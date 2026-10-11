import { expect, test } from 'claude-code/testing'
import { addPlanned, bandCurrent, bindRun, buildTree, completeAgent, settleRestored, spawnAgent, stepEnd, stepStart, tick } from '../plugin/hooks/agents.ts'
import type { AgentRecord, LogEntry, Outcome, SpawnEvent } from '../plugin/hooks/agents.ts'
import { agentRows, DEFAULT_UI, logRows, rowText, usageRows } from '../plugin/hooks/pane.tsx'
import type { PaneData } from '../plugin/hooks/pane.tsx'
import { stateBlock } from '../plugin/hooks/tool.ts'
import { parsePlan } from '../plugin/hooks/plan.ts'
import type { Plan } from '../plugin/hooks/plan.ts'

// Agent lifecycle edges: records that outlive their process, runs that end with calls unspawned,
// retries the engine does not raise, and the merge of an early record into its spawn.
const MIN = 60_000

function small(text: string): Plan {
  const r = parsePlan(text, {})
  if (!r.ok) throw new Error(r.error)
  return r.plan
}
const PLAN = small('# P\n\n- [ ] T1 a\n- [ ] T2 b\n')
const USAGE = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' }

function spawnEv(over: Partial<SpawnEvent> = {}): SpawnEvent {
  return { at: 0, toolUseId: 'toolu_1', description: 'T1 do it', subagentType: 'acme:scout', prompt: 'x', agentId: 'ag1', model: 'claude-sonnet-5-5', ...over }
}

function run(steps: Array<(agents: AgentRecord[]) => Outcome>, start: AgentRecord[] = []) {
  let agents = start
  const log: LogEntry[] = []
  for (const s of steps) {
    const o = s(agents)
    agents = o.agents
    log.push(...o.log)
  }
  return { agents, log }
}

test('spawn merge: the cost an early step and completion priced is kept and carried into the done entry', async () => {
  const { agents, log } = run([
    (a) => stepStart(a, { at: 1000, agentId: 'ag1', model: 'claude-sonnet-5-5', effort: 'high' }),
    (a) => stepEnd(a, { at: 1500, agentId: 'ag1', usage: USAGE }),
    (a) => completeAgent(a, { at: 1600, agentId: 'ag1', reason: 'answer', answer: 'ok', durationMs: 600, usage: USAGE }),
  ])
  const early = agents[0].estUsd
  expect(early).toBeGreaterThan(0)
  const o = spawnAgent(agents, spawnEv({ at: 2000 }), { plan: PLAN })
  expect(o.agents.length).toBe(1)
  expect(o.agents[0].status).toBe('done')
  expect(o.agents[0].estUsd).toBe(early)
  expect(o.log[0]).toMatchObject({ kind: 'done', agentId: 'ag1', estUsd: early })
  expect(log.length).toBe(0)
})

const TOK = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
function rec(id: string, status: AgentRecord['status'], over: Partial<AgentRecord> = {}): AgentRecord {
  return { id, agentId: id, description: 'T2 build', subagentType: 'acme:implementer', taskIds: ['T2'], role: 'implementer', status, spawnedAt: 10, firstStepAt: 20, lastStepAt: 50, steps: 3, tokens: TOK, estUsd: 0.5, warnings: [], ...over }
}

