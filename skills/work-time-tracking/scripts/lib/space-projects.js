'use strict';
/**
 * space-projects.js — WorkBuddy 空间项目名称解析（§4.1 C）。
 *
 * 空间项目（`p_<hex>`）的名称由**服务端下发**，本地任何文件都不存名称
 * （已逐一排查 DB / project-resources / Local Storage / HTTP 缓存 / 日志）。
 * 因此名称必须在线获取：
 *
 *   GET https://copilot.tencent.com/console/as/projects            → 全量 id→name
 *   GET https://copilot.tencent.com/console/as/projects/<pid>       → 单项目
 *
 * 凭据（JWT + x-user-id）在**本项目自己的会话日志**里明文可取
 * （`logs/<日期>/<会话名>__<hash>.log`），按 `x-project-id` 定位提取。
 *
 * 设计约束：
 *   - 本模块**只读线上、只写自己的缓存文件**，不改日志数据
 *   - **token 不出现在任何输出/日志里**
 *   - 采集热路径（ingest）**只读缓存**，不做网络请求；在线刷新走 `project --sync`
 *   - 离线/401 → 降级到缓存，再降级到 config.project_map
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CACHE_FILE = 'space-projects-cache.json';
/** Windows 10+ 自带 curl.exe；避免依赖 Git Bash 的 shim */
const DEFAULT_CURL = 'C:/Windows/System32/curl.exe';
/** 控制台基址 —— 注意必须带 `/console` 前缀（实测路径是 /console/as/projects） */
const DEFAULT_CONSOLE = 'https://copilot.tencent.com/console';

function cachePath(dir) {
  return path.join(dir, CACHE_FILE);
}

/** 读缓存（损坏/不存在一律降级为空，不抛错） */
function readCache(dir) {
  try {
    const f = cachePath(dir);
    if (!fs.existsSync(f)) return { map: {}, fetched_at: null };
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { map: o.map && typeof o.map === 'object' ? o.map : {}, fetched_at: o.fetched_at || null };
  } catch (e) {
    return { map: {}, fetched_at: null };
  }
}

function writeCache(dir, map, fetchedAt) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      cachePath(dir),
      JSON.stringify({ fetched_at: fetchedAt || new Date().toISOString(), map }, null, 2) + '\n',
      'utf8'
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 从宿主日志提取请求凭据（只读）。
 *
 * 扫描 `~/.workbuddy/logs/<日期>/*.log`（新日期优先），找含
 * `"x-project-id"` 且带 JWT 的会话日志。**返回值不含 token 明文的打印路径**，
 * 调用方不得把它写入日志或输出。
 *
 * @param {object} [opts] { home }
 * @returns {{ok:boolean, jwt?:string, uid?:string, pid?:string, scanned:number, error?:string}}
 */
function findCredentials(opts) {
  const h = (opts && opts.home) || os.homedir();
  const logsDir = path.join(h, '.workbuddy', 'logs');
  if (!fs.existsSync(logsDir)) return { ok: false, scanned: 0, error: '日志目录不存在' };

  const dateDirs = fs
    .readdirSync(logsDir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}/.test(n))
    .sort()
    .reverse(); // 最新优先

  let scanned = 0;
  for (const dd of dateDirs) {
    const ddPath = path.join(logsDir, dd);
    let files = [];
    try {
      files = fs.readdirSync(ddPath).filter((n) => /\.log$/i.test(n));
    } catch (e) {
      continue;
    }
    for (const n of files) {
      const f = path.join(ddPath, n);
      let st;
      try {
        st = fs.statSync(f);
      } catch (e) {
        continue;
      }
      if (st.size > 30 * 1024 * 1024) continue;
      let t = '';
      try {
        t = fs.readFileSync(f, 'utf8');
      } catch (e) {
        continue;
      }
      scanned += 1;
      const i = t.indexOf('"x-project-id"');
      if (i < 0) continue;
      const seg = t.slice(Math.max(0, i - 1500), i + 200);
      const jwt = (seg.match(/eyJ[A-Za-z0-9._-]{40,}/) || [])[0];
      const uid = (seg.match(/"x-user-id"\s*:\s*"([0-9a-f-]{36})"/) || [])[1];
      const pid = (seg.match(/"x-project-id"\s*:\s*"(p_[0-9a-f]+)"/) || [])[1];
      if (jwt && uid) return { ok: true, jwt, uid, pid: pid || null, scanned };
    }
  }
  return { ok: false, scanned, error: '日志中未找到可用凭据' };
}

