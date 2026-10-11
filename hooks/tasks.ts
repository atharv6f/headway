// Claude's task tools as a plan source (pure): the payloads of TaskCreate, TaskUpdate and TodoWrite
// folded into one list, the task files a resume rebuilds it from, and the list as a plan. SPEC.md 4.5.
import type { Plan, Status, Task } from './plan.ts'
import { clean, TASKS_MAX, TITLE_MAX } from './format.ts'
import { buildPlan } from './planbuild.ts'

export interface TaskItem {
  id: string
  title: string
  status: Status
  at?: number // when a call last added or changed it (SPEC 4.1: newer data than a finished list above)
}

// The tools' status words as the plan's: pending open, in_progress partial, completed done.
const STATUS: Record<string, Status> = { pending: 'open', in_progress: 'partial', completed: 'done' }

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

// A title as it is taken in: one clean line of at most TITLE_MAX characters (SPEC 12); none when empty.
function titleOf(v: unknown): string | undefined {
  const t = typeof v === 'string' ? clean(v, TITLE_MAX) : ''
  return t !== '' ? t : undefined
}

// A call that failed (a string result, `success: false`) changed nothing in the engine's list either.
function failed(output: unknown): boolean {
  return typeof output !== 'object' || output === null || asRecord(output).success === false
}

const stamp = (at: number | undefined) => (at !== undefined ? { at } : {})

function created(list: TaskItem[] | null, input: Record<string, unknown>, output: unknown, at?: number): TaskItem[] | null {
  const id = text(asRecord(asRecord(output).task).id)
  const title = titleOf(input.subject)
  if (failed(output) || id === undefined || title === undefined) return list
  const items = list ?? []
  // an id already listed is the same task: renamed, in its place, status kept
  if (items.some((t) => t.id === id)) return items.map((t) => (t.id === id ? { ...t, title, ...stamp(at) } : t))
  // a full list takes no more
  if (items.length >= TASKS_MAX) return list
  return [...items, { id, title, status: 'open', ...stamp(at) }]
}

function updated(list: TaskItem[] | null, input: Record<string, unknown>, output: unknown, at?: number): TaskItem[] | null {
  const id = text(input.taskId)
  if (list === null || failed(output) || id === undefined || !list.some((t) => t.id === id)) return list
  if (input.status === 'deleted') return list.filter((t) => t.id !== id)
  const status = typeof input.status === 'string' ? STATUS[input.status] : undefined
  const title = titleOf(input.subject)
  return list.map((t) => (t.id === id ? { ...t, ...(title !== undefined ? { title } : {}), ...(status !== undefined ? { status } : {}), ...stamp(at) } : t))
}

// A TodoWrite row's id: a short hash of its content, lower-cased with its spacing collapsed, so a row
// keeps its id when rows are inserted, dropped or reordered around it (SPEC 4.5).
export function todoId(content: string): string {
  let h = 0x811c9dc5
  for (const ch of content.trim().replace(/\s+/g, ' ').toLowerCase()) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % 36 ** 4).toString(36).padStart(4, '0')
}

// The whole list, every call: its rows in order, each id from its content, a repeat of the same
// content told apart by `-2`, `-3`. The input names the list even when the engine empties its own
// once every row is done. A row keeps its stamp unless it is new or its status moved.
function written(list: TaskItem[] | null, input: Record<string, unknown>, output: unknown, at?: number): TaskItem[] | null {
  if (!Array.isArray(input.todos) || typeof output === 'string') return list
  const seen = new Map<string, number>()
  const out: TaskItem[] = []
  for (const raw of input.todos as unknown[]) {
    if (out.length >= TASKS_MAX) break
    const r = asRecord(raw)
    const title = titleOf(r.content)
    if (title === undefined) continue
    const status = (typeof r.status === 'string' ? STATUS[r.status] : undefined) ?? 'open'
    const base = todoId(title)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    const id = n === 1 ? base : base + '-' + n
    const was = list?.find((t) => t.id === id)
    out.push({ id, title, status, ...(was !== undefined && was.status === status ? stamp(was.at) : stamp(at)) })
  }
  return out
}

// The list after one call of the main loop. `input` is the call's fields, `output` the tool's result.
// Any other tool (TaskList, TaskGet, ...) leaves the list as it is.
// `at`: the call's time, stamped on each item it adds or changes.
export function applyTaskCall(tool: string, input: Record<string, unknown>, output: unknown, list: TaskItem[] | null, at?: number): TaskItem[] | null {
  if (tool === 'TaskCreate') return created(list, input, output, at)
  if (tool === 'TaskUpdate') return updated(list, input, output, at)
  if (tool === 'TodoWrite') return written(list, input, output, at)
  return list
}

// One task file of `<configDir>/tasks/<session_id>/` (`{ id, subject, status, ... }`); null for
// anything else (the lock, a deleted task, text that is not a task).
export function parseTaskFile(raw: string): TaskItem | null {
  let o: Record<string, unknown>
  try {
    o = asRecord(JSON.parse(raw))
  } catch {
    return null
  }
  const id = text(o.id)
  const title = titleOf(o.subject)
  const status = typeof o.status === 'string' ? STATUS[o.status] : undefined
  return id === undefined || title === undefined || status === undefined ? null : { id, title, status }
}

// The list the task files hold, ids in numeric order; null when none is a task.
export function rebuildFromFiles(files: string[]): TaskItem[] | null {
  const items = files.flatMap((f) => parseTaskFile(f) ?? [])
  items.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
  return items.length > 0 ? items.slice(0, TASKS_MAX) : null
}

// The list as a plan: one group of its own, every task in it.
export function tasksPlan(items: TaskItem[]): Plan {
  const tasks: Task[] = items.map((t, i) => ({ id: t.id, title: t.title, ordinal: i + 1, line: 0, shape: 'checklist', status: t.status, groups: [0] }))
  return buildPlan({ section: '', tasks, groups: [{ id: 'tasks', title: '', kind: 'heading', own: true, tasks: tasks.map((_, i) => i) }] })
}
