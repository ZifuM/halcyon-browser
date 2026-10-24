/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! omni-index: the search behind Halcyon's command bar.
//!
//! Holds every searchable thing (open tabs, history, bookmarks, actions) as a title and a URL,
//! and answers a query with the best matches, fast enough to run on every keystroke over a
//! large history. Pure Rust with no dependencies, compiled to WebAssembly and loaded by
//! `OmniIndex.sys.mjs`; the same code runs natively for tests and benchmarks.
//!
//! How a query is answered:
//!   1. The query is lowercased and split into words. An item must match every word.
//!   2. Per item, a 64-bit "which characters occur" mask and a 256-bit "which letter pairs
//!      occur" mask reject most non-matching items with a few ANDs.
//!   3. Survivors are scored per word: the start of a word in the title beats a match inside a
//!      word; the site's host is worth more than the rest of the URL; a loose in-order match
//!      ("ghub" for "GitHub") still counts, for less; loose matching only runs when exact
//!      matches are scarce, and only over the 20,000 most useful items.
//!   4. Usefulness (frecency for history, open tabs, bookmarks) and recency add to the score.
//!   5. Items are visited most-useful first, and the scan stops as soon as no remaining item
//!      could beat the current top results (this is what keeps one- and two-letter queries
//!      fast: they match nearly everything).
//!   6. Typing more letters narrows the previous result set instead of starting over.

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod heap;

use alloc::collections::BinaryHeap;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;
use alloc::format;
use core::cmp::{Ordering, Reverse};

/// What an item is. Also a bit position in the `kinds` filter of a query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Tab = 0,
    Bookmark = 1,
    History = 2,
    Action = 3,
    Space = 4,
}

impl Kind {
    pub fn from_u8(v: u8) -> Option<Kind> {
        match v {
            0 => Some(Kind::Tab),
            1 => Some(Kind::Bookmark),
            2 => Some(Kind::History),
            3 => Some(Kind::Action),
            4 => Some(Kind::Space),
            _ => None,
        }
    }

    /// Fixed bonus: things you have open, saved, or can do beat things you once visited.
    fn bonus(self) -> f32 {
        match self {
            Kind::Tab => 40.0,
            Kind::Action => 30.0,
            Kind::Space => 30.0,
            Kind::Bookmark => 18.0,
            Kind::History => 0.0,
        }
    }
}

pub const ALL_KINDS: u32 = 0b11111;
const PREFIX_BONUS: f32 = 25.0;
/// Loose ("ghub") matching runs only when exact matches are this scarce...
const LOOSE_BELOW: usize = 3;
/// ...and only over the most useful items: it's for things you use, not every page ever seen.
const LOOSE_SCAN_CAP: usize = 20_000;
pub const MAX_RESULTS: usize = 64;
const MAX_WORDS: usize = 8;
const MAX_TEXT: usize = 2048;

struct Item {
    kind: Kind,
    /// 0..=100: how useful this item has been (frecency, normalised by the caller).
    boost: f32,
    /// Days since last use (0 = now). Recent things rank a little higher.
    age_days: f32,
    /// Offsets into the arena: lowercased title, lowercased URL without scheme and "www.".
    title: (u32, u32),
    url: (u32, u32),
    /// Length of the host at the start of `url`.
    host_len: u32,
    mask: u64,
    pairs: [u64; 4],
    alive: bool,
    /// Added or re-scored since the ranked view was built (scanned in full every query).
    hot: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub id: u32,
    pub score: f32,
}

/// f32 with a total order, for sorting and the top-k heap.
#[derive(Clone, Copy, PartialEq)]
struct Score(f32);
impl Eq for Score {}
impl PartialOrd for Score {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Score {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.partial_cmp(&other.0).unwrap_or(Ordering::Equal)
    }
}

const META_ALIVE: u8 = 0x80;
/// Re-rank once this many items have been added or re-scored since the last ranking.
const HOT_LIMIT: usize = 4096;
const NOT_RANKED: u32 = u32::MAX;

/// What a longer query can start from: the ranks that may still match.
struct Narrow {
    words: Vec<String>,
    kinds: u32,
    loose_ran: bool,
    ranks: Vec<u32>,
}

pub struct Index {
    items: Vec<Item>,
    arena: Vec<u8>,
    live: usize,
    // The ranked view: every item that was alive when it was built, most useful first, with
    // the data the filters need stored contiguously by rank, so a scan reads memory in order.
    ranked: Vec<u32>,
    rank_of: Vec<u32>,
    r_mask: Vec<u64>,
    r_pairs: Vec<[u64; 4]>,
    r_meta: Vec<u8>,
    r_static: Vec<f32>,
    built: bool,
    hot: Vec<u32>,
    last: Option<Narrow>,
    /// Per-rank "matched in query number N" stamps: a set without hashing.
    marks: Vec<u32>,
    generation: u32,
}

