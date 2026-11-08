// Release builds are GUI apps: no console window behind them.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod index;
mod paths;
mod pricing;
mod sync;
mod transcript;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

struct AppState {
    archive: PathBuf,
    index: RwLock<Option<Arc<index::Index>>>,
    syncing: AtomicBool,
}

impl AppState {
    fn current(&self) -> Option<Arc<index::Index>> {
        self.index.read().ok().and_then(|g| g.clone())
    }
    fn ensure(&self) -> Arc<index::Index> {
        if let Some(i) = self.current() {
            return i;
        }
        let cache = index::load_scan_cache(&self.archive);
        let built = Arc::new(index::build(&self.archive, cache, &|_, _| {}));
        if let Ok(mut g) = self.index.write() {
            *g = Some(built.clone());
        }
        built
    }
}

fn overview(state: &AppState, idx: &index::Index) -> Value {
    json!({
        "archive": state.archive.display().to_string(),
        "sessions": idx.sessions,
        "built_ms": idx.built_ms,
        "last_sync": sync::last_report(&state.archive),
        "syncing": state.syncing.load(Ordering::Relaxed),
        "profiles": paths::desktop_profiles().iter().map(|p| json!({"name": p.name, "path": p.path.display().to_string()})).collect::<Vec<_>>(),
        "claude_home": paths::claude_home().map(|p| p.display().to_string()),
        // `claude-history.exe --open <session id>` opens straight into that session
        "open": std::env::args().skip_while(|a| a != "--open").nth(1),
    })
}

#[tauri::command]
async fn bootstrap(state: State<'_, AppState>) -> Result<Value, String> {
    let idx = state.ensure();
    Ok(overview(&state, &idx))
}

#[tauri::command]
async fn start_sync(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Ok(false);
    }
    let archive = state.archive.clone();
    std::thread::spawn(move || {
        let emit_app = app.clone();
        let report = sync::run(&archive, &|p| {
            let _ = emit_app.emit("sync-progress", &p);
        });
        let _ = app.emit("sync-done", &report);
        let st = app.state::<AppState>();
        let cache = st
            .current()
            .map(|i| i.scans.clone())
            .unwrap_or_else(|| index::load_scan_cache(&archive));
        let emit_app2 = app.clone();
        let built = index::build(&archive, cache, &|done, total| {
            let _ = emit_app2.emit("index-progress", json!({"done": done, "total": total}));
        });
        let built = Arc::new(built);
        if let Ok(mut g) = st.index.write() {
            *g = Some(built.clone());
        }
        st.syncing.store(false, Ordering::SeqCst);
        let _ = app.emit("index-updated", overview(&st, &built));
    });
    Ok(true)
}

#[tauri::command]
async fn get_session(state: State<'_, AppState>, key: String) -> Result<Value, String> {
    let idx = state.ensure();
    transcript::load(&state.archive, &idx, &key).ok_or_else(|| format!("Session {} not found", key))
}

#[tauri::command]
async fn get_subagent(state: State<'_, AppState>, cli_id: String, agent_id: String) -> Result<Value, String> {
    let idx = state.ensure();
    transcript::load_subagent(&state.archive, &idx, &cli_id, &agent_id).ok_or_else(|| "Subagent transcript not found".to_string())
}

#[tauri::command]
async fn search(state: State<'_, AppState>, query: String) -> Result<Vec<Value>, String> {
    let idx = state.ensure();
    Ok(idx.search(&state.archive, &query, 200))
}

#[tauri::command]
async fn usage(state: State<'_, AppState>) -> Result<Value, String> {
    let idx = state.ensure();
    Ok(idx.usage())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("{} no longer exists on this computer", path));
    }
    app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
}

/// Headless modes:
///   --sync                 copy new history into the archive and exit (for a scheduled task)
///   --dump <dir> [keys..]  write the UI's data as JSON files (development and testing)
fn cli(archive: &std::path::Path, args: &[String]) -> Option<i32> {
    let has = |f: &str| args.iter().any(|a| a == f);
    if !has("--sync") && !has("--dump") {
        return None;
    }
    // Release builds have no console of their own; borrow the terminal's.
    #[cfg(windows)]
    {
        extern "system" {
            fn AttachConsole(pid: u32) -> i32;
        }
        unsafe {
            AttachConsole(u32::MAX);
        }
    }
    if has("--sync") {
        let r = sync::run(archive, &|_| {});
        let idx = index::build(archive, index::load_scan_cache(archive), &|_, _| {});
        println!(
            "archived {} new or changed files ({} MB) of {} scanned in {} ms; {} sessions indexed; {} errors",
            r.copied,
            r.bytes_copied / 1_000_000,
            r.scanned,
            r.duration_ms,
            idx.sessions.len(),
            r.errors.len()
        );
        for e in r.errors.iter().take(10) {
            eprintln!("  {}", e);
        }
        return Some(if r.errors.is_empty() { 0 } else { 2 });
    }
    if let Some(i) = args.iter().position(|a| a == "--dump") {
        let out = PathBuf::from(args.get(i + 1).cloned().unwrap_or_else(|| "dump".into()));
        let _ = std::fs::create_dir_all(out.join("sessions"));
        let t0 = std::time::Instant::now();
        let idx = index::build(archive, index::load_scan_cache(archive), &|_, _| {});
        eprintln!("index: {} sessions in {:?}", idx.sessions.len(), t0.elapsed());
        let state = AppState { archive: archive.to_path_buf(), index: RwLock::new(None), syncing: AtomicBool::new(false) };
        let write = |name: &str, v: &Value| {
            let _ = std::fs::write(out.join(name), serde_json::to_vec(v).unwrap_or_default());
        };
        write("bootstrap.json", &overview(&state, &idx));
        write("usage.json", &idx.usage());
        let mut keys: Vec<String> = args.iter().skip(i + 2).cloned().collect();
        if keys.is_empty() {
            keys = idx.sessions.iter().take(40).map(|s| s.key.clone()).collect();
        }
        for k in keys {
            let t = std::time::Instant::now();
            if let Some(v) = transcript::load(archive, &idx, &k) {
                write(&format!("sessions/{}.json", k), &v);
                let cli = v.pointer("/session/cli_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if let Some(subs) = v.pointer("/details/subagents").and_then(|x| x.as_array()) {
                    let _ = std::fs::create_dir_all(out.join("subagents"));
                    for a in subs {
                        let aid = a.get("agent_id").and_then(|x| x.as_str()).unwrap_or("");
                        if let Some(sv) = transcript::load_subagent(archive, &idx, &cli, aid) {
                            write(&format!("subagents/{}.json", aid), &sv);
                        }
                    }
                }
                eprintln!("session {} in {:?}", k, t.elapsed());
            }
        }
        return Some(0);
    }
    None
}

fn main() {
    let archive = paths::archive_root();
    let _ = std::fs::create_dir_all(&archive);
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = cli(&archive, &args) {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState { archive, index: RwLock::new(None), syncing: AtomicBool::new(false) })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            start_sync,
            get_session,
            get_subagent,
            search,
            usage,
            open_url,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claude History");
}
