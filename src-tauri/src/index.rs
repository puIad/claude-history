//! Builds the session list from the archive: one cheap pass over every
//! transcript (cached by size + mtime), merged with the desktop app's
//! per-session metadata (titles, environments, archive state, PRs, outputs).

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::paths;
use crate::pricing;

const SEARCH_CAP: usize = 160_000;

// ---------------------------------------------------------------- scan cache

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct ModelTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cw5m: u64,
    pub cw1h: u64,
    pub cost: f64,
    pub messages: u32,
}

impl ModelTotals {
    pub fn add(&mut self, o: &ModelTotals) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cw5m += o.cw5m;
        self.cw1h += o.cw1h;
        self.cost += o.cost;
        self.messages += o.messages;
    }
    pub fn tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cw5m + self.cw1h
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PrRef {
    pub number: u64,
    pub url: String,
    pub repo: String,
    #[serde(default)]
    pub state: String,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Scan {
    pub len: u64,
    pub mtime: i64,
    pub session_id: String,
    pub cwd: String,
    pub branch: String,
    pub first_ts: i64,
    pub last_ts: i64,
    pub custom_title: Option<String>,
    pub agent_name: Option<String>,
    pub summary: Option<String>,
    pub first_prompt: String,
    pub last_prompt: String,
    pub prompts: u32,
    pub assistant_msgs: u32,
    pub tool_calls: u32,
    pub models: BTreeMap<String, ModelTotals>,
    /// day (YYYY-MM-DD) -> model -> totals
    pub daily: BTreeMap<String, BTreeMap<String, ModelTotals>>,
    pub cc_cost: Option<f64>,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub api_ms: u64,
    pub prs: Vec<PrRef>,
    pub last_context: u64,
    pub last_model: String,
    pub version: String,
    pub entrypoint: String,
    pub account: Option<String>,
    pub search: String,
}

// ---------------------------------------------------------------- line types

#[derive(Deserialize)]
struct Head<'a> {
    #[serde(rename = "type", borrow, default)]
    t: Option<std::borrow::Cow<'a, str>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LineCommon<'a> {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    is_meta: Option<bool>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    entrypoint: Option<String>,
    #[serde(default, borrow)]
    message: Option<&'a RawValue>,
    // misc record types
    #[serde(default)]
    custom_title: Option<String>,
    #[serde(default)]
    agent_name: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default, rename = "totalCostUSD")]
    total_cost_usd: Option<f64>,
    #[serde(default)]
    total_lines_added: Option<u64>,
    #[serde(default)]
    total_lines_removed: Option<u64>,
    #[serde(default, rename = "totalAPIDuration")]
    total_api_duration: Option<u64>,
    #[serde(default)]
    pr_number: Option<u64>,
    #[serde(default)]
    pr_url: Option<String>,
    #[serde(default)]
    pr_repository: Option<String>,
    #[serde(default)]
    account_uuid: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct CacheCreation {
    #[serde(default)]
    pub ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    pub ephemeral_1h_input_tokens: u64,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_creation: Option<CacheCreation>,
    #[serde(default)]
    pub speed: Option<String>,
}

impl Usage {
    pub fn context(&self) -> u64 {
        self.input_tokens + self.cache_read_input_tokens + self.cache_creation_input_tokens
    }
    pub fn totals(&self, model: &str) -> ModelTotals {
        let (w5, w1) = match &self.cache_creation {
            Some(c) if c.ephemeral_5m_input_tokens + c.ephemeral_1h_input_tokens > 0 => {
                (c.ephemeral_5m_input_tokens, c.ephemeral_1h_input_tokens)
            }
            _ => (self.cache_creation_input_tokens, 0),
        };
        let ut = pricing::UsageTokens {
            input: self.input_tokens,
            output: self.output_tokens,
            cache_read: self.cache_read_input_tokens,
            cache_write_5m: w5,
            cache_write_1h: w1,
            fast: self.speed.as_deref() == Some("fast"),
        };
        ModelTotals {
            input: ut.input,
            output: ut.output,
            cache_read: ut.cache_read,
            cw5m: w5,
            cw1h: w1,
            cost: pricing::cost(model, &ut),
            messages: 1,
        }
    }
}

#[derive(Deserialize)]
struct AssistantMsg<'a> {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<Usage>,
    #[serde(default, borrow)]
    content: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct UserMsg<'a> {
    #[serde(default, borrow)]
    content: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct TextBlock {
    #[serde(rename = "type", default)]
    t: String,
    #[serde(default)]
    text: Option<String>,
}

// ---------------------------------------------------------------- helpers

/// "2026-11-08T18:17:31.517Z" -> unix ms. Tolerates missing fraction/zone.
pub fn parse_ts(s: &str) -> i64 {
    let b = s.as_bytes();
    if b.len() < 19 {
        return 0;
    }
    let num = |a: usize, n: usize| -> i64 {
        s.get(a..a + n).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0)
    };
    let (y, mo, d) = (num(0, 4), num(5, 2), num(8, 2));
    let (h, mi, se) = (num(11, 2), num(14, 2), num(17, 2));
    let mut ms = 0;
    if b.len() > 20 && b[19] == b'.' {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
        ms = frac.parse::<i64>().unwrap_or(0) * 10i64.pow(3 - frac.len().min(3) as u32);
    }
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    ((days * 86400 + h * 3600 + mi * 60 + se) * 1000) + ms
}

fn day_of(ts: &str) -> String {
    ts.get(0..10).unwrap_or("").to_string()
}

