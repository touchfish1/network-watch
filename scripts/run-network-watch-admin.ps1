param(
  [string]$ExecutablePath = "src-tauri\target\debug\src-tauri.exe"
)

$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)

$resolvedPath = Resolve-Path $ExecutablePath
Start-Process -FilePath $resolvedPath -Verb RunAs
