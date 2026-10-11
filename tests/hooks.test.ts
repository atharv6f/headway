import { expect, mock, test } from 'claude-code/testing'

// The hooks in register.tsx, driven through the engine. The engine's `$` has no state noun, so a
// hook beneath the plugin watches what it writes to `$.state` and passes each write on.
type Rec = { id: string; status: string; model?: string; effort?: string; role: string; steps: number; question?: string }
function watchState(on) {
  const last: Record<string, unknown> = {}
  on('state.set', async ($, e, next) => {
    if (e.plugin === 'waypoint') last[e.key] = e.value
    return next(e)
  })
  return {
    agents: () => (last.agents ?? []) as Rec[],
    log: () => (last.log ?? []) as Array<{ kind: string; agentId?: string }>,
  }
}

const USAGE = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 29234, model: 'claude-haiku-5-5' }

function spawnInput(over: Record<string, unknown>) {
  return {
    tool_use_id: 'toolu_1', prompt: 'Reply ok', description: 'a task', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...over,
  }
}

function beneath(on, ids: string[]) {
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: ids[n++] }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: [] }))
}

async function step($, agentId: string) {
  const s = $.turn.step({ turnId: 't-' + agentId, index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId })
  for await (const _ of s) {
    // drain
  }
}

test('hooks: a workflow agent is recorded with the agentId next(e) gave, steps, and turns done', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const st = watchState(on)
  beneath(on, ['aa1cb73e7de0a0378'])
  await $.agent.spawn(spawnInput({ description: 'R02-73 case read', subagentType: 'workflow-subagent', model: 'haiku', workflow: { runId: 'wf_1', agentIndex: 1 } }))
  let agents = st.agents()
  expect(agents.map((a) => a.id + ':' + a.status)).toEqual(['aa1cb73e7de0a0378:queued'])
  await step($, 'aa1cb73e7de0a0378')
  agents = st.agents()
  expect(agents[0]).toMatchObject({ status: 'running', effort: 'low', model: 'claude-haiku-5-5', steps: 1 })
  await $.turn.complete({ answer: 'ok', durationMs: 867, isAborted: false, turnId: 't-x', agentId: 'aa1cb73e7de0a0378', reason: 'answer', usage: USAGE })
  agents = st.agents()
  expect(agents[0].status).toBe('done')
  expect(st.log().map((l) => l.kind + ':' + l.agentId)).toEqual(['done:aa1cb73e7de0a0378'])
})

test('hooks: main-loop steps and turns record nothing; a BLOCKED answer is blocked', async ($, on) => {
  mock.clock(on, { now: 0 })
  const st = watchState(on)
  beneath(on, ['b1'])
  const s = $.turn.step({ turnId: 'main', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of s) {
    // drain
  }
  await $.turn.complete({ answer: 'BLOCKED: x', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })
  expect(st.agents().length).toBe(0)
  await $.agent.spawn(spawnInput({ subagentType: 'acme:implementer' }))
  await $.turn.complete({ answer: 'Read it.\nBLOCKED: which toggle', durationMs: 1, isAborted: false, turnId: 't', agentId: 'b1', reason: 'answer' })
  const agents = st.agents()
  expect(agents[0]).toMatchObject({ role: 'implementer', status: 'blocked', question: 'which toggle' })
})

test('hooks: the 15 s timer stalls a spawned agent that never steps, after startMinutes', { options: { startMinutes: 1, stallMinutes: 10 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, {})
  const st = watchState(on)
  beneath(on, ['s1'])
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  // what the band's theme refresh at session start asks for: no skins store, so ANSI
  on('session.cwd', async () => ({ value: '/tmp' }))
  on('config.list', async () => ({ value: [] }))
  on('ui.toast', async () => ({ value: {} }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.agent.spawn(spawnInput({}))
  await clock.advance(45_000)
  expect(st.agents()[0].status).toBe('queued')
  await clock.advance(15_000)
  expect(st.agents()[0].status).toBe('stalled')
  await step($, 's1')
  expect(st.agents()[0].status).toBe('running')
})

// ---------------------------------------------------------------- M5: router warnings and Workflow scripts

// The engine's tool: answers every tool call with `reply` (or a function of the event), and
// records the toasts the user would have seen.
function toolBeneath(on, reply: (e: { tool: string }, $: any) => Record<string, unknown> | Promise<Record<string, unknown>> = () => ({ result: 'ok' })) {
  const toasts: string[] = []
  on('tool.call', async ($, e) => reply(e, $))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: {} }
  })
  return toasts
}

