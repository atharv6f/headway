import { expect, test } from 'claude-code/testing'
import { completeAgent, globMatch, matchAgent, spawnAgent } from '../plugin/hooks/agents.ts'
import { LINE_MAX, parsePlan } from '../plugin/hooks/plan.ts'
import { numberedLine, parsePlanMode, plainTitle } from '../plugin/hooks/planmode.ts'
import { parseThemeFile } from '../plugin/hooks/theme.ts'
import { promptLabel } from '../plugin/hooks/sources.ts'
import { definitionModel } from '../plugin/hooks/router.ts'
import { parseWorkflow } from '../plugin/hooks/workflow.ts'
import type { Plan } from '../plugin/hooks/plan.ts'
import { filterFromInput, insideDir, parsePinArgs } from '../plugin/hooks/pin.ts'
import { TOOL_SPEC } from '../plugin/hooks/tool.ts'
import { PLAN, start, TOOL, world } from './world.ts'

// Text a model or a file supplies never makes a match run long (SPEC 5.2, 5.3, 14): a workflow
// label pattern is a linear glob, never a regex; there is no user regex at all (no `pattern=`), and
// plan IDs are matched as escaped literals.

function timed<T>(f: () => T): { value: T; ms: number } {
  const at = performance.now()
  const value = f()
  return { value, ms: performance.now() - at }
}

function ok(r: ReturnType<typeof parsePlan>): Plan {
  if (!r.ok) throw new Error('expected a plan, got refusal: ' + r.error)
  return r.plan
}

// ---------------------------------------------------------------- 1a: workflow label patterns

test('globMatch: a literal is equality; `*` matches any run, including none', async () => {
  expect(globMatch('read', 'read')).toBe(true)
  expect(globMatch('read', 'reads')).toBe(false)
  expect(globMatch('case * read', 'case R02-73 read')).toBe(true)
  expect(globMatch('case * read', 'case  read')).toBe(true)
  expect(globMatch('case * read', 'case R02 write')).toBe(false)
  expect(globMatch('*', '')).toBe(true)
  expect(globMatch('a*', 'a')).toBe(true)
  expect(globMatch('*b', 'ab')).toBe(true)
  expect(globMatch('*b', 'ba')).toBe(false)
  expect(globMatch('a*b*c', 'axxbyyc')).toBe(true)
  expect(globMatch('a*b*c', 'axxcyyb')).toBe(false)
  // regex metacharacters are plain text
  expect(globMatch('x.y (z)+', 'x.y (z)+')).toBe(true)
  expect(globMatch('x.y', 'xzy')).toBe(false)
})

test('globMatch: a label with 30 `*` against a 2000-character description returns quickly', async () => {
  const label = Array(31).fill('a').join('*') + 'b'
  const description = 'a'.repeat(2000)
  const r = timed(() => globMatch(label, description))
  expect(r.value).toBe(false)
  expect(r.ms).toBeLessThan(50)
  const hit = timed(() => globMatch(label.slice(0, -1), description))
  expect(hit.value).toBe(true)
  expect(hit.ms).toBeLessThan(50)
})

// ---------------------------------------------------------------- 1b: no pattern=

test('pattern=: the command refuses it as an unknown argument, and the tool schema has no pattern field', async () => {
  expect(parsePinArgs('p.md pattern=EX-\\d+', '/w')).toEqual({ ok: false, error: 'unknown argument: pattern=EX-\\d+' })
  expect('pattern' in TOOL_SPEC.inputSchema.properties).toBe(false)
  expect(TOOL_SPEC.description.includes('pattern')).toBe(false)
  // a pattern the model sends anyway is not part of the filter
  const r = filterFromInput({ file: 'p.md', pattern: '(a+)+$' }, '/w')
  expect(r).toEqual({ ok: true, filter: { file: '/w/p.md' }, typed: { file: 'p.md' } })
})

test('pattern=: through the command and the tool, the same plan pins by its own IDs', async ($, on) => {
  world(on, { files: { '/w/plan.md': PLAN } })
  await start($)
  expect((await $.command.run({ command: 'headway', args: 'track plan.md pattern=(a+)+$', origin: { kind: 'composer' } } as never)).text).toBe('refused: unknown argument: pattern=(a+)+$')
  const pinned = (await $.tool.call({ tool: TOOL, tool_use_id: 't1', action: 'track', file: 'plan.md', pattern: '(a+)+$' })).result as string
  expect(pinned).toMatch(/^tracking \/w\/plan\.md/)
  const state = (await $.tool.call({ tool: TOOL, tool_use_id: 't2', action: 'state' })).result as string
  expect(state.includes('pattern')).toBe(false)
})

