# 数据结构字典（结构化日志）

> **本文档是结构化日志字段的唯一定义处。**
> 存储机制与幂等规则见 `references/settlement.md`；完整数据模型（WorkItem / DailyLog / 并发）
> 见 `references/data-model.md`。
>
> 字段清单以 `scripts/lib/conversation-store.js` 的 `normalize*()` **实际写法为准** ——
> 若本文档与代码不一致，以代码为准并立即修正本文档。

---

## 0. 通用约定

| 约定 | 规则 |
|---|---|
| 存储格式 | **JSONL**：一行一条记录。坏行跳过并计入 `bad_lines`，不整份丢弃 |
| 存放位置 | `<log_dir>/logs/<YYYY-MM-DD>/<kind>.jsonl` |
| 写入方式 | 整文件**原子重写**（临时文件 → 回读校验 → `rename`） |
| 日期归属 | 只由记录**自身**的日期决定，**禁止**一次 upsert 跨多日 |
| 取不到的值 | 写 `null`，**不是** `0`、**不是** `'unavailable'` 字符串 |
| 取不到的说明 | 必须配 `*_source` / `settlement_status` 等**标签字段**说明原因 |
| 标签字段豁免 | `score_source` / `token_source` 的合法值本身含 `unavailable`，**不得**过空值归一化 |
| 时间格式 | 结构化日志内的时间戳为 **ISO 8601 带时区**；`Work Activity` 的 `start_time` / `end_time` 是 **`HH:MM` 纯时刻** |
| ID 派生 | 由**内容**派生（sha1），**不是随机数** —— 这是幂等的基石 |

```text
conversation_id = CON-<YYYYMMDD>-<sha1(session_id)[0:8] 大写>
usage_id        = SU-<YYYYMMDD>-<sha1(skill_invocation_id 或 conv|skill|version|ordinal)[0:10] 大写>
activity_id     = ACT-<YYYYMMDD>-<sha1(conversation_id|content|start_time)[0:10] 大写>
```

---

## 1. Conversation Log

**问的问题**：这次对话花了多少 Token / 积分？用的什么 Agent 和模型？
**业务键** `conversation_id` —— **一个对话 1 条**。
**文件** `logs/<date>/conversations.jsonl`

### ⚠️ 「Conversation」的定义（先对齐概念再看字段）

```text
Conversation = 一次**有连续上下文的 AI 会话**，不是「一问一答」的一条 Message。
```

| 概念 | 说明 | 是否本日志统计维度 |
|---|---|---|
| **Conversation** | 一次会话（一个 `session_id`）：从开始到结束，可含任意多轮往返、多个 Skill 调用 | ✅ **主统计单位** |
| **Message / 请求** | 会话内的一次往返（UserPromptSubmit → 回复） | 只作为明细量（`request_count`），**不是**主要统计维度 |
| **Work Activity** | 会话（或人工操作）**产出的工作事项** | ✅ 独立日志，0~N 条 |

因此：

```text
✗ 不要把「一次问答」当成一次 Conversation —— 会把 Token/积分切碎到无意义
✗ 不要用 Message 数当工作量 —— 工作量由 Work Activity 表达
✓ 结算发生在「Conversation 结束」，一次结算 = 一条 Conversation Log
```

> 一个 Conversation 可以有 0 条 Work Activity（纯咨询、纯查询），这是合法且常见的。

### 核心字段（用户要求保留的口径）