const R1_SCOUT = 'waypoint: Agent "R02-41 scope read" (scout) names no model; pass model on every dispatch.'

test('router: an Agent call without model returns the note as context, toasts once, logs, and marks the row at spawn', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const st = watchState(on)
  const toasts = toolBeneath(on)
  beneath(on, ['ag1'])
  const input = { tool: 'Agent', description: 'R02-41 scope read', subagent_type: 'scout', prompt: 'Read one file.', tool_use_id: 'toolu_a1' }
  const result = await $.tool.call(input)
  expect(result.context).toEqual([R1_SCOUT])
  expect(result.result).toBe('ok')
  expect(toasts).toEqual([R1_SCOUT])
  expect(st.log().map((l) => l.kind)).toEqual(['warn'])
  expect(st.log()[0]).toMatchObject({ ref: 'R1', role: 'scout' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_a1', description: 'R02-41 scope read', subagentType: 'scout' }))
  const rec = st.agents()[0] as Rec & { warnings: string[] }
  expect(rec.warnings).toEqual(['R1 ' + R1_SCOUT])
})

test('router: the note is appended to a context the result already has', async ($, on) => {
  mock.clock(on, { now: 0 })
  watchState(on)
  toolBeneath(on, () => ({ result: 'ok', context: ['earlier note'] }))
  const result = await $.tool.call({ tool: 'Agent', description: 'd', subagent_type: 'hand', prompt: 'p', tool_use_id: 'toolu_a2' })
  expect(result.context).toEqual(['earlier note', expect.stringContaining('waypoint: Agent "d" (hand) names no model')])
})

test('router: a deny result is returned unchanged, with no context and no pending mark', async ($, on) => {
  mock.clock(on, { now: 0 })
  const st = watchState(on)
  toolBeneath(on, () => ({ deny: 'no agents today' }))
  beneath(on, ['ag3'])
  const result = await $.tool.call({ tool: 'Agent', description: 'd', subagent_type: 'scout', prompt: 'p', tool_use_id: 'toolu_a3' })
  expect(result).toEqual({ deny: 'no agents today' })
  // a later spawn under the same id does not inherit the denied call's warning
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_a3', subagentType: 'scout' }))
  expect((st.agents()[0] as Rec & { warnings: string[] }).warnings).toEqual([])
})

test('router: with no role file R3 never fires, even for a scout on opus; a fork and a named model say nothing', async ($, on) => {
  mock.clock(on, { now: 0 })
  watchState(on)
  const toasts = toolBeneath(on)
  const call = (over: Record<string, unknown>) => $.tool.call({ tool: 'Agent', description: 'sweep', prompt: 'p', tool_use_id: 'toolu_x', ...over })
  for (const quiet of [{ subagent_type: 'acme:scout', model: 'opus' }, { subagent_type: 'scout', model: 'haiku' }, { subagent_type: 'fork' }, { subagent_type: 'general-purpose', model: 'haiku' }]) {
    const r = await call(quiet)
    expect(r.context).toBe(undefined)
  }
  expect(toasts).toEqual([])
})

test('router: after the fact, with no role file, the first step adds no R3 and no R4 to a row that carries R1', async ($, on) => {
  mock.clock(on, { now: 5000 })
  const st = watchState(on)
  toolBeneath(on)
  beneath(on, ['sc1'])
  await $.tool.call({ tool: 'Agent', description: 'sweep', subagent_type: 'acme:scout', prompt: 'p', tool_use_id: 'toolu_s1' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_s1', description: 'sweep', subagentType: 'acme:scout' }))
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'sc1' })
  for await (const _ of s) {
    // drain
  }
  const rec = st.agents()[0] as Rec & { warnings: string[] }
  expect(rec.warnings.map((w) => w.slice(0, 2))).toEqual(['R1'])
  expect(st.log().map((l) => l.kind + ':' + (l as { ref?: string }).ref)).toEqual(['warn:R1'])
})

const SCRIPT = `export const meta = { name: 'tiny', description: 'two agents', phases: ['Build', 'Verify'] }
phase('Build')
const a = await agent('Reply ok', { label: 'R02-73 case read', phase: 'Build', model: 'haiku', effort: 'low' })
phase('Verify')
const b = await agent('Reply ok', { label: 'API1 endpoint list', phase: 'Verify', model: 'haiku' })
return [a, b]`

const R2_TINY = 'waypoint: Workflow "tiny": 1 agent() call(s) without model or effort: "API1 endpoint list". Pass both on every call.'

function wfSpawn(index: number, label: string, runId = 'wf_9') {
  return spawnInput({ tool_use_id: 'toolu_wf', description: label, subagentType: 'workflow-subagent', model: 'haiku', workflow: { runId, agentIndex: index } })
}

test('router: a Workflow script is parsed at the call; R2 is the context; the spawns join phase, model and effort', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const st = watchState(on)
  const toasts = toolBeneath(on, () => ({ result: { status: 'async_launched', runId: 'wf_9', taskId: 't', workflowName: 'tiny' } }))
  beneath(on, ['w1', 'w2'])
  const result = await $.tool.call({ tool: 'Workflow', script: SCRIPT, tool_use_id: 'toolu_wf' })
  expect(result.context).toEqual([R2_TINY])
  expect(toasts).toEqual([R2_TINY])
  expect(st.log().map((l) => (l as { ref?: string }).ref)).toEqual(['R2'])
  // two planned calls, queued, with the run bound once the call returned
  let agents = st.agents() as Array<Rec & { planned?: boolean; phase?: string; warnings: string[]; requestedModel?: string }>
  expect(agents.map((a) => a.id + ':' + a.planned)).toEqual(['wf:wf_9:1:true', 'wf:wf_9:2:true'])
  await $.agent.spawn(wfSpawn(1, 'R02-73 case read'))
  await $.agent.spawn(wfSpawn(2, 'API1 endpoint list'))
  agents = st.agents() as typeof agents
  expect(agents.map((a) => a.id)).toEqual(['w1', 'w2'])
  expect(agents[0]).toMatchObject({ phase: 'Build', requestedModel: 'haiku', effort: 'low', warnings: [] })
  expect(agents[1]).toMatchObject({ phase: 'Verify', requestedModel: 'haiku' })
  expect(agents[1].effort).toBe(undefined)
  expect(agents[1].warnings).toEqual(['R2 ' + R2_TINY])
})

