param(
  [string]$PatchFile = "packages/mcp/patches/standalone-v1.patch"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required but was not found in PATH"
}

if (-not (Test-Path -LiteralPath $PatchFile)) {
  throw "Patch file not found: $PatchFile"
}

$insideRepo = git rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -ne 0 -or $insideRepo.Trim() -ne "true") {
  throw "Current directory is not inside a git repository"
}

# Dry-run first so failures are surfaced before touching files.
git apply --check $PatchFile
if ($LASTEXITCODE -ne 0) {
  throw "Patch check failed: $PatchFile"
}

git apply $PatchFile
if ($LASTEXITCODE -ne 0) {
  throw "Patch apply failed: $PatchFile"
}

Write-Host "Patch applied successfully: $PatchFile"
