//! Where Claude keeps its data on this machine, and where the archive lives.

use std::path::{Path, PathBuf};

/// The archive root. `CLAUDE_HISTORY_ARCHIVE` overrides it. On the machine that
/// built the exe it is the `archive/` folder next to `src-tauri/` (baked in at
/// compile time); anywhere else (an installed copy) it is
/// `%LOCALAPPDATA%\Claude History\archive`.
pub fn archive_root() -> PathBuf {
    if let Ok(p) = std::env::var("CLAUDE_HISTORY_ARCHIVE") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    if manifest.is_dir() {
        return normalize(&manifest.join("..").join("archive"));
    }
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Claude History")
        .join("archive")
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn claude_home() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude"))
}

/// A Claude desktop profile: a folder that holds `claude-code-sessions`.
#[derive(Clone, Debug)]
pub struct DesktopProfile {
    /// Stable name used inside the archive (`Claude`, `Claude-Account2`, ...).
    pub name: String,
    pub path: PathBuf,
}

/// Every desktop profile on this machine. The MSIX build moved its data to
/// `%LOCALAPPDATA%\Claude-Data\claude_*` in 2026; older and secondary profiles
/// live under the package's `LocalCache\Roaming\<name>` or `%APPDATA%\<name>`.
pub fn desktop_profiles() -> Vec<DesktopProfile> {
    let mut out: Vec<DesktopProfile> = Vec::new();
    let mut push = |name: String, path: PathBuf| {
        if !path.join("claude-code-sessions").is_dir() && !path.join("local-agent-mode-sessions").is_dir() {
            return;
        }
        if out.iter().any(|p| p.name == name) {
            return;
        }
        out.push(DesktopProfile { name, path });
    };

    if let Some(local) = dirs::data_local_dir() {
        // New layout: Claude-Data\claude_<package suffix>
        if let Ok(rd) = std::fs::read_dir(local.join("Claude-Data")) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    push("Claude".to_string(), e.path());
                }
            }
        }
        // MSIX package virtualised roaming folder
        if let Ok(rd) = std::fs::read_dir(local.join("Packages")) {
            for pkg in rd.flatten() {
                let n = pkg.file_name().to_string_lossy().to_string();
                if !n.to_ascii_lowercase().starts_with("claude") {
                    continue;
                }
                if let Ok(rd2) = std::fs::read_dir(pkg.path().join("LocalCache").join("Roaming")) {
                    for e in rd2.flatten() {
                        let name = e.file_name().to_string_lossy().to_string();
                        if name.to_ascii_lowercase().starts_with("claude") && e.path().is_dir() {
                            push(name, e.path());
                        }
                    }
                }
            }
        }
    }
    if let Some(roaming) = dirs::data_dir() {
        if let Ok(rd) = std::fs::read_dir(&roaming) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.to_ascii_lowercase().starts_with("claude") && e.path().is_dir() {
                    push(name, e.path());
                }
            }
        }
    }
    out
}

/// Turn a Windows path into something comparable: lowercase, forward slashes, no trailing slash.
pub fn path_key(p: &str) -> String {
    let mut s = p.replace('\\', "/").to_lowercase();
    while s.ends_with('/') {
        s.pop();
    }
    s
}

/// Strip a `.claude/worktrees/<name>` suffix so worktree sessions file under their repo.
pub fn strip_worktree(p: &str) -> String {
    let norm = p.replace('\\', "/");
    let lower = norm.to_lowercase();
    if let Some(i) = lower.find("/.claude/worktrees/") {
        return p[..i].to_string();
    }
    p.to_string()
}

pub fn basename(p: &str) -> String {
    let norm = p.replace('\\', "/");
    norm.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}
