# 触发机制与宿主适配

本文件回答两个问题：**谁负责触发**，以及**被触发之后 Skill 做什么**（§32/§52/§60）。

---

## 1. 三者职责边界（§2）

```text
Skill  ≠  宿主工具  ≠  下游同步 Skill
```

| 角色 | 负责 |
|---|---|
| **宿主（Codex / WorkBuddy）** | 事件产生、Hook 触发、Scheduled Task、Skill 调用 |
| **work-time-tracking** | Activity 采集、WorkItem 识别、时间记录、DailyLog、DailySummary、日志生命周期、共享与并发、安全过滤、同步数据准备 |
| **ticktick-work-review** | TickTick 同步、Task 创建/更新/完成、字段映射、幂等 |

> 宿主负责「**什么时候触发**」，Skill 负责「**被触发后做什么**」（§1）。

---

## 2. ⚠️ Skill 不是后台服务

Skill **不做**：创建后台常驻进程 · 自行创建系统定时器 · 自行监听整个电脑 ·
自行推送 TickTick · 自行启动宿主工具 · 执行未授权的系统任务。因此：

> **安装 Skill ≠ Skill 开始后台自动运行。**

典型的错误理解是把 `batch_interval_minutes: 20` 读成「Skill 每 20 分钟自动跑一次」。
它的真实含义是：**当宿主再次触发需要自动分析的事件时，用于控制 AI 分析调用频率。**

但也必须同时理解：

> **Skill 不是后台服务 ≠ 不能自动记录。**
> Skill 不负责自行监听，但可以被宿主的事件机制自动调用，从而实现用户无感的自动记录。

| 机制 | 作用 | 是否持续后台运行 |
|---|---|---|
| Host Event / Hook | 自动捕获工作活动 | 否，由宿主事件触发 |
| Host Scheduled Task | 定时总结 / 同步 | 否，由宿主调度 |
| Skill | 执行记录、分析、处理 | **否** |
| Manual Command | 用户主动操作 | 否 |

**落地要求**：本技能所有脚本中不含任何定时器或自动化创建逻辑；
也不要主动替宿主创建定时任务。

> 本约束的完整说明与宿主侧落地配置见 `references/automation.md` §1。

---

## 3. 三种触发机制（§3-§6）

### 3.1 事件 / Hook 自动触发（§3.1）

这是核心自动记录机制。用户正常使用 Codex / WorkBuddy 时**不需要输入 `/start`**。

宿主可用的事件节点（实际能力由宿主决定）：

```text
SessionStart   UserPromptSubmit   PostToolUse   ToolResult
FileOperation  Command            Stop          SessionEnd   Interrupt
```

收到宿主事件后，Skill 依次：

```text
1 获取事件时间  2 获取事件来源  3 获取必要上下文
4 执行安全过滤  5 判断是否属于工作活动  6 识别项目  7 识别工作类型
8 与现有 WorkItem 匹配  9 必要时创建新 WorkItem  10 更新对应时间片段
11 写入共享 DailyLog
```

调用入口是 `scripts/hook-bridge.js`（读 stdin 事件 JSON）。
**事件映射表见 `references/automation.md` §6.2**（本节不复制）。

映射背后的三条**设计理由**（这是本节的重点）：

| 事件 | 为什么这样处理 |
|---|---|
| `PostToolUse` | 每次工具调用都会触发。若允许它新建或入队，日志会被工具噪声灌满 → **仅刷新，无匹配事项直接忽略** |
| `Stop` / `SessionEnd` | 一次对话结束**不等于**工作事项完成 → 对 WorkItem 仅刷新；但 `Stop` 可用于触发**对话结算**（写的是不同日志，互不影响） |
| `SessionStart` | 只需登记宿主触发状态作为实证，不产生记录 |

**为什么`PostToolUse` 必须「仅刷新」**：它会在每次工具调用触发。若允许它新建或入队，
日志会被工具噪声灌满。因此无匹配事项时直接忽略。

**为什么 Hook 必须静默**：`SessionStart` / `UserPromptSubmit` 的 stdout 会被宿主
注入对话上下文，因此命令必须重定向 `>/dev/null 2>&1`。

