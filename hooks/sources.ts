// Plan sources (pure): which source draws the goal, its tag, its plan and its label. SPEC.md 4.1, 4.8.
//
// The seam. `SOURCES` is the precedence, highest first; the first row whose `has` is true is the
// active source. A source is one row here plus the hook in register.tsx that writes its data into
// `Sources`:
//   - P2 (report updates, partial) changed the `reported` row's data, `reportPlan`, `applyReport` and the
//     `temporal` flag (rows a task-less agent may attach to by its one partial task, 5.3); nothing else;
//   - P3 (task tools) adds a `tasks` field to `Sources`, a `tasks` row after `plan`, clears it in
//     `approvePlan`;
//   - P4 (workflow phases) adds a `phases` row after it the same way.
// register.tsx reads the active tag and plan only through `activeSource` and `sourcePlan`, so
// nothing else changes when a row is added. The file row has no `plan`: its plan is read and
// re-read by the 2 s poll (register.tsx loadPlan), which owns the file's mtime and its errors.
import type { Filter } from './pin.ts'
import { absolutePath } from './pin.ts'
import type { Plan, Task } from './plan.ts'
import type { PlanMode } from './planmode.ts'
import { phasePlan } from './phases.ts'
import type { PhaseRun } from './phases.ts'
import { applyUpdates, reportPlan } from './tool.ts'
import type { Reported, StatusUpdate } from './tool.ts'
import { basename, clean, TITLE_MAX, truncate } from './format.ts'
import { planFlips } from './agents.ts'
import { boundPlan, buildPlan } from './planbuild.ts'
import type { LogEntry } from './agents.ts'
import { tasksPlan } from './tasks.ts'
import type { TaskItem } from './tasks.ts'

export type SourceTag = 'file' | 'reported' | 'plan' | 'tasks' | 'phases'

// The data of every source, whether or not it is the one drawn: a lower source keeps its data
// while a higher one is active.
export interface Sources {
  filter: Filter | null
  report: Reported | null
  planMode: PlanMode | null
  tasks: TaskItem[] | null
  phases: PhaseRun | null // derived from the agent records on every read (phases.ts), never stored
}

interface SourceRow {
  tag: SourceTag
  has: (s: Sources) => boolean
  plan?: (s: Sources) => Plan // in-memory sources only
  title?: (s: Sources) => string | undefined // the source's own goal label, before the prompt's
  temporal?: true // an agent that names no task joins the one partial task (SPEC 5.3)
  doneAt?: (s: Sources) => number | undefined // a list whose every task is done: when it got there
  dataAt?: (s: Sources) => number | undefined // when the source's data last moved
}

export const SOURCES: SourceRow[] = [
  { tag: 'file', has: (s) => s.filter !== null, title: (s) => s.filter!.section ?? basename(s.filter!.file) },
  { tag: 'reported', has: (s) => (s.report?.tasks.length ?? 0) > 0, plan: (s) => reportPlan(s.report!), title: (s) => s.report!.title, temporal: true, doneAt: (s) => s.report!.doneAt },
  { tag: 'plan', has: (s) => (s.planMode?.steps.length ?? 0) > 0, plan: (s) => modePlan(s.planMode!), title: (s) => s.planMode!.title, temporal: true, doneAt: (s) => s.planMode!.doneAt },
  { tag: 'tasks', has: (s) => (s.tasks?.length ?? 0) > 0, plan: (s) => tasksPlan(s.tasks!), temporal: true, dataAt: (s) => Math.max(...s.tasks!.map((t) => t.at ?? -Infinity)) },
  { tag: 'phases', has: (s) => s.phases !== null, plan: (s) => phasePlan(s.phases!), title: (s) => s.phases!.title, dataAt: (s) => s.phases!.at },
]

// 4.1: a list whose every task is done yields to a lower source whose data moved after it finished.
function yields(s: Sources, i: number): boolean {
  const done = SOURCES[i].doneAt?.(s)
  return done !== undefined && SOURCES.slice(i + 1).some((r) => r.has(s) && (r.dataAt?.(s) ?? -Infinity) > done)
}

export function activeSource(s: Sources): SourceTag | null {
  return SOURCES.find((r, i) => r.has(s) && !yields(s, i))?.tag ?? null
}

// A reported or plan-mode list after a change: stamped with the moment its every task became done
// (kept while it stays so), unstamped while one is not.
export function withDoneAt<T extends { doneAt?: number }>(src: T, items: Array<{ status: string }>, at: number): T {
  const { doneAt, ...rest } = src
  const all = items.length > 0 && items.every((t) => t.status === 'done')
  return (all ? { ...rest, doneAt: doneAt ?? at } : rest) as T
}

// 5.3 step 2 applies to this source's plan.
export function isTemporal(tag: SourceTag | null): boolean {
  return SOURCES.find((r) => r.tag === tag)?.temporal === true
}

// 4.3: `report` updates move the tasks of the active source when it is a reported or plan-mode list;
// any other active source (or none) refuses them. Answers the sources with the moved list.
export function applyReport(
  s: Sources,
  updates: StatusUpdate[],
  at: number,
): { ok: true; sources: Sources; applied: number; unknown: string[] } | { ok: false; error: string } {
  const tag = activeSource(s)
  if (tag === 'reported') {
    const r = applyUpdates(s.report!.tasks, updates)
    return { ok: true, sources: { ...s, report: withDoneAt({ ...s.report!, tasks: r.items }, r.items, at) }, applied: r.applied, unknown: r.unknown }
  }
  if (tag === 'plan') {
    const r = applyUpdates(s.planMode!.steps, updates)
    return { ok: true, sources: { ...s, planMode: withDoneAt({ ...s.planMode!, steps: r.items }, r.items, at) }, applied: r.applied, unknown: r.unknown }
  }
  return { ok: false, error: 'updates apply to a reported or plan-mode list' }
}

