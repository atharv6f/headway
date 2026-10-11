import { expect, test } from 'claude-code/testing'
import { parsePlanMode } from '../hooks/planmode.ts'
import { modePlan } from '../hooks/sources.ts'
import {
  addPlanned,
  appendLog,
  bandCurrent,
  bindRun,
  buildTree,
  completeAgent,
  dropPlanned,
  familyOf,
  matchAgent,
  pinEntry,
  planFlips,
  reconcileList,
  roleOf,
  spawnAgent,
  stepEnd,
  stepStart,
  tick,
  unpinEntry,
} from '../hooks/agents.ts'
import type { AgentRecord, LogEntry, Outcome, SpawnEvent } from '../hooks/agents.ts'
import { parseGroupMap, parsePlan } from '../hooks/plan.ts'
import type { Plan } from '../hooks/plan.ts'
import { text as tasksText } from './fixtures/release-table.ts'
import { text as boardText } from './fixtures/release-groups.ts'

const MIN = 60_000
const STALL = { stallMs: 10 * MIN, startMs: 2 * MIN }

function rel2(): Plan {
  const gm = parseGroupMap(boardText)
  if (!gm.ok) throw new Error(gm.error)
  const r = parsePlan(tasksText, { section: 'Release 2 tasks', doneRule: 'column=landed', partial: 'published' }, gm.groups)
  if (!r.ok) throw new Error(r.error)
  return r.plan
}
const REL2 = rel2()

function small(text: string, opts: { partial?: string; doneRule?: string } = {}): Plan {
  const r = parsePlan(text, opts)
  if (!r.ok) throw new Error(r.error)
  return r.plan
}

let seq = 0
function spawnEv(over: Partial<SpawnEvent> = {}): SpawnEvent {
  seq++
  return {
    at: 0,
    toolUseId: 'toolu_' + seq,
    description: 'a task',
    subagentType: 'general-purpose',
    prompt: 'do the thing',
    agentId: 'a' + seq,
    model: 'claude-haiku-5-5',
    ...over,
  }
}

function only(o: Outcome, id: string): AgentRecord {
  const r = o.agents.find((a) => a.id === id)
  if (!r) throw new Error('no record ' + id)
  return r
}

// Runs a sequence of reducers, threading the agent list and collecting log entries.
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
const statusOf = (agents: AgentRecord[], id: string) => agents.find((a) => a.id === id)?.status

// ---------------------------------------------------------------- transitions

test('spawn queues, first step runs, an answer is done and logged with its task', async () => {
  const ev = spawnEv({ description: 'R02-73 case read', agentId: 'ag1', at: 1000 })
  let o = spawnAgent([], ev, { plan: REL2 })
  expect(only(o, 'ag1').status).toBe('queued')
  expect(only(o, 'ag1').taskIds).toEqual(['R02-73'])
  expect(o.log.length).toBe(0)
  o = stepStart(o.agents, { at: 2000, agentId: 'ag1', model: 'claude-haiku-5-5', effort: 'low' })
  expect(only(o, 'ag1').status).toBe('running')
  expect(only(o, 'ag1').effort).toBe('low')
  expect(only(o, 'ag1').firstStepAt).toBe(2000)
  o = stepEnd(o.agents, { at: 3000, agentId: 'ag1', usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 10, cache_creation_input_tokens: 29234, model: 'claude-haiku-5-5' } })
  expect(only(o, 'ag1').tokens).toEqual({ in: 2, out: 4, cacheRead: 10, cacheWrite: 29234 })
  o = completeAgent(o.agents, { at: 5000, agentId: 'ag1', reason: 'answer', answer: 'ok', durationMs: 4000 })
  const r = only(o, 'ag1')
  expect(r.status).toBe('done')
  expect(r.endedAt).toBe(5000)
  expect(r.durationMs).toBe(4000)
  expect(o.log.length).toBe(1)
  expect(o.log[0]).toMatchObject({ kind: 'done', ref: 'R02-73', agentId: 'ag1', durationMs: 4000 })
})

test('an answer with a BLOCKED line is blocked and logs the question', async () => {
  const ev = spawnEv({ agentId: 'b1', description: 'UI3 sweep half' })
  const { agents, log } = run([
    (a) => spawnAgent(a, ev, { plan: REL2 }),
    (a) => stepStart(a, { at: 10, agentId: 'b1', model: 'm' }),
    (a) => completeAgent(a, { at: 20, agentId: 'b1', reason: 'answer', answer: 'I read the file.\n  BLOCKED: which toggle placement holds the dark default', durationMs: 10 }),
  ])
  const r = agents.find((x) => x.id === 'b1') as AgentRecord
  expect(r.status).toBe('blocked')
  expect(r.question).toBe('which toggle placement holds the dark default')
  expect(log.map((l) => l.kind)).toEqual(['blocked'])
  expect(log[0]).toMatchObject({ ref: 'UI3', detail: 'which toggle placement holds the dark default' })
  // a completion or a tick changes nothing; only a new step (a SendMessage resume) reopens it
  const later = run([
    (a) => completeAgent(a, { at: 40, agentId: 'b1', reason: 'answer', answer: 'ok', durationMs: 5 }),
    (a) => tick(a, { at: 99 * MIN, ...STALL }),
  ], agents)
  expect(statusOf(later.agents, 'b1')).toBe('blocked')
  expect(later.log.length).toBe(0)
})

test('a step for a blocked agent reopens it to running and logs resumed', async () => {
  const ev = spawnEv({ agentId: 'rb', description: 'UI3 sweep half' })
  const { agents } = run([
    (a) => spawnAgent(a, ev, { plan: REL2 }),
    (a) => stepStart(a, { at: 10, agentId: 'rb', model: 'm' }),
    (a) => completeAgent(a, { at: 20, agentId: 'rb', reason: 'answer', answer: 'BLOCKED: which toggle', durationMs: 10 }),
  ])
  const o = stepStart(agents, { at: 30, agentId: 'rb', model: 'm' })
  const r = only(o, 'rb')
  expect(r.status).toBe('running')
  expect(r.question).toBe(undefined)
  expect(r.endedAt).toBe(undefined)
  expect(r.lastStepAt).toBe(30)
  expect(r.steps).toBe(2)
  expect(o.log).toEqual([{ at: 30, kind: 'resumed', ref: 'UI3', role: 'general-purpose', agentId: 'rb', detail: 'was blocked' }])
  // and it can finish again
  const d = completeAgent(o.agents, { at: 40, agentId: 'rb', reason: 'answer', answer: 'slot 3', durationMs: 10 })
  expect(only(d, 'rb').status).toBe('done')
  expect(d.log.map((l) => l.kind)).toEqual(['done'])
})

test('a step for a done or failed agent reopens it to running and logs resumed', async () => {
  for (const reason of ['answer', 'error'] as const) {
    const id = 'rd-' + reason
    const { agents } = run([
      (a) => spawnAgent(a, spawnEv({ agentId: id, description: 'R02-73 read' }), { plan: REL2 }),
      (a) => completeAgent(a, { at: 5, agentId: id, reason, answer: 'ok', durationMs: 5 }),
    ])
    expect(statusOf(agents, id)).toBe(reason === 'answer' ? 'done' : 'failed')
    const o = stepStart(agents, { at: 9, agentId: id, model: 'm' })
    expect(only(o, id).status).toBe('running')
    expect(only(o, id).reason).toBe(undefined)
    expect(o.log.map((l) => l.kind + ' ' + l.ref + ' ' + l.detail)).toEqual(['resumed R02-73 was ' + (reason === 'answer' ? 'done' : 'failed')])
  }
})

test('BLOCKED must start a line; a mention mid-line is a plain answer', async () => {
  const ev = spawnEv({ agentId: 'nb' })
  const { agents } = run([
    (a) => spawnAgent(a, ev, { plan: null }),
    (a) => completeAgent(a, { at: 1, agentId: 'nb', reason: 'answer', answer: 'Nothing is BLOCKED here; BLOCKEDNESS too.', durationMs: 1 }),
  ])
  expect(statusOf(agents, 'nb')).toBe('done')
})

test('error, refusal and aborted are failed with their reason', async () => {
  for (const reason of ['error', 'refusal', 'aborted'] as const) {
    const ev = spawnEv({ agentId: 'f-' + reason })
    const { agents, log } = run([
      (a) => spawnAgent(a, ev, { plan: null }),
      (a) => stepStart(a, { at: 1, agentId: 'f-' + reason, model: 'm' }),
      (a) => completeAgent(a, { at: 2, agentId: 'f-' + reason, reason, answer: '', durationMs: 1 }),
    ])
    const r = agents[0]
    expect(r.status).toBe('failed')
    expect(r.reason).toBe(reason)
    expect(log[0]).toMatchObject({ kind: 'failed', ref: '—', detail: reason })
  }
})