test('router: a name and a label carrying escape sequences reach the toast, the context and the record clean', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const st = watchState(on)
  const toasts = toolBeneath(on, () => ({ result: { runId: 'wf_e' } }))
  const script = "export const meta = { name: 'ev\u001b]0;pwn\u0007il', description: 'd', phases: [] }\nawait agent('p', { label: 'a\u001b[31mb\u0007c' })"
  expect(script).toContain('\u001b')
  const result = await $.tool.call({ tool: 'Workflow', script, tool_use_id: 'toolu_e' })
  const want = 'waypoint: Workflow "evil": 1 agent() call(s) without model or effort: "abc". Pass both on every call.'
  expect(result.context).toEqual([want])
  expect(toasts).toEqual([want])
  expect((st.agents() as Array<{ warnings: string[] }>)[0].warnings).toEqual(['R2 ' + want])
})

test('router: agents that spawn while the Workflow call is still running join through the tool_use_id', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const st = watchState(on)
  beneath(on, ['w1'])
  // the engine's tool holds its answer while the test spawns an agent, as a running Workflow does
  let release = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  toolBeneath(on, async () => {
    await gate
    return { result: { runId: 'wf_9' } }
  })
  const call = $.tool.call({ tool: 'Workflow', script: SCRIPT, tool_use_id: 'toolu_wf' })
  await new Promise((r) => setTimeout(r, 30))
  await $.agent.spawn(wfSpawn(1, 'R02-73 case read'))
  release()
  await call
  const agents = st.agents() as Array<Rec & { phase?: string; planned?: boolean }>
  expect(agents.find((a) => a.id === 'w1')).toMatchObject({ phase: 'Build', effort: 'low' })
})

