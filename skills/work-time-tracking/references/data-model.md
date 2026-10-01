# 数据模型与文件职责（V3.5）

版本标识：`config.version = "3.1"`、`manifest.type = "work-time-log"`。

> **V3.5 变更**：在既有结构化日志上新增 Work Segment 与 AI Usage；
> WorkItem / DailyLog 结构兼容不变，旧数据无需迁移。
>
> **V3.1 变更**：三日志模型与 WorkItem / DailyLog 结构**未变**；
> 变更集中在①结构化日志的**目录布局**（改为按日期组织，与 GitHub 远端同形）、
> ②**空值口径**（`'unavailable'` 字符串哨兵 → `null` + 来源标签）、
> ③**三层存储生命周期**、④新增 **GitHub 归档**能力。详见 §13-§15 与
> `references/github-sync.md`。

---

## 1. 数据层级（§11/§13/§23/§24）

| 层 | 含义 |
|---|---|
| **Activity** | 宿主工具产生的原始活动事件（§11.1） |
| **WorkItem** | 实际工作事项，也是 TickTick 的最终同步单位（§13） |
| **DailyLog** | 一天的原始工作日志（§23） |
| **DailySummary** | 对 DailyLog 的分析层，不等于原始日志（§24） |
| **Conversation / SkillUsage / WorkSegment / WorkActivity / AIUsage** | V3.0 起逐步形成的结构化日志；V3.5 增加 Segment 与 Usage（§13） |

```text
宿主事件 → Activity → Security Filter → WorkItem → DailyLog → DailySummary

（V3.0 并行链路，互不覆盖）
对话结束 → Parser Script ─┬→ Conversation Log ─┐
                          ├→ Skill Usage Log  ─┼→ Daily Summary 只读汇总
                          └→ Work Activity Log ┘      ↓
                                                  7/30 天周期分析
```

**两条链路不互相覆盖**：WorkItem 仍是同步到滴答清单的单位；
结构化日志是「这次对话花了多少 / 属于哪些主题和事项」的事实层。

---

## 2. 共享日志目录（§8/§8.1）

```text
WorkTimeLog/
├── current.json          当前日期 DailyLog
├── pending/              尚未同步的历史日志
├── archive/              可选历史归档
├── state.json            运行状态
├── config.json           用户配置
├── .log-manifest.json    用于确认目录属于本 Skill 的共享日志
│
├── structured/（V3.0 旧布局，仅兼容读取）
│
├── logs/                 V3.1：结构化日志（§13），**永久保留**
│   └── <YYYY-MM-DD>/
│       ├── conversations.jsonl
│       ├── skill-usage.jsonl
│       ├── work-segments.jsonl
│       ├── work-activities.jsonl
│       └── ai-usage.jsonl
├── raw/workbuddy/<YYYY-MM-DD>/<session_id>.json   原始快照（短期缓存，默认 7 天）
├── summaries/<YYYY-MM-DD>.md                       每日总结（永久保留）
└── .github-sync/                                   GitHub 工作副本（本地缓存，非数据）
```

`logs/` 与 `current.json` 共用同一套目录锁（`logs/.write.lock`），并发写入安全。
GitHub 远端仓库的目录形状与 `logs/` **完全一致**（`<date>/<kind>.jsonl`），
因此同步是逐文件比对，无需路径映射。

所有宿主工具必须使用**同一个** `log_directory`（§8）；第二个工具安装时检测到
`.log-manifest.json` 与 `config.json` 后必须复用，不得另建一套（§9）。

---

## 3. `.log-manifest.json`

```json
{
  "type": "work-time-log",
  "version": "1.0",
  "created_at": "2026-09-20T09:00:00+08:00",
  "log_id": "log_302984435"
}
```

`log_id` 是判定「多个工具是否属于同一共享日志」的依据。

---

## 4. `config.json`（§35）

> **配置项的完整定义见 `references/config-reference.md`** —— 含每个键的默认值、
> 数值边界（钳制）、fail-closed 安全项、以及**已移除 / 不应启用**的项。
> 本节只说明它在数据模型中的位置。

`config.json` 位于**共享日志目录**内（`<log_dir>/config.json`），是**生效配置**；
`<skill>/templates/config.json` 只是 `init-log.js init` 使用的模板。
（配置是 **JSON 而非 YAML**，理由见 `references/config-reference.md` §1。）

**注意配置中不含 `summary.schedule` 与 `sync.trigger`** —— 何时运行由宿主 Scheduled Task
决定，不由本 Skill 的配置驱动（§45 精神 / §35）。

