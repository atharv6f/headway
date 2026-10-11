import { expect, test } from 'claude-code/testing'
import { PLAN, start, TOOL, world } from './world.ts'
import { text as nested } from './fixtures/plan-nested.ts'
import * as f from './fixtures/report.ts'
import { GUIDE_ID, GUIDE_TEXT } from '../hooks/tool.ts'

// P2 through the hooks: report updates and refusals (SPEC 4.3), partial in the goal, the band and the
// state block, temporal association at a spawn (5.3), and the guidance section (6).
const FILES = { '/w/plan/p.md': PLAN }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 100, scroll: { offset: 0, bodyRows: 15 }, view: {} }
const PLAN_FILE = '/home/u/.claude/plans/some-plan.md'

async function tool($, input: Record<string, unknown>): Promise<string> {
  return (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_w', ...input })).result as string
}

const stateLines = async ($) => (await tool($, { action: 'state' })).split('\n')
const goalLine = async ($) => (await stateLines($))[0]

async function bandLines($): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const out: string[] = []
  for (const re of [/◆/, /▸/]) out.push(((await ui.find({ type: 'Text', text: re }))?.text as string | undefined) ?? '')
  await ui.unmount()
  return out
}

function spawnInput(over: Record<string, unknown>) {
  return {
    tool_use_id: 'toolu_1', prompt: 'Reply ok', description: 'a task', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...over,
  }
}

