//! Turns one session's transcript(s) into a render model for the UI:
//! messages with tool calls paired to their results, plus the side panel
//! data (context breakdown, cost per model, outputs, environment).

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::index::{clean_prompt, parse_ts, DesktopSession, Index, ModelTotals, SessionSummary, Usage};
use crate::pricing;

const RESULT_CAP: usize = 40_000;
const INPUT_STR_CAP: usize = 60_000;

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn cap(text: &str, n: usize) -> (String, bool) {
    if text.len() <= n {
        return (text.to_string(), false);
    }
    let mut end = n;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// Shorten very long string values inside a tool input (file contents in Write, etc.).
fn trim_input(v: &Value) -> Value {
    match v {
        Value::String(st) if st.len() > INPUT_STR_CAP => {
            let (c, _) = cap(st, INPUT_STR_CAP);
            Value::String(format!("{}\n… ({} more characters)", c, st.len() - c.len()))
        }
        Value::Array(a) => Value::Array(a.iter().map(trim_input).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), trim_input(v))).collect()),
        other => other.clone(),
    }
}

fn image_src(block: &Value) -> Option<String> {
    let src = block.get("source")?;
    let kind = s(src, "type");
    if kind == "base64" {
        let mt = src.get("media_type").and_then(|x| x.as_str()).unwrap_or("image/png");
        let data = src.get("data").and_then(|x| x.as_str())?;
        return Some(format!("data:{};base64,{}", mt, data));
    }
    if kind == "url" {
        return src.get("url").and_then(|x| x.as_str()).map(|x| x.to_string());
    }
    None
}