test('stall path 1: spawned and no step within startMinutes', async () => {
  const ev = spawnEv({ agentId: 's1', at: 0, description: 'API1 endpoint census' })
  let o = spawnAgent([], ev, { plan: REL2 })
  o = tick(o.agents, { at: 2 * MIN - 1, ...STALL })
  expect(only(o, 's1').status).toBe('queued')
  expect(o.changed).toBe(false)
  o = tick(o.agents, { at: 2 * MIN, ...STALL })
  expect(only(o, 's1').status).toBe('stalled')
  expect(o.changed).toBe(true)
  expect(o.log[0]).toMatchObject({ kind: 'stalled', ref: 'API1', detail: 'no step for 2m' })
  // a later tick neither re-logs nor reports a change
  o = tick(o.agents, { at: 3 * MIN, ...STALL })
  expect(o.changed).toBe(false)
  expect(o.log.length).toBe(0)
})

test('stall path 2: running and no step for stallMinutes', async () => {
  const ev = spawnEv({ agentId: 's2', at: 0 })
  let o = spawnAgent([], ev, { plan: null })
  o = stepStart(o.agents, { at: MIN, agentId: 's2', model: 'm' })
  o = tick(o.agents, { at: 5 * MIN, ...STALL })
  expect(only(o, 's2').status).toBe('running') // past startMinutes, but it has stepped
  o = stepEnd(o.agents, { at: 2 * MIN, agentId: 's2', usage: null })
  o = tick(o.agents, { at: 12 * MIN - 1, ...STALL })
  expect(only(o, 's2').status).toBe('running') // the step's end counts as activity
  o = tick(o.agents, { at: 12 * MIN, ...STALL })
  expect(only(o, 's2').status).toBe('stalled')
  expect(o.log[0]).toMatchObject({ kind: 'stalled', detail: 'no step for 10m' })
})

test('a step after a stall returns to running; a completion ends a stall', async () => {
  const a = spawnEv({ agentId: 'r1', at: 0 })
  const b = spawnEv({ agentId: 'r2', at: 0 })
  const { agents, log } = run([
    (x) => spawnAgent(x, a, { plan: null }),
    (x) => spawnAgent(x, b, { plan: null }),
    (x) => tick(x, { at: 3 * MIN, ...STALL }),
  ])
  expect(statusOf(agents, 'r1')).toBe('stalled')
  expect(statusOf(agents, 'r2')).toBe('stalled')
  expect(log.length).toBe(2)
  const after = run([
    (x) => stepStart(x, { at: 4 * MIN, agentId: 'r1', model: 'm' }),
    (x) => completeAgent(x, { at: 4 * MIN, agentId: 'r2', reason: 'answer', answer: 'ok', durationMs: 1 }),
  ], agents)
  expect(statusOf(after.agents, 'r1')).toBe('running')
  expect(statusOf(after.agents, 'r2')).toBe('done')
  // running again, it can stall again, and that is logged again
  const again = tick(after.agents, { at: 14 * MIN, ...STALL })
  expect(statusOf(again.agents, 'r1')).toBe('stalled')
  expect(again.log.map((l) => l.kind)).toEqual(['stalled'])
})

