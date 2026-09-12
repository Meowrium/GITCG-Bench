# 云服务器配置推荐 — 七圣召唤训练管道

## 瓶颈分析

12小时/轮（本地 i7-7700HQ 4C8T / 16GB / SATA SSD）：

| 阶段 | 占比 | 耗时 | 特征 |
|------|------|------|------|
| 自对弈 (1248局) | ~60% | ~7h | 单线程，每局0.4min，并发=2 |
| 数据集导出 | ~5% | ~0.6h | **磁盘I/O密集**（600-800MB JSON读写） |
| 模型训练 LightGBM | ~10% | ~1.2h | 多线程CPU |
| 评估对弈 | ~20% | ~2.4h | 同自对弈 |
| 其他 | ~5% | ~0.6h | — |

**关键发现**：你之前硬盘I/O爆了的原因是——即使只保留 policy_public 视图，每轮自对弈仍会产生数百MB原始捕获文件和 GB 级数据集 JSON。SATA SSD 的 IOPS 瓶颈在此场景下非常突出。

---

## 推荐配置

### 最低配置 (能跑，约8-10h/轮)

| 资源 | 规格 | 理由 |
|------|------|------|
| CPU | **8核** (16 vCPU) | 自对弈并发6 + LightGBM多线程 + 系统开销 |
| 内存 | **32 GB** | 6个自对弈进程×1.5GB + 数据集处理4GB + 系统 |
| 系统盘 | **40 GB NVMe** | 系统 + 依赖 |
| 数据盘 | **100 GB NVMe** | 训练工作目录（每轮2-5GB中间文件，保留最近迭代后自动清理） |

### 推荐配置 (~3-4h/轮)

| 资源 | 规格 | 理由 |
|------|------|------|
| CPU | **16核** (32 vCPU) | 自对弈并发10-12，缩短主体耗时 |
| 内存 | **64 GB** | 高并发下足够余量，避免OOM |
| 系统盘 | **40 GB NVMe** | 系统 + 依赖 |
| 数据盘 | **200 GB NVMe Gen4** | 读写速率>5000MB/s，解决I/O瓶颈 |

### 预算选项 (2-3h/轮)

| 资源 | 规格 |
|------|------|
| CPU | **32核** (64 vCPU) |
| 内存 | **128 GB** |
| 系统盘 | **40 GB NVMe** |
| 数据盘 | **500 GB NVMe Gen4** |

---

## 硬盘I/O详解

**为什么必须NVMe**：

| 操作 | 磁盘负载 | 说明 |
|------|----------|------|
| 自对弈写入 | 随机4K写 × 几千次/局 | 游戏状态快照（policy_public模式约50KB/次） |
| 数据集导出 | 顺序读 600MB + 顺序写 分片 | shard文件各1-5MB，共数十个 |
| LightGBM 训练 | 顺序读 数据集文件 | 全量加载特征矩阵 |
| 评估对弈 | 同自对弈 | — |

SATA SSD (500MB/s, 10K IOPS) → NVMe Gen3 (3500MB/s, 300K IOPS) → **30x IOPS提升**

---

## 部署步骤

```bash
# 1. 本地推送代码
git push

# 2. 上传训练资产（需要保留的本地文件）
scp -r packages/gi-agent/plan-phases/           root@SERVER:/opt/gi-training/packages/gi-agent/
scp -r packages/gi-agent/.llm-deck-cache/       root@SERVER:/opt/gi-training/packages/gi-agent/
scp    packages/gi-agent/benchmark.training-v3.json root@SERVER:/opt/gi-training/packages/gi-agent/

# 3. 服务器上执行
ssh root@SERVER
cd /opt/gi-training
bash scripts/cloud-deploy.sh    # 一次性环境安装
bash scripts/cloud-train.sh     # 启动训练

# 4. 下载训练结果
scp -r root@SERVER:/opt/gi-training/packages/gi-agent/output/cloud-training/ ./
```