fn strip_tag_blocks(s: &str, tag: &str) -> String {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(&open) {
        out.push_str(&rest[..i]);
        match rest[i..].find(&close) {
            Some(j) => rest = &rest[i + j + close.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = s.find(a)? + a.len();
    let j = s[i..].find(b)? + i;
    Some(&s[i..j])
}

/// Is this user text something the person typed? Returns the cleaned prompt.
pub fn clean_prompt(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    const SYSTEMISH: [&str; 12] = [
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<local-command-caveat>",
        "<task-notification>",
        "<system-reminder>",
        "Caveat:",
        "[SYSTEM NOTIFICATION",
        "<side-sessions-event>",
        "<ci-monitor-event>",
        "<bash-stdout>",
        "<bash-stderr>",
        "[Request interrupted",
    ];
    if SYSTEMISH.iter().any(|p| t.starts_with(p)) {
        return None;
    }
    if t.contains("<command-name>") {
        let name = between(t, "<command-name>", "</command-name>").unwrap_or("").trim();
        let args = between(t, "<command-args>", "</command-args>").unwrap_or("").trim();
        let name = if name.starts_with('/') { name.to_string() } else { format!("/{}", name) };
        return Some(if args.is_empty() { name } else { format!("{} {}", name, args) });
    }
    if let Some(cmd) = between(t, "<bash-input>", "</bash-input>") {
        return Some(format!("! {}", cmd.trim()));
    }
    let s = strip_tag_blocks(t, "system-reminder");
    let s = s.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Plain text of a user message's content, joined; None when it only carries tool results.
pub fn user_text(content: &RawValue) -> (Option<String>, bool) {
    let raw = content.get();
    if raw.starts_with('"') {
        let s: String = serde_json::from_str(raw).unwrap_or_default();
        return (Some(s), false);
    }
    let blocks: Vec<TextBlock> = serde_json::from_str(raw).unwrap_or_default();
    let mut has_tool_result = false;
    let mut parts = Vec::new();
    for b in blocks {
        match b.t.as_str() {
            "text" => {
                if let Some(t) = b.text {
                    parts.push(t)
                }
            }
            "tool_result" => has_tool_result = true,
            _ => {}
        }
    }
    if parts.is_empty() {
        (None, has_tool_result)
    } else {
        (Some(parts.join("\n")), has_tool_result)
    }
}

/// The first `n` bytes of `s`, cut back to a character boundary.
pub fn head(s: &str, n: usize) -> &str {
    let mut end = s.len().min(n);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// The record's top-level `type` without parsing the whole (possibly huge) line.
/// Metadata records start with it; on assistant records the nested
/// `message.type` comes first, so only known top-level values count there.
fn line_type(line: &str) -> Option<String> {
    let h = head(line, 600);
    if let Some(rest) = h.strip_prefix("{\"type\":\"") {
        return rest.find('"').map(|j| rest[..j].to_string());
    }
    let mut search = h;
    while let Some(i) = search.find("\"type\":\"") {
        let rest = &search[i + 8..];
        let Some(j) = rest.find('"') else { break };
        let v = &rest[..j];
        if matches!(v, "user" | "assistant" | "system" | "attachment") {
            return Some(v.to_string());
        }
        search = rest;
    }
    // A JSON string can't hold an unescaped quote, so this only matches the real key.
    if line.contains(",\"type\":\"assistant\"") {
        return Some("assistant".into());
    }
    let h: Head = serde_json::from_str(line).ok()?;
    h.t.map(|c| c.to_string())
}

fn push_search(buf: &mut String, s: &str) {
    if buf.len() >= SEARCH_CAP {
        return;
    }
    let room = SEARCH_CAP - buf.len();
    let mut take = s.len().min(room);
    while !s.is_char_boundary(take) {
        take -= 1;
    }
    buf.push_str(&s[..take].to_lowercase());
    buf.push('\n');
}

fn mtime_ms(m: &fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn scan_file(path: &Path) -> Scan {
    let mut s = Scan::default();
    if let Ok(m) = fs::metadata(path) {
        s.len = m.len();
        s.mtime = mtime_ms(&m);
    }
    s.session_id = path.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    let Ok(f) = fs::File::open(path) else { return s };
    let reader = BufReader::with_capacity(1 << 20, f);
    let mut seen_msg: HashSet<String> = HashSet::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.len() < 10 {
            continue;
        }
        let Some(t) = line_type(&line) else { continue };
        match t.as_str() {
            "user" | "assistant" | "custom-title" | "agent-name" | "summary" | "cost-state" | "pr-link"
            | "session-owner" => {}
            _ => continue,
        }
        let Ok(l) = serde_json::from_str::<LineCommon>(&line) else { continue };
        if let Some(ts) = &l.timestamp {
            let ms = parse_ts(ts);
            if ms > 0 {
                if s.first_ts == 0 || ms < s.first_ts {
                    s.first_ts = ms;
                }
                if ms > s.last_ts {
                    s.last_ts = ms;
                }
            }
        }
        match t.as_str() {
            "custom-title" => s.custom_title = l.custom_title.or(s.custom_title.take()),
            "agent-name" => s.agent_name = l.agent_name.or(s.agent_name.take()),
            "summary" => s.summary = l.summary.or(s.summary.take()),
            "session-owner" => s.account = l.account_uuid.or(s.account.take()),
            "cost-state" => {
                if let Some(c) = l.total_cost_usd {
                    s.cc_cost = Some(c);
                }
                s.lines_added = l.total_lines_added.unwrap_or(s.lines_added);
                s.lines_removed = l.total_lines_removed.unwrap_or(s.lines_removed);
                s.api_ms = l.total_api_duration.unwrap_or(s.api_ms);
            }
            "pr-link" => {
                if let (Some(n), Some(u)) = (l.pr_number, l.pr_url.clone()) {
                    if !s.prs.iter().any(|p| p.url == u) {
                        s.prs.push(PrRef { number: n, url: u, repo: l.pr_repository.clone().unwrap_or_default(), state: String::new() });
                    }
                }
            }
            "user" => {
                if s.cwd.is_empty() {
                    if let Some(c) = &l.cwd {
                        s.cwd = c.clone();
                    }
                }
                if let Some(b) = &l.git_branch {
                    if !b.is_empty() && b != "HEAD" {
                        s.branch = b.clone();
                    }
                }
                if s.version.is_empty() {
                    s.version = l.version.clone().unwrap_or_default();
                    s.entrypoint = l.entrypoint.clone().unwrap_or_default();
                }
                if l.is_meta == Some(true) {
                    continue;
                }
                let Some(msg) = l.message else { continue };
                let Ok(um) = serde_json::from_str::<UserMsg>(msg.get()) else { continue };
                let Some(content) = um.content else { continue };
                let (text, _) = user_text(content);
                if let Some(text) = text.and_then(|t| clean_prompt(&t)) {
                    s.prompts += 1;
                    if s.first_prompt.is_empty() {
                        s.first_prompt = text.chars().take(400).collect();
                    }
                    s.last_prompt = text.chars().take(400).collect();
                    push_search(&mut s.search, &text);
                }
            }
            "assistant" => {
                let Some(msg) = l.message else { continue };
                let Ok(am) = serde_json::from_str::<AssistantMsg>(msg.get()) else { continue };
                let model = am.model.unwrap_or_default();
                if model == "<synthetic>" {
                    continue;
                }
                if let Some(c) = am.content {
                    let raw = c.get();
                    if raw.contains("\"tool_use\"") {
                        s.tool_calls += raw.matches("\"type\":\"tool_use\"").count() as u32;
                    }
                    if raw.contains("\"text\"") {
                        if let Ok(blocks) = serde_json::from_str::<Vec<TextBlock>>(raw) {
                            for b in blocks {
                                if b.t == "text" {
                                    if let Some(tx) = b.text {
                                        push_search(&mut s.search, &tx);
                                    }
                                }
                            }
                        }
                    }
                }
                let id = am.id.unwrap_or_default();
                if !id.is_empty() && !seen_msg.insert(id) {
                    continue; // same API message split across lines: count usage once
                }
                s.assistant_msgs += 1;
                if let Some(u) = am.usage {
                    let tot = u.totals(&model);
                    s.models.entry(model.clone()).or_default().add(&tot);
                    if let Some(ts) = &l.timestamp {
                        s.daily.entry(day_of(ts)).or_default().entry(model.clone()).or_default().add(&tot);
                    }
                    let ctx = u.context();
                    if ctx > 0 {
                        s.last_context = ctx + u.output_tokens;
                        s.last_model = model.clone();
                    }
                }
            }
            _ => {}
        }
    }
    s
}

// ---------------------------------------------------------------- desktop metadata

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopSession {
    pub session_id: String,
    pub cli_session_id: Option<String>,
    pub cwd: Option<String>,
    pub origin_cwd: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub is_archived: Option<bool>,
    pub title: Option<String>,
    pub title_source: Option<String>,
    pub permission_mode: Option<String>,
    pub env_scope_id: Option<String>,
    pub started_from_environment_id: Option<String>,
    pub prs: Option<Vec<Value>>,
    pub published_artifacts: Option<Vec<Value>>,
    pub branch: Option<String>,
    pub source_branch: Option<String>,
    pub worktree_name: Option<String>,
    pub worktree_path: Option<String>,
    pub post_turn_summary: Option<Value>,
    pub turn_wrap_up: Option<Value>,
    pub last_turn_report: Option<String>,
    pub spawned_from: Option<Value>,
    pub prior_cli_session_ids: Option<Vec<String>>,
    pub is_starred: Option<bool>,
    pub scheduled_task_id: Option<String>,
    pub remote_control_spawn: Option<Value>,
    pub bridge_session_ids: Option<Vec<String>>,
    pub completed_turns: Option<u64>,
    pub forked_from_session_id: Option<String>,
    pub requested_additional_folders: Option<Vec<Value>>,
    pub git_anchors: Option<Vec<Value>>,
    pub side_session_notes: Option<Vec<Value>>,
    pub error: Option<String>,
    #[serde(skip)]
    pub profile: String,
    #[serde(skip)]
    pub kind: String,
    #[serde(skip)]
    pub file: PathBuf,
}

#[derive(Clone, Debug)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub cwd: String,
}

fn load_presets(archive: &Path) -> Vec<Preset> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(archive.join("desktop")) else { return out };
    for prof in rd.flatten() {
        let Ok(s) = fs::read_to_string(prof.path().join("ccd-session-presets.json")) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&s) else { continue };
        if let Some(accts) = v.get("byAccount").and_then(|x| x.as_object()) {
            for a in accts.values() {
                if let Some(ps) = a.get("presets").and_then(|x| x.as_array()) {
                    for p in ps {
                        let id = p.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        if out.iter().any(|q: &Preset| q.id == id) {
                            continue;
                        }
                        out.push(Preset {
                            id,
                            name: p.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            cwd: p.pointer("/target/cwd").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        });
                    }
                }
            }
        }
    }
    out
}

fn walk_files(dir: &Path, pred: &dyn Fn(&Path) -> bool, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            walk_files(&p, pred, out);
        } else if ft.is_file() && pred(&p) {
            out.push(p);
        }
    }
}

