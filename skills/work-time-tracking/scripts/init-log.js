#!/usr/bin/env node
'use strict';
/**
 * init-log.js — 共享日志目录初始化 / 运行状态 / 跨日处理 / 同步状态 / 迁移。
 *
 * 用法：
 *   init-log.js init --dir <路径> [--create] [--force]
 *   init-log.js tracking --set tracking|paused|disabled
 *   init-log.js rollover [--decision keep]
 *   init-log.js pending
 *   init-log.js flush
 *   init-log.js sync --status pending|syncing|success|partial|failed [--detail "..."]
 *   init-log.js migrate
 *
 * 状态查询请使用 status.js（§23-§30 的可感知状态机制）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./lib/log-core');

const USAGE = `init-log.js — 共享日志目录与运行状态

  init-log.js init --dir <路径> [--create] [--force]
      初始化或复用共享日志目录（§52-§54）。识别到旧版本目录时自动迁移标识。

  init-log.js tracking --set <tracking|paused|disabled>
      切换运行状态（§2.4）。paused/disabled 时自动采集不再创建 WorkItem。

  init-log.js rollover [--decision keep]
      跨日处理（§73-§76）。本机只保留当天日志（current.json）：
        · 已同步  → 直接丢弃，不备份历史
        · 未同步  → 中止并提示用户决定（--decision keep 转 pending）
      注意：本技能不做 git / GitHub 同步（2026-09-21 用户明确）；
      远端备份由独立的 GitHub 同步 Skill 负责，本脚本只处理本地文件。

  init-log.js pending
      查看 pending/、pending/writes/ 与同步状态。

  init-log.js flush
      重放 pending/writes/ 中暂存的失败写入（§57）。

  init-log.js sync --status <pending|syncing|success|partial|failed> [--detail "..."] [--date YYYY-MM-DD]
      写入同步状态（§46/§47）。实际同步由 ticktick-work-review 执行。
      注：合法值是 success，不是 synced —— 传 synced 会被 VALID_SYNC_STATUS 拒绝
      （log-core.js 仅在**读取**历史值时把旧写法 synced 兼容映射为 success）。
      --date 指向**非当天**时，写进 pending/<date>.json 并同步维护
      state.pending_sync_dates（success 即移出待同步列表）—— V3.23 补齐的历史日期通路。
      不带 --date 时仍写 current.json。

  init-log.js migrate
      把旧版本（format=work-time-shared-log / 嵌套 config）就地升级到 V1.4。

  状态查询请使用 status.js。
`;

const targetDir = (flags) => C.resolveDir(C.flagStr(flags, 'dir'));

function doInit(flags) {
  if (!flags.dir) throw new C.LogError('init 需要 --dir <日志文件夹路径>', C.EXIT.NO_DIR);
  const dir = path.resolve(String(flags.dir).replace(/^~/, os.homedir()));
  const force = C.flagBool(flags, 'force');
  const create = C.flagBool(flags, 'create');

  if (!fs.existsSync(dir) && !create) {
    throw new C.LogError(
      `目录不存在：${dir}\n如需创建，请先向用户确认路径，再加 --create。`,
      C.EXIT.BAD_DIR
    );
  }

  const kind = C.manifestKind(dir);
  const ours = kind === 'current' || kind === 'legacy';

  if (ours && kind === 'current' && !force) {
    const config = C.readConfig(dir);
    C.saveLocator(dir);
    C.emit({
      action: 'reuse',
      log_directory: dir,
      version: config.version,
      config,
      message: '已存在本技能的共享工作日志，直接复用，未创建任何新文件（§54）。',
    });
    return C.EXIT.OK;
  }

  const conflict = ['current.json', 'config.json', '.log-manifest.json'].filter((n) =>
    fs.existsSync(path.join(dir, n))
  );
  // §53：已有日志不得直接覆盖，必须先向用户确认
  if (!ours && conflict.length && !force) {
    throw new C.LogError(
      `检测到该目录已有内容（${conflict.join('、')}），且不是本技能创建的共享日志。\n` +
        '是否继续使用该日志目录？请向用户确认后加 --force。',
      C.EXIT.BAD_DIR
    );
  }

  fs.mkdirSync(path.join(dir, 'pending', 'writes'), { recursive: true });

  const previous = C.readJSON(C.manifestPath(dir), {}) || {};
  const migrated = kind === 'legacy';
  C.atomicWriteJSON(C.manifestPath(dir), {
    type: C.MANIFEST_TYPE,
    version: C.MANIFEST_VERSION,
    created_at: previous.created_at || C.nowIso(),
    log_id: previous.log_id || `log_${C.randomHex(9)}`,
  });

  const config = C.normalizeConfig(C.readJSON(C.configPath(dir), {}) || {}, dir);
  config.log_directory = dir;
  C.atomicWriteJSON(C.configPath(dir), config);

  if (!fs.existsSync(C.statePath(dir)) || force) {
    C.atomicWriteJSON(C.statePath(dir), C.defaultState());
  }
  if (!fs.existsSync(C.currentPath(dir))) {
    C.atomicWriteJSON(C.currentPath(dir), C.emptyDailyLog());
  }

  // 目录就绪 → 运行状态进入 tracking（除非配置显式关闭）
  const state = C.readJSON(C.statePath(dir), null) || C.defaultState();
  if (!state.hosts) state.hosts = {};
  if (
    !C.VALID_TRACKING_STATUS.includes(state.tracking_status) ||
    state.tracking_status === 'initializing'
  ) {
    state.tracking_status = config.tracking.enabled === false ? 'disabled' : 'tracking';
  }
  C.atomicWriteJSON(C.statePath(dir), state);
  C.saveLocator(dir);
  C.emit({
    action: kind === 'legacy' ? 'migrated' : ours ? 'repaired' : 'created',
    log_directory: dir,
    version: C.CONFIG_VERSION,
    manifest: { type: C.MANIFEST_TYPE, version: C.MANIFEST_VERSION },
    log_id: C.readManifest(dir).log_id,
    migrated_from: migrated ? 'work-time-shared-log / format=work-time-log' : null,
    files: [
      'current.json',
      'config.json',
      'state.json',
      '.log-manifest.json',
      'pending/',
      'pending/writes/',
    ],
  });
  return C.EXIT.OK;
}

function doTracking(flags) {
  const dir = targetDir(flags);
  C.ensureWritable(dir);
  const set = C.flagStr(flags, 'set');
  if (!set) throw new C.LogError('tracking 需要 --set <tracking|paused|disabled>');
  if (!C.VALID_TRACKING_STATUS.includes(set)) {
    throw new C.LogError(`运行状态非法：${set}（允许：${C.VALID_TRACKING_STATUS.join(', ')}）`);
  }
  const state = C.readJSON(C.statePath(dir), null) || C.defaultState();
  state.tracking_status = set;
  C.atomicWriteJSON(C.statePath(dir), state);

  // config 与 state 保持一致，便于其他工具直接读 config 判断（§50）
  const config = C.readConfig(dir);
  const on = set === 'tracking';
  config.tracking.enabled = on;
  config.tracking.auto_tracking = on;
  C.atomicWriteJSON(C.configPath(dir), config);

  const label = { tracking: '已开启自动记录', paused: '已暂停自动记录', disabled: '已关闭自动记录' };
  C.emit({
    action: 'tracking_status_changed',
    tracking_status: set,
    auto_tracking: config.tracking.auto_tracking,
    message: label[set] || set,
    note:
      set === 'tracking'
        ? '自动采集已恢复。'
        : '此后自动采集（source=codex/workbuddy）不再创建 WorkItem；手动记录与 --force 不受影响。',
  });
  return C.EXIT.OK;
}

function doRollover(flags) {
  const dir = targetDir(flags);
  C.ensureWritable(dir);
  const decision = C.flagStr(flags, 'decision');
  if (decision && decision !== 'keep') {
    throw new C.LogError(
      `--decision 只允许 keep。\n` +
        '（archive 已于 2026-09-21 废弃：cross 日时会先把工作事项导出到 ' +
        'logs/<date>/work-activities.jsonl 永久保留，再按同步状态决定是否转 pending/。）'
    );
  }
  const result = C.withLock(dir, () => {
    const log = C.readJSON(C.currentPath(dir), null) || C.emptyDailyLog();
    return C.checkDate(log, dir, decision, 'workbuddy');
  });
  if (!result) C.emit({ action: 'none', message: '当前日志日期与今天一致，无需处理。' });
  else C.emit(Object.assign({ action: 'rolled_over' }, result));
  return C.EXIT.OK;
}

function doPending(flags) {
  const dir = targetDir(flags);
  const log = C.readJSON(C.currentPath(dir), null) || {};
  const state = C.readJSON(C.statePath(dir), null) || {};
  const config = C.readConfig(dir);
  const list = (name) => {
    const d = path.join(dir, name);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort();
  };
  const spool = C.listSpool(dir).map((f) => {
    const p = C.readJSON(f, {});
    return {
      file: path.relative(dir, f),
      created_at: p.created_at,
      actor: p.actor,
      ops: (p.ops || []).length,
      last_error: p.last_error,
    };
  });
  C.emit({
    log_directory: dir,
    current_date: log.date,
    current_sync_status: (log.sync || {}).status,
    last_sync_at: (log.sync || {}).last_sync_at || null,
    pending: list('pending'),
    pending_items: (log.pending_items || []).length,
    judgments_cached: Object.keys(log.judgments || {}).length,
    spool,
    pending_sync_dates: state.pending_sync_dates || [],
    keep_days: config.log.keep_days,
    ai: C.aiUsage(dir, 'auto_analysis'),
    manual_ai: C.aiUsage(dir, 'manual'),
    protection:
      '未同步日志不受 keep_days 影响；pending/writes 中的失败写入不会被丢弃（§49）。',
  });
  return C.EXIT.OK;
}

function doFlush(flags) {
  const dir = targetDir(flags);
  C.ensureWritable(dir);
  if (!C.listSpool(dir).length) {
    C.emit({ action: 'flushed', replayed: 0, message: '没有待重放的失败写入。' });
    return C.EXIT.OK;
  }
  const result = C.runMutation(dir, 'workbuddy', [], {});
  C.emit({
    action: 'flushed',
    replayed: result.replayed_spool,
    version: result.log.version,
    records: result.log.records.length,
  });
  return C.EXIT.OK;
}

function doSync(flags) {
  const dir = targetDir(flags);
  C.ensureWritable(dir);
  const status = C.flagStr(flags, 'status');
  if (!status) throw new C.LogError('sync 需要 --status <pending|syncing|success|partial|failed>');
  if (!C.VALID_SYNC_STATUS.includes(status)) {
    throw new C.LogError(`同步状态非法：${status}（允许：${C.VALID_SYNC_STATUS.join(', ')}）`);
  }
  const detail = C.flagStr(flags, 'detail');

  // V3.23（用户 2026-09-28）：--date 指向「已跨日」的日志时，写进 pending/<date>.json。
  //   此前 sync 只写 current.json —— 历史日期一旦跨日转 pending，就再没有任何 CLI 入口
  //   能把它的同步状态标成成功（state.pending_sync_dates 也清不掉）。
  const dateFlag = C.flagStr(flags, 'date');
  const curLog = C.readJSON(C.currentPath(dir), null) || {};
  if (dateFlag && dateFlag !== curLog.date) {
    const r = C.setPendingSyncStatus(dir, dateFlag, status, detail, 'workbuddy');
    C.emit({
      action: 'sync_status_written',
      where: 'pending',
      date: r.date,
      file: r.file,
      sync: r.sync,
      pending_sync_dates: r.pending_sync_dates,
      note:
        status === 'success'
          ? `已把 pending/${r.date}.json 标为已同步，并从待同步日期中移除。`
          : `已把 pending/${r.date}.json 标为 ${status}；该日期仍在待同步列表中。`,
    });
    return C.EXIT.OK;
  }

  const patch = { status, last_attempt_at: C.nowIso() };
  if (status === 'synced') patch.last_sync_at = C.nowIso();
  if (detail) patch.detail = detail;
  const result = C.runMutation(dir, 'workbuddy', [{ kind: 'sync', sync: patch }], {});
  C.emit({
    action: 'sync_status_written',
    where: 'current',
    version: result.log.version,
    date: result.log.date,
    sync: result.log.sync,
    note:
      status === 'failed'
        ? '同步失败：原始 WorkItem 已完整保留，不被删除（§46）。'
        : status === 'success'
        ? '同步成功：已记录 last_sync_at（§47）。'
        : undefined,
  });
  return C.EXIT.OK;
}

function doMigrate(flags) {
  const dir = targetDir(flags);
  C.ensureWritable(dir);
  const rawLog = C.readJSON(C.currentPath(dir), {}) || {};
  const preview = JSON.parse(JSON.stringify(rawLog));
  const normalized = C.migrateLog(preview); // 预演：报告会被归一化的字段
  const before = {
    manifest: C.manifestKind(dir),
    config_version: (C.readJSON(C.configPath(dir), {}) || {}).version || null,
    log_version: rawLog.version || rawLog.schema_version || null,
    sync_status: (rawLog.sync || {}).status || null,
  };
  const result = C.runMutation(dir, 'workbuddy', [], {});
  const config = C.readConfig(dir);
  C.atomicWriteJSON(C.configPath(dir), config);
  const state = C.readJSON(C.statePath(dir), null) || C.defaultState();
  if (!state.collectors) state.collectors = {};
  if (!C.VALID_TRACKING_STATUS.includes(state.tracking_status)) state.tracking_status = 'tracking';
  C.atomicWriteJSON(C.statePath(dir), state);
  const previous = C.readJSON(C.manifestPath(dir), {}) || {};
  C.atomicWriteJSON(C.manifestPath(dir), {
    type: C.MANIFEST_TYPE,
    version: C.MANIFEST_VERSION,
    created_at: previous.created_at || C.nowIso(),
    log_id: previous.log_id || `log_${C.randomHex(9)}`,
  });
  fs.mkdirSync(path.join(dir, 'pending', 'writes'), { recursive: true });
  C.emit({
    action: 'migrated',
    log_directory: dir,
    before,
    after: {
      manifest: C.manifestKind(dir),
      manifest_type: C.readManifest(dir).type,
      config_version: config.version,
      log_version: result.log.version,
      records_preserved: result.log.records.length,
      sync_status: (result.log.sync || {}).status,
    },
    normalized,
    message:
      '原记录全部保留，仅升级版本标识与配置结构。' +
      'WorkItem id 刻意不改写，以免破坏 ticktick-work-review 的外部任务映射（§48）。',
  });
  return C.EXIT.OK;
}

C.runMain(() => {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const cmd = pos[0] || 'pending';
  switch (cmd) {
    case 'init':
      return doInit(flags);
    case 'tracking':
      return doTracking(flags);
    case 'rollover':
      return doRollover(flags);
    case 'pending':
      return doPending(flags);
    case 'flush':
      return doFlush(flags);
    case 'sync':
      return doSync(flags);
    case 'migrate':
      return doMigrate(flags);
    case 'help':
    case '--help':
      C.emitText(USAGE);
      return C.EXIT.OK;
    default:
      C.emitText(USAGE);
      throw new C.LogError(`未知子命令：${cmd}`);
  }
});
