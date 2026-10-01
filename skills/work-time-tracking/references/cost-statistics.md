# AI 成本统计口径（Token / 积分 / Skill）

> **本文档定义「AI 花了多少」这件事的唯一口径。**
> 字段定义见 `references/data-schema.md`；结算与写入机制见 `references/settlement.md`；
> 实现见 `scripts/lib/metrics-engine.js`（`buildSkillCost()` / `attributeDimension()` / `buildCostStats()`）。

---

## 1. 一句话原则

```text
Token 与积分是**两个独立指标**，同时给出、互不换算；
Credit / 积分只适用于积分类 Agent（如使用 WorkBuddy 积分问答）；
API 调用不产生积分，记 `0 + score_source: not_applicable`；
Skill 级积分**不存在** → 一律 null；
归因只走记录里**已经存在的** conversation_id，绝不推断、绝不摊派。
```

---

## 2. 统计单位：Conversation 是总账，Turn 是轮次分解

```text
Conversation（一次有连续上下文的 AI 会话）
   ├── total_token / total_score      ← 宿主给的真实总账
   ├── 0..N Turn                     ← 每轮精确 Token，不能分摊给 Skill
   ├── 0..N Work Segment              ← 主题边界
   ├── 0..N AI Usage Record           ← 精确归属明细
   └── 1..N Skill Usage               ← 只有载入体积（A 口径），没有积分
```

| 层级 | Token | 积分（Score / Credit） |
|---|---|---|
| **Conversation** | ✅ 真实值 | ✅ 真实值（可能是**下界**） |
| **Turn** | ✅ 来自 `turn_token_usage`，是本轮精确总量 | ❌ 不产出积分拆分 |
| **模型（model_name）** | ✅ 真实值（会话整体记给**主模型**） | ✅ 同会话；`not_applicable` 留空 |
| **Skill** | ✅ 只有 A 口径（载入体积） | ❌ **不存在** → `null` |
| **工作类型 / 项目 / 项目阶段** | 旧口径仅当事项带 `conversation_id` 时整体归属；新口径另看 AI Usage 精确归属 | 积分适用性继承 Conversation；API 类记 `not_applicable`，展示留空 |

**Turn 是会话内的分解层级**：一次用户请求 + 后续全部 Agent 工作，可以包含多条
消息和多次模型请求。`turn_token_usage` 用于回答“这一轮花了多少”，但不得继续
按 Skill 拆分。正常情况下 `Σ turn.total_token ≤ Conversation.total_token`，
差额是未形成 Turn 的系统/内部开销；差额保持未分配，不按比例补到 Turn 或 Skill。

**Message / 请求不是统计单位** —— 它只是 Turn 或会话内部的明细量（`request_count`）。

---

## 3. 三个 Token 口径（最容易搞混的地方）

| 口径 | 名称 | 取值 | 可跨 Skill 相加？ | 可与会话级 Token 相加？ |
|---|---|---|---|---|
| **A** | Skill 载入体积 | `skill_token = load_chars × token_per_char` | ✅ 可以 | ❌ **不可以** |
| **B** | 调用所在请求的用量 | `call_request_total_token`（含全部历史上下文） | ❌ **禁止**（同请求多 Skill 会重复计入） | ❌ 不可以 |
| **C** | 会话总用量 | Conversation 的 `total_token` | — | ✅ 这是会话级唯一权威值 |

**严禁**：

```text
✗ total_token ÷ Skill 数
✗ 按调用次数推算单次 Token
✗ 按 load_chars 占比反推「独占」Token
✗ 把 B 口径当 skill_token 求和
✗ 把 A 口径之和与会话级 total_token 相加或相除
```

**取不到就写 `null`**（`token_source: "unavailable"`），并说明原因（载入失败 / 口径关闭）。

---

## 3.1 V3.5：Conversation 总账与 AI Usage 精确归属

```text
Conversation total_token / total_score
  = 原始总账

AI Usage Record
  = 对这个总账中可精确表达部分的分项说明
```

允许三种状态：

```text
exact        已知用量明确对应 Segment / Activity
partial      只明确一部分，缺失部分没有数值
unallocated  用量已知但事项未知
```

汇总同时输出：

```text
allocated_token / allocated_credit
unallocated_token / unallocated_credit
```

计算规则：

