#!/usr/bin/env node
'use strict';
/**
 * export-work-activities.js — 把**已归类**的 WorkItem 导出为永久 Work Activity 日志。
 *
 * ## 解决什么问题
 *
 * ```text
 * current.json  → keep_days = 1，跨日直接覆盖、不做历史备份
 *                 ⇒ 今天的 WorkItem 明天就没了，只剩 summaries/<date>.md 的文字
 * logs/<date>/  → 永久（但此前只存对话成本：Token / Score / Skill）
 * ```
 *
 * 结果是不对称的：**「花了多少」永久保留，「做了什么」反而丢失。**
 *
 * 而 `logs/<date>/work-activities.jsonl` 本来就是为工作事项预留的位置 —— 本脚本把它填上。
 *
 * ## 与 `capture_work_activities` 的区别（重要）
 *
 * ```text
 * capture_work_activities = prompts  → 从对话提示词**造新事项**
 *                                      （会与事件管线重复记账，故默认 off）
 * 本脚本 export-work-activities      → 把**已经归类好**的事项导出
 *                                      （不造任何数据，只是换个地方永久留存）
 * ```
 *
 * ## 幂等
 *
 * `activity_id` 由 **WorkItem id** 派生（不是内容），因此：
 *
 * ```text
 * 同一份 WorkItem 导出 100 次 → 始终是 1 条记录，created=0 / unchanged=1
 * 内容被改写               → 仍是同一条（updated），不会新增
 * ```
 *
 * ## 用法
 *
 * ```bash
 * node scripts/export-work-activities.js                    # 导出今天
 * node scripts/export-work-activities.js --date 2026-09-20  # 导出指定日（需 current.json 或 --from）
 * node scripts/export-work-activities.js --from /path/to/2026-09-20.json
 *                                                           # 从别的 DailyLog 文件导出（抢救旧归档）
 * node scripts/export-work-activities.js --dry-run --json   # 只看会写什么
 * ```
 */

const fs = require('fs');
const path = require('path');

const C = require('./lib/log-core');
const CS = require('./lib/conversation-store');
const AL = require('./lib/activity-link');

const USAGE = `export-work-activities.js — 把已归类的 WorkItem 导出为永久 Work Activity 日志

  默认：读 <log_dir>/current.json 的 records → 写 logs/<date>/work-activities.jsonl

  --date <YYYY-MM-DD>   指定目标日期（默认取 DailyLog 自带日期）
  --from <文件>         从另一个 DailyLog JSON 读取（抢救旧的日志副本时用）
  --dry-run             只报告将要写入的内容，不落盘
  --json                输出 JSON
  --dir <路径>          日志目录

  activity_id 由 WorkItem id 派生 → 重复导出不产生新记录（幂等）。
  本脚本不创建任何新事项，只做「换个地方永久留存」。
`;

/* ------------------------------------------------------------------ *
 * 字段映射（WorkItem → Work Activity）
 * ------------------------------------------------------------------ */

/** WorkItem 状态 → Work Activity 状态（后者取值范围更窄） */
const STATUS_MAP = {
  completed: 'completed',
  cancelled: 'cancelled',
  in_progress: 'in_progress',
  paused: 'in_progress',
  not_started: 'needs_confirmation',
  needs_confirmation: 'needs_confirmation',
};

/** WorkItem.source 记录的是「哪个工具产生的」；Work Activity 记的是「谁做的」 */
function mapSource(src) {
  const s = String(src || '').toLowerCase();
  if (s === 'manual') return 'manual';
  if (!s) return 'agent';
  return 'agent'; // auto / workbuddy / codex / skill …都属自动采集
}

