# Capture the running Claude History window to a PNG (for visual checks).
# usage: powershell -File scripts/capture-window.ps1 <out.png> [scale]
param([string]$Out = "window.png", [double]$Scale = 1.75)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CHWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int L, T, R, B; }
}
"@
Add-Type -AssemblyName System.Drawing
[CHWin]::SetProcessDPIAware() | Out-Null
$p = Get-Process claude-history -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
$r = New-Object CHWin+RECT; [CHWin]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc(); [CHWin]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
$small = New-Object System.Drawing.Bitmap ([int]($w / $Scale)), ([int]($ht / $Scale))
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = 'HighQualityBicubic'
$g2.DrawImage($bmp, 0, 0, $small.Width, $small.Height)
$small.Save($Out)
"saved $Out ($w x $ht)"