/// Bit for one (lowercased) byte: letters and digits get their own bits, everything else
/// shares the rest. Non-ASCII bytes hash into the shared bits too.
#[inline]
fn byte_bit(b: u8) -> u64 {
    match b {
        b'a'..=b'z' => 1 << (b - b'a'),
        b'0'..=b'9' => 1 << (26 + (b - b'0')),
        b' ' | b'/' | b'.' | b'-' | b'_' | b':' | b'?' | b'=' | b'&' | b'#' => 0,
        _ => 1 << (36 + (b as u64 % 28)),
    }
}

fn mask_of(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0, |m, &b| m | byte_bit(b))
}

#[inline]
fn pair_bit(a: u8, b: u8) -> usize {
    ((a as usize).wrapping_mul(31) ^ (b as usize).wrapping_mul(131)) & 255
}

/// Bloom-style set of adjacent byte pairs.
fn pairs_of(bytes: &[u8], into: &mut [u64; 4]) {
    for w in bytes.windows(2) {
        let bit = pair_bit(w[0], w[1]);
        into[bit >> 6] |= 1 << (bit & 63);
    }
}

#[inline]
fn has_pairs(item: &[u64; 4], query: &[u64; 4]) -> bool {
    (item[0] & query[0] == query[0])
        & (item[1] & query[1] == query[1])
        & (item[2] & query[2] == query[2])
        & (item[3] & query[3] == query[3])
}

fn lower(s: &str) -> String {
    if s.is_ascii() {
        s.to_ascii_lowercase()
    } else {
        s.to_lowercase()
    }
}

/// "https://www.example.com/a" -> "example.com/a" (and the host length).
fn strip_url(url: &str) -> (String, usize) {
    let lowered = lower(url);
    let mut rest = lowered.as_str();
    if let Some(i) = rest.find("://") {
        rest = &rest[i + 3..];
    } else if let Some(stripped) = rest.strip_prefix("about:") {
        return (format!("about:{stripped}"), 0);
    }
    if let Some(stripped) = rest.strip_prefix("www.") {
        rest = stripped;
    }
    let host_len = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    (rest.to_string(), host_len)
}

/// Natural log for positive finite x (`f32::ln` needs `std`, which the WebAssembly build
/// doesn't have). Accurate to about 1e-6, far more than ranking needs.
fn ln(x: f32) -> f32 {
    let bits = x.to_bits();
    let exponent = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000); // 1 <= m < 2
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    let series = s * (2.0 + s2 * (2.0 / 3.0 + s2 * (2.0 / 5.0 + s2 * (2.0 / 7.0 + s2 * (2.0 / 9.0)))));
    exponent as f32 * core::f32::consts::LN_2 + series
}

#[inline]
fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b >= 0x80
}

/// Best match of `word` in `text`: (score, matched at a word start?).
fn substring_score(text: &[u8], word: &[u8]) -> Option<(f32, bool)> {
    if word.is_empty() || word.len() > text.len() {
        return None;
    }
    let first = word[0];
    let mut best: Option<(f32, bool)> = None;
    let last_start = text.len() - word.len();
    let mut i = 0;
    while i <= last_start {
        if text[i] == first && &text[i..i + word.len()] == word {
            let at_word_start = i == 0 || !is_word_char(text[i - 1]);
            let score = if i == 0 {
                1.0
            } else if at_word_start {
                0.85
            } else {
                0.5
            };
            if best.map_or(true, |(s, _)| score > s) {
                best = Some((score, at_word_start));
                // Only position 0 beats a word start, and it was checked first.
                if at_word_start {
                    break;
                }
            }
        }
        i += 1;
    }
    best
}

/// Loose in-order match ("ghub" in "github"): 0..1, less for spread-out letters.
fn subsequence_score(text: &[u8], word: &[u8]) -> Option<f32> {
    if word.len() < 3 {
        return None;
    }
    let mut ti = 0;
    let mut first = None;
    let mut last = 0;
    for &w in word {
        loop {
            if ti >= text.len() {
                return None;
            }
            if text[ti] == w {
                first.get_or_insert(ti);
                last = ti;
                ti += 1;
                break;
            }
            ti += 1;
        }
    }
    let span = last - first.unwrap_or(0) + 1;
    // Letters scattered across a whole title ("rust" in "pRivacy & secUrity SeTtings") aren't
    // what anyone meant.
    if span > word.len() * 3 {
        return None;
    }
    let tightness = word.len() as f32 / span as f32; // 1.0 = contiguous
    Some(0.15 + 0.2 * tightness)
}

/// One query's words and filters.
struct Query<'a> {
    words: &'a [String],
    joined: &'a [u8],
    kinds: u32,
    mask: u64,
    pairs: [u64; 4],
}

