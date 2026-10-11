import { expect, mock, test } from 'claude-code/testing'
import { PLAN, start, TOOL, world } from './world.ts'
import { bare, objects, text as flow } from './fixtures/flow.ts'
import { addPlanned, bindRun, buildTree, completeAgent, spawnAgent, stepStart, tick } from '../hooks/agents.ts'
import type { AgentRecord, PlannedInput } from '../hooks/agents.ts'
import { parseWorkflow } from '../hooks/workflow.ts'
import { phasePlan, phaseRun } from '../hooks/phases.ts'
import { activeSource, goalLabel, sourcePlan } from '../hooks/sources.ts'
import type { Sources } from '../hooks/sources.ts'
import { parsePlanMode } from '../hooks/planmode.ts'
import { text as nested } from './fixtures/plan-nested.ts'

// Workflow phases as a plan source (SPEC 4.6): the run's phases are the tasks, its agents nest under
// their phase, and the source is the lowest, below a pinned file, a report and a plan-mode plan.

const STUB = { plan: null }
const lit = (v: unknown) => (v as { value: string } | undefined)?.value

function planned(script: string, toolUseId: string, runId: string | null, at = 0): AgentRecord[] {
  const p = parseWorkflow(script)
  const calls: PlannedInput[] = p.calls.map((c) => ({ ordinal: c.ordinal, label: lit(c.label), phase: lit(c.phase), warnings: [] }))
  const title = p.description ?? p.name
  let out = addPlanned([], { at, toolUseId, calls, runTitle: title, runPhases: p.phases }, STUB).agents
  if (runId !== null) out = bindRun(out, toolUseId, runId).agents
  return out
}

let seq = 0
function spawn(agents: AgentRecord[], toolUseId: string, runId: string, index: number, label: string, at: number): { agents: AgentRecord[]; id: string } {
  const id = 'a' + ++seq
  const r = spawnAgent(agents, { at, toolUseId, description: label, subagentType: 'workflow-subagent', workflow: { runId, agentIndex: index }, agentId: id }, STUB)
  return { agents: stepStart(r.agents, { at, agentId: id }).agents, id }
}

const finish = (agents: AgentRecord[], id: string, at: number) => completeAgent(agents, { at, agentId: id, reason: 'answer', answer: 'ok', durationMs: 1, usage: null }).agents
const statuses = (agents: AgentRecord[]) => phaseRun(agents)?.phases.map((p) => p.name + ':' + p.status)

test('phase run: the phases of the script in order, the run title, every phase open before any agent spawns', async () => {
  const run = phaseRun(planned(flow, 'toolu_f', 'wf_f'))
  expect(run?.title).toBe('Build then verify')
  expect(run?.phases.map((p) => p.name + ':' + p.status)).toEqual(['Build:open', 'Verify:open'])
  expect(phaseRun(planned(objects, 'toolu_f', 'wf_f'))?.phases.map((p) => p.name)).toEqual(['Build', 'Verify'])
})

test('phase status: partial while one of its agents runs, done when every planned agent is terminal', async () => {
  let a = planned(flow, 'toolu_f', 'wf_f')
  const build = spawn(a, 'toolu_f', 'wf_f', 1, 'build core', 10)
  a = build.agents
  expect(statuses(a)).toEqual(['Build:partial', 'Verify:open'])
  a = finish(a, build.id, 20)
  expect(statuses(a)).toEqual(['Build:done', 'Verify:open'])
  const v1 = spawn(a, 'toolu_f', 'wf_f', 2, 'verify xyz', 30)
  a = v1.agents
  expect(statuses(a)).toEqual(['Build:done', 'Verify:partial'])
  a = finish(a, v1.id, 40)
  // the second Verify call is planned and has not spawned: the phase is not over
  expect(statuses(a)).toEqual(['Build:done', 'Verify:open'])
  const v2 = spawn(a, 'toolu_f', 'wf_f', 3, 'verify docs', 41)
  expect(statuses(v2.agents)).toEqual(['Build:done', 'Verify:partial'])
  expect(statuses(finish(v2.agents, v2.id, 50))).toEqual(['Build:done', 'Verify:done'])
})

