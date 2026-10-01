# 对话结算与结构化日志

> 本文档定义核心机制：**对话结束即结算**，以及 Conversation / Skill Usage /
> Work Segment / Work Activity / AI Usage 互相独立的日志。
>
> **字段定义不在这里** —— 完整字段字典见 `references/data-schema.md`。
> 本文档只讲**机制**：结算流程、幂等、Token 口径、异常处理、重新解析。

---

## 1. 一句话原则

> **Agent 对话结束后立即结算该次对话，把 Conversation、Skill、Token、WorkBuddy 积分
> 写入结构化日志；每日复盘只读取已生成的结构化日志做汇总，不再重新扫描历史对话。**

```text
✗ 旧做法：对话 →（什么都不做）→ 22:00 复盘时翻历史对话 → 重新解析 Skill / 重算 Token / 重算 Score
✓ 新做法：对话 → 立即结算并落盘 → 22:00 复盘只做 sum / group / join
```

为什么必须改：重新解析会**重复计费**（每次都要把整段对话读进模型）、**结果漂移**
（同一份数据两次解析可能得到不同数字）、**无法对账**（复盘口径一变就对不上）。

---

## 2. 结构化日志的职责边界

| 日志 | 回答的问题 | 业务键 | 一个对话对应几条 |
|---|---|---|---|
| **Conversation Log** | 这次对话花了多少 token / 积分？用的什么 Agent 和模型？ | `conversation_id` | **1 条** |
| **Turn Log** | 一次用户请求对应的 Agent 工作用了多少 Token？ | `turn_id` | **0 ~ N 条** |
| **Skill Usage Log** | 这次对话用了哪些 Skill？各载入多少、什么版本？ | `usage_id`（优先 `skill_invocation_id`） | **N 条**（每个 Skill 调用一条） |
| **Work Segment Log** | 这次对话内部有哪些连续主题？ | `segment_id` | 0 ~ N 条 |
| **Work Activity Log** | 这次对话（或人工）产出了哪些工作事项？ | `activity_id` | 0 ~ N 条 |
| **AI Usage Log** | 哪些精确可得的 Token / Credit 属于哪个 Segment / Activity？ | `ai_usage_id` | 0 ~ N 条 |

```text
Conversation CON001
     ├── SU001 requirements-analysis
     ├── SU002 prototype-design
     ├── SU003 work-time-tracking
     ├── SEG001 GPU 调度方案设计
     ├── ACT001
     ├── ACT002
     ├── ACT003
     └── AUS001 → ACT001
```

**职责必须分开**：一个日志里混装多类数据会导致「查 Skill 用法要连带解析 Token」，
也会让「某些对话没有 Skill 调用」这种常态变成异常。

---

## 3. 目录结构

在原有日志目录下**新增** `structured/`、`raw/`、`summaries/`，不动 `current.json` 等既有结构：

```text
<log_dir>/
├── current.json                    ← 既有：WorkItem 原始记录（不变）
├── pending/  archive/  state.json  ← 既有（不变）
├── config.json  .log-manifest.json ← 既有（config 新增 settlement 段）
│
├── structured/                     ← V3.0 新增
│   ├── conversations/2026-09-21.jsonl
│   ├── turns/2026-09-21.jsonl
│   ├── skill-usage/2026-09-21.jsonl
│   ├── work-segments/2026-09-21.jsonl
│   ├── work-activities/2026-09-21.jsonl
│   └── ai-usage/2026-09-21.jsonl
│
├── raw/<source>/<日期>/<session_id>.json    ← workbuddy / codex 原始快照，支持重新解析（§16）
└── summaries/2026-09-21.md                  ← 每日总结的可带走的 Markdown 副本
```

**为什么用 JSONL**：日志是追加型数据，逐行独立 —— 一行损坏不影响其余行，追加成本 O(1)。
**为什么保留 `current.json`**：WorkItem 是同步到滴答清单的单位（§31），其结构与语义未变，
不因本次架构调整而重构（用户 §13 明确要求不强制重构稳定结构）。

---

## 4. 幂等与防重复（用户 §15）

### 4.1 机制：确定性业务键 + 按键替换

```text
conversation_id = CON-<YYYYMMDD>-<sha1(session_id) 前 8 位>
usage_id        = SU-<YYYYMMDD>-<sha1(skill_invocation_id 或 conversation_id|skill_id|version|序号) 前 10 位>
turn_id         = TURN-<YYYYMMDD>-<sha1(provider_turn_id 或 conversation_id|turn|序号|开始时间) 前 10 位>
activity_id     = ACT-<YYYYMMDD>-<sha1(conversation_id|content|start_time) 前 10 位>
```