/// Running state of one query: matches so far and the top-k scores.
struct Scan {
    limit: usize,
    /// The most any item can gain from matching: a host-start hit on every word.
    bound: f32,
    hits: Vec<Hit>,
    heap: BinaryHeap<Reverse<Score>>,
    /// Where a ranked scan stopped early (ranks from here on weren't looked at).
    stopped_at: Option<usize>,
}

impl Scan {
    fn add(&mut self, id: u32, score: f32) {
        self.hits.push(Hit { id, score });
        self.heap.push(Reverse(Score(score)));
        if self.heap.len() > self.limit {
            self.heap.pop();
        }
    }

    fn kth(&self) -> Option<f32> {
        (self.heap.len() >= self.limit).then(|| self.heap.peek().map_or(f32::MIN, |r| r.0 .0))
    }
}

const INDEX_EMPTY: Index = Index {
    items: Vec::new(),
    arena: Vec::new(),
    live: 0,
    ranked: Vec::new(),
    rank_of: Vec::new(),
    r_mask: Vec::new(),
    r_pairs: Vec::new(),
    r_meta: Vec::new(),
    r_static: Vec::new(),
    built: false,
    hot: Vec::new(),
    last: None,
    marks: Vec::new(),
    generation: 0,
};

impl Default for Index {
    fn default() -> Index {
        INDEX_EMPTY
    }
}

impl Index {
    pub const fn new() -> Index {
        INDEX_EMPTY
    }

    pub fn len(&self) -> usize {
        self.live
    }

    pub fn is_empty(&self) -> bool {
        self.live == 0
    }

    pub fn clear(&mut self) {
        *self = Index::default();
    }

    fn push_text(&mut self, s: &str) -> (u32, u32) {
        let start = self.arena.len() as u32;
        let take = if s.len() > MAX_TEXT {
            // Cut on a char boundary.
            let mut end = MAX_TEXT;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            end
        } else {
            s.len()
        };
        self.arena.extend_from_slice(&s.as_bytes()[..take]);
        (start, take as u32)
    }

    fn text(&self, span: (u32, u32)) -> &[u8] {
        &self.arena[span.0 as usize..(span.0 + span.1) as usize]
    }

    /// Add an item; returns its id (stable until `clear`).
    pub fn add(&mut self, kind: Kind, title: &str, url: &str, boost: f32, age_days: f32) -> u32 {
        let title_lc = lower(title);
        let (url_lc, host_len) = strip_url(url);
        let t = self.push_text(&title_lc);
        let u = self.push_text(&url_lc);
        let mask = mask_of(self.text(t)) | mask_of(self.text(u));
        let mut pairs = [0u64; 4];
        pairs_of(self.text(t), &mut pairs);
        pairs_of(self.text(u), &mut pairs);
        let id = self.items.len() as u32;
        self.items.push(Item {
            kind,
            boost: boost.clamp(0.0, 100.0),
            age_days: age_days.max(0.0),
            title: t,
            url: u,
            host_len: (host_len as u32).min(u.1),
            mask,
            pairs,
            alive: true,
            hot: true,
        });
        self.rank_of.push(NOT_RANKED);
        self.hot.push(id);
        self.live += 1;
        id
    }

    /// Remove an item (its id is never reused).
    pub fn remove(&mut self, id: u32) -> bool {
        let Some(item) = self.items.get_mut(id as usize) else {
            return false;
        };
        if !item.alive {
            return false;
        }
        item.alive = false;
        if item.hot {
            item.hot = false;
            self.hot.retain(|&h| h != id);
        }
        let rank = self.rank_of[id as usize];
        if rank != NOT_RANKED {
            self.r_meta[rank as usize] &= !META_ALIVE;
        }
        self.live -= 1;
        true
    }

    /// Update how useful/recent an item is (a page visited again, a tab used). The item is
    /// scanned in full until the next re-ranking, so its new score always counts.
    pub fn touch(&mut self, id: u32, boost: f32, age_days: f32) {
        let Some(item) = self.items.get_mut(id as usize) else {
            return;
        };
        if !item.alive {
            return;
        }
        item.boost = boost.clamp(0.0, 100.0);
        item.age_days = age_days.max(0.0);
        if !item.hot {
            item.hot = true;
            self.hot.push(id);
            let rank = self.rank_of[id as usize];
            if rank != NOT_RANKED {
                self.r_meta[rank as usize] &= !META_ALIVE;
            }
        }
    }