| 字段 | 类型 | 允许 null | 含义 |
|---|---|---|---|
| `conversation_id` | string | ✗ | 业务键，由 `session_id` 派生；同一次对话重复结算是**同一个** id |
| `agent` | string | ✓ | 产生该对话的宿主 Agent（如 `craft` / `cli`） |
| `model_name` | string | ✓ | 主模型名；一次对话换过模型时取主用那个，全集见 `models[]` |
| `start_time` | string(ISO) | ✓ | 对话开始时间 |
| `end_time` | string(ISO) | ✓ | 对话结束时间 |
| `duration_seconds` | number | ✓ | 由 `start_time` / `end_time` 派生；**缺任一端点为 `null`** |
| `total_token` | number | ✓ | 对话总 Token。**与 Score 独立，禁止换算** |
| `total_score` | number | ✓ | 积分类 Agent 产生的 Credit / 积分。API 等不计积分通道记 `0 + score_source=not_applicable`；有积分通道按 `score_request_count` 判断是否为下界 |
| `status` | string | ✗ | 对话**本身**在宿主侧的结果：`completed` / `working` / `archived` / `interrupted` / `unknown` |
| `settlement_status` | string | ✗ | **本次结算**的结果：`settled` / `partial` / `failed` |
| `settled_at` | string(ISO) | ✓ | 最近一次结算成功的时间；**内容无变化时不推进**（否则幂等无法自证） |
| `source` | string | ✓ | 数据来源标识（如 `workbuddy` / `codex`） |

### 明细字段（代码实际写入，供对账与复盘）

| 字段 | 类型 | 含义 |
|---|---|---|
| `input_token` / `output_token` | number | 输入 / 输出 Token 拆分 |
| `cached_token` / `reasoning_token` | number | 缓存命中 / 推理 Token 拆分 |
| `models` | string[] | 请求级模型**去重集合**（一次对话可能换模型） |
| `score_source` | string | **标签**：`workbuddy_credit` / `not_applicable` / `unavailable` |
| `score_request_count` | number | 有积分记录的请求数。仅对 `workbuddy_credit` 等积分适用通道判断；**`< 适用请求数` 时 `total_score` 是下界** |
| `turn_count` | number | 本会话的 Turn 数；V3.26 新增，旧记录可为 `null` |
| `request_count` | number | 该对话的请求总数 |
| `skill_count` | number | 兼容字段，含义等同于 `skill_invocation_count` |
| `skill_invocation_count` | number | Skill Usage Log 条数，即调用事件数 |
| `distinct_skill_count` | number | 按 `skill_id` 去重后的不同 Skill 数；旧记录可为 `null` |
| `missing_fields` | string[] | 解析失败的字段名，配合 `settlement_status: partial` |
| `session_id` | string | 宿主原始 session id（ID 派生的输入） |
| `project` | string | 空间项目**名称**。拿不到名称时为 `null`（**不用目录名顶替**） |
| `project_id` | string | 空间项目 id（`p_<hex>`）。**名称拿不到也要留下它** —— 后续 `project --sync` 可据此补名 |
| `project_source` | string | **标签**：`space_project` / `project_map` / `host_project` / `codex_project` / `codex_project_root` / `space_project_unmapped` / `codex_project_unmapped` / `cwd_unregistered` / `none`。说明 `project` 为何是现在这个值 |
| `project_confidence` | string | `high` / `medium` / `low`，或 `null` |
| `workspace` | string | 会话的工作目录（原始 `cwd`，只作线索，不参与项目判定） |
| `title` | string | 对话标题 |
| `raw_ref` | string | 原始快照路径（`raw/workbuddy/<date>/<session_id>.json`） |
| `parser_version` | string | 解析器版本，便于判断是否需要重新解析 |
| `created_at` / `updated_at` | string(ISO) | 首次写入 / 最近变更时间 |

---

## 2. Turn Log

**问的问题**：一次用户请求对应的 Agent 工作用了多少 Token？
**业务键** `turn_id`，一个 Conversation 可有 0~N 条。
**文件** `logs/<date>/turns.jsonl`

```text
Turn = 一次用户请求 + 后续全部 Agent 工作
       可包含多条 assistant 消息、多个 Item、多次模型请求
```