/**
 * 在线拉取空间项目 id→name（**同步**，走 curl.exe）。
 *
 * @param {object} opts { jwt, uid, pid?, consoleBase?, curl?, timeoutSec? }
 * @returns {{ok:boolean, map?:Object<string,string>, error?:string}}
 */
function fetchProjectMap(opts) {
  const c = opts || {};
  if (!c.jwt || !c.uid) return { ok: false, error: '缺少凭据（jwt/uid）' };
  const curl = c.curl || DEFAULT_CURL;
  if (!fs.existsSync(curl)) return { ok: false, error: `未找到 curl.exe（${curl}）` };
  const base = (c.consoleBase || DEFAULT_CONSOLE).replace(/\/+$/, '');
  const url = base + '/as/projects';
  const timeoutSec = Number(c.timeoutSec) > 0 ? Number(c.timeoutSec) : 15;
  const args = [
    '-sS',
    // 必须绕过代理：本机 HTTPS_PROXY 指向本地代理，会把该请求打成 404
    '--noproxy',
    '*',
    '-m',
    String(timeoutSec),
    '-H',
    'Accept: application/json',
    '-H',
    'x-user-id: ' + c.uid,
    '-H',
    'x-project-id: ' + (c.pid || ''),
    '-H',
    'Authorization: Bearer ' + c.jwt,
    url,
  ];
  let lastError = '未知原因';
  // 接口偶发超时/空响应（daemon 日志里见过多次），重试 2 次提高成功率
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let out = '';
    try {
      out = execFileSync(curl, args, {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutSec * 1000 + 2000,
        windowsHide: true,
      });
    } catch (e) {
      const so = (e && e.stdout && String(e.stdout).slice(0, 80)) || '';
      lastError = '请求失败：' + String((e && e.message) || e).slice(0, 100) + (so ? ' / ' + so : '');
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (e) {
      lastError = '响应不是 JSON：' + out.slice(0, 80);
      continue;
    }
    const items =
      (parsed.data && (parsed.data.items || parsed.data.list || parsed.data.projects)) ||
      parsed.items ||
      parsed.list ||
      [];
    const map = {};
    for (const it of items) {
      const id = it.projectId || it.id || it.project_id;
      const name = it.name;
      if (id && name) map[String(id)] = String(name);
    }
    if (!Object.keys(map).length) {
      // 带上响应开头便于诊断（不含 token；响应体本身是项目列表）
      lastError =
        '响应中没有项目数据（code=' + parsed.code + ' msg=' + parsed.msg + ' items=' + items.length +
        '）响应开头：' + out.slice(0, 140).replace(/\s+/g, ' ');
      continue;
    }
    return { ok: true, map, attempts: attempt };
  }
  return { ok: false, error: lastError + '（已重试 3 次）' };
}

/**
 * 解析某个空间项目的名称。
 * 顺序：project_map（用户显式覆盖）→ 在线缓存。都没有 → null。
 */
function resolveName(pid, opts) {
  const id = String(pid || '').trim();
  if (!id) return null;
  const overrides = (opts && opts.project_map) || {};
  const cache = (opts && opts.cache) || {};
  const ov = overrides[id];
  if (ov && String(ov).trim()) return String(ov).trim();
  const ca = cache[id];
  if (ca && String(ca).trim()) return String(ca).trim();
  return null;
}