ID **由内容派生而非随机** —— 同一次对话结算一百次也得到同一个 ID。
这是「按键替换」能生效的前提；随机 ID 会让每次重跑都新增一条。

### 4.2 三条硬保证

| 保证 | 实现方式 |
|---|---|
| 不产生重复 Conversation Log | 以 `conversation_id` 为键 upsert |
| 不重复增加 Token / Score | 存**绝对值**不是增量；覆盖写，不是 `+=` |
| 不重复创建 Skill Usage | 优先 `skill_invocation_id`；缺失时用 `conversation_id + skill_id + skill_version + 序号` |

> **为什么用「绝对值 + 按键替换」而不是「先查重再追加」**：
> 查重是「读—判断—写」三步，中间有竞态窗口；按绝对值覆盖则是幂等的天然形态 ——
> 无论跑几次，结果都是同一份数据。

### 4.3 无变化不写盘

合并后与旧记录**完全一致时不写文件**（连 `updated_at` 都不动），结算报告里体现为：

```json
{ "conversation": {"created":0,"updated":0,"unchanged":1},
  "skill_usage":  {"created":0,"updated":0,"unchanged":3} }
```

`created` 全为 0 ⇒ 这次是重复处理，**没有产生任何新数据**。
`--dry-run` 之外，可以用这个信号直接验收幂等性。

### 4.4 合并语义

```text
有效值（数值/字符串）  → 覆盖旧值
空值 null             → **不覆盖**已有的有效值
完全无变化            → 原样返回，刷新都不刷新
```

哨兵不覆盖有效值这一条很重要：否则一次失败的解析会把此前成功拿到的 Token
覆盖成空值，变成「越修越差」。

---

## 5. Conversation Log

```json
{
  "conversation_id": "CON-20260920-CB62725D",
  "agent": "craft",
  "model_name": "custom-local:deepseek-v4-flash",
  "models": ["Deepseek-V4.1-Flash", "GLM-5.3-Flash"],
  "start_time": "2026-09-20T10:24:52+08:00",
  "end_time": "2026-09-20T19:00:04+08:00",
  "duration_seconds": 30900,
  "status": "completed",
  "settlement_status": "settled",
  "settled_at": "2026-09-21T17:07:38+08:00",
  "total_token": 23087410,
  "input_token": 23031736,
  "output_token": 55674,
  "cached_token": 14078656,
  "reasoning_token": 35183,
  "usage_score": 249.46,
  "score_source": "workbuddy_credit",
  "score_request_count": 21,
  "source": "workbuddy",
  "session_id": "e294d0bf-727a-49c2-b0bd-1dac6ed8d8e3",
  "project": null,
  "workspace": "C:\\Users\\User\\WorkBuddy\\2026-09-20-10-24-52",
  "title": "基于文档创建工作时间记录 Skill",
  "turn_count": null,
  "request_count": 47,
  "skill_count": 3,
  "skill_invocation_count": 3,
  "distinct_skill_count": 2,
  "missing_fields": [],
  "raw_ref": null,
  "parser_version": "3.0.0",
  "created_at": "2026-09-21T17:07:38+08:00",
  "updated_at": "2026-09-21T17:07:38+08:00"
}
```

### 5.1 字段来源（全部由脚本解析，不经 LLM）

| 字段 | 来源 | 可靠性 |
|---|---|---|
| `conversation_id` | 由 `session_id` 派生 | 确定性 |
| `session_id` | `workbuddy.db` → `sessions.id` / Hook 入参 | 确定性 |
| `agent` | 专家 `expert_runtime_identity`/`expert_id` → `sessions.mode` → `providerData.agent` | 确定性 |
| `model_name` | `sessions.model`；缺失时取请求级 `requestModelName` | 确定性 |
| `models` | 请求级 `requestModelName` 去重集合（一次对话可能换模型） | 确定性 |
| `start_time` / `end_time` | `sessions.created_at` / `last_activity_at`，并用 JSONL 时间戳**校正**（取更早/更晚） | 确定性 |
| `total_token` 等 | JSONL 请求级 `providerData.usage`，**按 `conversationRequestId` 去重后求和** | 确定性 |
| `total_score` | `session_usage.credit_json` 求和 | 确定性，但**仅覆盖部分请求 → 是下界** |
| `source` | 固定 `workbuddy`（其他宿主见 §9） | — |