| 字段 | 类型 | 允许 null | 含义 |
|---|---|---|---|
| `turn_id` | string | ✗ | 业务键，优先由宿主原始 turn_id 派生 |
| `conversation_id` | string | ✗ | 所属 Conversation |
| `provider_turn_id` | string | ✓ | 宿主原始 turn_id，用于对账 |
| `date` | string | ✗ | 归属日期 |
| `ordinal` | number | ✗ | Conversation 内第几轮，从 0 开始 |
| `start_time` / `end_time` | string(ISO) | ✓ | Turn 起止时间 |
| `duration_seconds` | number | ✓ | 由起止时间派生 |
| `request_count` | number | ✗ | 本 Turn 内去重后的模型请求数 |
| `request_ids` | string[] | ✗ | 本 Turn 的模型 response id 集合 |
| `total_token` | number | ✓ | 本 Turn 最后一次 `turn_token_usage.total_tokens` |
| `input_token` / `output_token` | number | ✓ | 输入 / 输出拆分 |
| `cached_token` / `reasoning_token` | number | ✓ | 缓存 / 推理拆分 |
| `token_source` | string | ✓ | `turn_usage` / `unavailable` |
| `status` | string | ✗ | `completed` / `working` / `interrupted` / `unknown` |
| `source` | string | ✗ | `codex` / `workbuddy` / `other` |
| `model` | string | ✓ | 该 Turn 的主模型 |
| `created_at` / `updated_at` | string(ISO) | ✓ | 写入 / 变更时间 |

约束：

```text
✓ Turn 总量是绝对值，重复结算按 turn_id 覆盖，不累加
✓ Turn 总量来自平台 turn_token_usage，不按消息或请求估算
✗ Turn 总量不得按 Skill 数拆分
✗ 一个 Turn 的 Token 不得与 Conversation 总量相加
```

## 3. Skill Usage Log

**问的问题**：这次对话用了哪些 Skill？各载入多少、什么版本？
**业务键** `usage_id` —— **一个 Skill 调用 1 条，一个对话可有 N 条**。
**文件** `logs/<date>/skill-usage.jsonl`

| 字段 | 类型 | 允许 null | 含义 |
|---|---|---|---|
| `usage_id` | string | ✗ | 业务键，优先由 `skill_invocation_id` 派生 |
| `conversation_id` | string | ✗ | **关联键**，指向所属 Conversation Log |
| `turn_id` | string | ✓ | V3.26：所属 Turn；旧数据为 `null` |
| `provider_turn_id` | string | ✓ | 宿主原始 Turn id |
| `turn_ordinal` | number | ✓ | Conversation 内第几轮 |
| `event_ordinal` | number | ✓ | 该 Turn 内 Skill 事件顺序 |
| `agent` | string | ✓ | 与所属 Conversation 一致，便于不 join 也能回答「谁在什么 agent 下用了它」 |
| `skill_id` | string | ✓ | Skill 标识 |
| `skill_name` | string | ✓ | Skill 展示名 |
| `skill_version` | string | ✓ | Skill 版本 |
| `skill_token` | number | ✓ | **该 Skill 的 Token 消耗**，见下方口径表 |
| `token_source` | string | ✗ | **标签**：`injection` / `unavailable` |
| `start_time` | string(ISO) | ✓ | 该次 Skill 调用开始时间 |
| `end_time` | string(ISO) | ✓ | 该次 Skill 调用结束时间 |
| `status` | string | ✓ | 调用状态 |
| `trigger_type` | string | ✓ | `agent` / `user` / `hook` / `automation` / `unknown`（JSONL 无法区分用户显式触发，故常为 `agent`） |
| `evidence` | string | ✓ | **V3.22**：凭什么认定「用了这个技能」——`explicit_invocation`（用户输入显式引用）/ `skill_md_loaded`（真实载入 SKILL.md）；取不到写 `null` |

> **`evidence` 只描述「证据类型」，不改变用量口径**：它回答的是
> 「这条记录是真的执行了技能，还是只被提到过」。Codex 侧没有 Skill 工具调用，
> 因此 `skill_md_loaded`（模型真的读了技能定义）是当前最强的可用证据；
> WorkBuddy 侧由宿主 `callId` 直接判定，`evidence` 为 `null` 属正常。

### ⚠️ Token 口径（本节最易出错处）

