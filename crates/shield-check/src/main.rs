/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! shield-check: does Shield block what it should, and nothing it shouldn't?
//!
//! Loads assembled filter lists into the same engine the browser uses (Firefox's in-tree
//! `etp_engine`, a fork of brave/adblock-rust) and replays a corpus through the same calls the
//! browser makes:
//!   * network blocking: `Request::preparsed` + `check_network_request_subset`
//!     (toolkit/components/content-classifier/content_classifier_engine/src/lib.rs)
//!   * element hiding: `url_cosmetic_resources` + `hidden_class_id_selectors` (the FFI functions
//!     our patch adds to the same file; see src/browser/components/peryn/shield/).
//!
//!   shield-check --corpus corpus.toml --list a.txt --list b.txt [--bench] [--json out.json]
//!                [--max-build-ms N] [--max-request-us N] [--max-serialized-kb N]
//!                [--max-cosmetic-us N]
//!
//! Exit status 1 if any case doesn't match its expectation or a performance budget is exceeded.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::process::ExitCode;
use std::time::Instant;

use etp_engine::lists::ParseOptions;
use etp_engine::request::Request;
use etp_engine::Engine;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Corpus {
    case: Vec<Case>,
    #[serde(default)]
    cosmetic: Vec<CosmeticCase>,
}

/// One page load, as the element-hiding actor sees it.
#[derive(Deserialize, Clone)]
struct CosmeticCase {
    page: String,
    /// Selectors that must be in the page's hide list (site-specific or generic non-class/id).
    #[serde(default)]
    hides: Vec<String>,
    /// Selectors that must not be hidden on this page (exceptions, other sites' rules).
    #[serde(default)]
    not_hides: Vec<String>,
    /// Classes and ids found in the page, sent for generic class/id rules.
    #[serde(default)]
    classes: Vec<String>,
    #[serde(default)]
    ids: Vec<String>,
    /// Selectors the generic class/id lookup must return.
    #[serde(default)]
    generic_hides: Vec<String>,
    /// Selectors the generic class/id lookup must not return.
    #[serde(default)]
    generic_not_hides: Vec<String>,
    #[serde(default)]
    note: String,
}

#[derive(Deserialize, Clone)]
struct Case {
    url: String,
    /// The page making the request (its URL).
    source: String,
    /// Request type as the browser reports it: script, image, stylesheet, xmlhttprequest,
    /// subdocument, media, font, ping, websocket, other.
    #[serde(rename = "type")]
    kind: String,
    /// "block" or "allow".
    expect: String,
    #[serde(default)]
    note: String,
}

#[derive(Serialize)]
struct CaseResult {
    url: String,
    source: String,
    kind: String,
    expect: String,
    blocked: bool,
    exception: Option<String>,
    pass: bool,
    note: String,
}

#[derive(Serialize)]
struct CosmeticResult {
    page: String,
    hide_selectors: usize,
    procedural_actions: usize,
    generichide: bool,
    missing: Vec<String>,
    wrongly_hidden: Vec<String>,
    pass: bool,
    note: String,
}

#[derive(Serialize)]
struct Report {
    rules: usize,
    build_ms: f64,
    serialized_kb: usize,
    cases: usize,
    failures: usize,
    block_cases: usize,
    blocked_correctly: usize,
    allow_cases: usize,
    allowed_correctly: usize,
    per_request_ns: Option<f64>,
    cosmetic_cases: usize,
    cosmetic_failures: usize,
    per_page_cosmetic_ns: Option<f64>,
    results: Vec<CaseResult>,
    cosmetic_results: Vec<CosmeticResult>,
}

/// Multi-label public suffixes common in the corpus. The browser asks Firefox's eTLD service;
/// this is enough to decide first- vs third-party for test URLs.
const MULTI_LABEL_SUFFIXES: &[&str] = &[
    "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "com.br", "co.in",
    "github.io", "pages.dev", "appspot.com", "cloudfront.net", "herokuapp.com",
];

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url).ok()?.host_str().map(|h| h.to_ascii_lowercase())
}

fn base_domain(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() <= 2 {
        return host.to_string();
    }
    let last_two = labels[labels.len() - 2..].join(".");
    let take = if MULTI_LABEL_SUFFIXES.contains(&last_two.as_str()) { 3 } else { 2 };
    labels[labels.len() - take.min(labels.len())..].join(".")
}

/// The browser resolves base domains with Firefox's eTLD service; this mirrors `base_domain`.
struct NaiveResolver;

impl etp_engine::url_parser::ResolvesDomain for NaiveResolver {
    fn get_host_domain(&self, host: &str) -> (usize, usize) {
        let base = base_domain(host);
        (host.len() - base.len(), host.len())
    }
}

