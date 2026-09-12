# 赛前卡组分析 Benchmark

本 benchmark 不启动 headless 对局，只评价模型从 `createDeckContext` 的卡牌、角色和规则文本中，
是否正确识别卡组性质、获胜路径、关键依赖和 matchup 思路。它适用于沙箱生成的
`strategy.json`，也适用于直接要求模型产出 JSON 的评测接口。

它不以启发式函数的输出作为唯一真值：`createRichDeckContext` 中的 combo clock、zone pressure 等可以
用来生成候选标注和做诊断，但如果它们同时出现在模型输入，就不能再作为同一字段的 gold label。

## 1. 任务拆分

一个样本是 `{ code, version }` 形式的 `myDeck`，可选地加上 `opponentDeck`。`version` 是解析该卡组
所用的数据版本，不能为空；输入只能是冻结版本的纯数据 deck context；
测试集 gold 与评分逻辑对模型不可见。

版本是样本身份的一部分：`deckCode + version + contextHash`。同一段 deck code 在不同版本应视为不同样本，
并分别用相应 `AssetsManager({ version })` 解析。不可用当前卡牌文本评分历史版本卡组，也不可把不同版本的
同名卡牌作为同一个 evidence ID。对局样本还应记录双方版本；接回真实对局时 runner 使用同一版本的
规则与卡牌数据，且双方版本必须相同。

| 子任务 | 评价对象 | 自动判分为主 | 人工标注为主 |
| --- | --- | --- | --- |
| 事实恢复 | 角色、卡牌、费用、限制、可检索的效果 | 是 | 否 |
| 卡组画像 | 快攻/中速/控制/组合技等多标签，以及节奏曲线 | 部分 | 是 |
| 机制推理 | 关键件、依赖、可成立的 combo、失败条件 | 部分 | 是 |
| 双方对局 | 威胁、要争夺的窗口、应避免的资源交换 | 否 | 是 |
| 可信度 | 预测概率是否与实际正确率一致，是否会拒答 | 是 | 否 |

“快攻、中速、控制、组合技”不能建模为互斥单选。例如一套通过两张关键牌在第 2 回合展开、
但之后靠持续压制取胜的卡组可同时有 `combo` 与 `tempo` 标签。因此模型必须输出标签分布和证据，
而不是只输出一个 `archetype` 字符串。

## 2. 建议替换的 `strategy.json` 分析字段

保留原策略字段供 Agent 使用，但在沙箱输出中增加下列可评分的 `analysisV2`。卡牌和角色统一使用输入
context 中的稳定 ID；禁止只用自然语言名称充当证据。`evidence` 中的 ID 必须来自当前侧给到模型的
`myDeckData` 或 `oppDeckData`，这样可以自动检测幻觉引用和越权引用。

```json
{
  "analysisSchemaVersion": "2.0",
  "inputIdentity": {
    "myDeck": { "code": "<base64>", "version": "v5.5.0", "contextHash": "sha256:..." },
    "opponentDeck": { "code": "<base64>", "version": "v5.5.0", "contextHash": "sha256:..." }
  },
  "analysisV2": {
    "deckProfile": {
      "archetypeWeights": {
        "tempo": 0.65,
        "midrange": 0.20,
        "control": 0.05,
        "combo": 0.70,
        "ramp": 0.10
      },
      "primaryArchetypes": ["tempo", "combo"],
      "pace": {
        "setupRounds": { "min": 1, "max": 2 },
        "pressurePeakRounds": [2, 3],
        "lateGameReliance": 0.25
      },
      "winConditions": [
        {
          "id": "wc-1",
          "kind": "burst|board_lock|attrition|engine|other",
          "description": "一句可验证的获胜机制",
          "requiredPieces": ["card-or-character-id"],
          "evidence": ["card-or-character-id"],
          "confidence": 0.82
        }
      ],
      "keyPieces": [
        {
          "id": "card-or-character-id",
          "role": "enabler|payoff|engine|tutor|protection|finisher",
          "necessity": "required|replaceable|optional",
          "evidence": ["card-or-character-id"],
          "confidence": 0.90
        }
      ],
      "lines": [
        {
          "id": "line-1",
          "kind": "combo|pressure|stabilize|value",
          "steps": [
            { "actor": "card-or-character-id", "effect": "短句", "evidence": ["id"] }
          ],
          "preconditions": ["可由输入规则文本验证的条件"],
          "payoff": "造成的具体局面/资源结果",
          "fragility": ["被打断的可验证原因"],
          "confidence": 0.74
        }
      ],
      "resourcePlan": {
        "priority": ["dice", "cards", "energy", "tempo", "board_slots"],
        "bottlenecks": [
          { "resource": "dice", "reason": "可验证说明", "evidence": ["id"] }
        ]
      }
    },
    "matchup": {
      "opponentThreats": [
        {
          "id": "threat-1",
          "source": "opponent-card-or-character-id",
          "window": { "minRound": 2, "maxRound": 3 },
          "severity": "low|medium|high",
          "counterplay": ["仅依据己方卡组能够执行的措施"],
          "evidence": ["opponent-id", "my-id"],
          "confidence": 0.68
        }
      ],
      "relativePlan": {
        "advantageAxes": ["tempo", "burst", "resource", "board", "consistency"],
        "targetPace": "race|stabilize|deny_setup|outvalue",
        "confidence": 0.61
      }
    },
    "abstentions": [
      {
        "field": "matchup.relativePlan",
        "reason": "输入资料不足或存在多个等价分支"
      }
    ]
  }
}
```