### 5.2 ⚠️ 两个必须记住的口径事实

1. **同一 API 请求会拆成多条记录**（reasoning / function_call ×N / message）。
   必须按 `providerData.conversationRequestId` 去重，否则 token 被重复累加数倍。
2. **`session_usage.used/size`（如 54827/1000000）是上下文窗口占用，不是计费 token。**
   `total_token` 一律来自 JSONL 的请求级 usage，**不得**用 `used` 顶替。

### 5.3 `total_score` 是下界

实测 WorkBuddy 积分类 Agent 只为**部分适用请求**落 credit 记录
（某次对话 47 次请求中仅 21 次有积分）；API 请求不进入积分适用口径。
因此：

```text
usage_score           = Σ credit（仅有记录的请求）
score_request_count   = 有积分记录的请求数
⚠ 当 score_request_count < request_count 时，usage_score 是**下界**，不是完整账单
```

汇总时（`metrics-engine`）会显式提示 `仅为下界：21/47 次请求有积分记录`，
**不得**把它当作完整消耗对外汇报。

### 5.4 Token 与 Score 是**独立指标**

```text
Conversation Token：23087410
WorkBuddy Score   ：249.46
```

**禁止**建立 `1 Score = N Token` 之类的换算关系（用户 §7）。
实测 credit 与 token **非线性**：同一模型档位下 input 相近而 credit 可差 1.8 倍
（含模型档位差异与可能的附加计费）—— 任何线性折算都会算错。

### 5.5 Turn Log（V3.26）

Turn 表示一次用户请求及其后续全部 Agent 工作。一个 Turn 可以包含多条消息和
多次模型请求，因此不能用 message 代替 Turn。

Codex 解析口径：

```text
provider_turn_id  ← token_usage_record.turn_id
total_token       ← 最后一个 token_usage_record.turn_token_usage.total_tokens
request_ids       ← 该 turn_id 下去重后的 response_id
status            ← task_started / task_complete；后续 Turn 已开始时前轮视为 completed
```

约束：

```text
✓ turn_token_usage 是绝对值，按 turn_id 覆盖写入
✓ Turn 总量可以用于展示每轮消耗
✗ 不得把 Turn 总量按 Skill 数摊派
✗ 不得把 Turn 总量与 Conversation 总量相加
```

---

## 6. Skill Usage Log

```json
{
  "usage_id": "SU-20260920-E43DCF2007",
  "conversation_id": "CON-20260920-CB62725D",
  "skill_id": "work-time-tracking",
  "skill_name": "work-time-tracking",
  "skill_version": "2.1",
  "start_time": "2026-09-20T10:25:04+08:00",
  "end_time": "2026-09-20T10:25:05+08:00",
  "skill_token": 4017,
  "token_source": "injection",
  "call_request_id": "50093ccfbc5f4f2e8add50e34ecfc0e5",
  "call_request_total_token": 37519,
  "load_chars": 14347,
  "args": null,
  "status": "completed",
  "source": "workbuddy",
  "skill_invocation_id": "call_01_4eGvX30r47hl3erCevAH5994",
  "created_at": "2026-09-21T17:07:38+08:00",
  "updated_at": "2026-09-21T17:07:38+08:00"
}
```

### 6.1 Skill 调用如何识别（确定性）

```text
JSONL 中 type = "function_call" 且 name = "Skill"
  ├── arguments = {"skill": "<skill_id>", "args": "..."}      → skill_id
  ├── callId                                                  → skill_invocation_id
  └── 同 callId 的 function_call_result.output.text           → load_chars（≈ SKILL.md 全文）
        └── 该文本以 "Error" 开头 ⇒ status = failed（未成功载入，不产生注入）
```

`skill_version` 解析顺序：`SKILL.md` frontmatter 的 `version:` → 标题里的 `Vx.y` 标记 →
插件缓存内的 `SKILL.md`；**都取不到写 `null`**（`strOrNull()`），**不猜版本号**。

### 6.1b Codex 侧如何识别（V3.22）

Codex **没有** Skill 工具调用，因此改用「证据」判定，并写进 `evidence` 字段：

```text
① explicit_invocation —— 用户输入里的显式引用（`$skill-name` / `skills/<name>/SKILL.md`）
                         trigger_type = user
② skill_md_loaded     —— 本会话的工具调用参数命中 `<...>/skills/<id>/SKILL.md`
                         trigger_type = agent（模型真的载入了技能定义）
```