兼容：V1.4 扁平结构、V1.6/V1.9 的旧字段（`ai.auto_task`、`max_ai_calls_per_day`、
旧 `security` 形状）会在读取时自动归并。

---

## 5. `state.json`（§8.1）

```json
{
  "current_date": "2026-09-20",
  "last_event_time": "2026-09-20T11:20:00+08:00",
  "pending_sync_dates": [],
  "last_summary_time": null,
  "last_automatic_summary_date": null,
  "last_sync_time": null,
  "tracking_status": "tracking",
  "active_work_items": ["WI-20260920-A8F2C1D3"],
  "automatic_ai_calls_today": 4,
  "manual_ai_calls_today": 2,
  "hosts": {}
}
```

§8.1 给出核心字段；为使 §35（AI 保护阈值）、§50（自检）、§56（进行中 / 触发来源）可落地，
额外保留 `tracking_status`、`active_work_items`、AI 计数与 `hosts`。

`hosts[<宿主>]` 记录宿主触发状态（§57）：

```json
{
  "host": "codex",
  "mechanism": "hooks",
  "available": true,
  "trigger_configured": true,
  "last_activity_at": "2026-09-20T11:20:00+08:00",
  "activity_count": 12
}
```

`mechanism`：`hooks` | `skill` | `manual` | `unavailable` | `unknown`

旧版键名（`last_activity_at` / `last_summary_date` / `last_sync_date` / `collectors` / `ai`）
会在读取时自动归一化（`migrateState()`）。

---

## 6. `Activity`（§11.1）

```json
{
  "id": "ACT-xxxx",
  "timestamp": "2026-09-20T10:20:00+08:00",
  "source": "codex",
  "event_type": "user_interaction",
  "content": "设计GPU细粒度调度页面",
  "session_id": "session-xxxx",
  "metadata": {}
}
```

`source`：`codex` | `workbuddy` | `manual` | `auto` | `generic` | `other`

`event_type`（由 §3.1 宿主事件映射而来）：

```text
session_start   session_end    user_interaction   tool_activity
file_operation  command        manual_input       interrupt
```

**采集边界（§12/§25）**：Activity 进入 WorkItem 前必须经过 Security Filter，
详见 `references/security.md`。

### 6.1 Activity 的字段与 Work Activity Log 的区别

| | `Activity`（本节） | Work Activity Log（`references/data-schema.md` §3） |
|---|---|---|
| 含义 | **宿主事件**：一次原始动作 | **工作事项**：已归类、可统计的产物 |
| 粒度 | 高频、可能重复 | 低频、去重后 |
| 落库位置 | `current.json` 的 `activities[]` / `pending/` | `logs/<date>/work-activities.jsonl` |
| 是否有 `category` / `project_stage` / `output` | ❌ 无（尚未归类） | ✅ 有（V3.3） |

> `category` / `project_stage` / `output` 属于**归类结果**，因此在 Activity 层不存在 ——
> 它们只在 WorkItem 与 Work Activity 上出现。

---

## 7. `WorkItem`（§12-§19）

```json
{
  "id": "WI-20260920-A8F2C1D3",
  "date": "2026-09-20",
  "category": "工作",                      // V3.3；V3.6 起含「探索沉淀」
  "project_name": "异构算力平台",
  "project_confidence": "high",
  "work_type": "需求梳理",
  "work_type_confidence": "high",
  "project_stage": "需求阶段",              // V3.3，仅 category=工作 时才有意义
  "output": "产出《GPU 调度需求规格说明书 V1》",   // V3.3，只有真产出才写
  "detail": "明确 MIG、显存隔离、GPU 复用率与节点调度规则。", // V3.5，脱敏后的结构化说明
  "ai_role": "AI协作",
  "segment_id": "SEG-20260920-ABCDEF1234",
  "skills": ["work-time-tracking"],
  "models": ["Deepseek-V4.1-Flash"],
  "content": "完善GPU细粒度调度需求规格说明书",
  "display_content": "【异构算力平台】【需求梳理】完善GPU细粒度调度需求规格说明书",
  "start_time": "10:10",
  "end_time": "11:20",
  "estimated_duration": null,
  "actual_duration": 70,
  "status": "completed",
  "source": "auto",
  "confidence": "high",
  "time_segments": [{ "start": "10:10", "end": "11:20" }],
  "activities": [],
  "parent_id": null,
  "tags": [],
  "notes": "",
  "ticktick": {
    "taskId": "6aaf6b5ee4b066c22040c33d",
    "projectId": "5a4329c34686f1f8e0f0f802",
    "syncedAt": "2026-09-21T11:57:44+08:00"
  },
  "content_compression": {
    "summarized": true,
    "truncated": false,
    "original_length": 412,
    "final_length": 71,
    "reason": "已由 AI 压缩至 71 字"
  }
}
```

