import { expect, test } from 'claude-code/testing'
import { bindAgent, joinSpawn, spawnAgent, stepStart, tick } from '../plugin/hooks/agents.ts'
import type { AgentRecord, JoinHints } from '../plugin/hooks/agents.ts'
import { costOf } from '../plugin/hooks/prices.ts'
import { register } from '../plugin/hooks/register.tsx'
import { PLAN, start, TOOL, world } from './world.ts'

// The spawn join corrected (SPEC 5.1): the Agent tool's result, which names the call's agentId, is
// authoritative over any join made from hints; workflow spawns are candidates only in live runs and
// only while they are not stalled; a fork never takes a lone waiting spawn; the head is searched in
// the transcript's first 64 KiB, with the list row behind it; a transcript is read once per agentId.

type A = AgentRecord

const USAGE = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }
const HAIKU = 'claude-haiku-5-5'
const SONNET = 'claude-sonnet-5-5'

function spawnInput(over: Record<string, unknown>) {
  return {
    tool_use_id: 'toolu_1', prompt: 'Reply ok', description: 'a task', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...over,
  }
}

// The engine beneath the plugin. `prompts`: each agent's transcript opening, by agentId (else the
// read is refused); `rows`: `$.agent.list()`; `results`: the Agent call's agentId, by tool_use_id.
function engine(on, o: { prompts?: Record<string, string>; rows?: Array<{ id: string; description: string; type: string; status: string }>; results?: Record<string, string>; reads?: string[] } = {}) {
  on('agent.spawn', async () => ({ model: HAIKU, agentId: 'unused' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: e.model } }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: o.rows ?? [] }))
  on('session.messages', async (_$, e) => {
    o.reads?.push(e.agentId)
    const p = e.agentId !== undefined ? o.prompts?.[e.agentId] : undefined
    if (p === undefined) return { value: { deny: 'not this session' } }
    return { value: [{ role: 'user', text: p, toolUses: [] }, { role: 'assistant', text: 'working', toolUses: [] }] }
  })
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Workflow') return { result: { runId: e.runId ?? 'wf_9' } }
    return { result: { status: 'completed', agentId: o.results?.[e.tool_use_id], content: [] } }
  })
}

async function step($, agentId: string, model = HAIKU, effort = 'low') {
  for await (const _ of $.turn.step({ turnId: 't-' + agentId, index: 0, model, effort, messageCount: 1, agentId })) {
    // drain
  }
}

async function complete($, agentId: string) {
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-' + agentId, agentId, reason: 'answer', usage: USAGE })
}

async function agentResult($, toolUseId: string, description = 'step') {
  await $.tool.call({ tool: 'Agent', description, subagent_type: 'general-purpose', model: 'haiku', prompt: 'p', tool_use_id: toolUseId })
}

const usd = (model: string, n: number) => n * costOf(model, { ...USAGE, model }).usd
const near = (got: number, want: number) => expect(Math.abs(got - want) < 1e-12 && want > 0).toBe(true)

// ---------------------------------------------------------------- 1. the Agent result is authoritative

const SAME_HEAD = 'Read the repository below and report what each module does, in order, with file paths and a one-line summary of every exported function; do not edit anything and keep it short. '.repeat(2)

test('rejoin: two crossed Agent spawns with one prompt head, description and type are put right by their results', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN } })
  const a = SAME_HEAD + 'Then check T2.'
  const b = SAME_HEAD + 'Then check T3.'
  expect(SAME_HEAD.length).toBeGreaterThan(300)
  engine(on, {
    prompts: { a1: a, b1: b },
    rows: [
      { id: 'a1', description: 'step', type: 'general-purpose', status: 'running' },
      { id: 'b1', description: 'step', type: 'general-purpose', status: 'running' },
    ],
    results: { toolu_a: 'a1', toolu_b: 'b1' },
  })
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 'tr', action: 'track', file: '/w/plan.md', section: 'Work', doneRule: 'column=landed' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_a', description: 'step', prompt: a }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_b', description: 'step', prompt: b }))
  // B steps first, twice on sonnet, and finishes; A steps once on haiku
  await step($, 'b1', SONNET)
  await step($, 'b1', SONNET)
  await complete($, 'b1')
  await step($, 'a1', HAIKU)
  await agentResult($, 'toolu_b')
  await agentResult($, 'toolu_a')
  const agents = w.last.agents as A[]
  expect(agents.length).toBe(2)
  const byCall = Object.fromEntries(agents.map((r) => [r.toolUseId, r]))
  expect([byCall.toolu_a.id, byCall.toolu_a.agentId, byCall.toolu_a.steps, byCall.toolu_a.model, byCall.toolu_a.status]).toEqual(['a1', 'a1', 1, HAIKU, 'running'])
  expect([byCall.toolu_b.id, byCall.toolu_b.agentId, byCall.toolu_b.steps, byCall.toolu_b.model, byCall.toolu_b.status]).toEqual(['b1', 'b1', 2, SONNET, 'done'])
  expect(byCall.toolu_a.taskIds).toEqual(['T2'])
  expect(byCall.toolu_b.taskIds).toEqual(['T3'])
  near(byCall.toolu_a.estUsd, usd(HAIKU, 1))
  near(byCall.toolu_b.estUsd, usd(SONNET, 2))
  // the done entry B's agent wrote while it sat on A's spawn now names B's task
  const done = (w.last.log as Array<{ kind: string; ref: string; agentId?: string }>).filter((l) => l.kind === 'done')
  expect(done.map((l) => l.agentId + ':' + l.ref)).toEqual(['b1:T3'])
})

