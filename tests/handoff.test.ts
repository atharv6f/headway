import { expect, test } from 'claude-code/testing'
import { start, TOOL, world, userCommand } from './world.ts'
import { text as nested } from './fixtures/plan-nested.ts'
import { GUIDE_TEXT, TOOL_SPEC } from '../hooks/tool.ts'

// The plan-mode handoff (SPEC 4.3, 4.4, 6): after an approval waypoint already tracks the plan, so a
// `track` of the plan file and a full `report` list in the same turn are refused or turned into a no-op.
const PLAN_FILE = '/home/u/.claude/plans/some-plan.md'
const OTHER_PLAN = '/home/u/.claude/plans/other-plan.md'
const ENV = { HOME: '/home/u' }
const FILES = { [PLAN_FILE]: nested, [OTHER_PLAN]: '- [ ] a\n- [ ] b\n', '/w/own.md': '- [ ] a\n- [ ] b\n' }
const IDS = 'ids: 1, 2, 3, 4'

function approving(on) {
  on('tool.call', async (_$, e) => ({ result: { plan: e.plan, isAgent: false, filePath: PLAN_FILE } }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
}

const approve = ($, plan = nested) => $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_p' + Math.random(), plan, planFilePath: PLAN_FILE })

async function tool($, input: Record<string, unknown>): Promise<string> {
  return (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_w', ...input })).result as string
}

const goalLine = async ($) => (await tool($, { action: 'state' })).split('\n')[0]
const LIST = { action: 'report', title: 'Mine', tasks: [{ title: 'x' }, { title: 'y' }] }

test('guidance and tool description: the handoff sentence and the plan-mode note are present', async () => {
  expect(GUIDE_TEXT).toContain("After plan-mode approval waypoint already tracks the plan: don't pin its file or report a new list; send `updates` with the ids `state` shows.")
  expect(GUIDE_TEXT.split(/\s+/).length).toBeLessThanOrEqual(155)
  expect(TOOL_SPEC.description).toContain('plan FILE the user asked to track')
  expect(TOOL_SPEC.description).toContain('plan-mode plans are tracked automatically')
})

const mainTurnEnds = ($) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

test('track: only the approved plan file, by its normalised path, is a no-op naming the ids; another plans-directory file is not taken for it', async ($, on) => {
  const w = world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  await approve($)
  const want = 'already tracking this plan from plan mode; use report updates with ' + IDS
  expect(await tool($, { action: 'track', file: PLAN_FILE })).toBe(want)
  expect(await tool($, { action: 'track', file: '../home/u/.claude/plans/../plans/./some-plan.md' })).toBe(want)
  expect(w.last.filter ?? null).toBe(null)
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
  // the reviewer's trap: another plan file is not refused as "this plan"; through the tool it is
  // outside the project (SPEC 14), and the user's own command pins it
  expect(await tool($, { action: 'track', file: OTHER_PLAN })).toBe('refused: outside the project; ask the user to run /waypoint track ' + OTHER_PLAN)
  expect((await userCommand($, 'track ' + OTHER_PLAN)).text).toMatch(/^tracking \/home\/u\/\.claude\/plans\/other-plan\.md/)
  expect((w.last.filter as { file: string }).file).toBe(OTHER_PLAN)
})

test('track: the approved file stays a no-op after the approval turn while the plan is unfinished; once it is done, track pins it', async ($, on) => {
  const w = world(on, { files: FILES, env: ENV })
  approving(on)
  on('turn.complete', async () => ({ text: '' }))
  await start($)
  await approve($)
  await mainTurnEnds($)
  await tool($, { action: 'report', updates: [{ id: '1', status: 'done' }, { id: '2', status: 'done' }, { id: '3', status: 'done' }] })
  expect(await tool($, { action: 'track', file: PLAN_FILE })).toBe('already tracking this plan from plan mode; use report updates with ' + IDS)
  // the reviewer's trap: a finished plan no longer turns its file away with advice to send updates
  await tool($, { action: 'report', done: ['4'] })
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 4/4 done (plan)')
  expect(await tool($, { action: 'track', file: PLAN_FILE })).toMatch(/^tracking \/home\/u\/\.claude\/plans\/some-plan\.md/)
  expect((w.last.filter as { file: string }).file).toBe(PLAN_FILE)
})

test('track: with no plan-mode plan active, a plans-directory file is outside the project for the tool and pinned by the command', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  await start($)
  expect(await tool($, { action: 'track', file: OTHER_PLAN })).toBe('refused: outside the project; ask the user to run /waypoint track ' + OTHER_PLAN)
  expect((await userCommand($, 'track ' + OTHER_PLAN)).text).toMatch(/^tracking \/home\/u\/\.claude\/plans\/other-plan\.md/)
})

test('report: a full list in the turn of the approval is refused with the ids; nothing changes', async ($, on) => {
  const w = world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  await approve($)
  expect(await tool($, LIST)).toBe('refused: a plan from plan mode is tracked; send updates with its ids: 1, 2, 3, 4')
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
  expect(w.last.report ?? null).toBe(null)
  // updates still work, and once one has been sent a full list replaces the plan as before
  expect(await tool($, { action: 'report', updates: [{ id: '1', status: 'done' }] })).toBe('updated 1 tasks')
  expect(await tool($, LIST)).toBe('reported 2 tasks')
  expect(await goalLine($)).toBe('goal: Mine — 0/2 done (reported)')
})

test('report: an updates call naming only unknown ids also ends the freshness, leaving the plan untouched', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  await approve($)
  expect(await tool($, { action: 'report', updates: [{ id: '9', status: 'done' }] })).toBe('updated 0 tasks; unknown task: 9')
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
  expect(await tool($, LIST)).toBe('reported 2 tasks')
})

test('report: the first main-loop turn.complete after the approval ends the freshness; a subagent turn does not', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  approving(on)
  on('turn.complete', async () => ({ text: '' }))
  await start($)
  await approve($)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', agentId: 'ag-sub', reason: 'answer' })
  expect(await tool($, LIST)).toMatch(/^refused: a plan from plan mode is tracked/)
  await mainTurnEnds($)
  expect(await tool($, LIST)).toBe('reported 2 tasks')
  expect(await goalLine($)).toBe('goal: Mine — 0/2 done (reported)')
})