```text
✗ 不扫整份 rollout —— 每轮请求都注入技能目录（本机 25 条），全文扫描必然假阳性
✗ 不认技能目录下的其它文件 —— `skills/<name>/scripts/x.js` 是开发/排查，不是使用
✗ apply_patch 不计入 —— 改技能源码 ≠ 使用技能
✓ 参数是 JSON 字符串，路径里的 `\` 是双写的（`skills\\name\\SKILL.md`）⇒ 分隔符用 `[\\/]+`
✓ 一次载入 = 一条记录（同一行同技能只算一次）；ordinal 参与 usage_id ⇒ 重放幂等
```

**Codex 侧的 `load_chars` 仍为 `null`**：rollout 里的工具输出可能被宿主截断，
拿截断长度当载入体积属于失真观测，宁可不写（`token_source: 'unavailable'`）。

> ⚠️ 这里曾写作「写 `unavailable`」—— 那是 V3.0 的字符串哨兵口径。
> V3.1 起**取不到的值一律写 `null`**；`'unavailable'` 只允许出现在
> `token_source` / `score_source` 这类**标签字段**里（它们的合法值本来就含它）。
> 代码为准：`normalizeSkillUsage()` 中 `skill_version: strOrNull(r.skill_version)`。

### 6.2 Skill Token 的三种口径（关键）

WorkBuddy **没有官方 Skill 级 token 口径**。本技能只承认以下两种，且严格区分：

| 口径 | 字段 | 含义 | 能否跨 Skill 相加 |
|---|---|---|---|
| **A 载入体积**（默认） | `skill_token` + `token_source: "injection"` | 该 Skill 调用时**新增推入上下文**的内容量 = 工具返回字符数 × `token_per_char` | **可以**（每个 Skill 独立的一次性注入） |
| — 取不到 | `skill_token: null`（`token_source: "unavailable"`） | 载入失败、或 `skill_token_method: "off"` | — |
| **B 所在请求** | `call_request_total_token` | 该调用**所在那一次请求**的 usage | **不可以**：含全部历史上下文，同请求内多个 Skill 会重复计入 |

```text
Conversation Total Token = 23087410
  Skill A（injection） = 4017     ← 可精确归因
  Skill B（injection） = 1827     ← 可精确归因
  Skill C（failed）    = null
  Σ(A,B) = 5844                   ← 合法：只是说明「Skill 载入共占 5844 token」
```

**严禁**（用户 §6）：

```text
✗ total_token ÷ Skill 数量        = 23087410 ÷ 3
✗ 按调用次数摊派
✗ 按字符占比反推「独占 token」
✗ 把 call_request_total_token 当 skill_token 求和
```

这些都不是观测值而是编造。取不到就写 `null` —— **`null` 是可接受的结果，
编造不是。**

> **本节只讲「怎么记录」；「怎么统计与归因」见 `references/cost-statistics.md`**
> —— 那里定义了四个归因维度（Skill / 工作类型 / 项目 / 项目阶段）、
> 占比、歧义判定，以及**为什么 Skill 级积分恒为 `null`**。
> 一句话：**Skill 级积分的缺失不是缺陷，是事实** —— 宿主只提供会话级 credit，
> 任何「按比例摊给 Skill」的做法都被本技能视为违规。

> **`token_per_char` 默认 0.28**（实测值，见 `references/security.md` 同源测量）。
> 它是**换算系数**而非估算替代：被测量的是「实际注入的字符数」这一真实观测量。
> 若用户只认可官方口径，把 `settlement.skill_token_method` 设为 `off`，
> 则所有 `skill_token` 一律 `null`（`token_source: "unavailable"`）。

### 6.3 一个对话多个 Skill

每个 Skill 调用**独立一条记录**，`conversation_id` 相同、`usage_id` 不同。
同一 Skill 在一次对话里调用两次 ⇒ 两条记录（`ordinal` 区分）——
这是正确的：**两次调用 = 两次注入**。

---

## 7. Work Activity Log

```json
{
  "activity_id": "ACT-20260920-9308E8FC74",
  "date": "2026-09-20",
  "project": "中大气象",
  "work_type": "需求分析",
  "content": "邮件服务开关与接收邮箱配置逻辑",
  "display_content": "【中大气象】【需求分析】邮件服务开关与接收邮箱配置逻辑",
  "start_time": "12:41",
  "end_time": "13:30",
  "source": "agent",
  "conversation_id": "CON-20260920-CB62725D",
  "status": "completed",
  "confidence": "high",
  "work_item_id": "WI-20260920-A8F2C1D3",
  "created_at": "2026-09-21T17:07:38+08:00",
  "updated_at": "2026-09-21T17:07:38+08:00"
}
```

