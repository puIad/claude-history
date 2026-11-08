//! Copies Claude's local history into the archive so it outlives cleanup,
//! uninstalls and lapsed subscriptions. Files are never deleted from the
//! archive; a transcript that shrank at the source is kept beside the new copy.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths::{self, DesktopProfile};

#[derive(Serialize, Clone, Default, Debug)]
pub struct SyncReport {
    pub scanned: u64,
    pub copied: u64,
    pub bytes_copied: u64,
    pub preserved: u64,
    pub errors: Vec<String>,
    pub finished_ms: i64,
    pub duration_ms: i64,
    pub sources: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SyncProgress {
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

struct Job {
    src: PathBuf,
    dest: PathBuf,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn collect_dir(src: &Path, dest: &Path, skip: &dyn Fn(&Path) -> bool, out: &mut Vec<Job>) {
    let Ok(rd) = fs::read_dir(src) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if skip(&p) {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        // Never follow junctions/symlinks: the desktop app refuses them and they can loop.
        if ft.is_symlink() {
            continue;
        }
        let d = dest.join(e.file_name());
        if ft.is_dir() {
            collect_dir(&p, &d, skip, out);
        } else if ft.is_file() {
            out.push(Job { src: p, dest: d });
        }
    }
}

fn plan(archive: &Path, profiles: &[DesktopProfile], sources: &mut Vec<String>) -> Vec<Job> {
    let mut jobs = Vec::new();
    let no_skip = |_: &Path| false;

    if let Some(home) = paths::claude_home() {
        let projects = home.join("projects");
        if projects.is_dir() {
            sources.push(projects.display().to_string());
            collect_dir(&projects, &archive.join("claude").join("projects"), &no_skip, &mut jobs);
        }
        for f in ["history.jsonl", "stats-cache.json"] {
            let p = home.join(f);
            if p.is_file() {
                jobs.push(Job { src: p, dest: archive.join("claude").join(f) });
            }
        }
        let plans = home.join("plans");
        if plans.is_dir() {
            collect_dir(&plans, &archive.join("claude").join("plans"), &no_skip, &mut jobs);
        }
    }

    for prof in profiles {
        sources.push(prof.path.display().to_string());
        let dest_root = archive.join("desktop").join(&prof.name);
        let skip_plugins = |p: &Path| {
            let n = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            n == "skills-plugin" || n == "vm_bundles" || n.ends_with(".vhdx")
        };
        for d in ["claude-code-sessions", "local-agent-mode-sessions", "side-session-notes"] {
            let s = prof.path.join(d);
            if s.is_dir() {
                collect_dir(&s, &dest_root.join(d), &skip_plugins, &mut jobs);
            }
        }
        // Small metadata files only. config.json is skipped: it holds encrypted sign-in tokens.
        for f in ["ccd-session-presets.json", "plan-usage-history.json"] {
            let p = prof.path.join(f);
            if p.is_file() {
                jobs.push(Job { src: p, dest: dest_root.join(f) });
            }
        }
    }
    jobs
}

fn same(src: &fs::Metadata, dest: &fs::Metadata) -> bool {
    if src.len() != dest.len() {
        return false;
    }
    match (src.modified(), dest.modified()) {
        (Ok(a), Ok(b)) => {
            let a = a.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let b = b.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(1);
            a == b
        }
        _ => false,
    }
}

fn copy_one(job: &Job, report: &mut SyncReport) {
    let Ok(sm) = fs::metadata(&job.src) else { return };
    if let Ok(dm) = fs::metadata(&job.dest) {
        if same(&sm, &dm) {
            return;
        }
        // A transcript that got shorter at the source (rewrite, compaction, partial
        // file) must not erase what we already have: keep the old copy beside it.
        let is_log = job.dest.extension().map(|e| e == "jsonl").unwrap_or(false);
        if is_log && sm.len() < dm.len() {
            let keep = job.dest.with_extension(format!("jsonl.superseded-{}", now_ms()));
            if fs::rename(&job.dest, &keep).is_ok() {
                report.preserved += 1;
            }
        }
    }
    if let Some(parent) = job.dest.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            report.errors.push(format!("{}: {}", parent.display(), e));
            return;
        }
    }
    // Copy to a temp name then rename, so a crash never leaves a half-written archive file.
    let tmp = job.dest.with_extension("partial-copy");
    match fs::copy(&job.src, &tmp) {
        Ok(n) => {
            if let Ok(mt) = sm.modified() {
                if let Ok(f) = fs::OpenOptions::new().write(true).open(&tmp) {
                    let _ = f.set_modified(mt);
                }
            }
            let _ = fs::remove_file(&job.dest);
            if let Err(e) = fs::rename(&tmp, &job.dest) {
                report.errors.push(format!("{}: {}", job.dest.display(), e));
                let _ = fs::remove_file(&tmp);
                return;
            }
            report.copied += 1;
            report.bytes_copied += n;
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            report.errors.push(format!("{}: {}", job.src.display(), e));
        }
    }
}

pub fn run(archive: &Path, progress: &dyn Fn(SyncProgress)) -> SyncReport {
    let start = now_ms();
    let mut report = SyncReport::default();
    // One sync at a time: the app and the scheduled `--sync` task can overlap.
    let _ = fs::create_dir_all(archive);
    let lock = archive.join(".sync.lock");
    let stale = fs::metadata(&lock)
        .and_then(|m| m.modified())
        .map(|t| t.elapsed().map(|e| e.as_secs() > 600).unwrap_or(true))
        .unwrap_or(true);
    if lock.exists() && !stale {
        report.errors.push("Another archive run was in progress; skipped this one.".into());
        report.finished_ms = now_ms();
        return report;
    }
    let _ = fs::write(&lock, std::process::id().to_string());
    let profiles = paths::desktop_profiles();
    progress(SyncProgress { phase: "scanning".into(), done: 0, total: 0 });
    let jobs = plan(archive, &profiles, &mut report.sources);
    let total = jobs.len() as u64;
    for (i, job) in jobs.iter().enumerate() {
        copy_one(job, &mut report);
        report.scanned += 1;
        if i % 40 == 0 {
            progress(SyncProgress { phase: "copying".into(), done: i as u64, total });
        }
    }
    progress(SyncProgress { phase: "copying".into(), done: total, total });
    report.finished_ms = now_ms();
    report.duration_ms = report.finished_ms - start;
    if report.errors.len() > 50 {
        report.errors.truncate(50);
    }
    if let Ok(s) = serde_json::to_string_pretty(&report) {
        let _ = fs::write(archive.join("last-sync.json"), s);
    }
    let _ = fs::remove_file(&lock);
    report
}

pub fn last_report(archive: &Path) -> Option<serde_json::Value> {
    let s = fs::read_to_string(archive.join("last-sync.json")).ok()?;
    serde_json::from_str(&s).ok()
}
