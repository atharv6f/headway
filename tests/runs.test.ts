import { expect, mock, test } from 'claude-code/testing'
import { addPlanned, bandCurrent, bindRun, buildTree, completeAgent, spawnAgent } from '../hooks/agents.ts'
import type { AgentRecord, SpawnEvent } from '../hooks/agents.ts'
import { bandLines } from '../hooks/band.tsx'
import { agentRows, DEFAULT_UI, planView, rowText } from '../hooks/pane.tsx'
import type { PaneData } from '../hooks/pane.tsx'
import { capSession, asSaved } from '../hooks/persist.ts'
import { parsePlan } from '../hooks/plan.ts'
import type { Plan } from '../hooks/plan.ts'
import { stateBlock } from '../hooks/tool.ts'
import { PLAN, start, TOOL, world } from './world.ts'

// Unmatched agents group by their workflow run, or under Agents (SPEC 2, 4.3, 8.1, 8.2): never under
// a bare "Unassigned" unless the record has neither a run nor an Agent-tool origin.

const NOW = 10_000_000
const RUN = 'wf_240ee13f-5ab'
let seq = 0

function plan(): Plan {
  const r = parsePlan('## Work\n\n| task | title | landed |\n|---|---|---|\n| T1 | first | yes |\n| T2 | second | |\n| T3 | third | |\n', { section: 'Work', doneRule: 'column=landed' })
  if (!r.ok) throw new Error(r.error)
  return r.plan
}

function wfSpawn(runId: string, index: number, over: Partial<SpawnEvent> = {}): SpawnEvent {
  seq++
  return { at: seq, toolUseId: 'toolu_wf_' + runId, description: 'reader ' + index, subagentType: 'workflow-subagent', workflow: { runId, agentIndex: index }, agentId: runId + '-a' + index, model: 'claude-haiku-5-5', ...over }
}

function agentSpawn(over: Partial<SpawnEvent> = {}): SpawnEvent {
  seq++
  return { at: seq, toolUseId: 'toolu_ag_' + seq, description: 'look around', subagentType: 'general-purpose', agentId: 'ag' + seq, model: 'claude-haiku-5-5', ...over }
}

const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ ordinal: i + 1, label: 'reader ' + (i + 1), warnings: [] as string[] }))

// A run as the hooks build it: the planned calls (with the script's title), the run bound, the spawns.
function runOf(runId: string, n: number, title: string | undefined, p: Plan | null = null, base: AgentRecord[] = []): AgentRecord[] {
  let agents = addPlanned(base, { at: 1, toolUseId: 'toolu_wf_' + runId, calls: calls(n), runTitle: title }, { plan: p }).agents
  agents = bindRun(agents, 'toolu_wf_' + runId, runId).agents
  for (let i = 1; i <= n; i++) agents = spawnAgent(agents, wfSpawn(runId, i), { plan: p }).agents
  return agents
}

function finish(agents: AgentRecord[], ids: string[]): AgentRecord[] {
  let out = agents
  for (const id of ids) out = completeAgent(out, { at: 5000, agentId: id, reason: 'answer', answer: 'ok', durationMs: 1 }).agents
  return out
}

test('no plan, a workflow of 3 agents: one group titled by the script description, band line 2 reads 0/3 then 3/3', async () => {
  const agents = runOf(RUN, 3, 'Probe three readers')
  const tree = buildTree(null, agents)
  expect(tree.unassigned.agents).toEqual([])
  expect(tree.groups.map((g) => [g.id, g.title, g.finished + '/' + g.dispatched])).toEqual([['wf:' + RUN, 'Probe three readers', '0/3']])
  expect(bandCurrent(null, agents).current).toEqual({ id: 'Probe three readers', title: '', done: 0, total: 3, unit: 'agents' })
  const line = bandLines({ columns: 100, ascii: false, goal: null, current: bandCurrent(null, agents).current, marks: { running: 3 } })[1].map((s) => s.text).join('')
  expect(line).toContain('Probe three readers')
  expect(line).toContain('0/3 agents')
  const done = finish(agents, [RUN + '-a1', RUN + '-a2', RUN + '-a3'])
  expect(bandCurrent(null, done).current).toEqual({ id: 'Probe three readers', title: '', done: 3, total: 3, unit: 'agents' })
  expect(buildTree(null, done).groups[0].status).toBe('done')
})