### 7.1 标准字段（§14）

```text
id  date  project_name  project_confidence  work_type  work_type_confidence
category             # V3.3；V3.6 起含「探索沉淀」
project_stage        # V3.3；仅 category=工作 或未填时有值
output               # V3.3；成果描述，只有真产出才写
detail               # V3.5；结构化说明，不走 200 字展示上限
ai_role              # V3.5；AI主导 / AI协作 / AI辅助 / AI查询 / AI排障 / 未知
segment_id           # V3.5；关联 Work Segment
skills / models      # V3.5；与事项直接关联的 Skill / Model
content  display_content  start_time  end_time  estimated_duration  actual_duration
status  source  confidence  parent_id  tags  activities  notes  time_segments
time_unknown         # 布尔；true 表示「已完成 · 时间未知」（§14 扩展）
ticktick             # 对象或 null；本地 WorkItem ↔ TickTick Task 的对应关系（§30/§31）
content_compression  # 对象或 null；超长内容被 AI 压缩 / 截断的留痕（2026-09-21 扩展）
```

#### `ticktick`（taskId 回写，2026-09-21 扩展）

用于消除「每次同步靠标题搜索匹配」的失手风险（§39）。**本技能只保存，不操作 TickTick API**（§4）。

| 子字段 | 类型 | 说明 |
|---|---|---|
| `taskId` | string | TickTick Task ID。**有值才有意义** |
| `projectId` | string \| null | TickTick 清单 ID；可后补 |
| `syncedAt` | string \| null | 最近一次同步时间（ISO 8601，带时区） |

约束（`normalizeItem` + `validate-log.js` 强制）：

```text
无 taskId（字段缺失 / null / 空对象 / 空串）  ⇒  整个 ticktick 置 null
有 taskId                                    ⇒  只保留白名单三字段，其余丢弃
数组 / 字符串 / 数字                          ⇒  置 null（形态非法）
```

**无 taskId 时不是保留半截对象，而是整个置 null** —— 避免「看起来同步过」的假象。

写入方式（由同步回报驱动，非本技能主动查 TickTick）：

```bash
# 保存对应关系
node scripts/update-work-item.js link --id <WorkItem id> \
     --task-id <ticktick taskId> [--project-id <清单 id>] [--synced-at <ISO 8601>]

# 清除对应关系（后续回退为标题匹配）
node scripts/update-work-item.js unlink --id <WorkItem id>
```

> **`taskId` 从哪来**：`ticktick-work-review` 在每次同步的「事项 ↔ taskId 对照」段中给出
> （见其 `SKILL.md` §6 与 `ticktick-work-review/references/output-templates.md`）。
> 本技能接收后落库；**不得自行调用 TickTick 查询 ID**（§4 职责边界）。

#### `content_compression`（压缩留痕，2026-09-21 扩展）

记录「超长内容被怎么处理了」。只在**真的发生过压缩或截断**时存在，否则为 `null`。

| 子字段 | 类型 | 说明 |
|---|---|---|
| `summarized` | boolean | 内容由 AI 压缩而来（浓缩，未丢尾部） |
| `truncated` | boolean | 内容被本地截断（**尾部信息已永久丢失**） |
| `original_length` | number \| null | 写入前的原始字符数 |
| `final_length` | number \| null | 实际落库的字符数 |
| `reason` | string \| null | 人类可读的处置说明；截断时必须写明失败原因 |

约束（`normalizeContentCompression` + `validate-log.js` 强制）：

```text
summarized 与 truncated 互斥；两者皆 true ⇒ 取更保守的一方（truncated）
两者皆 false / 缺 original_length / 非对象 / 数组  ⇒  整个 content_compression 置 null
```

> **为什么冲突时取 `truncated`**：两个标记都在描述「这条记录不完整」。
> 冲突时若取 `summarized`，等于把「丢过数据」粉饰成「只是浓缩过」，
> 而丢失信息比误报完整更危险 —— 所以一律向**保守**一侧收敛。

**无意义时置 `null`，不留半截空对象** —— 与 `ticktick` 同一设计，避免「看起来处理过」的假象。