| 字段 | 口径 | 可跨 Skill 相加？ |
|---|---|---|
| `skill_token` + `token_source: "injection"` | **A 口径**：该次调用**载入注入上下文**的体积 = `load_chars × token_per_char` | ✅ 可以（各自独立的一次性注入） |
| `skill_token: null` + `token_source: "unavailable"` | 载入失败 / 口径关闭（`settlement.skill_token_method = off`） | — |
| `call_request_total_token` | **B 口径**：调用**所在请求**的用量（含全部历史上下文，**非独占**） | ❌ **禁止**（同请求内多个 Skill 会重复计入） |

**严禁**：`total_token ÷ Skill 数`、按调用次数推算、按字符占比反推独占 token、
把 B 口径当 `skill_token` 求和。**取不到就写 `null`**。

### 明细字段

| 字段 | 含义 |
|---|---|
| `call_request_id` | 该 Skill 调用所在的请求 id |
| `call_request_total_token` | B 口径用量（**仅供对账**，不得作为 `skill_token`） |
| `load_chars` | 载入字符数（A 口径的原始测量值，便于复核换算） |
| `args` | 调用参数（**已经过 Security Filter 脱敏**） |
| `source` | 来源标识 |
| `skill_invocation_id` | 宿主提供的调用 id（存在时优先作为 ID 派生输入） |
| `created_at` / `updated_at` | 写入 / 变更时间 |

**Skill Receipt 视图**：由 Turn Log 与 Skill Usage 派生，不单独落事实日志。
中间回执显示截至当前 `event_ordinal` 的去重 Skill 集合；最终回执按 `skill_id`
去重，但保留每次 invocation 的 `usage_id` 与 `evidence`。

---

## 4. Work Segment Log

**问的问题**：这次对话内部有哪些连续工作主题？
**业务键** `segment_id` —— **0 ~ N 条**。
**文件** `logs/<date>/work-segments.jsonl`

| 字段 | 类型 | 允许 null | 含义 |
|---|---|---|---|
| `segment_id` | string | ✗ | 业务键，由对话、序号、开始时间与主题派生 |
| `conversation_id` | string | ✗ | 所属会话 |
| `date` | string | ✗ | 归属日期 |
| `ordinal` | number | ✗ | 会话内顺序 |
| `topic` | string | ✗ | 连续主题 |
| `summary` | string | ✓ | 主题摘要 |
| `start_time` / `end_time` | string(ISO) | ✓ | 起止时间 |
| `duration_seconds` | number | ✓ | 由起止时间派生 |
| `source` | string | ✗ | `agent` / `manual` / `imported` / `system` |
| `status` | string | ✗ | `completed` / `in_progress` / `needs_confirmation` / `cancelled` |
| `confidence` | string | ✓ | `high` / `medium` / `low` |

---

## 5. Work Activity Log

**问的问题**：这次对话（或人工）产出了哪些工作事项？
**业务键** `activity_id` —— **0 ~ N 条**。
**文件** `logs/<date>/work-activities.jsonl`

