# 项目与工作类型判定

> `SKILL.md` 只保留两条硬约束（**不猜项目**、**不虚构工作量**）。
> 本文档承载完整判定链路：来源、优先级、取法、联网对齐、易错点。

---

## 1. WorkItem 必须保留结构化字段

除 `content` 外，还必须保留两个**结构化**字段，并生成展示内容：

```json
{
  "project_name": "异构算力平台",
  "project_confidence": "high",
  "work_type": "需求梳理",
  "work_type_confidence": "high",
  "content": "完善GPU细粒度调度需求规格说明书",
  "display_content": "【异构算力平台】【需求梳理】完善GPU细粒度调度需求规格说明书"
}
```

展示格式：

```text
有项目：【项目名称】【工作类型】事项内容
无项目：【工作类型】事项内容
```

**禁止只保存格式化后的字符串而丢失结构化字段。**

---

## 2. 两条硬约束

1. **项目名称禁止猜测**：只有 `high` 或经上下文充分确认的 `medium` 才能写入；
   `low` 一律 `null`。无法确定项目时记为 `【工作类型】事项内容` 或进入
   `needs_confirmation`，**不得为了格式完整而编造项目名**。
2. **不得虚构用户未做过的工作**：事项内容可以轻度整理（简洁、可读、去口语化），
   但不能扩写成用户实际没完成的事。

**项目名一律来自宿主工具里已经建好的项目，不去解析对话内容推断。**

---

## 3. 来源与匹配顺序

项目来源：用户明确描述 / 当前会话上下文 / **宿主工作目录** / 用户手动指定。

```text
当前进行中 → 最近暂停 → 项目上下文匹配 → 工作类型匹配 → 语义匹配 → 高置信度新事项 → 低置信度 Pending
```

---

## 4. 项目来源①：WorkBuddy 空间项目（主链路）

WorkBuddy 的「项目」是**空间里的项目实体**，id 形如 `p_<hex>`。
名称由**服务端下发**（`/console/as/projects/<id>/…`），**本地不落地** ——
因此项目名需要在配置里给出。

但本地 SQLite 保存了归属关系，而宿主 Hook 恰好传 `session_id`：

```text
Hook 的 session_id ──→ workbuddy.db 的 sessions 表 ──→ project_id (p_xxxx)
                                                    └─→ config.project_map["p_xxxx"] → 项目正式名
```

`readSessionProjectIndex()` 只读 `workbuddy.db`（`node:sqlite` readOnly，WAL 下安全；
不可用即静默降级），产出 `session_id → project_id`。

配置（键是 **project_id**，不是文件路径）：

```json
"project_map": {
  "p_02902461c2504d1891f7571f95523cbd": "粤企知",
  "p_62ff1b7517ae450fada28a2205c7002b": "数字国资",
  "p_9cbc8f62ec044c5b8059b6724a698ae5": "异构算力",
  "p_7809e51197b84f9389519d2a07526188": "SCUT",
  "p_c7f5b736fb844361802712616eef6429": "物联管控",
  "p_ff834e75564f4baab995b39ace8c38b5": "中大气象"
}
```

`source` 记为 `space_project`，置信度 `high`。
关联到空间项目但未配名称时记为 `space_project_unmapped` ——
**保留 `project_id` 但不编造名称**。

> **为什么不用文件路径**：一个空间项目可覆盖多个工作目录
> （同一 project_id 下出现过 `云浮门户2609\原型` 与 `数字国资\…`），
> 路径无法表达「项目」，而 project_id 可以。

### 4.1 两阶段：采集用本地映射，总结时联网对齐

空间项目名由服务端下发、**本地拿不到**（已逐一排查 DB / 项目资源 / Local Storage /
HTTP 缓存 / 日志）。因此采用**两阶段**，兼顾「采集零延迟」与「名称权威」：

