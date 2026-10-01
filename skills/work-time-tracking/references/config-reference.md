# 配置参考（config）

> **配置独立管理** —— 所有可调参数集中在此，**不硬编码在 `SKILL.md` 说明文字里**。
> 本文档是配置项的完整定义；`SKILL.md` 只保留少量与结构相关的键。

---

## 1. 文件位置与形态（重要）

本技能的配置**不是** YAML，而是 **JSON**，且分两处：

| 角色 | 路径 | 说明 |
|---|---|---|
| **模板** | `<skill>/templates/config.json` | 随技能分发，`init-log.js init` 时作为默认值来源 |
| **生效配置** | `<log_dir>/config.json` | **实际生效的文件**，由 `init-log.js` 写入，用户直接编辑这里 |

```text
<log_dir>/config.json   ← 改这里才会生效
```

读取与归一化：`scripts/lib/log-core.js` 的 `normalizeConfig(raw, dir)`。

> **为什么不用 YAML**：本技能全部脚本是零依赖 Node.js，内置 `JSON.parse` 可直接读取配置。
> 引入 YAML 需要额外解析器（新依赖）或手写解析（新故障面），
> 且会让「模板」与「生效配置」两份文件格式分叉 —— 收益为零、风险为正。
> 因此**沿用 JSON**，但把结构按下方 YAML 等价格式整理清楚，便于阅读与编辑。
>
> 同理，`config/` 目录**不再新增副本** —— 模板与生效配置已有明确定位，
> 再加一个 `config/config.yaml` 就是**第三个事实源**，属于本技能明确拒绝的过度设计。

---

## 2. 完整配置（YAML 等价视图）

> 下列为**语义视图**，便于阅读。实际文件请写 JSON（见 §1）。

```yaml
log_directory: ""            # 日志目录，留空则用 init 时传入的 dir
timezone: "+08:00"           # 留空取本机时区

tracking:
  enabled: true
  auto_tracking: true
  idle_threshold_minutes: 30

host_events:                 # 决定采集哪几类 Activity
  enabled: true
  capture_user_interaction: true
  capture_tool_activity: true
  capture_file_activity: true
  capture_session_lifecycle: true

ai:
  enabled: true
  auto_analysis:             # 宿主自动任务 / 事件触发的 AI 分析
    enabled: true
    batch_interval_minutes: 20
    cooldown_minutes: 10
    safety_max_calls_per_day: 50   # 保护阈值，不是目标调用量
    max_context_items: 20
    enable_cache: true
    batch_max_pending: 5
  manual:                    # /analyze、/summary —— 不受安全熔断限制
    enabled: true
    unlimited: true

summary:
  enabled: true
  auto_scheduled: false

sync:
  enabled: true
  skill: "ticktick-work-review"
  realtime: false            # 强制 false，禁止实时同步
  auto_scheduled: false

log:
  keep_days: 1               # 只管 current.json 的一天一档
  protect_unsynced: true

settlement:                  # 对话结束结算
  enabled: true
  auto_on_conversation_end: true
  skill_token_method: injection   # injection | off —— 没有第三种
  token_per_char: 0.28            # 字符 → token 系数（实测值）
  score_enabled: true
  write_raw_snapshot: true        # 落盘 raw 快照，供重新解析
  capture_work_activities: off    # 保留兼容；正常不应开启（见 §4）

storage:                     # 三层存储生命周期
  structured_log_retention: permanent
  raw_log:
    enabled: true
    retention_days: 7
  daily_summary:
    retention: permanent

github:                      # Structured Logs 远端归档
  enabled: false             # ⚠️ 默认关闭
  repository: worktimeLog
  visibility: private        # 只接受 private
  sync_days: 1
  sync_raw_logs: false       # 默认不上传 Raw
  work_directory: ""         # 留空则用 <log_dir>/.github-sync
  remote: origin
  branch: main
  commit_message: "chore(logs): sync {date}"

daily_summary:
  enabled: true

ticktick:
  enabled: true

project_map: {}              # 工作目录 / project_id → 项目正式名
role: {}                     # 角色画像，见 references/daily-summary.md §6

work:                        # V3.3：三个归因维度的合法取值（可扩展，不强制填写）
  categories:                # 事项分类
    - 工作
    - 探索沉淀               # V3.6：AI 工具 / Skill / MCP / 提示词建设（个人方向）
    - 生活
    - 个人成长
    - 健康运动
    - 休闲娱乐
    - 其他
  exploration_projects: []   # V3.6：探索类**项目白名单**（补充「名字里没有工具词」的探索项目）
  exploration_keywords: []   # V3.6：留空则用内置 AI/工具向关键词表（skill / hook / mcp / 提示词 …）
  work_types:                # 工作类型（产品经理口径 + V3.5 通用扩展项）
    - 产品规划
    - 需求分析
    - 需求沟通
    - 需求文档
    - 竞品/行业研究
    - 产品设计
    - 原型设计
    - 交互设计
    - 数据分析
    - 项目管理
    - 研发协作
    - 测试验收
    - 上线发布
    - 问题处理
    - 产品运营
    - 产品复盘
    - 会议
    - 方案设计
    - PRD编写
    - 技术沟通
    - 开发协作
    - 测试验证
    - 资料查询
    - 其他工作
  project_stages:            # 项目阶段
    - 需求阶段
    - 设计阶段
    - 开发阶段
    - 测试阶段
    - 上线阶段
    - 运营/迭代阶段
    - 需求分析
    - 方案设计
    - 交互设计
    - 原型设计
    - PRD编写
    - 技术沟通
    - 开发协作
    - 测试验证
    - 问题排查
    - 上线发布
    - 运营维护
    - 其他

security:                    # 安全边界，fail-closed
  strict_mode: true
  allow_browser_access: false
  allow_clipboard_access: false
  allow_password_manager_access: false
  allow_full_disk_scan: false
  allow_arbitrary_shell: false
  redact_sensitive: true
  max_activity_length: 200
  max_detail_length: 4000
  ai_summarize: true
  ai_summarize_timeout_sec: 6
```