    /// Re-rank now (e.g. after a bulk load, or when the browser is idle) so no keystroke pays
    /// for it.
    pub fn prepare(&mut self) {
        let items = &self.items;
        let mut ranked: Vec<u32> = (0..items.len() as u32).filter(|&i| items[i as usize].alive).collect();
        ranked.sort_unstable_by(|&a, &b| {
            Score(Self::static_score(&items[b as usize])).cmp(&Score(Self::static_score(&items[a as usize])))
        });
        self.rank_of = vec![NOT_RANKED; items.len()];
        self.r_mask = Vec::with_capacity(ranked.len());
        self.r_pairs = Vec::with_capacity(ranked.len());
        self.r_meta = Vec::with_capacity(ranked.len());
        self.r_static = Vec::with_capacity(ranked.len());
        for (rank, &id) in ranked.iter().enumerate() {
            let item = &items[id as usize];
            self.rank_of[id as usize] = rank as u32;
            self.r_mask.push(item.mask);
            self.r_pairs.push(item.pairs);
            self.r_meta.push(META_ALIVE | item.kind as u8);
            self.r_static.push(Self::static_score(item));
        }
        for &id in &self.hot {
            self.items[id as usize].hot = false;
        }
        self.hot.clear();
        self.marks = vec![0; ranked.len()];
        self.generation = 0;
        self.ranked = ranked;
        self.built = true;
        self.last = None;
    }

    /// The part of an item's score that doesn't depend on the query.
    fn static_score(item: &Item) -> f32 {
        ln(1.0 + item.boost) * 9.0 + 12.0 / (1.0 + item.age_days / 3.0) + item.kind.bonus()
    }

    /// Score one item against the query words, or None if a word doesn't match.
    fn score(&self, item: &Item, q: &Query, loose: bool) -> Option<f32> {
        let title = self.text(item.title);
        let url = self.text(item.url);
        let host = &url[..item.host_len as usize];
        let path = &url[item.host_len as usize..];
        let mut total = 0.0;
        for word in q.words {
            let w = word.as_bytes();
            let length_bonus = 2.0 * w.len().min(10) as f32;
            let mut best: f32 = 0.0;
            if let Some((s, _)) = substring_score(title, w) {
                best = best.max(60.0 * s + length_bonus);
            }
            if let Some((s, at_start)) = substring_score(host, w) {
                // "git" -> github.com is a very strong signal.
                let host_score = if at_start { 70.0 } else { 45.0 } * s.max(0.7);
                best = best.max(host_score + length_bonus);
            }
            if best == 0.0 {
                if let Some((s, _)) = substring_score(path, w) {
                    best = 25.0 * s.max(0.6);
                }
            }
            if best == 0.0 && loose {
                if let Some(s) = subsequence_score(title, w).or_else(|| subsequence_score(host, w)) {
                    best = 40.0 * s;
                }
            }
            if best == 0.0 {
                return None;
            }
            total += best;
        }
        // Whole query is the start of the title or the host: what the user is spelling out.
        if title.starts_with(q.joined) || host.starts_with(q.joined) {
            total += PREFIX_BONUS;
        }
        // Usefulness 0..~41, recency 12 now and ~2 after two weeks, plus the kind's bonus.
        Some(total + Self::static_score(item))
    }

    /// Scan ranks in order; stops once nothing further can reach the top-k.
    fn scan_ranks(&mut self, scan: &mut Scan, q: &Query, ranks: &[u32], loose: bool) {
        let generation = self.generation;
        for (pos, &rank) in ranks.iter().enumerate() {
            let r = rank as usize;
            if let Some(kth) = scan.kth() {
                if self.r_static[r] + scan.bound < kth {
                    scan.stopped_at = Some(scan.stopped_at.map_or(pos, |s| s.min(pos)));
                    return;
                }
            }
            let meta = self.r_meta[r];
            if meta & META_ALIVE == 0
                || q.kinds & (1 << (meta & 0x7f)) == 0
                || self.r_mask[r] & q.mask != q.mask
                || (!loose && !has_pairs(&self.r_pairs[r], &q.pairs))
                || (loose && self.marks[r] == generation)
            {
                continue;
            }
            let id = self.ranked[r];
            if let Some(score) = self.score(&self.items[id as usize], q, loose) {
                self.marks[r] = generation;
                scan.add(id, score);
            }
        }
    }

    /// Items added or re-scored since ranking: always scanned in full.
    fn scan_hot(&self, scan: &mut Scan, q: &Query, loose: bool, strict_hits: &mut Vec<u32>) {
        for &id in &self.hot {
            let item = &self.items[id as usize];
            if !item.alive || q.kinds & (1 << item.kind as u8) == 0 || item.mask & q.mask != q.mask {
                continue;
            }
            if !loose && !has_pairs(&item.pairs, &q.pairs) {
                continue;
            }
            if loose && strict_hits.contains(&id) {
                continue;
            }
            if let Some(score) = self.score(item, q, loose) {
                if !loose {
                    strict_hits.push(id);
                }
                scan.add(id, score);
            }
        }
    }