处理顺序与隐私边界见 `references/security.md` §2.4 与 §7。
配置开关：`config.security.ai_summarize`（默认 `true`）、
`config.security.ai_summarize_timeout_sec`（默认 `6`，上限收敛到 `60`）。

### 7.2 项目与工作类型（§4-§11）

| 字段 | 说明 |
|---|---|
| `category` | **事项分类**（V3.3）；取自 `config.work.categories`。`project_stage` 仅工作可用；`output` 仅工作与探索沉淀可用 |
| `project_name` | 项目名称；**无法可靠识别时为 `null`**（§11 禁止猜测） |
| `project_confidence` | `high` / `medium` / `low`；只有 `high` 或充分确认的 `medium` 可写入（§5） |
| `work_type` | 工作类型；无法可靠判断时 `null`（§6/§7） |
| `work_type_confidence` | 同上 |
| `project_stage` | **项目阶段**（V3.3）；仅 `category = 工作` 或未填时有意义 |
| `output` | **成果描述**（V3.3）；**只有确实产出才写**，没有就 `null`（禁止虚构） |
| `content` | 事项内容（**不含**项目与工作类型前缀） |
| `display_content` | 展示内容，由三字段拼合（§28） |

> **V3.3 的 three-dimension 归因**：`project_name` / `work_type` / `project_stage`
> 三个字段不只用于展示 —— 它们同时是 AI 成本的**三个归因维度**
> （见 `references/cost-statistics.md`）。三者**都不强制填写**，
> 留空即归到「（未标注）」，不参与任何 Token/积分分摊。
> `category` 则决定事项进入「产品工作」还是「生活与个人事项」章节。

**项目识别来源**（§4.1）：用户明确描述 / 当前会话上下文 / 文件目录上下文 / 用户手动指定。

**项目名称格式化**（§10）：使用统一名称、尽量正式名称、不重复添加「项目」「系统」等无意义后缀、
不根据缩写随意创造正式名称、不确定时保持为空。

**工作类型基础清单**（§6，可在 `config.work.work_types` 扩展）：

```text
产品规划 需求分析 需求沟通 需求文档 竞品/行业研究 产品设计 原型设计 交互设计
数据分析 项目管理 研发协作 测试验收 上线发布 问题处理 产品运营 产品复盘
会议 方案设计 PRD编写 技术沟通 开发协作 测试验证 资料查询 其他工作
```

产品经理视角的**分组**（需求 / 产品设计 / 项目推进 / 研发协作 / 项目管理 / 数据分析 / 其他）
见 `references/daily-summary.md` §6。

### 7.2b 项目阶段（V3.3）

```text
需求分析 方案设计 交互设计 原型设计 PRD编写 技术沟通 开发协作
测试验证 问题排查 上线发布 运营维护
需求阶段 设计阶段 开发阶段 测试阶段 上线阶段 运营/迭代阶段 其他
```

```text
· 取值取自 config.work.project_stages；非法值在写入前被 CLI 拒绝
· 无法可靠判断时留 null —— **不猜阶段**
  （猜出来的阶段会让「阶段成本分布」失真，比空着更糟）
· 只在 category = 工作（或未填）时使用；生活/运动类恒为 null
```

### 7.3 display_content 生成规则（§8/§28/§44）

```text
有项目：display_content = 【project_name】【work_type】content
无项目：display_content = 【work_type】content
无类型：display_content = content
```

**必须结构化保存三个字段，禁止只保存格式化字符串**（§9）。
写入与修改时由 `normalizeItem()` 自动重算，自检会校验一致性。

### 7.4 最低记录要求（§13）

```text
start_time  content
```

项目名称**不是强制字段**；工作类型原则上应尽量识别，但无法可靠判断时也不得强行猜测。
`estimated_duration` 无法判断时必须为 `null`，**禁止编造**。

### 7.5 ID（§12）

```text
WI-YYYYMMDD-<随机>
```

例如 `WI-20260920-A8F2C1D3`。**禁止使用简单递增数字**，避免多工具生成相同 ID。

### 7.6 状态（§15 前的通用状态集）

```text
not_started  in_progress  paused  completed  cancelled  needs_confirmation
```

#### 已完成 · 时间未知（§14 扩展，2026-09-20）

**无 `start_time` 的条目，默认为 `needs_confirmation`** —— 避免把「漏填时间」当成合法完成。

