/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! omni-bench: is the command bar instant on a large history?
//!
//!   omni-bench [--items N] [--max-build-ms N] [--max-query-ms N] [--json OUT]
//!
//! Builds an index of N synthetic history entries and replays typed queries letter by letter,
//! as the command bar does. Reports the build time and per-keystroke query times; exits 1 over
//! budget.
//!
//! The synthetic history follows the shape of real browsing data: title words are drawn from a
//! 5,000-word vocabulary with a Zipf (1/rank) distribution, the topic words the queries use sit
//! at ranks 20-400 (common, not stop-word common), a few sites get most visits, and frecency is
//! heavily skewed. A tiny vocabulary would make every word match a tenth of history, which no
//! real history does.

use omni_index::{Index, Kind, ALL_KINDS};
use std::time::Instant;

const WORDS: &[&str] = &[
    "news", "weather", "recipe", "github", "pull", "request", "issue", "docs", "guide", "rust",
    "firefox", "privacy", "review", "best", "how", "to", "make", "sydney", "music", "video",
    "calendar", "mail", "inbox", "project", "design", "sidebar", "release", "notes", "search",
    "travel", "flight", "hotel", "shop", "cart", "price", "photo", "album", "chat", "team",
    "budget", "report", "plan", "meeting", "learn", "course", "lecture", "paper", "kitchen",
];
const TLDS: &[&str] = &["com", "org", "net", "io", "dev", "com.au", "co.uk", "de", "app"];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a>(&mut self, list: &[&'a str]) -> &'a str {
        list[(self.next() % list.len() as u64) as usize]
    }
}

fn main() {
    let mut items = 100_000usize;
    let mut max_build_ms: Option<f64> = None;
    let mut max_query_ms: Option<f64> = None;
    let mut json: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--items" => items = args.next().and_then(|v| v.parse().ok()).unwrap_or(items),
            "--max-build-ms" => max_build_ms = args.next().and_then(|v| v.parse().ok()),
            "--max-query-ms" => max_query_ms = args.next().and_then(|v| v.parse().ok()),
            "--json" => json = args.next(),
            _ => {
                eprintln!("usage: omni-bench [--items N] [--max-build-ms N] [--max-query-ms N] [--json OUT]");
                std::process::exit(2);
            }
        }
    }

    let mut rng = Rng(0x9E3779B97F4A7C15);
    // Vocabulary: filler words, with the topic words placed at ranks 20..400.
    const SYLLABLES: &[&str] = &["ka", "lo", "mi", "ne", "ra", "to", "su", "vi", "de", "pa", "zo", "be", "qu", "fi", "gu", "ho"];
    let vocab_size = 5000;
    let mut vocab: Vec<String> = (0..vocab_size)
        .map(|_| (0..(2 + rng.next() % 3)).map(|_| rng.pick(SYLLABLES)).collect::<String>())
        .collect();
    for (i, w) in WORDS.iter().enumerate() {
        let rank = 20 + i * 380 / WORDS.len();
        vocab[rank] = w.to_string();
    }
    let ln_n = (vocab_size as f64 + 1.0).ln();
    let zipf = |rng: &mut Rng| -> usize {
        let u = (rng.next() % 1_000_000) as f64 / 1_000_000.0;
        (((u * ln_n).exp() - 1.0) as usize).min(vocab_size - 1)
    };
    let sites: Vec<String> = (0..400)
        .map(|i| format!("{}{}.{}", rng.pick(WORDS), if i % 3 == 0 { "hub" } else { "" }, rng.pick(TLDS)))
        .collect();
    let mut entries = Vec::with_capacity(items);
    for i in 0..items {
        // A few sites get most visits, like real history.
        let site = &sites[((rng.next() % 1000) as f64).powf(1.6) as usize % sites.len()];
        let title: Vec<&str> = (0..(3 + rng.next() % 6)).map(|_| vocab[zipf(&mut rng)].as_str()).collect();
        let path: Vec<&str> = (0..(1 + rng.next() % 4)).map(|_| vocab[zipf(&mut rng)].as_str()).collect();
        let url = format!("https://{}/{}/{}", site, path.join("/"), i);
        let boost = 100.0 / (1.0 + (rng.next() % 500) as f32);
        let age = (rng.next() % 365) as f32;
        entries.push((title.join(" "), url, boost, age));
    }

    let started = Instant::now();
    let mut index = Index::new();
    for (title, url, boost, age) in &entries {
        index.add(Kind::History, title, url, *boost, *age);
    }
    index.prepare();
    let build_ms = started.elapsed().as_secs_f64() * 1000.0;

    let typed = ["github pull request", "sydney weather", "rust guide", "ghub", "recipe kitchen best", "travel hotel"];
    let mut times = Vec::new();
    for phrase in typed {
        for end in 1..=phrase.len() {
            if !phrase.is_char_boundary(end) {
                continue;
            }
            let q = &phrase[..end];
            let t = Instant::now();
            let hits = index.query(q, ALL_KINDS, 10);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            if std::env::var_os("OMNI_BENCH_VERBOSE").is_some() {
                println!("{ms:8.2} ms  {q:?} ({} hits)", hits.len());
            }
            times.push(ms);
            std::hint::black_box(hits);
        }
        // A fresh start for the next phrase, like reopening the command bar.
        index.query("", ALL_KINDS, 10);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = times[times.len() / 2];
    let p95 = times[(times.len() * 95 / 100).min(times.len() - 1)];
    let max = *times.last().unwrap();

    println!("Index: {items} history entries built in {build_ms:.0} ms");
    println!("Per keystroke ({} queries): median {p50:.2} ms, p95 {p95:.2} ms, worst {max:.2} ms", times.len());
    if let Some(path) = json {
        let _ = std::fs::write(
            path,
            format!("{{\"items\":{items},\"build_ms\":{build_ms:.1},\"p50_ms\":{p50:.3},\"p95_ms\":{p95:.3},\"max_ms\":{max:.3}}}\n"),
        );
    }
    let mut over = false;
    if let Some(b) = max_build_ms {
        if build_ms > b {
            println!("OVER BUDGET: build {build_ms:.0} ms > {b:.0} ms");
            over = true;
        }
    }
    if let Some(b) = max_query_ms {
        if p95 > b {
            println!("OVER BUDGET: p95 query {p95:.2} ms > {b:.2} ms");
            over = true;
        }
    }
    std::process::exit(if over { 1 } else { 0 });
}