    /// The best `limit` matches for `query` among items whose kind bit is set in `kinds`.
    pub fn query(&mut self, query: &str, kinds: u32, limit: usize) -> Vec<Hit> {
        if !self.built || self.hot.len() > HOT_LIMIT {
            self.prepare();
        }
        let limit = limit.clamp(1, MAX_RESULTS);
        let lowered = lower(query);
        let words: Vec<String> = lowered.split_whitespace().take(MAX_WORDS).map(str::to_string).collect();
        if words.is_empty() {
            self.last = None;
            return self.top_without_query(kinds, limit);
        }
        let joined = words.join(" ");
        let mut q = Query { words: &words, joined: joined.as_bytes(), kinds, mask: 0, pairs: [0; 4] };
        for w in &words {
            q.mask |= mask_of(w.as_bytes());
            pairs_of(w.as_bytes(), &mut q.pairs);
        }

        // Narrow the previous candidates when the new query only adds letters or words.
        let previous = self.last.take().filter(|last| {
            last.kinds == kinds
                && words.len() >= last.words.len()
                && last.words.iter().enumerate().all(|(i, old)| {
                    if i + 1 == last.words.len() {
                        words[i].starts_with(old.as_str())
                    } else {
                        words[i] == *old
                    }
                })
        });
        let previous_loose = previous.as_ref().is_some_and(|p| p.loose_ran);
        let candidates: Vec<u32> = match previous {
            Some(p) => p.ranks,
            None => (0..self.ranked.len() as u32).collect(),
        };

        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.marks.iter_mut().for_each(|m| *m = 0);
            self.generation = 1;
        }
        let mut scan = Scan {
            limit,
            bound: words.iter().map(|w| 70.0 + 2.0 * w.len().min(10) as f32).sum::<f32>() + PREFIX_BONUS,
            hits: Vec::new(),
            heap: BinaryHeap::new(),
            stopped_at: None,
        };
        let mut hot_strict = Vec::new();
        // Strict pass: every word appears as written.
        self.scan_hot(&mut scan, &q, false, &mut hot_strict);
        self.scan_ranks(&mut scan, &q, &candidates, false);

        // Loose pass ("ghub"), only when exact matches are scarce, over the most useful items.
        let can_be_loose = words.iter().any(|w| w.len() >= 3);
        let mut loose_ran = false;
        let mut loose_top = 0;
        if can_be_loose && scan.hits.len() < LOOSE_BELOW.min(limit) {
            loose_ran = true;
            self.scan_hot(&mut scan, &q, true, &mut hot_strict);
            if self.last_is_complete_for_loose(previous_loose, &candidates) {
                let cap = candidates.len().min(LOOSE_SCAN_CAP);
                self.scan_ranks(&mut scan, &q, &candidates[..cap], true);
            } else {
                // The candidates didn't allow for loose matches: look through the top items.
                loose_top = self.ranked.len().min(LOOSE_SCAN_CAP);
                let all: Vec<u32> = (0..loose_top as u32).collect();
                self.scan_ranks(&mut scan, &q, &all, true);
            }
        }

        // What a longer query has to look at, still in rank order: this query's matches among
        // the visited ranks, plus everything an early stop left unvisited. (Longer words only
        // ever match a subset, strictly or loosely.)
        let stop = scan.stopped_at.unwrap_or(candidates.len()).min(candidates.len());
        let generation = self.generation;
        let marks = &self.marks;
        let mut ranks: Vec<u32> = candidates[..stop]
            .iter()
            .copied()
            .filter(|&r| marks[r as usize] == generation)
            .chain(candidates[stop..].iter().copied())
            .collect();
        if loose_top > 0 {
            ranks.extend((0..loose_top as u32).filter(|&r| marks[r as usize] == generation));
            ranks.sort_unstable();
            ranks.dedup();
        }
        self.last = Some(Narrow { words, kinds, loose_ran, ranks });
        top_k(scan.hits, limit)
    }

    /// Loose matching can reuse the candidates only if they were built allowing for it (a
    /// fresh full candidate list always does).
    fn last_is_complete_for_loose(&self, previous_loose: bool, candidates: &[u32]) -> bool {
        previous_loose || candidates.len() == self.ranked.len()
    }

    /// With an empty query: the most useful items (open tabs first).
    fn top_without_query(&self, kinds: u32, limit: usize) -> Vec<Hit> {
        let hits = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, it)| it.alive && kinds & (1 << it.kind as u8) != 0)
            .map(|(id, it)| Hit {
                id: id as u32,
                // Nothing typed yet: open tabs (most recent first), then everything else.
                score: Self::static_score(it) + if it.kind == Kind::Tab { 1000.0 } else { 0.0 },
            })
            .collect();
        top_k(hits, limit)
    }
}

