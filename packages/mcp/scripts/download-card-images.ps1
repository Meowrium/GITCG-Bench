param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,
  [Parameter(Mandatory = $true)]
  [string]$IdFile,
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,
  [string]$Extension = "webp"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $IdFile)) {
  throw "ID file not found: $IdFile"
}

if (-not (Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

Get-Content -LiteralPath $IdFile | ForEach-Object {
  $id = $_.Trim()
  if ([string]::IsNullOrWhiteSpace($id)) {
    return
  }
  if ($id.StartsWith("#")) {
    return
  }

  $src = "{0}/{1}.{2}" -f $BaseUrl.TrimEnd('/'), $id, $Extension
  $dst = Join-Path $OutputDir ("{0}.{1}" -f $id, $Extension)

  if (Test-Path -LiteralPath $dst) {
    return
  }

  Write-Host "Downloading $src"
  Invoke-WebRequest -Uri $src -OutFile $dst
}

Write-Host "Done. Images saved to: $OutputDir"
