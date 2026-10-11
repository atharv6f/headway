import { expect, mock, test } from 'claude-code/testing'
import { bindAgent, joinSpawn, spawnAgent, stepStart } from '../plugin/hooks/agents.ts'
import type { AgentRecord } from '../plugin/hooks/agents.ts'
import { PLAN, start, TOOL, world } from './world.ts'

// agent.spawn is observed, never answered: the hook records the spawn from the event and returns
// next(e) as it came, so the agent's id is not known when the record is written. It is joined at the
// agent's first step (or its completion): by the head of its prompt, which the agent's own transcript
// opens with; else by the `$.agent.list()` row's description and type; a workflow agent by its run,
// model and order. The Agent tool's result, which carries the agentId, settles the join (rejoin.test.ts),
// and a spawn the engine refused (the Agent call came back denied or as an error) is dropped.

type A = { id: string; agentId?: string; status: string; description: string; taskIds: string[]; phase?: string; steps: number; model?: string }

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }

function spawnInput(over: Record<string, unknown>) {
  return {
    tool_use_id: 'toolu_1', prompt: 'Reply ok', description: 'a task', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...over,
  }
}

// The engine beneath the plugin: agent.spawn answers with the next id; each agent's transcript opens
// with the prompt it was spawned with (`prompts`, by agentId), and `$.agent.list()` names `rows`.
function engine(on, o: { ids?: string[]; prompts?: Record<string, string>; rows?: Array<{ id: string; description: string; type: string; status: string }>; deny?: boolean } = {}) {
  let n = 0
  const answers: unknown[] = []
  on('agent.spawn', async () => {
    const a = o.deny ? { deny: 'no such agent type' } : { model: 'claude-haiku-5-5', agentId: (o.ids ?? [])[n++] }
    answers.push(a)
    return a
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: o.rows ?? [] }))
  on('session.messages', async (_$, e) => {
    const p = e.agentId !== undefined ? o.prompts?.[e.agentId] : undefined
    if (p === undefined) return { value: { deny: 'not this session' } }
    return { value: [{ role: 'user', text: p, toolUses: [] }, { role: 'assistant', text: 'working', toolUses: [] }] }
  })
  return answers
}

async function step($, agentId: string, model = 'claude-haiku-5-5') {
  for await (const _ of $.turn.step({ turnId: 't-' + agentId, index: 0, model, effort: 'low', messageCount: 1, agentId })) {
    // drain
  }
}

test('spawn: the hook passes the spawn on as it came and answers what the engine answered', async ($, on) => {
  const w = world(on, {})
  const seen: unknown[] = []
  const answer = { model: 'claude-haiku-5-5', agentId: 'a1' }
  // the engine beneath the plugin: what it receives is what the plugin passed on
  on('agent.spawn', async (_$, e) => {
    seen.push(e)
    return answer
  })
  const input = spawnInput({ description: 'step 1: read', prompt: 'step 1: read the parser' })
  const out = await $.agent.spawn(input)
  expect(out).toEqual(answer)
  expect(seen).toEqual([input])
  // recorded from the event alone: queued under the call's id, no agentId yet
  expect((w.last.agents as A[]).map((a) => a.id + ':' + a.status + ':' + a.agentId)).toEqual(['toolu_1:queued:undefined'])
})

test('spawn: a normal agent is joined to its agentId at its first step, by its prompt', async ($, on) => {
  const w = world(on, {})
  engine(on, { ids: ['a1'], prompts: { a1: 'step 1: read the parser and report' } })
  await $.agent.spawn(spawnInput({ description: 'step 1: read', prompt: 'step 1: read the parser and report' }))
  await step($, 'a1')
  const agents = w.last.agents as A[]
  expect(agents.map((a) => a.id + ':' + a.agentId + ':' + a.status + ':' + a.steps)).toEqual(['a1:a1:running:1'])
  expect(agents[0].model).toBe('claude-haiku-5-5')
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-a1', agentId: 'a1', reason: 'answer', usage: USAGE })
  expect((w.last.agents as A[]).map((a) => a.id + ':' + a.status)).toEqual(['a1:done'])
})

test('spawn: two parallel agents with near-identical descriptions each land under their own step', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN } })
  engine(on, { ids: ['p1', 'p2'], prompts: { p1: 'T2: check the parser output', p2: 'T3: check the parser output' } })
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 'tr', action: 'track', file: '/w/plan.md', section: 'Work', doneRule: 'column=landed' })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_a', description: 'check the parser', prompt: 'T2: check the parser output' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_b', description: 'check the parser', prompt: 'T3: check the parser output' }))
  // the second agent steps first
  await step($, 'p2')
  await step($, 'p1')
  const agents = w.last.agents as A[]
  const byId = Object.fromEntries(agents.map((a) => [a.id, a.taskIds]))
  expect(byId).toEqual({ p1: ['T2'], p2: ['T3'] })
})

