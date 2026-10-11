import { expect, test } from 'claude-code/testing'
import {
  ctxLevel,
  hideHint,
  hintAfterMeasure,
  hintAtTurnComplete,
  hintOnTurnStart,
  line3Data,
  noteBoundary,
  START,
} from '../plugin/hooks/usage.ts'
import type { Boundary, Hint } from '../plugin/hooks/usage.ts'
import type { AgentRecord, LogEntry } from '../plugin/hooks/agents.ts'
import { parsePlan } from '../plugin/hooks/plan.ts'
import type { Plan } from '../plugin/hooks/plan.ts'

const ARMED = 'compact-at-next-boundary' as const
const NOW = 'compact-now' as const
const PLAN_TEXT = '### Release 2 tasks\n\n- [ ] T1: first\n- [ ] T2: second\n- [x] T3: third\n'
function plan(): Plan {
  const r = parsePlan(PLAN_TEXT, { section: 'Release 2 tasks' })
  if (!r.ok) throw new Error(r.error)
  return r.plan
}
const PLAN = plan()

let n = 0
function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  n++
  return {
    id: 'a' + n, agentId: 'a' + n, description: 'd', subagentType: 'scout', taskIds: ['T1'], role: 'scout', status: 'done',
    spawnedAt: 0, steps: 1, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, estUsd: 0, warnings: [], ...over,
  }
}

const AT = (b: Boundary, agents: AgentRecord[], percent: number | undefined, prev: Hint | undefined = null) =>
  hintAtTurnComplete({ agents, plan: PLAN, prev, percent, threshold: 70, boundary: b })

// ---------------------------------------------------------------- arming

test('the hint is off below the threshold, armed from it, and off when the percent is unknown', async () => {
  expect(hintAfterMeasure(undefined, 69, 70)).toBe(null)
  expect(hintAfterMeasure(null, 70, 70)).toBe(ARMED)
  expect(hintAfterMeasure(null, 99, 70)).toBe(ARMED)
  expect(hintAfterMeasure(ARMED, undefined, 70)).toBe(null)
  expect(hintAfterMeasure(undefined, 50, 40)).toBe(ARMED)
})

test('a measure between boundaries never raises the hint to now; a shown now stays while armed and goes with the arming', async () => {
  expect(hintAfterMeasure(ARMED, 80, 70)).toBe(ARMED)
  expect(hintAfterMeasure(NOW, 80, 70)).toBe(NOW)
  expect(hintAfterMeasure(NOW, 12, 70)).toBe(null) // after /compact
})

test('context level: ok under the threshold, warn from it, err from 90', async () => {
  expect(ctxLevel(69, 70)).toBe('ok')
  expect(ctxLevel(70, 70)).toBe('warn')
  expect(ctxLevel(89, 70)).toBe('warn')
  expect(ctxLevel(90, 70)).toBe('err')
  expect(ctxLevel(95, 95)).toBe('err')
})

// ---------------------------------------------------------------- boundary

test('now only at a main-loop turn.complete after an agent finished or a task flipped, with no agent running', async () => {
  const done = [agent({ taskIds: ['T1'] })]
  // nothing happened since the last evaluation: armed, not now
  expect(AT(START, done, 80).hint).toBe(ARMED)
  // a subagent finished, and everything is finished
  const pending = noteBoundary(START, ['T1'])
  const out = AT(pending, done, 80)
  expect(out.hint).toBe(NOW)
  expect(out.boundary.pending).toBe(false)
  // consumed: the next turn.complete with nothing new is armed again once the hint was hidden
  expect(AT(out.boundary, done, 80, hideHint(NOW)).hint).toBe(ARMED)
})

test('no now while an agent is running, queued, stalled or provisional; the boundary waits for the next turn.complete', async () => {
  const pending = noteBoundary(START, ['T1'])
  for (const status of ['running', 'queued', 'stalled'] as const) {
    const out = AT(pending, [agent(), agent({ status })], 80)
    expect(out.hint).toBe(ARMED)
    expect(out.boundary.pending).toBe(true)
  }
  expect(AT(pending, [agent(), agent({ status: 'running', provisional: true })], 80).hint).toBe(ARMED)
  // blocked, failed and done count as finished
  expect(AT(pending, [agent({ status: 'blocked' }), agent({ status: 'failed' })], 80).hint).toBe(NOW)
  // a Workflow's planned call that has not spawned is not an agent running
  expect(AT(pending, [agent(), agent({ status: 'queued', planned: true })], 80).hint).toBe(NOW)
  // the wait ends when they finish
  const later = AT(AT(pending, [agent({ status: 'running' })], 80).boundary, [agent()], 80)
  expect(later.hint).toBe(NOW)
})

test('a boundary below the threshold is off and is used up', async () => {
  const out = AT(noteBoundary(START, ['T1']), [agent()], 40)
  expect(out.hint).toBe(null)
  expect(out.boundary.pending).toBe(false)
  // crossing the threshold later, mid-task, is armed and not now
  expect(AT(out.boundary, [agent()], 75).hint).toBe(ARMED)
})

test('a hint already shown stays through a turn.complete that is not a boundary, while armed', async () => {
  const shown = AT(noteBoundary(START, ['T1']), [agent()], 80)
  expect(AT(shown.boundary, [agent()], 82, NOW).hint).toBe(NOW)
  expect(AT(shown.boundary, [agent()], 20, NOW).hint).toBe(null)
})

// ---------------------------------------------------------------- hiding