---

## 3. 关键项的语义与边界

### 3.1 `settlement.skill_token_method` —— 只有两个合法值

```text
injection → 记录 A 口径「Skill 载入体积」= load_chars × token_per_char（精确、可归因）
off       → 一律记 skill_token = null + token_source: "unavailable"
```

**没有第三种。** WorkBuddy 官方不存在 Skill 级 token 口径，因此不接受
「只认官方口径」以外的任何折算方案 —— 任何摊派 / 平均拆分 / 按占比反推都属于违规。

### 3.2 `token_per_char`

字符 → token 的换算系数，默认 `0.28`（实测值）。它只影响 A 口径的**换算呈现**，
不影响 `load_chars` 原始测量值的落库，便于日后复核。

### 3.3 `github` —— 安全默认值不可放宽

| 项 | 行为 |
|---|---|
| `enabled` | 默认 `false`。不配置就**不推送** |
| `visibility` | **写成 `public` 会在归一化时回落到 `private`**（无豁免通道） |
| `sync_days` | 钳制在 `1 ~ 365`；非有限数回落为 `1` |
| `sync_raw_logs` | 默认 `false` —— Raw 含完整对话痕迹且体积大 |
| `remote` | 允许指向**本地裸仓库**，以便离线测试 |

### 3.4 `storage` —— 分层不得越界

```text
structured_log_retention  恒为 'permanent'（不接受其他值）
daily_summary.retention   恒为 'permanent'
raw_log.retention_days    默认 7，钳制上限 3650 天（配成 999999 会让清理形同虚设）
```

> ⚠️ `log.keep_days`（默认 1）**只管 `current.json` 的一天一档**，
> 与 `logs/`（永久）**互不影响**。不要用 `keep_days` 去"清理历史"——
> `logs/` 与 `summaries/` 永久保留，`cleanup-raw-logs.js` 内有硬断言禁止触碰它们。

