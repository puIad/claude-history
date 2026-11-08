# Claude History: notes for coding agents

Windows desktop app (Rust + Tauri 2, plain HTML/CSS/ES-module UI) that archives every Claude Code and
Claude desktop session on the machine and renders them like the desktop app's Code tab. Offline, no
telemetry. Users: see `README.md`. This file is for agents changing the code.

## Layout

```
src-tauri/src/main.rs        Tauri commands, headless flags (--sync --open --import --dump), window
src-tauri/src/sync.rs        archive copy; add/update only, never deletes
src-tauri/src/index.rs       one cached pass over every transcript + desktop metadata -> session list
src-tauri/src/transcript.rs  one session -> render model + details-panel data
src-tauri/src/claudeai.rs    claude.ai data-export import
src-tauri/src/pricing.rs     model prices and context windows
ui/js/                       app.js (controller), sidebar, transcript, details, usage, plan, markdown
ui/css/app.css               theme tokens copied from the desktop app's stylesheet
scripts/                     build, vendor, screenshot and end-to-end drive scripts
```

## Commands

```
npm install && npm run vendor           # UI libraries into ui/vendor
powershell -File scripts/build.ps1      # release build into bin\
powershell -File scripts/build-msi.ps1  # MSI installer
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/drive-app.mjs <outDir>     # end-to-end run of the real exe, screenshot per step
node scripts/demo-data.mjs              # invented sessions -> archive/.demo (for screenshots)
DATA=archive/.demo node scripts/shot.mjs out.png [sessionKey|usage]   # needs python -m http.server 8765 at repo root
```

Needs the Rust GNU toolchain (`stable-x86_64-pc-windows-gnu`) and WinLibs MinGW; no Visual Studio.

## Rules that matter

- `archive/` holds the user's private history. Never commit it, never read it into logs or docs.
  Screenshots and tests use `scripts/demo-data.mjs`, not real data.
- The archive is append-only. A transcript that shrinks at the source keeps its old copy as
  `*.superseded-<time>`. Do not add deletion paths.
- `config.json` of the desktop app is never copied (it holds sign-in tokens).
- `ui/` has no build step and is embedded into the exe at compile time. Outside Tauri, `ui/js/mock.js`
  serves `--dump` JSON so the UI can be tested in a plain browser.
- `ui/fonts/` is copied from the local desktop app and is git-ignored; do not commit it.
- Costs are Claude Code's own total when recorded, else an estimate at API list prices
  (`pricing.rs`). Label estimates as estimates.