test('report: any later prompt ends the freshness, a task notification or a slash command included (the reviewer trap)', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  for (const prompt of [
    { text: '<task-notification>\n<status>completed</status>', origin: { kind: 'task-notification' } },
    { text: '/review the diff', origin: { kind: 'composer' } },
    { text: 'from the IDE', origin: { kind: 'ide' } },
    { text: 'now something else', origin: { kind: 'composer' } },
  ]) {
    await approve($)
    expect(await tool($, LIST)).toMatch(/^refused: a plan from plan mode is tracked/)
    await $.prompt.submit({ ...prompt, wait: false })
    expect(prompt.text + ' => ' + (await tool($, LIST))).toBe(prompt.text + ' => reported 2 tasks')
  }
})

test('report: a second approval guards the new plan again; more than twelve ids end in +n', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  await approve($)
  await tool($, { action: 'report', updates: [{ id: '1', status: 'done' }] })
  const long = '# Plan: Long\n' + Array.from({ length: 15 }, (_, i) => i + 1 + '. step ' + (i + 1)).join('\n') + '\n'
  await approve($, long)
  const ids = Array.from({ length: 12 }, (_, i) => String(i + 1)).join(', ')
  expect(await tool($, LIST)).toBe('refused: a plan from plan mode is tracked; send updates with its ids: ' + ids + ', +3')
  expect(await tool($, { action: 'track', file: PLAN_FILE })).toBe('already tracking this plan from plan mode; use report updates with ids: ' + ids + ', +3')
})

test('report: a full list is taken when no plan-mode plan stands (nothing approved, or a plan with no step)', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  expect(await tool($, LIST)).toBe('reported 2 tasks')
  await approve($, '# Plan: Prose only\nJust words.\n')
  expect(await tool($, LIST)).toBe('reported 2 tasks')
})

test('track: on Windows the approved file is told by its normalised path in any case and either separator', async ($, on) => {
  const WIN_PLAN = 'C:\\Users\\u\\.claude\\plans\\some-plan.md'
  const w = world(on, { files: { [WIN_PLAN]: nested, 'C:\\Users\\u\\proj\\own.md': '- [ ] a\n' }, env: { USERPROFILE: 'C:\\Users\\u' }, cwd: 'C:\\Users\\u\\proj' })
  on('tool.call', async (_$, e) => ({ result: { plan: e.plan, isAgent: false, filePath: WIN_PLAN } }))
  await start($)
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_pw', plan: nested, planFilePath: WIN_PLAN })
  const want = 'already tracking this plan from plan mode; use report updates with ' + IDS
  expect(await tool($, { action: 'track', file: 'c:/users/u/.claude/plans/SOME-PLAN.md' })).toBe(want)
  expect(await tool($, { action: 'track', file: '..\\.claude\\plans\\some-plan.md' })).toBe(want)
  expect(w.last.filter ?? null).toBe(null)
  expect(await tool($, { action: 'track', file: 'own.md' })).toMatch(/^tracking C:\\Users\\u\\proj\\own\.md/)
})

// "Yes, clear context" on the plan dialog (verified 2.1.296, docs/verified.md): ExitPlanMode returns
// the rejection text with isError, the session clears in the same turn, the old turn completes after
// the clear, and the new conversation's first turn starts with no prompt.submit.
const REJECTED = "Error: The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

function clearing(on, outcome: 'clear' | 'approve') {
  on('tool.call', async (_$, e) => (outcome === 'clear' ? { result: REJECTED, isError: true } : { result: { plan: e.plan, isAgent: false, filePath: PLAN_FILE } }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: '' }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
}
const turnEnds = ($) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })
const turnStarts = ($) => $.turn.start({ turnId: 'main2', text: '' })

