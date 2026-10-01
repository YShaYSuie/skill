#!/usr/bin/env node
'use strict';
/**
 * update-work-item.js — 安全修改 WorkItem / 处理待确认候选。
 *
 * 用法：
 *   update-work-item.js pause   --match "GPU" [--time 10:00]
 *   update-work-item.js resume  --match "GPU" [--time 10:20]
 *   update-work-item.js done    --match "GPU" [--time 11:10]
 *   update-work-item.js switch  --match "设备管理" [--time 09:30]
 *   update-work-item.js edit    --id <id> --content "..." --estimated 120 --status completed
 *   update-work-item.js promote --pending <cand_id> --start 10:00 --end 11:00
 *   update-work-item.js dismiss --pending <cand_id>
 *   update-work-item.js delete  --id <id>
 *
 * 所有子命令都支持 --id / --match 定位；匹配到多个时会列出候选并要求精确指定。
 */

const C = require('./lib/log-core');

const USAGE = `update-work-item.js — 安全修改 WorkItem

  子命令：pause | resume | done | cancel | switch | edit | delete | promote | dismiss | link | unlink

  公共参数：
    --id <id>            精确指定
    --match <关键字>      按内容模糊匹配（必须唯一命中）
    --pending <id>       待确认候选 ID（promote / dismiss 用）
    --time <HH:MM>       操作时间，默认当前时间
    --only-open          只在进行中/已暂停的事项中匹配
    --dir <路径> --actor <标识>

  edit 可改字段：
    --content --start --end --status --estimated --source --confidence --notes --tag
    --detail --ai-role --segment-id --skill --model
    --project <名称|null>            改项目归属（null/none/- 表示清空）
    --work-type <名称|null>          改工作类型（null/none/- 表示清空）
    --project-confidence <high|medium>   改项目时一并更新置信度（默认 high）
    --work-type-confidence <high|medium> 改类型时一并更新置信度（默认 high）
    注：项目与工作类型都是结构化字段，改后由 normalizeItem 重算 display_content。

  link：回写 TickTick 任务的对应关系（§30/§31 taskId 回写）。
        值由 ticktick-work-review 在同步回报中给出，本技能只保存、不操作 TickTick API。
    --task-id <id>       必填。TickTick Task ID
    --project-id <id>    可选。TickTick 清单 ID
    --synced-at <ISO>    可选，默认当前时间
    查找顺序：current.json → pending/*.json（V3.23）。命中已跨日的事项时
    就地写回 pending/<date>.json，返回体带 where:"pending" 与文件名。

  unlink：清除对应关系（ticktick 置 null），后续同步回退为标题匹配。
          等价于 link --unlink。

  switch：关闭其他事项的开放时段，并在目标事项上开启新时段（顺序切换）。
          其他事项 status 不变（§17）。

  promote：把 pending_items 中的候选转为正式 WorkItem（§20）。
`;

function locate(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);
  return dir;
}

function targetFlags(flags) {
  const id = C.flagStr(flags, 'id');
  const match = C.flagStr(flags, 'match');
  if (!id && !match) throw new C.LogError('需要 --id 或 --match 指定要操作的事项。');
  return { id, match, onlyOpen: C.flagBool(flags, 'only-open') };
}

function timeOf(flags) {
  const t = C.flagStr(flags, 'time');
  return t ? C.fmtHHMM(C.parseHHMM(t)) : C.nowHHMM();
}

/**
 * 状态变更同时上报宿主活跃，使 /status 能反映真实链路。
 * 刻意不带 mechanism：已登记的宿主触发能力只升不降。
 */
const collectorOp = (source) => ({
  kind: 'host',
  registry: {
    host: source,
    tool: source,
    available: true,
    last_activity_at: C.nowIso(),
    activity_delta: 1,
  },
});