test('two agents interleaved: each event moves only its own agent', async () => {
  const a = spawnEv({ agentId: 'x1', description: 'R02-73 read', at: 0 })
  const b = spawnEv({ agentId: 'x2', description: 'API12 identity', at: 1 })
  const { agents, log } = run([
    (s) => spawnAgent(s, a, { plan: REL2 }),
    (s) => stepStart(s, { at: 2, agentId: 'x1', model: 'm', effort: 'high' }),
    (s) => spawnAgent(s, b, { plan: REL2 }),
    (s) => stepStart(s, { at: 3, agentId: 'x2', model: 'm', effort: 'low' }),
    (s) => stepEnd(s, { at: 4, agentId: 'x1', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' } }),
    (s) => completeAgent(s, { at: 5, agentId: 'x2', reason: 'answer', answer: 'BLOCKED: need input', durationMs: 4 }),
    (s) => stepStart(s, { at: 6, agentId: 'x1', model: 'm', effort: 'high' }),
    (s) => completeAgent(s, { at: 7, agentId: 'x1', reason: 'answer', answer: 'fine', durationMs: 7 }),
  ])
  const x1 = agents.find((r) => r.id === 'x1') as AgentRecord
  const x2 = agents.find((r) => r.id === 'x2') as AgentRecord
  expect(x1.status).toBe('done')
  expect(x1.steps).toBe(2)
  expect(x1.effort).toBe('high')
  expect(x2.status).toBe('blocked')
  expect(x2.steps).toBe(1)
  expect(x2.effort).toBe('low')
  expect(x2.groupId).toBe('API12')
  expect(log.map((l) => l.kind + ':' + l.agentId)).toEqual(['blocked:x2', 'done:x1'])
})

test('a step or completion that arrives before its spawn is kept and joined to it', async () => {
  // The spawn hook writes after next(e) resolves; the subagent may already be stepping.
  let o = stepStart([], { at: 5, agentId: 'early', model: 'claude-haiku-5-5', effort: 'low' })
  expect(o.agents.length).toBe(1)
  expect(o.agents[0].provisional).toBe(true)
  o = spawnAgent(o.agents, spawnEv({ agentId: 'early', at: 6, description: 'R02-73 read' }), { plan: REL2 })
  expect(o.agents.length).toBe(1)
  const r = o.agents[0]
  expect(r.provisional).toBe(undefined)
  expect(r.status).toBe('running')
  expect(r.steps).toBe(1)
  expect(r.taskIds).toEqual(['R02-73'])
  expect(r.spawnedAt).toBe(5)

  // a completion that beat the spawn is logged once the spawn names the agent
  let p = completeAgent([], { at: 9, agentId: 'fast', reason: 'answer', answer: 'ok', durationMs: 3 })
  expect(p.log.length).toBe(0)
  p = spawnAgent(p.agents, spawnEv({ agentId: 'fast', at: 10, description: 'API1 list' }), { plan: REL2 })
  expect(p.agents[0].status).toBe('done')
  expect(p.log[0]).toMatchObject({ kind: 'done', ref: 'API1', agentId: 'fast' })
})

test('a provisional record nobody spawns is dropped, never stalled', async () => {
  let o = stepStart([], { at: 0, agentId: 'ghost', model: 'm' })
  o = tick(o.agents, { at: MIN, ...STALL })
  expect(o.agents.length).toBe(1)
  expect(o.log.length).toBe(0)
  o = tick(o.agents, { at: 3 * MIN, ...STALL })
  expect(o.agents.length).toBe(0)
  expect(o.changed).toBe(true)
  expect(o.log.length).toBe(0)
})

test('a denied spawn is not recorded', async () => {
  const o = spawnAgent([], { ...spawnEv(), agentId: undefined, deny: 'no' }, { plan: null })
  expect(o.agents.length).toBe(0)
  expect(o.changed).toBe(false)
})

test('$.agent.list failed or killed fails the agent and fills its name', async () => {
  const ev = spawnEv({ agentId: 'k1' })
  const ev2 = spawnEv({ agentId: 'k2' })
  let o = run([(a) => spawnAgent(a, ev, { plan: null }), (a) => spawnAgent(a, ev2, { plan: null })])
  const r = reconcileList(o.agents, [
    { id: 'k1', status: 'killed', name: 'toggle-web' },
    { id: 'k2', status: 'running', name: 'scout-2' },
    { id: 'zz', status: 'failed' },
  ], 50)
  expect(statusOf(r.agents, 'k1')).toBe('failed')
  expect(r.agents.find((a) => a.id === 'k1')?.reason).toBe('killed')
  expect(statusOf(r.agents, 'k2')).toBe('queued')
  expect(r.agents.find((a) => a.id === 'k2')?.name).toBe('scout-2')
  expect(r.log.map((l) => l.kind)).toEqual(['failed'])
  expect(r.changed).toBe(true)
  const again = reconcileList(r.agents, [{ id: 'k1', status: 'killed' }, { id: 'k2', status: 'running', name: 'scout-2' }], 60)
  expect(again.changed).toBe(false)
})

// ---------------------------------------------------------------- workflow agents

test('a workflow agent is recorded from agent.spawn: label, run and index, id from next(e)', async () => {
  const o = spawnAgent([], spawnEv({
    toolUseId: 'toolu_wf',
    description: 'R02-73 case read',
    subagentType: 'workflow-subagent',
    workflow: { runId: 'wf_240ee13f-5ab', agentIndex: 2 },
    agentId: 'aa1cb73e7de0a0378',
    requestedModel: 'haiku',
    model: 'claude-haiku-5-5',
  }), { plan: REL2 })
  const r = only(o, 'aa1cb73e7de0a0378')
  expect(r).toMatchObject({ runId: 'wf_240ee13f-5ab', agentIndex: 2, label: 'R02-73 case read', role: 'workflow-subagent', requestedModel: 'haiku', model: 'claude-haiku-5-5', status: 'queued', taskIds: ['R02-73'], groupId: 'UI3' })
})

test('a workflow agent finishing logs its label beside the role; a normal agent logs the role alone', async () => {
  let o = spawnAgent([], spawnEv({ description: 'R02-73 case read', subagentType: 'workflow-subagent', workflow: { runId: 'wf_l', agentIndex: 1 }, agentId: 'l1' }), { plan: REL2 })
  o = completeAgent(o.agents, { at: 5000, agentId: 'l1', reason: 'answer', answer: 'ok', durationMs: 4000 })
  expect(o.log[0]).toMatchObject({ kind: 'done', role: 'workflow-subagent', label: 'R02-73 case read' })
  let n = spawnAgent([], spawnEv({ description: 'R02-73 case read', subagentType: 'acme:scout', agentId: 'n1' }), { plan: REL2 })
  n = completeAgent(n.agents, { at: 5000, agentId: 'n1', reason: 'answer', answer: 'ok', durationMs: 4000 })
  expect(n.log[0].role).toBe('scout')
  expect(n.log[0].label).toBeUndefined()
})

test('a workflow agent without an agentId gets wf:<runId>:<index>, not the shared tool_use_id', async () => {
  const run1 = { runId: 'wf_r', agentIndex: 1 }
  const run2 = { runId: 'wf_r', agentIndex: 2 }
  let o = spawnAgent([], spawnEv({ toolUseId: 'toolu_same', workflow: run1, agentId: undefined, subagentType: 'workflow-subagent' }), { plan: null })
  o = spawnAgent(o.agents, spawnEv({ toolUseId: 'toolu_same', workflow: run2, agentId: undefined, subagentType: 'workflow-subagent' }), { plan: null })
  expect(o.agents.map((a) => a.id)).toEqual(['wf:wf_r:1', 'wf:wf_r:2'])
})

test('the join: a planned call of the same run whose label matches gives phase, model and effort', async () => {
  // Planned records are M5's (workflow.ts); this is the shape the join reads.
  const planned = (ordinal: number, label: string, phase: string): AgentRecord => ({
    id: 'wf:wf_j:' + ordinal, planned: true, runId: 'wf_j', agentIndex: ordinal, label, phase,
    description: label, subagentType: 'workflow-subagent', role: 'workflow-subagent', taskIds: [],
    requestedModel: 'haiku', effort: 'low', status: 'queued', spawnedAt: 0, steps: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, estUsd: 0, warnings: [],
  })
  const start = [planned(1, 'scan *', 'Build'), planned(2, 'scan *', 'Verify'), planned(3, 'R02-73 case read', 'Verify')]
  let o = spawnAgent(start, spawnEv({ description: 'scan API1', workflow: { runId: 'wf_j', agentIndex: 2 }, agentId: 'j2', subagentType: 'workflow-subagent' }), { plan: REL2 })
  expect(o.agents.length).toBe(3)
  const j2 = only(o, 'j2')
  expect(j2.phase).toBe('Verify') // agentIndex broke the tie between the two `scan *` calls
  expect(j2.planned).toBe(undefined)
  expect(j2.groupId).toBe('API1')
  o = spawnAgent(o.agents, spawnEv({ description: 'R02-73 case read', workflow: { runId: 'wf_j', agentIndex: 3 }, agentId: 'j3', subagentType: 'workflow-subagent' }), { plan: REL2 })
  expect(only(o, 'j3')).toMatchObject({ phase: 'Verify', requestedModel: 'haiku', taskIds: ['R02-73'] })
  // another run's spawn never takes this run's planned call
  o = spawnAgent(o.agents, spawnEv({ description: 'scan UI3', workflow: { runId: 'wf_other', agentIndex: 1 }, agentId: 'o1', subagentType: 'workflow-subagent' }), { plan: REL2 })
  expect(o.agents.filter((a) => a.planned).length).toBe(1)
  expect(only(o, 'o1').phase).toBe(undefined)
  // planned calls are never stalled by the start timeout: they were not spawned
  const t = tick(o.agents, { at: 99 * MIN, ...STALL })
  expect(t.agents.find((a) => a.planned)?.status).toBe('queued')
})

test('a workflow label that names nothing falls back to its phase', async () => {
  const planned: AgentRecord = {
    id: 'wf:wf_p:1', planned: true, runId: 'wf_p', agentIndex: 1, label: 'census', phase: 'API-CORE',
    description: 'census', subagentType: 'workflow-subagent', role: 'workflow-subagent', taskIds: [],
    status: 'queued', spawnedAt: 0, steps: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, estUsd: 0, warnings: [],
  }
  const o = spawnAgent([planned], spawnEv({ description: 'census', prompt: 'list things', workflow: { runId: 'wf_p', agentIndex: 1 }, agentId: 'p1' }), { plan: REL2 })
  expect(only(o, 'p1').groupId).toBe('API-CORE')
})

// ---------------------------------------------------------------- ID matching (4.3)

test('a description naming a group id lands on the group; one naming a task id on the task and its group', async () => {
  expect(matchAgent(REL2, ['API1 endpoint census'])).toEqual({ taskIds: [], groupId: 'API1' })
  expect(matchAgent(REL2, ['R02-73 case read'])).toEqual({ taskIds: ['R02-73'], groupId: 'UI3' })
})

test('longest id wins: API12 is not taken by API1, API-CORE not by PY, R02-73 is whole', async () => {
  expect(matchAgent(REL2, ['API12 identity']).groupId).toBe('API12')
  expect(matchAgent(REL2, ['after API1, do API12']).groupId).toBe('API12')
  expect(matchAgent(REL2, ['API-CORE census']).groupId).toBe('API-CORE')
  expect(matchAgent(REL2, ['R02-730 is not a row'])).toEqual({ taskIds: [] })
  expect(matchAgent(REL2, ['xR02-73'])).toEqual({ taskIds: [] })
  // dotted ids are where length order decides on its own
  const dotted = small('| id | title |\n|---|---|\n| A.1 | one |\n| A.1.2 | two |\n')
  expect(matchAgent(dotted, ['work on A.1.2 today']).taskIds).toEqual(['A.1.2'])
  expect(matchAgent(dotted, ['work on A.1 today']).taskIds).toEqual(['A.1'])
})

test('a heading-text id (no digit) matches in any case only in the name, description and label; in the prompt, and for an id with a digit, the case must match', async () => {
  const plan = modePlan(parsePlanMode('# Plan: P\n\n## Set up\n- a\n- b\n\n## Docs\n- c\n- d\n'))
  expect(plan.tasks.map((t) => t.id)).toEqual(['Set up', 'Docs'])
  const ctx = { plan }
  const spawn = (o: Partial<SpawnEvent>) => spawnAgent([], { at: 1, toolUseId: 'tu', description: 'helper', prompt: 'go', ...o } as SpawnEvent, ctx).agents[0].taskIds
  expect(spawn({ description: 'write the docs' })).toEqual(['Docs'])
  expect(spawn({ name: 'SET UP the repo' })).toEqual(['Set up'])
  expect(spawn({ description: 'x', workflow: { runId: 'wf_1', agentIndex: 0 } , name: undefined, prompt: 'go' })).toEqual([])
  expect(spawnAgent([], { at: 1, toolUseId: 'tu', description: 'the docs pass', workflow: { runId: 'wf_1', agentIndex: 0 } } as SpawnEvent, ctx).agents[0].taskIds).toEqual(['Docs'])
  // the prompt keeps the case-sensitive rule: "read the docs in src" names no step, "Docs" does
  expect(spawn({ prompt: 'read the docs in src and set up nothing' })).toEqual([])
  expect(spawn({ prompt: 'finish Docs today' })).toEqual(['Docs'])
  // whole words still: no id inside a longer word
  expect(spawn({ description: 'undocsed and setups' })).toEqual([])
  // a bare text list (a turn's text for the compact hint) is case-sensitive
  expect(matchAgent(plan, ['write the docs']).taskIds).toEqual([])
  expect(matchAgent(plan, ['write the Docs']).taskIds).toEqual(['Docs'])
  // an id with a digit is case-sensitive everywhere, the description included
  expect(spawnAgent([], { at: 1, toolUseId: 'tu', description: 'api1 census' } as SpawnEvent, { plan: REL2 }).agents[0].groupId).toBe(undefined)
  expect(matchAgent(REL2, ['api1 census'])).toEqual({ taskIds: [] })
})

test('a step whose id cleans to nothing takes its ordinal; an empty id never matches a text', async () => {
  const p = parsePlanMode('# Plan: Z\n\n## \u200b\n- a\n- b\n\n## Build\n- c\n')
  expect(p.steps.map((s) => s.id)).toEqual(['1', 'Build'])
  const plan = modePlan(p)
  expect(matchAgent(plan, ['a b. c', 'x, y', '']).taskIds).toEqual([])
  // a plan holding an empty task id and an empty group id (built by hand) still matches nothing loose
  const bad = { ...plan, tasks: [{ ...plan.tasks[0], id: '' }], groups: [{ ...plan.groups[0], id: '' }] }
  expect(matchAgent(bad, ['a b. c', 'x, y'])).toEqual({ taskIds: [] })
  expect(spawnAgent([], { at: 1, toolUseId: 'tu', description: 'one, two. three' } as SpawnEvent, { plan: bad }).agents[0].taskIds).toEqual([])
})

test('task ids are tried before group ids within one text; texts are tried in order', async () => {
  expect(matchAgent(REL2, ['UI3 work on R02-41'])).toEqual({ taskIds: ['R02-41'], groupId: 'UI3' })
  // the description names a group, the prompt a task: the first text with a match wins
  expect(matchAgent(REL2, ['API1 census', 'see R02-73'])).toEqual({ taskIds: [], groupId: 'API1' })
  // the name is searched first
  expect(matchAgent(REL2, ['R02-41', 'R02-73 read'])).toMatchObject({ taskIds: ['R02-41'] })
  expect(matchAgent(REL2, ['', 'nothing here', ''])).toEqual({ taskIds: [] })
  // case-sensitive
  expect(matchAgent(REL2, ['api1 census'])).toEqual({ taskIds: [] })
})

test('a task in overlapping groups takes the longer group id the text names', async () => {
  const plan = small('| id | title |\n|---|---|\n| X1 | one |\n')
  const mapped = parsePlan('| id | title |\n|---|---|\n| X1 | one |\n', {}, [{ id: 'G.1', rows: ['X1'] }, { id: 'G.1.2', rows: ['X1'] }])
  if (!mapped.ok) throw new Error(mapped.error)
  expect(plan.tasks.length).toBe(1)
  expect(matchAgent(mapped.plan, ['X1 under G.1.2'])).toEqual({ taskIds: ['X1'], groupId: 'G.1.2' })
  expect(matchAgent(mapped.plan, ['X1 under G.1'])).toEqual({ taskIds: ['X1'], groupId: 'G.1' })
})

test('a repeated task id is resolved by a group id in the same text, else its first occurrence', async () => {
  const text = '## Plan\n### Task 1: one\n- [ ] **Step 1:** a\n- [ ] **Step 2:** b\n### Task 2: two\n- [ ] **Step 1:** c\n'
  const plan = small(text)
  expect(matchAgent(plan, ['Step 1 of Task 2'])).toEqual({ taskIds: ['Step 1'], groupId: 'Task 2' })
  expect(matchAgent(plan, ['Step 1 again'])).toEqual({ taskIds: ['Step 1'], groupId: 'Task 1' })
})

test('the spawn searches name, description, prompt head, then label and phase', async () => {
  const long = 'x'.repeat(2000) + ' R02-73'
  const o = spawnAgent([], spawnEv({ agentId: 'm1', description: 'nothing', prompt: long }), { plan: REL2 })
  expect(only(o, 'm1').taskIds).toEqual([]) // past the first 2000 characters of the prompt
  const p = spawnAgent([], spawnEv({ agentId: 'm2', name: 'API12_worker', description: 'R02-73 read' }), { plan: REL2 })
  expect(only(p, 'm2')).toMatchObject({ groupId: 'API12', taskIds: [], name: 'API12_worker' })
  // `-` is a word character for the boundary, so a name like API12-worker names nothing
  expect(matchAgent(REL2, ['API12-worker'])).toEqual({ taskIds: [] })
})

test('no plan pinned, or no match: the Agent-tool agent goes under Agents', async () => {
  const o = spawnAgent([], spawnEv({ agentId: 'n1', description: 'R02-73 read' }), { plan: null })
  expect(only(o, 'n1').taskIds).toEqual([])
  expect(only(o, 'n1').groupId).toBe(undefined)
  const tree = buildTree(REL2, spawnAgent([], spawnEv({ agentId: 'n2', description: 'no id at all' }), { plan: REL2 }).agents)
  expect(tree.unassigned.agents).toEqual([])
  expect(tree.groups.find((g) => g.id === 'agents')?.agents.map((a) => a.id)).toEqual(['n2'])
})

// ---------------------------------------------------------------- role and model (4.4)

test('role is the last segment of subagentType, lower-cased; family is the first known name', async () => {
  expect(roleOf('acme:scout')).toBe('scout')
  expect(roleOf('Plugin:Sub:Implementer')).toBe('implementer')
  expect(roleOf('general-purpose')).toBe('general-purpose')
  expect(familyOf('claude-haiku-5-5')).toBe('haiku')
  expect(familyOf('Opus')).toBe('opus')
  expect(familyOf('fable-sonnet')).toBe('fable')
  expect(familyOf('gpt-x')).toBe('unknown')
  expect(familyOf(undefined)).toBe('unknown')
})

test('model is the resolved one from the spawn, then the step; the alias is kept apart', async () => {
  let o = spawnAgent([], spawnEv({ agentId: 'md', requestedModel: 'haiku', model: 'claude-haiku-5-5', subagentType: 'acme:scout' }), { plan: null })
  expect(only(o, 'md')).toMatchObject({ role: 'scout', requestedModel: 'haiku', model: 'claude-haiku-5-5' })
  o = stepStart(o.agents, { at: 1, agentId: 'md', model: 'claude-haiku-5-5-20261001', effort: 3 })
  expect(only(o, 'md')).toMatchObject({ model: 'claude-haiku-5-5-20261001', effort: '3' })
})

test('tokens come from turn.complete usage when no step reported any', async () => {
  const usage = { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8, model: 'm' }
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'tk' }), { plan: null }),
    (a) => completeAgent(a, { at: 1, agentId: 'tk', reason: 'answer', answer: 'ok', durationMs: 1, usage }),
  ])
  expect(agents[0].tokens).toEqual({ in: 5, out: 6, cacheRead: 7, cacheWrite: 8 })
})