/// Text + images of a tool_result's `content` (string or block list).
fn result_payload(content: Option<&Value>) -> (String, Vec<String>) {
    let mut text = String::new();
    let mut images = Vec::new();
    match content {
        Some(Value::String(st)) => text.push_str(st),
        Some(Value::Array(a)) => {
            for b in a {
                match s(b, "type").as_str() {
                    "text" => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(&s(b, "text"));
                    }
                    "image" => {
                        if let Some(src) = image_src(b) {
                            images.push(src);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    (text, images)
}

fn task_notification_summary(t: &str) -> String {
    let get = |tag: &str| -> String {
        let a = format!("<{}>", tag);
        let b = format!("</{}>", tag);
        t.find(&a)
            .and_then(|i| t[i + a.len()..].find(&b).map(|j| t[i + a.len()..i + a.len() + j].trim().to_string()))
            .unwrap_or_default()
    };
    let summary = get("summary");
    let status = get("status");
    if !summary.is_empty() {
        summary
    } else if !status.is_empty() {
        format!("Background task {}", status)
    } else {
        "Background task update".into()
    }
}

struct Ctx {
    archive: PathBuf,
    items: Vec<Value>,
    /// tool_use id -> (item index, block index)
    tools: HashMap<String, (usize, usize)>,
    /// message.id -> item index, so split assistant lines merge into one bubble
    msg_items: HashMap<String, usize>,
    seen_usage: std::collections::HashSet<String>,
    models: BTreeMap<String, ModelTotals>,
    last_usage: Option<(String, Usage)>,
    shape: Option<Value>,
    attachments: Map<String, Value>,
    tool_counts: BTreeMap<String, u64>,
    files_written: BTreeMap<String, (String, u64)>,
    artifacts: Vec<Value>,
    prs: Vec<Value>,
    plan: Option<Value>,
    todos: Option<Value>,
    cc_cost: Option<Value>,
    first_ts: i64,
    last_ts: i64,
    versions: Vec<String>,
    branch: String,
    cwd: String,
    lines_added: u64,
    lines_removed: u64,
}

impl Ctx {
    fn new(archive: &Path) -> Self {
        Ctx {
            archive: archive.to_path_buf(),
            items: Vec::new(),
            tools: HashMap::new(),
            msg_items: HashMap::new(),
            seen_usage: Default::default(),
            models: BTreeMap::new(),
            last_usage: None,
            shape: None,
            attachments: Map::new(),
            tool_counts: BTreeMap::new(),
            files_written: BTreeMap::new(),
            artifacts: Vec::new(),
            prs: Vec::new(),
            plan: None,
            todos: None,
            cc_cost: None,
            first_ts: 0,
            last_ts: 0,
            versions: Vec::new(),
            branch: String::new(),
            cwd: String::new(),
            lines_added: 0,
            lines_removed: 0,
        }
    }

    fn ts(&mut self, v: &Value) -> i64 {
        let ms = v.get("timestamp").and_then(|x| x.as_str()).map(parse_ts).unwrap_or(0);
        if ms > 0 {
            if self.first_ts == 0 || ms < self.first_ts {
                self.first_ts = ms;
            }
            self.last_ts = self.last_ts.max(ms);
        }
        ms
    }

    fn push_user(&mut self, uuid: &str, ts: i64, text: String, images: Vec<String>, origin: &str) {
        self.items.push(json!({"kind": "user", "uuid": uuid, "ts": ts, "text": text, "images": images, "origin": origin}));
    }

    fn line(&mut self, v: &Value, sidechain_ok: bool) {
        let t = s(v, "type");
        if !sidechain_ok && v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
            return;
        }
        match t.as_str() {
            "user" => self.user(v),
            "assistant" => self.assistant(v),
            "system" => self.system(v),
            "attachment" => self.attachment(v),
            "api-request-shape" => self.shape = v.get("shape").cloned(),
            "cost-state" => self.cc_cost = Some(v.clone()),
            "pr-link" => {
                let url = s(v, "prUrl");
                if !url.is_empty() && !self.prs.iter().any(|p| s(p, "url") == url) {
                    self.prs.push(json!({"number": v.get("prNumber"), "url": url, "repo": s(v, "prRepository")}));
                }
            }
            "frame-link" => {
                let url = s(v, "frameUrl");
                if !url.is_empty() && !self.artifacts.iter().any(|a| s(a, "url") == url) {
                    self.artifacts.push(json!({"url": url, "title": s(v, "title"), "path": s(v, "path")}));
                }
            }
            "summary" => {
                let txt = s(v, "summary");
                if !txt.is_empty() {
                    self.items.push(json!({"kind": "system", "subtype": "summary", "text": txt}));
                }
            }
            _ => {}
        }
    }

    fn user(&mut self, v: &Value) {
        let ts = self.ts(v);
        let uuid = s(v, "uuid");
        if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
            if self.cwd.is_empty() {
                self.cwd = c.to_string();
            }
        }
        if let Some(b) = v.get("gitBranch").and_then(|x| x.as_str()) {
            if !b.is_empty() && b != "HEAD" {
                self.branch = b.to_string();
            }
        }
        if let Some(ver) = v.get("version").and_then(|x| x.as_str()) {
            if !self.versions.iter().any(|x| x == ver) {
                self.versions.push(ver.to_string());
            }
        }
        let msg = v.get("message").cloned().unwrap_or(Value::Null);
        let content = msg.get("content");
        if v.get("isCompactSummary").and_then(|x| x.as_bool()) == Some(true) {
            let (text, _) = result_payload(content);
            self.items.push(json!({"kind": "compact", "ts": ts, "text": text}));
            return;
        }
        let is_meta = v.get("isMeta").and_then(|x| x.as_bool()) == Some(true);
        match content {
            Some(Value::String(st)) => {
                if is_meta {
                    return;
                }
                self.user_text(&uuid, ts, st, Vec::new());
            }
            Some(Value::Array(blocks)) => {
                let mut texts = Vec::new();
                let mut images = Vec::new();
                for b in blocks {
                    match s(b, "type").as_str() {
                        "tool_result" => self.tool_result(b, v),
                        "text" => texts.push(s(b, "text")),
                        "image" => {
                            if let Some(src) = image_src(b) {
                                images.push(src)
                            }
                        }
                        "document" => texts.push(format!("📎 {}", b.pointer("/title").and_then(|x| x.as_str()).unwrap_or("Attached document"))),
                        _ => {}
                    }
                }
                if is_meta {
                    return;
                }
                if !texts.is_empty() || !images.is_empty() {
                    let joined = texts.join("\n");
                    self.user_text(&uuid, ts, &joined, images);
                }
            }
            _ => {}
        }
    }

    fn user_text(&mut self, uuid: &str, ts: i64, raw: &str, images: Vec<String>) {
        let t = raw.trim_start();
        if t.starts_with("<task-notification>") {
            self.items.push(json!({"kind": "system", "subtype": "task", "ts": ts, "text": task_notification_summary(t)}));
            return;
        }
        if t.starts_with("[Request interrupted") {
            self.items.push(json!({"kind": "system", "subtype": "interrupted", "ts": ts, "text": "Interrupted by you"}));
            return;
        }
        if t.starts_with("<local-command-stdout>") || t.starts_with("<local-command-stderr>") {
            let inner = t
                .trim_start_matches("<local-command-stdout>")
                .trim_start_matches("<local-command-stderr>")
                .trim_end_matches("</local-command-stdout>")
                .trim_end_matches("</local-command-stderr>")
                .trim();
            if !inner.is_empty() {
                self.items.push(json!({"kind": "system", "subtype": "command_output", "ts": ts, "text": inner}));
            }
            return;
        }
        match clean_prompt(raw) {
            Some(text) => self.push_user(uuid, ts, text, images, "typed"),
            None if !images.is_empty() => self.push_user(uuid, ts, String::new(), images, "typed"),
            None => {}
        }
    }

    fn tool_result(&mut self, b: &Value, line: &Value) {
        let id = s(b, "tool_use_id");
        let Some(&(ii, bi)) = self.tools.get(&id) else { return };
        let (mut text, images) = result_payload(b.get("content"));
        let mut persisted = false;
        if text.contains("<persisted-output>") {
            if let Some(full) = self.persisted_output(&text) {
                text = full;
                persisted = true;
            }
        }
        let full_len = text.len();
        let (text, truncated) = cap(&text, RESULT_CAP);
        let mut r = json!({
            "text": text, "images": images, "truncated": truncated, "full_len": full_len,
            "error": b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false),
            "persisted": persisted,
        });
        let tur = line.get("toolUseResult");
        if let Some(tur) = tur {
            if let Some(o) = tur.as_object() {
                if let Some(p) = o.get("structuredPatch") {
                    r["patch"] = p.clone();
                    if let Some(a) = p.as_array() {
                        for h in a {
                            if let Some(lines) = h.get("lines").and_then(|x| x.as_array()) {
                                for l in lines {
                                    let l = l.as_str().unwrap_or("");
                                    if l.starts_with('+') {
                                        self.lines_added += 1;
                                    } else if l.starts_with('-') {
                                        self.lines_removed += 1;
                                    }
                                }
                            }
                        }
                    }
                }
                for k in ["agentId", "filePath", "type", "totalDurationMs", "totalTokens", "totalToolUseCount", "status", "resolvedModel"] {
                    if let Some(x) = o.get(k) {
                        r[k] = x.clone();
                    }
                }
                if let Some(ans) = o.get("answers") {
                    r["answers"] = ans.clone();
                }
            }
        }
        if let Some(item) = self.items.get_mut(ii) {
            if let Some(block) = item.get_mut("blocks").and_then(|x| x.get_mut(bi)) {
                block["result"] = r;
            }
        }
    }

    /// Claude Code moves big tool outputs into `<session>/tool-results/*.txt` and leaves
    /// a pointer in the transcript. The archive keeps those files, so read it back.
    fn persisted_output(&self, text: &str) -> Option<String> {
        let marker = "Full output saved to: ";
        let i = text.find(marker)? + marker.len();
        let path = text[i..].lines().next()?.trim();
        let norm = path.replace('/', "\\");
        let lower = norm.to_lowercase();
        let key = r"\.claude\projects\";
        let j = lower.find(key)? + key.len();
        let rel = &norm[j..];
        let p = self.archive.join("claude").join("projects").join(rel);
        let p = if p.exists() { p } else { PathBuf::from(path) };
        fs::read_to_string(p).ok()
    }

    fn assistant(&mut self, v: &Value) {
        let ts = self.ts(v);
        let msg = v.get("message").cloned().unwrap_or(Value::Null);
        let model = s(&msg, "model");
        if model == "<synthetic>" {
            // Client-side messages such as API errors rendered into the chat.
            let (text, _) = result_payload(msg.get("content"));
            if !text.trim().is_empty() {
                self.items.push(json!({"kind": "system", "subtype": "api_error", "ts": ts, "text": text}));
            }
            return;
        }
        let mid = s(&msg, "id");
        if let Some(u) = msg.get("usage") {
            if mid.is_empty() || self.seen_usage.insert(mid.clone()) {
                if let Ok(u) = serde_json::from_value::<Usage>(u.clone()) {
                    self.models.entry(model.clone()).or_default().add(&u.totals(&model));
                    if u.context() > 0 {
                        self.last_usage = Some((model.clone(), u));
                    }
                }
            }
        }
        let idx = match self.msg_items.get(&mid) {
            Some(&i) if !mid.is_empty() => i,
            _ => {
                self.items.push(json!({"kind": "assistant", "uuid": s(v, "uuid"), "ts": ts, "model": model, "blocks": []}));
                let i = self.items.len() - 1;
                if !mid.is_empty() {
                    self.msg_items.insert(mid.clone(), i);
                }
                i
            }
        };
        let think_ms = v.get("thinkingDurationMs").cloned().unwrap_or(Value::Null);
        let Some(blocks) = msg.get("content").and_then(|x| x.as_array()) else { return };
        for b in blocks {
            let bt = s(b, "type");
            let rendered = match bt.as_str() {
                "text" => {
                    let t = s(b, "text");
                    if t.trim().is_empty() {
                        None
                    } else {
                        Some(json!({"type": "text", "text": t}))
                    }
                }
                "thinking" => Some(json!({"type": "thinking", "text": s(b, "thinking"), "ms": think_ms})),
                "redacted_thinking" => Some(json!({"type": "thinking", "text": "", "ms": think_ms})),
                "tool_use" | "server_tool_use" => {
                    let name = s(b, "name");
                    *self.tool_counts.entry(name.clone()).or_default() += 1;
                    let input = b.get("input").cloned().unwrap_or(Value::Null);
                    self.note_tool(&name, &input, v);
                    Some(json!({"type": "tool", "id": s(b, "id"), "name": name, "input": trim_input(&input),
                        "server": bt == "server_tool_use"}))
                }
                "web_search_tool_result" | "web_fetch_tool_result" => {
                    let id = s(b, "tool_use_id");
                    if let Some(&(ii, bi)) = self.tools.get(&id) {
                        let txt = serde_json::to_string_pretty(b.get("content").unwrap_or(&Value::Null)).unwrap_or_default();
                        let (txt, tr) = cap(&txt, RESULT_CAP);
                        if let Some(block) = self.items[ii].get_mut("blocks").and_then(|x| x.get_mut(bi)) {
                            block["result"] = json!({"text": txt, "truncated": tr, "images": []});
                        }
                    }
                    None
                }
                _ => None,
            };
            if let Some(r) = rendered {
                let is_tool = r.get("type").and_then(|x| x.as_str()) == Some("tool");
                let tool_id = s(&r, "id");
                if let Some(arr) = self.items[idx].get_mut("blocks").and_then(|x| x.as_array_mut()) {
                    arr.push(r);
                    if is_tool {
                        let bi = arr.len() - 1;
                        self.tools.insert(tool_id, (idx, bi));
                    }
                }
            }
        }
    }

    fn note_tool(&mut self, name: &str, input: &Value, line: &Value) {
        let path = s(input, "file_path");
        match name {
            "Write" if !path.is_empty() => {
                let e = self.files_written.entry(path).or_insert(("created".into(), 0));
                e.1 += 1;
            }
            "Edit" | "MultiEdit" | "NotebookEdit" if !path.is_empty() => {
                let e = self.files_written.entry(path).or_insert(("edited".into(), 0));
                e.1 += 1;
            }
            "TodoWrite" => self.todos = input.get("todos").cloned(),
            _ => {}
        }
        if name.ends_with("update_plan") {
            if let Some(items) = input.get("items") {
                self.plan = Some(items.clone());
            } else if let Some(Value::Array(plan)) = self.plan.clone() {
                // {advance:true} / {done:[..], start:n} updates against the last full list
                let mut plan = plan;
                if input.get("advance").and_then(|x| x.as_bool()) == Some(true) {
                    if let Some(i) = plan.iter().position(|p| s(p, "status") == "in_progress") {
                        plan[i]["status"] = json!("completed");
                        if let Some(n) = plan.iter().skip(i + 1).position(|p| s(p, "status") == "pending") {
                            plan[i + 1 + n]["status"] = json!("in_progress");
                        }
                    }
                }
                if let Some(done) = input.get("done").and_then(|x| x.as_array()) {
                    for d in done {
                        if let Some(k) = d.as_u64() {
                            if let Some(p) = plan.get_mut(k as usize - 1) {
                                p["status"] = json!("completed");
                            }
                        }
                    }
                }
                if let Some(k) = input.get("start").and_then(|x| x.as_u64()) {
                    if let Some(p) = plan.get_mut(k as usize - 1) {
                        p["status"] = json!("in_progress");
                    }
                }
                self.plan = Some(Value::Array(plan));
            }
        }
        if name.ends_with("wrap_up") {
            for p in self.plan.iter_mut() {
                if let Some(a) = p.as_array_mut() {
                    for it in a.iter_mut() {
                        it["status"] = json!("completed");
                    }
                }
            }
        }
        let _ = line;
    }

    fn system(&mut self, v: &Value) {
        let ts = self.ts(v);
        let sub = s(v, "subtype");
        match sub.as_str() {
            "compact_boundary" => {
                let trig = v.pointer("/compactMetadata/trigger").and_then(|x| x.as_str()).unwrap_or("");
                let pre = v.pointer("/compactMetadata/preTokens").and_then(|x| x.as_u64()).unwrap_or(0);
                self.items.push(json!({"kind": "divider", "ts": ts, "text": "Conversation compacted",
                    "detail": if pre > 0 { format!("{} · {} tokens before", trig, pre) } else { trig.to_string() }}));
            }
            "api_error" => {
                let msg = v
                    .pointer("/error/formatted")
                    .or_else(|| v.pointer("/error/message"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("API error");
                self.items.push(json!({"kind": "system", "subtype": "api_error", "ts": ts, "text": msg,
                    "retry": v.get("retryAttempt"), "level": s(v, "level")}));
            }
            "local_command" => {
                let c = s(v, "content");
                let inner = c
                    .replace("<local-command-stdout>", "")
                    .replace("</local-command-stdout>", "")
                    .replace("<local-command-stderr>", "")
                    .replace("</local-command-stderr>", "");
                let inner = inner.trim();
                if !inner.is_empty() {
                    self.items.push(json!({"kind": "system", "subtype": "command_output", "ts": ts, "text": inner}));
                }
            }
            "informational" => {
                let c = s(v, "content");
                if !c.is_empty() {
                    self.items.push(json!({"kind": "system", "subtype": "info", "ts": ts, "text": c, "level": s(v, "level")}));
                }
            }
            _ => {}
        }
    }

    fn attachment(&mut self, v: &Value) {
        let ts = self.ts(v);
        let Some(a) = v.get("attachment") else { return };
        let t = s(a, "type");
        match t.as_str() {
            "queued_command" => {
                let p = s(a, "prompt");
                if p.trim_start().starts_with("<task-notification>") {
                    self.items.push(json!({"kind": "system", "subtype": "task", "ts": ts, "text": task_notification_summary(&p)}));
                } else if let Some(text) = clean_prompt(&p) {
                    let uuid = s(v, "uuid");
                    self.push_user(&uuid, ts, text, Vec::new(), "queued");
                }
            }
            "goal_status" => {
                if a.get("sentinel").and_then(|x| x.as_bool()) != Some(true) {
                    let met = a.get("met").and_then(|x| x.as_bool()).unwrap_or(false);
                    self.items.push(json!({"kind": "system", "subtype": "goal", "ts": ts,
                        "text": if met { "Goal met" } else { "Goal not met yet" }, "detail": s(a, "reason")}));
                }
            }
            "instructions" | "skill_listing" | "mcp_instructions_delta" | "agent_listing_delta" | "deferred_tools_delta"
            | "session_context" | "environment" | "model" | "auto_mode" | "date" => {
                // Keep the latest of each for the context breakdown; size from what was rendered.
                let size = v.get("rendered").map(|r| r.to_string().len()).unwrap_or_else(|| a.to_string().len());
                let mut rec = json!({"size": size});
                match t.as_str() {
                    "instructions" => {
                        let files: Vec<Value> = a
                            .get("files")
                            .and_then(|x| x.as_array())
                            .map(|fs| {
                                fs.iter()
                                    .map(|f| json!({"path": s(f, "path"), "type": s(f, "type"),
                                        "tokens": s(f, "content").len() / 4}))
                                    .collect()
                            })
                            .unwrap_or_default();
                        rec["files"] = Value::Array(files);
                    }
                    "skill_listing" => {
                        rec["count"] = a.get("skillCount").cloned().unwrap_or(Value::Null);
                        rec["names"] = a.get("names").cloned().unwrap_or(Value::Null);
                    }
                    "mcp_instructions_delta" => rec["names"] = a.get("addedNames").cloned().unwrap_or(Value::Null),
                    "agent_listing_delta" => {
                        let added: Vec<String> = a
                            .get("addedTypes")
                            .and_then(|x| x.as_array())
                            .map(|x| x.iter().filter_map(|y| y.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let builtin: Vec<String> = a
                            .get("builtInTypes")
                            .and_then(|x| x.as_array())
                            .map(|x| x.iter().filter_map(|y| y.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let custom: Vec<String> = added.into_iter().filter(|x| !builtin.contains(x)).collect();
                        rec["names"] = json!(custom);
                    }
                    "deferred_tools_delta" => {
                        let names: Vec<String> = a
                            .get("addedNames")
                            .and_then(|x| x.as_array())
                            .map(|x| x.iter().filter_map(|y| y.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        let mcp = names.iter().filter(|n| n.starts_with("mcp__")).count();
                        rec["mcp"] = json!(mcp);
                        rec["system"] = json!(names.len() - mcp);
                    }
                    "environment" => rec["snapshot"] = a.get("snapshot").cloned().unwrap_or(Value::Null),
                    _ => {}
                }
                // Deltas accumulate; full listings replace.
                let prev = self.attachments.get(&t).cloned();
                if t.ends_with("_delta") {
                    if let Some(p) = prev {
                        let psize = p.get("size").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                        rec["size"] = json!(size + psize);
                        for k in ["mcp", "system"] {
                            if let (Some(a1), Some(b1)) = (p.get(k).and_then(|x| x.as_u64()), rec.get(k).and_then(|x| x.as_u64())) {
                                rec[k] = json!(a1 + b1);
                            }
                        }
                        if let (Some(Value::Array(pa)), Some(Value::Array(ra))) = (p.get("names"), rec.get("names").cloned()) {
                            let mut m = pa.clone();
                            for n in ra {
                                if !m.contains(&n) {
                                    m.push(n);
                                }
                            }
                            rec["names"] = Value::Array(m);
                        }
                    }
                }
                self.attachments.insert(t, rec);
            }
            _ => {}
        }
    }
}

fn read_lines(path: &Path, ctx: &mut Ctx, sidechain_ok: bool) {
    let Ok(f) = fs::File::open(path) else { return };
    let r = BufReader::with_capacity(1 << 20, f);
    for line in r.lines().map_while(Result::ok) {
        if line.len() < 10 {
            continue;
        }
        // Skip the heavy request-logging records outright.
        let head = crate::index::head(&line, 60);
        if head.contains("\"api-request-blob\"") || head.contains("\"file-history") || head.contains("\"queue-operation\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        ctx.line(&v, sidechain_ok);
    }
}

fn tokens_of(v: &Value) -> u64 {
    (v.to_string().len() / 4) as u64
}

fn context_breakdown(ctx: &Ctx, window_hint: u64) -> Value {
    let Some((model, u)) = &ctx.last_usage else { return Value::Null };
    let total = u.context() + u.output_tokens;
    let mut window = pricing::context_window(model).max(window_hint);
    if total > window {
        window = 1_000_000;
    }
    let mut system_prompt = 0u64;
    let mut system_tools = 0u64;
    let mut mcp_tools = 0u64;
    let mut mcp_tool_names: Vec<String> = Vec::new();
    if let Some(shape) = &ctx.shape {
        if let Some(sys) = shape.get("system").and_then(|x| x.as_array()) {
            system_prompt = sys.iter().map(|b| (s(b, "text").len() / 4) as u64).sum();
        }
        if let Some(tools) = shape.get("tools").and_then(|x| x.as_array()) {
            for t in tools {
                let n = s(t, "name");
                if n.starts_with("mcp__") {
                    mcp_tools += tokens_of(t);
                    mcp_tool_names.push(n);
                } else {
                    system_tools += tokens_of(t);
                }
            }
        }
    }
    let att = |k: &str| -> u64 {
        ctx.attachments
            .get(k)
            .and_then(|a| a.get("size"))
            .and_then(|x| x.as_u64())
            .map(|x| x / 4)
            .unwrap_or(0)
    };
    let memory = att("instructions");
    let skills = att("skill_listing");
    let mcp_instr = att("mcp_instructions_delta");
    let agents = att("agent_listing_delta");
    let deferred = ctx.attachments.get("deferred_tools_delta").cloned().unwrap_or(Value::Null);
    let autocompact = (window as f64 * 0.033) as u64;
    let fixed = system_prompt + system_tools + mcp_tools + memory + skills + mcp_instr + agents;
    let messages = total.saturating_sub(fixed);
    let free = window.saturating_sub(total + autocompact);
    let mut mcp_servers: Vec<String> = mcp_tool_names
        .iter()
        .filter_map(|n| n.strip_prefix("mcp__").and_then(|r| r.split("__").next()).map(String::from))
        .collect();
    mcp_servers.dedup();
    json!({
        "model": model,
        "total": total,
        "window": window,
        "categories": [
            {"key": "messages", "name": "Messages", "tokens": messages},
            {"key": "system_tools", "name": "System tools", "tokens": system_tools},
            {"key": "system_prompt", "name": "System prompt", "tokens": system_prompt},
            {"key": "mcp_tools", "name": "MCP tools", "tokens": mcp_tools},
            {"key": "skills", "name": "Skills", "tokens": skills},
            {"key": "memory", "name": "Memory files", "tokens": memory},
            {"key": "mcp_instructions", "name": "MCP server instructions", "tokens": mcp_instr},
            {"key": "agents", "name": "Custom agents", "tokens": agents},
            {"key": "autocompact", "name": "Autocompact buffer", "tokens": autocompact},
            {"key": "free", "name": "Free space", "tokens": free},
        ],
        "deferred": {"system": deferred.get("system"), "mcp": deferred.get("mcp")},
        "lists": {
            "mcp_tools": mcp_tool_names,
            "memory_files": ctx.attachments.get("instructions").and_then(|a| a.get("files")).cloned().unwrap_or(json!([])),
            "agents": ctx.attachments.get("agent_listing_delta").and_then(|a| a.get("names")).cloned().unwrap_or(json!([])),
            "skills": ctx.attachments.get("skill_listing").and_then(|a| a.get("names")).cloned().unwrap_or(json!([])),
        },
        "usage": {"input": u.input_tokens, "cache_read": u.cache_read_input_tokens,
                  "cache_write": u.cache_creation_input_tokens, "output": u.output_tokens},
    })
}

fn connectors(desk: Option<&DesktopSession>) -> Value {
    let Some(d) = desk else { return json!([]) };
    let Ok(txt) = fs::read_to_string(&d.file) else { return json!([]) };
    let Ok(v) = serde_json::from_str::<Value>(&txt) else { return json!([]) };
    let mut out = Vec::new();
    if let Some(arr) = v.get("remoteMcpServersConfig").and_then(|x| x.as_array()) {
        for c in arr {
            let tools = c.get("tools").and_then(|x| x.as_array()).map(|x| x.len()).unwrap_or(0);
            out.push(json!({"name": s(c, "name"), "url": s(c, "url"), "tools": tools}));
        }
    }
    Value::Array(out)
}

pub fn load(archive: &Path, idx: &Index, key: &str) -> Option<Value> {
    let &i = idx.by_key.get(key)?;
    let sum: &SessionSummary = &idx.sessions[i];
    let desk = idx.desktop.get(key);
    let mut ctx = Ctx::new(archive);
    let ids = &sum.cli_ids;
    let mut missing: Vec<String> = Vec::new();
    for (n, id) in ids.iter().enumerate() {
        let Some(p) = idx.transcripts.get(id) else {
            missing.push(id.clone());
            continue;
        };
        if n > 0 && !ctx.items.is_empty() {
            ctx.items.push(json!({"kind": "divider", "text": "Context cleared", "detail": "New conversation in the same session"}));
        }
        read_lines(p, &mut ctx, false);
    }

    // Subagents spawned in this session, keyed by the parent's tool_use id.
    let mut subs: Vec<Value> = Vec::new();
    for id in ids {
        if let Some(list) = idx.subagents.get(id) {
            for p in list {
                let meta_path = p.with_extension("meta.json");
                let meta: Value = fs::read_to_string(&meta_path)
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                    .unwrap_or(Value::Null);
                let agent_id = p
                    .file_stem()
                    .map(|x| x.to_string_lossy().trim_start_matches("agent-").to_string())
                    .unwrap_or_default();
                let cost: f64 = idx
                    .scans
                    .get(&p.strip_prefix(archive).unwrap_or(p).to_string_lossy().replace('\\', "/"))
                    .map(|sc| sc.models.values().map(|m| m.cost).sum())
                    .unwrap_or(0.0);
                if let Some(sc) = idx.scans.get(&p.strip_prefix(archive).unwrap_or(p).to_string_lossy().replace('\\', "/")) {
                    for (k, v) in &sc.models {
                        ctx.models.entry(k.clone()).or_default().add(v);
                    }
                }
                subs.push(json!({"agent_id": agent_id, "tool_use_id": s(&meta, "toolUseId"),
                    "type": s(&meta, "agentType"), "description": s(&meta, "description"), "cost": cost}));
            }
        }
    }

    let cost_rows: Vec<Value> = {
        let mut merged: BTreeMap<String, ModelTotals> = BTreeMap::new();
        for (k, v) in &ctx.models {
            merged.entry(pricing::display_name(k)).or_default().add(v);
        }
        merged
            .iter()
            .map(|(k, v)| json!({"model": k, "input": v.input, "output": v.output, "cache_read": v.cache_read,
                "cache_write": v.cw5m + v.cw1h, "cost": v.cost, "messages": v.messages}))
            .collect()
    };
    let est_total: f64 = ctx.models.values().map(|m| m.cost).sum();

    let mut artifacts = ctx.artifacts.clone();
    if let Some(d) = desk {
        if let Some(pa) = &d.published_artifacts {
            for a in pa {
                let url = s(a, "url");
                if !artifacts.iter().any(|x| s(x, "url") == url) {
                    artifacts.push(json!({"url": url, "title": s(a, "title"), "path": s(a, "sourcePath")}));
                }
            }
        }
    }
    let mut prs = ctx.prs.clone();
    for p in &sum.prs {
        if !prs.iter().any(|x| s(x, "url") == p.url) {
            prs.push(json!({"number": p.number, "url": p.url, "repo": p.repo, "state": p.state}));
        } else if !p.state.is_empty() {
            for x in prs.iter_mut() {
                if s(x, "url") == p.url {
                    x["state"] = json!(p.state);
                }
            }
        }
    }
    let files: Vec<Value> = ctx
        .files_written
        .iter()
        .map(|(p, (kind, n))| json!({"path": p, "kind": kind, "count": n}))
        .collect();

    let (lines_added, lines_removed) = if sum.lines_added + sum.lines_removed > 0 {
        (sum.lines_added, sum.lines_removed)
    } else {
        (ctx.lines_added, ctx.lines_removed)
    };

    let cc = ctx.cc_cost.as_ref();
    let details = json!({
        "context": context_breakdown(&ctx, sum.context_window),
        "cost": {
            "total": sum.cost_usd,
            "estimated": sum.cost_estimated,
            "estimate_total": est_total,
            "by_model": cost_rows,
            "api_ms": cc.and_then(|c| c.get("totalAPIDuration")).cloned().unwrap_or(Value::Null),
            "tool_ms": cc.and_then(|c| c.get("totalToolDuration")).cloned().unwrap_or(Value::Null),
            "wall_ms": cc.and_then(|c| c.get("totalDuration")).cloned().unwrap_or(Value::Null),
        },
        "outputs": {"artifacts": artifacts, "files": files, "prs": prs},
        "changes": {"added": lines_added, "removed": lines_removed},
        "plan": ctx.plan,
        "todos": ctx.todos,
        "tools": ctx.tool_counts,
        "subagents": subs,
        "env": {
            "group": sum.group, "group_cwd": sum.group_cwd,
            "cwd": if sum.cwd.is_empty() { ctx.cwd.clone() } else { sum.cwd.clone() },
            "branch": if sum.branch.is_empty() { ctx.branch.clone() } else { sum.branch.clone() },
            "worktree": sum.worktree,
            "versions": ctx.versions,
            "permission_mode": sum.permission_mode,
            "remote_control": desk.map(|d| d.bridge_session_ids.as_ref().map(|b| !b.is_empty()).unwrap_or(false)).unwrap_or(false),
            "profile": sum.profile,
            "source": sum.source,
            "environment": ctx.attachments.get("environment").and_then(|a| a.get("snapshot")).cloned(),
        },
        "connectors": connectors(desk),
        "time": {"first": ctx.first_ts, "last": ctx.last_ts},
        "summary": desk.map(|d| json!({
            "post_turn": d.post_turn_summary, "wrap_up": d.turn_wrap_up,
            "report": d.last_turn_report, "error": d.error,
            "side_notes": d.side_session_notes, "additional_folders": d.requested_additional_folders,
        })),
        "missing": missing,
    });
    Some(json!({"session": sum, "items": ctx.items, "details": details}))
}

/// A subagent transcript, rendered the same way (its lines are all sidechain).
pub fn load_subagent(archive: &Path, idx: &Index, cli_id: &str, agent_id: &str) -> Option<Value> {
    let list = idx.subagents.get(cli_id)?;
    let want = format!("agent-{}", agent_id);
    let p: &PathBuf = list.iter().find(|p| p.file_stem().map(|s| s.to_string_lossy() == want).unwrap_or(false))?;
    let mut ctx = Ctx::new(archive);
    read_lines(p, &mut ctx, true);
    let meta: Value = fs::read_to_string(p.with_extension("meta.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    Some(json!({"items": ctx.items, "meta": meta}))
}