但自动采集（对话 / Hook）**天然拿不到时长**：能确认「做了什么」，拿不到「做了多久」。
> V3.25 把这条判断推广到了**全部**自动采集事项：不再只是「没时间」的那些，
> 而是**任何非 `manual` 来源都不产出时长**（详见 §7.7.1）。本节描述的是其中
> 「连开始时刻都没有」的极端情形。
若一律降级为 `needs_confirmation`，这类已确实完成的工作会永远挂在「待确认」里，
既进不了完成统计，也与事实不符。因此引入显式标记：

```json
{
  "status": "completed",
  "time_unknown": true,
  "start_time": null, "end_time": null, "time_segments": [], "actual_duration": null
}
```

约束（`validate-log.js` 强制）：

```text
time_unknown === true  ⇒  时间类字段必须全为 null/空（§13 不编造时间）
                       ⇒  status 只能是 completed 或 cancelled
无 start_time 且未标记  ⇒  仍要求 needs_confirmation（原规则不变）
```

语义区分：

| 状态 | 含义 |
|---|---|
| `needs_confirmation` + 无时间 | **归属未确认**：连项目/类型都没定，等 /analyze |
| `completed` + `time_unknown` | **归属已确认、时间未知**：项目与类型齐全，只缺时长 |

渲染约定：`recordSpan()` 对 `time_unknown` 条目输出「时间未记录」（而非「时间未知」），
总结中归入「已完成事项」，**不再**出现在「未完成事项」或「待确认事项（缺少开始时间）」。

### 7.7 时间模型（§16）

```json
"time_segments": [
  { "start": "10:00", "end": "10:30" },
  { "start": "11:00", "end": "11:20" },
  { "start": "14:00", "end": "14:40" }
]
```

- 进行中事项的 `actual_duration` **落盘为 `null`**，实时耗时由读取方现算。
- 相邻时段自动无损合并。
- `needs_confirmation` 事项的开放时段**不计入时长统计**（§13 精神）。

### 7.7.1 时长的证据分档（V3.25，用户 2026-09-28）

**AI 生成记录不产出时长。** 分档依据是**时间证据的来源**，不是「有没有 `end_time`」：

| 情形 | `actual_duration` | `duration_source` |
|---|---|---|
| `source = manual`，有闭合时段（或明确 start+end） | 闭合部分之和 | `segments` / `segments_partial`（后者=含未闭合时段，只算了闭合部分） |
| `source = manual`，只有开放时段 | `null` | `open_segment` |
| `source = manual`，无任何时间 | `null` | `unknown` |
| **`source ≠ manual`（codex / workbuddy / auto / generic / other）** | **`null`** | `not_applicable_ai_session` |
| 实时展示态（`live`） | 含开放段现值 | `live` —— **不得落盘** |

三条硬约束：

```text
✗ 非 manual 来源不得有非 null 时长（即便带着 end_time —— 那是会话收尾/批量封段时刻）
✗ 落盘时不得用 now 给开放段定价（否则同一份历史数据换个时刻重算就变，且实质是编造结束时间）
✗ duration_source='live' 不得出现在落盘日志里（validate-log 会拦）
```

### 7.8 两种时间统计（§20）

| 口径 | 含义 | 示例（A 10:00-11:00，B 10:30-11:30） |
|---|---|---|
| 事项累计时间 | 各 WorkItem 自身时间段累计 | 60 + 60 = **120 分钟** |
| 实际占用时间 | 所有时间段求并集 | 10:00-11:30 = **90 分钟** |

```text
item_duration ≠ elapsed_time
```

两者都保留。**并行事项情况下，事项累计时间可能大于实际工作时长**（§25）。

### 7.9 并行、项目连续性与项目切换（§16-§19）

- 多个 WorkItem 可同时 `in_progress`；**启动第二个不能自动结束第一个**。
- **项目连续性**：上下文明确保持同一项目时，`project_name` 可以继承（§16）。
  实现上由 `suggestProject()` 给出建议（唯一进行中事项 → `medium`），
  经 `--project auto` 或 AI 判定后落盘，**不做无根据的自动继承**。
- **项目切换**应创建新 WorkItem；原 WorkItem 不因项目切换而自动结束（§17）。
- **同一项目可存在多个工作类型**；项目相同不代表 WorkItem 相同（§18）。

### 7.10 跨午夜（§22 精神）

```text
23:50 → 00:30
```

WorkItem 归属于**开始日期**（`date = start_time 所在日期`）。

---

## 8. `DailyLog`（§23）

```json
{
  "date": "2026-09-20",
  "timezone": "+08:00",
  "version": 12,
  "updated_at": "2026-09-20T17:32:00+08:00",
  "updated_by": "codex",
  "records": [],
  "pending_items": [],
  "judgments": {},
  "summary": null,
  "sync": { "status": "pending", "last_sync_at": null }
}
```

