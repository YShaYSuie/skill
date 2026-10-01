# 状态查询与宿主触发状态（§56/§57）

`/status` 与 `/security` 都是**零 Token 操作**（§36）：只读本地文件与本地规则，不调用 AI。

---

## 1. 必须区分三种状态（§57）

**不能把「Skill 已安装」理解为「自动记录已启动」。** 必须分别显示：

```text
Skill 状态
宿主触发状态
日志记录状态
```

示例：

```text
Skill：🟢 已安装
Codex 自动触发：🟢 已配置
工作记录：🟢 正在记录
```

或者：

```text
Skill：🟢 已安装
Codex 自动触发：🔴 未配置
工作记录：🟡 等待手动触发
```

原因见 `references/trigger-adapters.md` §2：Skill 不是后台服务，
自动记录依赖宿主是否配置了 Hook / Event。

---

## 2. 状态判定依据

不能仅因为 `auto_tracking = true` 就显示 🟢。必须检查链路：

```text
配置 → Host Adapter → 日志目录 → current.json → 最近活动 → WorkItem
```

| 显示 | 含义 |
|---|---|
| 🟢 **正在记录** | 已检测到有效 Activity，并成功写入日志 |
| 🟡 **已开启但暂无活动** | 功能已开启，但近期没有检测到有效 Activity（或宿主触发未配置，等待手动触发） |
| 🔴 **记录异常** | 日志无法写入 / 权限异常 / Adapter 异常 / 文件锁异常 / 数据损坏，**必须说明原因** |
| ⚪ **未开启** | `auto_tracking=false` 或运行状态为 paused / disabled / initializing |

判定顺序（`computeStatus`）：

```text
未初始化                        → ⚪ 未开启
存在基础设施问题                 → 🔴 记录异常（逐条列出 reasons）
auto_tracking=false 或运行暂停   → ⚪ 未开启
没有任何宿主处于 recording       → 🟡 已开启但暂无活动
否则                            → 🟢 正在记录
```

🔴 的 reasons 覆盖：目录不存在/不可读/不可写、manifest 不属于本技能或无法解析、
`current.json` 不存在或无法解析、存在未释放的锁、`pending/writes` 有待重放写入。

---

## 3. `/status` 输出（§56）

```text
工作时间自动记录
────────────────────

Skill：
🟢 已加载

自动记录：
🟢 正在记录

宿主触发：🟢 已配置

触发来源：
Codex Hook / Event

Codex：🟢
  采集机制 hooks　宿主触发已配置

手动：○（/start、/log 与自然语言记录，作为人工兜底，§6）

日志目录：
<USER_HOME>\WorkTimeLog
  可读 ✓　可写 ✓　manifest current　log_id log_302984435

今日事项：
8

进行中：
2

待确认：
1

最近活动：
17:32

────────────────────

自动AI：

调用次数：
4 / 50

状态：
🟢 正常

手动AI：
2 次（不受安全熔断限制，§35）

────────────────────

今日总结：
未执行

────────────────────

TickTick同步：
未触发

同步方式：
手动 /sync / 宿主定时任务

同步Skill：
ticktick-work-review

────────────────────

Skill 不是后台服务：不会自行创建进程或定时器。
自动记录依赖宿主 Hook / Event；定时总结与同步由宿主任务触发（§43/§45）。
```

| 字段 | 来源 |
|---|---|
| 今日事项 | `current.json.records.length` |
| 进行中 | `status = in_progress` 的数量 |
| 待确认 | `needs_confirmation` 记录数 + `pending_items` 数 |
| 最近活动 | `state.last_event_time` |
| 自动AI 调用次数 | `state.automatic_ai_calls_today` / `ai.auto_analysis.safety_max_calls_per_day` |
| 手动AI | `state.manual_ai_calls_today`（不受熔断限制） |
| 今日总结 | `current.json.summary`（含触发方式 manual / auto_scheduled） |
| TickTick同步 | `current.json.sync.status` |

```bash
node scripts/status.js --json          # 供自动化读取
node scripts/status.js today           # 状态 + 今日记录
node scripts/status.js check           # 仅结构化检查项
```

---

## 4. 宿主触发状态（§57）

逐宿主展示，依据 `state.hosts` 中登记的 mechanism 与最近活动：

| 情况 | 显示 |
|---|---|
| 未登记或 `mechanism=unknown` | ⚪ 未配置（未配置宿主触发） |
| `mechanism=unavailable` / `available=false` | 🔴 自动采集不可用 |
| `mechanism=manual` | 🟡 仅支持手动触发 |
| `mechanism=hooks/skill` + 近期有活动 | 🟢 正在记录 |
| `mechanism=hooks/skill` + 超过空闲阈值无活动 | 🟡 暂无活动 |

