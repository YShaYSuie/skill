#!/usr/bin/env node
'use strict';
/**
 * validate-log.js — 日志完整性自检（§42，零 Token 操作）。
 *
 * §42 要求的运行前检查：
 *   1 log_directory 是否存在      2 是否可读写         3 current.json 是否有效
 *   4 日期是否正确                5 是否存在未同步日志   6 是否存在文件并发冲突
 *   7 WorkItem ID 是否唯一        8 项目名称是否来自可靠上下文
 *   9 工作类型是否来自可靠上下文   10 是否存在敏感信息
 *   11 是否超过 AI 自动调用保护阈值 12 TickTick 是否应该同步
 *
 * 只读，不修改任何数据。发现问题以退出码 5 结束。
 * 用法：
 *   validate-log.js [--strict]
 */

const fs = require('fs');
const path = require('path');
const C = require('./lib/log-core');

const USAGE = `validate-log.js — 日志自检（§42）

  [--strict]     把待确认事项、时长未记录等也视为问题
  [--dir <路径>]
`;

/**
 * 日志自检（§42）。返回 `{ log_directory, ok, checks, problems, warnings, note }`。
 *
 * V3.24（用户 2026-09-28）：从 CLI 内联体抽成函数并导出，使自检能被测试**进程内**调用 ——
 * 受限沙箱禁止 node 派生 node（spawnSync → EBUSY），只走 CLI 的校验在那种环境下无法回归。
 * 同时补上 `runMain(fn, module)` 的守卫：此前未传 module，require 本文件会直接执行 CLI。
 */