### 3.5 `security` —— fail-closed

`allow_*` 系列写成 `true` 会被**忽略并回落为 `false`**，自检（`validate-log.js`）
会直接报错。安全项**没有**用户可放宽的通道。

`max_activity_length` 只限制展示内容与 `content`；`max_detail_length` 用于结构化
`detail`，默认 4000，仍会脱敏并在超限时通过 `detail_compression` 留痕。

### 3.6 `ai.auto_analysis` 与 `ai.manual`

```text
auto_analysis.*   自动 AI 分析：受批量窗口、冷却、安全阈值约束
manual.*          手动 /analyze、/summary：**不受** safety_max_calls_per_day 限制
```

> `batch_interval_minutes` / `cooldown_minutes` **不是**「Skill 每 N 分钟运行一次」，
> 而是「宿主**再次触发**本 Skill 时，如何控制 AI 分析频率」。
> 本技能**没有任何定时器**。

达到安全阈值后：自动 AI 分析停止，但 **Activity 继续记录、WorkItem 继续保存、
DailyLog 继续更新**；无法判断的事项进入 `pending_items`，用户仍可手动 `/analyze`。

### 3.7 `project_map`

键可以是**工作目录**（最长前缀匹配）或 **WorkBuddy 的 `project_id`**（形如 `p_<hex>`）。
反斜杠会被统一为 `/`。详见 `references/project-inference.md`。

### 3.8 `role`

角色画像，决定日报按什么职业视角组织。`enabled: false` 时完全退化为通用总结。
详见 `references/daily-summary.md` §6。

### 3.8b `ai.model_aliases` / `ai.record_summarize_threshold_chars`（V3.6）

```yaml
ai:
  model_aliases:                    # 模型名归一：原始 model_name → 统一展示名
    "custom-local:deepseek-v4-flash": "DeepSeek-V4 Flash"
    "deepseek-v4-flash": "DeepSeek-V4 Flash"
  record_summarize_threshold_chars: 120   # 事项内容 ≤ 该长度按原文入库，超长才由 AI 摘要
```

```text
模型归一顺序：显式别名 → 去 provider 前缀（custom-local: / local: …）→ 小写去分隔符
未配别名也能归并；配别名是为了让展示名可读、可控（如 fast-model → 快速模型）
```

### 3.8c `summary.insights`（V3.6）

```yaml
summary:
  insights:
    enabled: true          # false 时 `/insights` 直接返回「已关闭」，不做任何计算
    stale_days: 30         # 「曾经用过但长期未调用」的判据
    top_n: 5               # 高频 Skill 榜单长度
    skill_roots: []        # 盘点「已装 / 已部署」的目录；留空 = 内置默认
```

```text
skill_roots 留空时的默认扫描范围：
  <home>/.skills-manager/skills （已安装）  <home>/.codex/skills （部署到 Codex）
  <home>/.workbuddy/skills      （部署到 WorkBuddy）  <home>/.claude/skills
只读文件系统，不读数据库、不起子进程、不出网；目录不存在时如实标注 exists=false。
```

### 3.8d `summary.stale_conversation_threshold`（V3.27）

```yaml
summary:
  stale_conversation_threshold: 3   # 日报生成后新增多少个 Conversation 才提示「建议重新生成」
```

```text
口径：日报已落盘 ∧ generated_at < 当日最后结算时间 ∧ 其后新增会话数 ≥ 本阈值 → 判为过期。
缺省 3；非数字 / 小于 1 → 回退 3（fail-safe，不抛错、不阻断总结）。
判定只报不改：不触发重新生成、不写文件。详见 references/daily-summary.md §3.2a。

⚠️ 本键已在 normalizeConfig 白名单中登记。新增同类配置项必须同步登记 ——
   白名单会**静默丢弃**未登记的键，用户写了也不会生效。
```

### 3.9 `work` —— 三个归因维度的合法取值（V3.3）

