# headway — specification (0.2)

headway is a Claude Code mod: a plugin with a hooks module that tracks the progress of whatever
Claude is working on and draws it in a band above the prompt and in a pane. It works out what the
plan is from the best source it has (a plan file you pin, a list Claude reports, a plan-mode plan
you approve, Claude's task tools, a workflow's phases), tracks every subagent under the step it
works on, flags blocked and stalled agents, warns about dispatches that name no model, and shows
what the session costs. One tool call tells Claude the same after `/compact`.

This document specifies headway 0.2 as the code stands, and is the reference for contributors.
Facts marked *verified* were checked on
Claude Code 2.1.296 (appendix A). Where a fact could not be checked it is a probe in appendix B,
not an assumption.

## 1. Purpose and non-goals

Purpose: one glance tells the user where the work stands, which step is live, which agents work
it, which are blocked or stalled, and what the session has cost. Without any setup: a plain
multi-step prompt is enough to get a goal and its steps on screen.

Non-goals, never built: denying or rewriting a dispatch; writing the plan file or any other file
of the user's; retry or scheduling of agents; a second tracking file of any kind; a log of
permissions or blocked commands; any cross-session or cross-machine view.

## 2. Install, layout, compatibility, licence

The repository is public on GitHub and is its own marketplace. The plugin lives at the repository
root; `.claude-plugin/marketplace.json` sits beside `.claude-plugin/plugin.json` and lists the one
plugin with `source: "./"`. This is the layout a single-plugin mod repository installs from with
the two commands below, and the one the engine's plugin loader reads without a sub-directory.

```
.claude-plugin/plugin.json          name "headway", version, description, license "MIT",
                                    "types": "./types/index.d.ts", userConfig (section 13)
.claude-plugin/marketplace.json     name "<marketplace>", owner, plugins: [{ name: "headway", source: "./" }]
hooks/hooks.json                    { "modules": ["./register.tsx"] }
hooks/*.ts, hooks/*.tsx             section 15
types/index.d.ts                    the `$.state` atoms
tests/*.test.ts, tests/fixtures/    section 16
README.md  SPEC.md  LICENSE  CONTRIBUTING.md
```

Install, inside Claude Code:

```
/plugin marketplace add atharv6f/headway
/plugin install headway@headway
```

then restart. Update with `claude plugin marketplace update <marketplace>` and
`claude plugin update headway@<marketplace>`; a manifest change (`version`, `userConfig`) is
picked up only by that update plus a restart.

| Fact | Value |
| :- | :- |
| Minimum Claude Code | 2.1.287 (the mods API) |
| Verified on | 2.1.296 |
| `isDeferred: false` on the tool | honoured from 2.1.293; ignored earlier (the tool is then deferred and found by ToolSearch) |
| Dependencies | none. The skins plugin is optional (section 11) |
| Licence | MIT; `LICENSE` names the copyright holder as `atharv6f` |

## 3. Levels and status model

| Level | What it is | Bar |
| :- | :- | :- |
| Goal | The active plan source (section 4) | tasks done / total; with a partial rule or partial statuses, done · partial · open / total |
| Task | One step of the plan: a checklist item, a table row, a reported or plan-mode step, a task-tool item, a workflow phase; or a group from a group map. Outside the plan, the workflow run or the `Agents` group an unmatched agent falls into | agents finished / dispatched; or the task's own sub-checklist done / total when it has one |
| Agent | One subagent, under the task or group it was matched to | none; status glyph, elapsed, last activity, est. cost |
| Log | Completions, flips and warnings, newest first; 200 drawn, 500 stored | none |

Agent statuses, in the order the Agents tab sorts them:

| Status | Enters when | Leaves when |
| :- | :- | :- |
| blocked | `turn.complete` with `reason === 'answer'` and a line in the first 4 KiB of `e.answer` whose first word is `BLOCKED` (found with string operations; the text after it, an optional `:` dropped, is the question) | a `turn.step` arrives (a SendMessage resume): running, log `resumed` |
| stalled | running and no `turn.step` for `stallMinutes`; or spawned and no `turn.step` within `startMinutes` | a `turn.step` (running) or a `turn.complete` |
| running | first `turn.step` with its `agentId` | `turn.complete` |
| queued | `agent.spawn` seen, no `turn.step` yet | first step, or the start timeout |
| failed | `turn.complete` with `reason` `error`, `refusal` or `aborted`; or `$.agent.list()` reports `failed` or `killed` | a `turn.step`: running, log `resumed` |
| done | `turn.complete` with `reason === 'answer'` and no BLOCKED line | a `turn.step`: running, log `resumed` |
| lost | a reload (section 12) finds it queued, running or stalled with no sign of life since this process started | a `turn.step`: running, log `resumed` |

Transitions (`hooks/agents.ts`):

| From | Event | To | Log |
| :- | :- | :- | :- |
| (none) | `agent.spawn` | queued | |
| queued, stalled | `turn.step` | running | |
| queued, running, stalled | `turn.complete`, answer with a BLOCKED line | blocked | `blocked` |
| queued, running, stalled | `turn.complete`, answer | done | `done` |
| queued, running, stalled | `turn.complete` `error`/`refusal`/`aborted`; `$.agent.list()` `failed`/`killed` | failed | `failed` |
| queued | no `turn.step` within `startMinutes` | stalled | `stalled` |
| running | no `turn.step` for `stallMinutes` | stalled | `stalled` |
| queued, running, stalled | reload into a new process, last sign of life before it started | lost | `lost (session restarted)`, once |
| blocked, done, failed, lost | `turn.step` (a SendMessage resume raises no new `agent.spawn`) | running | `resumed` |
| blocked, done, failed, lost | `turn.complete`, the timer | unchanged | |

Finished = done, failed, blocked, lost. Dispatched = every status. A timer (`$.clock.every(15_000)`)
re-evaluates the stall rules and redraws when a status flips.

Task status, in this precedence: done when the source says so (a done rule, a `done` status); active
when at least one of its agents is not finished; partial when the source says so; open otherwise.
A group's status follows the same rule over its tasks and its agents.

Current task: the task (or group) of the most recently spawned unfinished agent; if none, the
single `partial` task of a reported, plan-mode or task-tool source; if none, the workflow run or
`Agents` group of the most recently spawned unfinished agent; if none, the task of the most recent
completion (a lost agent is neither). The `focus` tool action overrides until the next spawn. A
blocked or stalled agent puts `⊘ n blocked` or `◌ n stalled` in band line 2 and sorts its row to
the top of the Agents tab and the Plan tree.

## 4. Plan sources (0.2)

### 4.1 Precedence and the source tag

The goal is drawn from the first source in this order that has data:

| # | Source | Has data when | Tag on band line 1 |
| :- | :- | :- | :- |
| 1 | pinned file (`track`, 4.2) | a filter is pinned (even while the file is unreadable) | `file` |
| 2 | reported plan (`report`, 4.3) | the reported list has at least one task | `reported` |
| 3 | plan-mode plan (4.4) | an approved plan parsed to at least one step | `plan` |
| 4 | task tools (4.5) | the task list has at least one item | `tasks` |
| 5 | workflow phases (4.6) | a Workflow run whose script declares `meta.phases` has been started, the newest of them, running or over | `phases` |
| 6 | nothing (4.7) | agents exist | none |

The tag is one dim word in `muted` after the count on band line 1 and in the `state` block's goal
line. Lower sources keep their data while a higher one is drawn; when the higher one goes (an
`untrack`, a cleared report) the next one shows. A reported or plan-mode list whose every task is
`done` records the moment it got there (`doneAt`, cleared when a task reopens); while finished it
yields to any lower source whose data moved after that moment (a task-tool item added or changed,
a phases run whose newest call or spawn is later), and a new full `report` list or plan-mode
approval replaces it as before. Two rules cross the sources:

- A plan-mode approval starts a new piece of work: it clears the reported list and the task-tool
  list before it becomes the plan-mode source. `track` and `untrack` touch only the file source.
- A `report` call with `updates` or `done` applies to the tasks of the active source when that
  source is reported or plan-mode; against any other active source it is refused with
  `refused: updates apply to a reported or plan-mode list`.

Whenever the active source changes (a plan-mode approval, an `untrack` that reveals a lower source,
a new report), every agent is re-matched (section 5.3) and finished agents stay; only a `track` of a
different filter drops finished agents (4.2). A plan-mode approval and a full `report` list that is
new work begin new work. A list is new work when fewer than half of its tasks share an id and a
title (compared in any case, spacing collapsed) with the reported list it replaces; a re-send that
adds a task or fixes a title is not, and its finished agents re-match as usual. At new work every agent finished at that moment is marked `previous` and, while it stays finished,
matches nothing at this or any later re-match (no ID, no temporal association), so it sits in its
workflow run's group or `Agents` (4.7) and never in the new plan's bars. Running agents re-match as
usual. A previous agent that resumes (its next step, after a SendMessage) drops the mark at that
step and is matched afresh against the plan drawn then (5.3, all three steps). The precedence is one ordered table in
`hooks/sources.ts`: a new source is one row there (its tag, its has-data test, its plan and title)
plus the hook that writes its data.

### 4.2 Pinned file

The user's plan file stays the only record; headway reads it and never writes it.

**Shapes.** Two generic shapes; a file may hold both, and each section is parsed independently.
Line endings `\r\n` and lone `\r` are read as `\n`; a line is read to its first 8,192 characters
(8 KiB) and the rest of it is ignored. Lines inside fenced code blocks are ignored: a
fence opener is a line that starts, after at most three spaces, with ``` or ~~~ and does not close
on the same line; it is closed by a line of the same marker at least as long, or by the end of the
file. ATX headings lose their closing `#`s.

Checklist: a line matching `^(\s*)[-*] \[( |x|X)\] (.+)$`. An item indented deeper than the nearest
item above it is that item's sub-checklist: sub-items are not tasks, they are the parent's bar, and
items at any depth below a top-level item count in that item's bar. Done = `x` or `X`.

```
## Milestone A
- [x] A1 Parse the config file
- [ ] A2 Wire the `--name` flag
  - [x] argparse
  - [ ] tests
- [ ] Write the release note
```

Here `A1` is done, `A2` is open with a 1/2 bar, and the third item has the ID `#3`.

Table: a GFM table (a header row with at least one `|`, a delimiter row such as `|---|` or
`:-- | --:`, then rows; a bare `---` is a thematic break). Cells are split on `|` not preceded by
`\`, trimmed; header names are lower-cased for matching. Done rules, in this precedence:

| Rule | Meaning |
| :- | :- |
| `column=<name>` | the row is done when the named column's cell is non-empty. Empty = blank, or a lone `-`, `–`, `—` or `[ ]` |
| `check=<name>` | the row is done when the named column's cell contains `[x]` or `[X]`; `[ ]` is open |
| `auto` (default) | if any cell of the first data row contains `[ ]`/`[x]`, `check` on that column; else if a column named `done` exists, `column=done`; else no done rule: every row open and `no done rule` shown after the count |

A `column=` or `check=` naming a column the table lacks is refused with `column not found: <name>`.
In a section that also has checklist items, a table with no done rule is prose and contributes no
tasks. A release checklist is the typical table:

```
| id | title                     | shipped    | announced |
| :- | :------------------------ | :--------- | :-------- |
| R1 | Tag and build             | 2026-10-02 | yes       |
| R2 | Publish the package       | 2026-10-03 |           |
| R3 | Update the install docs   |            |           |
```

`column=shipped partial=announced` counts `shipped 2 · announced 1 · open 1 / 3`.

Partial rule, optional and independent of the done rule: `partial=<column>` names a column with the
same empty semantics as `column=`. A row whose done rule is open but whose partial cell is non-empty
is partly done; a done row is never partial. The column headers, as written, are the words the
counts use. `partial=` on a table without that column, or on a checklist, is refused with
`partial column not found: <name>`.

**Task ID**, default rule: the leading token of a table row's first cell, or of a checklist item's
text after any opening `**` or backticks. The token is the longest prefix matching
`[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*`; when it holds no digit but is one of Step, Task,
Phase, Stage, Part, Milestone or Item (any case) followed by a space and digits, the two words are
the token (`Step 2`). A token with at least one digit is the ID (`A1`, `R2`, `Step 2`, `T08-25`); the
separator after it (`:`, `.`, `—`, `-`, or the closing `**`) is dropped from the title. A row or
item with no such token has the ID `#<n>`, its ordinal within its section (a plan-mode step with no
token takes the bare ordinal instead, 4.4). Title: the cell of a
column named `title`, else the second cell; for a checklist, the text after the ID. IDs need not be
unique: each occurrence is its own task. This is the only ID rule: no regex from the user or from
Claude is taken, since it would run on a backtracking engine.