const NOW = 1000
function spawned(toolUseId: string, description = 'd'): AgentRecord[] {
  return spawnAgent([], { at: NOW, toolUseId, description, subagentType: 'general-purpose' }, { plan: null }).agents
}
const end = (agents: AgentRecord[], agentId: string, model: string) =>
  agents.map((r) => (r.agentId === agentId ? { ...r, tokens: { in: 1000, out: 100, cacheRead: 0, cacheWrite: 0 }, estUsd: usd(model, 1) } : r))

test('bindAgent: a spawn joined to an unknown agent gives that agent back as a provisional record and takes its own', () => {
  // the spawn took a fork's agent (y1); its own agent (x1) stepped as a provisional record
  let agents = spawned('toolu_x', 'x')
  agents = agents.map((r) => ({ ...r, id: 'y1', agentId: 'y1' }))
  agents = end(stepStart(agents, { at: NOW + 1, agentId: 'y1', model: SONNET }).agents, 'y1', SONNET)
  agents = [...agents, ...spawned('toolu_other', 'other')]
  agents = end(stepStart(agents, { at: NOW + 2, agentId: 'x1', model: HAIKU }).agents, 'x1', HAIKU)
  expect(agents.filter((r) => r.provisional).map((r) => r.agentId)).toEqual(['x1'])
  const out = bindAgent(agents, 'toolu_x', 'x1', NOW + 3)
  expect(out.changed).toBe(true)
  const mine = out.agents.find((r) => r.toolUseId === 'toolu_x')!
  expect([mine.id, mine.agentId, mine.steps, mine.model, mine.provisional]).toEqual(['x1', 'x1', 1, HAIKU, undefined])
  near(mine.estUsd, usd(HAIKU, 1))
  const back = out.agents.filter((r) => r.provisional)
  expect(back.map((r) => [r.id, r.agentId, r.steps, r.model])).toEqual([['y1', 'y1', 1, SONNET]])
  near(back[0].estUsd, usd(SONNET, 1))
  // nothing counted twice
  const total = out.agents.reduce((s, r) => s + r.estUsd, 0)
  near(total, usd(HAIKU, 1) + usd(SONNET, 1))
  expect(out.agents.reduce((s, r) => s + r.steps, 0)).toBe(2)
})

test('bindAgent: a spawn whose agent has not stepped yet takes it fresh, and the agent it held goes back as provisional', () => {
  let agents = spawned('toolu_x', 'x').map((r) => ({ ...r, id: 'y1', agentId: 'y1' }))
  agents = stepStart(agents, { at: NOW + 1, agentId: 'y1', model: SONNET }).agents
  const out = bindAgent(agents, 'toolu_x', 'x1', NOW + 3).agents
  const mine = out.find((r) => r.toolUseId === 'toolu_x')!
  expect([mine.id, mine.agentId, mine.steps, mine.status, mine.model, mine.firstStepAt]).toEqual(['x1', 'x1', 0, 'queued', undefined, undefined])
  expect(out.filter((r) => r.provisional).map((r) => r.id + ':' + r.steps)).toEqual(['y1:1'])
})

