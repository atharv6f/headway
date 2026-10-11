import { expect, test } from 'claude-code/testing'
import { repinAgents, stepStart } from '../plugin/hooks/agents.ts'
import type { AgentRecord } from '../plugin/hooks/agents.ts'
import { sameFilter } from '../plugin/hooks/pin.ts'
import { parsePlan } from '../plugin/hooks/plan.ts'
import { PLAN, start, TOOL, transcripts, world, userCommand } from './world.ts'

// Pinning again (SPEC 3.3): the same filter only re-reads; another filter keeps the agents still at
// work, re-matched to the new plan, drops the finished ones and keeps the log.
const OTHER = `# Q

## Other

- [ ] X1 first
- [ ] X2 second
`
const FILES = { '/w/plan/p.md': PLAN, '/w/plan/q.md': OTHER }
type A = { id: string; status: string; taskIds: string[] }
type L = { kind: string; detail?: string }

function spawnInput(n: number, description: string) {
  return {
    tool_use_id: 'toolu_' + n, prompt: 'Reply ok', description, subagentType: 'acme:implementer',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  }
}

function setup(on) {
  const w = world(on, { files: FILES, sessionId: 's-1' })
  let n = 0
  const spawned = transcripts(on)
  on('agent.spawn', async (_$, e) => {
    const agentId = 'ag' + n++
    spawned(agentId, e.prompt)
    return { model: 'claude-sonnet-5-5', agentId }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: [] }))
  return w
}

const trackP = ($, id = 't') => $.tool.call({ tool: TOOL, tool_use_id: id, action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })

test('re-pin: the same filter again keeps a running agent and the log, and logs only re-read', async ($, on) => {
  const w = setup(on)
  await start($)
  await trackP($)
  await $.agent.spawn(spawnInput(1, 'T2 build'))
  expect(await userCommand($, 'track plan/p.md "Work" column=landed')).toBeDefined()
  await trackP($, 't2')
  expect((w.last.agents as A[]).map((a) => a.id + ':' + a.status)).toEqual(['toolu_1:queued'])
  const log = w.last.log as L[]
  expect(log.filter((l) => l.kind === 'pin').map((l) => l.detail)).toEqual(['re-read p.md § Work  column=landed', 're-read p.md § Work  column=landed', 'tracking p.md § Work  column=landed'])
  // the agent's BLOCKED answer still lands
  await $.turn.complete({ answer: 'BLOCKED: which toggle', durationMs: 5, isAborted: false, turnId: 't', agentId: 'ag0', reason: 'answer' })
  expect((w.last.agents as A[]).map((a) => a.id + ':' + a.status)).toEqual(['ag0:blocked'])
  expect((w.last.log as L[])[0].kind).toBe('blocked')
})

test('re-pin: another filter keeps agents at work re-matched to the new plan, drops finished ones, keeps the log', async ($, on) => {
  const w = setup(on)
  await start($)
  await trackP($)
  await $.agent.spawn(spawnInput(1, 'T2 build')) // ag0, will finish
  await $.agent.spawn(spawnInput(2, 'T3 build')) // ag1, still at work, names nothing in the new plan
  await $.agent.spawn(spawnInput(3, 'X1 prep')) // ag2, unassigned now, X1 in the new plan
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't', agentId: 'ag0', reason: 'answer' })
  await $.tool.call({ tool: TOOL, tool_use_id: 't2', action: 'track', file: 'plan/q.md', section: 'Other' })
  const agents = w.last.agents as A[]
  expect(agents.map((a) => a.id + ':' + a.status + ':' + a.taskIds.join(','))).toEqual(['toolu_2:queued:', 'toolu_3:queued:X1'])
  const log = w.last.log as L[]
  expect(log[0]).toMatchObject({ kind: 'pin', detail: 'tracking q.md § Other' })
  expect(log.map((l) => l.kind)).toEqual(['pin', 'done', 'pin'])
})

test('sameFilter: equal fields are the same pin whichever way they were written; auto is the default rule', async () => {
  expect(sameFilter({ file: '/a', section: 'S', doneRule: 'column=x' }, { doneRule: 'column=x', section: 'S', file: '/a' })).toBe(true)
  expect(sameFilter({ file: '/a' }, { file: '/a', doneRule: 'auto' })).toBe(true)
  expect(sameFilter({ file: '/a', partial: 'p' }, { file: '/a' })).toBe(false)
  expect(sameFilter(null, { file: '/a' })).toBe(false)
})