| 字段 | 说明 |
|---|---|
| `version` | §10.1 版本号：整数，每次成功写入 +1 |
| `records` | WorkItem 数组 |
| `pending_items` | 低置信度候选与待判断活动（§20），统一存放 |
| `judgments` | AI 判断缓存，键为 Activity hash（§32） |
| `summary` | DailySummary；`null` 表示尚未生成 |
| `sync` | 同步状态 |

### 8.1 `pending_items`（§20）

```json
{
  "id": "ACT-2f9a1c7e",
  "hash": "95cc2e0b…",
  "timestamp": "2026-09-20T10:32:00+08:00",
  "time": "10:32",
  "source": "codex",
  "event_type": "user_interaction",
  "content": "讨论了一个新的页面设计问题",
  "confidence": "low",
  "detected_at": "2026-09-20T10:32:05+08:00",
  "suspected_new_topic": true,
  "local_reason": "与当前进行中事项无关键词交集，疑似新工作主题",
  "redaction": []
}
```

处理方式：`collect-activity.js analyze` → `apply --work-item <id> | --new | --dismiss`，
或 `update-work-item.js promote | dismiss`。

### 8.2 `sync`（§51）

```json
"sync": { "status": "pending", "last_sync_at": null }
```

```text
pending   待同步（默认）
syncing   同步中
success   成功
partial   部分成功
failed    失败
```

**未成功的 WorkItem 保留，等待下次同步**（§51）。
旧版 `synced` / `partial_success` 会在迁移时归一化。

---

## 9. 共享文件并发写入（§10.1）

多个工具可能同时写 `current.json`，写入路径只有一条：

```text
获取文件锁 → 重新读取最新文件 → 检查版本号 → 合并变更
→ 更新版本号 → 原子写入（临时文件 + 替换）→ 释放锁
```

**禁止**：

```text
读取旧文件 → 直接覆盖 current.json
```

实现细节：

- 锁文件 `.write.lock`，`O_CREAT|O_EXCL` 独占创建；重试 150ms，最长 15 秒；
  mtime 超过 90 秒视为崩溃残留并自动回收。
- 版本冲突（当前 `version` ≠ 读取时 `version`）→ 重新读取 → 重新合并 → 再次写入。
- 原子写入：`.<文件名>.<pid>.tmp` → 回读校验 → `rename` 替换。
- 写入失败（锁竞争 / I/O 异常）时 op 暂存到 `pending/writes/`，下次写入自动重放；
  `add` 检查重复 id、`queue_item` 检查重复 hash，因此**重放幂等**。

---

## 10. 日志生命周期（§26）

`keep_days = 1`：**`current.json` 只保留当天**
（注意：`logs/` 与 `summaries/` **永久保留**，不受本项约束，见 §14）。

> **GitHub 归档**：V3.1 起本技能提供 `scripts/sync-github.js`（**默认关闭**），
> 是本技能**唯一**允许执行 git 的地方。Local 是 Source of Truth、**本地覆盖远端**，
> 远端**不反向覆盖本地**。见 `references/github-sync.md`。
>
> `raw/` 与 `summaries/` 是**本地**目录（`raw/` 为短期缓存，默认 7 天）。

```text
current.json.date != today
        ↓
① 先把工作事项导出到 logs/<date>/work-activities.jsonl（永久保留）
        ↓
② 按入口检查 sync 状态
├── 收到新日期记录（采集 / 手工新增）
│   ├── 未同步 → 旧 current.json 转 pending/<date>.json
│   └── 已同步 → 不额外备份
│   → 创建新的 current.json，并继续写入本次记录
└── 手工 `init-log.js rollover`
    ├── 已同步（success）→ 直接覆盖为新的 current.json，不归档、不备份
    └── 未同步（pending / syncing / partial / failed / 缺失）
        ├── 无决策 → 退出码 4 中止，提示「先同步」或「仍然丢弃」两个选项（不覆盖）
        └── --decision keep → current.json 移入 pending/ 后丢弃
```

> ⚠️ **`--decision` 只允许 `keep`。** `archive` 已于 2026-09-21 **废弃**：
> 跨日时会**先**把工作事项导出到 `logs/<date>/work-activities.jsonl` 永久保留，
> 再按同步状态决定是否转 `pending/` —— 不再需要 `archive/` 这个第三副本。