fn top_k(mut hits: Vec<Hit>, k: usize) -> Vec<Hit> {
    let by_score = |a: &Hit, b: &Hit| Score(b.score).cmp(&Score(a.score)).then(a.id.cmp(&b.id));
    if hits.len() > k {
        hits.select_nth_unstable_by(k - 1, by_score);
        hits.truncate(k);
    }
    hits.sort_unstable_by(by_score);
    hits
}

// ---- WebAssembly interface ---------------------------------------------------------------
//
// Plain C ABI, no bindings generator. JavaScript writes UTF-8 into buffers it got from
// `omni_alloc`, calls in, and reads results back from `omni_results_ptr`.

struct State {
    index: Index,
    results: Vec<u32>,
    scores: Vec<f32>,
}

impl State {
    const fn new() -> State {
        State { index: Index::new(), results: Vec::new(), scores: Vec::new() }
    }
}

#[cfg(target_arch = "wasm32")]
fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    struct Global(core::cell::UnsafeCell<State>);
    // WebAssembly here is single-threaded, and the functions below never re-enter.
    unsafe impl Sync for Global {}
    static STATE: Global = Global(core::cell::UnsafeCell::new(State::new()));
    f(unsafe { &mut *STATE.0.get() })
}

#[cfg(not(target_arch = "wasm32"))]
fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    std::thread_local! {
        static STATE: core::cell::RefCell<State> = const { core::cell::RefCell::new(State::new()) };
    }
    STATE.with(|s| f(&mut s.borrow_mut()))
}

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Allocate `len` bytes for JavaScript to write into.
#[no_mangle]
pub extern "C" fn omni_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Free a buffer from `omni_alloc`.
///
/// # Safety
/// `ptr` must come from `omni_alloc(cap)` and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn omni_free(ptr: *mut u8, cap: usize) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, 0, cap.max(1)));
    }
}

unsafe fn str_from<'a>(ptr: *const u8, len: usize) -> &'a str {
    if ptr.is_null() || len == 0 {
        return "";
    }
    let bytes = core::slice::from_raw_parts(ptr, len);
    core::str::from_utf8(bytes).unwrap_or("")
}

#[no_mangle]
pub extern "C" fn omni_clear() {
    with_state(|s| s.index.clear());
}

/// Add an item. Returns its id, or u32::MAX for an unknown kind.
///
/// # Safety
/// The pointers must be valid UTF-8 buffers of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn omni_add(
    kind: u8,
    title_ptr: *const u8,
    title_len: usize,
    url_ptr: *const u8,
    url_len: usize,
    boost: f32,
    age_days: f32,
) -> u32 {
    let Some(kind) = Kind::from_u8(kind) else {
        return u32::MAX;
    };
    let title = str_from(title_ptr, title_len);
    let url = str_from(url_ptr, url_len);
    with_state(|s| s.index.add(kind, title, url, boost, age_days))
}

#[no_mangle]
pub extern "C" fn omni_remove(id: u32) -> u32 {
    with_state(|s| s.index.remove(id) as u32)
}

#[no_mangle]
pub extern "C" fn omni_touch(id: u32, boost: f32, age_days: f32) {
    with_state(|s| s.index.touch(id, boost, age_days));
}

#[no_mangle]
pub extern "C" fn omni_prepare() {
    with_state(|s| s.index.prepare());
}

#[no_mangle]
pub extern "C" fn omni_len() -> u32 {
    with_state(|s| s.index.len() as u32)
}