// ---------------------------------------------------------------- est. cost (M6)

const M = 1_000_000
const close = (actual: number, expected: number) => expect(actual.toFixed(9)).toBe(expected.toFixed(9))
// one million input and one million output tokens on sonnet-5-5: 2 + 10 dollars
const SONNET_M = { input_tokens: M, output_tokens: M, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' }

test('each step prices its own usage and the agent sums them', async () => {
  const { agents, log } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'c1', model: 'claude-sonnet-5-5' }), { plan: null }),
    (a) => stepStart(a, { at: 1, agentId: 'c1', model: 'claude-sonnet-5-5' }),
    (a) => stepEnd(a, { at: 2, agentId: 'c1', usage: SONNET_M }),
    (a) => stepEnd(a, { at: 3, agentId: 'c1', usage: { ...SONNET_M, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M } }),
  ])
  expect(log).toEqual([])
  close(agents[0].estUsd, 12 + 0.2)
})

test('a turn.complete usage after steps is not counted twice, in tokens or in dollars', async () => {
  const { agents, log } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'c2', model: 'claude-sonnet-5-5' }), { plan: null }),
    (a) => stepStart(a, { at: 1, agentId: 'c2' }),
    (a) => stepEnd(a, { at: 2, agentId: 'c2', usage: SONNET_M }),
    (a) => completeAgent(a, { at: 3, agentId: 'c2', reason: 'answer', answer: 'ok', durationMs: 2, usage: SONNET_M }),
  ])
  expect(agents[0].tokens).toEqual({ in: M, out: M, cacheRead: 0, cacheWrite: 0 })
  close(agents[0].estUsd, 12)
  expect(log[0]).toMatchObject({ kind: 'done', estUsd: agents[0].estUsd })
})