**为什么 Hook 必须永不失败**：Hook 超时或非零退出会阻断用户会话。桥接脚本吞掉全部异常并始终
`exit 0`，单次等待上限 4 秒。

**配置生效方式与两条实测坑**（必须显式写 `matcher`、本版本默认热重载）
见 `references/automation.md` §6.3。**改完直接实测确认**（用痕迹文件），
不要把重启当作必需的配置步骤。

### 3.2 宿主定时任务触发（§4）

定时任务与"自动记录"是两个不同概念：定时任务用于**周期性批处理**，不代替事件记录。

| 任务 | 示例 | 动作 |
|---|---|---|
| 自动每日总结（§4.1） | 每天 18:30 | 宿主触发 `/summary` → 读取 DailyLog → 分析 → 生成 DailySummary → 写回 |
| 自动 TickTick 同步（§4.2） | 每天 18:40 | 宿主触发 `/sync` → 检查待同步 WorkItem → 整理数据 → 交 `ticktick-work-review` |
| 待处理检查 | 约每 20 分钟 | 宿主调用本技能处理待判断事项 |

**这些任务由宿主配置**，Skill 不自行创建（§8/§45/§58）。

自动任务失败时（§4.3）：不删除本地日志、不改变 WorkItem 原始记录、不标记已同步、
下次仍允许重新同步、必要时提示用户。

### 3.3 用户手动触发（§5）

```text
/start /pause /resume /done /log /edit
/today /summary /sync /status /status today /analyze /security
```

用于自动识别失败、补录过去工作、修正事项、主动生成总结/同步、查询状态。

### 3.4 自动与手动的关系（§6）

```text
自动事件 → Activity → WorkItem      ┐
                                     ├→ 同一个 DailyLog
/log 14:00-14:40 项目会议 → WorkItem ┘
```

每日工作日志可以同时包含**自动记录 + 人工补录**。

---

### 3.5 三个自动化任务必须分开

```text
任务1：Conversation End Handler   对话结束时实时结算（零 token）
任务2：GitHub Sync               每天定时归档（默认关闭）
任务3：Daily Summary             每天定时只读汇总 + TickTick 同步
```

```text
✗ 任务1 绝不能等到复盘才跑；任务3 绝不能重新解析原始对话
✗ 任务2 绝不能成为复盘的数据源（它是出口，不是入口）
✗ 任一任务失败都不得影响其他两个 —— 尤其不得删除本地日志
```

> **完整的任务定义、Hook 配置、现状核对与超时排查见 `references/automation.md`。**
> 本节不再复制宿主侧配置。

---

## 4. 宿主适配层（§41/§42）

```text
adapters/
├── codex/       Codex Hook / Event → 统一 Activity
├── workbuddy/   WorkBuddy 事件 → 统一 Activity
└── generic/     其他工具与手动输入 → 统一 Activity
```

统一格式（§41）：

```json
{
  "source": "codex",
  "event_type": "user_interaction",
  "timestamp": "...",
  "content": "...",
  "session_id": "..."
}
```

**Skill 核心逻辑不依赖具体宿主** —— 引擎只消费统一 Activity。

### 4.1 Codex 事件映射

| Hook | event_type | 约束 |
|---|---|---|
| `SessionStart` | `session_start` | 创建/恢复工作上下文 |
| `UserPromptSubmit` | `user_interaction` | 识别工作意图的主要依据 |
| `PostToolUse` / `ToolUse` / `ToolResult` | `tool_activity` | 用于判断是否仍在进行当前事项 |
| `FileOperation` | `file_operation` | 文件操作摘要 |
| `Command` | `command` | 命令类型摘要 |
| `Stop` | `tool_activity` | **不等于事项完成** |
| `SessionEnd` | `session_end` | **不直接结束 WorkItem** |
| `Interrupt` | `interrupt` | 中断时保存状态 |

### 4.2 宿主能力不足时（§42）

如果宿主**不支持 Hook、不支持事件回调**，Skill 无法凭空获得该工具的实时活动。
此时只能使用：用户手动触发，或宿主提供的其他自动机制。

> **不能声称已经实现"完全自动记录"。**

应在 `/status` 中如实显示为「宿主触发未配置 / 等待手动触发」：

```bash
node scripts/status.js host --host generic --mechanism manual
```

---