### 7.1 不依赖 Conversation

| `source` | 含义 | `conversation_id` |
|---|---|---|
| `agent` | 由 Agent 对话产生 | 有（指向对应 Conversation） |
| `manual` | 用户自己完成并记录 | **`null` 合法** |
| `imported` | 从外部导入 | 通常为 `null` |
| `system` | 宿主机系统产生 | 通常为 `null` |

**不得强制所有 Work Activity 都存在 `conversation_id`**（用户 §11）。
人工工作天然没有对话 —— 把 `null` 当异常处理会直接丢掉一半真实工作量。

### 7.2 格式与既有规则一致

沿用统一格式（不因本次调整而改变）：

```text
有项目：【项目名称】【工作类型】事项内容        ← 注意：Activity 用「工作类型」
        或【项目名称】【功能/模块名称】事项内容  ← 总结层按模块提炼后的展示
无项目：【工作类型】事项内容
```

`display_content` 由 `buildDisplayContent()` 重算，与 WorkItem 同一套规则（§8/§28）。

### 7.3 来源与写入方式

| 写入方式 | 命令 | 结果 |
|---|---|---|
| LLM/Agent 判定后写回（**主路径**） | `settle-conversation.js --session <id> --activities-file acts.json` | `source: agent`，关联本次对话 |
| 单条手工补录 | `--activity "项目\|类型\|内容\|开始\|结束"` | `source: agent`（可改） |
| 用户输入兜底（**候选，默认关闭**） | `--activities prompts` | `source: agent`、`confidence: low`、`status: needs_confirmation` |
| Hook 队列 → WorkItem 导出 | `collect-activity.js apply` → `export-work-activities.js` | `source: agent`，`session_id` 作证据；`conversation_id` 按证据查得（见 §7.4） |

> **为什么默认关闭 `prompts` 模式**：识别「哪句用户输入构成了一个工作事项」属于
> 语义判断，是 LLM 的职责（用户 §8）。脚本只提供确定性兜底，且明确标记为**候选**，
> 不冒充已确认的工作事项。

### 7.4 第 4 条写入路径：`session_id` 证据与回链（V3.4）

Hook 采集的事项走的是「WorkItem → 导出」这条路，与 `--activities-file` 不同源。
这条路曾经在「批量判定回写」处丢掉 `session_id`，导致导出的 Activity
`conversation_id` 恒为 `null`（真实事故）。现在的规则是：

```text
队列 pending_items（含 session_id）
   ↓ collect-activity.js apply        ← 证据在这一步必须写进 WorkItem
WorkItem（session_id / project_id）
   ↓ export-work-activities.js         ← 用 session_id 去 Conversation Log **查**
Work Activity（session_id 留档 + conversation_id 填上或 null）
```

**为什么是「查」而不是「按日期算 ID」**：`conversation_id` 的派生式里含日期
（`CON-<YYYYMMDD>-<hash>`），而这个日期是**会话归档日**，未必等于**事项发生日**
（会话可跨天存活）。按事项日期去算会造出一个日志里根本不存在的 ID —— 那不是关联。

**时序自愈**：事项常先导出、会话后结算。因此

```text
settle-conversation.js         结算完成后自动回链本次会话（--no-relink 可关）
settle-conversation.js --relink   单独回链历史数据（幂等，可反复执行）
```

回链只走证据：`session_id` 存在 **且** 该会话确实在 Conversation Log 里。
查不到就保持 `null`，并在报告里分成 `no_evidence`（无证据）与
`unresolved`（会话还不存在）两个计数 —— **不推断、不按时间/项目名凑**。

### 7.5 V3.5：Work Segment 与 AI Usage

对话结算可额外接收：

```bash
--segments-file segments.json
--activities-file activities.json
--ai-usage-file ai-usage.json
```

`activities.json` 可以用 `segment_index` 引用本批 Segment；
`ai-usage.json` 可以用 `segment_index` / `activity_index` 引用本批对象。
结算时先归一化，再转换为稳定的 `segment_id` / `activity_id`。

写入顺序：

```text
Conversation
  → Turn
  → Skill Usage
  → Work Segment
  → Work Activity
  → AI Usage
  → 回链
```

