param(
    [switch]$LlmEnhance,
    [string]$LlmCacheDir = ".llm-deck-cache"
)

# Source LLM API credentials from anal.ps1
if ($LlmEnhance) {
    $analPath = Join-Path $PSScriptRoot "anal.ps1"
    if (Test-Path $analPath) {
        $analContent = Get-Content $analPath -Raw
        if ($analContent -match 'DECK_ANALYZER_API_KEY\s*=\s*"([^"]+)"') {
            $env:DECK_ANALYZER_API_KEY = $Matches[1]
        }
        if ($analContent -match 'DECK_ANALYZER_MODEL\s*=\s*"([^"]+)"') {
            $env:DECK_ANALYZER_MODEL = $Matches[1]
        }
        if ($analContent -match 'DECK_ANALYZER_BASE_URL\s*=\s*"([^"]+)"') {
            $env:DECK_ANALYZER_BASE_URL = $Matches[1]
        }
    }

    Write-Host "LLM config: model=$env:DECK_ANALYZER_MODEL, base_url=$env:DECK_ANALYZER_BASE_URL" -ForegroundColor Cyan
    Write-Host "Pre-computing LLM deck analysis..." -ForegroundColor Magenta
    Push-Location ../llm-deck-analyzer
    pnpm run precompute:llm ../gi-agent/benchmark.training-v3.json --cache-dir $LlmCacheDir
    Pop-Location
    Write-Host "LLM analysis pre-computed. Cache: $LlmCacheDir" -ForegroundColor Green
}

pwsh -File ../../scripts/run-multi-iteration-training.ps1 `
    -PlanStrategy compiled `
    -PlansDir ./plan-phases/ `
    -PlanExplorationEpsilon 0.15 `
    @(if ($LlmEnhance) { @("-LlmCacheDir", $LlmCacheDir) } else { @() })