test('a turn.complete usage with no step before it is priced once and carried into the done entry', async () => {
  const { agents, log } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'k3', model: 'claude-sonnet-5-5' }), { plan: null }),
    (a) => completeAgent(a, { at: 3, agentId: 'k3', reason: 'answer', answer: 'ok', durationMs: 2, usage: SONNET_M }),
  ])
  close(agents[0].estUsd, 12)
  close(log[0].estUsd ?? -1, 12)
})

test('a resumed agent keeps its dollars and adds the new steps; the second complete adds nothing', async () => {
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'c4', model: 'claude-sonnet-5-5' }), { plan: null }),
    (a) => stepStart(a, { at: 1, agentId: 'c4' }),
    (a) => stepEnd(a, { at: 2, agentId: 'c4', usage: SONNET_M }),
    (a) => completeAgent(a, { at: 3, agentId: 'c4', reason: 'answer', answer: 'BLOCKED: which', durationMs: 2, usage: SONNET_M }),
    (a) => stepStart(a, { at: 4, agentId: 'c4' }),
    (a) => stepEnd(a, { at: 5, agentId: 'c4', usage: SONNET_M }),
    (a) => completeAgent(a, { at: 6, agentId: 'c4', reason: 'answer', answer: 'ok', durationMs: 2, usage: SONNET_M }),
  ])
  close(agents[0].estUsd, 24)
})

test('a step with no usage prices nothing; an unknown model prices at the sonnet row', async () => {
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'c5' }), { plan: null }),
    (a) => stepStart(a, { at: 1, agentId: 'c5' }),
    (a) => stepEnd(a, { at: 2, agentId: 'c5', usage: null }),
  ])
  expect(agents[0].estUsd).toBe(0)
  const u = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'c6' }), { plan: null }),
    (a) => stepEnd(a, { at: 2, agentId: 'c6', usage: { ...SONNET_M, model: 'claude-newthing-9' } }),
  ])
  close(u.agents[0].estUsd, 12)
})

test('haiku-5-5 is priced per step: a step over 100K prompt tokens takes the long rates, the next small one does not', async () => {
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'c7' }), { plan: null }),
    (a) => stepEnd(a, { at: 1, agentId: 'c7', usage: { input_tokens: 150_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' } }),
    (a) => stepEnd(a, { at: 2, agentId: 'c7', usage: { input_tokens: 50_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' } }),
  ])
  close(agents[0].estUsd, 150_000 * 0.5 / M + 50_000 * 0.1 / M)
})

// ---------------------------------------------------------------- log

const FLIP_A = '| task | title | landed | published |\n|---|---|---|---|\n| T1 | one | — | — |\n| T2 | two | — | — |\n| T3 | three | yes | — |\n| T4 | four | — | yes |\n'
const FLIP_B = '| task | title | landed | published |\n|---|---|---|---|\n| T1 | one | yes | — |\n| T2 | two | — | yes |\n| T3 | three | — | — |\n| T4 | four | — | yes |\n'

test('a plan change logs each task flipped done, to partial, or reopened', async () => {
  const opts = { doneRule: 'column=landed', partial: 'published' }
  const entries = planFlips(small(FLIP_A, opts), small(FLIP_B, opts), 100)
  expect(entries.map((e) => e.kind + ' ' + e.ref + ' ' + e.detail)).toEqual([
    'task-done T1 landed (plan changed)',
    'task-partial T2 published (plan changed)',
    'task-reopened T3 reopened (plan changed)',
  ])
  expect(planFlips(small(FLIP_A, opts), small(FLIP_A, opts), 100)).toEqual([])
})

test('a flip on the real Release 2 plan: the R02-73 row published', async () => {
  const lines = tasksText.split('\n')
  const i = lines.findIndex((l) => l.startsWith('| R02-73 |'))
  // set the row's published cell, found by the header's column position
  const header = lines.slice(0, i).reverse().find((l) => l.startsWith('| task')) as string
  const cols = header.split('|').map((c) => c.trim().toLowerCase())
  const row = lines[i].split('|')
  row[cols.indexOf('published')] = ' 2026-10-10 '
  const changed = [...lines.slice(0, i), row.join('|'), ...lines.slice(i + 1)].join('\n')
  const gm = parseGroupMap(boardText)
  if (!gm.ok) throw new Error(gm.error)
  const r = parsePlan(changed, { section: 'Release 2 tasks', doneRule: 'column=landed', partial: 'published' }, gm.groups)
  if (!r.ok) throw new Error(r.error)
  const entries = planFlips(REL2, r.plan, 5)
  const wasPublished = REL2.tasks.find((t) => t.id === 'R02-73')?.status === 'partial'
  expect(entries.map((e) => e.kind + ' ' + e.ref)).toEqual(wasPublished ? [] : ['task-partial R02-73'])
})

test('repeated ids are compared occurrence by occurrence', async () => {
  const a = small('### Task 1: a\n- [ ] **Step 1:** x\n### Task 2: b\n- [ ] **Step 1:** y\n')
  const b = small('### Task 1: a\n- [ ] **Step 1:** x\n### Task 2: b\n- [x] **Step 1:** y\n')
  const e = planFlips(a, b, 1)
  expect(e.length).toBe(1)
  expect(e[0]).toMatchObject({ kind: 'task-done', ref: 'Step 1', detail: 'done (plan changed)' })
})

test('pin and unpin entries; the log keeps 200, newest first', async () => {
  const pin = pinEntry({ file: '/x/plan/release-table.md', section: 'Release 2 tasks', doneRule: 'column=landed' }, 7)
  expect(pin).toMatchObject({ kind: 'pin', at: 7, detail: 'tracking release-table.md § Release 2 tasks  column=landed' })
  expect(pinEntry({ file: 'p.md', doneRule: 'auto' }, 1).detail).toBe('tracking p.md')
  expect(unpinEntry(8)).toMatchObject({ kind: 'unpin', detail: 'untracked' })
  let log: LogEntry[] = []
  for (let i = 0; i < 205; i++) log = appendLog(log, [{ at: i, kind: 'done', ref: 'T' + i }])
  expect(log.length).toBe(200)
  expect(log[0].at).toBe(204)
  expect(log[199].at).toBe(5)
  // several entries from one event: the last one is the newest
  const two = appendLog([], [{ at: 1, kind: 'done', ref: 'A' }, { at: 1, kind: 'blocked', ref: 'B' }])
  expect(two.map((e) => e.ref)).toEqual(['B', 'A'])
})

// ---------------------------------------------------------------- Plan tree (8.2)

const TREE_PLAN = [
  '## Plan',
  '### G1: first',
  '| task | title | landed | published |',
  '|---|---|---|---|',
  '| A1 | done one | yes | — |',
  '| A2 | queued one | — | — |',
  '| A3 | partial one | — | yes |',
  '| A4 | active one | — | — |',
  '### G2: second',
  '| task | title | landed | published |',
  '|---|---|---|---|',
  '| B1 | queued | — | — |',
  '### G3: third',
  '| task | title | landed | published |',
  '|---|---|---|---|',
  '| UI1 | done | yes | — |',
  '### G4: fourth',
  '| task | title | landed | published |',
  '|---|---|---|---|',
  '| D1 | partial | — | yes |',
  '| D2 | queued | — | — |',
  '### G5: fifth',
  '| task | title | landed | published |',
  '|---|---|---|---|',
  '| E1 | queued | — | — |',
].join('\n')

test('the tree nests groups, tasks and agents and sorts active, partial, queued, done', async () => {
  const plan = small(TREE_PLAN, { doneRule: 'column=landed', partial: 'published' })
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'w1', description: 'A4 work', at: 1 }), { plan }),
    (a) => spawnAgent(a, spawnEv({ agentId: 'w2', description: 'A4 more', at: 2 }), { plan }),
    (a) => completeAgent(a, { at: 3, agentId: 'w2', reason: 'answer', answer: 'ok', durationMs: 1 }),
    (a) => spawnAgent(a, spawnEv({ agentId: 'g1', description: 'G1 overview', at: 4 }), { plan }),
    (a) => spawnAgent(a, spawnEv({ agentId: 'c1', description: 'UI1 recheck', at: 5 }), { plan }),
  ])
  const tree = buildTree(plan, agents)
  expect(tree.groups.map((g) => g.id + ':' + g.status)).toEqual(['G1:active', 'G4:partial', 'G2:queued', 'G5:queued', 'G3:done'])
  const g1 = tree.groups[0]
  expect(g1.tasks.map((t) => t.id + ':' + t.status)).toEqual(['A4:active', 'A3:partial', 'A2:queued', 'A1:done'])
  expect(g1.agents.map((a) => a.id)).toEqual(['g1'])
  expect(g1.tasks[0].agents.map((a) => a.id)).toEqual(['w1', 'w2'])
  expect(g1.tasks[0]).toMatchObject({ finished: 1, dispatched: 2 })
  expect(g1).toMatchObject({ finished: 1, dispatched: 3, tasksDone: 1, tasksTotal: 4 })
  expect(g1.tasks[1].partialWord).toBe('published')
  // a done task with an agent still running stays done (the done rule comes first)
  const g3 = tree.groups[4]
  expect(g3.tasks[0]).toMatchObject({ id: 'UI1', status: 'done', dispatched: 1, finished: 0 })
})