test('phase status: a failed agent makes its settled phase failed, not done; a blocked one keeps it partial', async () => {
  let a = planned(flow, 'toolu_f', 'wf_f')
  const b = spawn(a, 'toolu_f', 'wf_f', 1, 'build core', 10)
  a = completeAgent(b.agents, { at: 20, agentId: b.id, reason: 'answer', answer: 'BLOCKED: which file', durationMs: 1, usage: null }).agents
  expect(statuses(a)).toEqual(['Build:partial', 'Verify:open'])
  const c = spawn(planned(flow, 'toolu_g', 'wf_g'), 'toolu_g', 'wf_g', 1, 'build core', 10)
  const failed = completeAgent(c.agents, { at: 20, agentId: c.id, reason: 'error', answer: '', durationMs: 1, usage: null }).agents
  expect(statuses(failed)).toEqual(['Build:failed', 'Verify:open'])
  // the plan: the phase is not done, so the goal counts done phases only; its node draws failed
  const plan = phasePlan(phaseRun(failed)!)
  expect(plan.counts.done).toBe(0)
  expect(plan.counts.total).toBe(2)
  const tree = buildTree(plan, failed)
  expect(tree.groups.flatMap((g) => g.tasks).find((t) => t.id === 'Build')!.status).toBe('failed')
  // a phase whose only agent was lost is open again, not failed
  const lost = failed.map((x) => (x.id === c.id ? { ...x, status: 'lost' as const } : x))
  expect(statuses(lost)).toEqual(['Build:open', 'Verify:open'])
  // with one failed and others still running, the phase is partial
  const v = spawn(planned(flow, 'toolu_h', 'wf_h'), 'toolu_h', 'wf_h', 2, 'verify xyz', 10)
  const w = spawn(v.agents, 'toolu_h', 'wf_h', 3, 'verify docs', 11)
  const oneDown = completeAgent(w.agents, { at: 20, agentId: v.id, reason: 'error', answer: '', durationMs: 1, usage: null }).agents
  expect(statuses(oneDown)).toEqual(['Build:open', 'Verify:partial'])
  expect(statuses(finish(oneDown, w.id, 30))).toEqual(['Build:open', 'Verify:failed'])
})

test('phase status: per call the latest attempt counts; a stalled call retried to success leaves its phase done (the reviewer case)', async () => {
  const stall = { stallMs: 600_000, startMs: 120_000 }
  let a = planned(flow, 'toolu_f', 'wf_f')
  const b = spawn(a, 'toolu_f', 'wf_f', 1, 'build core', 10)
  a = tick(b.agents, { at: 10 + 600_001, ...stall }).agents
  expect(a.find((x) => x.id === b.id)!.status).toBe('stalled')
  // the retry runs under a new agent id with no spawn; it finishes and is surfaced in the stalled call's place
  const t = 10 + 600_002
  a = stepStart(a, { at: t, agentId: 'retry1' }).agents
  a = finish(a, 'retry1', t + 1)
  a = tick(a, { at: t + 1 + 15_000, ...stall }).agents
  expect(a.find((x) => x.id === b.id)).toMatchObject({ status: 'failed', reason: 'retried' })
  expect(a.find((x) => x.id === 'retry1')).toMatchObject({ status: 'done', phase: 'Build' })
  expect(statuses(a)).toEqual(['Build:done', 'Verify:open'])
  // the other order: the latest attempt failed, so the phase is failed
  const later = a.map((x) => (x.id === b.id ? { ...x, spawnedAt: t + 5 } : x))
  expect(statuses(later)).toEqual(['Build:failed', 'Verify:open'])
})

