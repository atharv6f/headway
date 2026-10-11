import { expect, test } from 'claude-code/testing'
import { start, TOOL, world } from './world.ts'
import { quietSegs } from '../hooks/quiet.tsx'
import { register } from '../hooks/register.tsx'
import type { Seg } from '../hooks/band.tsx'

// The transcript rows of headway's own tool (SPEC 10.4): one dim line per call, the result folded in.
const text = (segs: Seg[]) => segs.map((s) => s.text).join('')
const row = (input: unknown, over: Record<string, unknown> = {}, ascii = false) =>
  quietSegs({ input, output: 'reported 3 tasks', isErrored: false, isRunning: false, ascii, ...over })

const LIST = { action: 'report', title: 'Colour files', tasks: [{ title: 'Create red.txt' }, { title: 'Create blue.txt' }, { title: 'Read both' }] }

test('quiet row: a report list is the step count and the titles', async () => {
  expect(text(row(LIST))).toBe('◆ headway · 3 steps: Create red.txt · Create blue.txt · Read both')
  expect(text(row({ action: 'report', tasks: [{ title: 'Only' }] }))).toBe('◆ headway · 1 step: Only')
})

test('quiet row: updates are one glyph and id each, done is a done mark', async () => {
  expect(text(row({ action: 'report', updates: [{ id: '1', status: 'partial' }] }))).toBe('◐ step 1')
  expect(text(row({ action: 'report', updates: [{ id: 1, status: 'done' }, { id: '2', status: 'done' }, { id: '3', status: 'partial' }] }))).toBe(
    '✓ step 1 · ✓ step 2 · ◐ step 3',
  )
  expect(text(row({ action: 'report', done: ['3'] }))).toBe('✓ step 3')
  expect(text(row({ action: 'report', updates: [{ id: '1', status: 'open' }] }))).toBe('○ step 1')
})

test('quiet row: track, state, focus and untrack', async () => {
  expect(text(row({ action: 'track', file: 'ROADMAP.md', section: 'Release 1' }))).toBe('◆ tracking ROADMAP.md § Release 1')
  expect(text(row({ action: 'track', file: 'ROADMAP.md' }))).toBe('◆ tracking ROADMAP.md')
  expect(text(row({ action: 'state' }, { output: 'goal: x\ncurrent: y' }))).toBe('◆ headway state')
  expect(text(row({ action: 'focus', taskId: 'T2' }))).toBe('▸ focus T2')
  expect(text(row({ action: 'untrack' }))).toBe('◆ untracked')
})

test('quiet row: ascii mode uses the ascii glyphs and separator', async () => {
  expect(text(row(LIST, {}, true))).toBe('* headway - 3 steps: Create red.txt - Create blue.txt - Read both')
  expect(text(row({ action: 'report', updates: [{ id: '1', status: 'done' }, { id: '2', status: 'partial' }] }, {}, true))).toBe('+ step 1 - / step 2')
})

test('quiet row: a refusal shows its text in the error colour, unknown ids as a warning beside the row', async () => {
  const refused = row({ action: 'report' }, { output: 'refused: tasks, updates or done required' })
  expect(text(refused)).toBe('✕ headway · refused: tasks, updates or done required')
  expect(refused.every((s) => s.el === 'failed')).toBe(true)
  const partial = row({ action: 'report', updates: [{ id: '1', status: 'done' }, { id: 'R9', status: 'done' }] }, { output: 'updated 1 tasks; unknown task: R9' })
  expect(text(partial)).toBe('✓ step 1 · ✓ step R9  ⚠ unknown task: R9')
  expect(partial[partial.length - 1].el).toBe('warning')
  expect(text(row({ action: 'focus', taskId: 'X' }, { output: 'unknown task: X' }))).toBe('⚠ headway · unknown task: X')
  const errored = row({ action: 'report' }, { isErrored: true, output: 'tool failed' })
  expect(text(errored)).toBe('✕ headway · tool failed')
})