test('plan IDs: a long agent text still matches a plan ID literally and finishes fast', async () => {
  const plan = ok(parsePlan('- [ ] T1 one\n- [ ] T2 two\n'))
  const far = 'y'.repeat(1500)
  expect(matchAgent(plan, [far + ' T2'])).toMatchObject({ taskIds: ['T2'] })
  const digits = '1'.repeat(5000)
  const r = timed(() => matchAgent(plan, [digits, digits, digits]))
  expect(r.ms).toBeLessThan(50)
  expect(r.value).toEqual({ taskIds: [] })
})

// ---------------------------------------------------------------- 0.2.1: inputs that ran long

test('plan parser: a heading line with a long run of inner spaces parses fast, and still heads its section', async () => {
  const text = '# x' + ' '.repeat(100_000) + 'y\n- [ ] T1 one\n'
  const r = timed(() => parsePlan(text))
  expect(r.ms).toBeLessThan(50)
  const plan = ok(r.value)
  expect(plan.tasks.map((t) => t.id)).toEqual(['T1'])
  expect(plan.groups[0].title).toBe('x') // the line is read only to its first 8 KiB, all spaces after the x
  const mode = timed(() => parsePlanMode(text))
  expect(mode.ms).toBeLessThan(50)
  expect(mode.value.steps.map((s) => s.id)).toEqual(['T1'])
})

test('plan parser: a delimiter-like row with a long run of spaces is rejected fast, and a real one still opens a table', async () => {
  const r = timed(() => parsePlan('| a | b |\n|-' + ' '.repeat(100_000) + '|x\n'))
  expect(r.ms).toBeLessThan(50)
  expect(ok(r.value).tasks).toEqual([])
  for (const delim of ['|---|---|', '| :- | -: |', '---|---', '   | --- |', '|:---:|', '| --- | --- |   ']) {
    expect(delim + ': ' + ok(parsePlan('| task | done |\n' + delim + '\n| T1 | x |\n')).tasks.length).toBe(delim + ': 1')
  }
  for (const delim of ['    | --- |', '| --- | x |', '|| --- |', '| --- ||', '|\t---|']) {
    expect(delim + ': ' + ok(parsePlan('| task | done |\n' + delim + '\n| T1 | x |\n')).tasks.length).toBe(delim + ': 0')
  }
})

test('plan parser: 20k heading and item pairs parse in linear time, each item under its own heading', async () => {
  let text = ''
  for (let i = 0; i < 20_000; i++) text += '## H' + i + ' part\n- [ ] T' + i + ' x\n'
  const r = timed(() => parsePlan(text))
  expect(r.ms).toBeLessThan(200)
  const plan = ok(r.value)
  expect(plan.groups.length).toBe(20_000)
  expect(plan.groups[19_999]).toMatchObject({ id: 'H19999', tasks: [19_999] })
})

test('plan-mode parser: 40k heading and item pairs parse in linear time (it cleans every group title, so its bound is wider)', async () => {
  let text = ''
  for (let i = 0; i < 40_000; i++) text += '## H' + i + ' part\n- [ ] T' + i + ' x\n'
  const mode = timed(() => parsePlanMode(text))
  expect(mode.ms).toBeLessThan(1000)
  expect(mode.value.groups[199]).toMatchObject({ id: 'H199' })
  expect(mode.value.steps[199]).toMatchObject({ id: 'T199', group: 199 })
})

test('plan parser: the nearest heading with an ID groups an item, else the nearest heading', async () => {
  const plan = ok(parsePlan('# Plan\n## M1 first\n### Notes\n- [ ] T1 a\n## Loose\n- [ ] T2 b\n### Sub\n#### Deeper\n- [ ] T3 c\n'))
  expect(plan.tasks.map((t) => plan.groups[t.groups[0]].id)).toEqual(['M1', 'Loose', 'Deeper'])
})

test('plan parser: a line is read only to its first 8 KiB', async () => {
  const plan = ok(parsePlan('- [ ] T1 ' + 'a'.repeat(20_000) + '\n'))
  expect(plan.tasks[0].title.length).toBe(LINE_MAX - '- [ ] T1 '.length)
})