// the engine's ExitPlanMode beneath, approving
function approving(on) {
  on('tool.call', async (_$, e) => ({ result: { plan: e.plan, isAgent: false, filePath: PLAN_FILE } }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
}

test('report: a list without ids is 1..n; updates and done move the statuses and the goal says so', async ($, on) => {
  const w = world(on, { files: FILES })
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  await start($)
  expect(await tool($, { action: 'report', ...f.noIds })).toBe('reported 3 tasks')
  expect(await goalLine($)).toBe('goal: Fruit files — 0/3 done (reported)')
  expect((w.last.report as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id)).toEqual(['1', '2', '3'])
  expect(await tool($, { action: 'report', updates: [{ id: '1', status: 'done' }, { id: '2', status: 'partial' }] })).toBe('updated 2 tasks')
  expect(await goalLine($)).toBe('goal: Fruit files — done 1 · partial 1 · open 1 / 3 (reported)')
  // line 1: the two-tone count; line 2: the partial task is the current one, with no agent
  const [line1, line2] = await bandLines($)
  expect(line1).toContain('done 1 · partial 1 · open 1 / 3')
  expect(line1).toContain('▓')
  expect(line1).toMatch(/reported$/)
  expect(line2).toContain('2 Create b.txt')
  expect((await stateLines($))[1]).toMatch(/^current: 2 Create b\.txt/)
  expect(await tool($, { action: 'report', done: ['2', '3'] })).toBe('updated 2 tasks')
  expect(await goalLine($)).toBe('goal: Fruit files — 3/3 done (reported)')
  expect((await bandLines($))[0]).toContain('3/3 done')
})

test('report: an unknown id is named back and the rest still apply; ids may be numbers', async ($, on) => {
  world(on, { files: FILES })
  await start($)
  await tool($, { action: 'report', ...f.withIds })
  expect(await goalLine($)).toBe('goal: Release — done 1 · partial 1 · open 1 / 3 (reported)')
  expect(await tool($, { action: 'report', ...f.unknownUpdate })).toBe('updated 1 tasks; unknown task: R9')
  expect(await goalLine($)).toBe('goal: Release — done 1 · partial 2 · open 0 / 3 (reported)')
  await tool($, { action: 'report', ...f.noIds })
  expect(await tool($, { action: 'report', done: [1] })).toBe('updated 1 tasks')
  expect(await goalLine($)).toBe('goal: Fruit files — 1/3 done (reported)')
})

test('report: refusals reach the caller and change nothing', async ($, on) => {
  world(on, { files: FILES })
  await start($)
  expect(await tool($, { action: 'report', ...f.both })).toBe('refused: tasks and updates or done cannot be combined in one call')
  expect(await tool($, { action: 'report', ...f.duplicateIds })).toBe('refused: duplicate id: A')
  // updates with nothing reported (no source) are refused
  expect(await tool($, { action: 'report', done: ['1'] })).toBe('refused: updates apply to a reported or plan-mode list')
  expect(await goalLine($)).toBe('goal: nothing tracked')
  await tool($, { action: 'report', ...f.noIds })
  expect(await tool($, { action: 'report', updates: [{ id: '1' }] })).toBe('refused: update 1: status must be open, partial or done')
  expect(await goalLine($)).toBe('goal: Fruit files — 0/3 done (reported)')
})

test('report: with a file pinned, updates are refused; a list is taken and waits beneath the file', async ($, on) => {
  world(on, { files: FILES })
  await start($)
  await tool($, { action: 'report', ...f.noIds })
  await tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect(await tool($, { action: 'report', done: ['1'] })).toBe('refused: updates apply to a reported or plan-mode list')
  expect(await tool($, { action: 'report', title: 'New', tasks: [{ title: 'only' }] })).toBe('reported 1 tasks')
  expect(await goalLine($)).toBe('goal: Work — 1/3 done (file: /w/plan/p.md § Work)')
  await tool($, { action: 'untrack' })
  expect(await goalLine($)).toBe('goal: New — 0/1 done (reported)')
  expect(await tool($, { action: 'report', done: ['1'] })).toBe('updated 1 tasks')
})

test('report: updates move a plan-mode plan by step id, and the plan text is kept', async ($, on) => {
  const w = world(on, { files: FILES })
  approving(on)
  await start($)
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_p', plan: nested, planFilePath: PLAN_FILE })
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
  expect(await tool($, { action: 'report', updates: [{ id: '1', status: 'done' }, { id: '2', status: 'partial' }] })).toBe('updated 2 tasks')
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — done 1 · partial 1 · open 2 / 4 (plan)')
  expect((await stateLines($))[1]).toMatch(/^current: 2 Write an index/)
  expect((w.last.plan as { text?: string }).text).toBe(nested)
  expect(await tool($, { action: 'report', done: ['9'] })).toBe('updated 0 tasks; unknown task: 9')
})

test('report: a flip is logged, so the log and the compact boundary hear of it', async ($, on) => {
  const w = world(on, { files: FILES })
  await start($)
  await tool($, { action: 'report', ...f.noIds })
  await tool($, { action: 'report', updates: [{ id: '1', status: 'partial' }] })
  await tool($, { action: 'report', done: ['1'] })
  expect((w.last.log as Array<{ kind: string; ref: string; detail?: string }>).map((l) => l.kind + ':' + l.ref + ':' + l.detail)).toEqual([
    'task-done:1:done',
    'task-partial:1:partial',
    'report::reported 3 tasks § Fruit files',
  ])
})

test('temporal: an agent that names no step joins the one partial task; two partial, none, or an id, do not', async ($, on) => {
  const w = world(on, { files: FILES })
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag' + ++n }))
  await start($)
  const agents = () => w.last.agents as Array<{ id: string; taskIds: string[]; groupId?: string }>
  await tool($, { action: 'report', ...f.noIds })
  await $.agent.spawn(spawnInput({ tool_use_id: 't1', description: 'write the file' }))
  expect(agents()[0]).toMatchObject({ taskIds: [] }) // none partial: Agents group
  await tool($, { action: 'report', updates: [{ id: '2', status: 'partial' }] })
  await $.agent.spawn(spawnInput({ tool_use_id: 't2', description: 'write the file' }))
  expect(agents()[1]).toMatchObject({ taskIds: ['2'], groupId: 'Fruit files' })
  await $.agent.spawn(spawnInput({ tool_use_id: 't3', description: 'step 3: list them' }))
  expect(agents()[2]).toMatchObject({ taskIds: ['3'] }) // an id wins
  await tool($, { action: 'report', updates: [{ id: '3', status: 'partial' }] })
  await $.agent.spawn(spawnInput({ tool_use_id: 't4', description: 'write the file' }))
  expect(agents()[3].taskIds).toEqual([]) // two partial
  // statuses moving does not re-match
  expect(agents()[1]).toMatchObject({ taskIds: ['2'] })
  expect(agents()[0].taskIds).toEqual([])
  // the current task is that of the newest unfinished agent matched to a task (3), not the partial one
  expect((await stateLines($))[1]).toBe('current: 3 List them — 0/1 agents finished')
})

test('temporal: a partial task of a pinned file does not attract agents', async ($, on) => {
  const w = world(on, { files: FILES })
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag1' }))
  await start($)
  await tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed', partial: 'published' })
  await $.agent.spawn(spawnInput({ description: 'write the file' }))
  expect((w.last.agents as Array<{ taskIds: string[] }>)[0].taskIds).toEqual([])
})

// ---------------------------------------------------------------- the guidance section

const compose = ($, over: Record<string, unknown> = {}) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: ['Bash', TOOL], outputStyle: null, traits: [], ...over } as never)
const ids = async ($, over: Record<string, unknown> = {}) => (await compose($, over)).sections.map((s) => s.id)

