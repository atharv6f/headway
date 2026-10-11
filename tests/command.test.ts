import { expect, test } from 'claude-code/testing'
import { PLAN, start, TOOL, world, userCommand } from './world.ts'

// The tool `mcp__waypoint__waypoint` and the `/waypoint` command, driven through the engine.
const FILES = { '/w/plan/p.md': PLAN, '/w/other.md': '# Other\n\n- [x] A1 one\n- [ ] A2 two\n' }

async function tool($, input: Record<string, unknown>): Promise<string> {
  const r = await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_w', ...input })
  return r.result as string
}

async function command($, args: string) {
  return userCommand($, args)
}

function spawnInput(over: Record<string, unknown>) {
  return {
    tool_use_id: 'toolu_1', prompt: 'Reply ok', description: 'a task', subagentType: 'acme:scout',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...over,
  }
}

test('tool: track pins, state reads the block back', async ($, on) => {
  const w = world(on, { files: FILES })
  await start($)
  const tracked = await tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed', partial: 'published' })
  expect(tracked).toBe('tracking /w/plan/p.md § Work: landed 1 · published 1 · open 1 / 3 tasks, 1 groups')
  expect(w.last.filter).toEqual({ file: '/w/plan/p.md', section: 'Work', doneRule: 'column=landed', partial: 'published', bounds: { file: '/w' } })
  const state = (await tool($, { action: 'state' })).split('\n')
  expect(state[0]).toBe('goal: Work — landed 1 · published 1 · open 1 / 3 (file: /w/plan/p.md § Work)')
  expect(state[1]).toBe('current: none')
  expect(state).toContain('agents: none')
  expect(state.find((l) => l.startsWith('log: '))).toMatch(/^log: \d\d:\d\d ◆ tracking p\.md § Work column=landed partial=published$/)
})

test('tool and command: track refusals read the same', async ($, on) => {
  world(on, { files: FILES })
  await start($)
  expect(await tool($, { action: 'track', file: 'plan/p.md', section: 'Nope' })).toBe('refused: section not found: Nope')
  expect((await command($, 'track plan/p.md "Nope"')).text).toBe('refused: section not found: Nope')
  expect(await tool($, { action: 'track', file: 'plan/p.md', doneRule: 'column=shipped' })).toBe('refused: column not found: shipped')
  expect((await command($, 'track plan/p.md column=shipped')).text).toBe('refused: column not found: shipped')
  expect(await tool($, { action: 'track', file: 'missing.md' })).toMatch(/^refused: ./)
  expect(await tool($, { action: 'track' })).toBe('refused: no plan file given')
  expect((await command($, 'track')).text).toBe('refused: no plan file given')
  expect(await tool($, { action: 'fly' })).toBe('refused: unknown action: fly')
})

// The test kit rejects a read with a bare engine error that names no errno, so these see the
// `cannot read` sentence; the ENOENT sentence is pin.test.ts (readFailure) and the live check.
test('tool and command: a plan or group map that does not read is a plain refusal naming the path as typed', async ($, on) => {
  const w = world(on, { files: FILES })
  await start($)
  expect(await tool($, { action: 'track', file: 'nope.md' })).toBe('refused: cannot read nope.md')
  expect((await command($, 'track nope.md')).text).toBe('refused: cannot read nope.md')
  expect((await command($, 'track ./plan/../nope.md')).text).toBe('refused: cannot read ./plan/../nope.md')
  expect(await tool($, { action: 'track', file: 'plan/p.md', groupMap: 'nogroups.json' })).toBe('refused: cannot read nogroups.json')
  expect((await command($, 'track plan/p.md groups=nogroups.json')).text).toBe('refused: cannot read nogroups.json')
  expect(w.last.filter ?? null).toBe(null)
})

test('tool: a report is the goal with no file pinned; a pinned file hides it and untrack shows it again', async ($, on) => {
  world(on, { files: FILES })
  await start($)
  const reported = await tool($, { action: 'report', title: 'Ship it', tasks: [{ id: 'S1', title: 'a', status: 'done' }, { id: 'S2', title: 'b', status: 'open' }] })
  expect(reported).toBe('reported 2 tasks')
  expect((await tool($, { action: 'state' })).split('\n')[0]).toBe('goal: Ship it — 1/2 done (reported)')
  expect(await tool($, { action: 'focus', taskId: 'S2' })).toBe('current task: S2')
  expect(await tool($, { action: 'report', tasks: [{ id: 'S1', title: 'a', status: 'later' }] })).toBe('refused: task 1: status must be open, partial or done')
  await tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect((await tool($, { action: 'state' })).split('\n')[0]).toBe('goal: Work — 1/3 done (file: /w/plan/p.md § Work)')
  await tool($, { action: 'untrack' })
  expect((await tool($, { action: 'state' })).split('\n')[0]).toBe('goal: Ship it — 1/2 done (reported)')
})

