// What headway keeps in `$.store` (pure): one record per session under `session:<id>`, the band
// pref, and the 14-day prune rule. SPEC.md 3.3 and 8.1.
import { agentRecency, isTerminal } from './agents.ts'
import { clean, TASKS_MAX, TITLE_MAX } from './format.ts'
import type { AgentRecord, LogEntry } from './agents.ts'
import type { Filter } from './pin.ts'
import type { Reported } from './tool.ts'
import type { PlanMode } from './planmode.ts'
import type { TaskItem } from './tasks.ts'
import type { SourceLabels } from './sources.ts'

export interface SavedSession {
  filter: Filter | null
  report: Reported | null
  plan: PlanMode | null // the approved plan-mode plan's parsed steps; its text stays in `$.state`
  label: SourceLabels // each in-memory source's prompt label: the prompt of the turn that started it (SPEC 4.8)
  prompt: string | null // the newest qualifying prompt line, the label of the next source to start
  tasks: TaskItem[] | null // the task-tool list (SPEC 4.5); a finished list is kept once its task files are gone
  agents: AgentRecord[]
  log: LogEntry[]
  savedAt: number
}

export const SAVE_MS = 1000
export const AGENT_CAP = 300
export const LOG_CAP = 500
export const MAX_RECORD_BYTES = 3 * 1024 * 1024
export const PRUNE_MS = 14 * 24 * 60 * 60_000
export const BAND_PREF = 'band'
const PREFIX = 'session:'

export function sessionKey(id: string): string {
  return PREFIX + id
}

export function isSessionKey(key: string): boolean {
  return key.startsWith(PREFIX)
}

// A stored value read back as a record, or undefined when it is not one.
export function asSaved(v: unknown): SavedSession | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.agents) || !Array.isArray(o.log) || typeof o.savedAt !== 'number') return undefined
  return {
    filter: (o.filter ?? null) as Filter | null,
    report: (o.report ?? null) as Reported | null,
    plan: (o.plan ?? null) as PlanMode | null,
    label: typeof o.label === 'object' && o.label !== null && !Array.isArray(o.label) ? (o.label as SourceLabels) : {},
    prompt: typeof o.prompt === 'string' ? o.prompt : null,
    tasks: Array.isArray(o.tasks) ? (o.tasks as TaskItem[]) : null,
    agents: o.agents as AgentRecord[],
    log: o.log as LogEntry[],
    savedAt: o.savedAt,
  }
}

// Saved more than 14 days ago, or carrying no save time at all.
export function isStale(v: unknown, now: number): boolean {
  const at = typeof v === 'object' && v !== null ? (v as { savedAt?: unknown }).savedAt : undefined
  return typeof at !== 'number' || now - at > PRUNE_MS
}

// A list a model wrote, as it is saved: at most TASKS_MAX items, each title one clean line of at most
// TITLE_MAX characters. A list already inside both comes back as it is.
function boundItems<T extends { title: string }>(items: T[]): T[] {
  const kept = items.length > TASKS_MAX ? items.slice(0, TASKS_MAX) : items
  if (kept === items && items.every((x) => clean(x.title, TITLE_MAX) === x.title)) return items
  return kept.map((x) => ({ ...x, title: clean(x.title, TITLE_MAX) }))
}

function boundReport(r: Reported | null | undefined): Reported | null {
  if (!r) return null
  const goal = r.title === undefined ? undefined : clean(r.title, TITLE_MAX)
  const { title: _title, ...rest } = r
  return { ...rest, ...(goal !== undefined && goal !== '' ? { title: goal } : {}), tasks: boundItems(r.tasks) }
}

function boundMode(p: PlanMode | null | undefined): PlanMode | null {
  if (!p) return null
  const title = p.title === undefined ? undefined : clean(p.title, TITLE_MAX)
  const { title: _title, ...rest } = p
  return { ...rest, ...(title !== undefined && title !== '' ? { title } : {}), steps: boundItems(p.steps) }
}

// The record as it is written: the lists a model wrote (report, plan-mode steps, task-tool items) cut
// to TASKS_MAX items of TITLE_MAX characters; at most AGENT_CAP agents (every one that is not over for
// good, then the most recently moved finished ones); at most LOG_CAP log entries (newest first); and,
// when the serialised record still exceeds MAX_RECORD_BYTES, the oldest finished agents, then the
// oldest log entries, then the tail of the report, plan and task lists dropped until it fits.
export function capSession(input: SavedSession): SavedSession {
  const rec: SavedSession = { ...input, report: boundReport(input.report), plan: boundMode(input.plan), tasks: input.tasks ? boundItems(input.tasks) : input.tasks }
  const live = rec.agents.filter((a) => !isTerminal(a.status)).length
  const room = Math.max(0, AGENT_CAP - live)
  const finished = rec.agents.filter((a) => isTerminal(a.status)).sort((x, y) => agentRecency(y) - agentRecency(x))
  let keep = new Set(finished.slice(0, room))
  let log = rec.log.length > LOG_CAP ? rec.log.slice(0, LOG_CAP) : rec.log
  let report = rec.report
  let plan = rec.plan
  let tasks = rec.tasks
  const build = (): SavedSession => ({
    ...rec,
    agents: rec.agents.length === live + keep.size ? rec.agents : rec.agents.filter((a) => !isTerminal(a.status) || keep.has(a)),
    log,
    report,
    plan,
    tasks,
  })
  let out = build()
  let size = JSON.stringify(out).length
  if (size <= MAX_RECORD_BYTES) return out
  // Over the size guard: shed the oldest finished agents first, then the oldest log entries.
  const byAge = [...keep].sort((x, y) => agentRecency(x) - agentRecency(y))
  while (size > MAX_RECORD_BYTES && byAge.length > 0) {
    keep = new Set(byAge.slice(Math.max(1, Math.ceil(byAge.length / 10))))
    byAge.splice(0, byAge.length - keep.size)
    out = build()
    size = JSON.stringify(out).length
  }
  while (size > MAX_RECORD_BYTES && log.length > 0) {
    log = log.slice(0, Math.floor(log.length * 0.9))
    out = build()
    size = JSON.stringify(out).length
  }
  // Then the sources: the tail of each list a tenth at a time, the longest first, until it fits.
  const shed = <T,>(items: T[]): T[] => items.slice(0, Math.floor(items.length * 0.9))
  while (size > MAX_RECORD_BYTES && ((report?.tasks.length ?? 0) > 0 || (plan?.steps.length ?? 0) > 0 || (tasks?.length ?? 0) > 0)) {
    const sizes = [report?.tasks.length ?? 0, plan?.steps.length ?? 0, tasks?.length ?? 0]
    const longest = sizes.indexOf(Math.max(...sizes))
    if (longest === 0 && report) report = { ...report, tasks: shed(report.tasks) }
    else if (longest === 1 && plan) plan = { ...plan, steps: shed(plan.steps) }
    else if (tasks) tasks = shed(tasks)
    out = build()
    size = JSON.stringify(out).length
  }
  return out
}

// A record as the text it is compared by: a save whose text equals the last one written is skipped.
export function recordText(rec: SavedSession): string {
  return JSON.stringify({ ...rec, savedAt: 0 })
}