test('a long description is cut to the label width on band line 2, as the run group title', async () => {
  const agents = runOf(RUN, 14, 'Map the four Atlas repos from code and audit the release decisions')
  const cur = bandCurrent(null, agents).current
  const line = bandLines({ columns: 100, ascii: false, goal: null, current: cur, marks: { running: 14 } })[1].map((s) => s.text).join('')
  expect(line).toMatch(/^ ▸ Map the four Atlas repos from…/)
  expect(line).toContain('0/14 agents')
})

test('the title falls back to a short run id when the script has neither description nor name', async () => {
  const agents = runOf(RUN, 2, undefined)
  const g = buildTree(null, agents).groups[0]
  expect(g.id).toBe('wf:' + RUN)
  expect(g.title).toBe('Workflow 240ee1')
})

test('a plain Agent-tool agent that matches no task goes under Agents; a bare record stays Unassigned', async () => {
  const p = plan()
  const agents = spawnAgent([], agentSpawn({ agentId: 'p1', description: 'no id at all' }), { plan: p }).agents
  const tree = buildTree(p, agents)
  expect(tree.groups.filter((g) => g.id === 'agents').map((g) => [g.title, g.agents.map((a) => a.id)])).toEqual([['Agents', ['p1']]])
  expect(tree.unassigned.agents).toEqual([])
  expect(bandCurrent(p, agents).current).toEqual({ id: 'Agents', title: '', done: 0, total: 1, unit: 'agents' })
  const bare: AgentRecord = { id: 'r9', agentId: 'r9', description: '', subagentType: '', taskIds: [], role: '', status: 'done', spawnedAt: 1, endedAt: 2, steps: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, estUsd: 0, warnings: [] }
  expect(buildTree(null, [bare]).unassigned.agents.map((a) => a.id)).toEqual(['r9'])
  expect(bandCurrent(null, [bare]).current?.id).toBe('Unassigned')
})

test('plan pinned: the plan group with agents sorts first, the workflow group next, then queued plan groups', async () => {
  const p = plan()
  let agents = spawnAgent([], agentSpawn({ agentId: 'm1', description: 'T2 build' }), { plan: p }).agents
  agents = runOf(RUN, 2, 'Probe two readers', p, agents)
  const tree = buildTree(p, agents)
  expect(tree.groups.map((g) => g.id)).toEqual([p.groups[0].id, 'wf:' + RUN])
  // a plan group with nothing running sorts after an active workflow group
  const g2 = parsePlan('## A\n\n| task | title |\n|---|---|\n| A1 | one |\n\n## B\n\n| task | title |\n|---|---|\n| B1 | two |\n', {})
  if (!g2.ok) throw new Error(g2.error)
  const two = g2.plan
  expect(two.groups.length).toBe(2)
  let a2 = spawnAgent([], agentSpawn({ agentId: 'm2', description: 'B1 build' }), { plan: two }).agents
  a2 = runOf(RUN, 2, 'Probe two readers', two, a2)
  expect(buildTree(two, a2).groups.map((g) => g.id)).toEqual([two.groups[1].id, 'wf:' + RUN, two.groups[0].id])
  // once the workflow finishes it sorts with the done groups: after the queued plan group
  const finished = finish(a2, [RUN + '-a1', RUN + '-a2', 'm2'])
  expect(buildTree(two, finished, 5000).groups.map((g) => g.id)).toEqual([two.groups[1].id, 'wf:' + RUN, two.groups[0].id])
  expect(buildTree(two, finished, 5000 + 31 * 60_000).groups.map((g) => g.id)).toEqual([two.groups[0].id, two.groups[1].id, 'wf:' + RUN])
})

test('plan pinned: band line 2 keeps the plan task while it has an unfinished agent, the workflow group otherwise', async () => {
  const p = plan()
  let agents = spawnAgent([], agentSpawn({ agentId: 'm1', description: 'T2 build' }), { plan: p }).agents
  agents = runOf(RUN, 2, 'Probe two readers', p, agents)
  expect(bandCurrent(p, agents).current).toMatchObject({ id: 'T2', total: 1, done: 0 })
  agents = finish(agents, ['m1'])
  expect(bandCurrent(p, agents).current).toEqual({ id: 'Probe two readers', title: '', done: 0, total: 2, unit: 'agents' })
})

