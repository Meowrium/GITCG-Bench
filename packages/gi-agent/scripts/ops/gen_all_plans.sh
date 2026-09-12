#!/bin/bash
# Generate gameplans for all 8 benchmark decks
# CORRECTED deck codes — sourced from self-play-v6-dense.json mirror matchups
source /mnt/d/AI/GTCG/genius-invokation/ds.sh
cd /mnt/d/AI/GTCG/genius-invokation/packages/gi-agent

declare -A DECK_CODES=(
  ["雷鹤"]="APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"
  ["红牛"]="ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA"
  ["水债"]="AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA"
  ["水八"]="A0BQ9CEPA1Bw9ZUPCWCw+MIPDIBg/cYQDCGQCskQDaEQC9EQDbEgDt0QD+EQD/IQD/AA"
  ["雷狼"]="AbDg5QQOAVCw5pcPCUBw9MIPDFAg9sYQDCFgA8kQDDGQDMoQDMGgDdEQDdEQENYRDQAA"
  ["神宵"]="AABQ7xUOAPBw9JcPCUBw9b0PDFCg9soQDTFgA9YQDbGQC9kQDcGwDN8QDeHwEOARDgAA"
  ["莫优"]="AhCQ3QsPACBg9IYPCUBw9ZgPCVCA9r0PDGAg+cIPDJFgAskQDKGQC8oQDLGgDNEQDcAA"
  ["水凝"]="ABDQ4SoOACCQ4noPB0Cg9J0PCWDQ+cIPDNAg/sYQDKFgC8kQDLGQDtEQDeEQD9oQDvAA"
)

export OPENAI_API_KEY="$DECK_ANALYZER_API_KEY"
export GAMEPLAN_BASE_URL="$DECK_ANALYZER_BASE_URL"
export GAMEPLAN_MODEL="$DECK_ANALYZER_MODEL"

mkdir -p output/plans-v3

for name in "${!DECK_CODES[@]}"; do
  echo "🤖 $name ..."
  code="${DECK_CODES[$name]}"
  pnpm exec gnx scripts/generate_gameplan.ts "$code" \
    --model "$DECK_ANALYZER_MODEL" \
    --profiles ../eval-char-comb/output/character-profiles.json \
    --output "output/plans-v3/${name}.json" 2>&1 | tail -3
  echo ""
done

echo "=== Done ==="
ls -la output/plans-v3/