// The plan an in-memory source stands for; null for the file (the poll's parse) and for no source.
export function sourcePlan(s: Sources, tag: SourceTag | null): Plan | null {
  const row = SOURCES.find((r) => r.tag === tag)
  return row?.plan && row.has(s) ? boundPlan(row.plan(s)) : null
}

// 4.8: the source's own title, else the prompt line of the turn that started it, else the tag itself.
export function goalLabel(s: Sources, tag: SourceTag, prompt: string | null | undefined): string {
  const own = SOURCES.find((r) => r.tag === tag)?.title?.(s)
  const text = own === undefined ? '' : clean(own, TITLE_MAX)
  if (text !== '') return text
  return prompt ?? tag
}

// 4.1: an approval starts a new piece of work. It replaces the plan-mode plan (a plan with no step
// leaves the source empty) and clears the reported list and the task-tool list; the pinned file is not touched.
export function approvePlan(s: Sources, planMode: PlanMode): Sources {
  return { ...s, report: null, tasks: null, planMode: planMode.steps.length > 0 ? planMode : null }
}

// A plan-mode plan as a plan: its steps as tasks under their heading groups, children as each bar.
export function modePlan(pm: PlanMode): Plan {
  const tasks: Task[] = pm.steps.map((st, i) => ({
    id: st.id,
    title: st.title,
    ordinal: i + 1,
    line: 0,
    shape: 'checklist',
    status: st.status,
    groups: [st.group],
    // a done step's children are done with it
    ...(st.sub ? { sub: st.status === 'done' ? { done: st.sub.total, total: st.sub.total } : { ...st.sub } } : {}),
  }))
  return buildPlan({
    section: pm.title ?? '',
    tasks,
    groups: pm.groups.map((g, gi) => ({ id: g.id, title: g.title, kind: 'heading' as const, ...(g.own ? { own: true as const } : {}), tasks: tasks.flatMap((t, ti) => (t.groups[0] === gi ? [ti] : [])) })),
    partialWord: true,
  })
}

// 4.8: each in-memory source's prompt label, the newest qualifying prompt at the moment the source
// started (a full report list, a plan approval, a task list out of nothing, a new run with phases).
// A later prompt never renames it; the next start of the same source does.
export type SourceLabels = Partial<Record<SourceTag, string>>

export function startLabel(labels: SourceLabels, tag: SourceTag, prompt: string | null): SourceLabels {
  const out: SourceLabels = { ...labels }
  if (prompt === null) delete out[tag]
  else out[tag] = prompt
  return out
}

// The task flips of one in-memory source between two of its states, in the words every source uses
// (SPEC 8: each `task-done` is a task boundary). The file's own flips add "(plan changed)".
export function sourceFlips(prev: Plan, next: Plan, at: number): LogEntry[] {
  return planFlips(prev, next, at, '')
}

const LABEL_MAX = 60

// The text without its `<pasted_content ...>` and `</pasted_content>` tags: a tag runs to the first `>`
// after its name, and with no `>` left there is no tag left. One pass; a pattern with `[^>]*` would
// rescan the rest of the prompt from every unclosed `<pasted_content`.
function withoutPasteTags(text: string): string {
  let out = ''
  let at = 0
  let from = 0
  for (;;) {
    const lt = text.indexOf('<', from)
    if (lt < 0) break
    const name = lt + (text[lt + 1] === '/' ? 2 : 1)
    const end = name + 'pasted_content'.length
    if (!text.startsWith('pasted_content', name) || /\w/.test(text[end] ?? ' ')) {
      from = lt + 1
      continue
    }
    const close = text.indexOf('>', end)
    if (close < 0) break
    out += text.slice(at, lt)
    at = close + 1
    from = at
  }
  return out + text.slice(at)
}

// The label a `prompt.submit` gives (4.8): a composer prompt that is not a slash command, its
// pasted-content tags removed (the pasted text stays), the first non-empty line, cut to 60.
export function promptLabel(text: string, originKind: string | undefined): string | undefined {
  if (originKind !== 'composer' || typeof text !== 'string') return undefined
  if (text.trimStart().startsWith('/')) return undefined
  const line = withoutPasteTags(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => clean(l))
    .find((l) => l !== '')
  return line === undefined ? undefined : truncate(line, LABEL_MAX)
}

// 4.1: a full `report` list is new work, which retires the finished agents, when fewer than half of
// its tasks share an id and a title (any case, spacing collapsed) with the list it replaces.
export function isNewWork(old: Reported | null, next: Reported): boolean {
  const key = (t: { id: string; title: string }) => t.id + '\u0000' + t.title.toLowerCase().replace(/\s+/g, ' ').trim()
  const before = new Set((old?.tasks ?? []).map(key))
  const shared = next.tasks.filter((t) => before.has(key(t))).length
  return shared < next.tasks.length / 2
}

// 4.4: a tool `track` names the plan-mode plan's file when its path, normalised, is the approved
// plan's own; a Windows-style path (`C:\...`) compares in any case, as its filesystem does.
export function isPlanModeFile(file: string, approved: string | undefined): boolean {
  if (approved === undefined) return false
  const key = (p: string) => {
    const abs = absolutePath('/', p)
    return abs.startsWith('/') ? abs : abs.toLowerCase()
  }
  return key(file) === key(approved)
}
