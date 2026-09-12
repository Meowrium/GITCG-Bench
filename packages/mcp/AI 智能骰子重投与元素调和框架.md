## 计划：AI 智能骰子重投与元素调和框架 (AI Local Dice Reroll and Tuning Framework)

此计划将在 MCP 独立服务器中引入一个本地逻辑框架，通过算法正确处理泛型骰子需求（如“任意3同色”或“2个火/万能”）和元素调和需求。AI 只需声明其**目标骰子状态**，服务端即可计算出最佳保留方案（并自动重投其余骰子），或智能选择上下文中最不重要（最低优先级）的手牌进行元素调和。

**开发步骤**
1. **设计目标骰子解析协议 (Dice Target Expression)**
   - 确立一种接口格式（例如 `{"omni_or_hydro": 3, "any_same": 2}`），使 AI 工具能轻松表达诸如“至少2个火，1个同色，剩下随意”的泛用条件。
2. **实现动态手牌价值评估 (Context-Aware Card Evaluator)**
   - 在 `src/analysis/CardEvaluator.ts` 中实现评估函数：根据当前出战角色状态、充能、所处回合以及卡牌本身的适用性进行打分。分数/优先级最低的卡牌将被系统标记为**调和狗粮（Tuning Candidates）**。
3. **实现智能重投工具 (`smart_reroll`)**
   - 建立 `src/analysis/DiceOptimizer.ts`。当在投掷阶段调用此工具时，根据当前的初始骰群与 AI 的期望表达式，计算出“应保留的最佳骰群下标”，并向后端的 `reroll_dice` 传入对应参数，AI 不再需要自己推理具体的骰子索引。
4. **实现智能调和工具 (`smart_tune`)**
   - 新增 `smart_tune` 工具。当 AI 需要某元素的骰子救场而手牌有空间时，只需告知需转换的数量和目标元素，系统会自动调用 `CardEvaluator` 挑选最次的卡牌、将其弃置并进行元素调和转换。
5. **更新 MCP 工具注册口 (StandaloneMcpToolHandler)**
   - 在相关处理器中注册上述两个新工具。
   - 调整 AI Prompt：鼓励使用这套基于预警与算法的新框架，淘汰容易使 AI 产生幻觉的低阶 `reroll_dice` 与手动选牌调和操作。

**相关文件修改**
- `mcp-standalone-repo/src/mcp/StandaloneMcpToolHandler.ts` — 注册新工具并代理请求。
- `mcp-standalone-repo/src/analysis/CardEvaluator.ts` — 添加战局实时的手牌评分和淘汰逻辑。
- `mcp-standalone-repo/src/analysis/DiceOptimizer.ts` — 编写核心匹配算法，实现目标条件解析。

**验证方法**
1. 单测预验证：输入不同的需求字符串/格式，验证 `TargetParser` 是否完美响应“万能+某元素N个”、“A/B元素各M个”、“3同色”等逻辑。
2. 模拟包含关键手牌与出战角色的场景（如角色缺大招时），验证充能卡/有效武器不被“狗粮”系统选中，而是抛弃不需要的异色角色专属或低收益卡。
3. 对战模拟：启动 MCP 测试，查看 AI 调用 `smart_reroll` 时服务器执行的保留逻辑是否正确；调用 `smart_tune` 时是否自动消耗了对应的手牌并成功转换出所需元素的骰子。

**决策纪要**
- 保持 `smart_reroll` 和 `smart_tune` 作为相互独立的工具：赋予 AI 对“何时换防”或“何时该直接甩牌”的阶段性决策控制权。
- 采用动态上下文评估（Dynamic Context-Aware）：根据战场需求（而非静态节奏列）分配卡牌权重，在不影响构筑的前提下最大化保留具有战术价值的卡牌。