//! Imports claude.ai's data export (Settings > Privacy > Export data), the only way to
//! keep conversations that live in Anthropic's cloud. The original zip is copied into the
//! archive, and each conversation is stored as its own file so the newest copy of a
//! conversation wins and nothing is ever dropped.

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::index::parse_ts;

#[derive(Serialize, Default, Debug)]
pub struct ImportReport {
    pub conversations: usize,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub source: String,
}

fn root(archive: &Path) -> PathBuf {
    archive.join("claudeai")
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Read conversations.json (and its sibling files) from a zip, a folder or the json itself.
fn read_export(src: &Path) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), String> {
    let lower = src.to_string_lossy().to_lowercase();
    if src.is_dir() {
        let conv = fs::read(src.join("conversations.json")).map_err(|e| format!("No conversations.json in that folder: {}", e))?;
        let mut extra = Vec::new();
        for n in ["projects.json", "users.json", "memories.json"] {
            if let Ok(b) = fs::read(src.join(n)) {
                extra.push((n.to_string(), b));
            }
        }
        return Ok((conv, extra));
    }
    if lower.ends_with(".json") {
        return fs::read(src).map(|b| (b, Vec::new())).map_err(|e| e.to_string());
    }
    let f = fs::File::open(src).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("Not a zip file: {}", e))?;
    let mut conv: Option<Vec<u8>> = None;
    let mut extra = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let base = name.rsplit('/').next().unwrap_or("").to_string();
        if !base.ends_with(".json") {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        if base == "conversations.json" {
            conv = Some(buf);
        } else {
            extra.push((base, buf));
        }
    }
    conv.map(|c| (c, extra)).ok_or_else(|| "The zip has no conversations.json; is it a claude.ai data export?".into())
}

pub fn import(archive: &Path, src: &Path) -> Result<ImportReport, String> {
    let (conv_bytes, extra) = read_export(src)?;
    let convs: Vec<Value> = serde_json::from_slice(&conv_bytes).map_err(|e| format!("conversations.json is not valid: {}", e))?;
    let r = root(archive);
    let dir = r.join("conversations");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Keep the export itself, untouched, next to what was taken from it.
    let stamp = crate::sync::now_ms();
    let keep = r.join("exports").join(stamp.to_string());
    if src.is_file() {
        let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "export".into());
        let len = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        // the same export imported twice is kept once
        let already = fs::read_dir(r.join("exports"))
            .map(|rd| rd.flatten().any(|d| fs::metadata(d.path().join(&name)).map(|m| m.len() == len).unwrap_or(false)))
            .unwrap_or(false);
        if !already {
            let _ = fs::create_dir_all(&keep);
            let _ = fs::copy(src, keep.join(name));
        }
    } else {
        let _ = fs::create_dir_all(&keep);
        let _ = fs::write(keep.join("conversations.json"), &conv_bytes);
    }
    for (n, b) in &extra {
        let _ = fs::write(r.join(n), b);
    }

    let mut rep = ImportReport { conversations: convs.len(), source: src.display().to_string(), ..Default::default() };
    for c in convs {
        let id = s(&c, "uuid");
        if id.is_empty() || id.contains(['/', '\\', '.']) {
            continue;
        }
        let path = dir.join(format!("{}.json", id));
        let newer = s(&c, "updated_at");
        match fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            Some(old) => {
                let old_n = old.get("chat_messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0);
                let new_n = c.get("chat_messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0);
                if parse_ts(&newer) > parse_ts(&s(&old, "updated_at")) || new_n > old_n {
                    let _ = fs::write(&path, serde_json::to_vec(&c).unwrap_or_default());
                    rep.updated += 1;
                } else {
                    rep.unchanged += 1;
                }
            }
            None => {
                let _ = fs::write(&path, serde_json::to_vec(&c).unwrap_or_default());
                rep.added += 1;
            }
        }
    }
    Ok(rep)
}