test('restore: agents left queued, running or stalled by an earlier process are lost, logged once; finished ones stay', async () => {
  const saved = [
    rec('q', 'queued', { firstStepAt: undefined, lastStepAt: undefined }),
    rec('r', 'running'),
    rec('s', 'stalled', { stalledAt: 60 }),
    rec('b', 'blocked', { question: 'which', endedAt: 70 }),
    rec('d', 'done', { endedAt: 70 }),
    rec('f', 'failed', { reason: 'error', endedAt: 70 }),
    rec('p', 'queued', { provisional: true, description: '', role: '', taskIds: [] }),
  ]
  const o = settleRestored(saved, { at: 10 * MIN, aliveSince: 5 * MIN })
  expect(o.changed).toBe(true)
  expect(o.agents.map((a) => a.id + ':' + a.status)).toEqual(['q:lost', 'r:lost', 's:lost', 'b:blocked', 'd:done', 'f:failed'])
  expect(o.agents.find((a) => a.id === 's')?.stalledAt).toBe(undefined)
  expect(o.agents.find((a) => a.id === 'r')?.endedAt).toBe(50)
  expect(o.agents.find((a) => a.id === 'r')?.estUsd).toBe(0.5)
  expect(o.log.map((l) => l.kind + ' ' + l.agentId + ' ' + l.detail)).toEqual(['lost q (session restarted)', 'lost r (session restarted)', 'lost s (session restarted)'])
  // settling again changes nothing and logs nothing
  const again = settleRestored(o.agents, { at: 11 * MIN, aliveSince: 5 * MIN })
  expect(again.changed).toBe(false)
  expect(again.log).toEqual([])
})

test('restore: an agent active since this process started is still live and keeps its status', async () => {
  const o = settleRestored([rec('r', 'running', { lastStepAt: 6 * MIN })], { at: 10 * MIN, aliveSince: 5 * MIN })
  expect(o.changed).toBe(false)
  expect(o.agents[0].status).toBe('running')
})

test('restore: a lost agent is not the current task, never stalls, is not running in the marks, and a step reopens it', async () => {
  const lost = settleRestored([rec('r', 'running')], { at: 10 * MIN, aliveSince: 5 * MIN }).agents
  const done = rec('d', 'done', { taskIds: ['T1'], description: 'T1 x', spawnedAt: 5, endedAt: 9 })
  const cur = bandCurrent(PLAN, [done, ...lost])
  expect(cur.current?.id).toBe('T1')
  expect(cur.marks).toEqual({})
  expect(bandCurrent(PLAN, lost).current).toBe(undefined)
  expect(tick(lost, { at: 99 * MIN, stallMs: 10 * MIN, startMs: 2 * MIN }).changed).toBe(false)
  const task = buildTree(PLAN, lost, 10 * MIN).groups[0].tasks.find((t) => t.id === 'T2')
  expect(task?.status).toBe('queued')
  expect(task?.finished).toBe(1)
  const back = stepStart(lost, { at: 11 * MIN, agentId: 'r', model: 'claude-sonnet-5-5' })
  expect(back.agents[0].status).toBe('running')
  expect(back.log[0]).toMatchObject({ kind: 'resumed', detail: 'was lost' })
})

function paneData(agents: AgentRecord[], log: LogEntry[], ascii = false): PaneData {
  return { columns: 100, ascii, now: 10 * MIN, ui: { ...DEFAULT_UI }, goal: null, tree: buildTree(PLAN, agents, 10 * MIN), agents, log, usage: null, compactAt: 70 }
}

test('restore: the Agents and Log tabs draw a lost agent with its own glyph, unicode and ascii', async () => {
  const o = settleRestored([rec('r1r1r1r1', 'running')], { at: 10 * MIN, aliveSince: 5 * MIN })
  const row = agentRows(paneData(o.agents, o.log)).map(rowText).find((t) => t.includes('r1r1'))
  expect(row).toMatch(/◇\s+r1r1/)
  expect(row).toContain('lost')
  expect(logRows(paneData(o.agents, o.log)).map(rowText).join('\n')).toMatch(/◇ T2\s+implementer lost\s+\(session restarted\)/)
  expect(agentRows(paneData(o.agents, o.log, true)).map(rowText).find((t) => t.includes('r1r1'))).toMatch(/~\s+r1r1/)
})

// ---------------------------------------------------------------- runs that end with calls unspawned