**Section.** `section` matches case-insensitively as a prefix of a heading's text; `Milestone A`
matches `## Milestone A (4 items)`. The section runs to the next heading of the same or a higher
level. No section = the whole file. A section matching nothing is refused with
`section not found: <text>`.

**Groups.** Group = the nearest ancestor heading of a task inside the section whose text yields a
real ID under the ID rule; when none does, the nearest heading, whose ID is its text. With a group
map the map's groups replace heading groups for the tasks they name; others keep their heading
group. A group map is a JSON file: `groups[]` with `id` (string), `rows` (string array of task
IDs) and optional `title`; every other key is ignored. A row ID matching no task is counted in the
Plan tab footer as `n unmapped rows`. A task named by several groups appears under each.

```json
{ "groups": [
  { "id": "G1", "title": "Parser",  "rows": ["A1", "A2"] },
  { "id": "G2", "title": "Release", "rows": ["R1", "R2", "R3"] }
] }
```

**Pinning and polling.** A filter is `{ file, section?, doneRule, partial?, groupMap?, bounds? }`;
paths are made absolute against `$.session.cwd()` at pin time. A `track` through the model tool pins
only inside the project (section 14): the file and the group map must land, every link followed
(`$.fs.stat(path, { resolve: true }).realPath`), under the real path of the session directory, else
`refused: outside the project; ask the user to run /headway track <file> [groups=<map>]`. There is
no exception: a file under `<configDir>/plans` is outside the project like any other (4.4). A
`/headway track` the user did not type is refused outright (9.2); the user's own `/headway track`
is not held to the project. Such a
pin keeps that real directory as its `bounds` (`{ file, groupMap? }`, saved with the filter), and every
read of the file or the map, at the pin and on each poll re-read, goes stat with links followed, then
the real path checked against the bound, then a check that it leads to a regular file of at most 2 MiB (a group map: 256 KiB), else
`refused: not a regular file: <path>` or `refused: file too large: <path>` with nothing read (a pipe
or a device is never opened), then a read of that real path, never of the path as given;
a re-read that lands outside keeps the last good parse and the goal's error reads `<path> lands
outside <dir>`. A pin of the user's has no bounds and reads the real path the same way. One filter at
a time; `bounds` says who pinned it, not which plan, so it is not compared. Pinning the
filter already pinned re-reads only (log `re-read`) and takes the new pin's bounds (the user's pin
lifts Claude's); another filter replaces it: agents still at
work stay and are re-matched, finished ones are dropped, the log keeps its entries. `untrack`
clears the file source only; agents stay. The file and the group map are stat-polled
(`$.clock.every(2000)`, `$.fs.stat`) and re-parsed on a changed `mtimeMs`; a main-loop
`turn.complete` triggers one immediate stat. There is no watch API. A read or parse error keeps the
last good parse and shows `plan unreadable` in band line 1 until the next good read. One load runs
at a time; every pin, unpin and reload starts a new generation, and a load begun under an older one
writes nothing when it lands. Tasks that flip done, to partial, or back open on a re-read are
logged (`task-done`, `task-partial`, `task-reopened`).

### 4.3 Reported plan (0.2: incremental updates)

Claude calls the `headway` tool with `action: "report"` (section 9.1). Three forms:

| Input | Effect |
| :- | :- |
| `tasks: [{ id?, title, status? }]`, `title?` | replaces the reported list. `status` defaults to `open`. Ids are optional on create: a task without one gets `1..n` by position, and the list is refused if a given id repeats |
| `updates: [{ id, status }]` | sets the status of each named task; an unknown id is reported back (`unknown task: <id>`) and the rest still apply |
| `done: [ids]` | shorthand for `updates` with `status: "done"` |

Statuses: `open | partial | done`. `title` sets the goal label (4.8). `tasks` and `updates`/`done`
in one call are refused (`refused: tasks and updates or done cannot be combined in one call`); so is
a call with none of the three (`refused: tasks, updates or done required`). `updates` and `done` may
come together. The reply is `reported <n> tasks` for a list; for updates `updated <n> tasks`, then
`; unknown task: <id>` for each id no task has (`updated 1 tasks; unknown task: R9`). Further refusals,
each prefixed `refused: `: `duplicate id: <id>` (checked after the positional ids are filled in, so
`[{ id: "2" }, { title }]` is refused), `task <i>: title must be a non-empty string`, `task <i>:
status must be open, partial or done`, `update <i>: ...`, `done <i>: id must be a non-empty string`.
An id may arrive as a number and is read as its text. Updates move every task with the id, are
logged as `task-done`, `task-partial` and `task-reopened` entries (detail `done`, `partial`,
`reopened`), and do not re-match agents (5.3). Text is made safe at ingest (10.5): ids, titles and the
goal `title` are one clean line, titles and ids cut at 200 characters; a list of more than 200 tasks is
refused (`refused: at most 200 tasks`), and so is an `updates` or `done` list of more than 200 entries
(`refused: at most 200 updates`, `refused: at most 200 done ids`). The list is one group named after the title; it is
stored in `$.store` with the session (section 12) and stands until a plan-mode approval or the next
full `tasks` list; a pinned file hides it without ending it. A full list sent while a plan-mode
plan is fresh is refused (4.4, handoff).

### 4.4 Plan-mode plan (0.2)

*Verified:* `tool.call` for `ExitPlanMode` carries `e.plan` (the plan markdown) and
`e.planFilePath`, neither in the tool's input schema; after `await next(e)` an approval returns
`result: { plan, isAgent, filePath }`, a rejection returns `isError: true` with a string `result`.
Re-entering plan mode in the same session overwrites the same plan file.

headway hooks `tool.call` `{ tool: 'ExitPlanMode' }`, calls `next(e)` first, and parses
`result.plan` only when `!isError`. A rejected plan changes nothing. Each approval replaces the
previous plan-mode plan (agents are re-matched, 4.1); a call with `e.agentId` (a subagent's plan)
is ignored.

**Parsing rule.** The parser is the file parser's reader (fences, headings, checklist items) with
four shapes, chosen against three real plan shapes: bullet sections with no numbers, numbered
steps continuing across `## Phase N` headings, and top-level numbered steps with indented numbered
sub-steps.

1. Title: the first `# ` heading; a `Plan:` prefix (any case, with the colon) is dropped. It is the
   goal label. Prose paragraphs anywhere are ignored. Every title (the plan's, each group's, each
   step's) is plain text: `[text](url)` becomes `text`, `**bold**`, `__bold__`, `*italic*`,
   `_italic_` and `~~strike~~` lose their markers, and an inline code span loses its backticks and
   keeps its text; a lone `*` or an underscore inside a word is text. IDs are not touched.
2. Meta sections are about the work, not steps of it, and are left out of every shape: a section
   (to the next heading of its level or higher, everything under it included) whose heading text,
   lower-cased with leading numbering and punctuation stripped (`3. Critical files:` is `critical
   files`), is exactly one of: context, background, summary, overview, goal, goals, files, critical
   files, key files, risks, risk, out of scope, non-goals, notes, open questions, questions,
   alternatives, assumptions, dependencies, verification, testing, test plan, acceptance, acceptance
   criteria, done when, rollback, references. The title heading is never one. A `## Tests` section is
   work and stays.
3. Steps come from the first of four shapes, in this order, that finds at least one step in the body
   outside the meta sections; when none does, the same order runs over the whole body, meta sections
   included:
   - checklist items (`- [ ]`, `- [x]`), by the 4.2 rule; sub-items are the parent's bar;
   - numbered items `^(\s*)\d+[.)]\s+(.+)$`: the smallest indent among them is the top level and
     each top-level item is a step; every numbered or bulleted line indented deeper, up to the next
     top-level item or heading, is a child counted in that step's bar (`4.` with five sub-steps is
     one step with a 0/5 bar). Numbering may continue across headings; the heading above a step is
     its group (`Phase 2: CLI` gives the group `Phase 2`);
   - headings of bullets: each `##`–`####` heading that is followed, before the next heading, by at
     least one `-`/`*` bullet is one step, with its bullets as its children; a heading followed only
     by prose is not a step of this shape;
   - headings with an ID: each `##`–`####` heading whose text has a real ID under the 4.2 token rule
     (`A3 Ship`, the two-word `Step 2`, `Task 3`, `Phase 1`) or a leading number (`2. Wire it`,
     `2) Wire it`, ID `2`) is one step though it holds only prose; its prose is not children.
4. Step IDs: a numbered step's ID is its number as written (`3`); when any number repeats (numbering
   restarting under each phase heading), every numbered step's ID is `<group ordinal>.<number>`
   instead (`2.1` for the first step under the second group, groups counted in order of first use,
   steps under no heading in the first), and its title stays the item text; numbered headings
   (`### 1. Write`) follow the same rule when their numbers repeat, with the ordinal counted over the
   groups that hold numbered headings only, so a `## Phase 1` heading that is a step of its own
   (`Phase 1` is an ID) does not shift it: `### 1. Write` under `## Phase 2` is `2.1`; the `state` block and
   the Plan tab show that ID, so `report` updates use it. A checklist step's ID follows
   the 4.2 token rule, else its bare ordinal (`2`, where a pinned file's checklist item would be
   `#2`); a heading step's ID is the heading text's token when it has
   one, else the heading text; a heading with an ID takes that ID. Titles are the item text, the
   heading text after its ID (the heading text when nothing follows it), or the first line of a
   multi-line item. Every step is open at approval.
5. Progress: `report` `updates`/`done` by step ID; an agent matched to a step (5.3) makes it active
   while the agent runs. Nothing else flips a plan-mode step.

