# Build the release exe and install it to bin\ (plus a Start menu shortcut).
# Needs: Rust GNU toolchain (rustup), WinLibs MinGW for windres (winget BrechtSanders.WinLibs.POSIX.UCRT).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$winlibs = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter "BrechtSanders.WinLibs*" -ErrorAction SilentlyContinue | Select-Object -First 1
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
if ($winlibs) { $env:PATH = "$env:PATH;$($winlibs.FullName)\mingw64\bin" }
Push-Location (Join-Path $root "src-tauri")
try { cargo build --release; if ($LASTEXITCODE) { throw "cargo build failed" } } finally { Pop-Location }
$bin = Join-Path $root "bin"
New-Item -ItemType Directory -Force $bin | Out-Null
Get-Process claude-history -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400
Copy-Item (Join-Path $root "src-tauri\target\release\claude-history.exe") (Join-Path $bin "claude-history.exe") -Force
$exe = Join-Path $bin "claude-history.exe"
$lnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Claude History.lnk"
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = $exe; $s.WorkingDirectory = $bin; $s.IconLocation = "$exe,0"
$s.Description = "Offline viewer for your Claude Code and Claude desktop history"
$s.Save()
"installed $exe"
