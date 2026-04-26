# Resize build/icon.png to the standard Windows icon sizes.
# Output goes to build/.icon-tmp/<size>.png.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src  = Join-Path $root "build\icon.png"
$out  = Join-Path $root "build\.icon-tmp"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$bmp = New-Object System.Drawing.Bitmap $src
foreach ($s in 16, 24, 32, 48, 64, 128, 256) {
    $dst = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($bmp, 0, 0, $s, $s)
    $dst.Save((Join-Path $out "$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $dst.Dispose()
    Write-Host "Wrote $s.png"
}
$bmp.Dispose()
