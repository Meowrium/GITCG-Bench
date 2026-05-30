$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$ProjectDir = Split-Path $ScriptDir -Parent
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("opencode-start-test-" + [guid]::NewGuid().ToString("N"))
$CaptureFile = Join-Path $TempDir "capture.json"
$StubPath = Join-Path $TempDir "opencode.ps1"

New-Item -ItemType Directory -Path $TempDir | Out-Null

try {
    @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

$payload = [pscustomobject]@{
    args = $Rest
    opencode_config = $env:OPENCODE_CONFIG
    cwd = (Get-Location).Path
}

$payload | ConvertTo-Json -Depth 5 | Set-Content -Path $env:OPENCODE_CAPTURE_FILE -Encoding UTF8
'@ | Set-Content -Path $StubPath -Encoding UTF8

    $originalPath = $env:PATH
    $env:PATH = "$TempDir;$env:PATH"
    $env:OPENCODE_CAPTURE_FILE = $CaptureFile

    $cases = @(
        @{
            name = "p0"
            script = Join-Path $ScriptDir "start-p0.ps1"
            agent = "gi-tcg-p0"
            prompt = "开始对局"
            config = Join-Path $ScriptDir "opencode-p0-agent.json"
        },
        @{
            name = "p1"
            script = Join-Path $ScriptDir "start-p1.ps1"
            agent = "gi-tcg-p1"
            prompt = "开始对局"
            config = Join-Path $ScriptDir "opencode-p1-agent.json"
        }
    )

    foreach ($case in $cases) {
        Remove-Item $CaptureFile -ErrorAction SilentlyContinue
        & $case.script

        if (-not (Test-Path $CaptureFile)) {
            throw "No opencode invocation captured for $($case.name)"
        }

        $capture = Get-Content $CaptureFile -Raw -Encoding UTF8 | ConvertFrom-Json

        if ($capture.cwd -ne $ProjectDir) {
            throw "$($case.name): expected cwd '$ProjectDir', got '$($capture.cwd)'"
        }

        if ($capture.opencode_config -ne $expectedConfig) {
            throw "$($case.name): expected OPENCODE_CONFIG '$expectedConfig', got '$($capture.opencode_config)'"
        }

        # Expected: opencode --agent <name> --prompt "<text>"
        $agentIdx = [array]::IndexOf($capture.args, "--agent")
        $promptIdx = [array]::IndexOf($capture.args, "--prompt")
        
        if ($agentIdx -lt 0 -or $promptIdx -lt 0) {
            throw "$($case.name): expected --agent and --prompt flags, got $($capture.args | ConvertTo-Json -Compress)"
        }

        if ($capture.args[$agentIdx + 1] -ne $case.agent) {
            throw "$($case.name): expected --agent '$($case.agent)', got '$($capture.args[$agentIdx + 1])'"
        }

        if ($capture.args[$promptIdx + 1] -ne $case.prompt) {
            throw "$($case.name): expected --prompt '$($case.prompt)', got '$($capture.args[$promptIdx + 1])'"
        }
    }

    Write-Host "start script tests passed"
}
finally {
    if ($null -ne $originalPath) {
        $env:PATH = $originalPath
    }
    Remove-Item Env:\OPENCODE_CAPTURE_FILE -ErrorAction SilentlyContinue
    Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