test('a blocked or stalled agent sorts its group, task and row to the top', async () => {
  const plan = small(TREE_PLAN, { doneRule: 'column=landed', partial: 'published' })
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'q1', description: 'A4 run', at: 0 }), { plan }),
    (a) => stepStart(a, { at: 0, agentId: 'q1', model: 'm' }),
    (a) => spawnAgent(a, spawnEv({ agentId: 'q2', description: 'E1 run', at: 0 }), { plan }),
    (a) => spawnAgent(a, spawnEv({ agentId: 'q3', description: 'E1 other', at: 0 }), { plan }),
    (a) => stepStart(a, { at: 0, agentId: 'q3', model: 'm' }),
    (a) => tick(a, { at: 3 * MIN, ...STALL }),
  ])
  expect(statusOf(agents, 'q2')).toBe('stalled')
  const tree = buildTree(plan, agents)
  expect(tree.groups[0].id).toBe('G5')
  expect(tree.groups[0].loud).toEqual({ blocked: 0, stalled: 1 })
  expect(tree.groups[0].tasks[0].agents.map((a) => a.id)).toEqual(['q2', 'q3'])
  expect(tree.groups[1].id).toBe('G1')
})

test('agents sort blocked, stalled, running, queued, then finished newest first', async () => {
  const plan = small(TREE_PLAN, { doneRule: 'column=landed', partial: 'published' })
  const ids = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']
  const { agents } = run([
    ...ids.map((id, i) => (a: AgentRecord[]) => spawnAgent(a, spawnEv({ agentId: id, description: 'B1 ' + id, at: i }), { plan })),
    (a) => completeAgent(a, { at: 10, agentId: 'o1', reason: 'answer', answer: 'ok', durationMs: 1 }),
    (a) => completeAgent(a, { at: 20, agentId: 'o2', reason: 'error', answer: '', durationMs: 1 }),
    (a) => stepStart(a, { at: 30, agentId: 'o3', model: 'm' }),
    (a) => completeAgent(a, { at: 40, agentId: 'o4', reason: 'answer', answer: 'BLOCKED: q', durationMs: 1 }),
    (a) => stepStart(a, { at: 30, agentId: 'o5', model: 'm' }),
    (a) => tick(a, { at: 30 + 10 * MIN, ...STALL }),
  ])
  // o3 and o5 stepped at 30, so both stall at 30+10m; o6 never stepped and stalls too
  const tree = buildTree(plan, agents)
  const b1 = tree.groups.find((g) => g.id === 'G2')?.tasks[0]
  expect(b1?.agents.map((a) => a.id + ':' + a.status)).toEqual(['o4:blocked', 'o3:stalled', 'o5:stalled', 'o6:stalled', 'o2:failed', 'o1:done'])
})

test('a task with a sub-checklist carries its own bar; a provisional record stays out of the tree', async () => {
  const plan = small('### T1: x\n- [ ] **S1:** a\n  - [x] one\n  - [ ] two\n')
  const tree = buildTree(plan, stepStart([], { at: 0, agentId: 'ghost', model: 'm' }).agents)
  expect(tree.groups[0].tasks[0].sub).toEqual({ done: 1, total: 2 })
  expect(tree.unassigned.agents.length).toBe(0)
})

test('the tree carries the unmapped row count from the group map', async () => {
  const tree = buildTree(REL2, [])
  expect(tree.unmapped).toBe(REL2.unmapped)
  expect(tree.unmapped > 0).toBe(true)
  const ui3 = tree.groups.find((g) => g.id === 'UI3')
  expect(ui3?.tasks.map((t) => t.id).sort()).toEqual(['R02-40', 'R02-41', 'R02-73'])
})

// ---------------------------------------------------------------- band line 2 (section 2, 8.1)

test('current task: none without agents; the task of the newest unfinished agent, with its bar', async () => {
  expect(bandCurrent(REL2, [])).toEqual({ marks: {} })
  const title = REL2.tasks.find((t) => t.id === 'R02-73')?.title as string
  let o = spawnAgent([], spawnEv({ agentId: 'c1', description: 'R02-73 case read', at: 1 }), { plan: REL2 })
  expect(bandCurrent(REL2, o.agents)).toEqual({ current: { id: 'R02-73', title, done: 0, total: 1, unit: 'agents' }, marks: {} })
  o = stepStart(o.agents, { at: 2, agentId: 'c1', model: 'm' })
  expect(bandCurrent(REL2, o.agents).marks).toEqual({ running: 1 })
  o = completeAgent(o.agents, { at: 3, agentId: 'c1', reason: 'answer', answer: 'ok', durationMs: 1 })
  // nothing unfinished: the task of the most recent completion
  expect(bandCurrent(REL2, o.agents)).toEqual({ current: { id: 'R02-73', title, done: 1, total: 1, unit: 'agents' }, marks: {} })
})

test('current task: an older unfinished agent beats a newer finished one; a group label gives the group', async () => {
  const pyTitle = REL2.groups.find((g) => g.id === 'API1')?.title as string
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'g1', description: 'API1 endpoint census', at: 1 }), { plan: REL2 }),
    (a) => spawnAgent(a, spawnEv({ agentId: 't1', description: 'R02-73 read', at: 2 }), { plan: REL2 }),
    (a) => completeAgent(a, { at: 3, agentId: 't1', reason: 'answer', answer: 'ok', durationMs: 1 }),
  ])
  expect(bandCurrent(REL2, agents).current).toEqual({ id: 'API1', title: pyTitle, done: 0, total: 1, unit: 'agents' })
})

test('current task: every task done and no agent at work reads all done, with no task kept as current', async () => {
  const plan = small('### T1: x\n- [x] **S1:** a\n- [x] **S2:** b\n')
  expect(bandCurrent(plan, [])).toEqual({ marks: {}, allDone: true })
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'd1', description: 'S2 go', at: 1 }), { plan }),
    (a) => completeAgent(a, { at: 3, agentId: 'd1', reason: 'answer', answer: 'ok', durationMs: 1 }),
  ])
  expect(bandCurrent(plan, agents)).toEqual({ marks: {}, allDone: true })
  expect(bandCurrent(plan, agents, 'S1')).toEqual({ marks: {}, allDone: true })
  // an agent still at work, or a task still open, keeps the task as current
  const live = spawnAgent([], spawnEv({ agentId: 'd2', description: 'S2 go', at: 1 }), { plan })
  expect(bandCurrent(plan, live.agents).allDone).toBe(undefined)
  expect(bandCurrent(plan, live.agents).current).toMatchObject({ id: 'S2', status: 'done' })
  const open = small('### T1: x\n- [x] **S1:** a\n- [ ] **S2:** b\n')
  expect(bandCurrent(open, agents).allDone).toBe(undefined)
  expect(bandCurrent(null, []).allDone).toBe(undefined)
})

test('current task: a done task is marked done so its bar is not drawn in the partial colour', async () => {
  const plan = small('### T1: x\n- [x] **S1:** a\n- [ ] **S2:** b\n')
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'e1', description: 'S1 go', at: 1 }), { plan }),
    (a) => completeAgent(a, { at: 3, agentId: 'e1', reason: 'answer', answer: 'ok', durationMs: 1 }),
  ])
  expect(bandCurrent(plan, agents).current).toEqual({ id: 'S1', title: 'a', done: 1, total: 1, unit: 'agents', status: 'done' })
  expect(bandCurrent(plan, agents, 'S1').current).toMatchObject({ id: 'S1', status: 'done' })
  expect(bandCurrent(plan, agents, 'S2').current?.status).toBe(undefined)
})

