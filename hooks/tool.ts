// The model tool (pure): its registration, the `track` line, the `report` list and the plan it
// stands for, and the `state` block Claude reads after `/compact`. SPEC.md 7.1.
import { agentRecency, isShown, isTerminal, looseGroups, matchedToPlan, roleText, sortAgents } from './agents.ts'
import type { AgentRecord, LogEntry } from './agents.ts'
import type { CurrentData } from './band.tsx'
import { clean, formatAgo, formatCounts, formatUsd, TASKS_MAX, TITLE_MAX } from './format.ts'
import { elapsed, logRows, modelEffort, rowText } from './display.ts'
import type { UsageData } from './display.ts'
import type { Filter } from './pin.ts'
import type { Plan, Task } from './plan.ts'
import { buildPlan } from './planbuild.ts'
import type { SourceTag } from './sources.ts'

export const TOOL_SPEC = {
  name: 'headway',
  description:
    'Plan progress tracker. One tool, pick an action. track: pin a plan FILE the user asked to track (file, optional section, ' +
    'doneRule column=<name>|check=<name>|auto, partial=<column>, groupMap path); plan-mode plans are tracked automatically. ' +
    'state: the goal counts, current task, blocked and stalled agents, every agent with its full id (for SendMessage), ' +
    'the newest log entries and the context fill; call after /compact or when you need it. report: give the task list ' +
    'yourself when the plan has no checklist or table (tasks), then mark steps with updates [{id, status}] or done [ids]; ' +
    'status is open, partial (started) or done. focus: set the current task. untrack: unpin.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['track', 'state', 'report', 'focus', 'untrack'] },
      file: { type: 'string', description: 'track: the plan file, relative to the session directory or absolute' },
      section: { type: 'string', description: 'track: a heading prefix, case-insensitive' },
      doneRule: { type: 'string', description: 'track: column=<name>, check=<name> or auto (default)' },
      partial: { type: 'string', description: 'track: a column whose non-empty cell marks a row partly done' },
      groupMap: { type: 'string', description: 'track: a JSON group map path' },
      logEntries: { type: 'integer', description: 'state: how many log entries, default 10' },
      tasks: {
        type: 'array',
        description: 'report: the task list; ids are optional (without them the tasks are 1..n), status defaults to open',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string', enum: ['open', 'partial', 'done'] } },
          required: ['title'],
        },
      },
      updates: {
        type: 'array',
        description: 'report: set the status of tasks already reported (not with tasks)',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, status: { type: 'string', enum: ['open', 'partial', 'done'] } },
          required: ['id', 'status'],
        },
      },
      done: { type: 'array', description: 'report: ids of tasks that are done (shorthand for updates)', items: { type: 'string' } },
      title: { type: 'string', description: 'report: the goal label' },
      taskId: { type: 'string', description: 'focus: a task or group ID of the tracked plan' },
    },
    required: ['action'],
  },
  isDeferred: false as const,
}

export type ReportStatus = 'open' | 'partial' | 'done'

// SPEC 6: the one section headway adds to the system prompt.
export const GUIDE_ID = 'headway:guide'
export const GUIDE_TEXT =
  'headway tracks progress beside the prompt. When a request asks for two or more things (for example "rename the file, then ' +
  'update its imports"), however few commands they take, call the `headway` tool once before any other work, with ' +
  '`action: "report"`, a goal `title` of at most 6 words, and `tasks: [{ title }]`, one short title per thing asked (ids optional). ' +
  'Mark each step as you go, not all at the end: before you start a step call `report` with `updates: [{ id, status: "partial" }]`; ' +
  'when it is finished, `status: "done"`. ' +
  'After plan-mode approval headway already tracks the plan: don\'t pin its file or report a new list; ' +
  'send `updates` with the ids `state` shows. ' +
  'Put the step\'s id in the description of any subagent you dispatch for it, as `step 3: ...`. For a request that asks for one ' +
  'thing, call nothing. Do not describe this tracking in your reply.'

// The tool's name as the engine offers it: a plugin tool is `mcp__<plugin>__<name>`.
const TOOL_SPEC_NAME = 'mcp__headway__' + TOOL_SPEC.name

// Renders that are not the main loop's prompt (a teammate's, a `/context` measure) or that draw
// nowhere (a bare or print run). `lean` is not one: it marks the short body, which the main loop of
// Opus 5.5 takes (seen live on 2.1.296: traits ['lean', 'skills']).
const NOT_MAIN = ['bare', 'print', 'teammate', 'analysis']