test('tool: focus sets the current task until the next spawn; an unknown ID is refused', async ($, on) => {
  world(on, { files: FILES })
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag1' }))
  await start($)
  await tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect(await tool($, { action: 'focus', taskId: 'ZZ9' })).toBe('unknown task: ZZ9')
  expect(await tool($, { action: 'focus', taskId: 'T2' })).toBe('current task: T2')
  expect((await tool($, { action: 'state' })).split('\n')[1]).toBe('current: T2 second — 0/0 agents finished')
  await $.agent.spawn(spawnInput({ description: 'T3 read' }))
  expect((await tool($, { action: 'state' })).split('\n')[1]).toBe('current: T3 third — 0/1 agents finished')
})

test('tool: untrack unpins; state then says nothing is tracked', async ($, on) => {
  const w = world(on, { files: FILES })
  await start($)
  await tool($, { action: 'track', file: 'plan/p.md' })
  expect(await tool($, { action: 'untrack' })).toBe('untracked')
  expect(w.last.filter).toBe(null)
  expect((await tool($, { action: 'state' })).split('\n')[0]).toBe('goal: nothing tracked')
})

test('tool: state takes logEntries', async ($, on) => {
  world(on, { files: FILES })
  await start($)
  await tool($, { action: 'track', file: 'plan/p.md' })
  await tool($, { action: 'track', file: 'other.md' })
  await tool($, { action: 'untrack' })
  const log = (n?: number) => (n === undefined ? tool($, { action: 'state' }) : tool($, { action: 'state', logEntries: n })).then((s) => s.split('\n').find((l) => l.startsWith('log: '))!)
  expect((await log(1)).split(' | ').length).toBe(1)
  expect(await log(1)).toContain('untracked')
  expect((await log()).split(' | ').length).toBe(3) // a new pin keeps the log and adds its entry
})

test('command: track and status print text, untrack prints untracked, a bad form prints the usage', async ($, on) => {
  world(on, { files: FILES })
  await start($)
  const r = await command($, 'track plan/p.md "Work" column=landed partial=published')
  expect(r.text).toBe('tracking /w/plan/p.md § Work: landed 1 · published 1 · open 1 / 3 tasks, 1 groups')
  expect((await command($, 'status')).text?.split('\n')[0]).toBe('goal: Work — landed 1 · published 1 · open 1 / 3 (file: /w/plan/p.md § Work)')
  expect((await command($, 'untrack')).text).toBe('untracked')
  expect((await command($, 'dance')).text).toMatch(/^usage: \/waypoint /)
})

test('command: bare /waypoint toggles the pane, a tab word opens it on that tab, close closes it', async ($, on) => {
  const w = world(on, { files: FILES })
  await start($)
  expect(await command($, '')).toEqual({})
  expect(w.opens.map((o) => o.id)).toEqual(['waypoint'])
  expect(await command($, '')).toEqual({})
  expect(w.closes).toEqual(['waypoint'])
  expect(await command($, 'agents')).toEqual({})
  expect((w.last.ui as { tab: string }).tab).toBe('agents')
  expect(await command($, 'close')).toEqual({})
  expect(w.closes).toEqual(['waypoint', 'waypoint'])
})

test('command: band off and on write the pref to the store', async ($, on) => {
  const w = world(on, { files: FILES })
  await start($)
  expect(await command($, 'band off')).toEqual({})
  expect(w.store.band).toBe(false)
  expect(await command($, 'band on')).toEqual({})
  expect(w.store.band).toBe(true)
})

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 100, scroll: { offset: 0, bodyRows: 15 }, view: {} }

async function bandShows($): Promise<boolean> {
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const found = (await ui.find({ type: 'Text', text: /Work/ })) !== undefined
  await ui.unmount()
  return found
}

test('band: band off hides the band, band on brings it back, and the pref holds at the next session start', async ($, on) => {
  const w = world(on, { files: FILES })
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  await start($)
  await command($, 'track plan/p.md "Work" column=landed')
  expect(await bandShows($)).toBe(true)
  await command($, 'band off')
  expect(await bandShows($)).toBe(false)
  await start($)
  expect(w.store.band).toBe(false)
  expect(await bandShows($)).toBe(false)
  await command($, 'band on')
  expect(await bandShows($)).toBe(true)
})

test('band: a reported list says reported after the goal count', async ($, on) => {
  world(on, { files: FILES })
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  await start($)
  await tool($, { action: 'report', title: 'Work list', tasks: [{ id: 'S1', title: 'a', status: 'done' }] })
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: /reported/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/1 done/ })).toBeDefined()
  await ui.unmount()
})