function runValidate(dir, strict) {
  const problems = [];
  const warnings = [];
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ check: name, ok: Boolean(ok), detail: detail || '' });
    if (!ok) problems.push(`${name}：${detail}`);
  };

  // §50-1/2 目录与权限
  check('log_directory 存在', fs.existsSync(dir) && fs.statSync(dir).isDirectory(), dir);
  if (!fs.existsSync(dir)) {
    return {
      log_directory: dir,
      ok: false,
      checks,
      problems,
      warnings,
      note: '日志目录不存在，无法自检。',
    };
  }
  const probe = C.probeDir(dir);
  check('目录可读', probe.readable);
  check('目录可写', probe.writable);

  // 共享日志标识（§8.1）
  const kind = C.manifestKind(dir);
  check(
    '共享日志标识有效',
    kind === 'current' || kind === 'legacy',
    '缺少 .log-manifest.json 或 type 不是 work-time-log'
  );
  if (kind === 'legacy') warnings.push('manifest 为旧版本标识，建议运行 init-log.js migrate。');
  const manifest = C.readManifest(dir);
  check(
    'manifest 含 log_id',
    Boolean(manifest.log_id),
    '缺少 log_id，多工具无法确认属于同一共享日志'
  );

  // 配置（§44）
  const rawConfig = C.readJSON(C.configPath(dir), {}) || {};
  const config = C.readConfig(dir);
  if (rawConfig.version !== C.CONFIG_VERSION) {
    warnings.push(
      `config.version=${rawConfig.version || '(缺失)'}，当前为 ${C.CONFIG_VERSION}，建议 migrate。`
    );
  }
  if (rawConfig.sync_realtime !== undefined || rawConfig.summary_schedule !== undefined) {
    warnings.push('config 为旧版扁平结构，建议运行 init-log.js migrate 升级（§44）。');
  }
  if (config.sync.realtime !== false) {
    problems.push('config.sync.realtime 必须为 false（§30 禁止实时同步）。');
  }
  if (config.log_directory && path.resolve(config.log_directory) !== path.resolve(dir)) {
    warnings.push(`config.log_directory=${config.log_directory}，与实际目录 ${dir} 不一致。`);
  }
  check('空闲阈值合法', config.tracking.idle_threshold_minutes > 0, '必须为正数');
  check(
    'AI 保护阈值合法',
    Number.isFinite(config.ai.auto_analysis.safety_max_calls_per_day),
    '缺少 ai.auto_analysis.safety_max_calls_per_day'
  );

  // 安全边界（§12/§55）
  for (const b of C.security.ACCESS_BOUNDARIES) {
    if (b.fixed === 'restricted') continue;
    if (config.security[b.key]) {
      problems.push(`安全边界被违规打开：${b.label}（${b.rule}）`);
    }
  }
  check('严格模式开启', config.security.strict_mode === true, 'strict_mode 必须为 true');
  check('敏感信息脱敏开启', config.security.redact_sensitive === true, 'redact_sensitive=false');

  // §50-3 current.json 有效性
  const log = C.readJSON(C.currentPath(dir), null);
  check('current.json 可解析', log !== null, '文件不存在或 JSON 无效');
  if (log) {
    check('version 为整数', Number.isInteger(log.version), String(log.version));
    check('date 字段存在', Boolean(log.date), String(log.date));
    check('records 为数组', Array.isArray(log.records), typeof log.records);
    check('pending_items 为数组', Array.isArray(log.pending_items), typeof log.pending_items);
    check(
      'judgments 为对象',
      log.judgments === null || typeof log.judgments === 'object',
      typeof log.judgments
    );
    check(
      'sync.status 合法',
      C.VALID_SYNC_STATUS.includes((log.sync || {}).status),
      String((log.sync || {}).status)
    );

    // §50-7 WorkItem ID 唯一 + 字段校验
    const seen = new Set();
    for (const rec of log.records || []) {
      const rid = rec.id || '(无 id)';
      if (seen.has(rid)) problems.push(`WorkItem id 重复：${rid}`);
      seen.add(rid);
      if (!/^WI-/.test(rid)) warnings.push(`WorkItem id 不符合 §10.2 的 WI-<日期>-<随机>：${rid}`);
      if (!rec.content) problems.push(`WorkItem 内容为空：${rid}`);
      // §50-8 非法敏感信息
      const hits = rec.content ? C.security.containsSensitive(rec.content) : [];
      if (hits.length) {
        problems.push(`WorkItem 内容含未脱敏敏感信息（${hits.join('、')}）：${rid}`);
      }
      if (rec.content && rec.content.includes('\n')) {
        problems.push(
          `WorkItem 疑似完整内容（多行）：${rid} —— 只记录工作主题（§12）`
        );
      }
      if (rec.content && rec.content.length > C.MAX_CONTENT_LENGTH) {
        problems.push(
          `WorkItem 内容超过上限 ${C.MAX_CONTENT_LENGTH} 字：${rid} —— ` +
            '应由 AI 压缩或安全过滤截断后写入（§12）'
        );
      }
      if (!rec.date) problems.push(`WorkItem 缺少 date：${rid}`);
      if (!C.VALID_SOURCE.includes(rec.source)) {
        problems.push(`WorkItem source 非法：${rid} -> ${rec.source}`);
      }
      if (!C.VALID_STATUS.includes(rec.status)) {
        problems.push(`WorkItem status 非法：${rid} -> ${rec.status}`);
      }
      // §14：无 start_time 时，只有 needs_confirmation / not_started，
      //   或**显式标记 time_unknown 的已完成事项**才合法（2026-09-20 扩展）
      if (
        !rec.start_time &&
        !['needs_confirmation', 'not_started'].includes(rec.status) &&
        rec.time_unknown !== true
      ) {
        problems.push(
          `WorkItem 缺少 start_time 但状态为 ${rec.status}：${rid} —— 应置 needs_confirmation（§14）`
        );
      }
      // time_unknown 必须与「无任何时间数据」一致，否则是自相矛盾的数据
      if (rec.time_unknown === true) {
        if (rec.start_time || rec.end_time || rec.actual_duration !== null) {
          problems.push(`WorkItem 标记 time_unknown 但存在时间数据：${rid} —— 二者不可并存（§13/§14）`);
        }
        if (!['completed', 'cancelled'].includes(rec.status)) {
          problems.push(`WorkItem 标记 time_unknown 但状态为 ${rec.status}：${rid} —— 仅适用于已完成/已取消`);
        }
      }
      // §30/§31：ticktick 对应关系必须形态正确（taskId 回写，2026-09-21 扩展）
      //   无 taskId 时整个字段应为 null；有 taskId 时不得夹带白名单外的字段。
      {
        const tt = rec.ticktick;
        if (tt !== undefined && tt !== null) {
          if (typeof tt !== 'object' || Array.isArray(tt)) {
            problems.push(`WorkItem ticktick 应为对象或 null：${rid} -> ${JSON.stringify(tt)}`);
          } else {
            if (!tt.taskId || typeof tt.taskId !== 'string' || !tt.taskId.trim()) {
              problems.push(
                `WorkItem ticktick 缺少 taskId：${rid} —— 无 taskId 时整个字段应为 null（§30/§31）`
              );
            } else if (tt.taskId.length > C.MAX_TICKTICK_ID_LENGTH) {
              problems.push(`WorkItem ticktick.taskId 长度异常：${rid}`);
            }
            const extra = Object.keys(tt).filter((k) => !C.VALID_TICKTICK_FIELDS.includes(k));
            if (extra.length) {
              warnings.push(`WorkItem ticktick 含白名单外字段（将被丢弃）：${rid} -> ${extra.join('、')}`);
            }
            for (const f of ['projectId', 'syncedAt']) {
              const v = tt[f];
              if (v !== undefined && v !== null && typeof v !== 'string') {
                problems.push(`WorkItem ticktick.${f} 应为字符串或 null：${rid}`);
              }
            }
          }
        }
      }
      // §12：超长内容的处理必须留痕（2026-09-21 扩展）。
      //   截断是信息损失 —— 缺了留痕就变成「静默截断」，用户无从察觉。
      {
        // V3.24（用户 2026-09-28）：**AI 生成记录不产出时长** 的不变量校验。
        //   1) 时长来源必须在枚举内；
        //   2) 非 manual 来源不得有非 null 时长（否则说明又按会话收尾计时了）；
        //   3) 'live' 是实时视图专用，落盘日志里出现即为错误。
        if (rec.duration_source !== undefined && rec.duration_source !== null) {
          if (!C.VALID_DURATION_SOURCE.includes(rec.duration_source)) {
            problems.push(
              `WorkItem duration_source 非法：${rid} -> ${JSON.stringify(rec.duration_source)}`
            );
          }
          if (rec.duration_source === 'live') {
            problems.push(`WorkItem duration_source=live 不得落盘：${rid} —— live 仅供实时展示`);
          }
        }
        if (rec.source !== 'manual' && rec.actual_duration !== null && rec.actual_duration !== undefined) {
          problems.push(
            `非人工来源不得产出时长：${rid}（source=${rec.source}, actual_duration=${rec.actual_duration}）` +
              ' —— AI 会话推导不产出时长（V3.24）'
          );
        }
      }
      {
        const cc = rec.content_compression;
        if (cc !== undefined && cc !== null) {
          if (typeof cc !== 'object' || Array.isArray(cc)) {
            problems.push(`WorkItem content_compression 应为对象或 null：${rid}`);
          } else {
            for (const f of ['summarized', 'truncated']) {
              if (typeof cc[f] !== 'boolean') {
                problems.push(`WorkItem content_compression.${f} 应为布尔值：${rid}`);
              }
            }
            if (cc.truncated === true && cc.summarized === true) {
              problems.push(
                `WorkItem content_compression 同时标记 summarized 与 truncated：${rid} —— 二者互斥`
              );
            }
            // 截断意味着信息被丢弃，必须给出原因
            if (cc.truncated === true && !cc.reason) {
              problems.push(`WorkItem 已截断但未记录原因：${rid} —— 截断必须可追溯（§12）`);
            }
            const original = Number(cc.original_length);
            if (cc.truncated === true && Number.isFinite(original) && original <= C.MAX_CONTENT_LENGTH) {
              warnings.push(
                `WorkItem 标记截断但原长 ${original} 未超上限 ${C.MAX_CONTENT_LENGTH}：${rid}`
              );
            }
          }
        }
      }
      for (const f of ['start_time', 'end_time']) {
        const v = rec[f];
        if (v === null || v === undefined) continue;
        if (!C.isHHMM(v)) {
          if (C.toMinutes(v) !== null)
            warnings.push(`WorkItem ${f} 为旧版 ISO 格式（${v}）：${rid}`);
          else problems.push(`WorkItem ${f} 格式非法：${rid} -> ${v}`);
        }
      }
      if (!Array.isArray(rec.activities)) warnings.push(`WorkItem 缺少 activities 字段：${rid}`);
      if (!rec.confidence) warnings.push(`WorkItem 未标记 confidence：${rid}`);

      const displayHits = rec.display_content
        ? C.security.containsSensitive(rec.display_content)
        : [];
      if (displayHits.length) {
        problems.push(`display_content 含未脱敏敏感信息（${displayHits.join('、')}）：${rid}`);
      }
      if (rec.detail) {
        const detailHits = C.security.containsSensitive(rec.detail);
        if (detailHits.length) {
          problems.push(`detail 含未脱敏敏感信息（${detailHits.join('、')}）：${rid}`);
        }
        const maxDetail = Number(config.security && config.security.max_detail_length) || 4000;
        if (String(rec.detail).length > maxDetail) {
          problems.push(`detail 超出安全上限：${rid}`);
        }
      }
      if (rec.detail_compression !== null && rec.detail_compression !== undefined) {
        if (
          typeof rec.detail_compression !== 'object' ||
          Array.isArray(rec.detail_compression) ||
          rec.detail_compression.truncated !== true ||
          !rec.detail_compression.reason
        ) {
          problems.push(`WorkItem detail_compression 形态非法：${rid}`);
        }
      }
      // §42-8/9：项目与工作类型必须来自可靠上下文（§5/§11 禁止猜测）
      if (rec.project_name) {
        if (!['high', 'medium'].includes(rec.project_confidence)) {
          problems.push(
            `项目名称缺少可靠置信度（§42-8）：${rid} project_name=${rec.project_name} ` +
              `project_confidence=${rec.project_confidence}`
          );
        }
      } else if (rec.project_confidence) {
        problems.push(`项目名称为空但 project_confidence 非空：${rid} -> ${rec.project_confidence}`);
      }
      if (rec.work_type) {
        if (!['high', 'medium'].includes(rec.work_type_confidence)) {
          problems.push(
            `工作类型缺少可靠置信度（§42-9）：${rid} work_type=${rec.work_type} ` +
              `work_type_confidence=${rec.work_type_confidence}`
          );
        }
        if (Array.isArray(config.work_types) && !config.work_types.includes(rec.work_type)) {
          warnings.push(
            `工作类型不在配置清单内（可在 config.work_types 扩展）：${rid} -> ${rec.work_type}`
          );
        }
      } else if (rec.work_type_confidence) {
        problems.push(`工作类型为空但 work_type_confidence 非空：${rid}`);
      }
      // §9/§28：display_content 必须由结构化字段拼合，禁止只存格式化字符串
      const expectedDisplay = C.buildDisplayContent(rec);
      if (rec.display_content !== expectedDisplay) {
        problems.push(
          `display_content 与结构化字段不一致（§9/§28）：${rid}\n` +
            `      实际：${rec.display_content}\n      应为：${expectedDisplay}`
        );
      }
      if (rec.estimated_duration !== null && rec.estimated_duration !== undefined) {
        if (!(rec.estimated_duration > 0)) {
          problems.push(`estimated_duration 非正数：${rid} -> ${rec.estimated_duration}`);
        }
        if (rec.confidence === 'low') {
          problems.push(`低可信度事项不应带 estimated_duration：${rid}（§14）`);
        }
      }
      for (const seg of rec.time_segments || []) {
        try {
          const s = C.parseHHMM(seg.start);
          if (seg.end) {
            const e = C.parseHHMM(seg.end);
            if (e < s) problems.push(`时间段结束早于开始：${rid} ${seg.start}-${seg.end}`);
          }
        } catch (e) {
          problems.push(`时间段格式非法：${rid} -> ${JSON.stringify(seg)}`);
        }
      }
      if (rec.status === 'in_progress' && rec.actual_duration !== null) {
        warnings.push(`进行中事项 actual_duration 应为 null：${rid} -> ${rec.actual_duration}`);
      }
      if (strict && rec.status === 'needs_confirmation') {
        problems.push(`待确认事项尚未补齐：${rid} ${rec.content}`);
      }
    }
    check('WorkItem 字段合法', !problems.some((p) => p.startsWith('WorkItem')), '见 problems');
    check('未记录完整内容', !problems.some((p) => p.includes('疑似完整内容')), '见 problems');
    check('未含未脱敏敏感信息', !problems.some((p) => p.includes('未脱敏敏感信息')), '见 problems');
    check(
      '超长内容已压缩或已留痕',
      !problems.some((p) => p.includes('内容超过上限')),
      '见 problems'
    );

    // pending_items（§20）
    const hashes = new Set();
    for (const p of log.pending_items || []) {
      const key = p.hash || p.id;
      if (!key) problems.push(`待判断事项缺少 hash/id：${JSON.stringify(p).slice(0, 80)}`);
      else if (hashes.has(key)) problems.push(`待判断事项重复：${key}`);
      else hashes.add(key);
      if (!p.content) problems.push(`待判断事项内容为空：${key}`);
      const hits = p.content ? C.security.containsSensitive(p.content) : [];
      if (hits.length) {
        problems.push(`待判断事项含未脱敏敏感信息（${hits.join('、')}）：${key}`);
      }
      if (p.confidence && !C.VALID_CONFIDENCE.includes(p.confidence)) {
        problems.push(`待判断事项 confidence 非法：${key} -> ${p.confidence}`);
      }
      if (p.source && !C.VALID_SOURCE.includes(p.source)) {
        problems.push(`待判断事项 source 非法：${key} -> ${p.source}`);
      }
      // §12：自动采集路径的超长处理留痕（2026-09-21 扩展）。
      //   这条路径没有人工介入，截断若不留痕就是永久静默丢内容。
      const pcc = p.content_compression;
      if (pcc !== undefined && pcc !== null) {
        if (typeof pcc !== 'object' || Array.isArray(pcc)) {
          problems.push(`待判断事项 content_compression 应为对象或 null：${key}`);
        } else if (pcc.truncated === true && !pcc.reason) {
          problems.push(`待判断事项已截断但未记录原因：${key} —— 截断必须可追溯（§12）`);
        }
      }
      if (p.content && p.content.length > C.MAX_CONTENT_LENGTH) {
        problems.push(`待判断事项内容超过上限 ${C.MAX_CONTENT_LENGTH} 字：${key}（§12）`);
      }
      if (p.detail && C.security.containsSensitive(p.detail).length) {
        problems.push(`待判断事项 detail 含未脱敏敏感信息：${key}`);
      }
    }
    // judgments（§32）
    for (const [hash, entry] of Object.entries(log.judgments || {})) {
      if (!entry.matched_work_item) problems.push(`判断缓存缺少 matched_work_item：${hash}`);
      else if (log.records && !log.records.some((r) => r.id === entry.matched_work_item)) {
        warnings.push(`判断缓存指向已不存在的 WorkItem：${hash} -> ${entry.matched_work_item}`);
      }
      if (!entry.analyzed_at) warnings.push(`判断缓存缺少 analyzed_at：${hash}`);
    }

    // §50-4 日期是否正确
    if (log.date !== C.today()) {
      check(
        '日期正确',
        false,
        `current.json 日期为 ${log.date}，与今天 ${C.today()} 不一致，需先执行 rollover（§49）。`
      );
    } else {
      check('日期正确', true);
    }

    // §50-5 / §42-5 未同步日志（只看历史日期；当天尚未同步属正常状态）
    const pendingDates = (C.readState(dir).pending_sync_dates || []).filter(
      (d) => d && d !== log.date
    );
    if (pendingDates.length) {
      warnings.push(`存在未同步历史日志：${pendingDates.join('、')}（§26.3 禁止静默覆盖）`);
    }
    check(
      '无未同步历史日志',
      pendingDates.length === 0,
      `待同步日期：${pendingDates.join('、')}`
    );

    // §42-12：TickTick 是否应该同步
    const syncStatus = (log.sync || {}).status || 'pending';
    if (syncStatus === 'pending' && (log.records || []).length) {
      warnings.push(
        `当前有 ${(log.records || []).length} 条 WorkItem 处于 ${syncStatus} 状态，` +
          '可执行 /sync 交由 ticktick-work-review 同步（§29）。'
      );
    }
  }

  // §50-6 并发冲突
  const lock = C.lockInfo(dir);
  if (lock && !lock.stale) {
    check('无并发冲突', false, `存在未过期的文件锁（${Math.round(lock.age_ms / 1000)} 秒）。`);
  } else if (lock) {
    warnings.push(`存在陈旧锁（${Math.round(lock.age_ms / 1000)} 秒），下次写入会自动回收。`);
  } else {
    check('无并发冲突', true);
  }
  const spool = C.listSpool(dir);
  if (spool.length) {
    warnings.push(
      `pending/writes 中有 ${spool.length} 份未落盘的失败写入，下次写入或 init-log.js flush 会自动重放。`
    );
  }
  check('无未落盘写入', spool.length === 0, `pending/writes 残留 ${spool.length} 份`);

  // §50-9 AI 保护阈值 + 宿主触发状态（§57）
  const state = C.readJSON(C.statePath(dir), null);
  if (state && log) {
    const st = C.migrateState(JSON.parse(JSON.stringify(state)));
    check(
      'state 与 current 日期一致',
      st.current_date === log.date,
      `${st.current_date} vs ${log.date}`
    );
    check(
      'tracking_status 合法',
      C.VALID_TRACKING_STATUS.includes(st.tracking_status),
      String(st.tracking_status)
    );
    for (const [host, entry] of Object.entries(st.hosts || {})) {
      if (entry.mechanism && !C.VALID_MECHANISM.includes(entry.mechanism)) {
        problems.push(`host ${host} mechanism 非法：${entry.mechanism}`);
      }
      if (entry.last_activity_at && Number.isNaN(Date.parse(entry.last_activity_at))) {
        problems.push(`host ${host} last_activity_at 无法解析：${entry.last_activity_at}`);
      }
    }
    if (!st.hosts || !Object.keys(st.hosts).length) {
      warnings.push('state.hosts 为空，/status 将显示宿主触发未配置（§57）。');
    }
    check(
      '自动 AI 计数为整数',
      Number.isInteger(st.automatic_ai_calls_today),
      String(st.automatic_ai_calls_today)
    );
    check(
      '手动 AI 计数为整数',
      Number.isInteger(st.manual_ai_calls_today),
      String(st.manual_ai_calls_today)
    );
    if (st.automatic_ai_calls_today > config.ai.auto_analysis.safety_max_calls_per_day) {
      warnings.push(
        `今日自动 AI 调用 ${st.automatic_ai_calls_today} 次已超过保护阈值 ` +
          `${config.ai.auto_analysis.safety_max_calls_per_day}（§35）。`
      );
    } else {
      check('未超过 AI 保护阈值', true);
    }
    for (const k of ['last_event_time', 'last_summary_time', 'last_sync_time']) {
      if (!(k in st)) warnings.push(`state 缺少 §8.1 字段：${k}`);
    }
  } else if (!state) {
    warnings.push('缺少 state.json。');
  }

  /* ---------------------------------------------------------------- *
   * V3.5：结构化日志的自检
   *
   * 只读、零 Token。核心是四条不变量：
   *   ① 目录名日期 == 记录日期（否则按日期查日志会漏）
   *   ② 业务键唯一（否则幂等失效、Token 会重复累加）
   *   ③ skill_token 只允许出现在 injection 口径下（禁止摊派估算）
   *   ④ 取不到的值必须是 null（禁止 0 或猜测值顶替）
   * ---------------------------------------------------------------- */
  const CS = require('./lib/conversation-store');
  const logsRoot = CS.logsDir(dir);
  const legacyRoot = CS.structuredDir(dir);
  const KIND_SPECS = [
    {
      kind: 'conversation',
      key: 'conversation_id',
      required: [
        'conversation_id',
        'agent',
        'model_name',
        'start_time',
        'end_time',
        'total_token',
        'total_score',
        'status',
        'settlement_status',
        'settled_at',
        'source',
      ],
      enums: {
        status: CS.VALID_CONVERSATION_HOST_STATUS,
        settlement_status: CS.VALID_SETTLEMENT_STATUS,
        source: CS.VALID_CONVERSATION_SOURCE,
      },
    },
    {
      kind: 'turn',
      key: 'turn_id',
      required: [
        'turn_id',
        'conversation_id',
        'date',
        'ordinal',
        'start_time',
        'end_time',
        'request_count',
        'total_token',
        'token_source',
        'status',
        'source',
      ],
      enums: {
        status: CS.VALID_TURN_STATUS,
        source: CS.VALID_CONVERSATION_SOURCE,
        token_source: CS.VALID_TURN_TOKEN_SOURCE,
      },
    },
    {
      kind: 'skill_usage',
      key: 'usage_id',
      required: [
        'usage_id',
        'conversation_id',
        'date',
        'skill_id',
        'skill_version',
        'skill_token',
        'token_source',
        'status',
      ],
      enums: {
        status: CS.VALID_USAGE_STATUS,
        token_source: CS.VALID_TOKEN_SOURCE,
        trigger_type: CS.VALID_TRIGGER_TYPE,
        source: CS.VALID_CONVERSATION_SOURCE,
      },
    },
    {
      kind: 'work_segment',
      key: 'segment_id',
      required: [
        'segment_id',
        'conversation_id',
        'date',
        'topic',
        'start_time',
        'end_time',
        'status',
      ],
      enums: {
        status: CS.VALID_SEGMENT_STATUS,
        source: CS.VALID_ACTIVITY_SOURCE,
      },
    },
    {
      kind: 'work_activity',
      key: 'activity_id',
      required: ['activity_id', 'content', 'source'],
      enums: {
        source: CS.VALID_ACTIVITY_SOURCE,
        ai_role: CS.VALID_AI_ROLE,
        // V3.6：归属二次确认状态（confirmed / pending_review）
        classification_status: CS.VALID_CLASSIFICATION_STATUS,
      },
    },
    {
      kind: 'ai_usage',
      key: 'ai_usage_id',
      required: [
        'ai_usage_id',
        'conversation_id',
        'date',
        'attribution_status',
        'total_token',
        'credit',
      ],
      enums: {
        attribution_status: CS.VALID_ATTRIBUTION_STATUS,
        source: CS.VALID_CONVERSATION_SOURCE,
      },
    },
  ];

  if (!fs.existsSync(logsRoot) && !fs.existsSync(legacyRoot)) {
    warnings.push(
      '尚无 logs/ 目录：对话结算（settle-conversation.js）尚未运行过。' +
        '这不是错误 —— 每日复盘的 AI 使用章节会显示为空。'
    );
  } else {
    const convByDate = {};
    const allConversations = [];
    const allTurns = [];
    const allSegments = [];
    const allActivities = [];
    const allAiUsages = [];
    // 收集待校验文件：新布局 logs/<date>/<kind>.jsonl 为主；
    // V3.0 旧布局 structured/<kind>/<date>.jsonl 仍校验（只读兼容），但会提示迁移。
    const targets = [];
    if (fs.existsSync(logsRoot)) {
      for (const d of fs.readdirSync(logsRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const spec of KIND_SPECS) {
          const file = path.join(logsRoot, d.name, CS.KINDS[spec.kind].file);
          if (fs.existsSync(file)) {
            targets.push({ spec, file, label: `logs/${d.name}/${CS.KINDS[spec.kind].file}`, date: d.name, legacy: false });
          }
        }
      }
    }
    if (fs.existsSync(legacyRoot)) {
      let legacyFound = false;
      for (const spec of KIND_SPECS) {
        const kdir = path.join(legacyRoot, CS.KINDS[spec.kind].legacyDir);
        if (!fs.existsSync(kdir)) continue;
        for (const f of fs.readdirSync(kdir).filter((x) => x.endsWith('.jsonl'))) {
          legacyFound = true;
          targets.push({
            spec,
            file: path.join(kdir, f),
            label: `structured/${CS.KINDS[spec.kind].legacyDir}/${f}`,
            date: f.slice(0, -'.jsonl'.length),
            legacy: true,
          });
        }
      }
      if (legacyFound) {
        warnings.push(
          '检测到 V3.0 旧布局 structured/（已按兼容方式校验）：' +
            '建议运行 settle-conversation.js --backfill 重新结算到 logs/ 后清理旧目录。'
        );
      }
    }

    const perKind = {};
    for (const t of targets) {
      const { spec, file, label, date: fileDate } = t;
      const parsed = CS.readJsonl(file);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fileDate)) {
        problems.push(`[${spec.kind}] 日志目录/文件名不是 YYYY-MM-DD：${label}`);
      }
      if (parsed.bad_lines) {
        warnings.push(`[${spec.kind}] ${label} 有 ${parsed.bad_lines} 行无法解析（已跳过，其余行不受影响）。`);
      }
      if (!perKind[spec.kind]) perKind[spec.kind] = { files: 0, records: 0 };
      perKind[spec.kind].files += 1;

      const seen = new Set();
      for (const rec of parsed.records) {
        perKind[spec.kind].records += 1;
        const key = rec[spec.key];
        if (!key) {
          problems.push(`[${spec.kind}] 记录缺少业务键 ${spec.key}：${JSON.stringify(rec).slice(0, 80)}`);
        } else if (seen.has(String(key))) {
          problems.push(`[${spec.kind}] 业务键重复（幂等失效）：${key}`);
        } else {
          seen.add(String(key));
        }

        for (const fld of spec.required) {
          if (rec[fld] === undefined) {
            problems.push(`[${spec.kind}] 缺少标准字段 ${fld}：${key || '(无键)'}`);
          }
        }
        for (const [fld, allowed] of Object.entries(spec.enums)) {
          if (rec[fld] !== undefined && rec[fld] !== null && !allowed.includes(rec[fld])) {
            problems.push(`[${spec.kind}] ${fld} 非法：${key} -> ${rec[fld]}`);
          }
        }

        // ① 记录日期必须与目录名一致
        const recDate = rec.date || CS.dateOf(rec.start_time);
        if (recDate && recDate !== fileDate) {
          problems.push(`[${spec.kind}] ${label} 中的记录日期为 ${recDate}，与目录名不一致：${key}`);
        }

        if (spec.kind === 'conversation') {
          // ④ 取不到的值必须是 null（禁止 0 / 猜测值顶替）
          for (const fld of [
            'total_token',
            'input_token',
            'output_token',
            'cached_token',
            'reasoning_token',
            'total_score',
            'duration_seconds',
          ]) {
            const v = rec[fld];
            if (v === undefined) continue;
            if (v !== null && !Number.isFinite(Number(v))) {
              problems.push(
                `[conversation] ${fld} 应为数值或 null（不可获取时写 null，不得估算）：${key} -> ${JSON.stringify(v)}`
              );
            }
          }
          // 积分为下界时必须留下覆盖度证据（否则复盘无法提示覆盖率）。
          // 但 `not_applicable`（走模型 API、本就不计积分）的 0 是**确定值**，
          // 不是「下界」，不该要求 coverage 证据 —— 否则会全线误报。
          if (
            rec.total_score !== null &&
            rec.score_source !== 'not_applicable' &&
            !(Number(rec.score_request_count) > 0)
          ) {
            warnings.push(
              `[conversation] ${key} 有积分但未记录 score_request_count，` +
                '复盘无法提示「积分覆盖率」（建议重新结算该会话）。'
            );
          }
          if (!convByDate[fileDate]) convByDate[fileDate] = [];
          convByDate[fileDate].push(rec);
          allConversations.push(rec);
        }

        if (spec.kind === 'turn') {
          for (const fld of [
            'total_token',
            'input_token',
            'output_token',
            'cached_token',
            'reasoning_token',
            'duration_seconds',
          ]) {
            const v = rec[fld];
            if (v !== undefined && v !== null && !Number.isFinite(Number(v))) {
              problems.push(
                `[turn] ${fld} 应为数值或 null（不可获取时写 null，不得估算）：${key} -> ${JSON.stringify(v)}`
              );
            }
          }
          allTurns.push(rec);
        }

        if (spec.kind === 'work_segment') allSegments.push(rec);
        if (spec.kind === 'work_activity') allActivities.push(rec);
        if (spec.kind === 'ai_usage') allAiUsages.push(rec);

        if (spec.kind === 'skill_usage') {
          // ③ 关键不变量：只有 injection 口径才允许出现数值 token（禁止摊派估算）
          const src = rec.token_source !== undefined ? rec.token_source : rec.skill_token_source;
          if (src !== 'injection' && rec.skill_token !== null) {
            problems.push(
              `[skill-usage] 非 injection 口径却记了数值 token（疑似摊派估算）：${key} -> ${rec.skill_token}`
            );
          }
          if (src === 'injection' && !Number.isFinite(Number(rec.skill_token))) {
            problems.push(`[skill-usage] injection 口径的 skill_token 应为数值：${key}`);
          }
          if (!rec.conversation_id) {
            problems.push(`[skill-usage] 未关联 conversation_id（强制要求）：${key}`);
          }
        }

        if (spec.kind === 'work_activity' && rec.source === 'agent' && !rec.conversation_id && !rec.work_item_id) {
          // 自动采集的事项必须**可追溯**：要么来自某次对话（conversation_id），
          // 要么来自某个已归类的事项（work_item_id）。
          // 两者都没有才算「来源标注可疑」。
          //
          // ⚠️ 2026-09-21 修正：原判定只看 conversation_id，于是
          // export-work-activities.js 导出的记录会全线误报 ——
          // WorkItem 本身不带 conversation_id，它靠 work_item_id 关联。
          warnings.push(
            `[work-activity] agent 来源但既无 conversation_id 也无 work_item_id：${key}` +
              '（自动采集的事项应至少有一种可追溯关联）'
          );
        }

        if (spec.kind === 'work_activity') {
          // V3.24：AI 生成记录不产出时长 —— 永久日志里同样要守住这条不变量
          if (rec.duration_source !== null && rec.duration_source !== undefined) {
            if (!C.VALID_DURATION_SOURCE.includes(rec.duration_source)) {
              problems.push(
                `[work-activity] duration_source 非法：${key} -> ${JSON.stringify(rec.duration_source)}`
              );
            }
            if (rec.duration_source === 'live') {
              problems.push(`[work-activity] duration_source=live 不得落盘：${key}`);
            }
          }
          if (rec.source === 'agent' && rec.duration_minutes !== null && rec.duration_minutes !== undefined) {
            problems.push(
              `[work-activity] 非人工来源不得产出时长：${key}（duration_minutes=${rec.duration_minutes}）`
            );
          }
          const maxDetail = Number(config.security && config.security.max_detail_length) || 4000;
          if (rec.detail && String(rec.detail).length > maxDetail) {
            problems.push(`[work-activity] detail 超出安全上限：${key}`);
          }
          if (
            rec.detail_compression !== null &&
            rec.detail_compression !== undefined &&
            (typeof rec.detail_compression !== 'object' ||
              Array.isArray(rec.detail_compression) ||
              rec.detail_compression.truncated !== true ||
              !rec.detail_compression.reason)
          ) {
            problems.push(`[work-activity] detail_compression 形态非法：${key}`);
          }
          const expectedLog = String(rec.display_content || rec.content || '').slice(0, 200);
          if (
            (rec.log !== undefined || rec.log_length !== undefined) &&
            (rec.log !== expectedLog || rec.log_length !== expectedLog.length)
          ) {
            problems.push(`[work-activity] log / log_length 与 200 字展示规则不一致：${key}`);
          }
        }

        if (spec.kind === 'ai_usage') {
          for (const fld of ['input_token', 'output_token', 'total_token', 'credit']) {
            const v = rec[fld];
            if (v !== null && v !== undefined && !Number.isFinite(Number(v))) {
              problems.push(
                `[ai-usage] ${fld} 应为数值或 null（不可获取时写 null，不得估算）：${key}`
              );
            }
          }
          if (rec.attribution_status === 'unallocated' && (rec.segment_id || rec.activity_id)) {
            problems.push(`[ai-usage] unallocated 记录不应包含 segment_id/activity_id：${key}`);
          }
          if (rec.attribution_status !== 'unallocated' && !rec.segment_id && !rec.activity_id) {
            problems.push(
              `[ai-usage] ${rec.attribution_status} 记录必须包含 segment_id 或 activity_id：${key}`
            );
          }
        }
      }
    }

    const segmentIds = new Set(allSegments.map((s) => String(s.segment_id)));
    const activityIds = new Set(allActivities.map((a) => String(a.activity_id)));
    const turnIds = new Set(allTurns.map((t) => String(t.turn_id)));
    for (const a of allActivities) {
      if (a.segment_id && !segmentIds.has(String(a.segment_id))) {
        problems.push(`[work-activity] 引用了不存在的 segment_id：${a.activity_id} -> ${a.segment_id}`);
      }
    }
    for (const u of allAiUsages) {
      if (u.activity_id && !activityIds.has(String(u.activity_id))) {
        problems.push(`[ai-usage] 引用了不存在的 activity_id：${u.ai_usage_id} -> ${u.activity_id}`);
      }
      if (u.segment_id && !segmentIds.has(String(u.segment_id))) {
        problems.push(`[ai-usage] 引用了不存在的 segment_id：${u.ai_usage_id} -> ${u.segment_id}`);
      }
    }
    const convByIdAll = new Map(allConversations.map((c) => [String(c.conversation_id), c]));
    for (const t of allTurns) {
      if (!convByIdAll.has(String(t.conversation_id))) {
        problems.push(`[turn] 未找到对应 Conversation：${t.turn_id} -> ${t.conversation_id}`);
      }
    }
    const allocatedByConv = new Map();
    for (const u of allAiUsages) {
      if (u.attribution_status === 'unallocated') continue;
      if (!allocatedByConv.has(String(u.conversation_id))) {
        allocatedByConv.set(String(u.conversation_id), { token: 0, token_known: false, credit: 0, credit_known: false });
      }
      const a = allocatedByConv.get(String(u.conversation_id));
      if (typeof u.total_token === 'number') {
        a.token += u.total_token;
        a.token_known = true;
      }
      if (typeof u.credit === 'number') {
        a.credit += u.credit;
        a.credit_known = true;
      }
    }
    for (const [cid, allocated] of allocatedByConv) {
      const conv = convByIdAll.get(cid);
      if (!conv) {
        problems.push(`[ai-usage] 未找到对应 Conversation：${cid}`);
        continue;
      }
      if (allocated.token_known && typeof conv.total_token === 'number' && allocated.token > conv.total_token) {
        problems.push(`[ai-usage] 精确归属 Token 大于 Conversation 总账：${cid}`);
      }
      if (allocated.credit_known && typeof conv.total_score === 'number' && allocated.credit > conv.total_score) {
        problems.push(`[ai-usage] 精确归属 Credit 大于 Conversation 总账：${cid}`);
      }
    }

    // ② 与 Conversation 的 skill_count 交叉核对 —— **必须在全库范围内按日期汇总**
    //
    // 长活会话（一个 session 跨多天）的 Skill 调用会分散在不同 logs/<date>/ 目录里，
    // 因此只看同目录会误报「数量不符」。
    const skillCountByConv = new Map();
    const skillNamesByConv = new Map();
    for (const t of targets) {
      if (t.spec.kind !== 'skill_usage') continue;
      for (const rec of CS.readJsonl(t.file).records) {
        if (!rec.conversation_id) continue;
        skillCountByConv.set(
          rec.conversation_id,
          (skillCountByConv.get(rec.conversation_id) || 0) + 1
        );
        if (!skillNamesByConv.has(rec.conversation_id)) {
          skillNamesByConv.set(rec.conversation_id, new Set());
        }
        skillNamesByConv.get(rec.conversation_id).add(String(rec.skill_id));
        if (rec.turn_id && !turnIds.has(String(rec.turn_id))) {
          problems.push(
            `[skill-usage] 引用了不存在的 turn_id：${rec.usage_id || '(无键)'} -> ${rec.turn_id}`
          );
        }
      }
    }
    for (const t of targets) {
      if (t.spec.kind !== 'conversation') continue;
      for (const conv of CS.readJsonl(t.file).records) {
        if (conv.skill_count === undefined) continue;
        const actual = skillCountByConv.get(conv.conversation_id) || 0;
        if (Number(conv.skill_count) !== actual) {
          warnings.push(
            `[交叉核对] ${conv.conversation_id} 的 skill_count=${conv.skill_count}，` +
              `全库实际 Skill Usage ${actual} 条（跨日期汇总）。`
          );
        }
        if (
          conv.skill_invocation_count !== null &&
          conv.skill_invocation_count !== undefined &&
          Number(conv.skill_invocation_count) !== actual
        ) {
          warnings.push(
            `[交叉核对] ${conv.conversation_id} 的 skill_invocation_count=${conv.skill_invocation_count}，` +
              `全库实际 Skill Usage ${actual} 条（跨日期汇总）。`
          );
        }
        if (
          conv.distinct_skill_count !== null &&
          conv.distinct_skill_count !== undefined
        ) {
          const distinct = (skillNamesByConv.get(conv.conversation_id) || new Set()).size;
          if (Number(conv.distinct_skill_count) !== distinct) {
            warnings.push(
              `[交叉核对] ${conv.conversation_id} 的 distinct_skill_count=${conv.distinct_skill_count}，` +
                `全库实际不同 Skill ${distinct} 个。`
            );
          }
        }
      }
    }

    const turnCountByConv = new Map();
    for (const t of allTurns) {
      turnCountByConv.set(
        t.conversation_id,
        (turnCountByConv.get(t.conversation_id) || 0) + 1
      );
    }
    for (const conv of allConversations) {
      if (conv.turn_count === null || conv.turn_count === undefined) continue;
      const actual = turnCountByConv.get(conv.conversation_id) || 0;
      if (Number(conv.turn_count) !== actual) {
        warnings.push(
          `[交叉核对] ${conv.conversation_id} 的 turn_count=${conv.turn_count}，` +
            `全库实际 Turn ${actual} 条（跨日期汇总）。`
        );
      }
    }

    for (const [kind, st] of Object.entries(perKind)) {
      check(`结构化日志 ${kind} 可解析`, true, `${st.files} 个文件 / ${st.records} 条`);
    }
    // 基础日志任缺一类都值得提示（可能是结算未跑或写入失败）。
    // 但 work_activity 默认就是关闭的（capture_work_activities = 'off'），
    // 此时缺它不是异常 —— 否则每个用默认配置的人都看到一条永久告警，反而麻痹。
    // V3.5 的 work_segment / ai_usage 是可选扩展，只在写入过时才校验。
    const activityCapture = String(
      (config.settlement && config.settlement.capture_work_activities) || 'off'
    ).toLowerCase();
    for (const spec of KIND_SPECS) {
      if (perKind[spec.kind] || !Object.keys(perKind).length) continue;
      if (spec.kind === 'work_activity' && activityCapture === 'off') continue;
      if (['turn', 'work_segment', 'ai_usage'].includes(spec.kind)) continue;
      warnings.push(`缺少 ${spec.kind} 类日志（其余日志已存在，可能是该次结算未写入）。`);
    }
  }

  const ok = problems.length === 0;
  return {
    log_directory: dir,
    ok,
    checks,
    problems,
    warnings,
    note: '自检只读，不修改任何数据；全部为本地规则，不调用 AI（§34）。',
  };
}

C.runMain(() => {
  const { flags } = C.parseArgs(process.argv.slice(2));
  if (C.flagBool(flags, 'help')) {
    C.emitText(USAGE);
    return C.EXIT.OK;
  }
  const result = runValidate(C.resolveDir(C.flagStr(flags, 'dir')), C.flagBool(flags, 'strict'));
  C.emit(result);
  return result.ok ? C.EXIT.OK : C.EXIT.CONFLICT;
}, module);

module.exports = { runValidate };