```text
allocated   = Σ AI Usage 中已给出的数值
unallocated = Conversation 总账 - allocated
```

硬约束：

```text
✗ 不按主题比例拆分 Conversation 总量
✗ 不按 Skill 数或调用次数拆分
✗ 不从 Token 占比反推 Credit
✗ 不把 Segment 当项目或成本归属
✓ 没有精确数据就保持 unallocated
✓ 两种口径分开呈现，不互相相加
```

旧 `attributeDimension()` 继续表示「会话级、全有或全无、歧义不计入任何一方」；
新 `allocatedDimension()` 只表示 AI Usage 精确归属。两张表不能求和。

---

## 4. Skill 维度指标（每项都要有）

```text
调用次数   invocations
失败次数   failed
累计 Token total_token（A 口径；全部不可获取时 null）
平均单次 Token avg_token
最大单次 Token max_token
最小单次 Token min_token
最近一次 Token last_token
最近一次时间   last_at
涉及对话数 conversation_count
关联事项数 activity_count
累计 Token 占会话总 Token 的比例 token_share
累计积分   total_score —— **恒为 null**
积分来源   score_source: 'unavailable'
不可用原因 unavailable_reason
载入字符数 load_chars（A 口径原始测量值，便于复核）
```

计数口径（V3.26）：

```text
skill_invocation_count = Skill Usage 事件条数（与旧 skill_count 一致）
distinct_skill_count   = 按 skill_id 去重后的不同 Skill 数
Skill Receipt          = 面向展示的只读视图：中间按事件累计，最终按 skill_id 去重
```

同一 Skill 同时有 `explicit_invocation` 和 `skill_md_loaded` 时：

```text
skill_invocation_count = 2
distinct_skill_count   = 1
回执显示                = 1 个 Skill
```

```text
· avg_token = token_known ? total_token / token_known : null
  （分母是**有值的调用次数**，不是 invocations —— 否则不可获取的调用会把均值压低）
· 任一单次 Token 不可获取 → max_token/min_token/last_token 仍按**已有值**计算，
  同时用 token_unavailable 计数器披露「有几次拿不到」
```

### 4.1 积分为什么必须是 null

宿主只提供**会话级** credit，不存在 Skill 级积分。
按比例把会话积分摊给 Skill 属于**估算**，明令禁止（用户要求「禁止估算 / 禁止摊派」）。

```text
✓ total_score: null + score_source: 'unavailable' + unavailable_reason: '宿主不提供 Skill 级积分'
✗ total_score: 145.63 / 3        ← 按 Skill 数摊派
✗ total_score: 会话积分 × 占比     ← 按 Token 占比摊派
✗ total_score: 0                 ← 0 表示「真实观察到零消耗」，与「不可获取」语义不同
```

### 4.2 版本对比

同一个 Skill 出现多个版本时，额外给出**平均单次 Token** 对比：

```text
<skill_id>：1.0 8,628（2 次）　→　1.1 6,352（3 次）
```

- 只对比**平均数**（总量受调用次数影响，不能说明版本优劣）
- 版本为 `null` 时记为「（无版本）」
- 全部不可获取时不输出该行

---

## 5. 三个归因维度（工作类型 / 项目 / 项目阶段）

V3.3 新增：把 AI 成本摊到「这件事属于什么工作」上。

| 维度 | 键 | 来源字段 | 说明 |
|---|---|---|---|
| 工作类型 | `work_type` | `config.work.work_types` | 「在做什么类型的事」 |
| 项目 | `project_name` | 记录中的项目名 | 「为哪个项目花的」 |
| 项目阶段 | `project_stage` | `config.work.project_stages` | 「在哪个阶段花的」 |

**三个维度都留空也是合法的**（不强制填写）—— 但留空就归到
`（未标注）` / `（未归属项目）`，且不参与任何 Token/积分分摊。

### 5.1 归因规则（铁律）

```text
1. 时间统计：照常统计（不受归因影响）
2. Token/积分：只有当事项带 **已存在** 的 conversation_id 时才归属
3. 一个会话在同一维度被**多个取值**引用 → 该会话的 Token/积分
   计入 'ambiguous'，**不计入任何一方**
4. 没有 conversation_id 的事项 → 只计时间，Token/积分记 null
5. 每个会话在同一维度**最多计入一次**（同一取值重复引用不重复累加）
6. `score_source = not_applicable` 的会话只参与 Token 统计；
   项目 / 工作类型 / 阶段表中的 Credit 显示为空，不显示「不可获取」
```