test('phase status: an agent lost after a restart does not fail its phase when the others are done', async () => {
  let a = planned(flow, 'toolu_f', 'wf_f')
  const v1 = spawn(a, 'toolu_f', 'wf_f', 2, 'verify xyz', 10)
  const v2 = spawn(v1.agents, 'toolu_f', 'wf_f', 3, 'verify docs', 11)
  a = finish(v2.agents, v1.id, 20)
  a = a.map((x) => (x.id === v2.id ? { ...x, status: 'lost' as const, endedAt: 30 } : x))
  expect(statuses(a)).toEqual(['Build:open', 'Verify:done'])
  // every call lost: open, not failed
  const allLost = a.map((x) => (x.id === v1.id ? { ...x, status: 'lost' as const } : x))
  expect(statuses(allLost)).toEqual(['Build:open', 'Verify:open'])
})

test('skipped calls: a planned call the run ended without spawning no longer blocks done', async () => {
  let a = planned(flow, 'toolu_f', 'wf_f')
  const b = spawn(a, 'toolu_f', 'wf_f', 1, 'build core', 10)
  const v = spawn(b.agents, 'toolu_f', 'wf_f', 2, 'verify xyz', 30)
  a = finish(finish(v.agents, b.id, 20), v.id, 40)
  expect(statuses(a)).toEqual(['Build:done', 'Verify:open'])
  // 60 s with nothing: the run is over and the third call (never spawned) is skipped
  a = tick(a, { at: 40 + 60_000, stallMs: 600_000, startMs: 120_000 }).agents
  expect(a.filter((x) => x.skipped).length).toBe(1)
  expect(statuses(a)).toEqual(['Build:done', 'Verify:done'])
})

test('two runs: the most recent run with phases is the source; the older keeps its own agents', async () => {
  const second = `export const meta = { name: 'two', description: 'Second run', phases: ['Read', 'Write'] }
await agent('x', { label: 'r1', phase: 'Read', model: 'haiku', effort: 'low' })`
  const a = [...planned(flow, 'toolu_f', 'wf_f', 0), ...planned(second, 'toolu_s', 'wf_s', 100)]
  const run = phaseRun(a)
  expect(run?.title).toBe('Second run')
  expect(run?.phases.map((p) => p.name)).toEqual(['Read', 'Write'])
})

test('a script without phases is no phase run, and does not displace an earlier one', async () => {
  expect(phaseRun(planned(bare, 'toolu_b', 'wf_b'))).toBe(null)
  expect(phaseRun(planned(flow.replace("phases: ['Build', 'Verify']", 'phases: []'), 'toolu_b', 'wf_b'))).toBe(null)
  const a = [...planned(flow, 'toolu_f', 'wf_f', 0), ...planned(bare, 'toolu_b', 'wf_b', 100)]
  expect(phaseRun(a)?.title).toBe('Build then verify')
})

test('the plan of a phase run: one own group named after the run, a task per phase, counts by status', async () => {
  let a = planned(flow, 'toolu_f', 'wf_f')
  const b = spawn(a, 'toolu_f', 'wf_f', 1, 'build core', 10)
  a = finish(b.agents, b.id, 20)
  const plan = phasePlan(phaseRun(a)!)
  expect(plan.tasks.map((t) => t.id + ':' + t.status)).toEqual(['Build:done', 'Verify:open'])
  expect(plan.groups.map((g) => g.id + ':' + g.own + ':' + g.tasks.join(','))).toEqual(['Build then verify:true:0,1'])
  expect(plan.counts).toEqual({ done: 1, partial: 0, open: 1, total: 2 })
})

// ---------------------------------------------------------------- the row in the table

const NONE: Sources = { filter: null, report: null, planMode: null, tasks: null, phases: null }
const RUN = phaseRun(planned(flow, 'toolu_f', 'wf_f'))!