test('workflow parser: 30k unclosed agent( calls parse fast to no calls; 30k nested closed ones to 30k calls', async () => {
  const open = timed(() => parseWorkflow('agent('.repeat(30_000)))
  expect(open.ms).toBeLessThan(200)
  expect(open.value.calls).toEqual([])
  const nested = timed(() => parseWorkflow('agent('.repeat(30_000) + ')'.repeat(30_000)))
  expect(nested.ms).toBeLessThan(200)
  expect(nested.value.calls.length).toBe(30_000)
  const options = timed(() => parseWorkflow("agent('p', { label: 'a', x: ".repeat(5_000) + '1' + ' })'.repeat(5_000)))
  expect(options.ms).toBeLessThan(200)
  expect(options.value.calls.length).toBe(5_000)
  expect(options.value.calls[4_999].label).toEqual({ kind: 'literal', value: 'a' })
  const phases = timed(() => parseWorkflow("phase('a')\n".repeat(10_000) + "agent('p', {})\n".repeat(10_000)))
  expect(phases.ms).toBeLessThan(200)
  expect(phases.value.calls[9_999].phase).toEqual({ kind: 'literal', value: 'a' })
})

test('workflow parser: nesting names the enclosing parallel and pipeline calls, outermost first', async () => {
  const p = parseWorkflow("await pipeline(() => parallel([() => agent('a', {}), () => agent('b', {})]), () => agent('c', {}))\nawait agent('d', {})")
  expect(p.calls.map((c) => c.nesting)).toEqual([['pipeline', 'parallel'], ['pipeline', 'parallel'], ['pipeline'], []])
})

test('BLOCKED: only the first 4 KiB of an answer is looked at, so a BLOCKED line after 100k newlines is a plain answer', async () => {
  const base = spawnAgent([], { at: 1, toolUseId: 'toolu_b', description: 'look', subagentType: 'general-purpose', agentId: 'x', model: 'claude-haiku-5-5' }, { plan: null }).agents
  const late = timed(() => completeAgent(base, { at: 2, agentId: 'x', reason: 'answer', answer: '\n'.repeat(100_000) + 'BLOCKED: x', durationMs: 1 }))
  expect(late.ms).toBeLessThan(50)
  expect(late.value.agents[0].status).toBe('done')
  const miss = timed(() => completeAgent(base, { at: 2, agentId: 'x', reason: 'answer', answer: ' \n'.repeat(100_000) + 'x', durationMs: 1 }))
  expect(miss.ms).toBeLessThan(50)
  expect(miss.value.agents[0].status).toBe('done')
  const early = completeAgent(base, { at: 2, agentId: 'x', reason: 'answer', answer: 'Looked around.\n\n  \tBLOCKED : which config file?  \nmore', durationMs: 1 })
  expect(early.agents[0]).toMatchObject({ status: 'blocked', question: 'which config file?' })
  expect(completeAgent(base, { at: 2, agentId: 'x', reason: 'answer', answer: 'BLOCKEDNESS is fine', durationMs: 1 }).agents[0].status).toBe('done')
  expect(completeAgent(base, { at: 2, agentId: 'x', reason: 'answer', answer: 'not BLOCKED here\r\nBLOCKED', durationMs: 1 }).agents[0]).toMatchObject({ status: 'blocked', question: '' })
})

test('definitionModel: a model line with a long run of inner spaces parses fast', async () => {
  const r = timed(() => definitionModel('---\nname: x\nmodel: x' + ' '.repeat(60_000) + 'y\n---\nBody.\n'))
  expect(r.ms).toBeLessThan(50)
  expect(r.value).toBe('x' + ' '.repeat(60_000) + 'y')
  const c = timed(() => definitionModel('---\nmodel: x' + ' '.repeat(60_000) + 'y # note\n---\n'))
  expect(c.ms).toBeLessThan(50)
  expect(c.value).toBe('x' + ' '.repeat(60_000) + 'y')
  expect(definitionModel('﻿---\r\nname: x\r\nmodel:  "haiku"  # fast\r\n---\r\nBody')).toBe('haiku')
  expect(definitionModel('---\nmodel: sonnet # the default\n---\n')).toBe('sonnet')
  expect(definitionModel('---\nmodel: inherit\n---\n')).toBe(undefined)
  expect(definitionModel('---\n  model: haiku\n---\n')).toBe(undefined)
  expect(definitionModel('---\nmodel: haiku\n')).toBe(undefined)
  expect(definitionModel('x\n---\nmodel: haiku\n---\n')).toBe(undefined)
})

// ---------------------------------------------------------------- plan titles: markdown cleaning is linear