test('spawn, a Workflow call and a turn.start on another task hide now; armed and off are untouched', async () => {
  expect(hideHint(NOW)).toBe(ARMED)
  expect(hideHint(ARMED)).toBe(ARMED)
  expect(hideHint(null)).toBe(null)
  expect(hideHint(undefined)).toBe(undefined)
})

test('a turn.start hides now only when its text names a task or group other than the boundary\'s', async () => {
  const shown = AT(noteBoundary(START, ['T1']), [agent({ taskIds: ['T1'] })], 80)
  expect(shown.hint).toBe(NOW)
  const start = (text: string) => hintOnTurnStart({ text, plan: PLAN, prev: NOW, boundary: shown.boundary })
  expect(start('now do T2 please')).toBe(ARMED)
  expect(start('T1 again, but smaller')).toBe(NOW)
  expect(start('looks good, thanks')).toBe(NOW)
  expect(start('')).toBe(NOW)
  expect(hintOnTurnStart({ text: 'start T2', plan: PLAN, prev: ARMED, boundary: shown.boundary })).toBe(ARMED)
  expect(hintOnTurnStart({ text: 'start T2', plan: PLAN, prev: null, boundary: shown.boundary })).toBe(null)
  // no plan, no task to name
  expect(hintOnTurnStart({ text: 'start T2', plan: null, prev: NOW, boundary: shown.boundary })).toBe(NOW)
})

// ---------------------------------------------------------------- band line 3

const entry = (over: Partial<LogEntry>): LogEntry => ({ at: 0, kind: 'done', ref: 'R02-73', ...over })

test('line 3: ctx level and exact cost; the hint replaces the log slot only when now', async () => {
  const usage = { percent: 42, usd: 12.34, hint: null as const }
  const log = [entry({ role: 'implementer', durationMs: 252_000, estUsd: 0.42 })]
  const l = line3Data({ usage, threshold: 70, log })
  expect(l.ctx).toEqual({ percent: 42, level: 'ok' })
  expect(l.cost).toBe('$12.34')
  expect(l.log).toEqual({ kind: 'done', text: 'R02-73 implementer done 4m12s est.$0.42' })
  expect(l.hint).toBe(undefined)
  expect(line3Data({ usage: { ...usage, percent: 75, hint: ARMED }, threshold: 70, log }).hint).toBe(undefined)
  expect(line3Data({ usage: { ...usage, percent: 75, hint: ARMED }, threshold: 70, log }).ctx).toEqual({ percent: 75, level: 'warn' })
  const now = line3Data({ usage: { ...usage, percent: 75, hint: NOW }, threshold: 70, log })
  expect(now.hint).toBe('compact now: task boundary')
  expect(line3Data({ usage: { ...usage, percent: 93 }, threshold: 70, log }).ctx?.level).toBe('err')
})

test('line 3: cost n/a when the ledger is absent, nothing for ctx or cost before the first measure', async () => {
  const noCost = line3Data({ usage: { percent: 10, hint: null }, threshold: 70, log: [] })
  expect(noCost.cost).toBe('cost n/a')
  const none = line3Data({ usage: null, threshold: 70, log: [entry({ role: 'scout' })] })
  expect(none.ctx).toBe(undefined)
  expect(none.cost).toBe(undefined)
  expect(none.log).toBeDefined()
  const noPercent = line3Data({ usage: { usd: 1, hint: null }, threshold: 70, log: [] })
  expect(noPercent.ctx).toBe(undefined)
  expect(noPercent.cost).toBe('$1.00')
})

test('line 3: the newest log entry of each kind in one line', async () => {
  const t = (e: LogEntry) => line3Data({ usage: null, threshold: 70, log: [e] }).log
  expect(t(entry({ kind: 'failed', role: 'scout', detail: 'error' }))).toEqual({ kind: 'failed', text: 'R02-73 scout failed error' })
  expect(t(entry({ kind: 'blocked', role: 'implementer', detail: 'which toggle' }))).toEqual({ kind: 'blocked', text: 'R02-73 implementer BLOCKED which toggle' })
  expect(t(entry({ kind: 'stalled', role: 'scout', detail: 'no step for 10m' }))).toEqual({ kind: 'stalled', text: 'R02-73 scout stalled no step for 10m' })
  expect(t(entry({ kind: 'resumed', role: 'scout', detail: 'was done' }))).toEqual({ kind: 'info', text: 'R02-73 scout resumed' })
  expect(t(entry({ kind: 'warn', ref: 'R1', detail: 'Agent "x" (scout) has no explicit model' }))).toEqual({ kind: 'warn', text: 'R1 Agent "x" (scout) has no explicit model' })
  expect(t(entry({ kind: 'task-done', detail: 'landed (plan changed)' }))).toEqual({ kind: 'done', text: 'R02-73 landed (plan changed)' })
  expect(t(entry({ kind: 'pin', ref: '', detail: 'tracking tasks.md' }))).toEqual({ kind: 'info', text: 'tracking tasks.md' })
  // a done entry without a price shows no cost; an unassigned agent has no ref
  expect(t(entry({ role: 'hand', ref: '—', durationMs: 5000 }))).toEqual({ kind: 'done', text: '— hand done 5s' })
  expect(line3Data({ usage: null, threshold: 70, log: [] }).log).toBe(undefined)
})

test('line 3: a cost and an agent estimate under one cent read <$0.01', async () => {
  const l = line3Data({ usage: { percent: 1, usd: 0.003, hint: null }, threshold: 70, log: [entry({ role: 'hand', durationMs: 1000, estUsd: 0.0004 })] })
  expect(l.cost).toBe('<$0.01')
  expect(l.log?.text).toBe('R02-73 hand done 1s est.<$0.01')
})