由此导出的两条必守事实：

```text
· 「按某维度」的 Token 合计 **可以小于** 会话总 Token（差额 = 未关联 + 有歧义）
· 「按某维度」的 Token 合计 **绝不可能大于** 会话总 Token
  （若出现大于，说明归因实现有缺陷）
```

### 5.2 项目 × 阶段（嵌套维度）

```text
先按项目聚合，再在项目内按阶段拆分
```

这一维**同样要判歧义**：同一会话若落进 2 个以上 `(项目, 阶段)` 格子，
说明归属不清 → 不计入任何一格。

> ⚠️ 真实踩到过：省略这一步会让「项目 × 阶段」的 Token 重复计数，
> 使合计大于会话总量。修复见 `buildCostStats()` 中的 `uniqueCellConv`。

### 5.3 V3.6：工作口径 vs 全量口径（同一维度出两张表）

```text
by_project / by_project_stage / by_work_type          全量口径（含探索沉淀 / 生活）
by_*_work / project_stages_work                       工作口径（剔除探索沉淀 / 生活）
```

**为什么必须分成两张**（用户 2026-09-24 要求「项目工作中哪个阶段比较侧重在 AI 上」）：

```text
同一会话若既做了业务项目、又给 skill 加了功能，在「全量口径」下会横跨
「业务项目」与「AI Skill 探索」两个取值 → 按 §5.1-3 判为歧义 → 该会话
**不计入任何一方**。结果就是项目/阶段两张表永远空着 —— 看起来像统计坏了，
实际是分类没分干净。

因此工作口径只保留「分类明确不是非工作」的事项：
  category 为空 或 category === '工作'  → 纳入（不猜，未标注不给结论）
  category 为 探索沉淀 / 生活 / 运动 / 休闲 / 成长 / 其他 → 剔除

⚠️ 两张表是**并排**关系，**不可相加**，也不可与 AI Usage 精确归属相加。
```

### 5.4 模型维度（V3.6）

```text
聚合键  config.ai.model_aliases 显式映射 → 去 provider 前缀 → 小写去分隔符
归属    一次 Conversation 的 Token/积分整体记给记录里的**主模型**
        （`models[]` 里其它模型只作线索，不按比例拆分 —— 拆分会变成估算）
指标    会话数 / 请求数 / Token（输入·输出·缓存·推理）/ 占比 /
        缓存命中率 / 平均单请求 Token / 平均单会话 Token / 积分
```

```text
· 缓存命中率 = 缓存读 Token ÷ 总 Token；任一不可获取 → null（不是 0%）
· 积分：`score_source = not_applicable` 的会话**不计入**分数会话数，
  展示时留空，不写 0（0 表示「真实观察到零消耗」，语义不同）
· 模型会话数合计 = Conversation 总数（每会话只归一个模型，不会重复计数）
```

### 5.5 占比（`*_share`）

```text
share = 该取值 Token / 会话总 Token × 100
```

```text
· 分子或分母任一不可获取（null）→ 占比也是 null，**不是 0%**
· 分母为 0 → null（不是 0%）
· 各占比之和 ≤ 100%（未关联与有歧义的部分没有归属对象）
```

---

## 6. 归因覆盖率（诊断必给）

任何成本报表都要能回答「为什么这些数字是 null」：

```text
归因覆盖率：75 条事项中 0 条带 conversation_id（区间内会话 43 个）
        —— 未关联的 Token/积分记 null，不摊派、不估算。
        其中 75 条无会话证据（人工记录 / 历史批量导入），0 条会话尚未结算。
```

```json
{
  "attribution_coverage": {
    "activities": 75,
    "with_conversation": 0,
    "conversations": 43,
    "no_session_evidence": 75,
    "session_not_settled": 0
  }
}
```

覆盖率低时，先**分清是哪一类空**，再决定动作 —— 三类空的处置完全不同：

| 情形 | 判据 | 该做什么 |
|---|---|---|
| ① 无会话证据 | 事项没有 `session_id`，或 `project_id` 在宿主里就是 `null` | **无事可做**。人工记录与历史导入本就无对话可挂，如实呈现即可 |
| ② 会话尚未结算 | 事项有 `session_id`，但 Conversation Log 里暂时查不到 | 执行 `settle-conversation.js --relink`（结算本身也会自动回链） |
| ③ 会话已不存在 | 有 `session_id`，日志里也查不到（超出保留范围 / 已清理） | 保持 `null`，说明原因 |