const STALL = { stallMs: 10 * MIN, startMs: 2 * MIN }
const CALLS = [
  { ordinal: 1, label: 'T1 first', warnings: [] },
  { ordinal: 2, label: 'T2 second', warnings: [] },
]
const wfSpawn = (agentIndex: number, label: string, agentId: string, at: number, runId = 'wf_1', toolUseId = 'toolu_w') =>
  spawnEv({ at, toolUseId, description: label, subagentType: 'workflow-subagent', workflow: { runId, agentIndex }, agentId })

function planned(toolUseId = 'toolu_w', runId = 'wf_1', calls = CALLS, at = 0) {
  return bindRun(addPlanned([], { at, toolUseId, calls }, { plan: PLAN }).agents, toolUseId, runId).agents
}

test('run end: a planned call that never spawned is skipped once the run is quiet and all its agents are terminal', async () => {
  const { agents } = run([
    (a) => spawnAgent(a, wfSpawn(1, 'T1 first', 'x1', 1000), { plan: PLAN }),
    (a) => completeAgent(a, { at: 2000, agentId: 'x1', reason: 'answer', answer: 'ok', durationMs: 1000 }),
  ], planned())
  // 30 s after the last agent ended: a sequential script may still be about to spawn the next call
  const early = tick(agents, { at: 32_000, ...STALL })
  expect(early.agents.find((a) => a.id === 'wf:wf_1:2')?.skipped).toBe(undefined)
  const o = tick(agents, { at: 2000 + 60_000, ...STALL })
  expect(o.changed).toBe(true)
  expect(o.log).toEqual([])
  const left = o.agents.find((a) => a.id === 'wf:wf_1:2')
  expect(left).toMatchObject({ planned: true, skipped: true, status: 'queued' })
  // not counted in task bars or totals, and not drawn
  const tree = buildTree(PLAN, o.agents, 70_000)
  const t2 = tree.groups[0].tasks.find((t) => t.id === 'T2')
  expect(t2?.dispatched).toBe(0)
  expect(t2?.status).toBe('queued')
  expect(tree.groups[0].dispatched).toBe(1)
  expect(tree.unassigned.agents).toEqual([])
  // settled once
  expect(tick(o.agents, { at: 200_000, ...STALL }).changed).toBe(false)
})

test('run end: an unfinished agent of the run holds its planned calls; another run does not', async () => {
  const { agents } = run([(a) => spawnAgent(a, wfSpawn(1, 'T1 first', 'x1', 1000), { plan: PLAN }), (a) => stepStart(a, { at: 1500, agentId: 'x1', model: 'm' })], planned())
  const o = tick(agents, { at: 99 * MIN, ...STALL })
  expect(o.agents.find((a) => a.id === 'wf:wf_1:2')?.skipped).toBe(undefined)
})

test('run end: a spawn that arrives after all joins its skipped call', async () => {
  const { agents } = run([
    (a) => spawnAgent(a, wfSpawn(1, 'T1 first', 'x1', 1000), { plan: PLAN }),
    (a) => completeAgent(a, { at: 2000, agentId: 'x1', reason: 'answer', answer: 'ok', durationMs: 1000 }),
    (a) => tick(a, { at: 90_000, ...STALL }),
    (a) => spawnAgent(a, wfSpawn(2, 'T2 second', 'x2', 95_000), { plan: PLAN }),
  ], planned())
  expect(agents.map((a) => a.id)).toEqual(['x1', 'x2'])
  expect(agents[1].skipped).toBe(undefined)
  expect(agents[1].planned).toBe(undefined)
})