| 字段 | 类型 | 允许 null | 含义 |
|---|---|---|---|
| `activity_id` | string | ✗ | 业务键 |
| `date` | string | ✗ | 归属日期（`YYYY-MM-DD`），由记录**自身**决定 |
| `conversation_id` | string | **✓** | 关联键。**人工工作为 `null` 是合法常态，不是异常** |
| `session_id` | string | ✓ | 宿主原始 session id —— **关联证据**（不是关联本身）。有了它，`conversation_id` 才能在结算之后被重新解析出来（V3.4） |
| `start_time` | string(`HH:MM`) | ✓ | 开始时刻。⚠️ **不是 ISO** |
| `end_time` | string(`HH:MM`) | ✓ | 结束时刻。⚠️ **不是 ISO** |
| `duration_minutes` | number | ✓ | **人工明确给出闭合时段**时的时长（`source=manual`，由 `hhmmDurationMinutes()` 计算，支持跨午夜 23:30→00:20 = 50）。**V3.25 起 AI 生成记录恒为 `null`** —— 见 `duration_source` |
| `duration_source` | string | ✓ | **V3.25 新增**：时长凭什么可信。`segments` / `segments_partial` / `open_segment` / `unknown` / `not_applicable_ai_session` / `live`（后者**只允许出现在实时展示，不得落盘**）。没有它，`null` 无法解释，`0` 与「不可获取」也会混淆 |
| `category` | string | ✓ | **事项分类**（V3.3，V3.6 起含 `探索沉淀`）：`工作` / `探索沉淀` / `生活` / `个人成长` / `健康运动` / `休闲娱乐` / `其他`。见下方「分类规则」 |
| `project_name` | string | ✓ | 项目名称。**不得猜测**；不确定时 `null` |
| `work_type` | string | ✓ | 工作类型（取自 `config.work.work_types`） |
| `project_stage` | string | ✓ | **项目阶段**（V3.3 + V3.5）：粗粒度 `需求阶段` / `设计阶段` / `开发阶段` / `测试阶段` / `上线阶段` / `运营/迭代阶段` / `其他`，以及细粒度 `需求分析` / `方案设计` / `交互设计` / `原型设计` / `PRD编写` / `技术沟通` / `开发协作` / `测试验证` / `问题排查` / `上线发布` / `运营维护` |
| `content` | string | ✗ | 事项内容（已脱敏、已按需压缩） |
| `detail` | string | ✓ | **结构化说明**（V3.5），脱敏后保存；不受 200 字展示限制 |
| `detail_compression` | object | ✓ | detail 超安全上限时的截断留痕 |
| `ai_role` | string | ✓ | `AI主导` / `AI协作` / `AI辅助` / `AI查询` / `AI排障` / `未知` |
| `segment_id` | string | ✓ | 关联 Work Segment |
| `skills` | string[] | ✓ | 与事项直接关联的 Skill |
| `models` | string[] | ✓ | 与事项直接关联的模型 |
| `log` / `log_length` | string / number | ✗ | 展示日志，长度不超过 200 |
| `output` | string | ✓ | **成果描述**（V3.3；V3.24 允许探索沉淀）。只有真写了才有，**绝不虚构** |
| `source` | string | ✗ | `agent` / `manual` / `imported` / `system` |
| `status` | string | ✓ | 事项状态 |
| `classification_status` | string | ✓ | **归属确认状态**（V3.6）：`confirmed` / `pending_review`（缺省即此值） |
| `confirmed_at` | string(ISO) | ✓ | 归属被确认的时间 |
| `confirmed_by` | string | ✓ | 确认来源（`user` / `ai`） |
| `created_at` / `updated_at` | string(ISO) | ✓ | 写入 / 变更时间 |

### 归属二次确认（`classification_status`，V3.6）

```text
记录时  按项目归属给出候选 → 标 pending_review（不确定就不确定，不硬认）
总结时  用上下文复核一次（工作会话里可能混进探索类 message）
写回后  标 confirmed + confirmed_at + confirmed_by
        之后**默认不再重复验证**（用户 2026-09-24：「已总结过的 message，
        若无明确要求重复总结时无需重复验证」）
重验    collect-activity.js apply --recheck  /  daily-summary.js draft --recheck
        会把状态打回 pending_review
```

### 分类规则（`category` / `project_stage` / `output`）

```text
· category        必须取自 config.work.categories；非法值在写入前被 CLI 拒绝
· project_stage   必须取自 config.work.project_stages；非法值被拒绝
· output          自由文本，但**只有确实产出了才写** —— 没有就 null
```

**分类与字段适用范围**（避免出现「普拉提｜需求阶段」这种荒谬组合）：

```text
category = 工作          →  允许写 project_stage / output
category = 探索沉淀      →  **允许 output**（Skill 能力变化），project_stage 强制 null
category = 生活/成长/健康/休闲/其他
                         →  project_stage 与 output 均强制为 null
category 未填（null）     →  按兼容口径，允许 project_stage / output
```

探索沉淀的 `output` 只描述用户可感知的能力变化，不写文件名、函数名或报错堆栈；
纯修复与稳定性维护可以保留在记录中，但默认只进入维护计数，不占总结主位。

