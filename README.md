# Skill Collection

Public collection of reusable Agent Skills.

## Included Skills

| Skill | Description |
| --- | --- |
| [`work-time-tracking`](skills/work-time-tracking/) | Work activity tracking, AI usage attribution, and daily/weekly/monthly reviews. |
| [`ticktick-work-review`](skills/ticktick-work-review/) | TickTick task synchronization, completion matching, work backfill, and review workflows. |

## Repository Layout

Each skill lives in its own directory under `skills/`:

```text
skills/
`-- <skill-name>/
    |-- SKILL.md
    |-- GUIDE.md
    |-- VERSION
    |-- CHANGELOG.md
    |-- references/
    `-- scripts/
```

## Install

Install a skill by copying its directory into the skill root used by your Agent host. Keep the required `SKILL.md` file at the root of the installed skill directory.

For example, install `work-time-tracking` into a skills directory with:

```powershell
Copy-Item -Recurse -Force .\skills\work-time-tracking "<skills-root>\work-time-tracking"
```

Some hosts provide their own skill manager. In that case, use the manager's local-install command with the path to the skill directory.