// The compact hint's boundary belongs to the pin it was noticed under: a new pin (another filter)
// starts clean; the same filter again is a re-read of the same pin.
for (const via of ['tool', 'command'] as const) {
  test('hint: a ' + via + ' track drops a boundary noticed under the old pin', { options: { compactAtPercent: 50 } }, async ($, on) => {
    const w = world(on, { files: FILES })
    on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'h1' }))
    on('turn.complete', async () => ({ text: '' }))
    on('session.usage', async () => ({ value: { context: { window: 200_000, percent: 60, tokens: 120_000 }, rateLimits: [], cost: { usd: 1 } } }))
    await start($)
    const pinIt = (rule: string) => (via === 'tool' ? tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: rule }) : command($, 'track plan/p.md "Work" ' + rule))
    await pinIt('column=landed')
    await $.agent.spawn(spawnInput({ description: 'T3 read' }))
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't-h1', agentId: 'h1', reason: 'answer' })
    await pinIt('column=published')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })
    expect((w.last.usage as { hint?: string }).hint).toBe('compact-at-next-boundary')
  })
}

test('command: the registration hint names every form, band off|on and status included', async ($, on) => {
  world(on, { files: FILES })
  const specs: Array<{ name: string; argumentHint?: string; immediate?: boolean }> = []
  on('command.register', async (_$, e) => {
    specs.push(e)
    return { value: { command: e.name } }
  })
  await start($)
  const spec = specs.find((s) => s.name === 'waypoint')!
  expect(spec.immediate).toBe(true)
  expect(spec.argumentHint).toBe('[track <path> ["section"] [column=..|check=..|auto] [partial=<column>] [groups=<path>] | untrack | plan|agents|log|usage | close | status | band off|on]')
})

// The `state` block's context line is the band's: both show the figures `$.session.usage()` gives
// now, whatever the `usage` atom holds at tool-call time (empty after a reset, or behind a step).
const contextLine = (state: string) => state.split('\n').filter((l) => l.startsWith('context:'))[0]
const answerUsage = (on, figures: { percent?: number; usd?: number }) =>
  on('session.usage', async () => ({ value: { context: { window: 200_000, ...(figures.percent !== undefined ? { percent: figures.percent, tokens: figures.percent * 2000 } : {}) }, rateLimits: [], ...(figures.usd !== undefined ? { cost: { usd: figures.usd } } : {}) } }))

test('state: an empty usage atom is filled from session.usage at tool-call time, and the band then shows the same', async ($, on) => {
  const w = world(on, { files: FILES })
  answerUsage(on, { percent: 5, usd: 0.76 })
  await start($)
  expect(w.last.usage).toBeUndefined()
  expect(contextLine(await tool($, { action: 'state' }))).toBe('context: 5% ($0.76)')
  expect(w.last.usage).toMatchObject({ percent: 5, usd: 0.76 })
})

test('state: after /clear reset the usage atom, the figures still read as the band shows them', async ($, on) => {
  world(on, { files: FILES, watchState: false })
  answerUsage(on, { percent: 5, usd: 0.76 })
  // the engine's `$.state` after /clear: the usage atom back to its default
  let reset = false
  on('state.get', async (_$, e, next) => {
    if (reset && e.key === 'usage') {
      reset = false
      return { value: { value: undefined, version: 0 } }
    }
    return next(e)
  })
  await start($)
  await tool($, { action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect(contextLine(await tool($, { action: 'state' }))).toBe('context: 5% ($0.76)')
  reset = true
  await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
  expect(contextLine(await tool($, { action: 'state' }))).toBe('context: 5% ($0.76)')
})

test('state: figures that moved since the last step are the ones it reports', async ($, on) => {
  world(on, { files: FILES })
  const figures: { percent?: number; usd?: number } = { percent: 70, usd: 3 }
  answerUsage(on, figures)
  await start($)
  expect(contextLine(await tool($, { action: 'state' }))).toBe('context: 70% ($3.00) — contextHint: compact-at-next-boundary')
  figures.percent = 5
  figures.usd = 3.5
  expect(contextLine(await tool($, { action: 'state' }))).toBe('context: 5% ($3.50)')
})

test('state: a failing session.usage call leaves the atom as it was', async ($, on) => {
  world(on, { files: FILES })
  let broken = false
  on('session.usage', async () => {
    if (broken) throw new Error('no ledger')
    return { value: { context: { window: 200_000, percent: 40, tokens: 80_000 }, rateLimits: [], cost: { usd: 2 } } }
  })
  await start($)
  expect(contextLine(await tool($, { action: 'state' }))).toBe('context: 40% ($2.00)')
  broken = true
  expect(contextLine(await tool($, { action: 'state' }))).toBe('context: 40% ($2.00)')
})