## 5. AI 调用策略（§32-§37）

```text
本地规则优先 → 需要判断时再调用 AI → 批量分析 → 缓存结果
```

### 5.1 零 Token 操作（§36）

```text
读取 current.json / state.json · 查询今日记录 · 查询 WorkItem
计算时间 · 写入日志 · 判断日期 · 检查同步状态 · 文件锁 · ID 生成
```

V3.0 追加（用户 §8 脚本优先原则）—— 这些**全部**是确定性数据处理，一律用脚本：

```text
Conversation ID 提取 · Agent 提取 · Model 提取 · 开始/结束时间提取
Token 提取 · Score 提取 · Skill 提取 · Skill Token 提取 · Skill Version 提取
日志生成 · 日志更新 · 重复数据检查
Token 汇总 · Score 汇总 · Skill 次数统计
```

AI 只处理：**工作内容识别、工作事项总结、项目归类、工作类型判断、每日复盘、周期性分析**。

> 判据（用户 §8）：**这一步的输出是否可能与上次不同？**
> 不会 → 脚本；会（需要语义判断）→ AI。
> Token / Score / Skill 都是「同样的输入必得同样的输出」，因此**绝不允许**交给 LLM 估算。

### 5.2 自动 AI 分析（§33/§34）

主要用于：新工作主题识别、多个 Activity 合并、WorkItem 匹配、低置信度事项分析、每日总结。

```json
"auto_analysis": {
  "batch_interval_minutes": 20,
  "cooldown_minutes": 10,
  "safety_max_calls_per_day": 50,
  "max_context_items": 20,
  "enable_cache": true
}
```

- `batch_interval_minutes` —— **宿主再次触发时是否合并分析**，不是定时器（§34）。
- `cooldown_minutes` —— 避免同一宿主运行链路中短时间重复调用 AI（§34）。

### 5.3 安全熔断（§35）

`safety_max_calls_per_day` 是**保护阈值，不是目标调用量**，用于防止异常循环、
自动任务配置错误、重复触发、AI 调用失控。

超过阈值后：

```text
自动 AI 分析停止
但 Activity 继续记录 · WorkItem 继续保存 · DailyLog 继续更新
无法判断的事项进入 pending_items
用户仍可手动 /analyze、/summary
```

### 5.4 手动 AI 调用（§35）

```text
/summary、/analyze
```

属于 Manual AI Call，**不受 `safety_max_calls_per_day` 限制**。

### 5.5 失败降级（§40）

AI 不可用时仍继续记录 Activity；如果可以确定 `start_time` + `content` 则继续创建 WorkItem；
无法判断归属时写入 `pending_items`。**不应因为 AI 不可用而丢失原始活动。**

### 5.6 命令

```bash
node scripts/collect-activity.js pending          # 待判断事项 + 批量建议
node scripts/collect-activity.js batch-context    # 最小上下文（不是完整 DailyLog）
node scripts/collect-activity.js analyze          # /analyze 手动批量分析
node scripts/collect-activity.js apply --hash <h> --work-item <id> --trigger manual
node scripts/collect-activity.js apply --hash <h> --new --start 10:00
node scripts/collect-activity.js apply --hash <h> --dismiss
node scripts/collect-activity.js budget [--kind auto_analysis|manual]
node scripts/collect-activity.js cache [--clear]
```

`--trigger` 决定是否占用安全阈值：`manual`（默认）不受限，`auto_analysis` 受限。

`batch-context` 只输出 `recent_work_items` + `pending_items`，
**不得发送完整 DailyLog / 聊天记录 / 完整文件内容**（§36）。

---

## 6. 自动识别与低置信度（§15-§20）

匹配顺序（§15）：

```text
Activity → 当前进行中的 WorkItem → 最近暂停的 WorkItem
        → 项目上下文匹配 → 工作类型匹配 → 语义 / 上下文匹配
        → 高置信度新事项 → 低置信度 Pending
```

创建新 WorkItem 的条件（§19 精神）—— 满足其一：

```text
明确出现新的工作主题
用户明确提出新的工作任务
当前上下文与已有事项明显不同
宿主事件显示明显的新工作活动
```

**避免**：每个 Prompt = 一个 WorkItem；每次 AI 回复 = 一个 WorkItem。