test('quiet row: titles, ids, a file name and a reply with escapes or line breaks draw as plain text', async () => {
  const link = '\u001b]8;;https://evil.example/x\u001b\\click\u001b]8;;\u001b\\'
  const t = text(row({ action: 'report', tasks: [{ title: 'Read\nthe ' + link + ' \u001b[2J' }, { title: 'two' }] }))
  expect(t).toBe('◆ headway · 2 steps: Read the click · two')
  expect(text(row({ action: 'report', updates: [{ id: 'A\u001b[31m1', status: 'done' }] }))).toBe('✓ step A1')
  expect(text(row({ action: 'track', file: 'a\n.md\u001b]0;x\u0007', section: 'S\r\nT' }))).toBe('◆ tracking a .md § S T')
  expect(text(row({ action: 'report' }, { output: 'refused: bad \u001b[31mred\nline' }))).toBe('✕ headway · refused: bad red line')
  expect(text(row({ action: 'focus', taskId: 'X\n' }, { output: 'unknown task: X\u001b[2J' }))).toBe('⚠ headway · unknown task: X')
})

test('quiet row: a call still running, or a result in an unexpected shape, still draws its line', async () => {
  expect(text(row(LIST, { isRunning: true, output: undefined }))).toContain('3 steps')
  expect(text(row(LIST, { output: { result: 'reported 3 tasks' } }))).toContain('3 steps')
  expect(text(row(null))).toBe('◆ headway')
  expect(text(row({ action: 'report' }, { output: undefined }))).toBe('◆ headway · report')
})

// ---------------------------------------------------------------- the hook

const USE = { tool_use_id: 'toolu_q', tool: TOOL, input: LIST, isRunning: false, isErrored: false, isInterrupted: false, output: 'reported 3 tasks' }

async function texts($, component: 'ToolUse' | 'ToolResult', props: Record<string, unknown>): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: 'headway', surface: 'terminal', component, requestId: 'toolu_q', props })
  const out: string[] = []
  for (const re of [/headway · 3 steps/, /stock row/, /step \d/, /refused/]) {
    const hit = await ui.find({ type: 'Text', text: re })
    if (hit) out.push(hit.text as string)
  }
  await ui.unmount()
  return out
}

function stock(on) {
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['stock row'] }))
}

test('hook: headway\'s own tool draws the quiet line and not the stock row; its result block draws nothing', async ($, on) => {
  world(on, {})
  stock(on)
  await start($)
  expect(await texts($, 'ToolUse', USE)).toEqual(['◆ headway · 3 steps: Create red.txt · Create blue.txt · Read both'])
  expect(await texts($, 'ToolResult', { tool_use_id: 'toolu_q', tool: TOOL, output: 'reported 3 tasks', isErrored: false })).toEqual([])
  const refusal = { ...USE, input: { action: 'report' }, output: 'refused: tasks, updates or done required' }
  expect(await texts($, 'ToolUse', refusal)).toEqual(['✕ headway · refused: tasks, updates or done required'])
})

test('hook: any other tool keeps its stock row and result', async ($, on) => {
  world(on, {})
  stock(on)
  await start($)
  expect(await texts($, 'ToolUse', { ...USE, tool: 'Bash', input: { command: 'ls' } })).toEqual(['stock row'])
  expect(await texts($, 'ToolResult', { tool_use_id: 'toolu_q', tool: 'Bash', output: {}, isErrored: false })).toEqual(['stock row'])
  expect(await texts($, 'ToolUse', { ...USE, tool: 'mcp__other__thing' })).toEqual(['stock row'])
})

test('hook: quietToolRows false restores the stock rows', { options: { quietToolRows: false } }, async ($, on) => {
  world(on, {})
  stock(on)
  await start($)
  expect(await texts($, 'ToolUse', USE)).toEqual(['stock row'])
  expect(await texts($, 'ToolResult', { tool_use_id: 'toolu_q', tool: TOOL, output: 'x', isErrored: false })).toEqual(['stock row'])
})

// ---------------------------------------------------------------- batch B: the transcript hook is narrow


function renderMatchers(options: Record<string, unknown>): unknown[] {
  const seen: unknown[] = []
  const on = (event: string, ...rest: unknown[]) => {
    if (event === 'ui.render') seen.push(rest.length > 1 ? rest[0] : undefined)
    const chain = { catch: () => chain }
    return chain
  }
  register(on, options)
  return seen
}

test('registration: the band and the pane have their own ui.render hook; the transcript rows are only headway\'s own tool', async () => {
  expect(renderMatchers({})).toEqual([{ component: ['AbovePrompt', 'Pane'] }, { component: ['ToolUse', 'ToolResult'], props: { tool: TOOL } }])
})

test('registration: quietToolRows false registers no transcript hook at all', async () => {
  expect(renderMatchers({ quietToolRows: false })).toEqual([{ component: ['AbovePrompt', 'Pane'] }])
})
