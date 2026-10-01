#!/usr/bin/env node
'use strict';
/**
 * lock-log.js — 共享日志锁的显式管理。
 *
 * 单个 WorkItem 的增删改由 write-work-item.js / update-work-item.js 内部自动加锁，
 * 无需手工调用本脚本。本脚本用于：
 *   1. 外部工具需要跨多步操作独占日志时，显式持有锁；
 *   2. 诊断锁状态、清理崩溃残留的陈旧锁。
 *
 * 用法：
 *   lock-log.js status
 *   lock-log.js acquire [--ttl 120] [--wait 10] [--holder "codex-batch"]
 *   lock-log.js release --token <token> [--force]
 *   lock-log.js stale [--clean]
 */

const fs = require('fs');
const C = require('./lib/log-core');

const USAGE = `lock-log.js — 共享日志锁管理

  status                       查看当前锁持有者与年龄
  acquire [--ttl 120] [--wait 10] [--holder 名称]
                               显式加锁，输出 token；--ttl 为建议持有时长（秒）
  release --token <token> [--force]
                               释放锁；token 不匹配时需 --force
  stale [--clean]              列出（并清理）超过 90 秒的陈旧锁

陈旧锁（写入方崩溃残留）会被任何一次自动写入自动回收，因此通常无需手工清理。
`;

/** 复用核心库的锁解析，避免陈旧阈值在多处各自定义而漂移 */
const readLock = (dir) => C.lockInfo(dir);

function doStatus(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const lock = readLock(dir);
  if (!lock) {
    C.emit({ locked: false, log_directory: dir, stale_threshold_seconds: 90 });
    return C.EXIT.OK;
  }
  C.emit({
    locked: true,
    log_directory: dir,
    pid: lock.pid,
    holder: lock.holder,
    created_at: lock.created_at,
    age_seconds: Math.round(lock.age_ms / 1000),
    stale: lock.age_ms > 90 * 1000,
    note: '陈旧锁会在下一次自动写入时被回收。',
  });
  return C.EXIT.OK;
}

function doAcquire(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);
  const ttl = C.flagNum(flags, 'ttl') || 120;
  const wait = C.flagNum(flags, 'wait') || 0;
  const holder = C.flagStr(flags, 'holder') || 'manual';
  const token = C.randomHex(16);
  const file = C.lockPath(dir);
  const deadline = Date.now() + wait * 1000;

  for (;;) {
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({ pid: process.pid, token, holder, created_at: C.nowIso(), ttl_seconds: ttl }),
        { flag: 'wx' }
      );
      C.emit({
        action: 'acquired',
        lock_file: file,
        token,
        ttl_seconds: ttl,
        holder,
        message: '完成操作后必须执行 release --token <token>；异常退出时该锁会在 90 秒后被自动回收。',
      });
      return C.EXIT.OK;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const lock = readLock(dir);
      if (lock && lock.age_ms > 90 * 1000) {
        try {
          fs.unlinkSync(file);
          continue;
        } catch (e2) {
          /* 竞争：重试 */
        }
      }
      if (Date.now() >= deadline) {
        C.emit({
          action: 'busy',
          locked_by: lock,
          message: '锁被占用且等待超时。请稍后重试，或先用 status 确认持有者。',
        });
        return C.EXIT.CONFLICT;
      }
      const end = Date.now() + 150;
      while (Date.now() < end) {
        /* 同步等待 */
      }
    }
  }
}

function doRelease(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const lock = readLock(dir);
  if (!lock) {
    C.emit({ action: 'noop', message: '当前没有锁。' });
    return C.EXIT.OK;
  }
  const token = C.flagStr(flags, 'token');
  const force = C.flagBool(flags, 'force');
  if (lock.token && token !== lock.token && !force) {
    throw new C.LogError(
      `token 不匹配，拒绝释放（当前 token 属于 holder=${lock.holder}）。确认要强制释放请加 --force。`
    );
  }
  fs.unlinkSync(lock.file);
  C.emit({ action: 'released', lock_file: lock.file, forced: Boolean(force) });
  return C.EXIT.OK;
}

function doStale(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const lock = readLock(dir);
  if (!lock) {
    C.emit({ action: 'none', message: '没有锁残留。' });
    return C.EXIT.OK;
  }
  const stale = lock.age_ms > 90 * 1000;
  let cleaned = false;
  if (stale && C.flagBool(flags, 'clean')) {
    fs.unlinkSync(lock.file);
    cleaned = true;
  }
  C.emit({
    stale,
    age_seconds: Math.round(lock.age_ms / 1000),
    cleaned,
    holder: lock.holder,
    message: stale
      ? cleaned
        ? '陈旧锁已清理。'
        : '检测到陈旧锁。加 --clean 可清理；自动写入也会自行回收。'
      : '锁未过期，可能正在被其他工具使用。',
  });
  return C.EXIT.OK;
}

C.runMain(() => {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const cmd = pos[0] || 'status';
  switch (cmd) {
    case 'status':
      return doStatus(flags);
    case 'acquire':
      return doAcquire(flags);
    case 'release':
      return doRelease(flags);
    case 'stale':
      return doStale(flags);
    case 'help':
      C.emitText(USAGE);
      return C.EXIT.OK;
    default:
      C.emitText(USAGE);
      throw new C.LogError(`未知子命令：${cmd}`);
  }
});