```text
① 采集阶段（Hook 热路径）—— 只查本地，零联网
   session_id → project_id（workbuddy.db）
              → 名称：config.project_map 覆盖 → 本地缓存 space-projects-cache.json
   ├─ 有名称 → 直接写入记录（space_project）
   └─ 无名称 → 保留 project_id，登记为待命名（不猜、不阻塞）

② 总结阶段（/summary、material、draft）—— 才联网
   对本日志中带 project_id 的条目调用线上接口取权威名称
   → 补全缺失的、校正不一致的 → 更新日志记录 → 再产出总结
```

**线上接口**（只读 GET）：

```text
GET https://copilot.tencent.com/console/as/projects    → 全量 projectId → name
需要：Authorization: Bearer <JWT> + x-user-id + x-project-id
```

凭据来自**该项目自己的会话日志**（`~/.workbuddy/logs/<日期>/<会话名>__<hash>.log`，明文可取）。
实现要点（`scripts/lib/space-projects.js`）：

| 要点 | 说明 |
|---|---|
| 只读线上 | 模块只发 GET、只写自己的缓存文件，不改日志数据 |
| token 不外泄 | 任何输出 / 日志 / 错误信息都不包含 token |
| 必须绕代理 | 本机 `HTTPS_PROXY` 指向本地代理会把该请求打成 404 → curl 加 `--noproxy *` |
| 路径带 `/console` | 实测正确路径是 `/console/as/projects`（少了会 404） |
| 缓存守卫 | 缓存 10 分钟内有效且范围可解析时**不再联网** |
| 失败不阻断 | 401 / 超时 / 离线 → 沿用本地映射与缓存，总结照常产出 |
| 重试 | 接口偶发空响应，内置 3 次重试 |

**作用范围**：只处理带 `project_id` 的条目 —— **非项目工作不记录项目名称**。

> **未命名的空间项目不得用目录名顶替**：回退到目录推导只在
> 「会话未关联任何空间项目」时发生。

### 4.2 会话级项目归属（`Conversation.project`，V3.4）

同一套解析也必须作用于**会话**，否则「按项目看 Token」永远是空表：

```text
sessions.project_id ──→ lib/project-resolver.js ──→ Conversation.project
                          ├── config.project_map[pid]        high  space_project
                          ├── space-projects-cache.json[pid]  high  space_project
                          ├── 都没有 → project = null，但**保留 project_id**
                          └── 且 project_source = 'space_project_unmapped'
```

无 `project_id` 时，才回退到宿主项目目录（`projectFromCwd`）。

会话记录额外落三个**溯源字段**，用来回答「这个 `project` 为什么是现在这个值」：

```text
project_id           空间项目 id（名称拿不到也要留，后续 project --sync 可补名）
project_source       space_project / project_map / host_project /
                     space_project_unmapped / cwd_unregistered / none
project_confidence   high / medium / low / null
```

**真实边界**：WorkBuddy 自身的时间戳工作区（`D:\workBuddy\<时间戳>`）
在 `sessions` 表里 `project_id` 就是 `null` —— 这类会话的 `project`
只能是 `null`，并记为 `cwd_unregistered`。**这是事实，不是缺陷。**

实现：`lib/project-resolver.js`（唯一入口）· 回归：`test-activity-link.js`

**命令**：

```bash
collect-activity.js project --list                   # 检测到的空间项目与命名状态
collect-activity.js project --sync                   # 手动联网同步（写缓存 + 回填）
collect-activity.js project --id p_xxx --name 名称    # 用固定名称覆盖（写入 project_map）
daily-summary.js material --no-online                # 离线场景：跳过联网对齐
```

**实测（本机 8 个空间项目）**：

```text
p_32e95811a6f24fd49353cf56d6b44d7e → 云浮门户
p_ff834e75564f4baab995b39ace8c38b5 → 气象数据
p_02902461c2504d1891f7571f95523cbd → Yqz
p_7809e51197b84f9389519d2a07526188 → SCUT
p_62ff1b7517ae450fada28a2205c7002b → 数字国资
p_9cbc8f62ec044c5b8059b6724a698ae5 → 算力平台
p_c7f5b736fb844361802712616eef6429 → 物联设备智能管控系统
p_12f8a9782b3346ad80f10df1dca57510 → 异构算力系统
```

