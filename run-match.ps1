$env:OPENAI_API_BASE = "https://opencode.ai/zen/go/v1"
if (-not $env:OPENAI_API_KEY) {
  throw "未设置 OPENAI_API_KEY 环境变量（本仓库不再硬编码凭据）"
}
& "$PSScriptRoot\.opencode\run-batch-llm.ps1" -ModelP0 "deepseek-v4-flash" -ModelP1 "deepseek-v4-flash" -SandboxEnabled 1