test('band marks count blocked, running and stalled agents across the plan', async () => {
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'm1', description: 'R02-73 a', at: 0 }), { plan: REL2 }),
    (a) => spawnAgent(a, spawnEv({ agentId: 'm2', description: 'R02-73 b', at: 0 }), { plan: REL2 }),
    (a) => spawnAgent(a, spawnEv({ agentId: 'm3', description: 'API1 c', at: 0 }), { plan: REL2 }),
    (a) => stepStart(a, { at: MIN, agentId: 'm1', model: 'm' }),
    (a) => completeAgent(a, { at: MIN, agentId: 'm2', reason: 'answer', answer: 'BLOCKED: q', durationMs: 1 }),
    (a) => tick(a, { at: 2 * MIN, ...STALL }),
  ])
  const b = bandCurrent(REL2, agents)
  expect(b.marks).toEqual({ blocked: 1, running: 1, stalled: 1 })
  expect(b.current).toMatchObject({ id: 'API1', done: 0, total: 1 })
})

test('current task: a sub-checklist gives an items bar; an unmatched Agent-tool agent is Agents', async () => {
  const plan = small('### T1: x\n- [ ] **S1:** a\n  - [x] one\n  - [ ] two\n')
  const o = spawnAgent([], spawnEv({ agentId: 's1', description: 'S1 go' }), { plan })
  expect(bandCurrent(plan, o.agents).current).toEqual({ id: 'S1', title: 'a', done: 1, total: 2, unit: 'items' })
  const u = spawnAgent([], spawnEv({ agentId: 'u1', description: 'no id' }), { plan })
  expect(bandCurrent(plan, u.agents).current).toEqual({ id: 'Agents', title: '', done: 0, total: 1, unit: 'agents' })
  expect(bandCurrent(null, u.agents).current).toEqual({ id: 'Agents', title: '', done: 0, total: 1, unit: 'agents' })
})

// ---------------------------------------------------------------- M5: planned calls and router warnings

const PLAN_CALLS = [
  { ordinal: 1, label: 'UI3 residual grep', phase: 'Build', requestedModel: 'haiku', effort: 'low', warnings: [] as string[] },
  { ordinal: 2, label: 'R02-73 case read', phase: 'Verify', requestedModel: 'haiku', warnings: ['R2 headway: Workflow "w": 1 agent() call(s) without model or effort: "R02-73 case read". Pass both on every call.'] },
]

test('addPlanned writes one queued planned record per call, matched against the plan; idempotent per tool call', async () => {
  const o = addPlanned([], { at: 5, toolUseId: 'toolu_w', calls: PLAN_CALLS }, { plan: REL2 })
  expect(o.changed).toBe(true)
  expect(o.agents.map((a) => a.id)).toEqual(['wf:toolu_w:1', 'wf:toolu_w:2'])
  expect(o.agents[0]).toMatchObject({
    planned: true, status: 'queued', toolUseId: 'toolu_w', agentIndex: 1, label: 'UI3 residual grep', phase: 'Build',
    requestedModel: 'haiku', effort: 'low', groupId: 'UI3', subagentType: 'workflow-subagent', warnings: [], spawnedAt: 5,
  })
  expect(o.agents[1]).toMatchObject({ taskIds: ['R02-73'] })
  expect(o.agents[1].effort).toBe(undefined)
  expect(o.agents[1].warnings.length).toBe(1)
  // the same call again replaces its planned records instead of doubling them
  const again = addPlanned(o.agents, { at: 6, toolUseId: 'toolu_w', calls: PLAN_CALLS }, { plan: REL2 })
  expect(again.agents.length).toBe(2)
  // another tool call's planned records are left alone
  const other = addPlanned(o.agents, { at: 7, toolUseId: 'toolu_v', calls: [PLAN_CALLS[0]] }, { plan: REL2 })
  expect(other.agents.length).toBe(3)
  // planned calls are not stalled by the timer
  expect(tick(o.agents, { at: 99 * MIN, ...STALL }).agents.every((a) => a.status === 'queued')).toBe(true)
})

test('bindRun gives planned calls of a tool call their run; the spawn then joins phase, model, effort and warnings', async () => {
  const planned = addPlanned([], { at: 0, toolUseId: 'toolu_w', calls: PLAN_CALLS }, { plan: REL2 })
  // before the run is known nothing joins
  const unbound = spawnAgent(planned.agents, spawnEv({ toolUseId: 'toolu_w', description: 'UI3 residual grep', subagentType: 'workflow-subagent', workflow: { runId: 'wf_r', agentIndex: 1 }, agentId: 'x1' }), { plan: REL2 })
  expect(unbound.agents.filter((a) => a.planned).length).toBe(2)
  const b = bindRun(planned.agents, 'toolu_w', 'wf_r')
  expect(b.changed).toBe(true)
  expect(b.agents.map((a) => a.id)).toEqual(['wf:wf_r:1', 'wf:wf_r:2'])
  expect(bindRun(b.agents, 'toolu_w', 'wf_r').changed).toBe(false)
  let o = spawnAgent(b.agents, spawnEv({ toolUseId: 'toolu_w', description: 'UI3 residual grep', subagentType: 'workflow-subagent', model: 'haiku', workflow: { runId: 'wf_r', agentIndex: 1 }, agentId: 'x1' }), { plan: REL2 })
  expect(only(o, 'x1')).toMatchObject({ phase: 'Build', requestedModel: 'haiku', effort: 'low', agentIndex: 1, warnings: [] })
  o = spawnAgent(o.agents, spawnEv({ toolUseId: 'toolu_w', description: 'R02-73 case read', subagentType: 'workflow-subagent', model: 'haiku', workflow: { runId: 'wf_r', agentIndex: 2 }, agentId: 'x2' }), { plan: REL2 })
  expect(only(o, 'x2')).toMatchObject({ phase: 'Verify', requestedModel: 'haiku' })
  expect(only(o, 'x2').warnings[0]).toMatch(/^R2 headway: Workflow/)
  expect(o.agents.filter((a) => a.planned).length).toBe(0)
})

test('a planned call with no label joins by its ordinal', async () => {
  const planned = addPlanned([], { at: 0, toolUseId: 'toolu_u', calls: [{ ordinal: 1, phase: 'P', warnings: [] }, { ordinal: 2, phase: 'Q', warnings: [] }] }, { plan: null })
  const b = bindRun(planned.agents, 'toolu_u', 'wf_u')
  const o = spawnAgent(b.agents, spawnEv({ description: 'whatever the harness called it', subagentType: 'workflow-subagent', workflow: { runId: 'wf_u', agentIndex: 2 }, agentId: 'u2' }), { plan: null })
  expect(only(o, 'u2').phase).toBe('Q')
})

test('dropPlanned removes a tool call planned records (a denied Workflow)', async () => {
  const planned = addPlanned([], { at: 0, toolUseId: 'toolu_w', calls: PLAN_CALLS }, { plan: null })
  expect(dropPlanned(planned.agents, 'toolu_w').agents).toEqual([])
  expect(dropPlanned(planned.agents, 'toolu_other').changed).toBe(false)
})

test('dispatch warnings ride the spawn onto the record', async () => {
  const w = ['R1 headway: Agent "d" (scout) has no explicit model; x']
  const o = spawnAgent([], spawnEv({ agentId: 'w1', subagentType: 'acme:scout', model: undefined, warnings: w }), { plan: null })
  expect(only(o, 'w1').warnings).toEqual(w)
})

// A role table as a user's roles file would give it (R3 and R4 are off without one).
const ROLES = {
  scout: { models: ['sonnet'], efforts: ['high'] },
  hand: { models: ['sonnet'], efforts: ['low'] },
}