> 由目录名推断会出错：`招投标事宜\异构算力` 实际属于 **算力平台**、
> `云计算平台\4-使用说明书` 实际属于 **异构算力系统**。**必须以线上为准。**

---

## 5. Codex 本地项目与宿主目录回退

Codex 不使用 WorkBuddy 的线上空间项目，但 Desktop 在本机保存了正式项目实体：

```text
<CODEX_HOME>/state_5.sqlite
  ├── projects(id, name, ...)
  ├── project_roots(project_id, position, path)
  └── threads(id, cwd, project_id, ...)
```

解析顺序：

```text
① config.project_map[cwd] 最长前缀匹配                   high  project_map
② threads.project_id -> projects.name                  high  codex_project
③ cwd 对 project_roots.path 最长前缀匹配                high  codex_project_root
④ 未命中 -> 回退 ~/.codex/config.toml 的 [projects.'<路径>']
⑤ 仍未登记 -> null，不猜
```

Codex 的 `project_id` 是 UUID，**不得**交给 WorkBuddy 的 `p_<hex>` 空间项目解析器；
两类宿主必须走 typed resolver。WorkBuddy 的会话工作目录仍读取
`~/.workbuddy/app/sessions.json`。

`readHostProjects()` 读取的是目录级回退清单；Codex 的正式名称由
`scripts/lib/codex-project-resolver.js` 只读本地 SQLite 解析。

**解析优先级**（`projectFromCwd()`）：

| 优先级 | 依据 | 置信度 | `project_source` |
|---|---|---|---|
| ① | `project_map[project_id]`（空间项目，来自 session_id） | `high` | `space_project` |
| ② | `project_map[cwd]` 最长前缀匹配（用户确认的正式名） | `high` | `project_map` |
| ③ | 命中宿主已建项目目录 → 用项目目录名 | `high` | `host_project` |
| ④ | 未登记 → **`null`，不猜** | — | `cwd_unregistered` |

**项目名取法**（`projectNameFromDir()`）：优先取「通用根目录」的**下一段** ——
宿主里项目常按 `<根>/<项目名>/<阶段>/<子目录>` 组织，取末段会得到阶段或子目录：

```text
E:/work/项目文档/粤企知/第三期/1-需求管理        → 粤企知        （而非 1-需求管理）
E:/work/项目文档/数字国资/基金金融/…/202609      → 数字国资      （而非 202609）
E:/work/项目文档/云浮门户2609/原型               → 云浮门户2609
d:/codex/2026-09-20/system-config-html          → system-config-html（无根标记，取末段）
```

通用根标记：`项目文档` `项目` `文档` `资料` `projects` `repos` `works` `code`。

**路径比较大小写不敏感** —— Windows 路径不区分大小写，
`e:/work/项目文档/云浮门户2609` 与 `E:/work/...` 必须命中同一条映射。

**无意义目录段会被跳过**，找不到就返回 `null`：

```text
构建/工具目录     node_modules  dist  src  build  .git  docs
操作系统层级      Users  User  home  data  mnt  volumes  AppData  以及盘符 C: D:
通用容器目录      项目文档  文档  work  projects  code  dev  soft
时间戳工作区      2026-09-20-10-24-52        ← WorkBuddy 工作区就以时间戳命名
纯数字 / GUID     12345678   0a1b2c3d-...
```

实测（真实宿主清单，共 27 个项目）：

```text
E:/work/项目文档/云浮门户2609/原型        → 云浮门户系统      [high] project_map
E:/work/项目文档/中大气象                → 中大气象系统      [high] project_map
E:/work/项目文档/粤企知/第三期/1-需求管理  → 粤企知           [high] host_project
<USER_HOME>/WorkBuddy/2026-09-20-…    → null             [cwd_unregistered]
```

> **不猜项目名，但不丢项目线索。** 采集到的条目始终保留 `project_context`（原始工作目录），
> 即使未能确定项目名，后续 `/analyze` 归类时也不会丢失上下文。