`category` 未填（`null`）时的推导顺序（**仅供展示与建议，不写回记录**）：

```text
生活/运动/休闲类关键词（优先） > 个人成长关键词 > 工作关键词 > 「其他」
```

> ⚠️ 生活 / 健康 / 休闲类信号**必须**优先于工作类，否则「运动计划评审」会被工作关键词抢走。

### 两个必须记住的实现约束

1. **`start_time` / `end_time` 是 `HH:MM` 纯时刻**，不是 ISO 字符串。
   用 `new Date('09:00')` 这类解析会得到 `Invalid Date`，使 `duration_minutes` 恒为 `null`
   —— 必须走 `hhmmDurationMinutes()`（V3.1 已修正此坑）。
2. **`display_content` 由 `buildDisplayContent()` 重算**，与 WorkItem 同一套格式，
   **不落库为存储字段**（避免同义字段双写漂移）：

```text
有项目：【项目名称】【工作类型】事项内容
无项目：【工作类型】事项内容          ← 不猜项目名
```

### 来源与写入方式

| 来源 | 写入方式 | `conversation_id` |
|---|---|---|
| `agent` | LLM 判定后经 `settle-conversation.js --activities-file / --activity` 写回 | 本次对话 |
| `agent` | 经 Hook 队列 → `collect-activity.js apply` → WorkItem → `export-work-activities.js` | 由 WorkItem 的 `session_id` **查** Conversation Log 得到（V3.4；查不到写 `null`） |
| `manual` | 用户手动记录（`/log` 等） | `null` |
| `imported` | `export-work-activities.js` 从 WorkItem 导出 | 有则带，无则 `null` |
| `system` | 系统生成（如跨日结转） | 通常 `null` |

### `conversation_id` 为 null 的三种情形（必须能区分）

```text
① 人工事项 / 历史批量导入      → 没有 session_id 证据，永远无法回链（no_session_evidence）
② 会话尚未结算                 → 有证据但暂时查不到；结算后 --relink 自动补齐（session_not_settled）
③ 会话确实不存在（已超出日志） → 有证据但查不到，保持 null
```

```text
✓ 只按事项自身的 session_id +「该会话确实存在于 Conversation Log」建立关联
✗ 不按时间重叠、不按项目名相同、不按「同一天只有一个候选」去凑关联
```

> `--relink` 报告中的 `no_evidence` / `unresolved` 两个计数，就是上面 ① 与 ②③ 的实际条数。

### 明细字段

| 字段 | 含义 |
|---|---|
| `display_content` | **计算字段，不落库** —— 由 `buildDisplayContent()` 按「【项目】【工作类型】内容」重算 |
| `confidence` | 归类置信度 |
| `work_item_id` | 该事项若已被 WorkItem 收录，记下对应 id，便于与 TickTick 同步链路对齐 |
| `ticktick` | **V3.23 新增**：TickTick 对应关系 `{ taskId, projectId, syncedAt }`，无 taskId 时为 `null`（白名单三字段，与 WorkItem 同一口径）。<br>为什么落在这一层：WorkItem 会随跨日丢弃、`pending/` 也可能被清理，而**永久活动日志不清理** —— taskId 只有存到这里才不会失传。 |
| `duration_source` | **V3.25 新增**：与同行的 `duration_minutes` 同源，说明「这个时长凭什么可信」。枚举定义见 `lib/log-core.js` 的 `VALID_DURATION_SOURCE`；WorkItem 侧的对应字段见 `data-model.md`。 |

---

## 6. AI Usage Log

**问的问题**：哪些精确可得的 Token / Credit 属于哪个 Segment / Activity？
**业务键** `ai_usage_id` —— **0 ~ N 条**。
**文件** `logs/<date>/ai-usage.jsonl`

