'use strict';
/**
 * project-resolver.js — 「事项/会话属于哪个项目」的**唯一**解析入口（V3.4 新增）。
 *
 * ## 为什么需要它
 *
 * 同一件事（`project_id → 项目名`）此前在两处各写了一遍，且**第三处漏写**：
 *
 * ```text
 * collect-activity.js   session_id → project_id → [project_map → 在线缓存] → 项目名   ✅
 * conversation-parser.js project_id 读到了，却直接写死 project: null                  ❌
 * ```
 *
 * 结果是：事项有项目名，会话却没有 → 「按项目看 Token」永远是空表。
 * 本模块把这条链路收敛成一份实现，任何需要「项目归属」的地方都调它。
 *
 * ## 解析顺序（不联网、不猜）
 *
 * ```text
 * ① config.project_map[cwd]              用户显式覆盖            high  project_map
 * ② Codex 本地项目（可选 codexResolver）  state_5.sqlite           high  codex_project / codex_project_root
 * ③ config.project_map[project_id]       用户显式覆盖            high  space_project
 * ④ space-projects-cache.json[project_id] 线上权威名称（已缓存）   high  space_project
 * ⑤ 有 project_id 但两处都没有名称        → 保留 project_id，名称留空
 *                                          space_project_unmapped（等 /analyze 时联网补）
 * ⑥ 无 project_id → 可选 cwdResolver 回退（其他宿主项目目录）
 * ⑦ 都没有 → null，不猜
 * ```
 *
 * **热路径（Hook）绝不发网络请求** —— 只读缓存文件；在线刷新由
 * `collect-activity.js project --sync` / `daily-summary.js material` 负责。
 */

const SP = require('./space-projects');

/**
 * 内存级缓存：同一进程内对同一个目录只读一次缓存文件。
 * 批量结算（--backfill）时会把 N 次磁盘读降到 1 次。
 */
const cacheMemo = new Map();

/** 读取（并记忆）某日志目录下的空间项目 id→名称缓存 */
function cachedProjectMap(dir, opts) {
  if (!dir) return {};
  if (opts && opts.cache && typeof opts.cache === 'object') return opts.cache;
  if (cacheMemo.has(dir)) return cacheMemo.get(dir);
  let map = {};
  try {
    map = SP.readCache(dir).map || {};
  } catch (e) {
    map = {};
  }
  cacheMemo.set(dir, map);
  return map;
}

/** 清空记忆（测试用；线上缓存被 --sync 刷新后也需要失效） */
function clearMemo() {
  cacheMemo.clear();
}

/**
 * `project_id` → 项目名。**只查本地映射与缓存**，查不到返回 `null`。
 *
 * @param {string} projectId 形如 `p_<hex>`
 * @param {object} [opts] { config, dir, cache }
 * @returns {{name:string|null, source:string|null}}
 */
function nameOfProjectId(projectId, opts) {
  const o = opts || {};
  const pid = String(projectId || '').trim();
  if (!pid) return { name: null, source: null };

  const overrides = (o.config && o.config.project_map) || {};

  // ① 用户显式覆盖（大小写不敏感，与 log-core.projectFromSession 同口径）
  const lower = pid.toLowerCase();
  for (const [k, v] of Object.entries(overrides)) {
    if (String(k).trim().toLowerCase() === lower && String(v).trim()) {
      return { name: String(v).trim(), source: 'project_map' };
    }
  }

  // ② 线上缓存
  const cache = cachedProjectMap(o.dir, o);
  const ca = cache[pid];
  if (ca && String(ca).trim()) return { name: String(ca).trim(), source: 'space_project_cache' };

  return { name: null, source: null };
}

/**
 * 解析一条记录的项目归属。
 *
 * @param {object} input
 *   `projectId` WorkBuddy 空间项目 id；`codexProjectId` / `codexSessionId`
 *   Codex 本地项目与线程 id；`cwd` 工作目录；`existingName` 记录里已有的项目名
 * @param {object} [opts]
 *   `config` 生效配置；`dir` 日志目录（读缓存用）；`cache` 直接给缓存 map；
 *   `codexResolver` `(source) => Codex 本地项目解析结果`
 *   `cwdResolver` `(cwd) => {project_name, project_confidence, source, reason, project_id?}`
 *   —— 由调用方注入（通常在 log-core），避免本模块反向依赖
 * @returns {{project_name, project_id, project_source, project_confidence, reason}}
 */