校验不通过时整次不写入，避免只落了一半：

```text
目标 ID 必须在本会话或已有日志中存在
unallocated 不得带目标 ID
exact / partial 必须有目标 ID
所有文本仍须经过 Security Filter
```

Conversation 的 `total_token` / `total_score` 保持总账；
AI Usage 只累计明确给出的值，剩余部分在汇总中保持 `unallocated`。

---

## 8. 异常处理（用户 §16）

**解析部分失败时不得丢弃整条记录。**

```yaml
# Score 拿不到，其余都成功
conversation_id: CON001
model_name: xxx
total_token: 10000
total_score: null            # 取不到就写 null，不写 0、不写 'unavailable' 字符串
score_source: unavailable    # 标签说明「为什么拿不到」
settlement_status: partial
missing_fields: ["total_score"]
```

```text
status: settled        全部关键字段解析成功
status: partial        部分字段失败（缺失项见 missing_fields）—— 记录照常写入
status: parse_failed   会话文件 / 数据库都读不到 —— 仍写入 conversation_id 与原始痕迹
```

### 重新解析

原始快照落在 `raw/<source>/<日期>/<session_id>.json`（含请求级 usage 明细、
Skill 调用、会话行、credit 映射、`source_files`）。因此：

```bash
# 补算某天（原始 JSONL 仍在，可重新解析）
node scripts/settle-conversation.js --backfill --since 2026-09-21 --until 2026-09-21
```

补算是**按键替换**：修正后的值覆盖旧值，不会产生第二条记录、不会重复累加。

---

## 9. 多 Agent / 多工具（用户 §24）

统一的抽象层，**不把 WorkBuddy 的字段设计成整个 Skill 的唯一模型**：

```yaml
source:        workbuddy | codex | other
agent:         craft / expert:<id> / ...      # 该工具实际的 Agent 标识
model_name:    ...
conversation_id: ...
total_token:   ...
total_score:   ...        # WorkBuddy 独有；其他工具填 null
```

| 工具 | Token | Score | Skill Token | Skill 识别 |
|---|---|---|---|---|
| WorkBuddy | ✅ 请求级精确 | ✅ `credit_json` 求和（下界） | ✅ injection 口径 | ✅ `function_call[name=Skill]` |
| Codex | ✅ rollout `thread_token_usage` | ✅ `0` + `score_source=not_applicable`（API 不产生 Credit） | ❌ 当前 rollout 无可归因载入体积 | ❌ 当前 rollout 不提供 Skill 调用清单 |

**不得为了兼容其他工具而降低 WorkBuddy 已具备的数据精度** ——
WorkBuddy 走 `parsers/workbuddy` 的精解析路径，其他工具走降级路径，字段形状一致。

### 9.1 Codex rollout 的解析口径

```text
会话单位：一个 state_5.sqlite.threads.id = 一个 Conversation（不是每个 rollout 文件一条）
主分片：threads.rollout_path；不可读时回退到最新的 thread_source=user 分片
历史前缀：主分片的 history_base.end_ordinal_exclusive 之前的用户分片
用户输入：合并历史前缀与主分片，按 ordinal + 文本去重，剥离宿主注入块
重复回放：不进入主分片历史链的用户分片忽略，不得重复记录问题或 Token
Token：主分片最后一条 thread_token_usage；缺失时回退 threads.tokens_used
Turn：按 token_usage_record.turn_id 归并；每个 Turn 取最后一次 turn_token_usage
Skill 关联：显式引用与 SKILL.md 载入事件按时间映射到 Turn，并写 turn_id / event_ordinal
请求数：历史前缀 + 主分片中的 response_id 去重计数
起止时间：最早用户分片时间 → 主分片最后一条 rollout 时间戳
任务状态：主分片最后一条 task_started / task_complete；archived 线程映射为 archived
模型：threads.model；取不到写 null
Score：Codex 走 API 通道，不产生 Credit；写 0 + score_source=not_applicable
Skill Usage：当前 rollout 不提供可归因的 Skill 载入体积，不写估算记录
内部子线程：thread_source != user（如 guardian_review）隔离，
            不作为用户问答；需要统计时只能另列内部开销，不得混入用户 Conversation 总账
```

Codex Hook 与 Codex 任务共用沙箱。**日志目录必须在该任务的可写根内**，
否则 Hook 会触发但写入被拒绝。Codex Desktop 的 per-thread managed sandbox
优先于全局 `[sandbox_workspace_write]`，需要在任务权限里显式加入日志目录。

