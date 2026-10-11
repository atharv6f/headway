import { expect, mock, test } from 'claude-code/testing'
import { PLAN, snapshotState, start, TOOL, world } from './world.ts'

// `$.state` as the engine serves it: every get of one dispatch reads the moment the dispatch began,
// whatever is written meanwhile; a set given `ifVersion` that another write beat misses, and a get
// after the miss reads what stands. The hooks must not lose a write to that snapshot.
const USAGE = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 29234, model: 'claude-haiku-5-5' }

function beneath(on) {
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: [] }))
  on('session.id', async () => ({ value: 's-1' }))
  on('store.set', async () => ({ value: undefined }))
}

test('snapshot: a step that creates a record and adds its usage in one dispatch keeps both writes', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const st = snapshotState(on)
  beneath(on)
  st.begin()
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'ag-early' })
  for await (const _ of s) {
    // drain
  }
  st.end()
  const agents = st.value('agents') as Array<{ id: string; steps: number; tokens: { cacheWrite: number }; estUsd: number }>
  expect(agents.map((a) => a.id)).toEqual(['ag-early'])
  expect(agents[0].steps).toBe(1)
  expect(agents[0].tokens.cacheWrite).toBe(29234)
  expect(agents[0].estUsd).toBeGreaterThan(0)
})

// ---------------------------------------------------------------- saves and same-dispatch writes

const FILES = { '/w/plan/p.md': PLAN }
type Rec = { filter: unknown; report: unknown; agents: Array<{ id: string; status: string }>; log: Array<{ kind: string }> }

function spawnInput(n: number, description: string) {
  return {
    tool_use_id: 'toolu_' + n, prompt: 'Reply ok', description, subagentType: 'acme:scout',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  }
}

// One test-driven call as one dispatch of the engine.
async function dispatch<T>(st: { begin: () => void; end: () => void }, work: () => Promise<T>): Promise<T> {
  st.begin()
  try {
    return await work()
  } finally {
    st.end()
  }
}

function setup(on) {
  const w = world(on, { files: FILES, sessionId: 's-1', watchState: false })
  const st = snapshotState(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag1' }))
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: [] }))
  on('ui.log', async () => ({ value: undefined })) // the unmocked registrations log here
  return { w, st }
}

const track = ($) => $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })

test('save: the record written after an agent finishes already holds it finished, and the log entry', async ($, on) => {
  const { w, st } = setup(on)
  await start($)
  await dispatch(st, () => track($))
  await dispatch(st, () => $.agent.spawn(spawnInput(1, 'T2 build')))
  await dispatch(st, () => $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't', agentId: 'ag1', reason: 'answer' }))
  await w.clock.advance(1000)
  const rec = w.store['session:s-1'] as Rec
  expect(rec.agents.map((a) => a.id + ':' + a.status)).toEqual(['ag1:done'])
  expect(rec.log.map((l) => l.kind)).toEqual(['done', 'pin'])
  expect(rec.filter).toEqual({ file: '/w/plan/p.md', section: 'Work', doneRule: 'column=landed', bounds: { file: '/w' } })
})

test('save: untrack saves the filter and report cleared', async ($, on) => {
  const { w, st } = setup(on)
  await start($)
  await dispatch(st, () => track($))
  await w.clock.advance(1000)
  await dispatch(st, () => $.tool.call({ tool: TOOL, tool_use_id: 't2', action: 'untrack' }))
  await w.clock.advance(1000)
  const rec = w.store['session:s-1'] as Rec
  expect(rec.filter).toBe(null)
  expect(rec.log.map((l) => l.kind)).toEqual(['unpin', 'pin'])
})

test('report: the reported list is the plan and the goal at once, and the save holds it', async ($, on) => {
  const { w, st } = setup(on)
  await start($)
  await dispatch(st, () => track($))
  await dispatch(st, () => $.tool.call({ tool: TOOL, tool_use_id: 't1', action: 'untrack' }))
  const tasks = [{ id: 'R1', title: 'one', status: 'done' }, { id: 'R2', title: 'two', status: 'open' }]
  await dispatch(st, () => $.tool.call({ tool: TOOL, tool_use_id: 't2', action: 'report', title: 'Ship it', tasks }))
  expect(st.value('goal')).toMatchObject({ label: 'Ship it', done: 1, total: 2, source: 'reported' })
  await w.clock.advance(1000)
  const rec = w.store['session:s-1'] as Rec
  expect(rec.report).toMatchObject({ title: 'Ship it' })
  expect(rec.log.map((l) => l.kind)).toEqual(['report', 'unpin', 'pin'])
})

test('re-pin: the same filter with a report beneath it keeps the report in the save (SPEC 4.1)', async ($, on) => {
  const { w, st } = setup(on)
  await start($)
  await dispatch(st, () => track($))
  await dispatch(st, () => $.tool.call({ tool: TOOL, tool_use_id: 't2', action: 'report', tasks: [{ id: 'R1', title: 'one', status: 'open' }] }))
  await w.clock.advance(1000)
  await dispatch(st, () => track($))
  await w.clock.advance(1000)
  expect((w.store['session:s-1'] as Rec).report).toMatchObject({ tasks: [{ id: 'R1' }] })
  expect(st.value('goal')).toMatchObject({ label: 'Work', source: 'file' })
})