test('bindAgent: an agent that a workflow spawn took goes to its Agent call, and the workflow spawn waits again', () => {
  const wf = spawnAgent([], { at: NOW, toolUseId: 'toolu_wf', description: 'R1', subagentType: 'workflow-subagent', workflow: { runId: 'wf_1', agentIndex: 1 } }, { plan: null }).agents
  let agents = [...wf, ...spawned('toolu_x', 'x')]
  agents = agents.map((r) => (r.runId ? { ...r, id: 'x1', agentId: 'x1' } : r))
  agents = stepStart(agents, { at: NOW + 1, agentId: 'x1', model: HAIKU }).agents
  const out = bindAgent(agents, 'toolu_x', 'x1', NOW + 3).agents
  expect(out.map((r) => r.id + ':' + (r.agentId ?? '-') + ':' + r.steps + ':' + r.status)).toEqual(['wf:wf_1:1:-:0:queued', 'x1:x1:1:running'])
})

// ---------------------------------------------------------------- 2. workflow candidates: live runs, not stalled

function wfSpawn(agents: AgentRecord[], at: number, runId: string, agentIndex: number, requestedModel = 'haiku', effort?: string): AgentRecord[] {
  const next = spawnAgent(agents, { at, toolUseId: 'toolu_' + runId, description: runId + ' #' + agentIndex, subagentType: 'workflow-subagent', requestedModel, workflow: { runId, agentIndex } }, { plan: null }).agents
  return effort === undefined ? next : next.map((r) => (r.runId === runId && r.agentIndex === agentIndex ? { ...r, effort } : r))
}
const hints = (model = HAIKU, effort = 'low'): JoinHints => ({ prompts: {}, model, effort })

test('joinSpawn: an old run\'s never-started spawn does not capture a later run\'s agent', () => {
  let agents = wfSpawn([], NOW, 'wf_old', 1)
  agents = wfSpawn(agents, NOW + 30_000, 'wf_new', 1)
  expect(joinSpawn(agents, hints(), NOW + 31_000)).toBe(1)
})

test('joinSpawn: a stalled workflow spawn is never a candidate', () => {
  let agents = wfSpawn([], NOW, 'wf_old', 1)
  agents = tick(agents, { at: NOW + 3 * 60_000, stallMs: 10 * 60_000, startMs: 2 * 60_000 }).agents
  expect(agents[0].status).toBe('stalled')
  agents = wfSpawn(agents, NOW + 3 * 60_000, 'wf_new', 1, 'sonnet')
  // the new run's spawn does not fit a haiku step; the stalled one would, and is not taken
  expect(joinSpawn(agents, hints(HAIKU), NOW + 3 * 60_000 + 1)).toBe(-1)
})

test('joinSpawn: overlapping runs: the older run\'s late agent joins once the newer run has no spawn that fits', () => {
  let agents = wfSpawn([], NOW, 'wf_1', 1)
  agents = wfSpawn(agents, NOW, 'wf_1', 2)
  agents = wfSpawn(agents, NOW + 5_000, 'wf_2', 1)
  // the newer run's agent joins the newer run's spawn
  const j = joinSpawn(agents, hints(), NOW + 6_000)
  expect(agents[j].runId).toBe('wf_2')
  agents = stepStart(agents, { at: NOW + 6_000, agentId: 'n1', model: HAIKU, join: hints() }).agents
  expect(agents.find((r) => r.agentId === 'n1')!.runId).toBe('wf_2')
  // the older run's agents then join the older run's spawns, in agentIndex order
  agents = stepStart(agents, { at: NOW + 7_000, agentId: 'o1', model: HAIKU, join: hints() }).agents
  agents = stepStart(agents, { at: NOW + 8_000, agentId: 'o2', model: HAIKU, join: hints() }).agents
  expect(agents.map((r) => r.id).sort()).toEqual(['n1', 'o1', 'o2'])
  expect(agents.find((r) => r.agentId === 'o1')!.agentIndex).toBe(1)
  // a newer run whose spawn waits on another model leaves an older run's fitting spawn to the step
  let mixed = wfSpawn([], NOW, 'wf_1', 1, 'haiku')
  mixed = wfSpawn(mixed, NOW + 5_000, 'wf_2', 1, 'sonnet')
  expect(mixed[joinSpawn(mixed, hints(HAIKU), NOW + 6_000)].runId).toBe('wf_1')
})