test('router: a script is read from scriptPath, which the tool prefers to an inline script', async ($, on) => {
  mock.clock(on, { now: 0 })
  const st = watchState(on)
  toolBeneath(on, () => ({ result: { runId: 'wf_p' } }))
  const reads: string[] = []
  on('fs.read', async (_$, e) => {
    reads.push(e.path)
    return { value: SCRIPT }
  })
  // the script sits inside the project (SPEC 14: only there or in the config directory is it read)
  on('session.cwd', async () => ({ value: '/tmp/s' }))
  on('fs.stat', async (_$, e) => ({ value: { kind: e.path === '/tmp/s' ? 'dir' : 'file', size: 1, mtimeMs: 1, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }))
  const result = await $.tool.call({ tool: 'Workflow', scriptPath: '/tmp/s/tiny.js', script: "agent('x')", tool_use_id: 'toolu_wp' })
  expect(reads).toEqual(['/tmp/s/tiny.js'])
  expect(result.context).toEqual([R2_TINY])
  expect(st.agents().length).toBe(2)
})

test('router: a clean script, a named workflow and a denied call add no context; a denied call drops its planned agents', async ($, on) => {
  mock.clock(on, { now: 0 })
  const st = watchState(on)
  const toasts = toolBeneath(on, () => ({ result: { runId: 'wf_c' } }))
  const clean = "export const meta = { name: 'c', description: 'd', phases: [] }\nawait agent('p', { label: 'one', model: 'haiku', effort: 'low' })"
  const r = await $.tool.call({ tool: 'Workflow', script: clean, tool_use_id: 'toolu_c' })
  expect(r.context).toBe(undefined)
  expect(toasts).toEqual([])
  expect(st.agents().length).toBe(1) // planned, with its phase and model, but no warning
  expect((await $.tool.call({ tool: 'Workflow', name: 'built-in', tool_use_id: 'toolu_n' })).context).toBe(undefined)
})

test('router: a denied Workflow call returns unchanged and leaves no planned agents', async ($, on) => {
  mock.clock(on, { now: 0 })
  const st = watchState(on)
  toolBeneath(on, () => ({ deny: 'not now' }))
  const result = await $.tool.call({ tool: 'Workflow', script: SCRIPT, tool_use_id: 'toolu_d' })
  expect(result).toEqual({ deny: 'not now' })
  expect(st.agents()).toEqual([])
})


// ---------------------------------------------------------------- M6: usage, prices, compact hint

type UsageState = { percent?: number; tokens?: number; window?: number; usd?: number; hint?: string }

// The engine's `$.session.usage()`: answers whatever `figures` holds now and counts the calls.
function usageBeneath(on, figures: { percent?: number; usd?: number }) {
  const calls = { n: 0 }
  on('session.usage', async () => {
    calls.n++
    const context = { window: 200_000, ...(figures.percent !== undefined ? { percent: figures.percent, tokens: figures.percent * 2000 } : {}) }
    return { value: { context, rateLimits: [], ...(figures.usd !== undefined ? { cost: { usd: figures.usd } } : {}) } }
  })
  return calls
}

// What the hooks wrote to the `usage` atom: the last value and how many writes.
function watchUsage(on) {
  const seen = { writes: 0, last: undefined as UsageState | null | undefined }
  on('state.set', async ($, e, next) => {
    if (e.plugin === 'waypoint' && e.key === 'usage') {
      seen.writes++
      seen.last = e.value as UsageState | null
    }
    return next(e)
  })
  return seen
}

async function mainStep($) {
  for await (const _ of $.turn.step({ turnId: 'main', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
}
const mainComplete = ($) => $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })

test('usage: a main-loop step and complete write context and exact session cost; a subagent step does not ask', async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, ['u1'])
  const calls = usageBeneath(on, { percent: 42, usd: 12.34 })
  const seen = watchUsage(on)
  await mainStep($)
  expect(seen.last).toEqual({ percent: 42, tokens: 84_000, window: 200_000, usd: 12.34, hint: null })
  expect(calls.n).toBe(1)
  await $.agent.spawn(spawnInput({}))
  await step($, 'u1')
  expect(calls.n).toBe(1)
})