/// Run a query; returns the number of results, readable through `omni_results_ptr` (ids,
/// u32) and `omni_scores_ptr` (f32), best first.
///
/// # Safety
/// `ptr` must be a valid UTF-8 buffer of `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn omni_query(ptr: *const u8, len: usize, kinds: u32, limit: u32) -> u32 {
    let query = str_from(ptr, len);
    with_state(|s| {
        let hits = s.index.query(query, kinds, limit as usize);
        s.results.clear();
        s.results.extend(hits.iter().map(|h| h.id));
        s.scores.clear();
        s.scores.extend(hits.iter().map(|h| h.score));
        hits.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn omni_results_ptr() -> *const u32 {
    with_state(|s| s.results.as_ptr())
}

#[no_mangle]
pub extern "C" fn omni_scores_ptr() -> *const f32 {
    with_state(|s| s.scores.as_ptr())
}

// ---- tests -----------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;

    #[test]
    fn ln_is_close() {
        for x in [1.0f32, 1.5, 2.0, 2.718_281_8, 10.0, 51.0, 101.0, 0.25] {
            assert!((ln(x) - x.ln()).abs() < 1e-5, "{x}");
        }
    }

    fn index() -> (Index, Vec<u32>) {
        let mut idx = Index::new();
        let ids = vec![
            idx.add(Kind::History, "GitHub: Let's build from here", "https://github.com/", 80.0, 1.0),
            idx.add(Kind::History, "Rust Programming Language", "https://www.rust-lang.org/learn", 40.0, 10.0),
            idx.add(Kind::Tab, "Pull requests · halcyon-browser", "https://github.com/ZifuM/halcyon-browser/pulls", 10.0, 0.0),
            idx.add(Kind::Bookmark, "Mozilla Developer Network", "https://developer.mozilla.org/en-US/", 30.0, 30.0),
            idx.add(Kind::History, "Weather — Sydney", "https://weather.example/au/sydney", 5.0, 200.0),
            idx.add(Kind::Action, "New Space", "halcyon:new-space", 50.0, 0.0),
            idx.add(Kind::History, "Café menu", "https://café.example/", 1.0, 1.0),
        ];
        (idx, ids)
    }

    fn top(idx: &mut Index, q: &str) -> Vec<u32> {
        idx.query(q, ALL_KINDS, 10).iter().map(|h| h.id).collect()
    }

    #[test]
    fn every_word_must_match() {
        let (mut idx, ids) = index();
        assert_eq!(top(&mut idx, "rust learn"), vec![ids[1]]);
        assert!(top(&mut idx, "rust banana").is_empty());
    }

    #[test]
    fn open_tab_outranks_history_for_the_same_site() {
        let (mut idx, ids) = index();
        let hits = top(&mut idx, "github");
        assert_eq!(hits[0], ids[2], "the open tab first");
        assert_eq!(hits[1], ids[0]);
    }

    #[test]
    fn host_prefix_and_word_starts_beat_inner_matches() {
        let (mut idx, ids) = index();
        assert_eq!(top(&mut idx, "dev")[0], ids[3], "developer.mozilla.org");
        assert_eq!(top(&mut idx, "syd")[0], ids[4]);
    }

    #[test]
    fn loose_matches_still_find_things() {
        let (mut idx, ids) = index();
        assert_eq!(top(&mut idx, "ghub")[..2].to_vec(), vec![ids[2], ids[0]]);
        assert!(top(&mut idx, "gh").is_empty(), "two letters: no loose matching");
        assert!(top(&mut idx, "mork").is_empty(), "too scattered (m..o..r..k across 'Mozilla Developer Network')");
    }

    #[test]
    fn case_scheme_and_www_are_ignored() {
        let (mut idx, ids) = index();
        assert_eq!(top(&mut idx, "RUST-LANG.org"), vec![ids[1]]);
        assert!(top(&mut idx, "https").is_empty());
        assert!(top(&mut idx, "www").is_empty());
    }

    #[test]
    fn non_ascii() {
        let (mut idx, ids) = index();
        assert_eq!(top(&mut idx, "CAFÉ"), vec![ids[6]]);
    }

    #[test]
    fn kinds_filter() {
        let (mut idx, ids) = index();
        let tabs_only = idx.query("git", 1 << Kind::Tab as u8, 10);
        assert_eq!(tabs_only.iter().map(|h| h.id).collect::<Vec<_>>(), vec![ids[2]]);
        let actions = idx.query("new", 1 << Kind::Action as u8, 10);
        assert_eq!(actions[0].id, ids[5]);
    }

    #[test]
    fn narrowing_gives_the_same_answer_as_a_fresh_query() {
        let (mut idx, _) = index();
        idx.query("g", ALL_KINDS, 10);
        idx.query("gi", ALL_KINDS, 10);
        let narrowed = top(&mut idx, "git");
        let mut fresh_idx = index().0;
        assert_eq!(narrowed, top(&mut fresh_idx, "git"));
        // Deleting letters starts over (and still works).
        assert_eq!(top(&mut idx, "r"), top(&mut fresh_idx, "r"));
    }

    #[test]
    fn removed_items_disappear_and_empty_query_lists_tabs_first() {
        let (mut idx, ids) = index();
        idx.query("git", ALL_KINDS, 10);
        assert!(idx.remove(ids[2]));
        assert!(!idx.remove(ids[2]));
        assert_eq!(top(&mut idx, "git"), vec![ids[0]]);
        assert_eq!(idx.len(), 6);
        let (mut idx2, ids2) = index();
        assert_eq!(top(&mut idx2, "  ")[0], ids2[2]);
    }

    #[test]
    fn touch_changes_ranking() {
        let mut idx = Index::new();
        let a = idx.add(Kind::History, "Notes A", "https://a.example/", 1.0, 100.0);
        let b = idx.add(Kind::History, "Notes B", "https://b.example/", 50.0, 1.0);
        assert_eq!(top(&mut idx, "notes")[0], b);
        idx.touch(a, 100.0, 0.0);
        assert_eq!(top(&mut idx, "notes")[0], a);
    }

    #[test]
    fn long_text_is_cut_on_a_char_boundary() {
        let mut idx = Index::new();
        let title = "é".repeat(3000);
        idx.add(Kind::History, &title, "https://x/", 0.0, 0.0);
        assert_eq!(idx.query("é", ALL_KINDS, 5).len(), 1);
    }

    /// Brute force: score everything, the way `query` is specified to behave.
    fn reference(idx: &Index, query: &str, kinds: u32, limit: usize) -> Vec<f32> {
        let lowered = lower(query);
        let words: Vec<String> = lowered.split_whitespace().take(MAX_WORDS).map(str::to_string).collect();
        let joined = words.join(" ");
        let q = Query { words: &words, joined: joined.as_bytes(), kinds, mask: 0, pairs: [0; 4] };
        let alive = |it: &&Item| it.alive && kinds & (1 << it.kind as u8) != 0;
        let mut scores: Vec<f32> = idx.items.iter().filter(alive).filter_map(|it| idx.score(it, &q, false)).collect();
        if scores.len() < LOOSE_BELOW.min(limit) && words.iter().any(|w| w.len() >= 3) {
            let loose = idx
                .items
                .iter()
                .filter(alive)
                .filter(|it| idx.score(it, &q, false).is_none())
                .filter_map(|it| idx.score(it, &q, true));
            scores.extend(loose.collect::<Vec<_>>());
        }
        scores.sort_unstable_by(|a, b| b.partial_cmp(a).unwrap());
        scores.truncate(limit);
        scores
    }

    #[test]
    fn matches_brute_force_while_typing_and_changing() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = move |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        let vocab = [
            "rust", "github", "pull", "request", "sydney", "weather", "recipe", "pasta", "news", "docs",
            "mozilla", "firefox", "garden", "travel", "hotel", "music", "guitar", "review", "map", "git",
        ];
        let sites = ["github.com", "rust-lang.org", "news.example", "docs.rs", "maps.example", "gitlab.com"];
        let mut idx = Index::new();
        let mut ids = Vec::new();
        let add = |idx: &mut Index, next: &mut dyn FnMut(usize) -> usize| {
            let title: Vec<&str> = (0..1 + next(4)).map(|_| vocab[next(vocab.len())]).collect();
            let url = format!("https://{}/{}", sites[next(sites.len())], vocab[next(vocab.len())]);
            let kind = [Kind::Tab, Kind::Bookmark, Kind::History, Kind::History, Kind::Action][next(5)];
            idx.add(kind, &title.join(" "), &url, next(100) as f32, next(60) as f32)
        };
        for _ in 0..3000 {
            ids.push(add(&mut idx, &mut next));
        }
        idx.prepare();
        let phrases = ["github pull", "rust docs", "ghub", "sydney weather", "gtr", "travel hotel map", "xyz"];
        for round in 0..30 {
            // Change things between bursts of typing: new items, re-scored ones, removed ones.
            for _ in 0..next(40) {
                ids.push(add(&mut idx, &mut next));
            }
            for _ in 0..next(40) {
                let id = ids[next(ids.len())];
                idx.touch(id, next(100) as f32, next(60) as f32);
            }
            for _ in 0..next(20) {
                idx.remove(ids[next(ids.len())]);
            }
            if round % 10 == 9 {
                idx.prepare();
            }
            let phrase = phrases[next(phrases.len())];
            let kinds = if next(4) == 0 { 1 << Kind::History as u8 } else { ALL_KINDS };
            let limit = [1, 3, 10][next(3)];
            for end in 1..=phrase.len() {
                let typed = &phrase[..end];
                let got: Vec<f32> = idx.query(typed, kinds, limit).iter().map(|h| h.score).collect();
                assert_eq!(got, reference(&idx, typed, kinds, limit), "round {round}, {typed:?}, limit {limit}");
            }
        }
    }

    #[test]
    fn abi_round_trip() {
        unsafe {
            omni_clear();
            let t = "Example Domain";
            let u = "https://example.com/";
            let id = omni_add(2, t.as_ptr(), t.len(), u.as_ptr(), u.len(), 10.0, 1.0);
            assert_eq!(id, 0);
            assert_eq!(omni_add(9, t.as_ptr(), t.len(), u.as_ptr(), u.len(), 0.0, 0.0), u32::MAX);
            let q = "exam";
            assert_eq!(omni_query(q.as_ptr(), q.len(), ALL_KINDS, 5), 1);
            assert_eq!(*omni_results_ptr(), 0);
            assert!(*omni_scores_ptr() > 0.0);
            let buf = omni_alloc(16);
            omni_free(buf, 16);
            assert_eq!(omni_len(), 1);
            assert_eq!(omni_remove(0), 1);
            assert_eq!(omni_len(), 0);
        }
    }
}