**Handoff.** After an approval headway tells Claude the plan is tracked (6). Two calls Claude
might still make would hide the plan-mode source, so they are turned away while the approval is
*fresh*. An approval that yields at least one step is fresh for its own turn only: until the main
loop's first `turn.complete` after it, any `prompt.submit` (any origin, a slash command or a task
notification included), any `report` call with `updates` or `done` (whether or not an id is
known), or a session reload (`/clear`, `/resume`, `/branch`) or restart (a plan carried across the
dialog's "clear context", 12, is fresh again); the flag is kept in memory,
not in the session record.

- The tool's `track` of the approved plan's own file (the engine's `result.filePath`, else the call's
  `e.planFilePath`),
  the two paths compared after normalising (`.` and `..` resolved; a Windows-style `C:\...` path in
  either separator and in any case), while the plan-mode plan is the
  active source and not finished (`doneAt` unset), pins nothing and replies `already tracking this
  plan from plan mode; use report updates with ids: 1.1, 1.2, …` (the step ids in order, without
  repeats; at most 12, then `, +<n>`), with nothing statted or read. This holds fresh or not. Any
  other file, another plan file under `<configDir>/plans/` included, and the approved file once the
  plan is finished or no longer drawn, is held to the project like any path (4.2, 14), so a file
  under `<configDir>/plans` is refused unread: the plan-mode plan comes from the ExitPlanMode result,
  never from a read of its file. The user's own `/headway track` is not affected.
- A full `report` list (`tasks`) while the approval is fresh, the plan-mode plan is the active
  source and it is not finished (`doneAt` unset) is refused: `refused: a plan from plan mode is
  tracked; send updates with its ids: 1.1, 1.2, …` (the same id list). Nothing is stored. Once the
  approval is no longer fresh a full list replaces the plan as in 4.1.

**Approval note.** The guidance of 6 is composed once, at the session's first turn, and proved too
faint for a short plan (live, P8: a three-step plan approved in plan mode, neither Haiku nor Sonnet
sent a `report` update, the band stayed at 0/3). So a successful approval also adds one note to
Claude's context: the hook returns the engine's result with `context: [...(result.context ?? []),
note]` (the mechanism of the router notes, 7). The note is `headway is tracking this plan: <steps>.
As you work, call headway report with updates [{id, status: "partial"}] when you start a step and
"done" when it is finished.`, where `<steps>` is `<id> <title>` joined by ` · ` for up to six steps
(a title over 24 characters cut with an ellipsis) and `ids <id list>` for more (the ids of the
`track` reply: at most 12, then `, +<n>`); about 50 words at most. It is added only when the approval
yields at least one step, the plan-mode plan is the source drawn (no file is pinned over it) and
`guideClaude` is on. A rejection, a subagent's plan and the "clear context" choice (whose result is
the rejection text, 12) get none: the result of a call that is an error carries no note, and the
plan crossing a `/clear` is announced by the guidance and the refusals alone.

A plan that yields no step under any shape is logged (`plan: no steps found`) and the source stays
empty. The plan text is held in `$.state` and the parsed steps in the session record; the file at
`filePath` is never read, since it is overwritten by the next plan.

### 4.5 Claude's task tools (0.2)

*Verified:* the task tools are absent from a default session on current models and present only
when the engine's task tools are turned on (an environment setting). With them on, `TaskCreate`
takes `{ subject, description, activeForm }` and returns `result.task.id` (engine-assigned
`"1"`, `"2"`, ...); `TaskUpdate` takes `{ taskId, status }` per item; `TodoWrite` (the older form)
takes the full list `{ todos: [{ content, status, activeForm }] }` with no ids. Task files live at
`<configDir>/tasks/<session_id>/<id>.json` (`{ id, subject, description, activeForm, status, ... }`)
and are removed as tasks complete; `TodoWrite` writes no file. Subagents have none of these tools.

headway hooks `tool.call` for `TaskCreate`, `TaskUpdate` and `TodoWrite`, after `next(e)`, main
loop only (a call with `e.agentId` is ignored):

| Call | Effect |
| :- | :- |
| `TaskCreate` | add `{ id: result.task.id, title: subject, status: open }` |
| `TaskUpdate` | `status` → pending `open`, in_progress `partial`, completed `done`, deleted removes the item; `subject` renames |
| `TodoWrite` | replace the list from `input.todos` in order, same status map; each id is a 4-character base-36 hash of the row's content (trimmed, spacing collapsed, lower-cased), a repeat of the same content suffixed `-2`, `-3`. Rows are compared by that id, so an insert, a removal or a reorder logs no flip and marks no task boundary; only a row whose status moved does |

On a reload from `classic.SessionStart` `source: 'resume'` the list is rebuilt from
`<configDir>/tasks/<e.session_id>/*.json` when that directory has task files; an empty directory
means every task was completed, not that the source is gone, so the saved list is kept. The source
clears on a plan-mode approval (4.1) and on `/clear` (12), as do the reported list, the plan-mode
plan and their labels.

### 4.6 Workflow phases as tasks (0.2)

When no higher source has data, the source is the most recent Workflow run whose script declares
`meta.phases` (section 5.2). It is derived from the agent records on every read and stored nowhere
else. The run is one group titled by `meta.description`, else `meta.name` (else `Workflow <short run
id>`), and each phase is a task of it in script order, ID the phase name. The goal label is the
run's title (a run with none leaves the prompt's line, 4.8).

- **Membership.** An agent of that run is placed by its `phase` (the `phase:` option of its planned
  call, carried by the join, 5.2), never by the words of its description: under the task of that
  name, or, when it has no phase or one `meta.phases` does not list, directly under the run's
  group. No other agent matches anything while this source is drawn (a phase named `Read` must not
  capture an Agent-tool call that says "Read"). Another run keeps the 0.1.2 run grouping (4.7).
- **Status.** Each planned call of the phase is judged by its latest attempt (a retry surfaced in a
  stalled call's place, 5.1, is a later attempt of that call). A phase is `partial` while a call's
  latest attempt has spawned and is not terminal (a blocked one is not); once it has at least one
  call and every call's latest attempt is terminal (done, failed, lost), it is `failed` when one of
  them failed, else `done` when one of them is done, else (every one lost) `open`. A `lost` attempt
  (a restart settled it, and it may well have finished) fails nothing. `open` also covers a planned
  call that has not spawned. A planned call the run ended without spawning
  (`skipped`, 5.2) is not an agent of the phase. A phase no call names stays `open`. Each phase's
  bar is its agents finished / dispatched. A `failed` phase is drawn `✕` in the `failed` element
  (slot `err`), its group too when every phase of it is done or failed; it is not done, so the goal
  counts done phases only (a failed one counts with the open ones), and it logs no task flip (the
  agent's own `failed` entry says it). Flips are compared within one run, the run told by its
  Workflow call's `tool_use_id`, so the first spawn, which binds the run id, still logs its phase's
  `task-partial`.
- **Run end.** The run ending (5.2) changes nothing: the source stays, every phase as it stood,
  until a higher source appears (and shows again when it goes), or a newer run with phases starts and
  replaces it. A run whose script declares no phases is not this source and does not displace it.
- On a change of source, and when a new run's planned calls are written, every agent is re-matched
  (5.3).

### 4.7 Nothing pinned: grouping by origin

With no source, agents are grouped by where they came from, never under a bare `Unassigned`. A
workflow agent joins its run's group (id `wf:<runId>`, titled by `meta.description`, else
`meta.name`, else `Workflow <first 6 characters of the run id after `wf_`>`); a plain Agent-tool
agent joins the group `Agents` (id `agents`). These groups are also where an unmatched agent goes
when a source is active; they are not plan groups and never count toward the goal.

### 4.8 Goal label (0.2)

The label is, in order: the pinned file's section or file name; the reported `title`; the
plan-mode title; otherwise the first line of the user's prompt. *Verified:* `prompt.submit` gives
`e.text` and `e.origin.kind`, `"composer"` for a typed prompt; a finished background agent raises
one with `origin.kind: "task-notification"`; a pasted block arrives wrapped in
`<pasted_content id="...">...</pasted_content>` tags. The prompt label takes the newest
`prompt.submit` with `origin.kind === "composer"` whose text does not start with `/`: tags and
blank lines stripped, the first non-empty line, cut to 60 characters with `…`. That line is kept as
the newest prompt; a source takes it as its label when it starts (a full `report` list, a
plan-mode approval, a task list out of nothing, a new Workflow run with phases), and keeps it until
it starts again. A later prompt (a follow-up such as "ok continue") renames nothing. Each source's
label and the newest prompt are kept in the session record.

## 5. Agent tracking

### 5.1 Events and the record

| Event | Used for | Fields read |
| :- | :- | :- |
| `tool.call` `{ tool: 'Agent' }` | router rules at dispatch; the ID search text; after `next(e)`, the spawn's agentId or its refusal (below) | `e.description`, `e.prompt`, `e.subagent_type`, `e.model`, `e.name`, `e.tool_use_id`; after `next(e)`: `result.result.agentId`, `deny`, `isError` |
| `agent.spawn` (observed: the hook records, then `return next(e)`, and never reads what `next` answers) | create the record; for a Workflow agent, the join (5.2) | `e.tool_use_id`, `e.description`, `e.subagentType`, `e.prompt`, `e.name`, `e.parentAgentId`, `e.workflow?.{runId, agentIndex}` |
| `tool.call` `{ tool: 'Workflow' }` | parse the script; rule R2, logged, toasted and noted only after `next(e)` and only when the call was not denied; after `next(e)`: `result.result.runId` | `$.fs.read` of where `e.scriptPath` lands when it lands inside the project or the Claude Code config directory and is a regular file of at most 256 KiB (the tool prefers it to `script`, so headway reads the same text; section 14), else `e.script` when it is at most 262,144 characters (256 Ki); a longer inline script is not parsed |
| `turn.step` (async generator, `yield* next(e)`) | running status, last activity, model, effort, tokens; the spawn join (below) | `e.agentId`, `e.model`, `e.effort`, `result.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model}`; for an `agentId` no record has: `$.session.messages({ agentId })` (its first user message, read once per agent) and its `$.agent.list()` row |
| `turn.complete` | final status, answer, duration; the spawn join, as at a step | `e.agentId`, `e.reason`, `e.answer`, `e.durationMs`, `e.usage` |
| `$.agent.list()` on the 15 s timer | `failed`/`killed` the events missed; `name` | `id`, `status`, `name`, `description` |

The record is the `agents` atom's element type in `types/index.d.ts`: `id` is `agentId` when
known, else `tool_use_id`, else `wf:<runId>:<ordinal>`; `taskIds[]` and `groupId` are the match;
`role`, `model`, `requestedModel`, `effort`; `status` and its timestamps; `steps`, `tokens`,
`estUsd`; `warnings[]`; and the workflow fields `runId`, `agentIndex`, `label`, `phase`,
`runTitle`, `planned`, `skipped`, `unordered`, `provisional`.

**The spawn join.** The Claude plugin directory requires a hook on `agent.spawn` to pass the
event on unchanged with `return next(e)`, so the spawn hook records from the event alone, before
the engine starts the agent, and the record has no `agentId` (its `id` is the `tool_use_id`, or
`wf:<runId>:<agentIndex>`; its model is the alias asked for until the first step resolves it). A
step or completion whose `agentId` no record has joins a waiting spawn (one with no `agentId`, no
step, queued or stalled, not a planned call), in this order. When some waiting spawn has a prompt
head (the first 160 characters of its prompt, white space folded, kept in memory), the agent's first
user message is searched for the heads in its first 64 KiB (64 Ki characters, white space folded;
one bounded pass per head): the earliest spawn whose head it holds joins, ties told apart by the
list row; when it holds no head, only a `$.agent.list()` row can join it (the earliest spawn with
the row's `description` and `type`), and with no row nothing joins (an engine fork, which no spawn
announced, is not taken for one). Else, with a row, the earliest spawn with the row's `description`
and `type`. A workflow agent has neither (*verified* 2.1.296: `$.session.messages({ agentId })`
refuses it at its first step and the list does not name it), so with neither the agent joins a
waiting workflow spawn: one that is queued (a stalled spawn, which never started, is never a
candidate) of a run not over by the run-end rule (5.2), whose asked-for model family matches the
step's when both are known. The most recently started run is tried first (a run starts at the
earliest record it has); only when none of its spawns fits does the next most recent get a turn.
Within a run a spawn whose script effort equals the step's goes before one whose does not (the
engine may run a call at another effort than the script set, so effort never rules a spawn out),
then the lowest `agentIndex`. Parallel workflow agents of one run with the same model family are
therefore joined in `agentIndex` order. An Agent-tool spawn is never joined without a hint, however
alone it waits: the agent's steps sit on a provisional record until a hint or the Agent call's
result joins them. Each agent's transcript is read at most once for this (its opening is kept, for
at most 32 agents, in memory), so a later step or the completion of an agent that joined nothing
does not read it again.