test('precedence: phases is the lowest source; each higher one hides it and its removal shows it again', async () => {
  const withRun = { ...NONE, phases: RUN }
  expect(activeSource(withRun)).toBe('phases')
  expect(activeSource({ ...withRun, planMode: parsePlanMode(nested) })).toBe('plan')
  expect(activeSource({ ...withRun, report: { tasks: [{ id: 'S1', title: 'a', status: 'open' } ] } })).toBe('reported')
  expect(activeSource({ ...withRun, filter: { file: '/w/p.md' } })).toBe('file')
  expect(activeSource({ ...withRun, report: { tasks: [] } })).toBe('phases')
  expect(sourcePlan(withRun, 'phases')?.tasks.map((t) => t.id)).toEqual(['Build', 'Verify'])
  expect(sourcePlan(NONE, 'phases')).toBe(null)
})

test('goal label: the run title; a run with none leaves the prompt; a prompt does not replace it', async () => {
  expect(goalLabel({ ...NONE, phases: RUN }, 'phases', 'typed prompt')).toBe('Build then verify')
  expect(goalLabel({ ...NONE, phases: { ...RUN, title: undefined } }, 'phases', 'typed prompt')).toBe('typed prompt')
})

// ---------------------------------------------------------------- through the hooks

const USAGE = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 100, scroll: { offset: 0, bodyRows: 15 }, view: {} }

function engine(on) {
  let n = 0
  on('tool.call', async (_$, e) => (e.tool === 'Workflow' ? { result: { status: 'async_launched', runId: 'wf_' + e.tool_use_id.replace('toolu_', ''), taskId: 't' } } : { result: 'ok' }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'w' + ++n }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: [] }))
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
}

const wfSpawn = (toolUseId: string, runId: string, index: number, label: string) => ({
  tool_use_id: toolUseId, prompt: 'Reply ok', description: label, subagentType: 'workflow-subagent', provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5', background: false, fork: false, model: 'haiku', workflow: { runId, agentIndex: index },
})

const done = ($, agentId: string) => $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-' + agentId, agentId, reason: 'answer', usage: USAGE })
async function tool($, input: Record<string, unknown>): Promise<string> {
  return (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_w', ...input })).result as string
}
const goalLine = async ($) => (await tool($, { action: 'state' })).split('\n')[0]

async function bandLine1($): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: 'headway', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const t = await ui.find({ type: 'Text', text: /◆/ })
  await ui.unmount()
  return t?.text as string | undefined
}

test('hooks: a Workflow call with meta.phases becomes the source; its agents nest under their phase; a finished phase counts', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  expect(await goalLine($)).toBe('goal: nothing tracked')
  await $.tool.call({ tool: 'Workflow', script: flow, tool_use_id: 'toolu_f' })
  expect(await goalLine($)).toBe('goal: Build then verify — 0/2 done (phases)')
  await $.agent.spawn(wfSpawn('toolu_f', 'wf_f', 1, 'build core'))
  const agents = () => w.last.agents as AgentRecord[]
  expect(agents()[0]).toMatchObject({ id: 'w1', taskIds: ['Build'], groupId: 'Build then verify' })
  expect(agents().filter((a) => a.planned).map((a) => a.taskIds[0])).toEqual(['Verify', 'Verify'])
  await done($, 'w1')
  await w.clock.advance(2000)
  expect(await goalLine($)).toBe('goal: Build then verify — 1/2 done (phases)')
  // the tree: one group, the Build task with its finished agent, the Verify task with its two planned calls (queued agents keep a task active, as for any source)
  const all = agents()
  const tree = buildTree(phasePlan(phaseRun(all)!), all)
  expect(tree.groups.map((g) => g.id + ':' + g.tasks.map((t) => t.id + ' ' + t.finished + '/' + t.dispatched + ' ' + t.status).join(','))).toEqual(['Build then verify:Verify 0/2 active,Build 1/1 done'])
  expect(tree.unassigned.agents.length).toBe(0)
  const line1 = await bandLine1($)
  expect(line1).toContain('Build then verify')
  expect(line1).toMatch(/1\/2 done {2}phases$/)
})