test('spawn: with no prompt to read, the agent list row joins by description and type', async ($, on) => {
  const w = world(on, {})
  engine(on, {
    ids: ['r1', 'r2'],
    rows: [
      { id: 'r1', description: 'step 1: read', type: 'scout', status: 'running' },
      { id: 'r2', description: 'step 2: write', type: 'scout', status: 'running' },
    ],
  })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_a', description: 'step 1: read', subagentType: 'scout' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_b', description: 'step 2: write', subagentType: 'scout' }))
  await step($, 'r2')
  await step($, 'r1')
  const agents = w.last.agents as A[]
  expect(agents.map((a) => a.id + ':' + a.description).sort()).toEqual(['r1:step 1: read', 'r2:step 2: write'])
})

// A workflow agent's transcript is not readable at its first step and `$.agent.list()` has no row
// for it (checked on 2.1.296), so it joins the waiting workflow spawn whose model and effort fit
// the step, the earliest first (agentIndex breaks a tie).
const WF_SCRIPT = `export const meta = { name: 'tiny', description: 'two agents', phases: ['Build', 'Verify'] }
const a = await agent('Read the config', { label: 'R02-73 case read', phase: 'Build', model: 'haiku', effort: 'low' })
const b = await agent('List the endpoints', { label: 'API1 endpoint list', phase: 'Verify', model: 'sonnet', effort: 'high' })`
const wfSpawn = (i: number, label: string, prompt: string, model: string) =>
  spawnInput({ tool_use_id: 'toolu_wf', description: label, prompt, subagentType: 'workflow-subagent', model, workflow: { runId: 'wf_9', agentIndex: i } })

test('spawn: workflow agents still join their planned calls by e.workflow, then their agentId in spawn order', async ($, on) => {
  const w = world(on, {})
  engine(on, { ids: ['w1', 'w2'] })
  on('tool.call', async () => ({ result: { runId: 'wf_9' } }))
  await $.tool.call({ tool: 'Workflow', script: WF_SCRIPT.replace("'sonnet', effort: 'high'", "'haiku', effort: 'low'"), tool_use_id: 'toolu_wf' })
  await $.agent.spawn(wfSpawn(1, 'R02-73 case read', 'Read the config', 'haiku'))
  await $.agent.spawn(wfSpawn(2, 'API1 endpoint list', 'List the endpoints', 'haiku'))
  let agents = w.last.agents as A[]
  expect(agents.map((a) => a.id + ':' + a.phase)).toEqual(['wf:wf_9:1:Build', 'wf:wf_9:2:Verify'])
  await step($, 'w1')
  await step($, 'w2')
  agents = w.last.agents as A[]
  expect(agents.map((a) => a.id + ':' + a.phase + ':' + a.status)).toEqual(['w1:Build:running', 'w2:Verify:running'])
})

test('spawn: a workflow agent that steps out of order joins the spawn whose model and effort fit its step', async ($, on) => {
  const w = world(on, {})
  engine(on, { ids: ['w1', 'w2'] })
  on('tool.call', async () => ({ result: { runId: 'wf_9' } }))
  await $.tool.call({ tool: 'Workflow', script: WF_SCRIPT, tool_use_id: 'toolu_wf' })
  await $.agent.spawn(wfSpawn(1, 'R02-73 case read', 'Read the config', 'haiku'))
  await $.agent.spawn(wfSpawn(2, 'API1 endpoint list', 'List the endpoints', 'sonnet'))
  // the sonnet agent steps first
  for await (const _ of $.turn.step({ turnId: 't-w2', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1, agentId: 'w2' })) {
    // drain
  }
  await step($, 'w1', 'claude-haiku-5-5')
  const agents = w.last.agents as A[]
  expect(agents.map((a) => a.id + ':' + a.phase).sort()).toEqual(['w1:Build', 'w2:Verify'])
})

test('spawn: an unreadable, unlisted agent (an engine fork) does not take a waiting Agent-tool spawn while another waits', async ($, on) => {
  const w = world(on, {})
  engine(on, { ids: ['g1', 'g2'], prompts: { g1: 'step 1: one', g2: 'step 2: two' } })
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_a', description: 'one', prompt: 'step 1: one' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_b', description: 'two', prompt: 'step 2: two' }))
  await step($, 'fork1')
  expect((w.last.agents as A[]).filter((a) => a.agentId === 'fork1').map((a) => a.description)).toEqual([''])
})