The Agent call's result carries the `agentId` and is authoritative: it outranks a join made from
the transcript, the row or the run. The record of that `tool_use_id` takes the agent's step data
(steps, tokens, cost, status and its reason or question, model, effort, step and end times) from
wherever a join put them, a provisional record or another spawn's record. Step data it held of
another agent go back: to the record that agent's data came from when two joins crossed (a swap),
else to a provisional record of that agent, which the provisional rules below then keep, surface or
drop; a record that gives up its data and gets none back waits again under its spawn id. Nothing is
counted twice. Log entries already written stay; those of either agent take the ref and role of
the record that now holds it. An Agent call that comes back denied or as an error with no
`agentId` means the engine refused the spawn: a waiting record of that `tool_use_id` is dropped. A
Workflow agent has no such result, so a mix-up between workflow spawns stays, and a Workflow agent
the engine refused waits and is marked stalled after `startMinutes`.

A step or completion that joins no spawn is a provisional record. One that only steps and is
quiet for 2 minutes is dropped. One that finishes and that no spawn claims within 15 s is an
agent the engine raised no `agent.spawn` for (a stalled workflow agent's retry runs under a new
`agentId`): it is kept under `Unassigned` with its answer and cost; it joins a workflow record only
when exactly one workflow agent is stalled and went quiet before the retry began, in which case the
original is settled `failed`, reason `retried`.

The Agent tool has no `effort` parameter, so an Agent-tool agent's effort is known from its first
`turn.step` only. Role = the last `:`-separated segment of `subagentType`, lower-cased. Model
family = the first of `fable`, `opus`, `sonnet`, `haiku` found in the lower-cased alias or id;
`unknown` otherwise.

### 5.2 Workflow scripts

*Verified:* `agent.spawn` fires once per `agent()` call with `subagentType: "workflow-subagent"`,
`description` = the call's `label`, `tool_use_id` = the Workflow call's (shared by the run), and
`workflow: { runId, agentIndex }` (`agentIndex` from 1 in script order); `next(e)` resolves the
`agentId` every later `turn.step` and `turn.complete` carries. `$.agent.list()` returns no row for
workflow agents. Phase is on no event.

The DSL, from the Workflow tool's description: `export const meta = { name, description, phases }`;
`agent(prompt, { label?, phase?, schema?, model?, effort?, isolation?, agentType? })`;
`parallel([...])`; `pipeline(items, ...stages)`; `phase(name)`. The parser is textual, never an
evaluator: `meta.phases` is the array after `phases:`, each entry a string literal or an object
whose `title:` is one (`{ title: 'Read' }`); each `agent(` takes
its balanced argument text, the last top-level `{ ... }` is the options object, and `label:`,
`phase:`, `model:`, `effort:` are read from it. A string literal is a value; a template literal is a
pattern with `${...}` spans as `*`; anything else is `dynamic`. The parser never throws, and its time
is linear in the script: strings, templates, comments and regex literals are masked in one forward pass
with an explicit stack of what is open (a `${` nested to any depth included), the brackets are matched in one pass with a stack, each argument list is
split stepping over its nested brackets whole, and the enclosing `parallel`/`pipeline` calls and
the preceding `phase()` statement are tracked in source order (a call's `nesting` names at most its
eight outermost).

A call with no `phase:` option takes the phase of the last `phase('name')` statement before it in
the source, and only while the order is certain: every `phase(...)` call is at the top level of the
script (inside no bracket), the script defines no `function`, and the name is a string literal. A
`phase()` in a loop, a block or a function, a name that is not a literal, a method call
(`x.phase(...)`) or a script with a `function` leaves its agents without a phase; they sit under
the run's group (4.6). *Limit:* an arrow function that is called from elsewhere than where it is
written is attributed by where it is written.

Planned records (id `wf:<tool_use_id>:<ordinal>`, status queued) are written before `next(e)`; the
run id binds from `e.workflow.runId` at the first spawn and from `result.result.runId` at the
return; a denied call, a call with no run id, or a named workflow (no script) drops or plans
nothing. The join at `agent.spawn`: the planned call of the same run whose label or pattern matches
`e.description` gives `phase`, `model` and `effort` (a label pattern is a glob, `*` for any run of
characters, matched by the classic wildcard walk with no regex: time at worst label × description,
never exponential); `agentIndex` breaks ties. A call with no
static label joins by `agentIndex` alone, and only in a straight script (no loop, function, or call
nested in `parallel`/`pipeline`); otherwise it stays unjoined rather than mis-joined. The call
returns at launch, so a run's end is inferred: on the 15 s timer a run whose spawned agents are all
terminal and that saw nothing for 60 s is over, and planned calls that never spawned are `skipped`
(drawn nowhere, counted nowhere).

### 5.3 Matching an agent to a task (0.2: temporal association)

In this order, first hit wins:

