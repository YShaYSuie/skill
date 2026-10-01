# 自检与回归测试

> 本文件用于修改后选择测试与隔离运行环境，不属于每次调用都必须加载的常驻规则。

## 快速自检

```bash
node scripts/validate-log.js [--dir "<log_dir>"] [--strict]
```

该命令只读、零 Token，校验日志结构、字段、脱敏、跨日和时长口径。

## 回归测试矩阵

```bash
node scripts/test-auto-rollover.js             # 新日期记录自动跨日 / pending / dry-run
node scripts/test-conversation-settlement.js   # 幂等 / 禁止摊派 / partial / 去重 / 字段口径
node scripts/test-codex-conversation.js        # Codex rollout 结算 / backfill / latest / 幂等
node scripts/test-skill-receipt.js             # Turn 回执：去重 / 中间快照 / 不串轮 / 兼容
node scripts/test-codex-hooks.js                # Codex Hook 命令 / launcher / 自动修复
node scripts/test-segment-usage.js             # Segment / AI Usage / 未归属 / 自检
node scripts/test-activity-link.js             # 项目归属 / session_id 证据 / 回链幂等 / 端到端
node scripts/test-egress-guard.js              # git 与出网边界
node scripts/test-github-sync.js               # 上传 / 幂等 / 覆盖方向 / 敏感拦截
node scripts/test-summary-engine.js
node scripts/test-project-inference.js
node scripts/test-role-profile.js
node scripts/test-period-summary.js            # 周 / 月 / 项目总结路径
node scripts/test-summary-material-v324.js     # 工作看板 / 能力变化 / 维护折叠
node scripts/test-summary-staleness.js         # 日报过期检测：识别 / 不误报 / 阈值 / 只读
node scripts/test-pending-link.js              # 已跨日事项 / taskId 回写 / 同步状态
node scripts/test-duration-policy.js           # AI 不产出时长 / 不用 now / 时长不变量
node scripts/test-insights.js                  # 模型归一 / 合计边界 / 不摊派 / 歧义
node scripts/test-skill-inventory.js           # 已装未用 / 已部署 / 显式引用识别
```

## 改动与必跑测试

| 改动范围 | 必须重跑 |
|---|---|
| 网络、子进程或出网边界 | `test-egress-guard.js` |
| 宿主来源或改名规则 | `test-project-inference.js` |
| 过滤、合并、角色词表、分类与分组 | `test-summary-engine.js` / `test-role-profile.js` |
| 总结渲染、`renderCostBrief` 参数、日 / 周 / 月 / 项目任一路径 | `test-period-summary.js` |
| 正式总结素材、工作看板、探索沉淀能力变化、维护过滤 | `test-summary-material-v324.js` |
| 日报落盘 / 读取、过期检测、`summaries/<date>.md` 头部 | `test-summary-staleness.js` |
| 项目归属或事项关联链路 | `test-activity-link.js` |
| 已跨日 pending 通路 | `test-pending-link.js` |
| 时长计算、`recalc`、`segMinutes`、`unionMinutes`、`duration_source` | `test-duration-policy.js` |

## 测试隔离

测试必须使用隔离目录，并通过 `WORK_TIME_TRACKING_DIR` 与重定向 HOME 避免污染真实日志。
优先采用进程内调用；受限沙箱可能禁止 Node 派生 Node，纯子进程测试可能产生假失败。

**进程内调用优先（V3.27 起）**：受限沙箱实测 `spawnSync(process.execPath, …)` 直接报
`EBUSY`，走 CLI 的测试会整片假失败（`exit=null`），把「环境问题」误读成「代码坏了」。
纯计算类逻辑（如过期检测）应 `require` 目标脚本、直接调函数断言返回值。
为此 `daily-summary.js` 已用 `C.runMain(fn, module)` 加守卫并导出纯函数 ——
被 `require` 时不会执行 CLI 逻辑，也不会污染调用方的 `process.exitCode`。