/** WorkItem → Work Activity 记录（只做映射，不造字段） */
function toActivity(wi, ctx) {
  const date = CS.assertDate(wi.date);
  return {
    date,
    activity_id: CS.makeActivityIdFromWorkItem(date, wi.id),
    project_name: wi.project_name || null,
    work_type: wi.work_type || null,
    // V3.3：分类 / 项目阶段 / 成果原样带过来（没有就留空，不补不猜）
    category: wi.category || null,
    project_stage: wi.project_stage || null,
    output: wi.output || null,
    // V3.6：归属确认状态随 WorkItem 一起导出 ——
    // 总结层据此跳过已确认事项，避免「同一件事被反复验证」。
    classification_status: wi.classification_status || null,
    confirmed_at: wi.confirmed_at || null,
    confirmed_by: wi.confirmed_by || null,
    content: wi.content,
    detail: wi.detail || null,
    detail_compression: wi.detail_compression || null,
    ai_role: wi.ai_role || null,
    segment_id: wi.segment_id || null,
    skills: Array.isArray(wi.skills) ? wi.skills : [],
    models: Array.isArray(wi.models) ? wi.models : [],
    // display_content 已由 WorkItem 按同一套格式生成，直接沿用（保证两处展示一致）
    display_content: wi.display_content || null,
    start_time: wi.start_time || null,
    end_time: wi.end_time || null,
    // V3.24：修掉 `Number.isFinite(Number(null)) === true` 把「取不到」写成 0 的老问题
    //   （与 V3.22 的 load_chars 同类）。AI 来源本就恒为 null —— 不产出时长（用户 2026-09-28）。
    duration_minutes:
      wi.actual_duration === null || wi.actual_duration === undefined
        ? null
        : Number.isFinite(Number(wi.actual_duration))
          ? Number(wi.actual_duration)
          : null,
    // V3.24（用户 2026-09-28）：把「时长凭什么可信」一并带进永久日志。
    //   否则下游只看到一个数字，无法分辨它来自人工闭合时段，还是 AI 会话推导。
    //   枚举见 log-core 的 VALID_DURATION_SOURCE；无依据时为 null。
    duration_source: C.VALID_DURATION_SOURCE.includes(wi.duration_source)
      ? wi.duration_source
      : null,
    source: mapSource(wi.source),
    // V3.4：关联键。解析顺序（**只在有证据时才写，绝不推断**）：
    //   ① WorkItem 已有 conversation_id（人工/结算阶段已确认过）
    //   ② 用 WorkItem 的 session_id 去 Conversation Log 里**查**（查不到就是 null）
    // 曾经这里恒为 null —— 因为上一步就没把 session_id 带下来，
    // 于是「按项目看 Token」永远算不出数。
    conversation_id: resolveConversationId(wi, ctx),
    // 关联证据本身也留档：结算发生在导出之后时，可由 activity-link 重新回链
    session_id: wi.session_id || null,
    status: STATUS_MAP[wi.status] || 'needs_confirmation',
    // V3.23（用户 2026-09-28）：把 TickTick 对应关系一并带进永久日志。
    //   此前 toActivity 不映射 ticktick，于是某个日期**不再保留在 pending/ 之后**
    //   （WorkItem 会被跨日丢弃），taskId 就彻底失传 —— 已实测：09-20~09-23 共 106 条
    //   事项的 taskId 全部缺失。永久日志是唯一还能承载它的地方，故在此落位。
    //   无 taskId 时置 null（与 WorkItem 的 normalizeTicktick 同一口径，不保留半截对象）。
    ticktick: C.normalizeTicktick(wi).ticktick,
    confidence: ['high', 'medium', 'low'].includes(wi.confidence)
      ? wi.confidence
      : wi.project_confidence === 'high'
        ? 'high'
        : 'medium',
    work_item_id: wi.id,
  };
}

/**
 * 解析 Work Activity 的 `conversation_id`。
 *
 * `ctx.convBySession` 是「已结算对话」的 `session_id → conversation_id` 索引；
 * 没有索引（或查不到）时返回 `null` —— **不用日期去派生**，因为派生式里的日期
 * 是「会话归档日」，与「事项发生日」不一定相同，算出来的 ID 可能根本不存在。
 */
function resolveConversationId(wi, ctx) {
  if (wi.conversation_id) return String(wi.conversation_id);
  if (!ctx || !ctx.convBySession || !wi.session_id) return null;
  return AL.conversationIdOf(wi.session_id, ctx.convBySession);
}

/* ------------------------------------------------------------------ *
 * 核心（可被其它脚本复用）
 * ------------------------------------------------------------------ */

/** 从一份 DailyLog 的 records 里挑出可导出的项（必须有 id 与 content） */
const exportable = (log) => (log.records || []).filter((r) => r && r.id && r.content);

/**
 * 把某天的 WorkItem 导出为 Work Activity（幂等 upsert）。
 *
 * @returns {object} 报告。**不抛异常** —— 以便调用方（如 daily-summary save）在
 *          导出失败时仍能完成自己的主流程。
 */
function exportRecords(dir, date, records) {
  const d = CS.assertDate(date);
  if (!records.length) {
    return { action: 'nothing_to_export', date: d, exportable: 0, written: null };
  }
  // 关联证据：一次导出只建一次「已结算对话」索引
  const ctx = { convBySession: AL.buildSessionConversationIndex(dir).index };
  const mapped = records.map((r) => toActivity(r, ctx));
  const written = CS.upsertWorkActivity(dir, mapped, { date: d });
  // 覆盖率如实回报：没挂上的要能解释为什么（无证据 / 会话尚未结算）
  const noEvidence = mapped.filter((a) => !a.conversation_id && !a.session_id).length;
  const unsettled = mapped.filter((a) => !a.conversation_id && a.session_id).length;
  return {
    action: written.created ? 'exported' : 'already_exported',
    date: d,
    exportable: records.length,
    target: CS.logPath(dir, 'work_activity', d),
    written,
    link_coverage: {
      total: mapped.length,
      with_conversation: mapped.length - noEvidence - unsettled,
      no_session_evidence: noEvidence,
      session_not_settled: unsettled,
    },
  };
}