**测试**：`node scripts/test-project-inference.js`（21 个边界用例，退出码非 0 即偏差）。
新增宿主来源或改名规则后必须重跑。

### 正式项目名映射（可选覆盖）

宿主清单提供的是**目录名**。要使用项目正式名称时，配置映射（置信度仍为 `high`）：

```json
"project_map": {
  "E:/work/项目文档/云浮门户2609": "云浮门户系统",
  "E:/work/项目文档/中大气象": "中大气象系统"
}
```

映射用**最长前缀匹配**，因此子目录（如 `<项目>/原型`）自动命中同一条映射。

---

## 6. ⚠️ 宿主系统通知的优先级（易错点）

`UserPromptSubmit` 通道会混入宿主的**系统通知**（任务完成回执、后台命令输出）：

```text
<task-notification><task-id>…</task-id><status>completed</status><summary>…</summary>
```

两条防线，缺一不可：

1. **采集层** `isWorkActivity()` 拒绝 → 根本不入库
2. **总结层** `classify()` 中 `HOST_NOTICE_RE` 判断放在「手动记录」「有项目名」等
   放行规则**之前** —— 因为通知内容里可能含项目路径（例如 summary 里带了
   `E:/work/项目文档/…`），一旦被赋了 `project_name`，"有项目名即真实事项"的规则
   会让它**绕过噪声过滤**。

> 这个坑是真实踩到的：回填项目名时，一条通知因内容含项目路径被赋了项目名，
> 随即从「被过滤」变成「进入总结」。**高置信度噪声必须独立于来源与项目判定。**

---

## 6.1 项目名决定「工作」还是「探索沉淀」（V3.6）

用户 2026-09-24 明确：**同一个人的探索项目与业务项目必须分开算**。

```text
命中任一 → category = 探索沉淀
  ① config.work.exploration_projects 白名单（双向包含，容忍简写）
  ② 项目名本身命中工具词表：skill / 技能 / hook / 工作流 / 自动化 /
     agent / 适配器 / adapter / cli / mcp / 插件 / 工具链 / 本技能 / 记录工具

其它具名项目 → category = 工作
无项目       → 才看内容关键词（探索沉淀关键词 → 个人成长 → 工作）
```

```text
为什么把项目归属抬到内容关键词之前：
  同一个人既会「为工作做需求分析」，也会「为 skill 做需求分析」，
  只靠措辞判断必然把 AI 能力建设误判成工作 —— 这正是用户反馈的
  「总结总偏开发视角、看不出我的实际工作内容」。
  项目名是可核对的证据，比措辞可靠；判定依据与优先级见
  `lib/role-profile.js` 的 `categoryOf()`，可用 `test-role-profile.js` 复核。

✗ 探索沉淀不得进入「工作」块，也不参与 PM 阶段 / 交付物口径。
```

## 7. 命令用法

```bash
# 内联写法（推荐，一次写全）
node scripts/write-work-item.js --content "【异构算力平台】【需求梳理】完善GPU调度需求" --start 10:10

# 显式参数
node scripts/write-work-item.js --content "设计容器创建页面" --project "异构算力平台" --work-type "产品设计" --start 13:00

# 项目上下文继承：auto 只接受 medium 及以上的建议，无上下文时保持 null
node scripts/write-work-item.js --content "设计容器创建页面" --project auto --work-type auto --start 13:00
```

`--project auto` / `--work-type auto` 的判定依据：

- 当前**唯一**进行中事项有项目 → 继承该项目（`medium`，理由「继承当前唯一进行中事项的项目」）
- 多个进行中事项分属不同项目 → 不继承，返回 `low` 并说明「不得猜测项目名称」
- 无可用上下文 → `null`

`--project` / `--work-type` 也可用于 `update-work-item.js edit` 与
`collect-activity.js apply`（批量判定后回写）。

---

## 8. 相关文档

| 文档 | 内容 |
|---|---|
| `references/data-schema.md` | Work Activity 字段定义 |
| `references/daily-summary.md` | 总结层的过滤与合并规则 |
| `references/config-reference.md` | `project_map` / `role` 等配置项 |
