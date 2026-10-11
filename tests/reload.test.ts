import { expect, test } from 'claude-code/testing'
import { PLAN, start, TOOL, world } from './world.ts'

// The reload on classic.SessionStart: what a new process does with the agents a record holds, and
// which record a new session id starts from.
const FILES = { '/w/plan/p.md': PLAN }
const DAY = 24 * 60 * 60_000
const FILTER = { file: '/w/plan/p.md', section: 'Work', doneRule: 'column=landed' }
const TOK = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }

function rec(id: string, status: string, over: Record<string, unknown> = {}) {
  return { id, agentId: id, description: 'T2 build', subagentType: 'acme:implementer', taskIds: ['T2'], role: 'implementer', status, spawnedAt: 1, firstStepAt: 2, lastStepAt: 5, steps: 3, tokens: TOK, estUsd: 0, warnings: [], ...over }
}
const saved = (agents: unknown[], at: number, filter: unknown = FILTER) => ({ filter, report: null, agents, log: [], savedAt: at })
type A = { id: string; status: string }
type L = { kind: string; agentId?: string; detail?: string }

test('reload: a resume in a new process shows a running agent lost, not stalled, and logs it once', async ($, on) => {
  const now = 6 * DAY
  const w = world(on, { files: FILES, sessionId: 's-res', store: { 'session:s-res': saved([rec('r1', 'running'), rec('b1', 'blocked', { question: 'q', endedAt: 4 })], 5 * DAY) }, now })
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-res' })
  expect((w.last.agents as A[]).map((a) => a.id + ':' + a.status)).toEqual(['r1:lost', 'b1:blocked'])
  await w.clock.advance(16_000)
  expect((w.last.agents as A[]).map((a) => a.id + ':' + a.status)).toEqual(['r1:lost', 'b1:blocked'])
  expect((w.last.log as L[]).map((l) => l.kind + ' ' + l.agentId + ' ' + l.detail)).toEqual(['lost r1 (session restarted)'])
  const state = (await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'state' })).result as string
  expect(state).toContain('stalled: none')
  expect(state).toContain('[lost] r1')
})

function spawnInput(n: number, description: string) {
  return {
    tool_use_id: 'toolu_' + n, prompt: 'Reply ok', description, subagentType: 'acme:scout',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  }
}

test('reload: /clear carries the record of the session being left, not the one saved last on the account', async ($, on) => {
  const now = 6 * DAY
  const other = { file: '/w/plan/p.md', section: 'Work', doneRule: 'column=published' }
  const w = world(on, { files: FILES, sessionId: 's-A', store: { 'session:s-A': saved([rec('a1', 'blocked', { question: 'q', endedAt: 4 })], now - 9000), 'session:s-B': saved([rec('b1', 'running')], now - 1000, other) }, now })
  await start($)
  w.setSessionId('s-A2')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-A2' })
  expect(w.last.filter).toEqual(FILTER)
  expect((w.last.agents as A[]).map((a) => a.id)).toEqual(['a1'])
  expect((w.store['session:s-A2'] as { filter: unknown }).filter).toEqual(FILTER)
  expect(w.store['last-session']).toBe(undefined)
})

test('reload: /clear in a session with nothing saved does not import another session pin', async ($, on) => {
  const now = 6 * DAY
  const w = world(on, { files: FILES, sessionId: 's-A', store: { 'session:s-B': saved([rec('b1', 'running')], now - 1000), 'last-session': 's-B' }, now })
  await start($)
  w.setSessionId('s-A2')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-A2' })
  expect(w.last.filter ?? null).toBe(null)
  expect((w.last.agents as A[] | undefined) ?? []).toEqual([])
  expect(w.store['session:s-A2']).toBe(undefined)
})

test('reload: a resume of an id with no record starts empty', async ($, on) => {
  const now = 6 * DAY
  const w = world(on, { files: FILES, sessionId: 's-prev', store: { 'session:s-other': saved([rec('o1', 'done', { endedAt: 4 })], now - 1000), 'last-session': 's-other' }, now })
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-unrelated' })
  expect(w.last.filter ?? null).toBe(null)
  expect(w.store['session:s-unrelated']).toBe(undefined)
})

test('reload: /clear starts the new conversation with an empty log; the running agent and the pin stay, and a resume keeps the log', async ($, on) => {
  const w = world(on, { files: FILES, sessionId: 's-1' })
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'live1' }))
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  await $.agent.spawn(spawnInput(1, 'T2 build'))
  expect((w.last.log as unknown[]).length).toBeGreaterThan(0)
  await w.clock.advance(2000)
  w.setSessionId('s-2')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
  expect(w.last.log).toEqual([])
  expect((w.store['session:s-2'] as { log: unknown[] }).log).toEqual([])
  expect(w.last.filter).toEqual({ ...FILTER, bounds: { file: '/w' } })
  expect((w.last.agents as A[]).map((a) => a.id)).toEqual(['toolu_1'])
  w.setSessionId('s-1')
  await $.classic.SessionStart({ source: 'resume', session_id: 's-1' })
  expect((w.last.log as unknown[]).length).toBeGreaterThan(0)
})

test('reload: /clear keeps an agent this process spawned running, and saves write no last-session pointer', async ($, on) => {
  const w = world(on, { files: FILES, sessionId: 's-1' })
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'live1' }))
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  await $.agent.spawn(spawnInput(1, 'T2 build'))
  await w.clock.advance(1000)
  w.setSessionId('s-2')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
  expect((w.last.agents as A[]).map((a) => a.id + ':' + a.status)).toEqual(['toolu_1:queued'])
  expect(w.writes.some((x) => x.key === 'last-session')).toBe(false)
})