// The section is left out when guideClaude is off, when a file is pinned (the file is the record),
// when the session draws nowhere (no surface), when the render is not the main loop's, and when the
// request does not offer the tool. `e.tools` names a deferred tool too (seen live: TaskCreate listed
// while the model had to load it through ToolSearch), so the name alone decides.
export function guideWanted(o: { enabled: boolean; pinned: boolean; surfaces: readonly string[]; traits: readonly string[]; tools: readonly string[] }): boolean {
  return o.enabled && !o.pinned && o.surfaces.length > 0 && o.tools.includes(TOOL_SPEC_NAME) && !o.traits.some((t) => NOT_MAIN.includes(t))
}

export interface Reported {
  title?: string
  tasks: Array<{ id: string; title: string; status: ReportStatus }>
  doneAt?: number // when every task became done (SPEC 4.1); unset while one is not
}

export interface StatusUpdate {
  id: string
  status: ReportStatus
}

// The goal summary the band draws (the `goal` atom).
export interface GoalSummary {
  label: string
  done: number
  partial: number
  open: number
  total: number
  doneWord: string
  partialWord?: string
  noDoneRule: boolean
  error?: string
  source?: SourceTag // the active source the goal is drawn from (SPEC 4.1)
}

function countText(g: { done: number; partial: number; open: number; total: number; doneWord: string; partialWord?: string }): string {
  return g.partialWord !== undefined ? formatCounts(g) : g.done + '/' + g.total
}

export function trackLine(filter: Filter, plan: Plan): string {
  const c = plan.counts
  const counts = countText({ ...c, doneWord: plan.doneWord, partialWord: plan.partialWord })
  return 'tracking ' + clean(filter.file) + (filter.section ? ' § ' + clean(filter.section) : '') + ': ' + counts + ' tasks, ' + plan.groups.length + ' groups'
}

const STATUSES: readonly string[] = ['open', 'partial', 'done']
const isStatus = (v: unknown): v is ReportStatus => typeof v === 'string' && STATUSES.indexOf(v) >= 0

// An id as given: a non-empty string, or a number (a model may send `3` for step 3).
function idOf(v: unknown): string | undefined {
  const text = typeof v === 'string' ? clean(v, TITLE_MAX) : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
  return text === '' ? undefined : text
}

type Fail = { ok: false; error: string }

function parseList(input: Record<string, unknown>): { ok: true; kind: 'list'; report: Reported } | Fail {
  if (!Array.isArray(input.tasks)) return { ok: false, error: 'tasks must be an array' }
  if (input.title !== undefined && typeof input.title !== 'string') return { ok: false, error: 'title must be a string' }
  if (input.tasks.length > TASKS_MAX) return { ok: false, error: 'at most ' + TASKS_MAX + ' tasks' }
  const tasks: Reported['tasks'] = []
  const seen = new Set<string>()
  for (const [i, raw] of (input.tasks as unknown[]).entries()) {
    const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const title = typeof t.title === 'string' ? clean(t.title, TITLE_MAX) : ''
    if (title === '') return { ok: false, error: 'task ' + (i + 1) + ': title must be a non-empty string' }
    if (t.status !== undefined && !isStatus(t.status)) return { ok: false, error: 'task ' + (i + 1) + ': status must be open, partial or done' }
    // an id given must be usable; one left out is the task's position
    if (t.id !== undefined && idOf(t.id) === undefined) return { ok: false, error: 'task ' + (i + 1) + ': id must be a non-empty string' }
    const id = idOf(t.id) ?? String(i + 1)
    if (seen.has(id)) return { ok: false, error: 'duplicate id: ' + id }
    seen.add(id)
    tasks.push({ id, title, status: t.status ?? 'open' })
  }
  const report: Reported = { tasks }
  const goal = typeof input.title === 'string' ? clean(input.title, TITLE_MAX) : ''
  if (goal !== '') report.title = goal
  return { ok: true, kind: 'list', report }
}

function parseUpdates(input: Record<string, unknown>): { ok: true; kind: 'updates'; updates: StatusUpdate[] } | Fail {
  const updates: StatusUpdate[] = []
  if (input.updates !== undefined) {
    if (!Array.isArray(input.updates)) return { ok: false, error: 'updates must be an array' }
    if (input.updates.length > TASKS_MAX) return { ok: false, error: 'at most ' + TASKS_MAX + ' updates' }
    for (const [i, raw] of (input.updates as unknown[]).entries()) {
      const u = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const id = idOf(u.id)
      if (id === undefined) return { ok: false, error: 'update ' + (i + 1) + ': id must be a non-empty string' }
      if (!isStatus(u.status)) return { ok: false, error: 'update ' + (i + 1) + ': status must be open, partial or done' }
      updates.push({ id, status: u.status })
    }
  }
  if (input.done !== undefined) {
    if (!Array.isArray(input.done)) return { ok: false, error: 'done must be an array of ids' }
    if (input.done.length > TASKS_MAX) return { ok: false, error: 'at most ' + TASKS_MAX + ' done ids' }
    for (const [i, raw] of (input.done as unknown[]).entries()) {
      const id = idOf(raw)
      if (id === undefined) return { ok: false, error: 'done ' + (i + 1) + ': id must be a non-empty string' }
      updates.push({ id, status: 'done' })
    }
  }
  return { ok: true, kind: 'updates', updates }
}