/**
 * 总结前把「空间项目归属」与线上权威名称对齐（§4.1 C）。
 *
 * **只在总结阶段调用**：采集热路径不做网络请求。
 * 作用范围限于 **带 project_id 的条目** —— 无归属线索的不去猜、不请求。
 *
 * 处理两类：
 *   1. 有 project_id 但没有名称 → 补全
 *   2. 有 project_id 但名称与线上不一致 → 校正（以线上为准）
 *
 * 任何失败都**不阻断总结**，只如实返回错误。
 *
 * @param {string} dir 日志目录
 * @param {object} [opts] { config, log, home, timeoutSec, curl }
 * @returns {{ok:boolean, skipped?:boolean, scoped:number, resolved:number, renamed:number, projects:number, error?:string}}
 */
function syncUnresolvedProjects(dir, opts) {
  const o = opts || {};
  const C = require('./log-core');
  const config = o.config || C.readConfig(dir);
  const log = o.log || C.readJSON(C.currentPath(dir));

  // 作用范围：日志中出现过的、带 project_id 的空间项目
  const scoped = new Set();
  for (const p of log.pending_items || []) if (p.project_id) scoped.add(String(p.project_id));
  for (const r of log.records || []) if (r.project_id) scoped.add(String(r.project_id));
  if (!scoped.size) {
    return { ok: true, skipped: true, scoped: 0, resolved: 0, renamed: 0, projects: 0, reason: '无空间项目' };
  }

  // 缓存新鲜度守卫：短时间内的重复调用（如 draft 之后紧接 save）不再请求线上，
  // 但要确保范围内每个项目都能从缓存/覆盖中解析出名称 —— 否则仍需联网补齐。
  const ttlMinutes = Number(o.ttlMinutes) > 0 ? Number(o.ttlMinutes) : 10;
  const cached = readCache(dir);
  const fresh =
    cached.fetched_at && Date.now() - Date.parse(cached.fetched_at) < ttlMinutes * 60 * 1000;
  if (fresh) {
    const allResolvable = [...scoped].every((pid) =>
      resolveName(pid, { cache: cached.map, project_map: config.project_map })
    );
    if (allResolvable) {
      return {
        ok: true,
        skipped: true,
        cached: true,
        scoped: scoped.size,
        resolved: 0,
        renamed: 0,
        projects: Object.keys(cached.map).length,
        reason: `缓存 ${ttlMinutes} 分钟内有效`,
      };
    }
  }

  const creds = findCredentials(o.home ? { home: o.home } : undefined);
  if (!creds.ok) {
    return {
      ok: false,
      scoped: scoped.size,
      resolved: 0,
      renamed: 0,
      projects: 0,
      error: '无法获取凭据：' + (creds.error || '未知'),
    };
  }
  const fetched = fetchProjectMap({
    jwt: creds.jwt,
    uid: creds.uid,
    pid: creds.pid,
    consoleBase: o.consoleBase,
    curl: o.curl,
    timeoutSec: o.timeoutSec,
  });
  if (!fetched.ok) {
    return { ok: false, scoped: scoped.size, resolved: 0, renamed: 0, projects: 0, error: fetched.error };
  }
  writeCache(dir, fetched.map);

  let resolved = 0;
  let renamed = 0;
  const pending = (log.pending_items || []).map((p) => {
    if (!p.project_id) return p;
    const nm = resolveName(p.project_id, { cache: fetched.map, project_map: config.project_map });
    if (!nm) return p;
    if (p.project_name === nm) return p;
    if (p.project_name) renamed += 1;
    else resolved += 1;
    return Object.assign({}, p, {
      project_name: nm,
      project_confidence: 'high',
      project_source: 'space_project',
      project_reason: `总结阶段按线上权威名称对齐：${p.project_id}`,
    });
  });
  const ops = [{ kind: 'patch_pending_batch', items: pending }];
  for (const pid of Object.keys(fetched.map)) ops.push({ kind: 'space_project', project_id: pid, named: true });
  C.runMutation(dir, 'workbuddy', ops, {});

  return {
    ok: true,
    skipped: false,
    scoped: scoped.size,
    resolved,
    renamed,
    projects: Object.keys(fetched.map).length,
  };
}

module.exports = {
  CACHE_FILE,
  DEFAULT_CURL,
  DEFAULT_CONSOLE,
  cachePath,
  readCache,
  writeCache,
  findCredentials,
  fetchProjectMap,
  resolveName,
  syncUnresolvedProjects,
};