test('usage: a write is skipped when the percent and cost are unchanged, made when either moves', async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, [])
  const figures: { percent?: number; usd?: number } = { percent: 42, usd: 12.34 }
  const calls = usageBeneath(on, figures)
  const seen = watchUsage(on)
  await mainStep($)
  await mainStep($)
  await mainComplete($)
  expect(calls.n).toBe(3)
  expect(seen.writes).toBe(1)
  figures.usd = 12.5
  await mainStep($)
  expect(seen.writes).toBe(2)
  expect(seen.last).toMatchObject({ percent: 42, usd: 12.5 })
  figures.percent = 43
  await mainStep($)
  expect(seen.writes).toBe(3)
})

test('usage: no cost in the answer leaves usd out, and no percent yet leaves percent out', async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, [])
  usageBeneath(on, {})
  const seen = watchUsage(on)
  await mainStep($)
  expect(seen.last).toEqual({ window: 200_000, hint: null })
})

test('usage: a failing session.usage call leaves the atom alone and the step through', async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, [])
  on('session.usage', async () => {
    throw new Error('no ledger')
  })
  const seen = watchUsage(on)
  await mainStep($)
  expect(seen.writes).toBe(0)
})

test('hint: off below the threshold, armed from it', { options: { compactAtPercent: 70 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, [])
  const figures = { percent: 69, usd: 1 }
  usageBeneath(on, figures)
  const seen = watchUsage(on)
  await mainStep($)
  expect(seen.last?.hint).toBe(null)
  figures.percent = 70
  await mainStep($)
  expect(seen.last?.hint).toBe('compact-at-next-boundary')
})

test('hint: compact-now only at a main-loop turn.complete after an agent finished with none running; hidden at the next spawn', { options: { compactAtPercent: 50 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, ['h1', 'h2'])
  usageBeneath(on, { percent: 60, usd: 1 })
  const seen = watchUsage(on)
  await mainStep($)
  expect(seen.last?.hint).toBe('compact-at-next-boundary')
  // mid-task: an agent is running when the main loop's turn completes
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_h1' }))
  await step($, 'h1')
  await mainComplete($)
  expect(seen.last?.hint).toBe('compact-at-next-boundary')
  // the agent finishes; the main loop's turn completes: a boundary
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-h1', agentId: 'h1', reason: 'answer', usage: USAGE })
  expect(seen.last?.hint).toBe('compact-at-next-boundary') // a subagent's complete is not the main loop's
  await mainComplete($)
  expect(seen.last?.hint).toBe('compact-now')
  // a main-loop step in the same session keeps it shown
  await mainStep($)
  expect(seen.last?.hint).toBe('compact-now')
  // the next spawn is work on something else
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_h2', description: 'next' }))
  expect(seen.last?.hint).toBe('compact-at-next-boundary')
  // that agent finishes, and the boundary shows again
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-h2', agentId: 'h2', reason: 'answer', usage: USAGE })
  await mainComplete($)
  expect(seen.last?.hint).toBe('compact-now')
})