// A `report` call (SPEC 4.3): a full list, or updates (with the `done` shorthand); never both.
export function parseReport(input: Record<string, unknown>): { ok: true; kind: 'list'; report: Reported } | { ok: true; kind: 'updates'; updates: StatusUpdate[] } | Fail {
  const hasList = input.tasks !== undefined
  const hasUpdates = input.updates !== undefined || input.done !== undefined
  if (hasList && hasUpdates) return { ok: false, error: 'tasks and updates or done cannot be combined in one call' }
  if (hasList) return parseList(input)
  if (hasUpdates) return parseUpdates(input)
  return { ok: false, error: 'tasks, updates or done required' }
}

// Sets the status of each task named; an id no task has is named back and the rest still apply. A
// repeated id (plan-mode headings) moves every task that has it. Answers a new list.
export function applyUpdates<T extends { id: string; status: ReportStatus }>(
  items: T[],
  updates: StatusUpdate[],
): { items: T[]; applied: number; unknown: string[] } {
  const next = items.map((t) => ({ ...t }))
  const unknown: string[] = []
  let applied = 0
  for (const u of updates) {
    const hits = next.filter((t) => t.id === u.id)
    if (hits.length === 0) {
      if (unknown.indexOf(u.id) < 0) unknown.push(u.id)
      continue
    }
    for (const t of hits) t.status = u.status
    applied += hits.length
  }
  return { items: next, applied, unknown }
}

// A plan-mode plan's step ids for a reply: the first twelve, then how many more.
const IDS_SHOWN = 12
export function idsText(ids: readonly string[]): string {
  const unique = ids.filter((id, i) => ids.indexOf(id) === i)
  return unique.slice(0, IDS_SHOWN).join(', ') + (unique.length > IDS_SHOWN ? ', +' + (unique.length - IDS_SHOWN) : '')
}

// The note an approval adds to Claude's context (SPEC 4.4, 6): the plan's steps as headway holds
// them and the two calls to make. Up to six steps show id and title (cut short), more show ids only.
const NOTE_TITLES = 6
const NOTE_TITLE_MAX = 24
export function planNote(steps: ReadonlyArray<{ id: string; title: string }>): string {
  const list =
    steps.length <= NOTE_TITLES
      ? steps.map((s) => s.id + ' ' + (s.title.length > NOTE_TITLE_MAX ? s.title.slice(0, NOTE_TITLE_MAX - 1).trimEnd() + '…' : s.title)).join(' · ')
      : 'ids ' + idsText(steps.map((s) => s.id))
  return 'headway is tracking this plan: ' + list + '. As you work, call headway report with updates [{id, status: "partial"}] when you start a step and "done" when it is finished.'
}

// The reply to an updates call: the count, then each unknown id.
export function updatedLine(applied: number, unknown: string[]): string {
  return 'updated ' + applied + ' tasks' + unknown.map((id) => '; unknown task: ' + id).join('')
}

// A reported list as a plan: one group named after the title, every task in it.
export function reportPlan(r: Reported): Plan {
  const tasks: Task[] = r.tasks.map((t, i) => ({ id: t.id, title: t.title, ordinal: i + 1, line: 0, shape: 'checklist', status: t.status, groups: [0] }))
  return buildPlan({
    section: r.title ?? '',
    tasks,
    groups: [{ id: r.title ?? 'reported', title: '', kind: 'heading', own: true, tasks: tasks.map((_, i) => i) }],
    partialWord: true,
  })
}

export function contextHint(usage: UsageData | null): 'compact-now' | 'compact-at-next-boundary' | null {
  return usage?.hint ?? null
}

export interface StateData {
  source?: SourceTag | null // the active source; absent reads as none
  filter: Filter | null
  goal: GoalSummary | null
  current?: CurrentData
  steps?: Array<{ id: string; title: string; status: ReportStatus }> // a plan-mode plan's steps: their ids are headway's (4.4)
  agents: AgentRecord[]
  log: LogEntry[]
  usage: UsageData | null
  now: number
  logEntries: number
}

const STEP_TITLE = 60

const STATE_FINISHED = 20

function who(a: AgentRecord): string {
  const role = clean(roleText(a))
  const what = clean(a.label ?? a.description)
  return clean(a.id) + ' ' + (role === '' ? '—' : role) + (role === what ? '' : ' "' + what + '"') + (a.name ? ' (name: ' + clean(a.name) + ')' : '')
}