test('R3 after the fact: the first step of a scout that R1 flagged, resolved to opus, marks the row and logs', async () => {
  const r1 = ['R1 headway: Agent "sweep" (scout) names no model; x']
  let o = spawnAgent([], spawnEv({ agentId: 'r1', description: 'sweep', subagentType: 'acme:scout', model: undefined, warnings: r1 }), { plan: null, roles: ROLES })
  o = stepStart(o.agents, { at: 10, agentId: 'r1', model: 'claude-opus-5-5', effort: 'high', roles: ROLES })
  const r = only(o, 'r1')
  expect(r.warnings.length).toBe(2)
  expect(r.warnings[1]).toBe('R3 headway: scout "sweep" dispatched on opus; the role table expects sonnet.')
  expect(o.log).toEqual([{ at: 10, kind: 'warn', ref: 'R3', role: 'scout', agentId: 'r1', detail: 'scout "sweep" dispatched on opus; the role table expects sonnet.' }])
  // a second step adds nothing
  const o2 = stepStart(o.agents, { at: 20, agentId: 'r1', model: 'claude-opus-5-5', effort: 'high', roles: ROLES })
  expect(only(o2, 'r1').warnings.length).toBe(2)
  expect(o2.log).toEqual([])
})

test('R3 after the fact does not fire when R1 did not (the dispatch named a model); R4 fires on the first step only', async () => {
  let o = spawnAgent([], spawnEv({ agentId: 'h1', description: 'tiny', subagentType: 'acme:hand', model: 'sonnet' }), { plan: null })
  o = stepStart(o.agents, { at: 10, agentId: 'h1', model: 'claude-opus-5-5', effort: 'high', roles: ROLES })
  const r = only(o, 'h1')
  expect(r.warnings).toEqual(['R4 headway: hand "tiny" ran at effort high; the role table expects low.'])
  expect(o.log.map((l) => l.kind + ':' + l.ref)).toEqual(['warn:R4'])
  const o2 = stepStart(o.agents, { at: 20, agentId: 'h1', model: 'claude-opus-5-5', effort: 'medium', roles: ROLES })
  expect(only(o2, 'h1').warnings.length).toBe(1)
})

test('an unknown role and a workflow agent are never judged at the first step', async () => {
  let o = spawnAgent([], spawnEv({ agentId: 'g1', subagentType: 'general-purpose', model: undefined, warnings: ['R1 x'] }), { plan: null })
  o = stepStart(o.agents, { at: 1, agentId: 'g1', model: 'claude-haiku-5-5', effort: 'max', roles: ROLES })
  expect(only(o, 'g1').warnings).toEqual(['R1 x'])
  expect(o.log).toEqual([])
  let w = spawnAgent([], spawnEv({ agentId: 'wf1', subagentType: 'workflow-subagent', workflow: { runId: 'wf_z', agentIndex: 1 } }), { plan: null })
  w = stepStart(w.agents, { at: 1, agentId: 'wf1', model: 'claude-haiku-5-5', effort: 'low', roles: ROLES })
  expect(only(w, 'wf1').warnings).toEqual([])
})

test('a step that beat its spawn is still routed once the spawn lands', async () => {
  let o = stepStart([], { at: 5, agentId: 'e1', model: 'claude-opus-5-5', effort: 'high', roles: ROLES })
  expect(only(o, 'e1').provisional).toBe(true)
  expect(o.log).toEqual([])
  o = spawnAgent(o.agents, spawnEv({ agentId: 'e1', at: 6, description: 'late', subagentType: 'acme:scout', model: undefined, warnings: ['R1 headway: Agent "late" (scout) names no model; x'] }), { plan: null, roles: ROLES })
  const r = only(o, 'e1')
  expect(r.warnings.map((x) => x.slice(0, 2))).toEqual(['R1', 'R3'])
  expect(o.log.map((l) => l.kind + ':' + l.ref)).toEqual(['warn:R3'])
})

test('with no role table the first step is not judged: no R3, no R4', async () => {
  let o = spawnAgent([], spawnEv({ agentId: 'n1', description: 'sweep', subagentType: 'acme:scout', model: undefined, warnings: ['R1 x'] }), { plan: null })
  o = stepStart(o.agents, { at: 10, agentId: 'n1', model: 'claude-opus-5-5', effort: 'low' })
  expect(only(o, 'n1').warnings).toEqual(['R1 x'])
  expect(o.log).toEqual([])
})

// ---------------------------------------------------------------- recent groups (8.2) and the warned mark (8.1)

test('a group whose agents finished in the last 30 minutes sorts right after the active groups', async () => {
  const plan = small(TREE_PLAN, { doneRule: 'column=landed', partial: 'published' })
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'r1', description: 'B1 job', at: 100 }), { plan }),
    (a) => completeAgent(a, { at: 200, agentId: 'r1', reason: 'answer', answer: 'ok', durationMs: 1 }),
    (a) => spawnAgent(a, spawnEv({ agentId: 'r2', description: 'A4 work', at: 300 }), { plan }),
  ])
  const ids = (now?: number) => buildTree(plan, agents, now).groups.map((g) => g.id + ':' + g.status)
  // no clock: the order of the plan sort
  expect(ids()).toEqual(['G1:active', 'G4:partial', 'G2:queued', 'G5:queued', 'G3:done'])
  // 29 minutes after the finish: G2 comes straight after the active group, before partial and queued
  expect(ids(200 + 29 * MIN)).toEqual(['G1:active', 'G2:queued', 'G4:partial', 'G5:queued', 'G3:done'])
  expect(buildTree(plan, agents, 200 + 29 * MIN).groups[1].recent).toBe(true)
  // 31 minutes after: back to the plan sort
  expect(ids(200 + 31 * MIN)).toEqual(['G1:active', 'G4:partial', 'G2:queued', 'G5:queued', 'G3:done'])
  expect(buildTree(plan, agents, 200 + 31 * MIN).groups.some((g) => g.recent)).toBe(false)
})

test('a task is recent when one of its agents finished in the last 30 minutes; an unfinished agent is not', async () => {
  const plan = small(TREE_PLAN, { doneRule: 'column=landed', partial: 'published' })
  const { agents } = run([
    (a) => spawnAgent(a, spawnEv({ agentId: 'r1', description: 'B1 job', at: 100 }), { plan }),
    (a) => completeAgent(a, { at: 200, agentId: 'r1', reason: 'answer', answer: 'ok', durationMs: 1 }),
    (a) => spawnAgent(a, spawnEv({ agentId: 'r3', description: 'E1 job', at: 300 }), { plan }),
  ])
  const tree = buildTree(plan, agents, 400)
  expect(tree.groups.find((g) => g.id === 'G2')?.tasks[0].recent).toBe(true)
  expect(tree.groups.find((g) => g.id === 'G5')?.recent).toBe(false)
})

test('band line 2 marks warned: agents not yet finished that carry a router warning', async () => {
  const warned = (id: string, over: Partial<AgentRecord> = {}): AgentRecord => ({
    ...spawnAgent([], spawnEv({ agentId: id, description: 'R02-73 read', at: 1 }), { plan: REL2 }).agents[0],
    warnings: ['R1 no explicit model'],
    ...over,
  })
  expect(bandCurrent(REL2, [warned('w1')]).marks).toEqual({ warned: 1 })
  expect(bandCurrent(REL2, [warned('w1', { status: 'running' }), warned('w2', { status: 'stalled' })]).marks).toEqual({ warned: 2, running: 1, stalled: 1 })
  // a finished agent's warning no longer marks the band
  expect(bandCurrent(REL2, [warned('w3', { status: 'done', endedAt: 5 })]).marks).toEqual({})
})

// SPEC 5.3: a bare numeric ID (a plan-mode or reported step) matches only as `Step n`, `step n`,
// `#n`, or `n:` / `n.` at the start of the text, never as a loose number.
test('bare numeric IDs match only in the step forms, never as a loose number', async () => {
  const plan = modePlan(parsePlanMode('1. write a\n2. write b\n12. write l\n'))
  const hit = (text: string) => matchAgent(plan, [text]).taskIds
  expect(hit('step 2: write b')).toEqual(['2'])
  expect(hit('Step 2 build')).toEqual(['2'])
  expect(hit('fix #2 now')).toEqual(['2'])
  expect(hit('2: write b')).toEqual(['2'])
  expect(hit('  2. write b')).toEqual(['2'])
  expect(hit('step 12: last')).toEqual(['12'])
  expect(hit('make 2 files')).toEqual([])
  expect(hit('write 2: files')).toEqual([])
  expect(hit('v2 rollout')).toEqual([])
  expect(hit('2.5 release')).toEqual([])
  expect(hit('mystep 2')).toEqual([])
  // an ID with letters keeps the whole-word rule
  const file = modePlan(parsePlanMode('- [ ] A1 parse\n- [ ] A2 wire\n'))
  expect(matchAgent(file, ['finish A2 today']).taskIds).toEqual(['A2'])
})
