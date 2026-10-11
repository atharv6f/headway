import { expect, test } from 'claude-code/testing'
import { PLAN, start, TOOL, world } from './world.ts'
import { text as nested } from './fixtures/plan-nested.ts'
import { text as phases } from './fixtures/plan-phases.ts'

// Plan sources through the hooks (SPEC 4.1, 4.4, 4.8, 12): ExitPlanMode approval and rejection, the
// precedence against a pinned file and a report, the prompt label, the band tag and the save.
const FILES = { '/w/plan/p.md': PLAN }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 100, scroll: { offset: 0, bodyRows: 15 }, view: {} }
const PLAN_FILE = '/home/u/.claude/plans/some-plan.md'

// The engine's ExitPlanMode beneath: approves unless the test says to reject.
function planModeBeneath(on) {
  const state = { reject: false, faults: [] as string[] }
  on('ui.log', async (_$, e) => {
    state.faults.push(String(e.text ?? e.message ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('tool.call', async (_$, e) => {
    if (e.tool !== 'ExitPlanMode') return { result: 'ok' }
    if (state.reject) return { result: "Error: The user doesn't want to proceed with this tool use.", isError: true }
    return { result: { plan: e.plan, isAgent: false, filePath: PLAN_FILE } }
  })
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  return state
}

const exitPlan = ($, plan: string, over: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_p' + Math.random(), plan, planFilePath: PLAN_FILE, ...over })

async function tool($, input: Record<string, unknown>): Promise<string> {
  return (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_w', ...input })).result as string
}

const goalLine = async ($) => (await tool($, { action: 'state' })).split('\n')[0]

async function bandLine1($): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const t = await ui.find({ type: 'Text', text: /◆/ })
  await ui.unmount()
  return t?.text as string | undefined
}

test('approval: an approved plan becomes the plan-mode source; band line 1 and state name it plan', async ($, on) => {
  world(on, { files: FILES })
  planModeBeneath(on)
  await start($)
  const r = await exitPlan($, nested)
  expect((r.result as { filePath: string }).filePath).toBe(PLAN_FILE)
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
  const line1 = await bandLine1($)
  expect(line1).toContain('Tidy the notes folder')
  expect(line1).toMatch(/0\/4 done {2}plan$/)
})

test('rejection changes nothing; a subagent plan is ignored; a second approval replaces the first', async ($, on) => {
  const w = world(on, { files: FILES })
  const beneath = planModeBeneath(on)
  await start($)
  beneath.reject = true
  await exitPlan($, nested)
  expect(await goalLine($)).toBe('goal: nothing tracked')
  beneath.reject = false
  await exitPlan($, nested, { agentId: 'sub-1' })
  expect(await goalLine($)).toBe('goal: nothing tracked')
  await exitPlan($, nested)
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
  beneath.reject = true
  await exitPlan($, phases)
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
  beneath.reject = false
  await exitPlan($, phases)
  expect(await goalLine($)).toBe('goal: Word count tool — 0/12 done (plan)')
  expect((w.last.plan as { steps: unknown[] }).steps.length).toBe(12)
})

test('a plan with no steps is logged and leaves the plan-mode source empty', async ($, on) => {
  const w = world(on, { files: FILES })
  planModeBeneath(on)
  await start($)
  await exitPlan($, nested)
  await exitPlan($, '# Plan: Talk\n\nJust prose.\n')
  expect(await goalLine($)).toBe('goal: nothing tracked')
  expect((w.last.log as Array<{ detail?: string }>)[0].detail).toBe('plan: no steps found')
})

test('precedence: a pinned file hides the plan-mode plan and untrack reveals it; agents are re-matched each time', async ($, on) => {
  world(on, { files: FILES })
  const beneath = planModeBeneath(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag1' }))
  await start($)
  await exitPlan($, nested)
  await $.agent.spawn({ tool_use_id: 'toolu_a', prompt: 'go', description: 'Step 3: lint script', subagentType: 'x:implementer', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  await tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect(await goalLine($)).toBe('goal: Work — 1/3 done (file: /w/plan/p.md § Work)')
  expect(await bandLine1($)).toMatch(/1\/3 done {2}file$/)
  expect(await tool($, { action: 'untrack' })).toBe('untracked')
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
  const state = await tool($, { action: 'state' })
  expect(state).toContain('current: 3 Add a lint script')
  expect(beneath.faults.filter((f) => !/^waypoint: (tool|command)\.register:/.test(f))).toEqual([]) // the harness has no registry
})

test('precedence: a report hides the plan-mode plan, an approval clears the report, track and untrack keep it', async ($, on) => {
  world(on, { files: FILES })
  planModeBeneath(on)
  await start($)
  await exitPlan($, nested)
  // a full list in the turn of the approval is refused (4.3); a later prompt starts new work
  await $.prompt.submit({ text: 'ship it', origin: { kind: 'composer' }, wait: false })
  await tool($, { action: 'report', title: 'Ship it', tasks: [{ id: 'S1', title: 'a', status: 'done' }, { id: 'S2', title: 'b', status: 'open' }] })
  expect(await goalLine($)).toBe('goal: Ship it — 1/2 done (reported)')
  await tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect(await goalLine($)).toBe('goal: Work — 1/3 done (file: /w/plan/p.md § Work)')
  await tool($, { action: 'untrack' })
  expect(await goalLine($)).toBe('goal: Ship it — 1/2 done (reported)')
  await exitPlan($, phases)
  expect(await goalLine($)).toBe('goal: Word count tool — 0/12 done (plan)')
})

test('goal label: an untitled plan takes the newest composer prompt line; slash commands and notifications do not move it', async ($, on) => {
  world(on, { files: FILES })
  planModeBeneath(on)
  await start($)
  await $.prompt.submit({ text: 'Tidy the notes into one folder\nwith an index', origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: '/waypoint status', origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: '<task-notification>\n<status>completed</status>', origin: { kind: 'task-notification' }, wait: false })
  await exitPlan($, '## Steps\n1. make the folder\n2. write the index\n')
  expect(await goalLine($)).toBe('goal: Tidy the notes into one folder — 0/2 done (plan)')
  // with a plan-mode goal standing, a new prompt does not replace the label
  await $.prompt.submit({ text: 'now do step 1', origin: { kind: 'composer' }, wait: false })
  expect(await goalLine($)).toBe('goal: Tidy the notes into one folder — 0/2 done (plan)')
})

test('persistence: the plan-mode source and the label survive a fork reload, not a /clear; the saved record holds steps, not the text', async ($, on) => {
  const w = world(on, { files: FILES, sessionId: 's-1' })
  const beneath = planModeBeneath(on)
  await start($)
  await $.prompt.submit({ text: 'Count the words', origin: { kind: 'composer' }, wait: false })
  await exitPlan($, phases)
  await w.clock.advance(1000)
  expect(beneath.faults.filter((f) => !/^waypoint: (tool|command)\.register:/.test(f))).toEqual([]) // the harness has no registry
  const rec = w.store['session:s-1'] as { plan: { title: string; steps: unknown[]; text?: string }; label: Record<string, string>; prompt: string }
  expect(rec.plan.steps.length).toBe(12)
  expect(rec.plan.title).toBe('Word count tool')
  expect(rec.plan.text).toBe(undefined)
  expect(rec.label).toEqual({ plan: 'Count the words' })
  expect(rec.prompt).toBe('Count the words')
  w.setSessionId('s-2')
  await $.classic.SessionStart({ source: 'fork', session_id: 's-2' })
  expect(await goalLine($)).toBe('goal: Word count tool — 0/12 done (plan)')
  expect(w.last.label).toEqual({ plan: 'Count the words' })
  w.setSessionId('s-3')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-3' })
  expect(await goalLine($)).toBe('goal: nothing tracked')
  expect(w.last.label).toEqual({})
})

test('state: a plan-mode plan lists its step ids, qualified when numbering restarts, so report updates can name them', async ($, on) => {
  world(on, { files: FILES, sessionId: 's-1' })
  planModeBeneath(on)
  await start($)
  await exitPlan($, '# Plan: Two phase demo\n\n## Phase 1: Setup\n1. make folder src\n2. write src/a.txt\n\n## Phase 2: Build\n1. write src/b.txt\n2. list src\n')
  const lines = (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_s', action: 'state' })).result.split('\n')
  expect(lines[2]).toBe('steps: 1.1 make folder src (open) · 1.2 write src/a.txt (open) · 2.1 write src/b.txt (open) · 2.2 list src (open)')
  expect((await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_u', action: 'report', updates: [{ id: '2.1', status: 'done' }] })).result).toBe('updated 1 tasks')
})
