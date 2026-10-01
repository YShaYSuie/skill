#!/usr/bin/env node
'use strict';
/**
 * aggregate-logs.js — Structured Logs 的**唯一**统计入口（用户 §十二/§二十六）。
 *
 * ## 定位
 *
 * ```text
 * ✗ 统计不能让 AI 读日志去算
 * ✓ 统计由脚本读 Structured Logs 完成，AI 只负责「解读与撰写」
 * ```
 *
 * Token / Score / Skill 次数 / 工作时长这些**确定性**统计全部落在本脚本，
 * 零 LLM 调用、零 token 成本。`daily-summary.js` 的 AI 章节也复用同一份汇总
 * （内部走 `lib/metrics-engine.js`），确保「复盘看到的数字」与「这里算出来的数字」
 * 永远一致 —— 同源，不重复实现。
 *
 * **只读 Structured Logs**（`logs/<date>/{conversations,skill-usage,work-activities}.jsonl`），
 * 不会重新扫描历史 Conversation、不会重算 Token 或 Score。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/aggregate-logs.js                     # 今天
 * node scripts/aggregate-logs.js 2026-09-20          # 指定某天
 * node scripts/aggregate-logs.js --days 7            # 最近 7 天（含今天）
 * node scripts/aggregate-logs.js --from 2026-09-01 --to 2026-09-21
 * node scripts/aggregate-logs.js --days 30 --json    # 机器可读
 * ```
 */

const C = require('./lib/log-core');
const CS = require('./lib/conversation-store');
const ME = require('./lib/metrics-engine');

const USAGE = `aggregate-logs.js — Structured Logs 统计（只读，零 AI 调用）

  位置参数：  <YYYY-MM-DD>            统计该天（默认今天）

  --from <YYYY-MM-DD> --to <YYYY-MM-DD>   统计区间
  --days <n>                              最近 n 天（含今天）
  --json                                  输出 JSON
  --dir <路径>                            日志目录

  数据源：logs/<date>/{conversations,turns,skill-usage,work-activities}.jsonl
  不读取 raw/、不重新解析历史 Conversation、不重算 Token / Score。
`;

const shiftDate = (date, deltaDays) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${C.pad(d.getMonth() + 1)}-${C.pad(d.getDate())}`;
};

function run() {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);

  const from = C.flagStr(flags, 'from');
  const to = C.flagStr(flags, 'to');
  const days = C.flagNum(flags, 'days');
  const positional = pos[0] && pos[0] !== 'help' ? pos[0] : null;

  let metrics;
  let mode;

  if (from || to) {
    const f = CS.assertDate(from || to);
    const t = CS.assertDate(to || from);
    if (f > t) throw new C.LogError(`--from（${f}）不能晚于 --to（${t}）。`);
    metrics = ME.buildMetricsRange(dir, f, t);
    mode = 'range';
  } else if (days !== null && days !== undefined) {
    if (!(days >= 1)) throw new C.LogError('--days 必须 ≥ 1。');
    const today = C.today();
    const f = shiftDate(today, -(Math.floor(days) - 1));
    metrics = ME.buildMetricsRange(dir, f, today);
    mode = 'days';
  } else if (positional) {
    metrics = ME.buildMetrics(dir, CS.assertDate(positional));
    mode = 'single';
  } else {
    metrics = ME.buildMetrics(dir, C.today());
    mode = 'single';
  }

  // 明确标注数据边界，避免被误读为「扫了全部历史」
  metrics.mode = mode;
  metrics.sources = [
    CS.logPath(dir, 'conversation', metrics.from),
    CS.logPath(dir, 'turn', metrics.from),
    CS.logPath(dir, 'skill_usage', metrics.from),
    CS.logPath(dir, 'work_activity', metrics.from),
  ];
  metrics.dates_available = CS.listLoggedDates(dir);

  if (C.flagBool(flags, 'json')) {
    C.emit(metrics);
    return C.EXIT.OK;
  }

  const L = [
    `Structured Logs 统计（${metrics.date}）`,
    '─'.repeat(24),
    '',
    ...ME.renderMetrics(metrics),
  ];
  if (metrics.notes.length) {
    L.push('');
    metrics.notes.forEach((n) => L.push(`· ${n}`));
  }
  C.emitText(L.join('\n'));
  return C.EXIT.OK;
}

C.runMain(() => {
  const { pos } = C.parseArgs(process.argv.slice(2));
  if (pos[0] === 'help') {
    C.emitText(USAGE);
    return C.EXIT.OK;
  }
  return run();
});
