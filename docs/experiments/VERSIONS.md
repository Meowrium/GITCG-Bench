# GI-TCG Experiment Version Registry

> Single source of truth for all AI pipeline experiments.
> Update after each run. For paper writing: grep by version tag.

---

## Version Comparison

| Version | Date | Tag | WR% | Coverage | Value Model | Ranker | Key Change | Status |
|---------|------|-----|-----|----------|-------------|--------|------------|--------|
| v16 | ? | `v16-mcts400-gbdt` | ? | ? | GBRL→GBDT | GBDT lambdarank | Baseline MCTS400 | ? |
| v18 | ? | ? | ? | ? | GBRL→GBDT | GBDT lambdarank | ? | ? |
| v19 | 2026-05-29 | `v16-gbrl-v19` | **0.0%** | 100/100 | GBRL→GBDT | GBDT lambdarank | Missing features → range collapse | ❌ Failed |
| v20-gbdt-v3 | 2026-05-30 | `v20-gbdt-v3` | **0.0%** | 100/100 | GBRL→GBDT | GBDT lambdarank | Fixed paths + threshold features | ❌ Failed |
| v20-gbdt-v5 | 2026-05-31 | `v20-gbdt-v5` | **0.0%** | 100/100 | GBRL→GBDT | GBDT lambdarank | top-features 160, 200 trees, lr 0.03 | ❌ Failed |
| v20-gbdt-fix-v6 | 2026-06-03 | `v20-gbdt-fix-v6` | **0.0%** | 100/100 | GBRL→GBDT | GBDT lambdarank | Full pipeline w/ leaf analysis probe | ❌ Failed |
| **v20-gbdt-fix-v7** | **2026-06-03** | **`v20-gbdt-fix-v7`** | **?** | **100** | **GBRL Direct** | **GBDT lambdarank** | **Skip LGBM: GBRL direct inference** | **🔄 Running** |
| v20-guided-v1 | 2026-05-31 | `v20-guided-v1` | — | — | GBRL→GBDT | GBDT lambdarank | Guided self-play (syntax error crash) | ❌ Failed |
| v20-gbrl-direct | 2026-06-01 | `v20-gbrl-direct` | **0.0%** | 100/100 | GBRL Direct | GBDT lambdarank | GBRL subprocess MCTS (OOM + fd I/O) | ❌ Failed |
| **v20-luck-v1** | **2026-06-09** | **`v20-luck-v1`** | **?** | **?** | **GBRL→GBDT** | **GBDT lambdarank** | **Luck-aware weights + combo/luck policy** | **🔄 Running → merged** |
| **v20-luck-v9** | **2026-06-12** | **`v20-luck-v9`** | **0.0%** | **100** | **GBRL Direct** | **GBDT lambdarank** | **GBRL direct inference, 1000 self-play** | **✅ Done** |
| **v20-luck-v10** | **2026-06-13** | **`v20-luck-v10`** | **—** | **—** | **—** | **—** | **FORCE_RETRAIN unbound → crash** | **❌ Failed** |
| **v20-luck-v11** | **2026-06-13** | **`v20-luck-v11-conc16`** | **—** | **—** | **—** | **—** | **concat=16 → Stage 3 OOM** | **❌ Failed** |
| **v20-luck-v12** | **2026-06-14** | **`v20-luck-v12`** | **—** | **—** | **GBRL Direct** | **GBDT lambdarank** | **Revert concurrency, 16C32G** | **❌ Stage 3 OOM** |
| **v20-luck-v13** | **2026-06-14** | **`v20-luck-v13`** | **—** | **—** | **GBRL Direct** | **GBDT lambdarank** | **node --max-old-space-size=28672** | **❌ Bun not defined** |
| **v20-luck-v14** | **2026-06-14** | **`v20-luck-v14`** | **?** | **?** | **GBRL Direct** | **GBDT lambdarank** | **+bun runtime, node heap fix** | **🔄 Running** |

---

## v20-luck-v9 — GBRL Direct + 1000 SP + luck weights (✅ 0% WR)