手工 `init-log.js rollover` 不带决策时仍以退出码 4 中止并输出选项；
采集与手工新增事项则自动走非破坏性跨日，不因 `current.json` 落后而丢弃新记录。

> `keep_days` 只影响「保留几天」，不影响「是否备份」。
> 已同步内容在本机**只留当天**：`archive/` 不会因为已同步而被写入。
> `validate-log.js` 的「无未同步历史日志」检查仍会列出待同步日期，作为覆盖前的最后一道提醒。


---

## 11. 自检（§50）

`validate-log.js` 自动完成，全部为本地规则、零 Token：

```text
1 log_directory 是否存在        2 是否可读写
3 current.json 是否有效          4 日期是否正确
5 是否存在未同步日志             6 是否存在文件并发冲突
7 WorkItem ID 是否唯一           8 是否存在非法敏感信息
9 是否超过 AI 自动调用保护阈值
```

另含：配置版本、安全边界是否被违规打开、`pending_items` 与 `judgments` 合法性、
`state` 与 `current.json` 日期一致性、宿主触发状态、**`ticktick` 字段形态**、
**超长内容是否已压缩或已留痕**（`content_compression`）。

---

## 12. 新增 WorkItem 字段的检查清单

给 WorkItem 加新字段时，**五类都要改**，否则会出现「写入成功但自检报错」或「归一化丢失」：

```text
1. scripts/lib/log-core.js
   ├── 常量（如 VALID_TICKTICK_FIELDS）
   └── normalizeItem() 或独立 normalize<X>()，并在 normalizeItem 末尾调用
2. scripts/lib/log-core.js 的 module.exports —— 导出常量与归一化函数
3. scripts/validate-log.js —— 在 WorkItem 循环内加形态校验（pending_items 循环同样要加）
4. 写入入口（⚠️ 三个，最容易漏第 3 个）
   ├── scripts/write-work-item.js（新建时给默认值，通常 null；park 分支的 candidate 也要给）
   ├── scripts/update-work-item.js（新增子命令或用 edit 支持）
   └── scripts/collect-activity.js（自动采集入口，queued 对象也要带）
5. references/data-model.md §7 的 JSON 示例 + §7.1 字段清单 + 专节说明
```

> 第 4 步的**三个**写入入口都容易漏。`content_compression` 就是这样落的：
> 手动写入（`write-work-item.js`）、改写（`update-work-item.js edit`）、
> 自动采集（`collect-activity.js ingest`）三处都要赋值，否则 Hook 场景依然无痕。

**归一化必须幂等**：已归一化的记录再跑一次 `normalizeItem()` 结果不得变化
（验证方法：逐条 `JSON.stringify` 前后比对，`LOG_ROOT\archive\*.json` 全量检查）。

**默认值的取舍**：字段无意义时置 `null`，不要保留半截空对象 ——
例如 `ticktick` 无 `taskId` 时整个置 `null`，避免「看起来同步过」的假象。

**互斥子字段要定义冲突解**：若一个字段含互斥标记（如 `content_compression` 的
`summarized` / `truncated`），必须明确「冲突时取哪一方」，且选**保守**的一侧 ——
丢失信息比误报完整更危险。

回归测试放在 `scripts/test-<字段名>.js`，风格参照 `test-ticktick-link.js`
（用 `os.tmpdir()` 建临时目录，跑真实 CLI，不触碰 `LOG_ROOT`）。
需要避免真实网络调用的字段（如 `content_compression`）可在测试中**注入假实现**
（`filterContent` 的 `options.llm` 注入口），保证测试可重复。

#### ⚠️ 测试必须重定向 HOME（否则会污染真实运行环境）

脚本通过 **HOME 下的定位器文件**解析默认日志目录：

```text
~/.workbuddy/work-time-tracking.json → { "log_directory": "D:\\WorkTimeLog" }
```

`init-log.js init --dir <临时目录>` 会把这个**全局**定位器改写成临时目录。
若测试直接继承真实 `HOME`，跑完删除临时目录后，**生产侧的 Hook 与 `/status`
就会指向一个已消失的路径** —— 表现为「日志突然不记录了」，且极难定位。

因此所有 `test-*.js` 在 `spawnSync` 子进程时必须这样写：

```js
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-home-'));
const CHILD_ENV = Object.assign({}, process.env, {
  HOME: SANDBOX_HOME,
  USERPROFILE: SANDBOX_HOME,   // Windows 上 Node 读的是 USERPROFILE
});
// spawnSync(..., { env: CHILD_ENV })
```

并在收尾时连同 `SANDBOX_HOME` 一起 `rmSync`。