**不能因为 Skill 已安装就认为所有宿主都在被记录。** 有宿主处于 🔴 时，
输出末尾追加提醒行，避免用户误以为全线正常。

登记命令：

```bash
node scripts/status.js host --host codex     --mechanism hooks
node scripts/status.js host --host workbuddy --mechanism skill
node scripts/status.js host --host generic   --mechanism manual
node scripts/status.js host --host other     --mechanism unavailable --available false
```

| mechanism | 含义 |
|---|---|
| `hooks` | 宿主提供生命周期事件 → 自动记录 |
| `skill` | 宿主事件 / Skill 触发 |
| `manual` | 仅手动触发（宿主能力不足，§42） |
| `unavailable` | 自动触发不可用 |

宿主触发能力**只升不降**：已登记为 `hooks` 的宿主，普通写入不会把它降级为 `skill`。

---

## 5. 安全状态（§12/§55）

```bash
node scripts/status.js security
```

输出见 `references/security.md`。同样为零 Token 操作。

> 例外说明：`status.js` 本身永远是零 Token。但**写入链路**上的超长内容压缩
> （`config.security.ai_summarize = true`）会调用线上 LLM，属于 §35 的「AI 自动调用」，
> 计入 `state.automatic_ai_calls_today`（自动采集场景）与 `manual_ai_calls_today`（手动写入场景）。
> 需要完全离线时把 `ai_summarize` 置为 `false`。

---

## 5.1 日志保留与跨日

**先区分两个不同层级的保留期** —— 它们互不影响：

```text
current.json  → log.keep_days = 1（默认）  → 每天一换，只留当天
logs/         → permanent                 → **永久**，跨日不清
summaries/    → permanent                 → **永久**
raw/          → storage.raw_log.retention_days（默认 7 天）
```

`current.json` 是**工作事项**的唯一数据源；日报的 **AI 使用章节**另读当天
`logs/<date>/*.jsonl` —— 两者**互补**，不互相替代
（详见 `references/daily-summary.md` §2）。

**跨日处理**（只针对 `current.json`）：

```text
current.json.date != today
├── 手工 `init-log.js rollover`
│   ├── sync.status = 'success' → 直接覆盖为新日期，不归档、不备份
│   └── 未同步 → 未给 --decision 时退出码 4；--decision keep 转 pending/
└── 收到新日期记录（采集 / 手工新增）
    ├── 先把旧 WorkItem 永久导出到 logs/<date>/work-activities.jsonl
    ├── 未同步 → 旧日志转 pending/<date>.json
    └── 创建当日 current.json，并继续写入本次记录
```

> ⚠️ **合法状态值是 `VALID_SYNC_STATUS = [pending, syncing, success, partial, failed]`。**
> 判定「已同步」只能看 `'success'` —— 曾误写成 `'synced'`，
> 导致已同步日志跨日被误判为「未同步」而转入 `pending/`。
>
> **V3.4.1 起，自动记录路径不再依赖人工执行 rollover。**
> Hook 或手工新增事项收到新日期记录时，会先执行上面的非破坏性跨日处理；
> `--rollover keep` 仅保留为旧 Hook 参数兼容。

用户约定：**已同步的内容不需要在本机留历史备份**；
**未同步的内容不得静默覆盖**，必须先提示用户决定。

> ⚠️ `logs/` 与 `summaries/` **不受 `init-log.js rollover` 影响**，
> 也**不被 `log.keep_days` 约束** —— 跨日换代只针对 `current.json`。
> 历史由 `logs/`（永久）承担；旧模型中的 `archive/` 已于 V3.1 **废弃**。

> **GitHub 归档**：本技能提供 `scripts/sync-github.js`（**默认关闭**），
> 是本技能**唯一**允许执行 git 的地方；Local 是 Source of Truth、**本地覆盖远端**。
> 见 `references/github-sync.md`。

`validate-log.js` 的「无未同步历史日志」检查会列出待同步日期，是覆盖前的最后一道提醒。

---

## 6. 与其它检查命令的分工

| 命令 | 面向 | 内容 |
|---|---|---|
| `status.js` | **用户** | 三态、逐宿主触发状态、今日概览、AI 额度 |
| `status.js security` | **用户** | 访问边界与脱敏状态 |
| `validate-log.js` | **维护** | §50 自检十项 |
| `init-log.js pending` | **维护** | pending / archive / pending-writes / 同步日期 |
| `collect-activity.js pending` | **维护** | 待判断事项与批量分析建议 |

以上全部为只读或本地操作，不修改数据，也不调用 AI。