test('run end: a resumed run that reuses the run id drops the old leftovers before binding, so ids never collide', async () => {
  const first = run([
    (a) => spawnAgent(a, wfSpawn(1, 'T1 first', 'x1', 1000), { plan: PLAN }),
    (a) => completeAgent(a, { at: 2000, agentId: 'x1', reason: 'answer', answer: 'ok', durationMs: 1000 }),
    (a) => tick(a, { at: 90_000, ...STALL }),
  ], planned()).agents
  expect(first.filter((a) => a.id === 'wf:wf_1:2').length).toBe(1)
  // the resume: a new Workflow call, its own plan, the same run id
  const plan2 = addPlanned(first, { at: 100_000, toolUseId: 'toolu_r', calls: CALLS }, { plan: PLAN }).agents
  const bound = bindRun(plan2, 'toolu_r', 'wf_1').agents
  const ids = bound.map((a) => a.id)
  expect(ids).toEqual(['x1', 'wf:wf_1:1', 'wf:wf_1:2'])
  expect(new Set(ids).size).toBe(ids.length)
  expect(bound.filter((a) => a.planned).every((a) => a.toolUseId === 'toolu_r' && !a.skipped)).toBe(true)
  // its spawn joins the new plan's call
  const o = spawnAgent(bound, wfSpawn(2, 'T2 second', 'y2', 101_000, 'wf_1', 'toolu_r'), { plan: PLAN })
  expect(o.agents.filter((a) => a.planned).map((a) => a.id)).toEqual(['wf:wf_1:1'])
})

test('labelless calls join by agentIndex only when the script is ordered; otherwise they stay unjoined', async () => {
  const calls = [{ ordinal: 1, phase: 'P', warnings: [] }, { ordinal: 2, phase: 'Q', warnings: [] }]
  const ordered = planned('toolu_u', 'wf_u', calls)
  expect(spawnAgent(ordered, wfSpawn(2, 'harness name', 'u2', 5, 'wf_u', 'toolu_u'), { plan: null }).agents.find((a) => a.id === 'u2')?.phase).toBe('Q')
  const loose = planned('toolu_v', 'wf_v', calls.map((c) => ({ ...c, unordered: true })))
  const o = spawnAgent(loose, wfSpawn(2, 'harness name', 'v2', 5, 'wf_v', 'toolu_v'), { plan: null })
  expect(o.agents.find((a) => a.id === 'v2')?.phase).toBe(undefined)
  expect(o.agents.filter((a) => a.planned).length).toBe(2)
})

test('run end: a skipped call is in no tab and not in the state block', async () => {
  const { agents } = run([
    (a) => spawnAgent(a, wfSpawn(1, 'T1 first', 'x1x1', 1000), { plan: PLAN }),
    (a) => completeAgent(a, { at: 2000, agentId: 'x1x1', reason: 'answer', answer: 'ok', durationMs: 1000 }),
    (a) => tick(a, { at: 90_000, ...STALL }),
  ], planned())
  const rows = agentRows(paneData(agents, [])).map(rowText).join('\n')
  expect(rows).toContain('x1x1')
  expect(rows).not.toContain('wf:2')
  const block = stateBlock({ filter: null, report: null, goal: null, current: undefined, agents, log: [], usage: null, now: 100_000, logEntries: 10 })
  expect(block).toContain('x1x1')
  expect(block).not.toContain('T2 second')
})

// ---------------------------------------------------------------- retries the engine does not raise

test('retry: a completion no spawn claims is surfaced after 15 s, Unassigned, with its cost and its BLOCKED entry', async () => {
  const { agents } = run([
    (a) => stepStart(a, { at: 1000, agentId: 'r9', model: 'claude-sonnet-5-5' }),
    (a) => stepEnd(a, { at: 1500, agentId: 'r9', usage: USAGE }),
    (a) => completeAgent(a, { at: 2000, agentId: 'r9', reason: 'answer', answer: 'BLOCKED: need the slot order', durationMs: 1000 }),
  ])
  const soon = tick(agents, { at: 7000, ...STALL })
  expect(soon.agents[0].provisional).toBe(true)
  expect(soon.log).toEqual([])
  const o = tick(agents, { at: 17_000, ...STALL })
  expect(o.agents.length).toBe(1)
  expect(o.agents[0].provisional).toBe(undefined)
  expect(o.agents[0]).toMatchObject({ id: 'r9', status: 'blocked', question: 'need the slot order' })
  expect(o.agents[0].estUsd).toBeGreaterThan(0)
  expect(o.log).toEqual([{ at: 2000, kind: 'blocked', ref: '—', role: '', agentId: 'r9', detail: 'need the slot order' }])
  expect(buildTree(PLAN, o.agents, 20_000).unassigned.agents.map((a) => a.id)).toEqual(['r9'])
  // settled once
  expect(tick(o.agents, { at: 60_000, ...STALL }).log).toEqual([])
})

