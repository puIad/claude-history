# Build the Windows installer: src-tauri\target\release\bundle\msi\Claude History_<version>_x64_en-US.msi
# Same toolchain as build.ps1. The Tauri CLI downloads WiX on first use.
# ui\fonts (the desktop app's fonts) is moved aside during the build so the installer never
# redistributes them; the installed app falls back to system fonts.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$winlibs = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter "BrechtSanders.WinLibs*" -ErrorAction SilentlyContinue | Select-Object -First 1
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
if ($winlibs) { $env:PATH = "$env:PATH;$($winlibs.FullName)\mingw64\bin" }

$fonts = Join-Path $root "ui\fonts"
$parked = Join-Path $root "src-tauri\target\fonts-parked"
if (Test-Path $fonts) {
    if (Test-Path $parked) { Remove-Item -Recurse -Force $parked }
    New-Item -ItemType Directory -Force (Split-Path $parked) | Out-Null
    Move-Item $fonts $parked
}
Push-Location $root
try {
    npx tauri build --bundles msi --config src-tauri/tauri.msi.conf.json
    if ($LASTEXITCODE) { throw "tauri build failed" }
} finally {
    Pop-Location
    if (Test-Path $parked) { Move-Item $parked $fonts }
}
Get-ChildItem (Join-Path $root "src-tauri\target\release\bundle\msi\*.msi") | ForEach-Object { $_.FullName }