test('spawn: a spawn the engine refused is dropped when its Agent call comes back as an error', async ($, on) => {
  const w = world(on, {})
  engine(on, { deny: true })
  // the Agent tool's answer once the engine refused its spawn
  on('tool.call', async () => ({ result: 'no such agent type', isError: true }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_d', description: 'step 1: read', subagentType: 'scout' }))
  expect((w.last.agents as A[]).map((a) => a.id)).toEqual(['toolu_d'])
  await $.tool.call({ tool: 'Agent', description: 'step 1: read', subagent_type: 'scout', model: 'haiku', prompt: 'p', tool_use_id: 'toolu_d' })
  expect(w.last.agents as A[]).toEqual([])
})

test('spawn: with nothing to tell two waiting spawns apart, the Agent results bind each to its agentId', async ($, on) => {
  const w = world(on, {})
  engine(on, { ids: ['x1', 'x2'] })
  on('tool.call', async (_$, e) => ({ result: { status: 'completed', agentId: e.tool_use_id === 'toolu_1' ? 'x1' : 'x2', content: [] } }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_1', description: 'one' }))
  await $.agent.spawn(spawnInput({ tool_use_id: 'toolu_2', description: 'two' }))
  await step($, 'x2')
  await step($, 'x1')
  expect((w.last.agents as A[]).length).toBe(4) // two waiting spawns, two provisional records
  await $.tool.call({ tool: 'Agent', description: 'one', subagent_type: 'general-purpose', model: 'haiku', prompt: 'p', tool_use_id: 'toolu_1' })
  await $.tool.call({ tool: 'Agent', description: 'two', subagent_type: 'general-purpose', model: 'haiku', prompt: 'p', tool_use_id: 'toolu_2' })
  const agents = w.last.agents as A[]
  expect(agents.map((a) => a.id + ':' + a.description + ':' + a.steps + ':' + a.status).sort()).toEqual(['x1:one:1:running', 'x2:two:1:running'])
})

// ---------------------------------------------------------------- the pure join

const NOW = 1000
function spawned(over: Partial<{ toolUseId: string; description: string; subagentType: string; prompt: string }>): AgentRecord[] {
  return spawnAgent([], { at: NOW, toolUseId: over.toolUseId ?? 'toolu_1', description: over.description ?? 'd', subagentType: over.subagentType ?? 'general-purpose', prompt: over.prompt }, { plan: null }).agents
}

test('joinSpawn: a transcript that matches no waiting prompt joins nothing, so an engine fork is not taken for a spawn', () => {
  const agents = spawned({ prompt: 'step 1: read the parser' })
  expect(joinSpawn(agents, { text: 'Summarise the conversation so far', prompts: { toolu_1: 'step 1: read the parser' } })).toBe(-1)
  expect(joinSpawn(agents, { text: 'step 1: read the parser', prompts: { toolu_1: 'step 1: read the parser' } })).toBe(0)
})

test('joinSpawn: with no hint, no Agent-tool spawn joins, however alone it waits', () => {
  const one = spawned({})
  expect(joinSpawn(one, { prompts: {} })).toBe(-1)
  const two = [...one, ...spawned({ toolUseId: 'toolu_2' })]
  expect(joinSpawn(two, { prompts: {} })).toBe(-1)
})

test('bindAgent: a provisional record of the same agent folds into the spawn it belongs to', () => {
  let agents = spawned({ description: 'step 1: read' })
  agents = stepStart(agents, { at: NOW + 5, agentId: 'z1', model: 'claude-haiku-5-5' }).agents
  expect(agents.map((a) => a.id)).toEqual(['toolu_1', 'z1']) // no hint: it waits for the Agent result
  expect(bindAgent(agents, 'toolu_1', 'z1', NOW + 6).agents.map((a) => a.id + ':' + a.description + ':' + a.steps)).toEqual(['z1:step 1: read:1'])
  const two = [...spawned({ toolUseId: 'toolu_a', description: 'a' }), ...spawned({ toolUseId: 'toolu_b', description: 'b' })]
  const stepped = stepStart(two, { at: NOW + 5, agentId: 'z2', model: 'claude-haiku-5-5' }).agents
  expect(stepped.length).toBe(3)
  const bound = bindAgent(stepped, 'toolu_b', 'z2', NOW + 9).agents
  expect(bound.map((a) => a.id + ':' + a.description + ':' + a.steps)).toEqual(['toolu_a:a:0', 'z2:b:1'])
})