test('joinSpawn: a stalled workflow agent\'s retry (a new agentId, no spawn) does not take a waiting sibling', () => {
  let agents = wfSpawn([], NOW, 'wf_1', 1)
  agents = wfSpawn(agents, NOW, 'wf_1', 2)
  agents = stepStart(agents, { at: NOW + 1_000, agentId: 'w1', model: HAIKU, join: hints() }).agents
  // agent 2 never starts; agent 1 goes quiet; both are marked stalled
  agents = tick(agents, { at: NOW + 11 * 60_000, stallMs: 10 * 60_000, startMs: 2 * 60_000 }).agents
  expect(agents.map((r) => r.status)).toEqual(['stalled', 'stalled'])
  agents = stepStart(agents, { at: NOW + 11 * 60_000 + 1, agentId: 'retry1', model: HAIKU, join: hints() }).agents
  expect(agents.find((r) => r.agentId === 'retry1')!.provisional).toBe(true)
  expect(agents.find((r) => r.agentIndex === 2)!.agentId).toBeUndefined()
})

// ---------------------------------------------------------------- 3. a fork does not take a lone waiting spawn

test('spawn: an unreadable, unlisted agent stepping first does not take a lone waiting Agent-tool spawn', async ($, on) => {
  const w = world(on, {})
  engine(on, { prompts: { a1: 'step 1: read the parser' } })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_a', description: 'one', prompt: 'step 1: read the parser' }))
  await step($, 'fork1')
  let agents = w.last.agents as A[]
  expect(agents.map((r) => r.id + ':' + (r.provisional ? 'p' : 'r'))).toEqual(['toolu_a:r', 'fork1:p'])
  await step($, 'a1')
  agents = w.last.agents as A[]
  expect(agents.find((r) => r.toolUseId === 'toolu_a')!.agentId).toBe('a1')
})

// ---------------------------------------------------------------- 4. workflow fit

const XHIGH_SCRIPT = `export const meta = { name: 'tiny', description: 'two agents' }
const a = await agent('Read the config', { label: 'read one', model: 'haiku', effort: 'xhigh' })`

test('spawn: a workflow agent whose step reports another effort than the script set still joins its spawn', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await $.tool.call({ tool: 'Workflow', script: XHIGH_SCRIPT, tool_use_id: 'toolu_wf' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_wf', description: 'read one', prompt: 'Read the config', subagentType: 'workflow-subagent', model: 'haiku', workflow: { runId: 'wf_9', agentIndex: 1 } }))
  await step($, 'w1', HAIKU, 'high')
  const agents = w.last.agents as A[]
  expect(agents.map((r) => r.id + ':' + r.label + ':' + r.status)).toEqual(['w1:read one:running'])
})

test('joinSpawn: effort only breaks a tie between spawns that fit the model', () => {
  let agents = wfSpawn([], NOW, 'wf_1', 1, 'haiku', 'low')
  agents = wfSpawn(agents, NOW, 'wf_1', 2, 'haiku', 'high')
  expect(joinSpawn(agents, hints(HAIKU, 'high'), NOW + 1)).toBe(1)
  expect(joinSpawn(agents, hints(HAIKU, 'medium'), NOW + 1)).toBe(0)
  // a model family on only one side does not rule a spawn out
  const loose = wfSpawn([], NOW, 'wf_1', 1, 'claude-x', 'low')
  expect(joinSpawn(loose, hints(SONNET, 'max'), NOW + 1)).toBe(0)
})

// ---------------------------------------------------------------- 5. head search

test('joinSpawn: the head is found past the first 8 KiB of a transcript, within 64 KiB', () => {
  const agents = [...spawned('toolu_a', 'a'), ...spawned('toolu_b', 'b')]
  const prompts = { toolu_a: 'step 1: read the parser', toolu_b: 'step 2: write the parser' }
  const preamble = 'context '.repeat(4000) // 32 000 characters before the prompt
  expect(joinSpawn(agents, { text: preamble + 'step 2: write the parser', prompts })).toBe(1)
  // beyond 64 KiB it is not searched
  expect(joinSpawn(agents, { text: 'x'.repeat(70_000) + 'step 2: write the parser', prompts })).toBe(-1)
})

test('joinSpawn: a readable transcript that holds no head falls through to the list row', () => {
  const agents = [...spawned('toolu_a', 'step 1: read'), ...spawned('toolu_b', 'step 2: write')]
  const prompts = { toolu_a: 'step 1: read the parser', toolu_b: 'step 2: write the parser' }
  expect(joinSpawn(agents, { text: 'a reworded opening', row: { description: 'step 2: write', type: 'general-purpose' }, prompts })).toBe(1)
  // with no row either, nothing joins (an engine fork)
  expect(joinSpawn(agents, { text: 'a reworded opening', prompts })).toBe(-1)
})

// ---------------------------------------------------------------- 6. stalledAt goes when the step data come in

test('bindAgent: a stalled spawn that takes its stepping agent drops stalledAt', () => {
  let agents = [...spawned('toolu_a', 'a'), ...spawned('toolu_b', 'b')]
  agents = tick(agents, { at: NOW + 3 * 60_000, stallMs: 10 * 60_000, startMs: 2 * 60_000 }).agents
  expect(agents[0].stalledAt).toBeDefined()
  agents = stepStart(agents, { at: NOW + 3 * 60_000 + 1, agentId: 'z1', model: HAIKU }).agents
  const out = bindAgent(agents, 'toolu_a', 'z1', NOW + 3 * 60_000 + 2).agents
  const mine = out.find((r) => r.toolUseId === 'toolu_a')!
  expect([mine.status, mine.stalledAt]).toEqual(['running', undefined])
})

// ---------------------------------------------------------------- 7. one transcript read per agentId

test('spawn: an agent no spawn claims has its transcript read once, though its provisional record expires', async ($, on) => {
  const w = world(on, {})
  const reads: string[] = []
  engine(on, { reads })
  await start($)
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_a', description: 'one', prompt: 'step 1: one' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_b', description: 'two', prompt: 'step 2: two' }))
  await step($, 'fork1')
  await step($, 'fork1')
  // quiet past the provisional record's two minutes: it is dropped
  await w.clock.advance(3 * 60_000)
  expect((w.last.agents as A[]).some((r) => r.agentId === 'fork1')).toBe(false)
  await step($, 'fork1')
  await complete($, 'fork1')
  expect(reads.filter((id) => id === 'fork1').length).toBe(1)
})