test('two concurrent runs make two groups; band line 2 shows the one spawned last', async () => {
  let agents = runOf(RUN, 2, 'First run')
  agents = runOf('wf_bbbbbbbb-111', 3, 'Second run', null, agents)
  const tree = buildTree(null, agents)
  expect(tree.groups.map((g) => g.title).sort()).toEqual(['First run', 'Second run'])
  expect(bandCurrent(null, agents).current).toMatchObject({ id: 'Second run', total: 3 })
  // the second run finishes: the first, still at work, is current
  agents = finish(agents, ['wf_bbbbbbbb-111-a1', 'wf_bbbbbbbb-111-a2', 'wf_bbbbbbbb-111-a3'])
  expect(bandCurrent(null, agents).current).toMatchObject({ id: 'First run', total: 2, done: 0 })
})

test('the run title survives a save and a load of the session record', async () => {
  const agents = runOf(RUN, 2, 'Probe two readers')
  const saved = asSaved(JSON.parse(JSON.stringify(capSession({ filter: null, report: null, agents, log: [], savedAt: 1 }))))
  expect(saved?.agents.every((a) => a.runTitle === 'Probe two readers')).toBe(true)
  expect(buildTree(null, saved?.agents ?? []).groups[0].title).toBe('Probe two readers')
})

// ---------------------------------------------------------------- the panes and the state block

function paneData(agents: AgentRecord[], p: Plan | null): PaneData {
  return { columns: 100, ascii: false, now: NOW, ui: { ...DEFAULT_UI }, goal: null, tree: buildTree(p, agents), agents, log: [], usage: null }
}

test('plan tab shows the group title and its agents; the agents tab names a workflow agent by its run', async () => {
  const agents = runOf(RUN, 2, 'Probe two readers')
  const plan = planView(paneData(agents, null)).rows.map(rowText)
  expect(plan.some((x) => /Probe two readers .*0\/2 agents/.test(x))).toBe(true)
  expect(plan.some((x) => /Unassigned/.test(x))).toBe(false)
  const rows = agentRows(paneData(agents, null)).map(rowText)
  expect(rows.some((x) => /Probe two rea/.test(x) && /reader 1/.test(x))).toBe(true)
  const plain = agentRows(paneData(spawnAgent([], agentSpawn({ agentId: 'p1' }), { plan: null }).agents, null)).map(rowText)
  expect(plain[1]).toMatch(/p1 +—/)
})

test('state: current names the workflow group; the agents line groups the run once', async () => {
  const agents = finish(runOf(RUN, 3, 'Probe three readers', null, spawnAgent([], agentSpawn({ agentId: 'p1', description: 'solo' }), { plan: null }).agents), [RUN + '-a1'])
  const block = stateBlock({ filter: null, report: null, goal: null, current: bandCurrent(null, agents).current, agents, log: [], usage: null, now: NOW, logEntries: 5 })
  const lines = block.split('\n')
  expect(lines.find((l) => l.startsWith('current:'))).toBe('current: Probe three readers — 1/3 agents finished')
  const agentsLine = lines.find((l) => l.startsWith('agents:')) ?? ''
  expect(agentsLine.match(/run "Probe three readers"/g)?.length).toBe(1)
  expect(agentsLine.indexOf('p1')).toBeLessThan(agentsLine.indexOf('run "Probe three readers"'))
  expect(agentsLine).toContain('(ids are for SendMessage)')
})

test('state: every id and title a file, a script or a model wrote is one clean line (newline, ESC, BEL)', async () => {
  const r = parsePlan('- [ ] T1 first\u001b]0;pwned\u0007 step\u001b[31m\n')
  const filePlan = r.ok ? r.plan : null
  expect(filePlan).not.toBe(null)
  const runAgents = runOf(RUN, 1, 'Probe\nthree\u001b[2J readers').map((a) => ({ ...a, id: a.id + '\u001b[31m', label: 'read\ner\u0007', model: 'claude-\u001b[1mx' }))
  const goal = { label: 'g', done: 0, partial: 1, open: 0, total: 1, doneWord: 'do\u001b[2Jne', partialWord: 'ha\nlf', noDoneRule: false }
  const fileBlock = stateBlock({ source: 'file', filter: { file: '/w/p.md' }, goal, current: bandCurrent(filePlan, [], 'T1').current, agents: [], log: [], usage: null, now: NOW, logEntries: 5 })
  const runBlock = stateBlock({ filter: null, goal: null, current: bandCurrent(null, runAgents).current, agents: runAgents, log: [], usage: null, now: NOW, logEntries: 5 })
  for (const block of [fileBlock, runBlock]) {
    expect(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(block)).toBe(false)
    expect(block.split('\n').length).toBe(7) // goal, current, blocked, stalled, agents, log, context
  }
  expect(fileBlock).toContain('current: T1 first step')
  expect(fileBlock).toContain('goal: g — done 0 · ha lf 1 · open 0 / 1 (file: /w/p.md)')
  expect(runBlock).toContain('current: Probe three readers')
  expect(runBlock).toContain('run "Probe three readers": [queued] ' + RUN + '-a1 read er claude-x ')
})