for (const outcome of ['clear', 'approve'] as const) {
  test('approve and clear context (' + outcome + '): the plan crosses the clear with its label and stays fresh through the new first turn', async ($, on) => {
    const w = world(on, { files: FILES, env: ENV, sessionId: 's-1' })
    clearing(on, outcome)
    await start($)
    await $.prompt.submit({ text: 'Tidy my notes', origin: { kind: 'composer' }, wait: false })
    await approve($)
    await w.clock.advance(50)
    w.setSessionId('s-2')
    await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
    await turnEnds($) // the old turn, completing after the clear
    expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
    expect(w.last.label).toEqual({ plan: 'Tidy my notes' })
    await turnStarts($)
    expect(await tool($, LIST)).toMatch(/^refused: a plan from plan mode is tracked/)
    expect(await tool($, { action: 'track', file: PLAN_FILE })).toMatch(/^already tracking this plan from plan mode/)
    await turnEnds($)
    expect(await tool($, LIST)).toBe('reported 2 tasks')
  })
}

test('a rejected plan, its turn over, then /clear: no plan crosses; an approval more than 10 s before a /clear is dropped like any prompt-driven source', async ($, on) => {
  const w = world(on, { files: FILES, env: ENV, sessionId: 's-1' })
  clearing(on, 'clear')
  await start($)
  await approve($)
  await turnEnds($)
  w.setSessionId('s-2')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
  expect(await goalLine($)).toBe('goal: nothing tracked')
})

test('an approval, then a /clear more than 10 s later: the plan is dropped', async ($, on) => {
  const w = world(on, { files: FILES, env: ENV, sessionId: 's-1' })
  clearing(on, 'approve')
  await start($)
  await approve($)
  expect(await goalLine($)).toBe('goal: Tidy the notes folder — 0/4 done (plan)')
  await w.clock.advance(10_001)
  w.setSessionId('s-2')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
  expect(await goalLine($)).toBe('goal: nothing tracked')
})

// The approval's own note (SPEC 4.4, 6): session guidance alone left small plans unreported, so an
// approval returns a `context` note naming the steps and the two calls to make.
const noteOf = (r): string[] => (r as { context?: string[] }).context ?? []
const SMALL = '# Plan: Greeter\n\n## Context\nA greeter.\n\n## Steps\n1. Add greet.py\n2. Add README line\n3. Run it\n\n## Verification\nRun it.\n'

test('approval note: a successful approval adds one context note naming the ids and titles, under 70 words', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  const r = await approve($, SMALL)
  expect(noteOf(r)).toEqual([
    'waypoint is tracking this plan: 1 Add greet.py · 2 Add README line · 3 Run it. As you work, call waypoint report with updates [{id, status: "partial"}] when you start a step and "done" when it is finished.',
  ])
  expect(noteOf(r)[0].split(/\s+/).length).toBeLessThanOrEqual(60)
})

test('approval note: notes already in context are kept; the result is otherwise the engine\'s', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  on('tool.call', async (_$, e) => ({ result: { plan: e.plan, isAgent: false, filePath: PLAN_FILE }, context: ['earlier'] }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await start($)
  const r = await approve($, SMALL)
  expect(noteOf(r)[0]).toBe('earlier')
  expect(noteOf(r)).toHaveLength(2)
  expect((r as { result: { filePath: string } }).result.filePath).toBe(PLAN_FILE)
})

test('approval note: more than six steps list ids only, at most twelve then +n', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  const many = Array.from({ length: 14 }, (_, i) => i + 1 + '. step number ' + (i + 1)).join('\n') + '\n'
  const note = noteOf(await approve($, many))[0]
  expect(note).toContain('waypoint is tracking this plan: ids 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, +2.')
  expect(note.split(/\s+/).length).toBeLessThanOrEqual(60)
})

test('approval note: none for a rejection, a plan with no steps, a subagent\'s plan, or guideClaude false', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  on('tool.call', async (_$, e) => (e.plan.includes('REJECT') ? { result: REJECTED, isError: true } : { result: { plan: e.plan, isAgent: false, filePath: PLAN_FILE } }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await start($)
  expect(noteOf(await approve($, 'REJECT\n1. a\n2. b\n'))).toEqual([])
  expect(noteOf(await approve($, 'Just prose, no steps at all.\n'))).toEqual([])
  const sub = await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_s', plan: SMALL, planFilePath: PLAN_FILE, agentId: 'ag1' })
  expect(noteOf(sub)).toEqual([])
})

test('approval note: none with guideClaude false', { options: { guideClaude: false } }, async ($, on) => {
  world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  const r = await approve($, SMALL)
  expect(noteOf(r)).toEqual([])
  expect(await goalLine($)).toBe('goal: Greeter — 0/3 done (plan)')
})

test('approval note: none when a file is pinned over the plan', async ($, on) => {
  world(on, { files: FILES, env: ENV })
  approving(on)
  await start($)
  await tool($, { action: 'track', file: '/w/own.md' })
  expect(noteOf(await approve($, SMALL))).toEqual([])
})
