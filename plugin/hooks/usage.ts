// Context, session cost and the compact hint (pure). SPEC.md section 6 and band line 3 (8.1).
// register.tsx reads `$.session.usage()` and the events and calls these with plain data.
import { bandCurrent, isFinished, matchAgent, roleText } from './agents.ts'
import type { AgentRecord, LogEntry } from './agents.ts'
import type { Line3Data, LogKind } from './band.tsx'
import { LOG_VERB } from './display.ts'
import type { UsageData } from './display.ts'
import { formatDuration, formatEstUsd, formatUsd } from './format.ts'
import type { Plan } from './plan.ts'

// The value of `usage.hint`, as the `state` tool hands it to Claude (7.1): null below the threshold,
// `compact-at-next-boundary` while armed, `compact-now` at a boundary.
export type Hint = 'compact-at-next-boundary' | 'compact-now' | null
const ARMED = 'compact-at-next-boundary' as const
const NOW = 'compact-now' as const

export const HINT_TEXT = 'compact now: task boundary'

// Context fill, 90 and up is critical (6): ok under the threshold, warn from it, err from 90.
export function ctxLevel(percent: number, threshold: number): 'ok' | 'warn' | 'err' {
  if (percent >= 90) return 'err'
  return percent >= threshold ? 'warn' : 'ok'
}

const isArmed = (percent: number | undefined, threshold: number) => percent !== undefined && percent >= threshold

// A measure between boundaries (a main-loop step): armed at the threshold, off below it. It never
// raises the hint to `now` (only a boundary does), and a `now` already shown stays while armed.
export function hintAfterMeasure(prev: Hint | undefined, percent: number | undefined, threshold: number): Hint {
  if (!isArmed(percent, threshold)) return null
  return prev === NOW ? NOW : ARMED
}

// A boundary is noticed when a subagent completes or a task flips done (`pending`), and is acted on at
// the next main-loop turn.complete with no agent running. `pendingRefs` are the task or group IDs
// noticed since then; `refs` are those of the boundary last acted on, which a turn.start is judged
// against.
export interface Boundary {
  pending: boolean
  pendingRefs: string[]
  refs: string[]
}

export const START: Boundary = { pending: false, pendingRefs: [], refs: [] }

export function noteBoundary(b: Boundary, refs: string[]): Boundary {
  const merged = b.pendingRefs.slice()
  for (const r of refs) if (r !== '' && r !== '—' && merged.indexOf(r) < 0) merged.push(r)
  return { ...b, pending: true, pendingRefs: merged }
}

// A main-loop turn.complete with the fresh percent. At a boundary (something noticed, and no agent
// not yet finished: a planned Workflow call that has not spawned is not an agent running, a
// provisional record is) the hint is `now` when armed; the notice is used up either way. Otherwise
// it is the plain measure.
export function hintAtTurnComplete(o: {
  agents: AgentRecord[]
  plan: Plan | null
  prev: Hint | undefined
  percent: number | undefined
  threshold: number
  boundary: Boundary
}): { hint: Hint; boundary: Boundary } {
  const running = o.agents.some((a) => !a.planned && !isFinished(a.status))
  if (!o.boundary.pending || running) {
    return { hint: hintAfterMeasure(o.prev, o.percent, o.threshold), boundary: o.boundary }
  }
  const refs = o.boundary.pendingRefs.slice()
  const current = bandCurrent(o.plan, o.agents).current?.id
  if (current !== undefined && refs.indexOf(current) < 0) refs.push(current)
  return {
    hint: isArmed(o.percent, o.threshold) ? NOW : null,
    boundary: { pending: false, pendingRefs: [], refs },
  }
}

// An agent.spawn, a Workflow call: work has begun, so a shown `now` goes back to armed.
export function hideHint(prev: Hint | undefined): Hint | undefined {
  return prev === NOW ? ARMED : prev
}

// A turn.start hides `now` when its text names a task or group other than the boundary's. A text
// that names none (or only the boundary's own) is not shown to begin work on another task.
export function hintOnTurnStart(o: { text: string; plan: Plan | null; prev: Hint | undefined; boundary: Boundary }): Hint | undefined {
  if (o.prev !== NOW) return o.prev
  const m = matchAgent(o.plan, [o.text])
  const named = m.taskIds[0] ?? m.groupId
  if (named === undefined) return o.prev
  return o.boundary.refs.indexOf(named) >= 0 ? o.prev : hideHint(o.prev)
}

// ---------------------------------------------------------------- band line 3

const LOG_KIND: Record<string, LogKind> = {
  done: 'done',
  'task-done': 'done',
  failed: 'failed',
  blocked: 'blocked',
  stalled: 'stalled',
  warn: 'warn',
}

// The newest log entry as line 3's last slot: `R02-73 implementer done 4m12s est.$0.42`.
function logSlot(e: LogEntry): { kind: LogKind; text: string } {
  const kind = LOG_KIND[e.kind] ?? 'info'
  const verb = LOG_VERB[e.kind]
  if (verb === undefined) {
    const text = e.kind === 'pin' || e.kind === 'unpin' ? e.detail ?? '' : [e.ref, e.detail].filter((x) => x !== undefined && x !== '').join(' ')
    return { kind, text }
  }
  const parts = [e.ref === '' ? '—' : e.ref]
  if (e.role) parts.push(roleText({ role: e.role, label: e.label }))
  parts.push(verb)
  if (e.kind === 'done') {
    if (e.durationMs !== undefined) parts.push(formatDuration(e.durationMs))
    if (e.estUsd !== undefined && e.estUsd > 0) parts.push(formatEstUsd(e.estUsd))
  } else if (e.kind !== 'resumed' && e.detail) parts.push(e.detail)
  return { kind, text: parts.join(' ') }
}

// Band line 3 (6, 8.1): `ctx 42%  $12.34` and the newest log entry, or the compact hint in its slot.
// Nothing for ctx or cost until the first measure; `cost n/a` when the ledger is absent.
export function line3Data(o: { usage: UsageData | null; threshold: number; log: LogEntry[] }): Line3Data {
  const out: Line3Data = {}
  const u = o.usage
  if (u) {
    if (u.percent !== undefined) out.ctx = { percent: u.percent, level: ctxLevel(u.percent, o.threshold) }
    out.cost = u.usd !== undefined ? formatUsd(u.usd) : 'cost n/a'
    if (u.hint === NOW) out.hint = HINT_TEXT
  }
  if (out.hint === undefined && o.log.length > 0) out.log = logSlot(o.log[0])
  return out
}