test('retry: the one stalled workflow agent adopts a surfaced retry, which takes its place; the original is settled', async () => {
  const stalled = run([
    (a) => spawnAgent(a, wfSpawn(1, 'T1 first', 'w1', 0), { plan: PLAN }),
    (a) => stepStart(a, { at: 1000, agentId: 'w1', model: 'claude-haiku-5-5' }),
    (a) => tick(a, { at: 11 * MIN, ...STALL }),
  ], planned()).agents
  expect(stalled.find((a) => a.id === 'w1')?.status).toBe('stalled')
  const { agents, log } = run([
    (a) => stepStart(a, { at: 12 * MIN, agentId: 'w1b', model: 'claude-haiku-5-5' }),
    (a) => stepEnd(a, { at: 12 * MIN + 500, agentId: 'w1b', usage: USAGE }),
    (a) => completeAgent(a, { at: 12 * MIN + 900, agentId: 'w1b', reason: 'answer', answer: 'ok', durationMs: 900 }),
    (a) => tick(a, { at: 13 * MIN, ...STALL }),
  ], stalled)
  const retry = agents.find((a) => a.id === 'w1b')
  expect(retry).toMatchObject({ status: 'done', label: 'T1 first', taskIds: ['T1'], runId: 'wf_1', agentIndex: 1, subagentType: 'workflow-subagent' })
  expect(retry?.provisional).toBe(undefined)
  expect(retry?.estUsd).toBeGreaterThan(0)
  expect(agents.find((a) => a.id === 'w1')).toMatchObject({ status: 'failed', reason: 'retried' })
  expect(log.map((l) => l.kind + ':' + l.agentId + ':' + (l.detail ?? ''))).toEqual(['failed:w1:retried', 'done:w1b:'])
  expect(log[1]).toMatchObject({ ref: 'T1', estUsd: retry?.estUsd })
})

test('retry: with two stalled workflow agents the retry stays unjoined', async () => {
  const stalled = run([
    (a) => spawnAgent(a, wfSpawn(1, 'T1 first', 'w1', 0), { plan: PLAN }),
    (a) => spawnAgent(a, wfSpawn(2, 'T2 second', 'w2', 0), { plan: PLAN }),
    (a) => tick(a, { at: 11 * MIN, ...STALL }),
  ], planned()).agents
  const { agents } = run([
    (a) => completeAgent(a, { at: 12 * MIN, agentId: 'w9', reason: 'answer', answer: 'ok', durationMs: 900 }),
    (a) => tick(a, { at: 13 * MIN, ...STALL }),
  ], stalled)
  expect(agents.find((a) => a.id === 'w9')).toMatchObject({ status: 'done', taskIds: [], subagentType: '' })
  expect(agents.find((a) => a.id === 'w9')?.provisional).toBe(undefined)
  expect(agents.filter((a) => a.status === 'stalled').length).toBe(2)
})

test('usage tab: a queued agent shows the alias its call asked for, as Agents and state do; a resolved model wins', async () => {
  const queued = rec('q1q1q1q1', 'queued', { model: undefined, requestedModel: 'haiku', effort: 'low', firstStepAt: undefined, lastStepAt: undefined })
  const resolved = rec('r2r2r2r2', 'running', { model: 'claude-opus-5-5', requestedModel: 'sonnet' })
  const rows = usageRows(paneData([queued, resolved], [])).map(rowText)
  expect(rows.find((r) => r.includes('q1q1'))).toMatch(/q1q1\s+implementer\s+haiku\s/)
  expect(rows.find((r) => r.includes('r2r2'))).toMatch(/r2r2\s+implementer\s+opus\s/)
})