/**
 * 导出当天的 WorkItem（从 current.json 读）。供 `daily-summary.js save` 直接调用。
 *
 * 只有在「current.json 的日期与目标日期一致」时才导出 —— 否则会把别的日期的
 * 事项写到错误的位置（宁可跳过并说明）。
 */
function exportForDate(dir, date) {
  const log = C.readJSON(C.currentPath(dir), null);
  if (!log || !Array.isArray(log.records)) {
    return { action: 'skipped', reason: 'current.json 不可读或缺少 records', date: String(date) };
  }
  if (String(log.date) !== String(date)) {
    return {
      action: 'skipped',
      reason: `current.json 日期为 ${log.date}，与目标 ${date} 不一致`,
      date: String(date),
    };
  }
  return exportRecords(dir, date, exportable(log));
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function run() {
  const { flags } = C.parseArgs(process.argv.slice(2));
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);
  const dryRun = C.flagBool(flags, 'dry-run');

  const from = C.flagStr(flags, 'from');
  let log = null;
  let sourcePath = null;

  if (from) {
    sourcePath = path.resolve(from);
    log = C.readJSON(sourcePath, null);
    if (!log || !Array.isArray(log.records)) {
      throw new C.LogError(`--from 指向的文件不是有效的 DailyLog（缺少 records）：${sourcePath}`);
    }
  } else {
    sourcePath = C.currentPath(dir);
    log = C.readJSON(sourcePath, null);
    if (!log || !Array.isArray(log.records)) {
      throw new C.LogError(`current.json 不可读或缺少 records：${sourcePath}`);
    }
  }

  const date = CS.assertDate(C.flagStr(flags, 'date') || log.date);
  const records = exportable(log);

  const report = {
    action: 'export_work_activities',
    mode: dryRun ? 'dry_run' : 'apply',
    log_directory: dir,
    source: sourcePath,
    date,
    work_items_total: (log.records || []).length,
    exportable: records.length,
    skipped_incomplete: (log.records || []).length - records.length,
    target: CS.logPath(dir, 'work_activity', date),
    written: null,
    notes: [],
  };

  if (!records.length) {
    report.action = 'nothing_to_export';
    report.notes.push(`${sourcePath} 中没有可导出的 WorkItem。`);
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  if (dryRun) {
    report.action = 'dry_run';
    const dryCtx = { convBySession: AL.buildSessionConversationIndex(dir).index };
    report.preview = records
      .map((r) => toActivity(r, dryCtx))
      .map((a) => ({
        activity_id: a.activity_id,
        work_item_id: a.work_item_id,
        start_time: a.start_time,
        duration_minutes: a.duration_minutes,
        project_name: a.project_name,
        work_type: a.work_type,
        conversation_id: a.conversation_id,
        session_id: a.session_id,
        ai_role: a.ai_role,
        segment_id: a.segment_id,
        display_content: a.display_content,
      }));
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  // 幂等 upsert：activity_id 由 WorkItem id 派生，重复导出只会覆盖同一行
  const core = exportRecords(dir, date, records);
  report.action = core.action;
  report.written = core.written;
  report.link_coverage = core.link_coverage || null;
  report.notes.push(
    core.written && core.written.created
      ? `已导出 ${core.written.created} 条工作事项到永久日志（logs/${date}/work-activities.jsonl）。`
      : '已全部导出过，本次未新增记录（幂等）。'
  );
  if (core.link_coverage && core.link_coverage.session_not_settled) {
    report.notes.push(
      `${core.link_coverage.session_not_settled} 条事项的会话尚未结算，conversation_id 暂空；` +
        '结算后执行 `settle-conversation.js --relink` 即可补齐（不必重新导出）。'
    );
  }
  if (core.link_coverage && core.link_coverage.no_session_evidence) {
    report.notes.push(
      `${core.link_coverage.no_session_evidence} 条事项没有会话证据（人工记录或历史批量导入），` +
        'conversation_id 保持 null —— 这是事实，不做推断。'
    );
  }

  if (!C.flagBool(flags, 'quiet')) C.emit(report);
  return C.EXIT.OK;
}

module.exports = { toActivity, exportRecords, exportForDate, exportable };

C.runMain(() => {
  const { pos } = C.parseArgs(process.argv.slice(2));
  if (pos[0] === 'help') {
    C.emitText(USAGE);
    return C.EXIT.OK;
  }
  return run();
}, module); // ← 本模块会被 daily-summary.js require，必须显式传入自己的 module 做 CLI 守卫