test('hooks: a report outranks the phases; clearing it shows them again with the run agents back under their phases', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Workflow', script: flow, tool_use_id: 'toolu_f' })
  await $.agent.spawn(wfSpawn('toolu_f', 'wf_f', 1, 'build core'))
  const agents = () => w.last.agents as AgentRecord[]
  expect(agents()[0].taskIds).toEqual(['Build'])
  await tool($, { action: 'report', title: 'Mine', tasks: [{ id: 'S1', title: 'one', status: 'open' }] })
  expect(await goalLine($)).toBe('goal: Mine — 0/1 done (reported)')
  expect(agents()[0].taskIds).toEqual([])
  await tool($, { action: 'report', tasks: [] })
  expect(await goalLine($)).toBe('goal: Build then verify — 0/2 done (phases)')
  expect(agents()[0]).toMatchObject({ taskIds: ['Build'], groupId: 'Build then verify' })
})

test('hooks: a pinned file outranks the phases and untrack shows them', async ($, on) => {
  const w = world(on, { files: { '/w/plan/p.md': PLAN } })
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Workflow', script: flow, tool_use_id: 'toolu_f' })
  expect(await goalLine($)).toContain('(phases)')
  await tool($, { action: 'track', file: '/w/plan/p.md', section: 'Work' })
  expect(await goalLine($)).toContain('(file')
  await tool($, { action: 'untrack' })
  expect(await goalLine($)).toBe('goal: Build then verify — 0/2 done (phases)')
  expect((w.last.agents as AgentRecord[]).filter((a) => a.planned).length).toBe(3)
})

test('hooks: the run ends after 60 s quiet and the source stays; a newer run replaces it; one without phases does not', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Workflow', script: flow, tool_use_id: 'toolu_f' })
  await $.agent.spawn(wfSpawn('toolu_f', 'wf_f', 1, 'build core'))
  await done($, 'w1')
  await $.agent.spawn(wfSpawn('toolu_f', 'wf_f', 2, 'verify xyz'))
  await done($, 'w2')
  await w.clock.advance(75_000)
  expect((w.last.agents as AgentRecord[]).filter((a) => a.skipped).length).toBe(1)
  expect(await goalLine($)).toBe('goal: Build then verify — 2/2 done (phases)')
  await w.clock.advance(10 * 60_000)
  expect(await goalLine($)).toBe('goal: Build then verify — 2/2 done (phases)')
  // a run whose script declares no phases leaves the source where it is, its agents in their run group
  await $.tool.call({ tool: 'Workflow', script: bare, tool_use_id: 'toolu_b' })
  expect(await goalLine($)).toBe('goal: Build then verify — 2/2 done (phases)')
  const plain = (w.last.agents as AgentRecord[]).filter((a) => a.toolUseId === 'toolu_b')
  expect(plain.length).toBe(3)
  expect(plain.every((a) => a.taskIds.length === 0 && a.groupId === undefined)).toBe(true)
  // a newer run with phases takes over
  const second = flow.replace("name: 'flow', description: 'Build then verify'", "name: 'two', description: 'Second run'").replace("'Build', 'Verify'", "'Read', 'Write'").replace(/phase: 'Build'/, "phase: 'Read'").replace(/phase: 'Verify'/g, "phase: 'Write'")
  await $.tool.call({ tool: 'Workflow', script: second, tool_use_id: 'toolu_2' })
  expect(await goalLine($)).toBe('goal: Second run — 0/2 done (phases)')
  // the first run is now an ordinary run group
  expect((w.last.agents as AgentRecord[]).filter((a) => a.toolUseId === 'toolu_f' && !a.planned).every((a) => a.taskIds.length === 0)).toBe(true)
})