约束：权重与 confidence 必须在 `[0, 1]`；`primaryArchetypes` 是权重大于等于 `0.35` 的标签；
每一个关键结论至少提供一条证据；没有可靠依据时使用 `abstentions`，而不是编造确定结论。
供运行时注入 prompt 的自然语言摘要可由此 JSON 再生成，不能反过来把无法评分的大段 prose 当作唯一输出。

## 3. Gold 数据集

### 样本构成

建议首版使用 80 个单卡组样本和 48 个 matchup 样本：

- 现有 8 套 benchmark 卡组；
- 每套至少 4 个“最小改动”变体：移除 payoff、移除 enabler、替换为 draw/防守/高费牌；
- 其余为不同角色组合、不同资源曲线的固定构筑；
- matchup 由不同风格的卡组配对，不能只有镜像。

最小改动变体是核心防投机集合：例如移除唯一 payoff 后，模型仍把它判为稳定 combo，或仍引用已删除的牌，
应被直接扣分。变体和原卡组必须按 lineage 分组，只能整体落入 train/dev/test 之一，防止近重复泄漏。

### 标注流程

1. 程序从纯数据提取硬事实：牌/角色集合、复制数、费用、元素、明确的前置条件与效果。
2. 两名熟悉规则的标注者独立填写 `analysisV2` gold；他们只看同一输入，不看任何候选模型答案或启发式结论。
3. 第三名标注者裁决分歧，保留 `acceptableAlternatives`（例如两种合理的主副 archetype）。
4. 对画像、关键件和对局计划计算 Krippendorff's alpha；低于 `0.67` 的字段修改 rubric 或允许多答案，
不以个人偏好当作真值。
5. 将标注者解释引用的输入 ID 写入 gold，供审计与争议复核。

测试集必须包含初版开发后才冻结的卡组/变体；不得用同一个模型的分析结果生成或裁决 gold。

## 4. 评分

最终得分为 100 分，并同时公布各分项，禁止只报总分。

| 分项 | 分数 | 方法 |
| --- | ---: | --- |
| 输入忠实性 | 20 | schema、ID 存在性、无对手越权、证据可从原始规则文本蕴含、无虚构牌/效果 |
| 卡组画像 | 20 | archetypeWeights 对 gold 分布的 Brier score；`primaryArchetypes` 的 macro-F1；节奏区间的区间 IoU |
| 获胜条件与关键件 | 25 | `kind`/role/necessity 的加权集合 F1；每个匹配 claim 还需 evidence entailment |
| 线路与资源推理 | 20 | 步骤依赖、前置条件、payoff、fragility 的 rubric；无效或不可能线路为 0，不能以文笔加分 |
| matchup 判断 | 10 | threat/source/window/counterplay 的加权 F1；只在提供 opponent deck 时计入 |
| 校准与克制 | 5 | confidence 的 Brier/ECE；正确 abstention 不罚分，错误的高 confidence 额外扣分 |

单卡组任务移除 matchup 的 10 分后，将其按 `输入忠实性 +2、卡组画像 +3、线路与资源 +5` 重分配。
对自然语言字段，只允许人工评审“是否被证据支持、是否可执行”，每项 0/1/2；评审必须盲测模型来源。

评分时按卡组做 macro-average，变体 lineage 权重合计为 1，避免某一热门卡组的许多变体主导总分。
报告 1,000 次 grouped bootstrap（按 lineage 重采样）的 95% CI，比较模型时报告分项 delta 与 CI。

## 5. 两个必须分开的赛道

| 赛道 | 模型输入 | 目的 |
| --- | --- | --- |
| `reasoning-pure` | `createDeckContext` 纯数据 | 测量模型自身的规则阅读与推理 |
| `heuristic-assisted` | 纯数据 + 明确标记的启发式输出 | 测量整套沙箱产品的效果 |

不能将两个赛道成绩横向称为“模型本体能力”。在 assisted 赛道，报告还应列出模型只是复述启发式、
成功纠错启发式、以及被错误启发式带偏的比例。所有自动启发式的版本和 hash 写入 manifest。

## 6. 最小验收集与发布规则

先用 16 个单卡组样本（含 8 个最小改动变体）和 8 个 matchup 做 smoke：验证 JSON、ID、证据和评分器。
正式比较使用上述冻结的 80/48 集合。

一个模型/沙箱版本只有同时满足以下条件才可宣称“赛前分析更好”：

- 总分的 grouped-bootstrap 95% CI 下界高于对照；
- `输入忠实性 ≥ 18/20`，且不存在越权访问另一侧 sandbox 的证据；
- `获胜条件与关键件`、`线路与资源推理` 均不低于对照 3 分以上；
- 最小改动变体上的总分不低于原卡组集合，且“引用已删除关键件”率低于 2%；
- 单独报告 pure 与 assisted 赛道，不得合并。

## 7. 与现有沙箱的接入

评测调用现有沙箱生成流程即可，但 runner 不启动游戏。每个样本保存：`my_deck_data.json`（含版本）、
可选 `opp_deck_data.json`、`analysis.ts`、原始 stdout、经 schema 校验后的 `strategy.json`、
generation log 和评分结果。每条结果需记录 `analysisSchemaVersion`、模型 ID、prompt hash、
temperature、heuristics 开关和输入数据 hash。

实现顺序建议：先把 `analysisV2` 的 Zod schema 与 JSON-only prompt 落地；再建立 16 样本 smoke gold 和
自动 ID/evidence 校验器；最后加入人工 rubric、变体生成器和 grouped-bootstrap 报告器。这样即使暂未运行
任何对局，也能找出“只会写漂亮策略文本、却没有读懂卡牌”的模型。
