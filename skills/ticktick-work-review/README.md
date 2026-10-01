# TickTick Work Review

## Overview

`ticktick-work-review` is an Agent Skill for turning TickTick from a task list into a reliable work ledger. It helps an Agent compare planned tasks with work described by the user, identify completed work, record meaningful missing work, review task health, and produce practical daily, weekly, or monthly summaries.

The Skill focuses on synchronization decisions: which TickTick task should be created or updated, which fields should receive information, and when user authorization is required.

## Features

- Daily review: reconcile TickTick tasks with work the user actually completed.
- Daily planning: prioritize today's work without changing TickTick unless authorized.
- Task cleanup: identify unclear, duplicate, or stale tasks and propose specific changes.
- Period review: summarize work and time allocation for a week, month, or custom range.
- Next-action planning: group unfinished work into priority, continuation, and optional items.
- Health check: report concrete task-system problems without producing a score.
- Completion and backfill rules: distinguish "task is complete" from "the user did related work."
- TickTick content validation: enforce a consistent note format before writes and after read-back.

## Requirements

- A TickTick MCP server connected to the Agent host.
- The MCP tools referenced by this Skill for listing projects, reading tasks, creating tasks, completing tasks, and updating tasks.
- Node.js for the optional content validator in `scripts/validate-content.js`.

The Skill does not store TickTick credentials. Authentication remains in the MCP server or Agent host configuration.

## Install

Copy this directory into the skills root used by your Agent host, keeping `SKILL.md` at the root of the installed Skill directory:

```powershell
Copy-Item -Recurse -Force .\skills\ticktick-work-review "<skills-root>\ticktick-work-review"
```

If your Agent host provides a Skill manager, use its local install command with this directory instead.

## Usage

Example requests:

```text
复盘今天，并同步到 TickTick
帮我安排今天做什么
整理一下 TickTick，找出需要处理的任务
总结本周的工作和时间投入
帮我整理下一步
检查一下我的 TickTick 健康度
```

The Agent loads `SKILL.md` and the relevant files under `references/` for the selected mode.

## Configuration

The Skill relies on the MCP capability names and parameters documented in `references/mcp-capabilities.md`. Tool availability can vary by TickTick MCP implementation; unavailable operations are reported instead of being simulated.

Write behavior follows the authorization rules in `SKILL.md`:

- Read-only reviews do not modify TickTick.
- Suggested plans remain suggestions until the user explicitly asks to apply them.
- Task deletion requires explicit user authorization and is never inferred.
- Unrecorded time is reported as unrecorded rather than estimated as fact.

## Validation

Run the validator self-test:

```powershell
node scripts/validate-content.js --selftest
```

Validate one note:

```powershell
node scripts/validate-content.js --source ai --content "<content>"
```

Supported `--source` values are `ai`, `manual`, `manual_open`, and `none`.

## Repository Layout

```text
ticktick-work-review/
|-- SKILL.md
|-- README.md
|-- VERSION
|-- CHANGELOG.md
|-- references/
`-- scripts/
```

## Version

Current public release: `1.2.0`. See `CHANGELOG.md` for the public release history and `references/changelog.md` for the detailed behavior history.