/// What the element-hiding actor does for one page: site resources, then (unless the page has a
/// `$generichide` exception) generic rules for the classes and ids it found.
fn cosmetic(engine: &Engine, case: &CosmeticCase) -> CosmeticResult {
    let resources = engine.url_cosmetic_resources(&case.page);
    let generic: HashSet<String> = if resources.generichide {
        HashSet::new()
    } else {
        engine
            .hidden_class_id_selectors(&case.classes, &case.ids, &resources.exceptions)
            .into_iter()
            .collect()
    };
    let mut missing = Vec::new();
    let mut wrongly_hidden = Vec::new();
    for sel in &case.hides {
        if !resources.hide_selectors.contains(sel) {
            missing.push(sel.clone());
        }
    }
    for sel in &case.generic_hides {
        if !generic.contains(sel) {
            missing.push(sel.clone());
        }
    }
    for sel in &case.not_hides {
        if resources.hide_selectors.contains(sel) || generic.contains(sel) {
            wrongly_hidden.push(sel.clone());
        }
    }
    for sel in &case.generic_not_hides {
        if generic.contains(sel) {
            wrongly_hidden.push(sel.clone());
        }
    }
    CosmeticResult {
        page: case.page.clone(),
        hide_selectors: resources.hide_selectors.len(),
        procedural_actions: resources.procedural_actions.len(),
        generichide: resources.generichide,
        pass: missing.is_empty() && wrongly_hidden.is_empty(),
        missing,
        wrongly_hidden,
        note: case.note.clone(),
    }
}