test('hint: a main-loop turn.complete with no agent ever finished is not a boundary', { options: { compactAtPercent: 50 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, [])
  usageBeneath(on, { percent: 80 })
  const seen = watchUsage(on)
  await mainStep($)
  await mainComplete($)
  expect(seen.last?.hint).toBe('compact-at-next-boundary')
})

test('hint: below the threshold a boundary shows nothing, and compacting clears a shown hint', { options: { compactAtPercent: 50 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, ['k1'])
  const figures = { percent: 60 }
  usageBeneath(on, figures)
  const seen = watchUsage(on)
  await $.agent.spawn(spawnInput({}))
  await step($, 'k1')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-k1', agentId: 'k1', reason: 'answer', usage: USAGE })
  await mainComplete($)
  expect(seen.last?.hint).toBe('compact-now')
  figures.percent = 8 // after /compact the next response reports the small window
  await mainStep($)
  expect(seen.last?.hint).toBe(null)
})

test('hint: a Workflow call hides a shown hint', { options: { compactAtPercent: 50 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, ['w1'])
  toolBeneath(on, () => ({ result: { runId: 'wf_h' } }))
  usageBeneath(on, { percent: 60 })
  const seen = watchUsage(on)
  await $.agent.spawn(spawnInput({}))
  await step($, 'w1')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-w1', agentId: 'w1', reason: 'answer', usage: USAGE })
  await mainComplete($)
  expect(seen.last?.hint).toBe('compact-now')
  await $.tool.call({ tool: 'Workflow', script: "export const meta = { name: 'c', description: 'd', phases: [] }\nawait agent('p', { label: 'one', model: 'haiku', effort: 'low' })", tool_use_id: 'toolu_hw' })
  expect(seen.last?.hint).toBe('compact-at-next-boundary')
})

test('hint: a turn.start with no task named keeps it; the turn.start event is observed, not gated', { options: { compactAtPercent: 50 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, ['t1'])
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  usageBeneath(on, { percent: 60 })
  const seen = watchUsage(on)
  await $.agent.spawn(spawnInput({}))
  await step($, 't1')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-t1', agentId: 't1', reason: 'answer', usage: USAGE })
  await mainComplete($)
  expect(seen.last?.hint).toBe('compact-now')
  const r = await $.turn.start({ text: 'thanks, that looks right', turnId: 'main2' })
  expect(r).toEqual({ turnId: 'main2' })
  expect(seen.last?.hint).toBe('compact-now')
})

test('prices: a subagent step and its completion are priced once into estUsd and the done entry', async ($, on) => {
  mock.clock(on, { now: 0 })
  const st = watchState(on)
  beneath(on, ['p1'])
  await $.agent.spawn(spawnInput({}))
  await step($, 'p1')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-p1', agentId: 'p1', reason: 'answer', usage: USAGE })
  // haiku-5-5: 2 in at 0.10, 4 out at 0.50, 29234 cache write at the 1h rate 0.20, per million
  const expected = (2 * 0.1 + 4 * 0.5 + 29234 * 0.2) / 1_000_000
  const rec = st.agents()[0] as Rec & { estUsd: number; tokens: { in: number; cacheWrite: number } }
  expect(rec.tokens).toMatchObject({ in: 2, cacheWrite: 29234 })
  expect(rec.estUsd.toFixed(9)).toBe(expected.toFixed(9))
  expect((st.log()[0] as { estUsd?: number }).estUsd?.toFixed(9)).toBe(expected.toFixed(9))
})

