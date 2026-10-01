#!/usr/bin/env node
'use strict';
/**
 * cleanup-raw-logs.js — Raw 会话快照的保留期清理（用户 §十九/§二十）。
 *
 * ## 三层存储里的哪一层
 *
 * ```text
 * Raw Conversation  → 短期缓存（storage.raw_log.retention_days，默认 7 天）← 本脚本管这里
 * Structured Logs   → **永久保留**（体积小，是长期历史数据，绝不清理）
 * Daily Summary     → **永久保留**
 * ```
 *
 * Raw 快照只用于**重新解析 / 调试 / 数据恢复 / 错误排查**，不作为日常统计的数据源
 * （统计一律读 Structured Logs）。因此到期即可删除，不会影响任何统计口径。
 *
 * ## 安全设计
 *
 * 清理是**删除**操作，所以：
 *
 * ```text
 * ① 默认 **dry-run** —— 不带 --apply 只列出将要删除的目录，绝不删
 * ② 只允许删除 <log_dir>/raw/<source>/<YYYY-MM-DD>/ 这一种形状
 * ③ 先校验 <log_dir> 确实是本技能的共享日志目录（有 .log-manifest.json）
 * ④ 目录名必须是合法日期，且严格早于截止日（当天与未来一律不动）
 * ⑤ 绝不触碰 logs/ 与 summaries/（有显式断言）
 * ```
 *
 * ## 用法
 *
 * ```bash
 * node scripts/cleanup-raw-logs.js                  # 预演：列出将删除的内容
 * node scripts/cleanup-raw-logs.js --apply          # 真正删除
 * node scripts/cleanup-raw-logs.js --retention-days 3 --dry-run
 * node scripts/cleanup-raw-logs.js --json
 * ```
 */

const fs = require('fs');
const path = require('path');

const C = require('./lib/log-core');
const CS = require('./lib/conversation-store');

const USAGE = `cleanup-raw-logs.js — Raw 快照保留期清理

  默认 **dry-run**（只列出，不删除）。真正删除必须显式加 --apply。

  --apply                    执行删除
  --retention-days <n>       覆盖 config.storage.raw_log.retention_days
  --date <YYYY-MM-DD>        以该日期为「今天」计算截止日（便于测试与补跑）
  --json                     输出 JSON
  --dir <路径>               日志目录

  只处理 <log_dir>/raw/<source>/<YYYY-MM-DD>/；logs/ 与 summaries/ 永不清理。
`;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 校验目录是本技能的共享日志目录（防止把别的目录当成日志目录来删） */
function assertManagedDir(dir) {
  const manifest = C.readJSON(C.manifestPath(dir), null);
  if (!manifest || manifest.type !== C.MANIFEST_TYPE) {
    throw new C.LogError(
      `目录 ${dir} 不是本技能的共享日志目录（缺少 .log-manifest.json 或 type 不匹配）。` +
        '为避免误删，清理已中止。',
      C.EXIT.BAD_DIR
    );
  }
}