---

## 10. 每日复盘的新职责（用户 §17-§19）

```text
每日复盘**不负责**计算 Conversation Token / Skill Token / WorkBuddy Score。
这些在每次对话结束时已经结算完毕。
```

复盘只做四件事：

```text
读取 logs/*.jsonl
读取 logs/*.jsonl
读取 logs/*.jsonl
→ 汇总（sum / group / join）
```

### 10.1 必须产出的统计

**工作情况**：工作事项数量、项目分布、工作类型分布、Agent 工作事项、人工工作事项、未完成事项
**Agent 使用**：Conversation 数量、Total Token、WorkBuddy Score、Agent 分布、Model 分布
**Skill 使用**：Skill 使用次数、Skill Token、Skill 分布、Skill 对应项目/工作事项

### 10.2 禁止行为

```text
✗ 重新扫描历史 Conversation
✗ 重新解析 Skill
✗ 重新计算 Token / 重新计算 Score
✗ 用 LLM 估算 Token
```

实现上由 `lib/metrics-engine.js` 保证：它**只有** `CS.read(dir, kind, date)` 这一种数据来源，
物理上无法读到历史对话。

---

## 11. 关联链（用户 §20）

```text
项目 → 工作事项 → Conversation → Skill → Token / Score
```

```text
【异构算力平台】
  ↓
【需求分析】完善GPU细粒度调度
  ↓
Conversation CON001
  ↓
requirements-analysis
  ↓
2300 Token
```

### 关联铁律

1. **只在有显式关联时才生成**：以 Work Activity 上非空的 `conversation_id` 为唯一连接依据。
2. **没有关联就不推断**：`manual` 来源的事项天然没有 Conversation，
   其工作量**只按事项计**，不摊任何对话的 Token。
3. **归属有歧义时归入 `ambiguous`**：一个对话若被两个项目的工作事项共同引用，
   其 Token/Score **不计入任何一个项目的合计**，只做提示。
4. **`conversation_id` 只能由证据「查」出来**（V3.4）：`session_id` 是该事项
   属于哪个会话的证据，用它到 Conversation Log 里查；查不到就是 `null`。
   **禁止**按日期派生 ID、按时间重叠或同项目去凑关联。

```text
⚠ 归属有歧义（未计入任何项目合计）：
  - 【项目A】CON001、CON002：这些对话同时关联多个项目的工作事项，
    Token/Score 无法归属到单一项目，因此不计入任何项目的合计（§20 不推断）。
```

4. **同一对话只计一次**：多个工作事项共享一个 Conversation 时，
   该 Conversation 的 Token 只在项目合计里出现一次。

---

## 12. 周期性分析（用户 §21）

保留 7 天 / 30 天能力，且**只能基于结构化日志**：

```bash
node scripts/daily-summary.js metrics --dir <log_dir> --date <date>
```

可统计：工作事项趋势、项目工作量趋势、Agent 使用趋势、Model 使用趋势、
Token 消耗趋势、Score 消耗趋势、Skill 使用趋势、Skill Token 趋势。

> ⚠ **本机当前只保留当天结构化日志**（`settlement.retain_days = 0`，与
> `log.keep_days = 1` 的既有约定一致）。要跑 7/30 天趋势，需先把
> `retain_days` 调大 —— **不要**为了让趋势图好看而去重扫历史对话
> （那正是本次架构要消灭的做法）。
>
> 历史结构化日志的**远端留存不属于本技能**：本技能不做 git / GitHub 同步
> （2026-09-21 用户明确），远端备份计划交由独立的 GitHub 同步 Skill 负责。

---

## 13. 自动化任务拆分（结算视角）

结算**只在任务1 里发生**，且必须与另两个任务隔离：

```text
任务1：Conversation End Handler  →  本文档描述的结算（实时、零 token）
任务2：GitHub Sync               →  归档出口，不是数据源
任务3：Daily Summary             →  只读汇总，不重算 Token / Score
```

```text
✗ 任务1 绝不能等到复盘才跑
✗ 任务3 绝不能重新解析原始对话
✗ 任务2 绝不能成为复盘的数据源
✗ 任一任务失败都不得影响其他两个，尤其不得删除本地日志
```

> **完整的宿主侧触发配置（Hook 写法、事件映射、现状核对、`Hook timed out` 排查）
> 见 `references/automation.md`。** 本技能**不创建任何 Hook 或定时任务**
> —— 那由用户在宿主侧配置。

