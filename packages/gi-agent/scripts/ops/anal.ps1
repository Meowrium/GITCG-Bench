$env:DECK_ANALYZER_API_KEY=$env:DEEPSEEK_API_KEY
$env:DECK_ANALYZER_MODEL="deepseek-v4-pro"
$env:DECK_ANALYZER_BASE_URL="https://api.deepseek.com"
pnpm run spl:compile --benchmark benchmark.training-v3.json --output ./plan-phases/ --llm-enhance