test('repinAgents: an agent keeps a task id the new plan still has when its texts name nothing (it came from the prompt)', async () => {
  const r = parsePlan('# P\n\n- [ ] T1 a\n- [ ] T2 b\n', {})
  if (!r.ok) throw new Error(r.error)
  const base = { subagentType: 'acme:scout', role: 'scout', spawnedAt: 1, steps: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, estUsd: 0, warnings: [] }
  const agents: AgentRecord[] = [
    { ...base, id: 'p', agentId: 'p', description: 'read the file', taskIds: ['T2'], status: 'running' },
    { ...base, id: 'g', agentId: 'g', description: 'read the file', taskIds: ['Z9'], status: 'running' },
    { ...base, id: 'd', agentId: 'd', description: 'T1 done', taskIds: ['T1'], status: 'done' },
    { ...base, id: 'l', agentId: 'l', description: 'T1 lost', taskIds: ['T1'], status: 'lost' },
  ]
  const o = repinAgents(agents, { plan: r.plan })
  expect(o.agents.map((a) => a.id + ':' + a.taskIds.join(','))).toEqual(['p:T2', 'g:'])
})

test('re-pin: the same filter again keeps the compact-hint boundary noticed under it', { options: { compactAtPercent: 50 } }, async ($, on) => {
  const w = setup(on)
  on('session.usage', async () => ({ value: { context: { window: 200_000, percent: 60, tokens: 120_000 }, rateLimits: [], cost: { usd: 1 } } }))
  await start($)
  await trackP($)
  await $.agent.spawn(spawnInput(1, 'T3 read'))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-ag0', agentId: 'ag0', reason: 'answer' })
  await trackP($, 't2')
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })
  expect((w.last.usage as { hint?: string }).hint).toBe('compact-now')
})

test('re-match with retire: finished agents become previous and match nothing; running ones and resumed previous ones re-match', async () => {
  const r = parsePlan(PLAN, {})
  if (!r.ok) throw new Error(r.error)
  const base = { subagentType: 'acme:scout', role: 'scout', spawnedAt: 1, steps: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, estUsd: 0, warnings: [] }
  const agents: AgentRecord[] = [
    { ...base, id: 'd', agentId: 'd', description: 'T1 done', taskIds: ['T1'], status: 'done' },
    { ...base, id: 'b', agentId: 'b', description: 'T2 blocked', taskIds: ['T2'], status: 'blocked' },
    { ...base, id: 'r', agentId: 'r', description: 'T3 running', taskIds: ['T3'], status: 'running' },
  ]
  const o = repinAgents(agents, { plan: r.plan, temporal: true }, { keepFinished: true, retire: true })
  expect(o.agents.map((a) => a.id + ':' + a.taskIds.join(',') + ':' + (a.previous === true))).toEqual(['d::true', 'b::true', 'r:T3:false'])
  // a later re-match without retire keeps the previous agents out; one that resumed re-matches and drops the mark
  const resumed = o.agents.map((a) => (a.id === 'd' ? { ...a, status: 'running' as const } : a))
  const again = repinAgents(resumed, { plan: r.plan }, { keepFinished: true })
  expect(again.agents.map((a) => a.id + ':' + a.taskIds.join(',') + ':' + (a.previous === true))).toEqual(['d:T1:false', 'b::true', 'r:T3:false'])
})

test('stepStart: a step for a previous agent clears the mark and re-matches it with the context given, temporal association included', async () => {
  const r = parsePlan(PLAN, {})
  if (!r.ok) throw new Error(r.error)
  const base = { subagentType: 'acme:scout', role: 'scout', spawnedAt: 1, steps: 1, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, estUsd: 0, warnings: [], firstStepAt: 1 }
  const agents: AgentRecord[] = [
    { ...base, id: 'p', agentId: 'p', description: 'T2 again', taskIds: [], status: 'done', previous: true },
    { ...base, id: 'q', agentId: 'q', description: 'no id here', taskIds: [], status: 'done', previous: true },
  ]
  const o = stepStart(agents, { at: 5, agentId: 'p', match: { plan: r.plan } })
  expect(o.agents[0]).toMatchObject({ status: 'running', taskIds: ['T2'] })
  expect(o.agents[0].previous).toBe(undefined)
  const partial = { ...r.plan, tasks: r.plan.tasks.map((t) => (t.id === 'T3' ? { ...t, status: 'partial' as const } : { ...t, status: 'open' as const })) }
  const q = stepStart(agents, { at: 5, agentId: 'q', match: { plan: partial, temporal: true } })
  expect(q.agents[1]).toMatchObject({ status: 'running', taskIds: ['T3'] })
  expect(q.agents[1].previous).toBe(undefined)
})