| 维度 | 详情 |
|------|------|
| **状态** | ✅ Done |
| **日期** | 2026-06-12 |
| **ECI** | `eci-7xv8q7cpkix3p4lb34b1` |
| **规格** | `ecs.c7a.4xlarge` (16C32G), Spot ¥1.5/h |
| **镜像** | `bench-llm:v20-luck-v9` |
| **NAS 归档** | `/mnt/nas/v20-mcts400-gbdt` |
| **Pipeline 耗时** | 2h33m (12:06–14:39 CST) |

### Training Metrics
| 指标 | 值 |
|------|-----|
| Self-play | 1000 captures → 118,906 RL samples, 333 shards |
| GBRL Train/Val MAE | 0.3788 / 0.3790 |
| GBRL pred range | [-0.1896, 1.2203] span=**1.41** ✓ |
| LGBM | N/A (skipped — direct inference) |
| Ranker pairwise_support | 0.772 |
| Ranker top1_not_contradicted | 0.388 |

### Results: 0% WR, 0/1000, all 0-10-0

---

## v20-luck-v10 — FORCE_RETRAIN unbound (❌ Failed)

| 维度 | 详情 |
|------|------|
| **状态** | ❌ Failed |
| **日期** | 2026-06-13 |
| **ECI** | `eci-7xv2clm5687jo10asrhr` |
| **镜像** | `bench-llm:v20-luck-v10` |

### Root Cause
`pipeline.sh` L4 `set -eu` + L73 `${FORCE_RETRAIN}` 未绑定，Dockerfile 缺 `ENV FORCE_RETRAIN=true`（v11 已补）。Cron job 命名错位（名 v11 指 v10 镜像）。

---

## v20-luck-v11-conc16 — Stage 3 OOM (❌ Failed)

| 维度 | 详情 |
|------|------|
| **状态** | ❌ Failed |
| **日期** | 2026-06-13 |
| **ECI** | `eci-7xv2clm5687k16jptyaa` |
| **规格** | `ecs.c7a.8xlarge` (32C64G), Spot ¥1.5/h |
| **镜像** | `bench-llm:v20-luck-v11-conc16` |

### Root Cause
Stage 3 `run-build-rl-warm-start-bundle.ts` Node V8 heap 溢出（`AllocateRawWithRetryOrFailSlowPath`）。pnpm→node 迁移后 V8 默认 heap ~4GB，118K samples 构建 ranking dataset 撑爆。v9 用 bun 能过。

---

## v20-luck-v12 — Same OOM, not concurrency (❌ Failed)

| 维度 | 详情 |
|------|------|
| **状态** | ❌ Failed |
| **日期** | 2026-06-14 |
| **ECI** | `eci-7xv6frsk9x2p0emg2c53` |
| **规格** | `ecs.c7a.4xlarge` (16C32G), Spot ¥1.5/h |
| **镜像** | `bench-llm:v20-luck-v12` |

### Root Cause
回退 concurrency 16→8 后 Stage 3 仍然 OOM。证实根因**不是 concurrency，是 node vs bun**：node 默认 heap ~4GB，无论机器 16GB 还是 64GB。Fix: `--max-old-space-size=28672`。

---

## v20-luck-v13 — +--max-old-space-size=28672 (🔄 Running)

| 维度 | 详情 |
|------|------|
| **状态** | 🔄 Running |
| **日期** | 2026-06-14 |
| **ECI** | `eci-7xvdfkxwz4y1k613zpjg` |
| **规格** | `ecs.c7a.4xlarge` (16C32G), Spot ¥1.5/h |
| **镜像** | `bench-llm:v20-luck-v13` |
| **NAS 归档** | `/mnt/nas/v20-mcts400-gbdt` |

### Key Change
`pipeline-mcts-gbdt.sh` L104: `node --max-old-space-size=28672 ...` — 给 Node 28GB heap（32GB 容器留 4GB 给 OS）。

### Hypothesis
Stage 3 warm-start bundle 构建 118K samples → V8 heap 28GB 够用（v9 bun 16GB 够）。Stage 5 concurrency=8 不变。