**结算本身的时延**：Node 解析 47 次请求的会话实测约 1 秒内完成；
**超大会话**（十 MB 级 JSONL）可能接近 Hook 超时。若 `Stop` 频繁超时，
改用宿主**定时任务**每分钟跑一次 `--latest --limit 3 --quiet --exit-zero`，
**不要**加大 Hook 超时（超时被强杀可能留下陈旧锁）。

---

## 14. Skill 不是后台服务

`work-time-tracking` **本身不负责**：后台监听、常驻运行、自动监听 Conversation End。
这些能力**必须由宿主提供**。Skill 只负责定义：

```text
数据结构 · 处理规则 · 记录规范 · 复盘规则 · 分析规则
```

```text
安装 Skill ≠ Skill 开始后台自动运行
```

详见 `references/automation.md` §1。

---

## 15. 命令总览

```bash
# ── 任务1：对话结束结算（实时） ─────────────────────────────
node scripts/settle-conversation.js --session <sessionId>
node scripts/settle-conversation.js --latest
node scripts/settle-conversation.js --session <id> --dry-run          # 只看，不写
node scripts/settle-conversation.js --session <id> --activities prompts
node scripts/settle-conversation.js --session <id> --activity "项目|类型|内容|09:00|10:30"
node scripts/settle-conversation.js --session <id> --activities-file acts.json
node scripts/settle-conversation.js --session <id> --segments-file segs.json --ai-usage-file usage.json
node scripts/settle-conversation.js --backfill --since 2026-09-01 --until 2026-09-21
node scripts/settle-conversation.js --relink                        # 只补事项关联（历史修复）
node scripts/settle-conversation.js --relink --session <id> --dry-run
node scripts/settle-conversation.js --latest --quiet --exit-zero      # Hook 安全模式
node scripts/settle-conversation.js --codex-home <CODEX_HOME> --session <id>

# ── 任务3：每日复盘（只读汇总） ─────────────────────────────
node scripts/daily-summary.js metrics            # 只看 AI / Skill 汇总
node scripts/daily-summary.js material           # 总结素材（含 AI 汇总）
node scripts/daily-summary.js draft              # 十四节确定性草稿
node scripts/daily-summary.js save --text "…"    # 落盘 current.json.summary + summaries/<date>.md
```

---

## 16. 自检清单

```text
[ ] Conversation / Turn / Skill / Segment / Activity / AI Usage 六类日志职责独立
[ ] Turn 与 Conversation 分开记录；Turn 总 Token 为绝对值，不与会话总量相加
[ ] Conversation 记录 Agent / Model / Conversation ID / Total Token / WorkBuddy Score
[ ] Skill Usage 记录 Skill 版本 / Skill Token；支持一个 Conversation 多个 Skill
[ ] Skill Usage 可关联 Turn 与 event_ordinal；Skill Receipt 为只读派生视图
[ ] Work Activity 支持 agent 与 manual；manual 允许 conversation_id = null
[ ] Work Segment / AI Usage 可重复写入且幂等
[ ] AI Usage 只累加明确数值，unallocated 不按比例拆分
[ ] Conversation 的 project / project_id / project_source 已按项目归属解析（不是写死 null）
[ ] 事项的 session_id 从队列一路带到 Work Activity（关联证据不丢）
[ ] conversation_id 由证据「查」得；查不到为 null，并分得清 no_evidence / unresolved
[ ] 结算后自动回链；--relink 可单独补历史（幂等）
[ ] 对话结束后立即结算，不等待复盘
[ ] Token / Score / Skill 由脚本解析，不经 LLM
[ ] 重复处理不产生重复数据（created 全为 0）
[ ] 每日复盘只读结构化日志，不重新扫描历史对话
[ ] 禁止人为估算 Skill Token（不摊派、不按次数推算）
[ ] 区分 Conversation Token 与 Skill Token；区分 Token 与 Score
[ ] 部分失败记 partial 并保留可重新解析的原始数据
```

---

## 17. 相关文档

| 文档 | 内容 |
|---|---|
| `references/data-model.md` | 结构化日志的字段定义与文件职责 |
| `references/work-segments-and-usage.md` | Segment 与 Usage 的完整机制 |
| `references/trigger-adapters.md` | 触发机制与三个任务的宿主接法 |
| `references/security.md` | 采集边界、脱敏、外发路径 |
| `references/ticktick-sync-contract.md` | 与滴答清单的同步边界 |
