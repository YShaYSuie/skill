'use strict';
/**
 * codex-project-resolver.js - Codex 本地项目归属解析。
 *
 * Codex Desktop 的项目数据是**本地 SQLite**，不是线上空间项目：
 *
 *   <CODEX_HOME>/state_5.sqlite
 *     projects(id, name, ...)
 *     project_roots(project_id, position, path)
 *     threads(id, cwd, project_id, ...)
 *
 * 解析顺序：
 *   ① threads.project_id -> projects.name
 *   ② cwd 对 project_roots.path 做最长前缀匹配
 *   ③ 都未命中 -> project_name = null（继续交给上层 cwd 回退，不在这里猜目录名）
 *
 * 本模块只读数据库，不联网。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE_PROJECT = 'codex_project';
const SOURCE_ROOT = 'codex_project_root';
const SOURCE_UNMAPPED = 'codex_project_unmapped';
const SOURCE_NONE = 'codex_project_none';

function resolveCodexHome(opts) {
  const o = opts || {};
  return path.resolve(
    o.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  );
}

function normalizePath(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  s = s.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '');
  return s.toLowerCase();
}

function isSameOrChild(cwd, root) {
  const c = normalizePath(cwd);
  const r = normalizePath(root);
  if (!c || !r) return false;
  return c === r || c.startsWith(r + '/');
}

function openDb(codexHome) {
  const file = path.join(codexHome, 'state_5.sqlite');
  if (!fs.existsSync(file)) return { db: null, file, error: 'state_5.sqlite 不存在' };
  try {
    const { DatabaseSync } = require('node:sqlite');
    return { db: new DatabaseSync(file, { readOnly: true }), file, error: null };
  } catch (e) {
    return { db: null, file, error: String((e && e.message) || e) };
  }
}

function readProjects(db) {
  try {
    const projects = db
      .prepare('SELECT id, name FROM projects')
      .all()
      .filter((r) => r && r.id && r.name);
    const roots = db
      .prepare('SELECT project_id, position, path FROM project_roots')
      .all()
      .filter((r) => r && r.project_id && r.path);
    return {
      projects,
      byId: new Map(projects.map((r) => [String(r.id), String(r.name)])),
      roots,
      available: true,
      error: null,
    };
  } catch (e) {
    return {
      projects: [],
      byId: new Map(),
      roots: [],
      available: false,
      error: String((e && e.message) || e),
    };
  }
}

function readThread(db, sessionId) {
  if (!sessionId) return null;
  try {
    return (
      db
        .prepare('SELECT id, cwd, project_id, title FROM threads WHERE id = ?')
        .get(String(sessionId)) || null
    );
  } catch (e) {
    return null;
  }
}

function missed(projectId, cwd, reason, source) {
  return {
    project_name: null,
    project_id: projectId ? String(projectId) : null,
    project_source: source || SOURCE_NONE,
    project_confidence: null,
    project_context: cwd ? String(cwd) : null,
    reason,
  };
}

/**
 * @param {object} input { sessionId, projectId, cwd, threadRow }
 * @param {object} [opts] { codexHome }
 * @returns {{project_name, project_id, project_source, project_confidence, project_context, reason}}
 */
function resolveCodexProject(input, opts) {
  const src = input || {};
  const codexHome = resolveCodexHome(opts);
  const opened = openDb(codexHome);
  if (!opened.db) {
    return missed(
      src.projectId,
      src.cwd,
      `Codex 本地项目库不可用：${opened.error}`,
      'codex_projects_unavailable'
    );
  }

  try {
    const snapshot = readProjects(opened.db);
    if (!snapshot.available) {
      return missed(
        src.projectId,
        src.cwd,
        `Codex 项目表不可用：${snapshot.error}`,
        'codex_projects_unavailable'
      );
    }

    const thread = src.threadRow || readThread(opened.db, src.sessionId);
    const cwd = src.cwd || (thread && thread.cwd) || null;
    const projectId = src.projectId || (thread && thread.project_id) || null;

    if (projectId && snapshot.byId.has(String(projectId))) {
      const name = snapshot.byId.get(String(projectId));
      return {
        project_name: name,
        project_id: String(projectId),
        project_source: SOURCE_PROJECT,
        project_confidence: 'high',
        project_context: cwd ? String(cwd) : null,
        reason: `Codex 本地项目：${projectId} -> ${name}`,
      };
    }

    let best = null;
    for (const root of snapshot.roots) {
      if (!isSameOrChild(cwd, root.path)) continue;
      const normalized = normalizePath(root.path);
      if (!best || normalized.length > best.normalized.length) {
        best = { normalized, root };
      }
    }
    if (best) {
      const name = snapshot.byId.get(String(best.root.project_id));
      if (name) {
        return {
          project_name: name,
          project_id: String(best.root.project_id),
          project_source: SOURCE_ROOT,
          project_confidence: 'high',
          project_context: cwd ? String(cwd) : null,
          reason: `Codex 项目根目录：${best.root.path} -> ${name}`,
        };
      }
    }

    if (projectId) {
      return missed(
        projectId,
        cwd,
        `Codex 项目 ${projectId} 未在本地 projects 表中找到名称`,
        SOURCE_UNMAPPED
      );
    }
    return missed(null, cwd, cwd ? `Codex 工作目录未匹配本地项目根目录：${cwd}` : '无 Codex 项目线索', SOURCE_NONE);
  } finally {
    try {
      opened.db.close();
    } catch (e) {
      /* 忽略 */
    }
  }
}

module.exports = {
  SOURCE_PROJECT,
  SOURCE_ROOT,
  SOURCE_UNMAPPED,
  SOURCE_NONE,
  resolveCodexHome,
  normalizePath,
  resolveCodexProject,
};