function base(on) {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'You are Claude.', scope: 'shared' as const }] }))
}

test('guide: waypoint:guide is appended after the engine sections as session scope, with the spec text', async ($, on) => {
  world(on, { files: FILES })
  base(on)
  await start($)
  const sections = (await compose($)).sections
  expect(sections.map((s) => s.id)).toEqual(['base', GUIDE_ID])
  expect(sections[1]).toEqual({ id: 'waypoint:guide', text: GUIDE_TEXT, scope: 'session' })
  expect(GUIDE_TEXT).toContain('action: "report"')
  expect(GUIDE_TEXT).toContain('status: "done"')
  // the report list carries a short goal title (6 words at most), and the section stays near its word budget
  expect(GUIDE_TEXT).toContain('a goal `title` of at most 6 words')
  expect(GUIDE_TEXT.split(/\s+/).length).toBeLessThanOrEqual(155)
})

test('guide: left out for guideClaude false', { options: { guideClaude: false } }, async ($, on) => {
  world(on, { files: FILES })
  base(on)
  await start($)
  expect(await ids($)).toEqual(['base'])
})

test('guide: left out for a session that draws nowhere (no surface, bare, print)', async ($, on) => {
  world(on, { files: FILES })
  base(on)
  await start($)
  expect(await ids($, { surfaces: [] })).toEqual(['base'])
  expect(await ids($, { traits: ['bare'] })).toEqual(['base'])
  expect(await ids($, { traits: ['print'] })).toEqual(['base'])
  expect(await ids($)).toEqual(['base', 'waypoint:guide'])
})

test('guide: a pinned file withdraws it on the next compose; untrack brings it back', async ($, on) => {
  world(on, { files: FILES })
  base(on)
  await start($)
  expect(await ids($)).toEqual(['base', 'waypoint:guide'])
  await tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect(await ids($)).toEqual(['base'])
  await tool($, { action: 'untrack' })
  expect(await ids($)).toEqual(['base', 'waypoint:guide'])
})

test('guide: only for a request that offers the waypoint tool', async ($, on) => {
  world(on, { files: FILES })
  base(on)
  await start($)
  expect(await ids($, { tools: ['Bash', 'Read'] })).toEqual(['base'])
  expect(await ids($, { tools: [] })).toEqual(['base'])
  // ToolSearch alone is not the tool: a deferred tool is named in e.tools all the same
  expect(await ids($, { tools: ['Bash', 'ToolSearch'] })).toEqual(['base'])
  expect(await ids($, { tools: [TOOL] })).toEqual(['base', 'waypoint:guide'])
})

test('guide: only for the main loop: a teammate or an analysis render leaves it out; the lean body (the main loop on some models) keeps it', async ($, on) => {
  world(on, { files: FILES })
  base(on)
  await start($)
  for (const trait of ['teammate', 'analysis']) expect(await ids($, { traits: [trait] })).toEqual(['base'])
  expect(await ids($, { traits: ['lean', 'skills'] })).toEqual(['base', 'waypoint:guide'])
})