// ---------------------------------------------------------------- through the hooks

const SCRIPT = (meta: string) => `export const meta = ${meta}
const a = await agent('Reply ok', { label: 'reader 1', model: 'haiku', effort: 'low' })
const b = await agent('Reply ok', { label: 'reader 2', model: 'haiku', effort: 'low' })
return [a, b]`

function watch(on) {
  const last: Record<string, unknown> = {}
  on('state.set', async ($, e, next) => {
    if (e.plugin === 'waypoint') last[e.key] = e.value
    return next(e)
  })
  on('ui.toast', async () => ({ value: {} }))
  return { agents: () => (last.agents ?? []) as AgentRecord[], last }
}

test('hooks: the run title is meta.description, else meta.name, else none; spawns carry it', async ($, on) => {
  mock.clock(on, { now: 0 })
  const st = watch(on)
  on('tool.call', async (_$, e) => ({ result: { status: 'async_launched', taskId: 't', runId: 'wf_' + e.tool_use_id } }))
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'h' + ++n }))
  const cases: Array<[string, string, string | undefined]> = [
    ['toolu_d', "{ name: 'named', description: 'Probe two readers', phases: [] }", 'Probe two readers'],
    ['toolu_n', "{ name: 'named-only', phases: [] }", 'named-only'],
    ['toolu_x', '{ phases: [] }', undefined],
  ]
  for (const [id, meta, title] of cases) {
    await $.tool.call({ tool: 'Workflow', script: SCRIPT(meta), tool_use_id: id })
    expect(st.agents().filter((a) => a.runId === 'wf_' + id).map((a) => a.runTitle)).toEqual([title, title])
    await $.agent.spawn({ tool_use_id: id, prompt: 'p', description: 'reader 1', subagentType: 'workflow-subagent', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, model: 'haiku', workflow: { runId: 'wf_' + id, agentIndex: 1 } })
    expect(st.agents().find((a) => a.runId === 'wf_' + id && a.agentId)?.runTitle).toBe(title)
  }
})

test('hooks: a resume reloads the run title from the record; state names the group', async ($, on) => {
  const tok = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
  const rec = (i: number) => ({ id: 'a' + i, agentId: 'a' + i, runId: RUN, agentIndex: i, label: 'reader ' + i, runTitle: 'Probe two readers', description: 'reader ' + i, subagentType: 'workflow-subagent', taskIds: [], role: 'workflow-subagent', status: 'done', spawnedAt: 1, endedAt: 4, firstStepAt: 2, lastStepAt: 3, steps: 1, tokens: tok, estUsd: 0, warnings: [] })
  const w = world(on, { sessionId: 's-1', store: { 'session:s-1': { filter: null, report: null, agents: [rec(1), rec(2)], log: [], savedAt: 5 } }, now: 10 })
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-1' })
  expect((w.last.agents as AgentRecord[]).map((a) => a.runTitle)).toEqual(['Probe two readers', 'Probe two readers'])
  const state = (await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'state' })).result as string
  expect(state).toContain('current: Probe two readers — 2/2 agents finished')
})

test('hooks: a pinned plan keeps its goal while an unmatched workflow runs', async ($, on) => {
  const w = world(on, { files: { '/w/plan/p.md': PLAN } })
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'h' + ++n }))
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  const before = JSON.stringify(w.last.goal)
  await $.agent.spawn({ tool_use_id: 'toolu_1', prompt: 'p', description: 'reader 1', subagentType: 'workflow-subagent', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, model: 'haiku', workflow: { runId: RUN, agentIndex: 1 } })
  expect(JSON.stringify(w.last.goal)).toBe(before)
  expect(before).toContain('"total":3')
})