test('usage: session.measure, which the engine raises once the turn is in the ledger, refreshes the figures and keeps the hint', { options: { compactAtPercent: 50 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  beneath(on, [])
  // at the turn's own events the ledger has not yet taken the last response
  const figures = { percent: 60, usd: 0.257 }
  usageBeneath(on, figures)
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  const seen = watchUsage(on)
  await mainStep($)
  await mainComplete($)
  expect(seen.last).toMatchObject({ percent: 60, usd: 0.257, hint: 'compact-at-next-boundary' })
  const writes = seen.writes
  await $.session.measure({ context: { window: 200_000, tokens: 120_000, percent: 60 }, rateLimits: [], cost: { usd: 0.2701 }, changed: ['cost'] })
  expect(seen.last).toEqual({ percent: 60, tokens: 120_000, window: 200_000, usd: 0.2701, hint: 'compact-at-next-boundary' })
  expect(seen.writes).toBe(writes + 1)
  // the same figures again write nothing
  await $.session.measure({ context: { window: 200_000, tokens: 120_000, percent: 60 }, rateLimits: [], cost: { usd: 0.2701 }, changed: ['rateLimits'] })
  expect(seen.writes).toBe(writes + 1)
  // a cost-less measure drops usd rather than keeping a stale one
  await $.session.measure({ context: { window: 200_000, percent: 40 }, rateLimits: [], changed: ['context'] })
  expect(seen.last).toEqual({ percent: 40, window: 200_000, hint: null })
})

test('usage: the 15 s timer reads the ledger too, so spend outside a turn reaches the figure; it writes only on a change', { options: { compactAtPercent: 50 } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, {})
  beneath(on, [])
  const figures = { percent: 60, usd: 0.22 }
  const calls = usageBeneath(on, figures)
  const seen = watchUsage(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/tmp' }))
  on('config.list', async () => ({ value: [] }))
  on('ui.toast', async () => ({ value: {} }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await mainStep($)
  expect(seen.last).toMatchObject({ usd: 0.22, hint: 'compact-at-next-boundary' })
  const writes = seen.writes
  const before = calls.n
  await clock.advance(15_000)
  expect(calls.n).toBeGreaterThan(before)
  expect(seen.writes).toBe(writes) // nothing moved: no write
  figures.usd = 0.28 // a background call outside any turn
  await clock.advance(15_000)
  expect(seen.last).toMatchObject({ usd: 0.28, hint: 'compact-at-next-boundary' })
  expect(seen.writes).toBe(writes + 1)
})

// ---------------------------------------------------------------- batch B: failure containment

test('containment: a band start that throws still registers the tool and the command, and logs', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, {})
  const registered: string[] = []
  const logs: string[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => {
    throw new Error('cwd gone')
  })
  on('config.list', async () => {
    throw new Error('config gone')
  })
  on('tool.register', async (_$, e) => {
    registered.push('tool:' + e.name)
    return { value: undefined }
  })
  on('command.register', async (_$, e) => {
    registered.push('command:' + e.name)
    return { value: undefined }
  })
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  expect(registered.sort()).toEqual(['command:waypoint', 'tool:waypoint'])
  expect(logs.some((l) => l.startsWith('waypoint: band: '))).toBe(true)
  await clock.advance(30_000)
})

test('containment: an agent.spawn without a prompt still records the agent', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const st = watchState(on)
  beneath(on, ['np1'])
  await $.agent.spawn(spawnInput({ prompt: undefined }))
  expect(st.agents().map((a) => a.id)).toEqual(['np1'])
})

test('containment: a Workflow script with an invalid code point does not fail the call and marks the call dynamic', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const st = watchState(on)
  const toasts = toolBeneath(on, () => ({ result: { status: 'async_launched', runId: 'wf_x', taskId: 't', workflowName: 'bad' } }))
  beneath(on, [])
  const script = "const a = await agent('x', { label: 'q\\u{110000}' })"
  const result = await $.tool.call({ tool: 'Workflow', script, tool_use_id: 'toolu_bad' })
  expect(result.result).toMatchObject({ runId: 'wf_x' })
  expect(result.context).toBe(undefined)
  expect(toasts).toEqual([])
  expect(st.agents().map((a) => a.id)).toEqual(['wf:wf_x:1'])
})