`test-ai-compress.js` §10 内置了这条守卫：跑完会断言真实定位器**没有**被指向
`%TEMP%\wtt-*`，可作模板。

---

## 13. 结构化日志（V3.5）

> **字段定义见 `references/data-schema.md`**（完整字段字典）。
> **机制与幂等见 `references/settlement.md`**。
>
> 本节曾自行罗列一遍字段清单 —— 与 `SKILL.md` 双写、口径易漂移，
> 是本次重构**消除的重复源**（V3.2）。字段问题一律查 `data-schema.md`。

五者职责必须分开，各有唯一业务键：

| 日志 | 文件 | 业务键 | 一个对话几条 |
|---|---|---|---|
| Conversation Log | `logs/<date>/conversations.jsonl` | `conversation_id` | 1 |
| Skill Usage Log | `logs/<date>/skill-usage.jsonl` | `usage_id` | N（每个 Skill 调用一条） |
| Work Segment Log | `logs/<date>/work-segments.jsonl` | `segment_id` | 0 ~ N |
| Work Activity Log | `logs/<date>/work-activities.jsonl` | `activity_id` | 0 ~ N |
| AI Usage Log | `logs/<date>/ai-usage.jsonl` | `ai_usage_id` | 0 ~ N |

---

## 14. 三层存储的生命周期（V3.1）

| 层 | 位置 | 保留期 | 清理者 |
|---|---|---|---|
| Raw Conversation | `raw/workbuddy/<date>/` | 短期缓存，**默认 7 天** | `cleanup-raw-logs.js`（默认 dry-run） |
| Structured Logs | `logs/<date>/*.jsonl` | **永久** | 无（脚本内有硬断言禁止触碰） |
| Daily Summary | `summaries/<date>.md` | **永久** | 无 |
| GitHub | 远端 **private** 仓库 | 长期归档（可选，默认关闭） | — |

> ⚠️ **不要让 `logs/` 跟着 `current.json` 一起换代。** 两者口径不同：
>
> ```text
> current.json   → log.keep_days = 1     （每天一换，只留当天）
> logs/          → permanent             （长期历史数据，跨日不清）
> ```
>
> 结构化日志**不受** `init-log.js rollover` 影响，也**不被** `log.keep_days` 约束；
> `cleanup-raw-logs.js` 只处理 `raw/workbuddy/<YYYY-MM-DD>/`。
> 配置项见 `references/config-reference.md` §3.4。

需要 7/30 天趋势分析时把这些日志**保留好**（本地永久 + 可选 GitHub 归档），
**不要**改回「重扫历史对话」的老做法。

---

## 15. 给结构化日志加新字段的检查清单

与 §12（WorkItem 字段）流程不同，结构化日志的字段集中在两个文件：

```text
1. scripts/lib/conversation-store.js
   ├── normalizeConversation / normalizeSkillUsage / normalizeWorkSegment /
   │   normalizeWorkActivity / normalizeAiUsage
   └── 若字段参与 ID 派生或业务键，必须同步改 make*Id()
2. scripts/lib/conversation-parser.js
   └── collectConversation()（数据从哪来）
3. scripts/lib/metrics-engine.js
   └── 若要进每日复盘，加到 buildFrom() / renderMetrics()
4. scripts/validate-log.js
   └── KIND_SPECS 的 required / enums（否则自检漏检）
5. `references/data-schema.md`（字段字典，**唯一字段定义处**）+ `references/settlement.md`
6. scripts/test-conversation-settlement.js（回归用例）
7. Work Segment / AI Usage 的输入入口：`settle-conversation.js --segments-file`
   / `--ai-usage-file`，并在入库前做关联校验
```

**四条必须守住的约束**：

1. **幂等**：`normalize<X>()` 必须纯函数 —— 同样输入两次，输出必须完全一致
   （不得含随机数、不得读时钟决定字段值；时间戳只允许出现在
   `created_at`/`updated_at`/`settled_at`，且**内容无变化时不得推进**）。
2. **空值语义**：取不到时写 `null`（**不要写 `0`**，也不要写 `'unavailable'` 字符串），
   并用 `*_source` / `settlement_status` 标签说明原因。
3. **标签字段要排除在空值逻辑之外**：`score_source` / `token_source` 的合法值含
   `'unavailable'`，绝不能过 `strOrNull()` —— 这是 V3.0 踩过的坑。
4. **不新增口径**：任何试图「补齐」`skill_token` 的折算逻辑都属于违规，
   在 code review 中应直接被拒。