function simpleAction(cmd, flags) {
  const dir = locate(flags);
  const actor = C.flagStr(flags, 'actor') || 'workbuddy';

  if (cmd === 'promote' || cmd === 'dismiss') {
    const pendingId = C.flagStr(flags, 'pending') || C.flagStr(flags, 'id');
    const match = C.flagStr(flags, 'match');
    if (!pendingId && !match) {
      throw new C.LogError(`${cmd} 需要 --pending <candidate id> 或 --match <关键字>。`);
    }
    if (cmd === 'dismiss') {
      const result = C.runMutation(dir, actor, [{ kind: 'dismiss', id: pendingId, match }], {});
      C.emit({
        action: 'dismissed',
        version: result.log.version,
        dismissed: result.applied[0],
        pending_left: (result.log.pending_items || []).length,
      });
      return C.EXIT.OK;
    }
    const set = {};
    for (const f of ['content', 'notes']) {
      const v = C.flagStr(flags, f);
      if (v !== null) set[f] = v;
    }
    if (C.flagStr(flags, 'start') !== null) {
      set.start_time = C.fmtHHMM(C.parseHHMM(C.flagStr(flags, 'start')));
    }
    if (C.flagStr(flags, 'end') !== null) {
      set.end_time = C.fmtHHMM(C.parseHHMM(C.flagStr(flags, 'end')));
    }
    const status = C.flagStr(flags, 'status');
    if (status && !C.VALID_STATUS.includes(status)) throw new C.LogError(`--status 非法：${status}`);
    const source = C.flagStr(flags, 'source');
    if (source) {
      if (!C.VALID_SOURCE.includes(source)) throw new C.LogError(`--source 非法：${source}`);
      set.source = source;
    }
    const result = C.runMutation(
      dir,
      actor,
      [{ kind: 'promote', id: pendingId, match, set, status }],
      {}
    );
    C.emit({
      action: 'promoted',
      version: result.log.version,
      work_item: result.log.records.slice(-1)[0],
      promoted_from: result.applied[0].promoted_from,
      pending_left: (result.log.pending_items || []).length,
      note: '候选已转为正式 WorkItem；若仍缺开始时间，状态保持 needs_confirmation（§2.1）。',
    });
    return C.EXIT.OK;
  }

  const t = targetFlags(flags);
  const hhmm = timeOf(flags);

  if (cmd === 'pause' || cmd === 'resume' || cmd === 'done' || cmd === 'cancel') {
    const log0 = C.readJSON(C.currentPath(dir), null) || {};
    const rec = C.resolveOne(log0, t.id, t.match, t.onlyOpen);
    const op = { kind: 'patch', id: rec.id, set: {} };
    if (cmd === 'pause') {
      op.set.status = 'paused';
      op.segmentsClose = [hhmm];
    } else if (cmd === 'resume') {
      op.set.status = 'in_progress';
      op.segmentsAdd = [{ start: hhmm, end: null }];
    } else if (cmd === 'done') {
      op.set.status = 'completed';
      op.set.end_time = hhmm;
      op.segmentsClose = [hhmm];
    } else {
      op.set.status = 'cancelled';
      op.set.end_time = hhmm;
      op.segmentsClose = [hhmm];
    }
    const result = C.runMutation(dir, actor, [op, collectorOp(rec.source)], {});
    C.emit({
      action: cmd,
      version: result.log.version,
      work_item: result.log.records.find((r) => r.id === rec.id),
      note:
        cmd === 'resume'
          ? '已开启新的 time_segment，原有时间段保留（§16）。'
          : '已关闭所有开放时段，实际时长按时间段之和计算（§16）。',
    });
    return C.EXIT.OK;
  }

  if (cmd === 'switch') {
    const log0 = C.readJSON(C.currentPath(dir), null) || {};
    const rec = C.resolveOne(log0, t.id, t.match, true);
    const ops = [];
    let closed = 0;
    for (const other of log0.records || []) {
      if ((other.time_segments || []).some((s) => !s.end)) {
        ops.push({ kind: 'patch', id: other.id, segmentsClose: [hhmm] });
        if (other.id !== rec.id) closed += 1;
      }
    }
    ops.push({
      kind: 'patch',
      id: rec.id,
      set: { status: 'in_progress' },
      segmentsAdd: [{ start: hhmm, end: null }],
    });
    ops.push(collectorOp(rec.source));
    const result = C.runMutation(dir, actor, ops, {});
    C.emit({
      action: 'switch',
      version: result.log.version,
      work_item: result.log.records.find((r) => r.id === rec.id),
      closed_other_segments: closed,
      note: '其他事项的开放时段已关闭，status 保持不变（§17）。',
    });
    return C.EXIT.OK;
  }

  if (cmd === 'delete') {
    const log0 = C.readJSON(C.currentPath(dir), null) || {};
    const rec = C.resolveOne(log0, t.id, t.match, false);
    const result = C.runMutation(dir, actor, [{ kind: 'delete', id: rec.id }], {});
    C.emit({
      action: 'deleted',
      version: result.log.version,
      work_item_id: rec.id,
      content: rec.content,
    });
    return C.EXIT.OK;
  }

  if (cmd === 'edit') {
    const set = {};
    let redaction = null;
    // §12/§28：项目、工作类型与 content 均为结构化字段，改后由 normalizeItem 重算 display_content
    for (const f of ['project_name', 'work_type']) {
      const v = C.flagStr(flags, f === 'project_name' ? 'project' : 'work-type');
      if (v !== null) {
        if (v === 'null' || v === 'none' || v === '-') {
          set[f] = null;
          set[f === 'project_name' ? 'project_confidence' : 'work_type_confidence'] = null;
        } else {
          set[f] = v;
          const cKey = f === 'project_name' ? 'project-confidence' : 'work-type-confidence';
          const c = C.flagStr(flags, cKey) || 'high';
          if (!C.VALID_CONFIDENCE.includes(c)) throw new C.LogError(`--${cKey} 非法：${c}`);
          set[f === 'project_name' ? 'project_confidence' : 'work_type_confidence'] = c;
        }
      }
    }
    for (const f of ['content', 'status', 'source', 'confidence', 'notes']) {
      const v = C.flagStr(flags, f);
      if (v !== null) set[f] = v;
    }
    if (set.status && !C.VALID_STATUS.includes(set.status)) {
      throw new C.LogError(`--status 非法：${set.status}（允许：${C.VALID_STATUS.join(', ')}）`);
    }
    if (set.source && !C.VALID_SOURCE.includes(set.source)) {
      throw new C.LogError(`--source 非法：${set.source}`);
    }
    if (set.confidence && !C.VALID_CONFIDENCE.includes(set.confidence)) {
      throw new C.LogError(`--confidence 非法：${set.confidence}`);
    }
    // 只拒绝多行（日志不是聊天备份）；长度超限交给 Security Filter 用 AI 压缩，
    // 不再直接报错 —— 否则用户贴一段较长描述就只能自己先手工精简。
    if (set.content && set.content.includes('\n')) {
      throw new C.LogError('--content 必须是单行工作事项摘要。');
    }
    // §6/§12：改写内容同样要过 Security Filter（超长 → AI 压缩，失败才截断）
    if (set.content) {
      const filtered = C.security.filterContent(set.content, { security: C.readConfig(dir).security });
      if (!filtered.content) throw new C.LogError('内容经安全过滤后为空，未写入。');
      set.content = filtered.content;
      redaction = {
        redacted: filtered.redacted,
        hits: filtered.hits,
        truncated: filtered.truncated,
        summarized: filtered.summarized,
      };
      const cm = C.security.compressionMeta(filtered);
      if (cm) set.content_compression = cm;
    }
    const detailRaw = C.flagStr(flags, 'detail');
    if (detailRaw !== null) {
      if (['null', 'none', '-'].includes(detailRaw.toLowerCase())) {
        set.detail = null;
        set.detail_compression = null;
      } else {
        const detailFiltered = C.security.filterDetail(detailRaw, {
          security: C.readConfig(dir).security,
        });
        set.detail = detailFiltered.detail;
        set.detail_compression = C.security.detailMeta(detailFiltered);
      }
    }
    const aiRole = C.flagStr(flags, 'ai-role');
    if (aiRole !== null) {
      if (['null', 'none', '-'].includes(aiRole.toLowerCase())) set.ai_role = null;
      else if (!C.VALID_AI_ROLE.includes(aiRole)) {
        throw new C.LogError(`--ai-role 非法：${aiRole}（允许：${C.VALID_AI_ROLE.join(', ')}）`);
      } else {
        set.ai_role = aiRole;
      }
    }
    const segmentId = C.flagStr(flags, 'segment-id');
    if (segmentId !== null) {
      set.segment_id = ['null', 'none', '-'].includes(segmentId.toLowerCase()) ? null : segmentId;
    }
    const skillArgs = C.flagList(flags, 'skill');
    if (skillArgs.length) set.skills = skillArgs;
    const modelArgs = C.flagList(flags, 'model');
    if (modelArgs.length) set.models = modelArgs;
    const estRaw = C.flagStr(flags, 'estimated');
    if (estRaw !== null) {
      if (['null', 'none', '-'].includes(estRaw.toLowerCase())) set.estimated_duration = null;
      else {
        const n = Number(estRaw);
        if (!Number.isFinite(n) || n <= 0) throw new C.LogError('--estimated 需要正数或 null。');
        set.estimated_duration = n;
      }
    }

    const log0 = C.readJSON(C.currentPath(dir), null) || {};
    const rec0 = C.resolveOne(log0, t.id, t.match, false);

    const tags = C.flagList(flags, 'tag');
    if (tags.length) set.tags = [...new Set([...(rec0.tags || []), ...tags])].sort();

    const op = { kind: 'patch', id: rec0.id, set };
    const startRaw = C.flagStr(flags, 'start');
    const endRaw = C.flagStr(flags, 'end');

    if (startRaw !== null) {
      const hhmm = C.fmtHHMM(C.parseHHMM(startRaw));
      const first = (rec0.time_segments || [])[0] || null;
      if (first) op.segmentsDrop = [{ start: first.start }];
      op.segmentsAdd = [{ start: hhmm, end: first ? first.end || null : null }];
      set.start_time = hhmm;
    }
    if (endRaw !== null) {
      const hhmm = C.fmtHHMM(C.parseHHMM(endRaw));
      set.end_time = hhmm;
      op.segmentsClose = [hhmm];
      if (['needs_confirmation', 'not_started'].includes(rec0.status) && !set.status) {
        set.status = 'completed';
      }
    }
    if (!Object.keys(set).length && !op.segmentsClose && !op.segmentsAdd) {
      throw new C.LogError('edit 未指定任何要修改的字段。');
    }

    const result = C.runMutation(dir, actor, [op], {});
    C.emit({
      action: 'edited',
      version: result.log.version,
      work_item: result.log.records.find((r) => r.id === rec0.id),
    });
    return C.EXIT.OK;
  }

  if (cmd === 'link' || cmd === 'unlink') {
    // §30/§31：回写 TickTick 对应关系。本技能只保存，不操作 TickTick API（§4 职责边界）。
    //   link   --id <WorkItem> --task-id <ticktick taskId> [--project-id <id>] [--synced-at <ISO>]
    //   unlink --id <WorkItem>
    const unlink = cmd === 'unlink' || C.flagBool(flags, 'unlink');
    const taskId = C.flagStr(flags, 'task-id');
    if (!unlink && !taskId) {
      throw new C.LogError('link 需要 --task-id <值>，或改用 unlink / --unlink 清除对应关系。');
    }
    if (unlink && taskId) {
      throw new C.LogError('unlink 与 --task-id 不能同时使用。');
    }
    if (taskId && taskId.length > C.MAX_TICKTICK_ID_LENGTH) {
      throw new C.LogError(`--task-id 长度超过 ${C.MAX_TICKTICK_ID_LENGTH}，疑似非法值。`);
    }

    let ticktick = null;
    if (!unlink) {
      const projectId = C.flagStr(flags, 'project-id');
      const syncedAt = C.flagStr(flags, 'synced-at') || C.nowIso();
      ticktick = {
        taskId,
        projectId: projectId || null,
        syncedAt,
      };
    }

    // V3.23（用户 2026-09-28）：先查 current.json，查不到再查 pending/*.json。
    //   已跨日的事项此前**完全无法回写 taskId** —— link 只读 current.json，
    //   而 pending/ 里的日志不在 runMutation 的作用域内。这里改成：
    //     · current.json 命中 → 走原有 runMutation（带 state 同步）
    //     · pending 命中     → 用库层就地写回该 pending 日志
    const located = C.resolveWorkItemAnywhere(dir, t.id, t.match, false);

    if (located.where === 'pending') {
      const r = C.patchPendingWorkItem(
        dir,
        located.date,
        located.rec.id,
        { ticktick },
        { actor }
      );
      C.emit({
        action: unlink ? 'unlinked' : 'linked',
        where: 'pending',
        date: r.date,
        file: r.file,
        work_item_id: r.work_item_id,
        content: r.before.content,
        ticktick_before: r.before.ticktick || null,
        ticktick: r.after.ticktick,
        note: unlink
          ? `目标事项已跨日，已清除 pending/${r.date}.json 中的对应关系。`
          : `目标事项已跨日，已写入 pending/${r.date}.json（V3.23 补齐的通路）；` +
            '后续同步应优先按 taskId 定位（见 ticktick-sync-contract.md §5.6）。',
      });
      return C.EXIT.OK;
    }

    const rec0 = located.rec;
    const before = rec0.ticktick || null;

    const result = C.runMutation(dir, actor, [{ kind: 'patch', id: rec0.id, set: { ticktick } }], {});
    const after = result.log.records.find((r) => r.id === rec0.id);
    C.emit({
      action: unlink ? 'unlinked' : 'linked',
      where: 'current',
      version: result.log.version,
      work_item_id: rec0.id,
      content: rec0.content,
      ticktick_before: before,
      ticktick: after.ticktick,
      note: unlink
        ? '已清除 TickTick 对应关系，后续同步将回退为标题匹配。'
        : '已保存 TickTick 对应关系；后续同步应优先按 taskId 定位（见 ticktick-sync-contract.md §5.6）。',
    });
    return C.EXIT.OK;
  }

  throw new C.LogError(`未知子命令：${cmd}`);
}

C.runMain(() => {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  const ALLOWED = [
    'pause',
    'resume',
    'done',
    'cancel',
    'switch',
    'edit',
    'delete',
    'promote',
    'dismiss',
    'link',
    'unlink',
  ];
  if (!cmd || cmd === 'help' || C.flagBool(flags, 'help')) {
    C.emitText(USAGE);
    return cmd ? C.EXIT.OK : C.EXIT.USAGE;
  }
  if (!ALLOWED.includes(cmd)) {
    throw new C.LogError(`未知子命令：${cmd}（允许：${ALLOWED.join('/')}）`);
  }
  return simpleAction(cmd, flags);
});
