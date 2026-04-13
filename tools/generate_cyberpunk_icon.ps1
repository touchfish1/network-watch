Add-Type -AssemblyName System.Drawing

$signature = @"
using System;
using System.Runtime.InteropServices;
public static class NativeIcon {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);
}
"@

Add-Type -TypeDefinition $signature

function New-RoundedRectanglePath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-GlowLine {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.PointF[]]$Points,
    [System.Drawing.Color]$CoreColor,
    [float]$Width
  )

  foreach ($glow in @(
      @{ Alpha = 36; Scale = 2.8 },
      @{ Alpha = 72; Scale = 1.9 },
      @{ Alpha = 128; Scale = 1.3 }
    )) {
    $pen = New-Object System.Drawing.Pen(
      [System.Drawing.Color]::FromArgb($glow.Alpha, $CoreColor.R, $CoreColor.G, $CoreColor.B),
      ($Width * $glow.Scale)
    )
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $Graphics.DrawLines($pen, $Points)
    $pen.Dispose()
  }

  $mainPen = New-Object System.Drawing.Pen($CoreColor, $Width)
  $mainPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $mainPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $mainPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $Graphics.DrawLines($mainPen, $Points)
  $mainPen.Dispose()
}

function New-CyberpunkBitmap {
  param([int]$Size)

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $cyan = [System.Drawing.Color]::FromArgb(255, 65, 236, 255)
  $magenta = [System.Drawing.Color]::FromArgb(255, 255, 56, 166)
  $amber = [System.Drawing.Color]::FromArgb(255, 255, 200, 84)
  $panel = [System.Drawing.Color]::FromArgb(212, 8, 14, 25)

  $margin = [float]($Size * 0.11)
  $panelSize = [float]($Size - ($margin * 2))
  $radius = [float]($Size * 0.18)
  $panelPath = New-RoundedRectanglePath -X $margin -Y $margin -Width $panelSize -Height $panelSize -Radius $radius

  foreach ($glow in @(
      @{ Color = $cyan; Alpha = 42; Width = ($Size * 0.11) },
      @{ Color = $magenta; Alpha = 30; Width = ($Size * 0.16) }
    )) {
    $pen = New-Object System.Drawing.Pen(
      [System.Drawing.Color]::FromArgb($glow.Alpha, $glow.Color.R, $glow.Color.G, $glow.Color.B),
      [float]$glow.Width
    )
    $graphics.DrawPath($pen, $panelPath)
    $pen.Dispose()
  }

  $fillBrush = New-Object System.Drawing.SolidBrush $panel
  $graphics.FillPath($fillBrush, $panelPath)
  $fillBrush.Dispose()

  $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 32, 208, 255), [float]($Size * 0.038))
  $borderPen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
  $graphics.DrawPath($borderPen, $panelPath)
  $borderPen.Dispose()
  $panelPath.Dispose()

  $nStroke = @(
    (New-Object System.Drawing.PointF([float]($Size * 0.29), [float]($Size * 0.75))),
    (New-Object System.Drawing.PointF([float]($Size * 0.29), [float]($Size * 0.27))),
    (New-Object System.Drawing.PointF([float]($Size * 0.51), [float]($Size * 0.60))),
    (New-Object System.Drawing.PointF([float]($Size * 0.71), [float]($Size * 0.25))),
    (New-Object System.Drawing.PointF([float]($Size * 0.71), [float]($Size * 0.75)))
  )
  Draw-GlowLine -Graphics $graphics -Points $nStroke -CoreColor $cyan -Width ([float]($Size * 0.075))

  $scanPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, $magenta.R, $magenta.G, $magenta.B), [float]($Size * 0.05))
  $scanPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $scanPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine(
    $scanPen,
    [float]($Size * 0.20),
    [float]($Size * 0.31),
    [float]($Size * 0.43),
    [float]($Size * 0.31)
  )
  $graphics.DrawLine(
    $scanPen,
    [float]($Size * 0.58),
    [float]($Size * 0.70),
    [float]($Size * 0.80),
    [float]($Size * 0.70)
  )
  $scanPen.Dispose()

  $dotBrush = New-Object System.Drawing.SolidBrush $amber
  $dotRadius = [float]($Size * 0.055)
  $graphics.FillEllipse($dotBrush, [float]($Size * 0.69), [float]($Size * 0.14), $dotRadius, $dotRadius)
  $graphics.FillEllipse($dotBrush, [float]($Size * 0.18), [float]($Size * 0.79), $dotRadius, $dotRadius)
  $dotBrush.Dispose()

  $graphics.Dispose()
  return $bitmap
}

function Save-Ico {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [string]$Path
  )

  $handle = $Bitmap.GetHicon()
  try {
    $icon = [System.Drawing.Icon]::FromHandle($handle)
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
    try {
      $icon.Save($stream)
    } finally {
      $stream.Dispose()
      $icon.Dispose()
    }
  } finally {
    [NativeIcon]::DestroyIcon($handle) | Out-Null
  }
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$iconDir = Join-Path $root "src-tauri\\icons"

$sizes = @{
  "32x32.png" = 32
  "128x128.png" = 128
  "128x128@2x.png" = 256
  "256x256.png" = 256
  "icon.png" = 128
}

foreach ($entry in $sizes.GetEnumerator()) {
  $bitmap = New-CyberpunkBitmap -Size $entry.Value
  try {
    $bitmap.Save((Join-Path $iconDir $entry.Key), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }
}

$icoBitmap = New-CyberpunkBitmap -Size 32
try {
  Save-Ico -Bitmap $icoBitmap -Path (Join-Path $iconDir "icon.ico")
} finally {
  $icoBitmap.Dispose()
}