fn check(engine: &Engine, case: &Case) -> Result<(bool, Option<String>), String> {
    let host = host_of(&case.url).ok_or_else(|| format!("bad url: {}", case.url))?;
    let source_host = host_of(&case.source).ok_or_else(|| format!("bad source: {}", case.source))?;
    let third_party = base_domain(&host) != base_domain(&source_host);
    let request = Request::preparsed(&case.url, &host, &source_host, &case.kind, third_party);
    let result = engine.check_network_request_subset(&request, false, false);
    Ok((result.matched, result.exception))
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: shield-check --corpus FILE --list FILE [--list FILE...] [--bench] [--json OUT]\n\
         \x20                   [--max-build-ms N] [--max-request-us N] [--max-serialized-kb N]\n\
         \x20                   [--max-cosmetic-us N]"
    );
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let mut corpus_path = None;
    let mut lists = Vec::new();
    let mut bench = false;
    let mut json_out = None;
    let mut max_build_ms: Option<f64> = None;
    let mut max_request_us: Option<f64> = None;
    let mut max_serialized_kb: Option<usize> = None;
    let mut max_cosmetic_us: Option<f64> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--corpus" => corpus_path = args.next(),
            "--list" => match args.next() {
                Some(p) => lists.push(p),
                None => return usage(),
            },
            "--bench" => bench = true,
            "--json" => json_out = args.next(),
            "--max-build-ms" => max_build_ms = args.next().and_then(|v| v.parse().ok()),
            "--max-request-us" => max_request_us = args.next().and_then(|v| v.parse().ok()),
            "--max-serialized-kb" => max_serialized_kb = args.next().and_then(|v| v.parse().ok()),
            "--max-cosmetic-us" => max_cosmetic_us = args.next().and_then(|v| v.parse().ok()),
            _ => return usage(),
        }
    }
    let (Some(corpus_path), false) = (corpus_path, lists.is_empty()) else {
        return usage();
    };

    let corpus: Corpus = match fs::read_to_string(&corpus_path)
        .map_err(|e| e.to_string())
        .and_then(|t| toml::from_str(&t).map_err(|e| e.to_string()))
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot read corpus {corpus_path}: {e}");
            return ExitCode::from(2);
        }
    };

    let mut rules = Vec::new();
    for path in &lists {
        match fs::read_to_string(path) {
            Ok(text) => rules.extend(text.lines().map(str::to_owned)),
            Err(e) => {
                eprintln!("cannot read list {path}: {e}");
                return ExitCode::from(2);
            }
        }
    }
    let rule_count = rules.len();
    let _ = etp_engine::url_parser::set_domain_resolver(Box::new(NaiveResolver));

    let started = Instant::now();
    let engine = Engine::from_rules(rules, ParseOptions::default());
    let build_ms = started.elapsed().as_secs_f64() * 1000.0;
    let serialized_kb = engine.serialize().len() / 1024;

    let mut results = Vec::new();
    for case in &corpus.case {
        let (blocked, exception) = match check(&engine, case) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::from(2);
            }
        };
        let pass = match case.expect.as_str() {
            "block" => blocked,
            "allow" => !blocked,
            other => {
                eprintln!("expect must be block or allow, got {other:?}");
                return ExitCode::from(2);
            }
        };
        results.push(CaseResult {
            url: case.url.clone(),
            source: case.source.clone(),
            kind: case.kind.clone(),
            expect: case.expect.clone(),
            blocked,
            exception,
            pass,
            note: case.note.clone(),
        });
    }

    // Benchmark: repeat the whole corpus until ~200k checks, report the mean.
    let per_request_ns = bench.then(|| {
        let rounds = (200_000 / corpus.case.len().max(1)).max(1);
        let started = Instant::now();
        let mut hits = 0usize;
        for _ in 0..rounds {
            for case in &corpus.case {
                if check(&engine, case).map(|r| r.0).unwrap_or(false) {
                    hits += 1;
                }
            }
        }
        std::hint::black_box(hits);
        started.elapsed().as_nanos() as f64 / (rounds * corpus.case.len()) as f64
    });

    let cosmetic_results: Vec<CosmeticResult> =
        corpus.cosmetic.iter().map(|c| cosmetic(&engine, c)).collect();
    let per_page_cosmetic_ns = (bench && !corpus.cosmetic.is_empty()).then(|| {
        let rounds = (20_000 / corpus.cosmetic.len()).max(1);
        let started = Instant::now();
        let mut total = 0usize;
        for _ in 0..rounds {
            for case in &corpus.cosmetic {
                total += cosmetic(&engine, case).hide_selectors;
            }
        }
        std::hint::black_box(total);
        started.elapsed().as_nanos() as f64 / (rounds * corpus.cosmetic.len()) as f64
    });

    let count = |expect: &str, pass_only: bool| {
        results.iter().filter(|r| r.expect == expect && (!pass_only || r.pass)).count()
    };
    let report = Report {
        rules: rule_count,
        build_ms,
        serialized_kb,
        cases: results.len(),
        failures: results.iter().filter(|r| !r.pass).count(),
        block_cases: count("block", false),
        blocked_correctly: count("block", true),
        allow_cases: count("allow", false),
        allowed_correctly: count("allow", true),
        per_request_ns,
        cosmetic_cases: cosmetic_results.len(),
        cosmetic_failures: cosmetic_results.iter().filter(|r| !r.pass).count(),
        per_page_cosmetic_ns,
        results,
        cosmetic_results,
    };

    println!(
        "Engine: {} rule lines, built in {:.0} ms, {} KB serialized",
        report.rules, report.build_ms, report.serialized_kb
    );
    println!(
        "Blocked {}/{} that should be blocked; allowed {}/{} that must keep working",
        report.blocked_correctly, report.block_cases, report.allowed_correctly, report.allow_cases
    );
    if let Some(ns) = report.per_request_ns {
        println!("Matching: {:.2} µs per request (mean over the corpus)", ns / 1000.0);
    }
    let mut by_note: BTreeMap<&str, usize> = BTreeMap::new();
    for r in report.results.iter().filter(|r| !r.pass) {
        *by_note.entry(r.expect.as_str()).or_default() += 1;
        println!(
            "FAIL expected {:5} but {}: {} ({}, from {}){}",
            r.expect,
            if r.blocked { "blocked" } else { "allowed" },
            r.url,
            r.kind,
            r.source,
            r.exception.as_ref().map(|e| format!(" [exception: {e}]")).unwrap_or_default()
        );
    }
    if report.cosmetic_cases > 0 {
        println!(
            "Element hiding: {}/{} pages as expected",
            report.cosmetic_cases - report.cosmetic_failures,
            report.cosmetic_cases
        );
    }
    if let Some(ns) = report.per_page_cosmetic_ns {
        println!("Element hiding: {:.2} µs per page (site lookup + generic class/id lookup)", ns / 1000.0);
    }
    for r in report.cosmetic_results.iter().filter(|r| !r.pass) {
        println!(
            "FAIL element hiding on {}: missing {:?}, wrongly hidden {:?} ({} site selectors, generichide={})",
            r.page, r.missing, r.wrongly_hidden, r.hide_selectors, r.generichide
        );
    }
    if let Some(path) = json_out {
        if let Err(e) = fs::write(&path, serde_json::to_string_pretty(&report).unwrap_or_default()) {
            eprintln!("cannot write {path}: {e}");
        }
    }
    let mut over_budget = Vec::new();
    if let Some(max) = max_build_ms {
        if report.build_ms > max {
            over_budget.push(format!("engine build {:.0} ms > budget {max:.0} ms", report.build_ms));
        }
    }
    if let Some(max) = max_serialized_kb {
        if report.serialized_kb > max {
            over_budget.push(format!("engine size {} KB > budget {max} KB", report.serialized_kb));
        }
    }
    if let (Some(max), Some(ns)) = (max_request_us, report.per_request_ns) {
        if ns / 1000.0 > max {
            over_budget.push(format!("matching {:.2} µs/request > budget {max:.2} µs", ns / 1000.0));
        }
    }
    if let (Some(max), Some(ns)) = (max_cosmetic_us, report.per_page_cosmetic_ns) {
        if ns / 1000.0 > max {
            over_budget.push(format!("element hiding {:.2} µs/page > budget {max:.2} µs", ns / 1000.0));
        }
    }
    for line in &over_budget {
        println!("OVER BUDGET: {line}");
    }
    if report.failures > 0 || report.cosmetic_failures > 0 || !over_budget.is_empty() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
