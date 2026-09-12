#!/usr/bin/env bash
# 七圣召唤知识评测 — 使用 eval-config.json 批量运行
set -euo pipefail

BASEDIR="$(cd "$(dirname "$0")" && pwd)"
# eval-config.json 的 questions 是「仓库根相对」路径，故先切到仓库根
REPO_ROOT="$(cd "$BASEDIR/../../.." && pwd)"
cd "$REPO_ROOT"
NODE="node"
REPO_ROOT_WIN="$(cygpath -m "$REPO_ROOT" 2>/dev/null || echo "$REPO_ROOT")"
TSX_IMPORT="file:///$REPO_ROOT_WIN/packages/config/src/preload/node.js"
EVAL_SCRIPT="$BASEDIR/src/cli/evaluate.ts"
CONFIG="$BASEDIR/eval-config.json"

export NODE_ENV=development

echo "===== 批量评测 (config: eval-config.json) ====="
$NODE --disable-warning=DEP0205 --conditions=development \
  --import="$TSX_IMPORT" \
  "$EVAL_SCRIPT" \
  --config "$CONFIG"