/// Light summaries of every imported conversation, for the sidebar.
pub fn summaries(archive: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(root(archive).join("conversations")) else { return out };
    for e in rd.flatten() {
        let Ok(t) = fs::read_to_string(e.path()) else { continue };
        let Ok(c) = serde_json::from_str::<Value>(&t) else { continue };
        let msgs = c.get("chat_messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();
        let first_human = msgs.iter().find(|m| s(m, "sender") == "human").map(|m| message_text(m)).unwrap_or_default();
        let model = c.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string();
        out.push(json!({
            "uuid": s(&c, "uuid"),
            "name": s(&c, "name"),
            "created": parse_ts(&s(&c, "created_at")),
            "updated": parse_ts(&s(&c, "updated_at")),
            "prompts": msgs.iter().filter(|m| s(m, "sender") == "human").count(),
            "first": first_human.chars().take(300).collect::<String>(),
            "project": c.pointer("/project/name").and_then(|x| x.as_str()).unwrap_or(""),
            "model": model,
            "search": msgs.iter().map(message_text).collect::<Vec<_>>().join("\n").to_lowercase().chars().take(160_000).collect::<String>(),
        }));
    }
    out
}

fn message_text(m: &Value) -> String {
    if let Some(blocks) = m.get("content").and_then(|c| c.as_array()) {
        let t: Vec<String> = blocks
            .iter()
            .filter(|b| s(b, "type") == "text")
            .map(|b| s(b, "text"))
            .filter(|t| !t.is_empty())
            .collect();
        if !t.is_empty() {
            return t.join("\n\n");
        }
    }
    s(m, "text")
}

/// One conversation in the same render model as Claude Code sessions.
pub fn load(archive: &Path, uuid: &str) -> Option<(Vec<Value>, Value)> {
    if uuid.contains(['/', '\\', '.']) {
        return None;
    }
    let t = fs::read_to_string(root(archive).join("conversations").join(format!("{}.json", uuid))).ok()?;
    let c: Value = serde_json::from_str(&t).ok()?;
    let mut items = Vec::new();
    let mut first = 0i64;
    let mut last = 0i64;
    let mut tools: std::collections::HashMap<String, (usize, usize)> = Default::default();
    for m in c.get("chat_messages").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
        let ts = parse_ts(&s(&m, "created_at"));
        if ts > 0 {
            if first == 0 {
                first = ts;
            }
            last = last.max(ts);
        }
        let files: Vec<String> = ["attachments", "files"]
            .iter()
            .flat_map(|k| m.get(*k).and_then(|x| x.as_array()).cloned().unwrap_or_default())
            .map(|f| s(&f, "file_name"))
            .filter(|n| !n.is_empty())
            .collect();
        if s(&m, "sender") == "human" {
            let mut text = message_text(&m);
            if !files.is_empty() {
                text = format!("{}{}📎 {}", text, if text.is_empty() { "" } else { "\n\n" }, files.join(", "));
            }
            items.push(json!({"kind": "user", "uuid": s(&m, "uuid"), "ts": ts, "text": text, "images": [], "origin": "typed"}));
            continue;
        }
        let mut blocks: Vec<Value> = Vec::new();
        match m.get("content").and_then(|x| x.as_array()) {
            Some(content) if !content.is_empty() => {
                for b in content {
                    match s(b, "type").as_str() {
                        "text" => {
                            let t = s(b, "text");
                            if !t.trim().is_empty() {
                                blocks.push(json!({"type": "text", "text": t}));
                            }
                        }
                        "thinking" => blocks.push(json!({"type": "thinking", "text": s(b, "thinking"), "ms": null})),
                        "tool_use" => {
                            let id = if s(b, "id").is_empty() { format!("{}-{}", s(&m, "uuid"), blocks.len()) } else { s(b, "id") };
                            tools.insert(id.clone(), (items.len(), blocks.len()));
                            blocks.push(json!({"type": "tool", "id": id, "name": s(b, "name"), "input": b.get("input").cloned().unwrap_or(Value::Null)}));
                        }
                        "tool_result" => {
                            let text = match b.get("content") {
                                Some(Value::Array(a)) => a.iter().map(|x| s(x, "text")).collect::<Vec<_>>().join("\n"),
                                Some(Value::String(t)) => t.clone(),
                                _ => String::new(),
                            };
                            let res = json!({"text": text, "images": [], "error": b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false)});
                            let key = s(b, "tool_use_id");
                            let target = tools.get(&key).copied().or_else(|| {
                                // results without ids attach to the latest tool call in this message
                                blocks.iter().rposition(|x| x["type"] == "tool").map(|bi| (items.len(), bi))
                            });
                            if let Some((ii, bi)) = target {
                                if ii == items.len() {
                                    if let Some(x) = blocks.get_mut(bi) {
                                        x["result"] = res;
                                    }
                                } else if let Some(x) = items.get_mut(ii).and_then(|it| it.get_mut("blocks")).and_then(|bs| bs.get_mut(bi)) {
                                    x["result"] = res;
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {
                let t = s(&m, "text");
                if !t.trim().is_empty() {
                    blocks.push(json!({"type": "text", "text": t}));
                }
            }
        }
        items.push(json!({"kind": "assistant", "uuid": s(&m, "uuid"), "ts": ts, "model": c.get("model").cloned().unwrap_or(Value::Null), "blocks": blocks}));
    }
    let meta = json!({
        "first": first, "last": last,
        "project": c.pointer("/project/name"),
        "summary": c.get("summary"),
        "name": s(&c, "name"),
    });
    Some((items, meta))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!([{
            "uuid": "c0ffee00-0000-4000-8000-000000000001",
            "name": "Plan a trip",
            "created_at": "2026-10-01T09:00:00.000000Z",
            "updated_at": "2026-10-01T09:05:00.000000Z",
            "chat_messages": [
                {"uuid": "m1", "sender": "human", "created_at": "2026-10-01T09:00:00.000000Z", "text": "Where should I go?",
                 "content": [{"type": "text", "text": "Where should I go?"}], "attachments": [{"file_name": "notes.txt"}], "files": []},
                {"uuid": "m2", "sender": "assistant", "created_at": "2026-10-01T09:00:10.000000Z", "text": "",
                 "content": [
                    {"type": "thinking", "thinking": "Short note."},
                    {"type": "tool_use", "id": "t1", "name": "web_search", "input": {"query": "best trips"}},
                    {"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "results"}]},
                    {"type": "text", "text": "Try **Lisbon**."}
                 ]}
            ]
        }])
    }

    #[test]
    fn imports_and_renders_an_export() {
        let dir = std::env::temp_dir().join(format!("chimport-{}", crate::sync::now_ms()));
        let archive = dir.join("archive");
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("conversations.json");
        fs::write(&src, serde_json::to_vec(&sample()).unwrap()).unwrap();

        let r = import(&archive, &src).unwrap();
        assert_eq!((r.conversations, r.added), (1, 1));
        // importing again changes nothing
        let r2 = import(&archive, &src).unwrap();
        assert_eq!((r2.added, r2.unchanged), (0, 1));

        let sums = summaries(&archive);
        assert_eq!(sums.len(), 1);
        assert_eq!(sums[0]["name"], "Plan a trip");
        assert_eq!(sums[0]["prompts"], 1);

        let (items, meta) = load(&archive, "c0ffee00-0000-4000-8000-000000000001").unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0]["text"].as_str().unwrap().contains("notes.txt"));
        let blocks = items[1]["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[1]["result"]["text"], "results");
        assert!(meta["last"].as_i64().unwrap() > meta["first"].as_i64().unwrap());
        let _ = fs::remove_dir_all(&dir);
    }
}