1. **ID match.** Search text, in order: the agent's `name`; `description`; the first 2000
   characters of `prompt`; for a workflow agent, `label` then `phase`. Candidates are the IDs the
   active source actually has (task IDs including `#<n>` ordinals, then group IDs, never a reported
   or plan-mode list's own group named after its title or `reported`/`plan`), each matched as
   a whole word (`(?<![A-Za-z0-9-])ID(?![A-Za-z0-9-])`, metacharacters escaped, case-sensitive but for the one case below),
   longest first so `A1` never takes `A12`. A bare numeric ID (a plan-mode or reported step `3`)
   or a qualified one (`2.1`, 4.4) matches only as `Step 3`, `step 3`, `#3`, or `3:`/`3.` at the
   start of the text, never as a loose `3` or `2.1`; `step 2` does not match `step 2.1`. A heading-text ID (one with no digit, such as `Docs` or `Set up`) matches in any case in the agent's `name`, `description` and workflow `label` only; in the prompt and the phase it must match in case, as an ID with a digit must everywhere. An empty ID matches nothing; a plan-mode step whose ID cleans to nothing takes its ordinal. A task ID in several groups is resolved by a group ID in the same text, else by
   first occurrence.
2. **Temporal association.** No ID matched, the active source is reported, plan-mode or task
   tools, and exactly one task is `partial`: the agent attaches to that task. With none or several
   partial, no association.
3. **Origin grouping** (4.7): the workflow run or `Agents`.

An agent is re-matched when the source changes, never when a task's status changes. A `previous`
agent (4.1) skips all three steps while it is finished: it goes to its origin group. Its first step
after a resume clears the mark and runs the three steps again.

## 6. Guiding Claude (0.2)

headway adds one section to the system prompt through `prompt.compose`: after `await next(e)` it
appends `{ id: 'headway:guide', text, scope: 'session' }` to `result.sections`. (The engine
documents the hook as a list of sections, each `shared` or `session`; a section appended after the
engine's is `session`.) The section is left out when `guideClaude` is false, when a file is pinned
(then the file is the record and `report` is not wanted), when the session draws nowhere
(`e.surfaces` empty, or `e.traits` includes `bare` or `print`), when the render is not the main
loop's prompt (`e.traits` includes `teammate` or `analysis`; not `lean`, the short body, which the
main loop of Opus 5.5 takes: *verified* on 2.1.296, its traits are `['lean', 'skills']`), and when the request does not
offer the tool: the section goes in only when `e.tools` holds `mcp__headway__headway`. *Verified*
on 2.1.296: `e.tools` names deferred tools too (`TaskCreate` was listed while the model had to load
it through ToolSearch), so no ToolSearch rule is needed. `PromptComposeInput` has no agent id, so a
subagent's render is not told apart beyond these fields.

*Verified (B2, 2.1.296):* the section reaches Claude and is read word for word, and `guideClaude:
false` leaves it out. The hook runs on every model turn, but the prompt Claude gets is the one
composed at the session's first model turn: a file pinned afterwards does not withdraw the section
(the next compose omits it and Claude still quotes it), and a changed text for the same id is not
picked up either. So the rule above holds at that first turn: a file pinned before the first prompt
keeps the section out, a file pinned later leaves it in. With it in, Claude's `report` updates
under a pinned file are refused with `updates apply to a reported or plan-mode list`, which says
what to do. There is no way to withdraw a session section mid-session; the limitation stands.

Text, as sent (153 words; the third wording tried, see appendix A17, with the goal `title` clause
and the plan-mode handoff sentence added, A19 and A22):

> headway tracks progress beside the prompt. When a request asks for two or more things (for
> example "rename the file, then update its imports"), however few commands they take, call the
> `headway` tool once before any other work, with `action: "report"`, a goal `title` of at most 6
> words, and `tasks: [{ title }]`, one short title per thing asked (ids optional). Mark each step as
> you go, not all at the end: before you start a step call `report` with `updates: [{ id, status:
> "partial" }]`; when it is finished, `status: "done"`. After plan-mode approval headway already
> tracks the plan: don't pin its file or report a new list; send `updates` with the ids `state`
> shows. Put the step's id in the description of any subagent you dispatch for it, as `step 3: ...`.
> For a request that asks for one thing, call nothing. Do not describe this tracking in your reply.

Cost, stated honestly in the README: about 150 words of system prompt per session on the session
side of the cache boundary, and one tool call per step (two with the `partial` mark) when Claude
follows it. The section is the only text headway adds to Claude's context, besides the one-line
router notes on dispatches (section 7) and the note a plan-mode approval carries (4.4). The handoff sentence is backed by the refusals of 4.4, so a
Claude that ignores it still cannot hide the plan.

## 7. Router warnings (0.2: generic rules; role rules from a file)

Warnings inform; they never deny or rewrite. `routerWarnings: false` turns every rule off.

| Rule | Fires on | Condition | Default | Text |
| :- | :- | :- | :- | :- |
| R1 | `tool.call` Agent | `e.model` absent, `subagent_type` is not `fork`, and the type's definition names no model (below) | on | `headway: Agent "<description>" (<role>) names no model; pass model on every dispatch.` |
| R2 | `tool.call` Workflow | an `agent(` call whose options lack `model:` or `effort:` and are not dynamic | on | `headway: Workflow "<meta.name>": <n> agent() call(s) without model or effort: <labels or ordinals>. Pass both on every call.` (cut near 600 characters with `+n more`) |
| R3 | `tool.call` Agent with `e.model` or a definition `model:`; or the first `turn.step` when R1 fired | model family outside the role's `models` | off until a role file names the role | `headway: <role> "<description>" dispatched on <family>; the role table expects <set>.` |
| R4 | first `turn.step` of a known role | effort outside the role's `efforts` | off until a role file names the role | row mark and log only |

Role rules come from one optional file, `<configDir>/headway-roles.json` (the config directory is
`$.env.get('CLAUDE_CONFIG_DIR')`, else `.claude` in the home directory, `$HOME` else `$USERPROFILE`). It is read at session start and
re-read when its mtime moves (checked every fifth 2 s tick). Schema:

```json
{ "roles": {
  "scout":       { "models": ["sonnet"],         "efforts": ["high"] },
  "implementer": { "models": ["sonnet", "opus"], "efforts": ["high", "xhigh"] },
  "reviewer":    { "models": ["opus"],           "efforts": ["high"] },
  "runner":      { "models": ["sonnet"],         "efforts": ["low"] }
} }
```

R1 and typed agents. An agent type whose definition file sets `model:` in its frontmatter is routed
already, so R1 stays quiet for it. *Verified (2.1.296):* the resolved model cannot tell: at
`agent.spawn`, `next(e)` for a `general-purpose`, a user-defined `implementer` (definition model
`claude-sonnet-5-5`) and a project agent with no `model:` all resolved to `claude-sonnet-5-5` under
an opus parent whose `parentModel` was `claude-opus-5-5`, while `model: inherit` resolved to the
parent's and `model: haiku` to haiku. A no-model definition resolves to the engine's default, not
the parent's, so comparing with `parentModel` is not a test. headway therefore reads the
definition: `<type>.md` (the last `:` segment, case kept) in `.claude/agents` of the session
directory and each parent, then `<configDir>/agents`, and for a `plugin:type` name each
`<configDir>/plugins/cache/<marketplace>/<plugin>/<version>/agents`; the first file found decides,
and a `model:` of `inherit`, empty, or no line counts as no model. The frontmatter is read line by
line with string operations, no pattern over a line. A UTF-8 byte order mark before the opening
`---` is tolerated. A definition not found (a file named differently from its type, a plugin
loaded by `--plugin-dir`, a built-in type) counts as no model, so R1 fires as before.

The lookup is bounded. Every segment of the type name (and each marketplace, plugin and version
directory used) must match `[A-Za-z0-9._-]+` and be neither `.` nor contain `..`; a name that does
not (`../../etc/x`, `a/b`, a NUL) is looked up nowhere and R1 fires. The walk up from the session
directory ends at the first directory holding a `.git`, or at the home directory (`$HOME`, else `$USERPROFILE`),
whichever comes first, both inclusive, and never reads the filesystem root; a session directory
outside home with no `.git` is searched alone. A `C:\...` session directory is walked with
backslashes. A candidate is statted before it is read: only a regular file of at most 64 KiB
is read (a pipe, a device or a larger file is no definition, with one debug line; a stat that
reports no type is trusted unless its size is 0), and only where it lands, every link followed, under
the directory it was found in or under the config directory (which holds the plugin cache); a
definition linked out of both is no definition, with one debug line, so R1 fires. The answer is kept per (session directory, type)
for the session; a found file is re-read when its mtime moves or it goes, and a type with no
definition is looked up again after 60 seconds. The skins marketplace taken from an `enabledPlugins` key is
held to the same name rule before it is spliced into a store or cache path: a key that fails it is no
skins plugin.

R3 for a typed agent: when the definition sets a model and the call names none, R3 judges the
definition's model against the role file at dispatch (the same warning text, context to Claude, row
mark, log and toast as for a call's own `model`); a call's own `model` is judged instead when it has
one. R3 after the fact (the first step's resolved model) still runs only when R1 fired, since a
definition's model is judged at dispatch. R4 judges the first step's effort for every listed role,
typed or not. R2 is unchanged: a workflow `agent()` call has no observable agent type (every spawn is
`workflow-subagent`), so its `model:` is what the script says.

Precedence: `routerWarnings: false` beats everything; otherwise R1 and R2 always run; R3 and R4
run only for roles the file names, and never for a model family of `unknown` (such as `inherit`).
A file that does not parse disables R3/R4 and toasts once per session with the parse error.

Delivery, every time R1–R3 fire at dispatch, once `next(e)` has answered and only when the call was
not denied: for the user, an amber `⚠` before the agent's row in
the band, the Plan tree and the Agents tab, a log entry, and one `$.ui.toast` per dispatch; for
Claude, `const result = await next(e)` then `{ ...result, context: [...(result.context ?? []),
text] }` (*verified:* the text reaches Claude for Agent and Workflow calls). `deny` results are
returned unchanged. R3 and R4 found from a `turn.step` cannot add context: row mark and log only.
A record's `warnings[]` holds `"<rule> <text>"`; a log entry is
`{ kind: 'warn', ref: '<rule>', role?, agentId?, detail }`.

## 8. Usage and the compact hint

| Figure | Source | Shown as |
| :- | :- | :- |
| Context fill | `(await $.session.usage()).context.percent`, after each main-loop `turn.step` and `turn.complete`, and from `session.measure` | `ctx 42%`; `ok` under the threshold, `warn` from it, `err` from 90 |
| Session cost | `(await $.session.usage()).cost?.usd`, same cadence; the 15 s timer catches spend no turn announces | `$12.34`, exact, the figure of Claude Code's own session cost (`/cost` on an API-key account; on a subscription plan the usage view in settings, not `/cost`); `cost n/a` when absent |
| Per-agent tokens | summed from `turn.step` `result.usage`; `turn.complete` `e.usage` when no step was seen | in/out/cache counts in the Usage tab |
| Per-agent cost | tokens × the price table in `hooks/prices.ts` | always `est.`; an unknown family uses the `sonnet` row and is marked `est.?` |

The price table is one place: `[family regex, [input, output, cache read, cache write] USD per
million]`, with the source and date in a comment above it.

Compact hint: `compactAtPercent` arms it when context fill crosses the threshold. It reads
`compact now: task boundary` in band line 3 only after a main-loop `turn.complete` that follows a
subagent finishing or a task flipping done, with no agent running. A task flip of any source counts:
the file's on a re-read, a reported or plan-mode list's on `report`, a task list's on `TaskUpdate`
or `TodoWrite`, a phase's when its agents move it; each is logged as `task-done`, `task-partial` or
`task-reopened` with the words `done`, `partial` and `reopened` (the file's add `(plan changed)`).
A new list, plan or run is not a flip. The hint hides at the next
`agent.spawn`, Workflow call, or `turn.start` whose text names another task. The `state` action
returns `contextHint`: `compact-now`, `compact-at-next-boundary`, or `null`.

## 9. Tool and command

### 9.1 Tool

Registered at `session.start` as `headway` (full name `mcp__headway__headway`),
`isDeferred: false`. One tool with an `action` field.

| `action` | Input | Reply |
| :- | :- | :- |
| `track` | `file` (required), `section?`, `doneRule?` (`column=<name>` / `check=<name>` / `auto`), `partial?`, `groupMap?`; for a plan *file* the user asked to track (a plan-mode plan is tracked automatically) | `tracking <file> § <section>: <counts> tasks, <groups> groups`, `already tracking this plan from plan mode; ...` (4.4), `refused: outside the project; ask the user to run /headway track <file>` (4.2), or `refused: <reason>` |
| `state` | `logEntries?` (default 10) | the block below |
| `report` | `tasks?`, `title?`, `updates?`, `done?` (4.3, 4.4) | `reported <n> tasks` / `updated <n> tasks` / `refused: <reason>` |
| `focus` | `taskId` | `current task: <id>` or `unknown task: <id>` |
| `untrack` | none | `untracked` |

`state` reads `$.session.usage()` when called and writes the figures to the `usage` atom, so its
context line equals band line 3. The block (the `agents` line lists every unfinished agent, then
the 20 most recently finished, then `+n more`; the goal line names the source; under a plan-mode
plan a `steps:` line after `current:` lists every step as `<id> <title, cut at 60> (<status>)`,
joined by ` · `, since those ids are headway's own (4.4) and `report` updates must name them):

```
goal: Add a --name flag to hello.py — 2/4 done (plan)
current: 3 Write the tests — 1/2 agents finished
steps: 1 Read hello.py (done) · 2 Add the flag (done) · 3 Write the tests (open) · 4 Update the README (open)
blocked: c3e9 implementer "step 3: pytest cases" — BLOCKED: should greet() strip whitespace?
stalled: none
agents: [running] 4b7d scout "step 3: read test_hello.py" sonnet/high 2m · [done] a7f1 implementer "step 2" ... (ids are for SendMessage)
log: 12:04 ✓ 2 implementer done 4m12s est.$0.42 | 12:01 ⚠ R1 Agent "step 3: pytest cases" names no model | ...
context: 71% ($12.34) — contextHint: compact-at-next-boundary
```

### 9.2 Command

`$.command.register({ name: 'headway', argumentHint, immediate: true })`.

| Form | Does |
| :- | :- |
| `/headway` | opens the pane (or the expanded band when not placed); again closes it |
| `/headway track <path> ["Section text"] [column=<name> \| check=<name> \| auto] [partial=<column>] [groups=<path>]` | pins; prints the same line as the tool |
| `/headway plan` / `agents` / `log` / `usage` | opens the pane on that tab |
| `/headway close` | closes the pane or the expanded band |
| `/headway untrack` | unpins |
| `/headway status` | prints the `state` block |
| `/headway band off` / `band on` | hides or shows the band (store pref `band`, over `bandDefault`) |

The command returns `{ text }` for `track`, `untrack`, `status` and refusals, `{}` otherwise.

The forms that change something, `track`, `untrack` and `band off`/`band on`, run only when the
person typed them: `e.origin.kind === 'composer'`, which the engine stamps on Enter at the prompt
and never presumes. Any other run (a message a model wrote, `peer-send-message` or `peer`; a
`coordinator`, `channel` or `projects-relay` delivery; a `task-notification`; a `scheduled-trigger`;
another plugin's `$.command.run`, `plugin`; `bridge`, `sdk`; a run with no stamp, `unclassified` or
none) gets `refused: run this from the prompt` before anything is parsed, statted or written. The
forms that only read or show, `/headway` alone, the tab names, `close` and `status`, answer from
any origin.

## 10. UI

### 10.1 Band above the prompt

Hook: `on('ui.render', { component: ['AbovePrompt', 'Pane'] })`, one hook for both sites. A second
`ui.render` hook, `{ component: ['ToolUse', 'ToolResult'], props: { tool: 'mcp__headway__headway' } }`,
draws the transcript rows of headway's own tool (10.4); those two hooks are the only `ui.render`
registrations. Quiet
rule: return `next(e)` untouched when `e.props.hasSurvey` is true, when the band is off
(`bandDefault` or the store pref), or when no source has data and no agent is still at work.
Otherwise two or three lines; line 3 is dropped when `e.props.bodyColumns` is under 60. With agents
at work and no source, line 1 reads `◆ no plan` in `muted`. Every `Text` uses
`wrap: 'truncate-end'`; nothing wraps.

Composition: headway draws `<Box column>{its lines}{await next(e)}</Box>`, so another mod's band
(skins' meters) still shows. *Verified:* without a declared dependency the order between two
installed bands follows load order, and skins' meters then draw above headway's lines; under
`--plugin-dir` headway draws above. headway declares no dependency (skins must stay optional), so
with skins installed its meters may sit above headway's lines. The README says so.

Mock at 100 columns (`░` is the track, drawn as spaces on a `surface` background; the fill is `█`
with one fractional cell from `▏▎▍▌▋▊▉`):

```
 ◆ Add a --name flag to hello.py  ████████████████████░░░░░░░░░░░░░░░░░░░░  2/4 done  plan
 ▸ 3 Write the tests             ████████████████████░░░░░░░░░░░░░░░░░░░░  1/2 agents  ● 1  ⊘ 1 blocked
 ctx 42%  $12.34   ✓ 2 implementer done 4m12s est.$0.42
```

With partial data the goal bar is two-tone (`█` done in `ok`, `▓` partial in `run`, then the track)
and the count reads `<doneword> <d> · <partialword> <p> · open <o> / <total>`; for a reported or
plan-mode list the words are `done` and `partial`. Widths: 1 space; glyph and space; label 30;
2 spaces; bar 40; 2 spaces; the rest. When the count does not fit, the bar shrinks first (minimum
12), then the label (minimum 12). Line 2 reads `no current task` in `muted` when nothing is
dispatched; with no plan task at work it shows the run or `Agents` group with its own agents bar.
The single partial task of a reported, plan-mode or task-tool source that no agent works reads
`◐ in progress` in `run` in place of an agents count. When every task of the active source is done and
no agent is at work, line 2 reads `✓ all done` (ascii `+ all done`) in `ok` and no task is current,
whether or not an agent finished a moment ago or the `focus` action named a task. A current task that is done
(or a group whose tasks are all done) draws its bar in `ok`, never in `run`. On the Plan tab a group
that counts agents (not the plan's own group) draws its bar in `ok` once its status is done; the plan's
own group bar is `ok` for done tasks and `run` for partial ones already. Line 3's last slot shows the newest log entry or the compact hint.

Expanded band: when `$.ui.panes()` reports the pane `isPlaced: false` (*verified:* only an unasked
open below 110 columns, or 144 for an id never opened; a command-opened pane is placed at every
width), the band draws the pane body under the three lines, at most `e.props.maxRows - 1` rows,
with tab buttons on letter hotkeys `p a l u` and `x` to close (letters: a digit hotkey also fires
when the user types that digit alone into an empty prompt). The buttons act while the band has
focus (Ctrl+X then Tab).

### 10.2 Pane

`$.ui.open({ id: 'headway', title: 'Headway', focus: true, rows: 18, columns: 72 })`. No
`closeOnEscape`: Esc returns focus to the prompt and the pane stays. Hotkeys with the pane
focused: `1`–`4` tabs; `e` expand all / collapse all; `h` hide done tasks; `r` re-read the plan;
`q` close; Enter on a row with a chevron opens or closes it. `ui.close` for this id clears the open
flag.

Plan tab:

```
 1 Plan   2 Agents   3 Log   4 Usage                                   e expand  h hide done
 ◆ Add a --name flag to hello.py  ██████░░░░░░░░░░  2/4 done   plan
 ▾ 3  Write the tests                                      ▊▊░░  1/2 agents   ⊘ 1 blocked
       ⊘ c3e9  implementer  opus/high    blocked  06:12   BLOCKED: should greet() strip…
       ● 4b7d  scout        sonnet/high  running  01:40   step 20s ago   est.$0.11
 ○ 4  Verify the CLI by hand
 ✓ 2  Wire the flag with argparse
 ✓ 1  Add greet(name)
 ▸ Agents                                                  ▊▊▊▊  2/2 agents
```

A plan-mode step that is done shows its children complete (`5/5 items`), not the count it was
approved with; an open or partial step shows its children as parsed.

Groups and tasks sort active first, then partial, then open, then done; done tasks sort last and
hide under `h`. A group with an agent that finished in the last 30 minutes sorts right after the
active groups and opens by default. The groups of a reported, plan-mode or task-tool source are the
plan itself: they start expanded, their bar is the group's task progress (done tasks in the done
colour, partial or active ones in the `run` colour, the track after) and their count reads `d/t tasks`,
whatever agents work them; any other group's bar and count are its agents' (finished / dispatched), or
its tasks' when it has no agent. Tasks show `✓` done, `●` active, `◐` partial, `○` open. The run
and `Agents` groups are drawn among the plan's groups by the same order, titled with no id; the
`N groups` footer counts plan groups only.

Agents tab (running, blocked, stalled first; then queued; then finished newest first): columns
`st id task role model/effort elapsed last-activity est.cost`, a workflow agent's call label in
the role column, `id` the first four characters of `agentId`, a blocked row ending with the first
60 characters after `BLOCKED`. Log tab: `HH:MM glyph ref text`, newest first. Usage tab: the
context bar, the session figure followed by `exact`, the agents' estimate with the price table's date
(`no agents` when none was dispatched), then a row per agent.

### 10.3 Redraw

Writes to `$.state` atoms redraw the sites that read them; the poll writes only on change. Every
read within one dispatch answers the dispatch's first moment, so agent reducers run inside
`update` (read-apply-write, retried on a version miss) rather than after a probing read; an
unchanged reducer writes nothing and logs nothing. A main-loop `turn.step`'s usage write is
skipped when percent and cost are unchanged.

### 10.4 Transcript rows for headway's own tool

A `ui.render` hook of its own serves `ToolUse` and `ToolResult`, registered with a props matcher,
`{ component: ['ToolUse', 'ToolResult'], props: { tool: 'mcp__headway__headway' } }` (*verified*
2.1.296, A21: the engine runs it for that tool's rows only, so no other tool's row reaches headway). It
is registered whatever `quietToolRows` says (every registration is unconditional, so static analysis
reads it) and with `quietToolRows: false` returns `next(e)`. Otherwise it does not call `next`:
`ToolUse` returns one line (`hooks/quiet.tsx`, from `input` and the stored `output`, which is the
reply text), `ToolResult` returns an empty `Box`. Any other tool, or `quietToolRows: false`, keeps
its stock row. The line is built from the call, so it draws while the call runs, and the reply is folded
in:

| Call | Line |
| :- | :- |
| `report` with `tasks` | `◆ headway · 3 steps: <title> · <title> · <title>` (each title cut at 48 cells; the line truncates at the end) |
| `report` with `updates`/`done` | `<glyph> step <id>` per entry joined by `·`: `✓ step 1 · ◐ step 2`; the glyph is `✓` done, `◐` partial, `○` open |
| `track` | `◆ tracking <file> § <section>` |
| `state` / `focus` / `untrack` | `◆ headway state` / `▸ focus <taskId>` / `◆ untracked` |
| reply `refused: ...` or `isErrored` | `✕ headway · <reply text>` in the `failed` colour (the whole line) |
| reply `unknown task: <id>` (focus) | `⚠ headway · unknown task: <id>` in `warning` |
| reply `...; unknown task: <ids>` (updates) | the normal line, then `  ⚠ unknown task: <ids>` in `warning` |

Text is `counts` (muted); status glyphs use `doneGlyph`, `partial`, `queued`. Glyphs and separator
come from the `GLYPHS` table, so ascii mode gives `* headway - 3 steps: ...` and `+ step 1 - / step 2`.

*Verified (2.1.296):* chaining with the skins mod. skins registers its own `ui.render` hooks for
`ToolUse` and `ToolResult` that draw every `mcp__*` tool as its own row (`headway:headway  report`)
without calling `next`, so whichever mod's hook is outermost wins. With `--plugin-dir <headway>
--plugin-dir <skins>` (headway first) and with skins installed and headway under `--plugin-dir`,
headway's line drew and skins drew every other tool; with `--plugin-dir <skins> --plugin-dir
<headway>` skins drew headway's calls and no quiet line appeared. Two marketplace installs load in
skins-first order (Appendix A7), so there headway loses; the README says so. Skins disabled:
headway's line draws and no other row changes.

### 10.5 Text a model wrote

One sanitiser, `clean` in `hooks/format.ts`: it removes terminal escape sequences whole (OSC, which
carries links and title changes; DCS, SOS, PM and APC strings; CSI; any other ESC pair; the 8-bit
introducers), then every other C0 and C1 control character, DEL and format character (the bidi
embeddings, overrides and isolates, the tag characters, the zero-width space and the byte order
mark; the joiner and non-joiner, the direction marks and the variation selectors stay, so emoji
sequences and Persian and Indic words are intact), turns tabs, line breaks and line and paragraph separators into a space, collapses each
run of whitespace to one space and trims; an optional cap cuts to that many characters with an
ellipsis. `stripControls` is the same without the collapsing, for text that is padded into columns.

It is applied where model-written text comes in: the `report` list (ids, titles, the goal title),
the file and section a `track` echoes, the prompt label, a router warning's description, the `state`
block's agent, goal and log text, the plan-mode plan as it is parsed (its title, every step id and
title and every heading, at most 200 steps) and the task tools as each call is applied (every title;
a `TodoWrite` keeps its first 200 rows, a `TaskCreate` on a list of 200 is dropped, a resume reads at
most 200 task files); then again the plan that is drawn (`boundPlan` in `hooks/planbuild.ts`: at most
200 tasks, each id and title and heading clean and cut at 200 characters) and the saved record (12). And again,
as defence in depth, where rows are made: every pane and log segment, every band segment and every
quiet transcript segment goes through `stripControls`, so a description, a log detail or a reply
reaches the terminal as plain text.

## 11. Theming (0.2: skins optional)

`theme` (section 13) picks the source of colours:

| `theme` | Behaviour |
| :- | :- |
| `auto` (default) | skins' palette when the skins plugin is installed **and** enabled; otherwise plain |
| `skins` | skins' palette whenever its files are readable, enabled or not |
| `plain` | Claude Code's theme colours and ANSI names only |

Installed and enabled: `$.settings.read()` returns the merged settings; its `enabledPlugins` record
has a key `skins@<marketplace>` whose value is `true` when enabled and `false` when disabled; no
such key means not installed. The marketplace name comes from that key, never hard-coded.
*Verified:* a disabled skins keeps its files on disk, so `skins` mode still colours from them.

Reading the skin (same as 0.1.2, paths built from `<configDir>` and the marketplace): the store file
is the entry of `$.fs.list(<configDir>/plugins/store)` matching `skins_<marketplace>-<hex>.json`;
fields `prefs.skin`, `prefs.icons` (`unicode`|`ascii`), `custom`, `folders` (the entry keyed by
`$.session.cwd()` overrides `prefs`). The palette is the file
`<configDir>/plugins/cache/<marketplace>/skins/<highest version>/hooks/themes/<skin>.ts`, read with a
scan per `palette:` and `light:` block (a `key: {` at the start of a line, to the first `}`) and a
pattern per slot line, never evaluated. A missing store means skins' defaults
(`noir`, `unicode`); `prefs.skin === 'off'` or an unreadable theme file means plain, with one toast
per session naming the reason. The store and theme files are stat-polled every fifth 2 s tick so
`/skin <name>` recolours headway live.

Light or dark: `SKINS_THEME` env (`light`/`dark`); else the `theme` row of `$.config.list()` (a
name containing `light` is light, `dark` is dark); else `COLORFGBG` (a last field of 7 or 15 is
light); else dark. 0.1.2 also ran `defaults read -g AppleInterfaceStyle` on macOS for the `auto`
case; 0.2 drops it so that headway runs no subprocess. Cost of that choice: with Claude Code's
theme on `auto`, no `COLORFGBG`, and skins enabled on a light macOS appearance, skins' meters draw
light while headway's lines draw dark; the fix is an explicit Claude Code theme or
`SKINS_THEME=light`, and the README says so. Light palette: the skin's `light` block when present,
else skins' derivation (`fg #1f1f1f`, `muted #6b6b6b`, `surface #ffffff`, `zebra #f2f2f2`, kinds
scaled toward black).

Slot mapping: goal glyph, label and active tab `user` (bold); goal fill, `✓`, done `ok`; current
`▸`, task fill, `●`, `◐`, partial cells `run`; track `surface` background; `○`, timestamps,
model/effort, counts, inactive tabs, source tag `muted`; `✕`, `◌`, context from 90 `err`; `⊘`,
`⚠`, context from the threshold, compact hint `warn` (bold); titles, ids `fg`; alternate table
rows `zebra`. Plain fallback, named ANSI colours that the terminal's own palette keeps readable on
light and dark backgrounds (never white or black): `fg` and `other` the terminal's default
foreground, `muted` dim, `surface` gray (a background only), `ok` green, `err` red, `warn` yellow,
`run` yellow, `user` yellow, `read`/`mcp` cyan, `write` magenta, `search`/`web` blue.

Glyphs (unicode / ascii): goal `◆`/`*`; current `▸`/`>`; expanded/collapsed `▾ ▸`/`v >`; running
`●`/`o`; open `○`/`.`; partial `◐`/`/`; done `✓`/`+`; failed `✕`/`x`; blocked `⊘`/`!`; stalled
`◌`/`?`; lost `◇`/`~`; warning `⚠`/`W`; fill `█`/`#`; partial cells `▓`/`=`; separator `·`/`-`.
No emoji; every glyph is one cell.

## 12. Persistence

| Layer | Holds | Lives |
| :- | :- | :- |
| `$.state` atoms (`filter`, `report`, `plan` (0.2), `tasks` (0.2), `label` (0.2), `prompt` (0.2), `focus`, `goal`, `theme`, `agents`, `log`, `ui`, `usage`) | everything drawn | the session; survives `/compact` and a module reload |
| `$.store` key `session:<id>` | `{ filter, report, plan, tasks, label, prompt, agents, log, savedAt }` | across `/resume`, `/branch` and a restart; across `/clear`, only `filter` and `agents` (and a plan the dialog's "clear context" approved, below) |
| `$.store` key `band` | the `/headway band` pref | the config directory |

Saves are debounced to one write per second, keyed by `await $.session.id()`, and skipped when the
record equals the last one written (compared without `savedAt`). A record is capped at 300 agents
(every unfinished one, then the most recently moved finished ones), 500 log entries, 200 items in each
of the report, the plan-mode steps and the task-tool list (titles 200 characters), and 3 MiB,
shedding the oldest finished agents, then the oldest log entries, then the tail of the longest of
the report, plan and task lists until it fits.

*Verified:* `/compact` keeps the session id and `$.state`; `/clear` mints a new id and resets
`$.state`; an in-session `/resume` resets `$.state` and, inside its `classic.SessionStart` hook,
`$.session.id()` still returns the previous id. So the reload runs in
`on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] })` from `session:<e.session_id>`
only. When that key is absent, `clear` and `fork` copy the record of the session being left under
the new id; a resume with no record starts empty. A `/clear` starts a new conversation: it carries
the pinned filter and the agents (a running one stays under its step), never the log or the
prompt-driven sources (`report`, `plan`, `tasks`, `label`, `prompt`), which are emptied; a resume
keeps the log. One exception, the plan dialog's "Yes, clear context"
(*verified*, A23): that choice resolves `ExitPlanMode` with `isError: true` and the rejection text,
then clears in the same turn. So the plan of a main-loop `ExitPlanMode` (from `e.plan`, approved or
not) is held, with the newest prompt line as its label, until that turn's main-loop `turn.complete`
or the next `prompt.submit`; a `clear` that arrives while it is held and within 10 s of the call
starts the new conversation with that plan as the plan-mode source, labelled, logged as approved
when the call was not, and fresh (4.4) through the new conversation's first turn (the old turn's
`turn.complete`, which arrives after the clear, does not end it). A rejected plan whose turn
completes is never held past it. Agents whose last sign of life predates this
process's start are settled `lost`. `session.start` prunes records older than 14 days.

## 13. Settings (`userConfig` in `plugin.json`)

The three number entries match the manifest schema (`type`, `title`, `description`, `default`, `min`,
`max`). *Verified* on 2.1.296: `/plugin configure` shows a boolean's or string's default beside its
label and shows nothing beside a number, also for a control plugin whose only number is `{ type:
"number", default: 10 }`. It is Claude Code's display; the default still applies when nothing is set.

| Key | Type | Default | Meaning |
| :- | :- | :- | :- |
| `stallMinutes` | number ≥ 1 | 10 | minutes without a step before a running agent is stalled |
| `startMinutes` | number ≥ 1 | 2 | minutes a spawned agent may wait for its first step |
| `compactAtPercent` | number 1–100 | 70 | context fill that arms the compact hint |
| `guideClaude` | boolean | true | add the guidance section (section 6) to the system prompt, read at the session's first model turn, and the note of a plan-mode approval (4.4) |
| `routerWarnings` | boolean | true | run the router rules (section 7) |
| `theme` | `auto` \| `skins` \| `plain` | `auto` | colour source (section 11) |
| `quietToolRows` | boolean | true | draw headway's own tool calls as one dim transcript line each (section 10.4) |
| `bandDefault` | `on` \| `off` | `on` | whether the band shows before `/headway band` has been run |

Values arrive in `register(on, options)`.

## 14. Trust

What headway does with your machine, in full:

- **Network:** none. No fetch, no telemetry, no update check.
- **Reads:** the plan file and group map you pin (any path), or that Claude pins through the tool's
  `track` action (only inside the project: the path must land, every link followed, under the real
  path of the session directory, with no exception; a file under `<configDir>/plans` is never read
  for Claude, 4.4), since what headway reads flows back to Claude through `state`, outside Claude
  Code's permissions; such a pin keeps its bound, and every read of it, at the pin and on each poll,
  stats the path with links followed, checks the real path against the bound and reads that real
  path, so a link swapped after the check is not followed (4.2); `<configDir>/headway-roles.json`
  if you create it; the Workflow script file by path (`scriptPath`, which the tool prefers to an
  inline `script`, so headway reads the text that runs), only when it lands inside the project or
  the config directory, and then the real path checked is what is read, else the inline `script` is
  parsed and no file is read;
  agent definition files by type name, for R1 and R3 (`.claude/agents` from the session directory
  up to the first `.git` or your home directory and never the filesystem root, `<configDir>/agents`,
  plugin `agents` directories; a type name is used only when it is letters, digits, `.`, `-` and
  `_`, with `plugin:type` allowed, so a path or `..` is read nowhere; a definition is read only where
  it lands under the directory it was found in or under the config directory, and the real path
  checked is what is read); skins' store and theme files
  when `theme` resolves to skins; Claude Code's task files for this session under
  `<configDir>/tasks/<session_id>/`; the plan-mode plan text the engine hands it; the merged
  settings through `$.settings.read()` (to see whether skins is enabled); `$.session.usage()`,
  `$.agent.list()`, `$.config.list()` and the `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`, `SKINS_THEME` and
  `COLORFGBG` variables.
- **Sizes:** a read is made only of a regular file, never a pipe or a device, and only up to a cap
  checked on the stat before the read: the plan file 2 MiB, a group map 256 KiB, a Workflow script
  file 256 KiB, an agent definition 64 KiB, the role file 64 KiB, skins' store 256 KiB, a skins theme
  file 64 KiB, each Claude Code task file 64 KiB (at most 500 task files are read per session); a
  larger plan file or group map is refused (`file too large`), any other larger file is skipped with
  one debug line saying why. An inline Workflow `script` over 262,144 characters is not parsed.
  Every parse is linear in its input: a plan line is read to its first 8 KiB, an agent's answer to
  its first 4 KiB for a BLOCKED line, and no pattern backtracks over a run of spaces (4.2, 5.2, 7).
  A pattern over text a model, a file or the user supplies is linear on an 8 KiB line (64 KiB for a
  theme file): plan titles, numbered items, theme blocks, pasted-content tags and path separators are
  scanned by hand, and a test times each on its worst line.
- **Residual race:** each bounded read is stat, check, then a read of the real path the stat
  answered. That path is fully resolved, but a directory on it can still be swapped for a link
  between the stat and the read, and the read would follow it; doing so needs write access to a
  directory inside the project, the config directory or a definition directory, which is already
  local write access to what Claude may read.
- **Writes:** its own `$.store` (one record per session, one pref) and `$.state`. The session record
  holds the plan sources, the agents, the log and the first line of your composer prompts (cut at 60
  characters; it is the goal label when the source has no title of its own, 4.8), and is pruned
  after 14 days. Never a file of yours; never the plan.
- **Subprocesses:** none (section 11).
- **What Claude sees:** the guidance section (section 6) when `guideClaude` is on and no file is
  pinned at the session's first turn; the note of a plan-mode approval (4.4) when `guideClaude` is on;
  a one-line note after a dispatch that trips a router rule; the replies of the `headway`
  tool when Claude calls it. Nothing else.
- **What Claude can do through the tool:** pin a file for headway to read (`track`) inside the
  project, give a task list, move statuses, set the focus, unpin. Claude can pin a file only inside
  the project; you can pin any file with `/headway track`. A `/headway track`, `untrack` or
  `band on|off` that you did not type at the prompt (one in a message a model wrote, a relay, a
  notification, another plugin's run, a scheduled prompt) is refused (9.2); `status` and the pane
  answer from anywhere. Nothing it sends is written to a file.
- **Text that becomes a pattern:** no text from you, Claude or a file becomes a regex of its own.
  Plan IDs are matched literally, as escaped text, in the first 2000 characters of a prompt; a Workflow
  label pattern is a glob matched without a regex (5.2). No text a model or a file
  supplies reaches a terminal unsanitised: router warnings clean every value they quote (the role,
  the model family, the effort, the description, the role file's names).
- **What it never does:** deny or rewrite a tool call; retry or schedule an agent. Before an Agent
  or Workflow call goes on, headway's hook may read one capped file (an agent definition of at most
  64 KiB, a Workflow script of at most 256 KiB); it then passes the call on unchanged, and a fault in
  the hook lets the call through. A router warning (R1 to R3 on an Agent call, R2 on a Workflow call)
  is logged, toasted and added to context only after the call has gone on and only when it was not
  denied. The other `tool.call` hooks act after the call has run.

## 15. Code layout and engine constraints

```
hooks/register.tsx   every on(...) and every $.* call; helpers taking $ are top-level here
hooks/plan.ts        file shapes, sections, IDs, done and partial rules, group map (pure)
hooks/planmode.ts    the plan-mode parser (pure)                                    (0.2)
hooks/sources.ts     source precedence, reported and task-tool reducers, goal label (0.2, pure)
hooks/planbuild.ts   the one constructor of an in-memory source's plan, and the bound a drawn plan is held to (pure)
hooks/phases.ts      the phases source: the run and its plan, derived from the agent records (0.2, pure)
hooks/agents.ts      record shape, transitions, matching, stall rule (pure)
hooks/workflow.ts    script parser (pure)
hooks/router.ts      rules R1–R4; role file parsing (pure)
hooks/prices.ts      the price table and costOf (pure)
hooks/usage.ts       compact-hint rules, line 3 data (pure)
hooks/theme.ts       store and theme-file parsing, slots, glyphs, light derivation (pure)
hooks/format.ts      bars, durations, money, truncation, the text sanitiser, size caps (pure)
hooks/display.ts     rows and cells shared by pane, band and `state` (pure)
hooks/band.tsx  hooks/pane.tsx  trees from plain data (pure)
hooks/quiet.tsx      the transcript line of headway's own tool, from plain data (pure)
hooks/pin.ts  hooks/tool.ts  hooks/persist.ts   filter parsing, tool spec and state block, store record (pure)
```

Engine rules the code must obey:

- **One hook per event and matcher.** The static analyser reads each `on('<literal>', matcher)`; a
  second registration for the same event and matcher in one module is refused. `ui.render` has one
  hook for the band and the pane (`component: ['AbovePrompt', 'Pane']`) and one for the transcript rows
  of headway's own tool (`component: ['ToolUse', 'ToolResult']`, `props: { tool }`); `tool.call` for
  Agent, Workflow, `ExitPlanMode`, the task tools and the headway tool are distinct `{ tool }`
  matchers on the same event.
- **`$` stays in `register.tsx`.** `$` may be passed only to top-level functions in the same file,
  never to imported ones; the pure modules take plain data. No `require`, no dynamic `import()`,
  relative imports only. `claude plugin validate <dir> --strict` must pass at every milestone.
- **Failure containment.** Every hook body and timer callback catches its own faults and writes
  them to the debug log (`$.ui.log(..., { to: 'debug' })`), never rejecting; work after
  `await next(e)` is caught separately, because an error handler above would run the event again.
  Router hooks fail open (`.catch(($, e, next) => next(e))`): a warning never gates a dispatch.
  `session.start` registers the tool and the command first, then starts timers, store and band,
  each guarded on its own.
- **No evaluation.** Workflow scripts and theme files are read textually.

## 16. Tests and fixtures (0.2: synthetic only)

Tests run with `claude plugin test`. Every fixture is synthetic text written for the test; no
fixture may be copied from a private project, and expected counts are computed from the fixture at
test time by an independent counter (`tests/count.ts`), never written into the test by hand.
Required fixtures:

| Fixture | Shape | Must contain |
| :- | :- | :- |
| `roadmap.md` | checklist | `## Milestone` headings; `- [ ] A1 ...` items; a sub-checklist two deep; an item with no ID (`#<n>`); a fenced block holding a `- [ ]` line that must not count; a `## Phase A ##` closing-hash heading |
| `release.md` | check table | a `[ ]`/`[x]` column `auto` must find; a bare `---` thematic break above it |
| `backlog.md` + `groups.json` | column/partial table | `column=shipped partial=announced`; `-`, `–`, `—` and `[ ]` placeholders; a `\|` in a cell; a group map with one unmapped row and one task in two groups |
| `plan-bullets.md` | plan-mode | `# Plan: ...`, `## Context`, four `##` sections of flat bullets, trailing prose |
| `plan-phases.md` | plan-mode | `## Phase 1..4` headings; numbered steps 1–12 continuing across them |
| `plan-nested.md` | plan-mode | `## Checklist`; top-level `1.`–`4.` with three-space-indented numbered sub-steps |
| task-tool sequences | event scripts | `TaskCreate` → `TaskUpdate` (in_progress, completed, deleted); a `TodoWrite` full list replaced twice; a resume directory with two `.json` files and one with none |
| `report` sequences | tool inputs | a list without ids; a list with ids; `updates` with one unknown id; `done`; `tasks` and `updates` together (refused) |
| `flow.ts` | workflow script | `meta.phases: ['Build', 'Verify']`; three labelled `agent()` calls, one with a template label, one without `model`/`effort`, one inside `parallel` |
| agent event scripts | events | spawn/step/complete sequences for every transition in section 3, both stall paths, a BLOCKED answer, a SendMessage resume, a provisional record |

Each test asserts a positive outcome the fixture caused; none passes on the absence of a mark.

## Appendix A. Verified on 2.1.296

Facts above marked *verified* were checked on 2026-10-10 against Claude Code 2.1.296 with
throwaway probe mods under `--plugin-dir`, in tmux, subagents on `haiku`. The raw evidence is not
in this repository.

| # | Fact | How |
| :- | :- | :- |
| A1 | `agent.spawn` fires per workflow `agent()` call with `subagentType: "workflow-subagent"`, `description` = label, shared `tool_use_id`, `workflow: { runId, agentIndex }`; `next(e)` resolves `{ model, agentId }` | a Workflow with two labelled calls, every field logged |
| A2 | `turn.step` / `turn.complete` carry that `agentId`, `model`, `effort`, `usage`; phase is on no event; `$.agent.list()` lists no workflow agents | same run |
| A3 | `tool.call` `context` reaches Claude for Agent and Workflow calls | a marker string appended; Claude quoted it on the next prompt |
| A4 | hex colours draw in `Text color` in band and pane | `#ff8f40` captured as a 256-colour escape |
| A5 | `$.fs.read` of a 1.2 MB plan file; `$.fs.list`/`read` of the plugins store directory | direct calls |
| A6 | `$.plugin.root` of a marketplace install is the install location; `CLAUDE_CONFIG_DIR` is set when the CLI was started with it, else unset with `HOME` set | logged on two config dirs |
| A7 | band composition: both bands show; installed without `dependencies` skins' meters sit above headway's; `maxRows` 16 in fullscreen at 45 rows, terminal rows in classic; `bodyColumns` = columns − 5 | captures at 60, 80, 140 columns |
| A8 | two sessions writing `session:<id>` every second for a minute do not clobber each other | a third session read both keys |
| A9 | `/compact` keeps id and `$.state`; `/clear` new id, state reset; in-session `/resume` resets state and `$.session.id()` lags inside `classic.SessionStart` | logged around each command |
| A10 | a command-opened pane is placed at every width; `isPlaced: false` only from an unasked open below 110 columns (144 for a new id) | opens from a command and from a timer |
| A11 | `claude plugin install -s <user\|project\|local>`; install writes `enabledPlugins` and `extraKnownMarketplaces` | `--help` and settings.json diff |
| A12 | task tools absent by default on current models; present under the engine's opt-in; payload shapes of 4.5; task files under `<configDir>/tasks/<session_id>/` survive `claude --resume`; `TodoWrite` writes no file; subagents have no task tools | sessions with and without the opt-in, files listed at resume |
| A13 | `ExitPlanMode` `tool.call` carries `e.plan` and `e.planFilePath`; approval `result: { plan, isAgent, filePath }`; rejection `isError: true`; the plan file is overwritten per approval | plan mode approved, rejected, re-entered |
| A14 | `prompt.submit` `e.text` and `e.origin.kind` (`composer`, `task-notification`); paste wrapped in `<pasted_content>`; slash commands run as `/name args` text or not at all | typed, pasted, slash and notification prompts |
| A15 | without `dependencies` headway loads with skins disabled and keeps the skin palette from skins' files on disk | `enabledPlugins` `skins@...: false` |
| A16 | the three plan-mode shapes of 4.4 | three real plans written by Claude in plan mode |
| A17 | B2: a `prompt.compose` section appended as `session` is read by Claude word for word and changes what it does, with a wording that defines a step by what is asked, not by tool calls. The spec's first wording ("When a request takes several steps ... For a request that is one step, call nothing") failed: asked to create three files and list them, Claude made one command and did not call `report`, saying it took one command and the text says call nothing for one step. The second wording (first revision: a step is a thing asked, "however few commands they take") made Claude call `report` in 4 of 4 runs but send a `partial` mark in 1 of 4 (it batched one `done` update). The third wording (6, adds "Mark each step as you go ... before you start a step") gave `report`, `partial`, `partial`/`done`, `done` in 3 of 3 runs, band line 1 `done 0 · partial 1 · open 1 / 2` then `2/2 done`, line 2 the partial step; `what is 2+2?` called nothing (also under the second wording); `guideClaude: false` called nothing. The prompt is composed once, at the first model turn (6) | live sessions in tmux, `--plugin-dir`, the debug log showing `prompt.compose` per turn, and Claude asked to quote its system prompt |
| A18 | a `--plugin-dir` plugin is `headway@inline`; its options come from `pluginConfigs["headway@inline"].options` in `--settings` | the debug log line naming the key; `guideClaude: false` read as off |
| A19 | Claude passes a goal `title` of six words or fewer with the report list under the wording that adds "a goal `title` of at most 6 words" (2 of 2 live runs: "Create and read back two files", "Write haiku files and list folder"); the quiet rows draw live; the chaining result of 10.4 | two tmux sessions on haiku, then the same prompt with skins loaded in each order |
| A20 | R1 and typed agents: `agent.spawn` `next(e)` resolves a no-model definition to `claude-sonnet-5-5`, not the parent's (`claude-opus-5-5`); `model: inherit` to the parent's; so the resolved model cannot say whether a definition set one. Live with the definition read (section 7): `general-purpose` and a project agent with no `model:` fired R1; the user's `implementer` (model in its frontmatter) and a project agent with `model: haiku` did not | a probe mod logging `agent.spawn` before and after `next`, then the build, `/headway status` log |
| A21 | batch B, live (2.1.296, haiku, scratch directory): a `ui.render` hook with `props: { tool }` runs for that tool's rows only (headway's quiet lines drew, Write and Agent rows stayed stock); a reported list of 3 done steps draws its Plan tab group expanded with a full `████` bar in the done colour and `3/3 tasks`; the Usage tab reads `<$0.01 exact` and `no agents`; an Agent call with `subagent_type: "../../etc/x"` fired R1 although files defining `model: haiku` stood at both paths the traversal would reach (`<cwd>/etc/x.md`, `/tmp/etc/x.md`), while a project agent `okagent` with `model: haiku` fired none | tmux session on `--plugin-dir`, the Plan, Usage and Log tabs captured, canary files removed after |
| A22 | the plan-mode handoff (4.4, 6), live on 2.1.296 with Opus 5.5 (account default model), `--permission-mode plan`, a scratch directory, the guidance with the handoff sentence: run 1, a four-step plan, approved with auto mode: Claude sent only `report` `updates` with ids `1`-`4` (partial then done per step), no `track`, no second list, and the band read `4/4 done  plan`; run 2, a plan in two phases with numbering restarting (ids `1.1`, `1.2`, `2.1`, `2.2`): Claude called `state` first, then sent `updates` with `1.1` to `2.2`, again no `track` and no list, `4/4 done  plan`. The refusals of 4.4 did not fire in either run (the tests cover them) | two tmux sessions on `--plugin-dir`, the session transcripts read for every `headway` call and its reply, then deleted |
| A23 | the plan dialog's "Yes, clear context" (shown with `showClearContextOnPlanAccept: true`): `ExitPlanMode` resolves `isError: true` with the stock rejection text, `classic.SessionStart` `clear` follows 16 ms later, the old turn's `turn.complete` after the clear has begun, then the new conversation's `turn.start` with "Implement the following plan: ..." and no `prompt.submit`; a typed `/clear` raises no `prompt.submit` either; after the fix the plan crossed the clear and Claude sent only `updates` | tmux on `--plugin-dir`, a probe line in the hooks and the debug log, then the session transcript |
| A24 | the approval note (4.4), live on 2.1.296 in plan mode (`/plan`, a scratch directory, a three-step plan with Context, Steps and Verification), once on Haiku and once on Sonnet. Without the note neither sent a `report` update on this plan. With it the session transcript showed the note in the approval's result and both models sent `updates` (`partial` then `done` per step); the band read `3/3 done  plan`. `/plugin configure` shows no value beside a number option, also for a control plugin with `{ type: "number", default: 10 }` (13) | two tmux sessions on `--plugin-dir`, the transcripts read for every `headway` call and the note, then deleted |

## Appendix B. Probes

Facts the spec relies on, and where each stands.

| # | Claim | Status |
| :- | :- | :- |
| B1 | `$.settings.read()` with no `source` returns `enabledPlugins` with `<name>@<marketplace>` keys and boolean values (typed as a loose record) | settled, verified.md B1 |
| B2 | the guidance section reaches Claude and changes what it does | settled, A17 and section 6 |
| B3 | `tool.call` for `ExitPlanMode` from a subagent's plan carries `e.agentId` (typed; not observed: a general-purpose subagent in a plan-mode session reported that it has no `ExitPlanMode` tool, so no subagent call was seen; the `e.agentId` guard stays) | not observed |
| B4 | `TaskUpdate` with `status: "deleted"` and `TaskCreate` in a subagent | settled for `deleted`, verified.md B4; a subagent has no task tools |
| B5 | `agentIndex` order under `parallel`/`pipeline`, and an `agent()` with no label | settled, verified.md B5 |
| B6 | Claude Code's theme setting value for the automatic case (the `theme` row of `$.config.list()`), on which the light/dark fallback of section 11 depends | settled, verified.md B6 |
| B7 | `/plugin marketplace add <owner>/<repo>` on a repository whose plugin is at the root with `source: "./"` installs with no sub-directory (the layout another public mod ships) | open |