### 6.1 项目与工作类型的本地判定

本地层**只给建议，不自动写入**（§11 禁止猜测）：

| 函数 | 作用 |
|---|---|
| `suggestProject(log)` | 上下文继承建议：唯一进行中事项 → `medium`；多项目并存 → `low` 且不写 |
| `suggestWorkType(text, list)` | 关键词匹配（18 类），命中 → `medium`；未命中 → `low` 且留空 |

两者结论通过 `--project auto` / `--work-type auto` 被接受，或由 AI 在批量分析时判定后
用 `--project` / `--work-type` 回写。**未确认时保持 `null`。**

### 6.2 项目连续性（§16）

同一项目连续工作时可继承 `project_name`：

```text
【异构算力平台】【需求梳理】完善GPU资源配置需求
        ↓ 上下文明确仍属同一项目
【异构算力平台】【产品设计】设计容器创建页面
```

**项目切换**（§17）应创建新 WorkItem；原 WorkItem **不因项目切换而自动结束**。

**同一项目下可有多个工作类型**（§18）—— 项目相同不代表 WorkItem 相同：

```text
【异构算力平台】【需求梳理】整理GPU细粒度调度需求
【异构算力平台】【产品设计】设计GPU分配配置页面
【异构算力平台】【方案评审】评审节点资源调度方案
```

### 6.3 低置信度处理（§20）

**不要强行归类**，写入 `pending_items`：

```json
{ "content": "讨论了一个新的页面设计问题", "timestamp": "10:32", "confidence": "low" }
```

用户可随时用 `/analyze` 做后续分析。

本地判定规则（`lib/activity-engine.js`）：

| 场景 | 判定 |
|---|---|
| 判断缓存命中 | `attach`（零 Token） |
| 只有 1 个进行中事项且共享关键词 | `attach` |
| 只有 1 个进行中事项、无关键词交集 | `queue`（疑似新主题） |
| 多个进行中事项 | `queue`（本地无法判定） |
| 与最近暂停事项共享关键词 | `attach` 并自动恢复 |
| 完全无法匹配 | `queue` |

---

## 7. 手动记录（§21/§22）

```text
/start <事项>   /pause   /resume   /done   /log <时间范围> <事项>   /edit <work_id>
```

```text
/log 14:00-14:40 项目会议
        ↓
start_time = 14:00 · actual_duration = 40 分钟 · source = manual
```

只给开始时间时 `actual_duration = null` 并置 `needs_confirmation`，**不得猜测结束时间**。

### 7.1 手动明确指定项目与工作类型（§22）

```text
/start 【异构算力平台】【需求梳理】完善GPU调度需求
/start 异构算力平台：完善GPU调度需求
```

解析为：

```text
project_name = "异构算力平台"
work_type   = "需求梳理"
content     = "完善GPU调度需求"
```

对应 CLI：

```bash
node scripts/write-work-item.js --content "【异构算力平台】【需求梳理】完善GPU调度需求" --start 10:10
node scripts/write-work-item.js --content "异构算力平台：完善GPU调度需求" --start 10:10
node scripts/write-work-item.js --content "设计容器创建页面" --project "异构算力平台" --work-type "产品设计"
```

解析优先级：内联 `【】` > 冒号 > 显式 `--project` / `--work-type` 参数。
`14:00-14:40 项目会议` 这类时间前缀不会被误判为项目。
项目无法确定时只写 `【工作类型】事项内容`（§21）。

### 7.2 事项内容优化（§27）

可以把口语化描述整理为简洁规范的事项（例如「把GPU配置页面的需求重新整理一下，然后补充一下
节点选择的逻辑」→「完善GPU配置页面及节点选择逻辑」），但**不得扩展成用户没有实际完成的工作**。

---

## 8. 空闲检测（§21/§54）

超过 `idle_threshold_minutes`（默认 30）没有活动时：

```text
标记 possible_idle
不得直接认定「工作结束」
```

后续由 AI 或用户确认。

---

## 9. 隐私与安全

采集内容的约束、脱敏规则与访问边界见 `references/security.md`。
要点：Activity 先过 Security Filter；只访问用户指定的日志目录；不触碰磁盘/浏览器/剪贴板/凭据。