fn load_desktop(archive: &Path) -> Vec<DesktopSession> {
    let mut files = Vec::new();
    let root = archive.join("desktop");
    let Ok(rd) = fs::read_dir(&root) else { return Vec::new() };
    let mut per_profile: Vec<(String, PathBuf, &'static str)> = Vec::new();
    for prof in rd.flatten() {
        let name = prof.file_name().to_string_lossy().to_string();
        per_profile.push((name.clone(), prof.path().join("claude-code-sessions"), "code"));
        per_profile.push((name, prof.path().join("local-agent-mode-sessions"), "cowork"));
    }
    for (name, dir, kind) in per_profile {
        let mut fl = Vec::new();
        walk_files(
            &dir,
            &|p: &Path| {
                let n = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                n.starts_with("local_") && n.ends_with(".json")
            },
            &mut fl,
        );
        for f in fl {
            files.push((name.clone(), f, kind));
        }
    }
    let parsed: Vec<DesktopSession> = files
        .par_iter()
        .filter_map(|(prof, f, kind)| {
            let s = fs::read_to_string(f).ok()?;
            let mut d: DesktopSession = serde_json::from_str(&s).ok()?;
            if d.session_id.is_empty() {
                return None;
            }
            d.profile = prof.clone();
            d.kind = kind.to_string();
            d.file = f.clone();
            Some(d)
        })
        .collect();
    // The two app profiles mirror each other: keep the most recently active copy.
    let mut by_id: HashMap<String, DesktopSession> = HashMap::new();
    for d in parsed {
        let newer = match by_id.get(&d.session_id) {
            Some(old) => d.last_activity_at.unwrap_or(0) > old.last_activity_at.unwrap_or(0),
            None => true,
        };
        if newer {
            by_id.insert(d.session_id.clone(), d);
        }
    }
    by_id.into_values().collect()
}

// ---------------------------------------------------------------- the index

#[derive(Serialize, Clone, Debug, Default)]
pub struct SessionSummary {
    pub key: String,
    pub source: String,
    pub profile: String,
    pub cli_id: String,
    pub cli_ids: Vec<String>,
    pub title: String,
    pub group: String,
    pub group_cwd: String,
    pub cwd: String,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub archived: bool,
    pub starred: bool,
    pub model: String,
    pub model_name: String,
    pub effort: String,
    pub permission_mode: String,
    pub prompts: u32,
    pub tool_calls: u32,
    pub cost_usd: f64,
    pub cost_estimated: bool,
    pub tokens: u64,
    pub branch: String,
    pub worktree: String,
    pub prs: Vec<PrRef>,
    pub artifacts: u32,
    pub summary: String,
    pub side: bool,
    pub parent_key: String,
    pub first_prompt: String,
    pub has_transcript: bool,
    pub scheduled: bool,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub context_tokens: u64,
    pub context_window: u64,
}

#[derive(Default)]
pub struct Index {
    pub sessions: Vec<SessionSummary>,
    pub by_key: HashMap<String, usize>,
    pub desktop: HashMap<String, DesktopSession>,
    /// cli session id -> transcript path in the archive
    pub transcripts: HashMap<String, PathBuf>,
    /// cli session id -> its subagent transcripts
    pub subagents: HashMap<String, Vec<PathBuf>>,
    pub scans: HashMap<String, Scan>,
    pub presets: Vec<Preset>,
    pub built_ms: i64,
    pub archive: Option<PathBuf>,
    /// lowercased text of imported claude.ai conversations, by session key
    pub extra_search: HashMap<String, String>,
}

fn cache_path(archive: &Path) -> PathBuf {
    archive.join(".cache").join("scan-v2.json")
}

pub fn load_scan_cache(archive: &Path) -> HashMap<String, Scan> {
    fs::read(cache_path(archive))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_scan_cache(archive: &Path, scans: &HashMap<String, Scan>) {
    let p = cache_path(archive);
    if let Some(d) = p.parent() {
        let _ = fs::create_dir_all(d);
    }
    if let Ok(b) = serde_json::to_vec(scans) {
        let tmp = p.with_extension("tmp");
        if fs::write(&tmp, b).is_ok() {
            let _ = fs::rename(&tmp, &p);
        }
    }
}

fn rel_key(archive: &Path, p: &Path) -> String {
    p.strip_prefix(archive).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn group_for(cwd: &str, env_id: Option<&str>, presets: &[Preset]) -> (String, String) {
    if let Some(id) = env_id {
        if let Some(p) = presets.iter().find(|p| p.id == id) {
            return (p.name.clone(), p.cwd.clone());
        }
    }
    let base_cwd = paths::strip_worktree(cwd);
    let k = paths::path_key(&base_cwd);
    if let Some(p) = presets.iter().find(|p| paths::path_key(&p.cwd) == k) {
        return (p.name.clone(), p.cwd.clone());
    }
    let lower = k.as_str();
    if lower.contains("/scratch-workspaces/") || lower.contains("/scratchpad") {
        return ("Scratch".into(), base_cwd);
    }
    if base_cwd.is_empty() {
        return ("No folder".into(), String::new());
    }
    (paths::basename(&base_cwd), base_cwd)
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

pub fn build(archive: &Path, mut cache: HashMap<String, Scan>, progress: &(dyn Fn(u64, u64) + Sync)) -> Index {
    let projects = archive.join("claude").join("projects");
    let mut files = Vec::new();
    walk_files(
        &projects,
        &|p: &Path| p.extension().map(|e| e == "jsonl").unwrap_or(false),
        &mut files,
    );
    // Cowork transcripts (if the machine ever ran them) live inside the desktop profile.
    let mut cowork = Vec::new();
    if let Ok(rd) = fs::read_dir(archive.join("desktop")) {
        for prof in rd.flatten() {
            walk_files(
                &prof.path().join("local-agent-mode-sessions"),
                &|p: &Path| p.extension().map(|e| e == "jsonl").unwrap_or(false),
                &mut cowork,
            );
        }
    }
    files.extend(cowork.iter().cloned());

    // Decide which files need a fresh scan.
    let total = files.len() as u64;
    let todo: Vec<(String, PathBuf)> = files
        .iter()
        .filter_map(|p| {
            let k = rel_key(archive, p);
            let m = fs::metadata(p).ok()?;
            match cache.get(&k) {
                Some(s) if s.len == m.len() && s.mtime == mtime_ms(&m) => None,
                _ => Some((k, p.clone())),
            }
        })
        .collect();
    let done = std::sync::atomic::AtomicU64::new(total - todo.len() as u64);
    progress(done.load(std::sync::atomic::Ordering::Relaxed), total);
    let fresh: Vec<(String, Scan)> = todo
        .par_iter()
        .map(|(k, p)| {
            let s = scan_file(p);
            let n = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            if n % 25 == 0 {
                progress(n, total);
            }
            (k.clone(), s)
        })
        .collect();
    let changed = !fresh.is_empty();
    for (k, s) in fresh {
        cache.insert(k, s);
    }
    let live: HashSet<String> = files.iter().map(|p| rel_key(archive, p)).collect();
    let before = cache.len();
    cache.retain(|k, _| live.contains(k));
    if changed || cache.len() != before {
        save_scan_cache(archive, &cache);
    }
    progress(total, total);

    // Map transcripts and subagents by session id.
    let mut transcripts: HashMap<String, PathBuf> = HashMap::new();
    let mut subagents: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for p in &files {
        let comps: Vec<String> = p.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
        let n = comps.len();
        if n >= 3 && comps[n - 2] == "subagents" {
            let parent = comps[n - 3].clone();
            subagents.entry(parent).or_default().push(p.clone());
        } else if !p.to_string_lossy().contains(".superseded-") {
            let id = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            // Prefer the biggest copy if the same id shows up twice.
            let bigger = match transcripts.get(&id) {
                Some(old) => fs::metadata(p).map(|m| m.len()).unwrap_or(0) > fs::metadata(old).map(|m| m.len()).unwrap_or(0),
                None => true,
            };
            if bigger {
                transcripts.insert(id, p.clone());
            }
        }
    }

    let presets = load_presets(archive);
    let desktop = load_desktop(archive);
    let scan_of = |id: &str| -> Option<&Scan> {
        let p = transcripts.get(id)?;
        cache.get(&rel_key(archive, p))
    };
    let sub_totals = |id: &str| -> (BTreeMap<String, ModelTotals>, u32) {
        let mut m: BTreeMap<String, ModelTotals> = BTreeMap::new();
        let mut calls = 0;
        if let Some(list) = subagents.get(id) {
            for p in list {
                if let Some(s) = cache.get(&rel_key(archive, p)) {
                    for (k, v) in &s.models {
                        m.entry(k.clone()).or_default().add(v);
                    }
                    calls += s.tool_calls;
                }
            }
        }
        (m, calls)
    };

    let mut sessions: Vec<SessionSummary> = Vec::new();
    let mut claimed: HashSet<String> = HashSet::new();
    let mut desk_map: HashMap<String, DesktopSession> = HashMap::new();

    let mut fill_from_scans = |sum: &mut SessionSummary, ids: &[String]| {
        let mut models: BTreeMap<String, ModelTotals> = BTreeMap::new();
        let mut cc: Option<f64> = None;
        for id in ids {
            if let Some(s) = scan_of(id) {
                sum.has_transcript = true;
                sum.prompts += s.prompts;
                sum.tool_calls += s.tool_calls;
                for (k, v) in &s.models {
                    models.entry(k.clone()).or_default().add(v);
                }
                if let Some(c) = s.cc_cost {
                    cc = Some(cc.unwrap_or(0.0) + c);
                }
                sum.lines_added += s.lines_added;
                sum.lines_removed += s.lines_removed;
                for pr in &s.prs {
                    if !sum.prs.iter().any(|p| p.url == pr.url) {
                        sum.prs.push(pr.clone());
                    }
                }
                if sum.first_prompt.is_empty() {
                    sum.first_prompt = s.first_prompt.clone();
                }
                if sum.branch.is_empty() {
                    sum.branch = s.branch.clone();
                }
                if s.last_context > 0 {
                    sum.context_tokens = s.last_context;
                    if sum.model.is_empty() {
                        sum.model = s.last_model.clone();
                    }
                }
            }
            let (sm, calls) = sub_totals(id);
            for (k, v) in sm {
                models.entry(k).or_default().add(&v);
            }
            sum.tool_calls += calls;
        }
        let est: f64 = models.values().map(|m| m.cost).sum();
        sum.tokens = models.values().map(|m| m.tokens()).sum();
        match cc {
            // Claude Code's own running total is authoritative when it was recorded.
            Some(c) if c > 0.0 => {
                sum.cost_usd = c;
                sum.cost_estimated = false;
            }
            _ => {
                sum.cost_usd = est;
                sum.cost_estimated = true;
            }
        }
        if sum.model.is_empty() {
            if let Some((m, _)) = models.iter().max_by_key(|(_, v)| v.output) {
                sum.model = m.clone();
            }
        }
    };

    for d in desktop {
        let mut ids: Vec<String> = Vec::new();
        for p in d.prior_cli_session_ids.clone().unwrap_or_default() {
            if !ids.contains(&p) {
                ids.push(p);
            }
        }
        if let Some(c) = &d.cli_session_id {
            if !ids.contains(c) {
                ids.push(c.clone());
            }
        }
        for i in &ids {
            claimed.insert(i.clone());
        }
        let cwd = d.origin_cwd.clone().or(d.cwd.clone()).unwrap_or_default();
        let env = d.env_scope_id.clone().or(d.started_from_environment_id.clone());
        let (group, group_cwd) = group_for(&cwd, env.as_deref(), &presets);
        let mut sum = SessionSummary {
            key: d.session_id.clone(),
            source: if d.kind == "cowork" { "cowork".into() } else { "desktop".into() },
            profile: d.profile.clone(),
            cli_id: d.cli_session_id.clone().unwrap_or_default(),
            cli_ids: ids.clone(),
            title: d.title.clone().unwrap_or_default(),
            group,
            group_cwd,
            cwd: d.cwd.clone().unwrap_or_default(),
            created_ms: d.created_at.unwrap_or(0),
            updated_ms: d.last_activity_at.or(d.created_at).unwrap_or(0),
            archived: d.is_archived.unwrap_or(false),
            starred: d.is_starred.unwrap_or(false),
            model: d.model.clone().unwrap_or_default(),
            effort: d.effort.clone().unwrap_or_default(),
            permission_mode: d.permission_mode.clone().unwrap_or_default(),
            branch: d.branch.clone().unwrap_or_default(),
            worktree: d.worktree_name.clone().unwrap_or_default(),
            artifacts: d.published_artifacts.as_ref().map(|a| a.len() as u32).unwrap_or(0),
            scheduled: d.scheduled_task_id.is_some(),
            side: d.spawned_from.is_some(),
            parent_key: d
                .spawned_from
                .as_ref()
                .map(|v| str_of(v, "sessionId"))
                .unwrap_or_default(),
            ..Default::default()
        };
        if let Some(prs) = &d.prs {
            for p in prs {
                let url = str_of(p, "url");
                if url.is_empty() {
                    continue;
                }
                sum.prs.push(PrRef {
                    number: p.get("prNumber").and_then(|x| x.as_u64()).unwrap_or(0),
                    url,
                    repo: str_of(p, "repo"),
                    state: str_of(p, "state"),
                });
            }
        }
        sum.summary = d
            .post_turn_summary
            .as_ref()
            .map(|v| str_of(v, "status_detail"))
            .filter(|s| !s.is_empty())
            .or_else(|| d.turn_wrap_up.as_ref().map(|v| str_of(v, "description")))
            .unwrap_or_default();
        fill_from_scans(&mut sum, &ids);
        if sum.title.trim().is_empty() {
            sum.title = fallback_title(&sum.first_prompt);
        }
        desk_map.insert(sum.key.clone(), d);
        sessions.push(sum);
    }

    // Transcripts the desktop app never indexed: terminal sessions, SDK runs, older history.
    let mut cli_ids: Vec<&String> = transcripts.keys().filter(|id| !claimed.contains(*id)).collect();
    cli_ids.sort();
    for id in cli_ids {
        let Some(s) = scan_of(id) else { continue };
        if s.prompts == 0 && s.assistant_msgs == 0 {
            continue; // empty shells (aborted starts, metadata-only files)
        }
        let p = transcripts.get(id).cloned().unwrap_or_default();
        let is_cowork = p.to_string_lossy().contains("local-agent-mode-sessions");
        let (group, group_cwd) = group_for(&s.cwd, None, &presets);
        let mut sum = SessionSummary {
            key: id.clone(),
            source: if is_cowork { "cowork".into() } else { "cli".into() },
            profile: String::new(),
            cli_id: id.clone(),
            cli_ids: vec![id.clone()],
            title: s
                .custom_title
                .clone()
                .or(s.agent_name.clone())
                .or(s.summary.clone())
                .unwrap_or_default(),
            group,
            group_cwd,
            cwd: s.cwd.clone(),
            created_ms: s.first_ts,
            updated_ms: s.last_ts.max(s.first_ts),
            ..Default::default()
        };
        fill_from_scans(&mut sum, &[id.clone()]);
        if sum.title.trim().is_empty() {
            sum.title = fallback_title(&sum.first_prompt);
        }
        sessions.push(sum);
    }

    // Cowork sessions that ran in Anthropic's cloud: only their metadata is on this
    // computer (session id, space, granted folders). List them so the history is complete.
    sessions.extend(cloud_cowork(archive, &claimed));

    // Conversations imported from a claude.ai data export.
    let mut extra_search: HashMap<String, String> = HashMap::new();
    for c in crate::claudeai::summaries(archive) {
        let uuid = str_of(&c, "uuid");
        if uuid.is_empty() {
            continue;
        }
        let key = format!("claudeai:{}", uuid);
        let first = str_of(&c, "first");
        let name = str_of(&c, "name");
        extra_search.insert(key.clone(), str_of(&c, "search"));
        let project = str_of(&c, "project");
        sessions.push(SessionSummary {
            key,
            source: "claudeai".into(),
            title: if name.trim().is_empty() { fallback_title(&first) } else { name },
            group: "claude.ai".into(),
            created_ms: c.get("created").and_then(|x| x.as_i64()).unwrap_or(0),
            updated_ms: c.get("updated").and_then(|x| x.as_i64()).unwrap_or(0),
            prompts: c.get("prompts").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            first_prompt: first,
            model: str_of(&c, "model"),
            summary: if project.is_empty() { String::new() } else { format!("Project: {}", project) },
            has_transcript: true,
            ..Default::default()
        });
    }

    for s in sessions.iter_mut() {
        s.model_name = if s.model.is_empty() { String::new() } else { pricing::display_name(&s.model) };
        s.context_window = if s.model.is_empty() { 200_000 } else { pricing::context_window(&s.model) };
        if s.context_tokens > s.context_window {
            s.context_window = 1_000_000;
        }
    }
    sessions.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    let by_key = sessions.iter().enumerate().map(|(i, s)| (s.key.clone(), i)).collect();
    Index {
        sessions,
        by_key,
        desktop: desk_map,
        transcripts,
        subagents,
        scans: cache,
        presets,
        built_ms: crate::sync::now_ms(),
        archive: Some(archive.to_path_buf()),
        extra_search,
    }
}

fn cloud_cowork(archive: &Path, claimed: &HashSet<String>) -> Vec<SessionSummary> {
    let mut spaces: HashMap<String, String> = HashMap::new();
    let mut entries: Vec<(Value, i64, String)> = Vec::new();
    let Ok(rd) = fs::read_dir(archive.join("desktop")) else { return Vec::new() };
    for prof in rd.flatten() {
        let mut files = Vec::new();
        walk_files(
            &prof.path().join("local-agent-mode-sessions"),
            &|p: &Path| {
                let n = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                n == "spaces.json" || n == "remote-session-spaces.json"
            },
            &mut files,
        );
        for f in files {
            let Ok(v) = fs::read_to_string(&f).map(|t| serde_json::from_str::<Value>(&t).unwrap_or(Value::Null)) else { continue };
            let mtime = fs::metadata(&f).map(|m| mtime_ms(&m)).unwrap_or(0);
            if let Some(arr) = v.get("spaces").and_then(|x| x.as_array()) {
                for s in arr {
                    spaces.insert(str_of(s, "id"), str_of(s, "name"));
                }
            }
            if let Some(arr) = v.get("entries").and_then(|x| x.as_array()) {
                for e in arr {
                    entries.push((e.clone(), mtime, prof.file_name().to_string_lossy().to_string()));
                }
            }
        }
    }
    let mut out: Vec<SessionSummary> = Vec::new();
    for (e, mtime, profile) in entries {
        let id = str_of(&e, "sessionId");
        if id.is_empty() || claimed.contains(&id) || out.iter().any(|s| s.key == id) {
            continue;
        }
        let folder = e
            .get("folders")
            .and_then(|x| x.as_array())
            .and_then(|a| a.first())
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let space = spaces.get(&str_of(&e, "spaceId")).cloned().unwrap_or_default();
        let place = if !space.is_empty() { space.clone() } else { paths::basename(&folder) };
        out.push(SessionSummary {
            key: id.clone(),
            source: "cowork-cloud".into(),
            profile,
            cli_id: String::new(),
            cli_ids: Vec::new(),
            title: if place.is_empty() { "Cowork session".into() } else { format!("Cowork session in {}", place) },
            group: "Cowork".into(),
            group_cwd: folder.clone(),
            cwd: folder,
            // The session's own dates live in the cloud; the metadata file's time is the best local clue.
            updated_ms: mtime,
            created_ms: 0,
            summary: if space.is_empty() { String::new() } else { format!("Space: {}", space) },
            has_transcript: false,
            ..Default::default()
        });
    }
    out
}

fn fallback_title(first_prompt: &str) -> String {
    let t = first_prompt.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if t.is_empty() {
        return "Untitled session".into();
    }
    let mut out: String = t.chars().take(60).collect();
    if t.chars().count() > 60 {
        out.push('…');
    }
    out
}

impl Index {
    /// The desktop app samples plan usage every ~15 minutes into plan-usage-history.json:
    /// fh = current 5-hour session %, sd = weekly %, xu = extra-usage spend %.
    /// Merged per organisation across both profiles, oldest first.
    pub fn plan_usage(&self) -> Value {
        let Some(archive) = &self.archive else { return Value::Null };
        let mut per_org: BTreeMap<String, (BTreeMap<i64, Value>, HashMap<String, u32>)> = BTreeMap::new();
        let Ok(rd) = fs::read_dir(archive.join("desktop")) else { return Value::Null };
        for prof in rd.flatten() {
            let name = prof.file_name().to_string_lossy().to_string();
            let Ok(txt) = fs::read_to_string(prof.path().join("plan-usage-history.json")) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
            for s in v.get("samples").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                let org = str_of(&s, "org");
                let t = s.get("t").and_then(|x| x.as_i64()).unwrap_or(0);
                if org.is_empty() || t == 0 {
                    continue;
                }
                let u = s.get("u").cloned().unwrap_or(Value::Null);
                let e = per_org.entry(org).or_default();
                e.0.insert(t, serde_json::json!([t, u.get("fh"), u.get("sd"), u.get("xu")]));
                *e.1.entry(name.clone()).or_default() += 1;
            }
        }
        let orgs: Vec<Value> = per_org
            .into_iter()
            .map(|(org, (samples, profs))| {
                let profile = profs.into_iter().max_by_key(|(_, n)| *n).map(|(p, _)| p).unwrap_or_default();
                serde_json::json!({"org": org, "profile": profile, "samples": samples.into_values().collect::<Vec<_>>()})
            })
            .filter(|o| o["samples"].as_array().map(|a| a.len() > 2).unwrap_or(false))
            .collect();
        Value::Array(orgs)
    }

    pub fn scan_for(&self, archive: &Path, id: &str) -> Option<&Scan> {
        let p = self.transcripts.get(id)?;
        self.scans.get(&rel_key(archive, p))
    }

    pub fn search(&self, archive: &Path, q: &str, limit: usize) -> Vec<Value> {
        let q = q.trim().to_lowercase();
        if q.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for s in &self.sessions {
            let mut hit_title = s.title.to_lowercase().contains(&q);
            let mut snippet = String::new();
            if let Some(text) = self.extra_search.get(&s.key) {
                if let Some(i) = text.find(&q) {
                    let mut a = i.saturating_sub(60);
                    while !text.is_char_boundary(a) {
                        a -= 1;
                    }
                    let mut b = (i + q.len() + 100).min(text.len());
                    while !text.is_char_boundary(b) {
                        b -= 1;
                    }
                    snippet = text[a..b].replace('\n', " ");
                    hit_title = true;
                }
            }
            for id in &s.cli_ids {
                let Some(sc) = self.scan_for(archive, id) else { continue };
                if let Some(i) = sc.search.find(&q) {
                    let mut a = i.saturating_sub(60);
                    while !sc.search.is_char_boundary(a) {
                        a -= 1;
                    }
                    let mut b = (i + q.len() + 100).min(sc.search.len());
                    while !sc.search.is_char_boundary(b) {
                        b -= 1;
                    }
                    snippet = sc.search[a..b].replace('\n', " ");
                    hit_title = true;
                    break;
                }
            }
            if hit_title {
                out.push(serde_json::json!({ "key": s.key, "snippet": snippet }));
                if out.len() >= limit {
                    break;
                }
            }
        }
        out
    }

    /// Spend and tokens per day and per model, for the Usage view.
    pub fn usage(&self) -> Value {
        let mut days: BTreeMap<String, BTreeMap<String, ModelTotals>> = BTreeMap::new();
        let mut models: BTreeMap<String, ModelTotals> = BTreeMap::new();
        for s in self.scans.values() {
            for (d, m) in &s.daily {
                let e = days.entry(d.clone()).or_default();
                for (k, v) in m {
                    e.entry(k.clone()).or_default().add(v);
                    models.entry(k.clone()).or_default().add(v);
                }
            }
        }
        let days_v: Vec<Value> = days
            .iter()
            .map(|(d, m)| {
                let cost: f64 = m.values().map(|x| x.cost).sum();
                let tokens: u64 = m.values().map(|x| x.tokens()).sum();
                let msgs: u32 = m.values().map(|x| x.messages).sum();
                let by: serde_json::Map<String, Value> = m
                    .iter()
                    .map(|(k, v)| (pricing::display_name(k), serde_json::json!({"cost": v.cost, "tokens": v.tokens()})))
                    .collect();
                serde_json::json!({"day": d, "cost": cost, "tokens": tokens, "messages": msgs, "by_model": by})
            })
            .collect();
        let mut merged: BTreeMap<String, ModelTotals> = BTreeMap::new();
        for (k, v) in &models {
            merged.entry(pricing::display_name(k)).or_default().add(v);
        }
        let models_v: Vec<Value> = merged
            .iter()
            .map(|(k, v)| {
                serde_json::json!({"model": k, "cost": v.cost, "input": v.input, "output": v.output,
                "cache_read": v.cache_read, "cache_write": v.cw5m + v.cw1h, "messages": v.messages})
            })
            .collect();
        let mut by_group: BTreeMap<String, (f64, u32)> = BTreeMap::new();
        for s in &self.sessions {
            let e = by_group.entry(s.group.clone()).or_default();
            e.0 += s.cost_usd;
            e.1 += 1;
        }
        let groups_v: Vec<Value> = by_group
            .iter()
            .map(|(k, (c, n))| serde_json::json!({"group": k, "cost": c, "sessions": n}))
            .collect();
        serde_json::json!({"days": days_v, "models": models_v, "groups": groups_v,
            "plan": self.plan_usage(),
            "sessions": self.sessions.len(),
            "total_cost": self.sessions.iter().map(|s| s.cost_usd).sum::<f64>()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_ts("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(parse_ts("2026-11-08T18:17:31.517Z"), 1794161851517);
        assert_eq!(parse_ts("2026-11-08T18:17:31Z"), 1794161851000);
        assert_eq!(parse_ts("garbage"), 0);
    }

    #[test]
    fn finds_top_level_type() {
        let assistant = r#"{"parentUuid":"a","isSidechain":false,"message":{"model":"m","type":"message","content":[{"type":"text","text":"hi"}]},"type":"assistant","uuid":"b"}"#;
        assert_eq!(line_type(assistant).as_deref(), Some("assistant"));
        let user = r#"{"parentUuid":null,"isSidechain":false,"promptId":"p","type":"user","message":{"role":"user","content":"hi"}}"#;
        assert_eq!(line_type(user).as_deref(), Some("user"));
        assert_eq!(line_type(r#"{"type":"custom-title","customTitle":"x"}"#).as_deref(), Some("custom-title"));
        // a quoted type inside a string value must not fool it
        let tricky = r#"{"parentUuid":"a","message":{"content":[{"type":"tool_use","input":{"cmd":"echo \"type\":\"user\""}}]},"type":"assistant"}"#;
        assert_eq!(line_type(tricky).as_deref(), Some("assistant"));
    }

    #[test]
    fn cleans_prompts() {
        assert_eq!(clean_prompt("  hello  ").as_deref(), Some("hello"));
        assert_eq!(clean_prompt("<task-notification>x</task-notification>"), None);
        assert_eq!(clean_prompt("<local-command-stdout>ok</local-command-stdout>"), None);
        assert_eq!(
            clean_prompt("<command-name>/goal</command-name><command-message>goal</command-message><command-args>ship it</command-args>").as_deref(),
            Some("/goal ship it")
        );
        assert_eq!(clean_prompt("<bash-input>ls</bash-input>").as_deref(), Some("! ls"));
        assert_eq!(clean_prompt("fix it<system-reminder>secret</system-reminder>").as_deref(), Some("fix it"));
    }

    #[test]
    fn head_respects_char_boundaries() {
        let s = "ab→cd";
        assert_eq!(head(s, 3), "ab");
        assert_eq!(head(s, 5), "ab→");
    }

    #[test]
    fn usage_costs_use_model_prices() {
        let u = Usage { input_tokens: 1_000_000, output_tokens: 1_000_000, ..Default::default() };
        let t = u.totals("claude-opus-5-5");
        assert!((t.cost - 24.0).abs() < 1e-9);
        assert_eq!(crate::pricing::display_name("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
        assert_eq!(crate::pricing::display_name("claude-opus-5-5[1m]"), "Opus 5.5");
    }
}