const shiftDate = (date, deltaDays) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${C.pad(d.getMonth() + 1)}-${C.pad(d.getDate())}`;
};

/** 统计目录大小与文件数（用于报告「将释放多少空间」） */
function measure(p) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else {
        try {
          bytes += fs.statSync(f).size;
          files += 1;
        } catch (err) {
          /* 忽略 */
        }
      }
    }
  };
  walk(p);
  return { bytes, files };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function run() {
  const { flags } = C.parseArgs(process.argv.slice(2));
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);
  assertManagedDir(dir);

  const config = C.readConfig(dir);
  const cfg = config.storage.raw_log;
  const today = C.flagStr(flags, 'date') ? CS.assertDate(C.flagStr(flags, 'date')) : C.today();
  const explicit = C.flagNum(flags, 'retention-days');
  const retention = explicit !== null && explicit >= 0 ? Math.min(explicit, 3650) : cfg.retention_days;
  const apply = C.flagBool(flags, 'apply');

  const report = {
    action: 'raw_cleanup',
    mode: apply ? 'apply' : 'dry_run',
    log_directory: dir,
    raw_root: path.join(dir, 'raw', 'workbuddy'),
    raw_sources: [],
    reference_date: today,
    retention_days: retention,
    cutoff_date: shiftDate(today, -retention),
    scanned: 0,
    targets: [],
    deleted: 0,
    reclaimed_bytes: 0,
    skipping: [],
    notes: [],
  };

  if (cfg.enabled === false) {
    report.action = 'skipped';
    report.notes.push('config.storage.raw_log.enabled = false，未做任何清理。');
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  const rawBase = path.join(dir, 'raw');
  if (!fs.existsSync(rawBase)) {
    report.notes.push('raw/ 目录不存在，无需清理。');
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  const sourceEntries = fs.readdirSync(rawBase, { withFileTypes: true });
  for (const source of sourceEntries) {
    if (!source.isDirectory()) continue;
    if (!/^[a-z0-9_-]+$/i.test(source.name)) {
      report.skipping.push({ name: source.name, reason: '不是合法的 raw source 目录' });
      continue;
    }
    const root = path.join(rawBase, source.name);
    try {
      if (fs.lstatSync(root).isSymbolicLink()) {
        report.skipping.push({ name: source.name, reason: 'raw source 是符号链接，已跳过' });
        continue;
      }
    } catch (e) {
      report.skipping.push({ name: source.name, reason: '无法读取 raw source，已跳过' });
      continue;
    }
    report.raw_sources.push(source.name);

    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // 严格只认日期目录形状，其余（含符号链接、临时目录）一律跳过
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.name)) {
        report.skipping.push({
          source: source.name,
          name: e.name,
          reason: '不是 YYYY-MM-DD 形状的目录',
        });
        continue;
      }
      report.scanned += 1;
      if (e.name >= report.cutoff_date) continue; // 截止日当天及之后都保留

      const full = path.join(root, e.name);
      let lstat = null;
      try {
        lstat = fs.lstatSync(full);
      } catch (err) {
        report.skipping.push({ source: source.name, name: e.name, reason: '无法读取，已跳过' });
        continue;
      }
      if (lstat.isSymbolicLink()) {
        report.skipping.push({ source: source.name, name: e.name, reason: '符号链接，已跳过' });
        continue;
      }
      // 关键防线：解析后的绝对路径必须仍在本目录之下
      if (path.dirname(path.resolve(full)) !== path.resolve(root)) {
        report.skipping.push({ source: source.name, name: e.name, reason: '路径越界，已跳过' });
        continue;
      }
      const m = measure(full);
      report.targets.push({
        source: source.name,
        date: e.name,
        path: full,
        files: m.files,
        bytes: m.bytes,
      });
    }
  }

  report.targets.sort((a, b) => (a.date < b.date ? -1 : 1));

  if (apply) {
    for (const t of report.targets) {
      // 每条删除前再断言一次：必须在对应 raw/<source> 之下（纵深防御）
      const root = path.join(rawBase, t.source);
      const parent = path.dirname(path.resolve(t.path));
      if (parent !== path.resolve(root)) {
        report.skipping.push({ source: t.source, name: t.date, reason: '路径越界，已跳过' });
        continue;
      }
      // 显式断言：绝不触碰 logs/ 与 summaries/
      const lowered = path.resolve(t.path).toLowerCase();
      for (const forbidden of ['logs', 'summaries']) {
        if (lowered.includes(`${path.sep}${forbidden}${path.sep}`) || lowered.endsWith(`${path.sep}${forbidden}`)) {
          throw new C.LogError(`内部错误：清理目标命中了禁止清理的目录 ${forbidden}：${t.path}`);
        }
      }
      fs.rmSync(t.path, { recursive: true, force: true });
      report.deleted += 1;
      report.reclaimed_bytes += t.bytes;
    }
  }

  if (!apply && report.targets.length) {
    report.notes.push(
      `以上 ${report.targets.length} 个目录将在 --apply 时删除。` +
        'Structured Logs 与 Summaries 不受影响（永久保留）。'
    );
  }
  if (!C.flagBool(flags, 'quiet')) C.emit(report);
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