// The goal line names the active source by its tag; a file also by its path and section.
function goalLine(d: StateData): string {
  const tag = d.source ?? null
  if (tag === null) return 'goal: nothing tracked'
  const f = tag === 'file' ? d.filter : null
  const source = f ? 'file: ' + clean(f.file) + (f.section ? ' § ' + clean(f.section) : '') : tag
  const g = d.goal
  if (g === null) return 'goal: ' + clean(f ? f.section ?? f.file : tag) + ' — not read yet (' + source + ')'
  return 'goal: ' + clean(g.label) + ' — ' + clean(formatCounts(g)) + ' (' + source + ')' + (g.error !== undefined ? ' — plan unreadable: ' + clean(g.error) : '')
}

function currentLine(c: CurrentData | undefined): string {
  if (c === undefined) return 'current: none'
  const done = c.status === 'partial' ? 'in progress' : c.unit === 'items' ? c.done + '/' + c.total + ' items done' : c.done + '/' + c.total + ' agents finished'
  const title = clean(c.title)
  return 'current: ' + clean(c.id) + (title !== '' ? ' ' + title : '') + ' — ' + done
}

function logText(log: LogEntry[], n: number): string {
  const entries = log.slice(0, Math.max(0, n))
  if (entries.length === 0) return 'log: none'
  const rows = logRows({ columns: 10_000, ascii: false, log: entries })
  return 'log: ' + rows.map((r) => clean(rowText(r))).join(' | ')
}

export function stateBlock(d: StateData): string {
  const real = sortAgents(d.agents.filter(isShown))
  const lines = [goalLine(d), currentLine(d.current)]
  // a plan-mode plan's ids are headway's (`2.1` where numbering restarts): listed so `report` can name them
  if (d.steps && d.steps.length > 0) lines.push('steps: ' + d.steps.map((s) => clean(s.id) + ' ' + clean(s.title, STEP_TITLE) + ' (' + s.status + ')').join(' · '))
  const blocked = real.filter((a) => a.status === 'blocked')
  if (blocked.length === 0) lines.push('blocked: none')
  for (const a of blocked) lines.push('blocked: ' + who(a) + ' — BLOCKED' + (a.question ? ': ' + clean(a.question) : ''))
  const stalled = real.filter((a) => a.status === 'stalled')
  if (stalled.length === 0) lines.push('stalled: none')
  for (const a of stalled) {
    const quiet = a.firstStepAt === undefined ? 'no first step for ' + formatAgo(d.now - a.spawnedAt) : 'no step for ' + formatAgo(d.now - (a.lastStepAt ?? a.spawnedAt))
    lines.push('stalled: ' + who(a) + ' — ' + quiet)
  }
  // Every agent that is not over for good, then the newest finished ones, then how many are left out.
  const finished = real.filter((a) => isTerminal(a.status)).sort((x, y) => agentRecency(y) - agentRecency(x))
  const shownFinished = new Set(finished.slice(0, STATE_FINISHED))
  const listed = real.filter((a) => !isTerminal(a.status) || shownFinished.has(a))
  const hidden = real.length - listed.length
  // The unmatched agents of one workflow run are listed together, after the others, under the run's title.
  const runs = looseGroups(real.filter((a) => !matchedToPlan(a))).groups.filter((g) => g.kind === 'run')
  const inRun = new Set(runs.flatMap((g) => g.agents))
  const entry = (a: AgentRecord) => '[' + a.status + '] ' + who(a) + ' ' + clean(modelEffort(a)) + ' ' + formatAgo(elapsed(a, d.now))
  const blocks = [listed.filter((a) => !inRun.has(a)).map(entry).join(' · ')]
  for (const g of runs) {
    const mine = listed.filter((a) => g.agents.includes(a))
    if (mine.length > 0) blocks.push('run "' + clean(g.title) + '": ' + mine.map(entry).join(' · '))
  }
  lines.push(
    real.length === 0
      ? 'agents: none'
      : 'agents: ' + blocks.filter((b) => b !== '').join(' | ') + (hidden > 0 ? ' · +' + hidden + ' more' : '') + ' (ids are for SendMessage)',
  )
  lines.push(logText(d.log, d.logEntries))
  const u = d.usage
  let ctx = 'context: ' + (u?.percent !== undefined ? Math.round(u.percent) + '%' : 'n/a')
  if (u?.percent !== undefined) ctx += u.usd !== undefined ? ' (' + formatUsd(u.usd) + ')' : ' (cost n/a)'
  const hint = contextHint(u)
  if (hint !== null) ctx += ' — contextHint: ' + hint
  lines.push(ctx)
  return lines.join('\n')
}