// ---------------------------------------------------------------- batch B: theme polling

function themeWorld(on) {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { HOME: '/h' })
  const calls = { reads: 0, lists: 0, stats: [] as string[], processes: 0 }
  let storeMtime = 1
  const files: Record<string, string> = {
    '/h/.claude/plugins/store/skins_example-mods-abc123.json': JSON.stringify({ prefs: { skin: 'noir', icons: 'unicode' } }),
    '/w/plan.md': '- [ ] T1 one\n',
  }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/w' }))
  on('session.id', async () => ({ value: 's' }))
  on('config.list', async () => ({ value: [] }))
  on('settings.read', async () => ({ value: { enabledPlugins: { 'skins@example-mods': true } } }))
  on('ui.toast', async () => ({ value: {} }))
  on('ui.log', async () => ({ value: undefined }))
  on('store.get', async () => ({ value: undefined }))
  on('store.set', async () => ({ value: undefined }))
  on('store.keys', async () => ({ value: [] }))
  on('fs.list', async (_$, e) => {
    calls.lists++
    if (e.path === '/h/.claude/plugins/store') return { value: [{ name: 'skins_example-mods-abc123.json', kind: 'file' }] }
    return { value: [] }
  })
  on('fs.read', async (_$, e) => {
    if (e.path.includes('/plugins/store/')) calls.reads++
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('fs.stat', async (_$, e) => {
    calls.stats.push(e.path)
    const realPath = e.resolve ? { realPath: e.path } : {}
    if (e.path === '/w') return { value: { kind: 'dir', size: 0, mtimeMs: 5, ...realPath } }
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: e.path.includes('/plugins/store/') ? storeMtime : 5, ...realPath } }
  })
  on('process.run', async () => {
    calls.processes++
    return { value: { exitCode: 0, stdout: 'Dark\n', stderr: '' } }
  })
  return { clock, calls, touchStore: () => storeMtime++ }
}

test('theme: a quiet session only stats the store file, every tenth second, and never re-reads it', async ($, on) => {
  const t = themeWorld(on)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  expect(t.calls.reads).toBe(1)
  const lists = t.calls.lists
  await t.clock.advance(5 * 60_000)
  expect(t.calls.reads).toBe(1)
  expect(t.calls.lists).toBe(lists)
  const storeStats = t.calls.stats.filter((p) => p.includes('/plugins/store/')).length
  expect(storeStats).toBeGreaterThan(0)
  expect(storeStats).toBeLessThanOrEqual(31)
  expect(t.calls.stats.filter((p) => !p.includes('/plugins/store/') && !p.endsWith('waypoint-roles.json')).length).toBe(0)
  expect(t.calls.processes).toBe(0)
})

test('theme: once something is tracked a changed store file is re-read at the next tenth second, an unchanged one is not', async ($, on) => {
  const t = themeWorld(on)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__waypoint__waypoint', tool_use_id: 'a', action: 'track', file: '/w/plan.md' })
  await t.clock.advance(50_000)
  expect(t.calls.reads).toBe(1)
  t.touchStore()
  await t.clock.advance(10_000)
  expect(t.calls.reads).toBe(2)
  await t.clock.advance(40_000)
  expect(t.calls.reads).toBe(2)
})

test('theme: nothing in the plugin starts a subprocess, however long a tracked session runs', async ($, on) => {
  const t = themeWorld(on)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__waypoint__waypoint', tool_use_id: 'a', action: 'track', file: '/w/plan.md' })
  await t.clock.advance(5 * 60_000)
  expect(t.calls.processes).toBe(0)
})