```text
config.work.categories       事项分类   → Work Activity 的 category
config.work.work_types       工作类型   → Work Activity 的 work_type
config.work.project_stages   项目阶段   → Work Activity 的 project_stage
config.work.exploration_projects / exploration_keywords
                             V3.6：判定「探索沉淀」的项目白名单与关键词表
```

**分类归属优先级（V3.6，`role-profile.categoryOf()`）**：

```text
显式 category > 生活类强信号（运动/休闲/生活）> 项目归属 > 内容关键词

· 项目命中 exploration_projects 或项目名含工具词（skill/hook/MCP…）→ 探索沉淀
· 其它具名项目 → 工作
· 无项目时才看关键词：探索沉淀关键词 → 个人成长 → 工作
· 探索沉淀**不得**进入「工作」块，也不参与 PM 阶段/交付物口径
· V3.24：探索沉淀可写 output（描述用户可感知能力变化）；project_stage 仍只允许工作
```

**扩展方式与合并规则**：

```text
1. 想新增取值 → 直接编辑 <log_dir>/config.json 的 work.* 数组，不需要改代码。
2. 归一化时 **默认清单始终并入**（`normalizeWorkEnums()`）——
   删掉某一项并不能让它变成非法；要真正移除只能改代码里的默认清单。
3. 旧版顶层 `work_types`（V3.1/V3.2 写法）**仍然生效**，
   与 `work.work_types` **合并去重**，一份数组两种读法（向后兼容）。
4. `config.work_types` 与 `config.work.work_types` 在归一化后指向**同一份数组**。
```

**写入时校验（fail-fast）**：

```text
✗ --category 写了不在 categories 里的值 → 直接报错并列出合法取值
✗ --project-stage 写了不在 project_stages 里的值 → 直接报错
（宁可当场报错，也不让一个错拼的分类污染后续所有按分类的统计）
```

> `--category auto` / `--project-stage auto` 表示**接受本地关键词建议**；
> 命中不到就留 `null`（**不猜**）。建议只用于本次写入，**不会自动写回 config**。

**`work.work_types` 的默认口径**是产品经理视角的 18 项。
若用户不是产品经理，直接替换该数组即可（总结里的分组会落到「其他」，
不影响时间与 Token 统计的正确性）。详见 `references/daily-summary.md` §6。

---

## 4. ⚠️ 已移除 / 不应启用的配置项

| 项 | 状态 | 原因 |
|---|---|---|
| `settlement.capture_work_activities: prompts` | **保留但不应开启** | 会把用户输入兜底登记为候选事项，与事件管线（Hook → collect-activity → pending → AI 归类）**重复记账** |
| `settlement.retain_days` | **已移除** | 曾表示「0 = 只保留当天」，与「`logs/` 永久保留」直接矛盾，且无任何消费者 |
| `log.archive_enabled` | **已移除** | 属旧「current.json 历史备份」模型；历史现由 `logs/` 与 `summaries/` 承担，再存 `archive/` 就是第三个副本 |
| 顶层 `work_types` | **保留但不推荐新写** | V3.1/V3.2 的写法；现在应写进 `work.work_types`（旧写法仍合并生效） |

> 新增配置项时：必须同时更新 ① `normalizeConfig` ② `templates/config.json`
> ③ 本文档 ④ `scripts/test-egress-guard.js` 的相关断言（若涉及安全默认值）。

---

## 5. 相关文档

| 文档 | 内容 |
|---|---|
| `references/data-model.md` | `config.json` 在数据模型中的位置 |
| `references/settlement.md` | `settlement.*` 对应的结算机制 |
| `references/github-sync.md` | `github.*` 对应的归档行为 |
| `references/security.md` | `security.*` 对应的安全边界 |
| `references/daily-summary.md` | `role` / `summary` / `work.work_types` 对应的日报口径 |
| `references/cost-statistics.md` | `settlement.*` 与归因维度如何影响成本统计 |
