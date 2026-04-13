param(
  [string]$CommitMessage = "",
  [switch]$Push
)

$ErrorActionPreference = "Stop"

Set-Location (Split-Path -Parent $PSScriptRoot)

function Get-NextVersion([string]$version) {
  $parts = $version.Split(".")
  if ($parts.Length -ne 3) {
    throw "Unsupported version format: $version"
  }

  return "{0}.{1}.{2}" -f $parts[0], $parts[1], ([int]$parts[2] + 1)
}

function Update-JsonVersion($path, $version) {
  $json = Get-Content $path -Raw | ConvertFrom-Json
  $json.version = $version
  $json | ConvertTo-Json -Depth 100 | Set-Content $path
}

$packageJsonPath = "package.json"
$packageLockPath = "package-lock.json"
$cargoTomlPath = "src-tauri/Cargo.toml"
$tauriConfigPath = "src-tauri/tauri.conf.json"

$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$currentVersion = $packageJson.version
$nextVersion = Get-NextVersion $currentVersion
$tagName = "v$nextVersion"

Update-JsonVersion $packageJsonPath $nextVersion
Update-JsonVersion $packageLockPath $nextVersion

$cargoToml = Get-Content $cargoTomlPath -Raw
$cargoToml = $cargoToml -replace 'version = "' + [regex]::Escape($currentVersion) + '"', 'version = "' + $nextVersion + '"'
Set-Content $cargoTomlPath $cargoToml

$tauriConfig = Get-Content $tauriConfigPath -Raw | ConvertFrom-Json
$tauriConfig.version = $nextVersion
$tauriConfig | ConvertTo-Json -Depth 100 | Set-Content $tauriConfigPath

cargo check --manifest-path src-tauri/Cargo.toml | Out-Null
npm run build | Out-Null

git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json

if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
  $CommitMessage = "Release $tagName"
}

git commit -m $CommitMessage
git tag -a $tagName -m "Release $tagName"

if ($Push) {
  git push origin main
  git push origin $tagName
}

Write-Host "Created $tagName from $currentVersion -> $nextVersion"