function resolveProjectContext(input, opts) {
  const o = opts || {};
  const src = input || {};
  const pid = src.projectId ? String(src.projectId).trim() : null;
  const existing = src.existingName ? String(src.existingName).trim() : null;
  const cwd = src.cwd ? String(src.cwd) : '';

  // —— 0. 记录本身已有项目名：尊重它（AI/用户已确认过，不要被机器覆盖）——
  if (existing) {
    return {
      project_name: existing,
      project_id: pid,
      project_source: 'recorded',
      project_confidence: 'high',
      reason: '记录中已有项目名，保持原值',
    };
  }

  // —— Codex 本地项目（typed resolver，避免把 Codex UUID 当 WorkBuddy p_<hex>）——
  let codexMiss = null;
  if (
    typeof o.codexResolver === 'function' &&
    (src.codexProjectId || src.codexSessionId || cwd)
  ) {
    // 用户显式写的路径映射优先于自动识别，保持与 projectFromCwd 相同的口径。
    const mapped = Object.entries((o.config && o.config.project_map) || {})
      .map(([k, v]) => [
        String(k).replace(/\\/g, '/').replace(/\/+$/, ''),
        String(v).trim(),
      ])
      .filter(([k, v]) => k && v && !/^p_/i.test(k))
      .sort((a, b) => b[0].length - a[0].length);
    const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    for (const [dir, name] of mapped) {
      const d = dir.toLowerCase();
      if (normalized === d || normalized.startsWith(d + '/')) {
        return {
          project_name: name,
          project_id: null,
          project_source: 'project_map',
          project_confidence: 'high',
          reason: `命中 Codex 项目映射：${dir} -> ${name}`,
        };
      }
    }

    try {
      const hit = o.codexResolver({
        projectId: src.codexProjectId ? String(src.codexProjectId) : null,
        sessionId: src.codexSessionId ? String(src.codexSessionId) : null,
        cwd: cwd || null,
      });
      if (hit && hit.project_name) {
        return {
          project_name: String(hit.project_name),
          project_id: hit.project_id ? String(hit.project_id) : null,
          project_source: hit.project_source || 'codex_project',
          project_confidence: hit.project_confidence || 'high',
          reason: hit.reason || 'Codex 本地项目',
        };
      }
      if (hit && hit.project_id) codexMiss = hit;
    } catch (e) {
      codexMiss = null;
    }
  }

  // —— 1/2/3. 空间项目 ——
  if (pid) {
    const hit = nameOfProjectId(pid, o);
    if (hit.name) {
      return {
        project_name: hit.name,
        project_id: pid,
        project_source: 'space_project',
        project_confidence: 'high',
        reason: `${hit.source === 'project_map' ? 'project_map 覆盖' : '线上缓存'}：${pid} → ${hit.name}`,
      };
    }
    // 关联到空间项目但还没有名称 —— 保留 id，**不用目录名顶替**（§4.1 明确禁止）
    return {
      project_name: null,
      project_id: pid,
      project_source: 'space_project_unmapped',
      project_confidence: null,
      reason: `空间项目 ${pid} 尚未解析出名称（可执行 project --sync 联网补全）`,
    };
  }

  // 有 Codex project_id 但本地表没给出名称时保留 id，不用目录名顶替。
  if (codexMiss) {
    return {
      project_name: null,
      project_id: codexMiss.project_id ? String(codexMiss.project_id) : null,
      project_source: codexMiss.project_source || 'codex_project_unmapped',
      project_confidence: null,
      reason: codexMiss.reason || 'Codex 本地项目未解析出名称',
    };
  }

  // —— 4. 无空间项目 → 可选回退到宿主项目目录 ——
  if (cwd && typeof o.cwdResolver === 'function') {
    let byCwd = null;
    try {
      byCwd = o.cwdResolver(cwd);
    } catch (e) {
      byCwd = null;
    }
    if (byCwd && byCwd.project_name) {
      return {
        project_name: String(byCwd.project_name),
        project_id: byCwd.project_id || null,
        project_source: byCwd.source || 'host_project',
        project_confidence: byCwd.project_confidence || 'high',
        reason: byCwd.reason || `宿主项目目录：${cwd}`,
      };
    }
  }

  // —— 5. 无法确定 → null（不猜）——
  return {
    project_name: null,
    project_id: null,
    project_source: cwd ? 'cwd_unregistered' : 'none',
    project_confidence: null,
    reason: cwd ? `工作目录未登记为项目：${cwd}` : '无项目归属线索',
  };
}

module.exports = {
  nameOfProjectId,
  resolveProjectContext,
  cachedProjectMap,
  clearMemo,
};