// ---------------------------------------------------------------- the old design's guarantee

for (const background of [true, false]) {
  test('spawn: a single ' + (background ? 'background' : 'foreground') + ' Agent call ends on its own record with status, model, steps and cost', async ($, on) => {
    const w = world(on, {})
    engine(on, { prompts: { s1: 'step 1: read the parser' }, results: { toolu_s: 's1' } })
    await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_s', description: 'step 1: read', prompt: 'step 1: read the parser', background }))
    // a background call's result comes back at launch, a foreground one's after the agent finished
    if (background) await agentResult($, 'toolu_s', 'step 1: read')
    await step($, 's1', SONNET)
    await step($, 's1', SONNET)
    await complete($, 's1')
    if (!background) await agentResult($, 'toolu_s', 'step 1: read')
    const agents = w.last.agents as A[]
    expect(agents.map((r) => [r.id, r.toolUseId, r.agentId, r.status, r.model, r.steps, r.description])).toEqual([['s1', 'toolu_s', 's1', 'done', SONNET, 2, 'step 1: read']])
    near(agents[0].estUsd, usd(SONNET, 2))
  })
}

// The Claude plugin directory's rule: a hook on agent.spawn passes the event on with a literal
// `return next(e)`. The registered handler and its fail-open .catch are read as source text.
test('agent.spawn: every path of the hook returns its next parameter called with its event parameter, and no name is reused', () => {
  const spawnHooks: Array<{ handler: Function; caught?: Function }> = []
  const chain = (entry?: { handler: Function; caught?: Function }) => ({
    catch(fn: Function) {
      if (entry) entry.caught = fn
      return chain()
    },
  })
  const fakeOn = (event: string, ...rest: unknown[]) => {
    const handler = rest[rest.length - 1] as Function
    if (event !== 'agent.spawn') return chain()
    const entry = { handler }
    spawnHooks.push(entry)
    return chain(entry)
  }
  register(fakeOn, {})
  expect(spawnHooks.length).toBe(1)
  for (const fn of [spawnHooks[0].handler, spawnHooks[0].caught]) {
    expect(fn).toBeDefined()
    const src = String(fn).trim()
    const params = /^async\s*\(\s*\$\s*,\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/.exec(src)
    expect(params).not.toBeNull()
    const [, event, pass] = params!
    // unique names: the directory refuses a hook whose parameter names are declared elsewhere in the file
    expect(['e', 'next']).not.toContain(event)
    expect(['e', 'next']).not.toContain(pass)
    expect(src).toMatch(new RegExp('return ' + pass + '\\(' + event + '\\);?\\s*\\}$'))
    expect(src.match(/\breturn\b/g)?.length).toBe(1)
  }
})