```text
✗ 覆盖率低就改用估算 —— 绝对禁止
✗ 用「同一天 / 同项目 / 时间重叠」去补关联 —— 那是推断，不是记录
✓ 覆盖率低就把「为什么低」讲清楚，并给出可执行的改进动作
```

### 6.1 什么会让覆盖率变高（写入侧的三个要点）

覆盖率不是一个统计口径问题，而是**写入链路有没有把证据带到底**的问题：

```text
1. Conversation.project 要真的解析出来
   （project_id → config.project_map / 空间项目缓存）
2. WorkItem 必须带 session_id
   （Hook 队列里本来就有，回写时不能丢）
3. Work Activity 必须保留 session_id 这个证据
   （这样「事项先导出、会话后结算」也能在结算后自动回链）
```

> 这三条曾经**全部缺失** —— 症状就是本页示例里的两个 `null`
> （`project` 与 `conversation_id` 全空）。修复记录见 `references/changelog.md` V3.4。

---

## 7. 输出契约

### 7.1 JSON（供 AI 组织语言 / 供下游消费）

```text
cost
├── total_token / total_score             会话级合计（任一不可获取 → null）
├── token_known_conversations             有 Token 的会话数
├── token_unknown_conversations           不可获取的会话数
├── score_known_conversations / score_unknown_conversations
├── score_not_applicable_conversations   API 等不产生积分的会话
├── share_basis { token, score }          占比分母（标量或 null）
├── skill                                 见 §4
│   ├── conversation_count_with_skill
│   └── conversation_count_without_skill
├── conversation_projects[]               Conversation 项目 AI 使用（范围口径）
├── by_work_type[] / by_work_type_ambiguous[]
├── by_project[] / by_project_ambiguous[]
├── by_project_stage[] / by_project_stage_ambiguous[]
├── project_stages[]                      项目 × 阶段嵌套
├── project_stage_ambiguous[]
├── by_work_type_work[] / by_project_work[] / by_project_stage_work[]
│                                        工作口径（V3.6，见 §5.3）
├── by_*_work_ambiguous[]                 工作口径的歧义会话
├── project_stages_work[]                 项目 × 阶段（工作口径）
├── attribution_coverage                  见 §6
├── attribution_rule                      规则原文（供读者核对）
└── notes[]                               口径提示（Token/Score 独立等）
```

> `models{ rows[], raw_name_count, rule }` 挂在**顶层 metrics**（与 `cost` 平级），
> 不放在 `cost` 里 —— 它不是成本口径，而是「模型使用对比」，见 §5.4。

### 7.2 文本

- 数值可用 `toLocaleString('en-US')` 千分位；不可获取统一显示为「不可获取」
- **不可获取时不写括注** —— 禁止出现「Token 不可获取（不可获取）」这类零信息量输出
- 占比不可获取时不写「（不可获取）」括注，直接省略括号
- 项目 AI 使用表中的 Credit 若为 `not_applicable` 或不可获取，**显示为空**
- Skill 分布必须同时展示有 Skill 的 Conversation 与未记录 Skill 的 Conversation 数

---

## 8. Score 的三条额外事实

```text
① Score 只在**适用积分的 Agent 请求**中可能形成下界：
   用 score_request_count / score_applicable_requests 披露，不把 API 请求算作缺口
② 走模型 API 的对话**不消耗积分** → 记 0 + score_source=not_applicable
   项目 AI 使用表中直接留空，不显示「不可获取」
③ Token 与 Score **不得建立换算关系**，也不得互相推算
```

---

## 9. 相关文档

| 文档 | 内容 |
|---|---|
| `references/data-schema.md` | 结构化日志字段字典（含 Segment / AI Usage / `category` / `project_stage` / `output`） |
| `references/settlement.md` | Token/Score 的写入时机与幂等、Skill Usage 的识别 |
| `references/config-reference.md` | `settlement.skill_token_method` / `token_per_char` / `work.*` |
| `references/daily-summary.md` | 这些数字在日报 / 周报 / 月报里如何呈现 |