const EIGHT_KIB = 8192
const TITLE_WORST: Record<string, string> = {
  stars: '*'.repeat(EIGHT_KIB),
  underscores: '_'.repeat(EIGHT_KIB),
  tildes: '~'.repeat(EIGHT_KIB),
  backticks: '`'.repeat(EIGHT_KIB),
  backtickRuns: Array.from({ length: 90 }, (_, i) => '`'.repeat(i + 1) + 'a ').join('').padEnd(EIGHT_KIB, 'a'),
  openBrackets: '['.repeat(EIGHT_KIB),
  nestedBrackets: '['.repeat(EIGHT_KIB / 2) + ']('.repeat(EIGHT_KIB / 4),
  emptyLinks: '[](' .repeat(EIGHT_KIB / 3),
  imageOpens: '![['.repeat(EIGHT_KIB / 3),
  unclosedStars: ' *a'.repeat(EIGHT_KIB / 3),
  unclosedDoubleStars: ' **a'.repeat(EIGHT_KIB / 4),
  unclosedUnderscores: ' _a'.repeat(EIGHT_KIB / 3),
  unclosedDoubleUnderscores: ' __a'.repeat(EIGHT_KIB / 4),
  unclosedTildes: ' ~~a'.repeat(EIGHT_KIB / 4),
  mixed: '*_~`['.repeat(EIGHT_KIB / 5),
}

test('plainTitle: an 8 KiB line of any one marker, nested brackets or unclosed spans returns in a few milliseconds', async () => {
  for (const [name, line] of Object.entries(TITLE_WORST)) {
    expect(line.length).toBeGreaterThanOrEqual(EIGHT_KIB - 4)
    const r = timed(() => plainTitle(line))
    expect(name + ' ' + (r.ms < 15 ? 'fast' : 'slow ' + r.ms.toFixed(1) + ' ms')).toBe(name + ' fast')
  }
})

// ---------------------------------------------------------------- the rest of the patterns that read model or file text

// A pattern is judged on the worst 8 KiB line the pattern can be given (a theme file, which is read to
// 64 KiB, and a prompt, which has no cap, on more). Each name below is a pattern that was quadratic.
function fast(name: string, f: () => unknown, limit = 50): void {
  const r = timed(f)
  expect(name + ' ' + (r.ms < limit ? 'fast' : 'slow ' + r.ms.toFixed(1) + ' ms')).toBe(name + ' fast')
}

test('plan-mode numbered items and headings: a line of spaces ending in line separators returns in a few milliseconds', async () => {
  const line = '1.' + ' '.repeat(EIGHT_KIB - 10) + '\u2028x\u2029y'
  // no checklist in the plan, so the numbered shape is the one tried
  const r = timed(() => parsePlanMode('# P\n\n' + line + '\n2. b\n'))
  expect(r.ms).toBeLessThan(50)
  expect(r.value.steps.map((x) => x.id)).toEqual(['2'])
  fast('numberedLine', () => numberedLine(line, true))
  fast('numberedLine heading', () => numberedLine(line, false))
})

test('theme file: 64 KiB of blank lines, spaces or unclosed blocks parses in a few milliseconds', async () => {
  const cap = 64 * 1024
  for (const [name, text] of Object.entries({
    blankLines: '\n'.repeat(cap),
    spaces: ' '.repeat(cap),
    blankThenKey: '\n'.repeat(cap - 10) + 'palette: x',
    unclosedBlocks: 'palette: {\n'.repeat(cap / 11),
    unclosedLight: 'light: {'.repeat(cap / 8),
    longBlock: 'palette: {' + "a: 'x',".repeat(cap / 7),
  })) {
    fast('theme ' + name, () => parseThemeFile(text), 30)
  }
})

test('insideDir: a run of separators ending in a letter is cut in a few milliseconds', async () => {
  fast('insideDir', () => {
    insideDir('\\'.repeat(EIGHT_KIB) + 'x', '/w')
    insideDir('/w', '/'.repeat(EIGHT_KIB) + 'x')
    insideDir('C:\\' + '\\'.repeat(EIGHT_KIB) + 'x', 'C:\\' + '/'.repeat(EIGHT_KIB) + 'x')
  })
})

test('promptLabel: a prompt of a million unclosed paste tags is labelled in a few milliseconds', async () => {
  fast('paste tags', () => promptLabel('<pasted_content'.repeat(70_000), 'composer'), 100)
  fast('paste closers', () => promptLabel('</pasted_content '.repeat(60_000) + 'x', 'composer'), 100)
})