| 字段 | 类型 | 允许 null | 含义 |
|---|---|---|---|
| `ai_usage_id` | string | ✗ | 业务键 |
| `conversation_id` | string | ✗ | 所属会话 |
| `segment_id` | string | ✓ | 精确关联的 Segment |
| `activity_id` | string | ✓ | 精确关联的 Activity |
| `date` | string | ✗ | 归属日期 |
| `attribution_status` | string | ✗ | `exact` / `partial` / `unallocated` |
| `input_token` / `output_token` / `total_token` | number | ✓ | 平台可得的 Token 明细；缺一且无平台总量时写 `null` |
| `credit` | number | ✓ | 与 Token 独立的积分 / Credit |
| `model` / `models` | string / string[] | ✓ | 模型信息 |
| `agent` | string | ✓ | Agent 标识 |
| `skills` | string[] | ✓ | 该用量涉及的 Skill |
| `start_time` / `end_time` | string(ISO) | ✓ | 用量发生时间 |
| `source` | string | ✗ | `workbuddy` / `codex` / `other` |

约束：

```text
attribution_status = unallocated → 不得包含 segment_id / activity_id
attribution_status = exact/partial → 必须包含 segment_id 或 activity_id
Conversation 总量仍是总账；AI Usage 只做精确归属，不按比例拆分
```

---

## 7. 数据如何互相关联

```text
Conversation Log ──conversation_id──┬──> Skill Usage Log   （1 : N）
                                    ├──> Turn Log          （1 : N）
                                    ├──> Work Segment Log   （1 : N）
                                    ├──> Work Activity Log  （1 : N，且可为 0 : 0）
                                    └──> AI Usage Log       （1 : N）

Work Activity Log ──work_item_id──> current.json 的 WorkItem ──taskId──> TickTick
```

**关联铁律**：

```text
✓ 只在存在显式 conversation_id 时才建立关联
✗ 不推断关联；没有 conversation_id 就不连
```

一个 `conversation_id` 被**同一维度下的多个取值**共同引用时归入「归属有歧义」（`ambiguous`），
**不计入任何一方**的合计。四个归因维度各自独立判定：

```text
维度                    「多个取值」的含义
──────────────────────────────────────────────────────────────
工作类型 (work_type)     同一对话服务多个工作类型   → by_work_type_ambiguous
项目 (project_name)      同一对话服务多个项目       → by_project_ambiguous
项目阶段 (project_stage)  同一对话跨多个阶段         → by_project_stage_ambiguous
项目 × 阶段              同一对话落进 2 个以上格子  → project_stage_ambiguous
```

> ⚠️ **项目 × 阶段**这一维最容易漏判：同一对话若同时出现在「A 项目/开发阶段」与
> 「B 项目/需求阶段」两个格子里，若不判歧义就会**重复计数**，
> 使「按项目×阶段」的 Token 合计大于会话总 Token。
> 实现见 `scripts/lib/metrics-engine.js` 的 `buildCostStats()`。

`conversation_id` 只是**关联键**，不是所有日志的统一主键 —— 各有各的业务键。

---

## 8. 原始快照（`raw/`）

`raw/workbuddy/<date>/<session_id>.json` 是**短期缓存**（默认 7 天），
用于结算失败或口径变更后**重新解析**：

```text
session_row  session_usage{used,size,credits,credit_total}  requests[]  skill_calls[]
source_files[]  notes[]  collected_at  parser_version  conversation_id
```

重算命令：`node scripts/settle-conversation.js --backfill` —— 结果**覆盖**旧值而非新增。

---

## 9. 相关文档

| 文档 | 内容 |
|---|---|
| `references/settlement.md` | 结算与幂等的**完整机制**（ID 派生细节、按键替换、异常三态、重新解析） |
| `references/cost-statistics.md` | **AI 成本统计口径**：四个归因维度、占比、歧义、版本对比、什么必须记 `null` |
| `references/work-segments-and-usage.md` | Work Segment 与 AI Usage 的分段、归属与安全规则 |
| `references/data-model.md` | WorkItem / Activity / DailyLog / state / 并发写入 / 生命周期 |
| `references/daily-summary.md` | 复盘只消费本文档定义的日志，产出日报 / 周报 / 月报 / 项目报告 |
| `scripts/lib/conversation-store.js` | 存储层实现（`normalize*()` 是字段的**最终事实**） |
