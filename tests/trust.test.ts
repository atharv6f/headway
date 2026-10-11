import { expect, test } from 'claude-code/testing'
import { PLAN, start, TOOL, world } from './world.ts'
import { insideDir } from '../hooks/pin.ts'

// What headway reads on Claude's behalf stays inside what the user's own permissions would show it
// (SPEC 14): the model tool pins a file only inside the project; a Workflow script is read only from
// the project or the Claude Code config directory; an agent definition only where it was found.
const CFG = '/h/.claude'
const ENV = { HOME: '/h' }
const SECRET = '- [ ] S1 the secret line\n'
const OUTSIDE = 'refused: outside the project; ask the user to run /headway track '
const FROM_PROMPT = 'refused: run this from the prompt'

async function tool($, input: Record<string, unknown>): Promise<string> {
  return (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_t', ...input })).result as string
}
// the user's own command: typed at the prompt, so the engine stamps it `composer`
const command = ($, args: string) => $.command.run({ command: 'headway', args, origin: { kind: 'composer' } } as never)
const commandFrom = ($, kind: string | undefined, args: string) => $.command.run({ command: 'headway', args, ...(kind ? { origin: { kind, ...(kind === 'plugin' ? { name: 'other' } : {}) } } : {}) } as never)

// ---------------------------------------------------------------- track through the model tool

test('tool track: a file outside the project is refused and never read; the user can pin it', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, '/h/.ssh/config': SECRET }, env: ENV })
  await start($)
  expect(await tool($, { action: 'track', file: '/h/.ssh/config' })).toBe(OUTSIDE + '/h/.ssh/config')
  expect(await tool($, { action: 'track', file: '../h/.ssh/config' })).toBe(OUTSIDE + '../h/.ssh/config')
  expect(w.reads.filter((p) => p === '/h/.ssh/config')).toEqual([])
  expect(w.last.filter ?? null).toBe(null)
  expect((await tool($, { action: 'state' })).includes('secret')).toBe(false)
  // the user's own command is not held to the project
  expect((await command($, 'track /h/.ssh/config')).text).toMatch(/^tracking \/h\/\.ssh\/config/)
})

test('tool track: a link inside the project that lands outside it is refused; one that lands inside is pinned', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, '/w/notes.md': SECRET, '/w/docs/p.md': PLAN, '/h/.ssh/config': SECRET }, env: ENV })
  w.real['/w/notes.md'] = '/h/.ssh/config'
  w.real['/w/docs/p.md'] = '/w/plan.md'
  await start($)
  expect(await tool($, { action: 'track', file: 'notes.md' })).toBe(OUTSIDE + 'notes.md')
  expect(w.reads.filter((p) => p === '/w/notes.md' || p === '/h/.ssh/config')).toEqual([])
  expect(w.last.filter ?? null).toBe(null)
  expect(await tool($, { action: 'track', file: 'docs/p.md' })).toMatch(/^tracking \/w\/docs\/p\.md/)
})

test('tool track: a group map outside the project is refused; the project is its real path, a linked session directory too', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, '/w/g.json': '{}', '/h/g.json': '{}', '/real/proj/plan.md': PLAN }, env: ENV })
  // the session directory is a link: the project is where it lands
  w.real['/w'] = '/real/proj'
  w.real['/w/plan.md'] = '/real/proj/plan.md'
  await start($)
  expect(await tool($, { action: 'track', file: 'plan.md', groupMap: '/h/g.json' })).toBe(OUTSIDE + 'plan.md groups=/h/g.json')
  // /w/g.json lands at /w/g.json in this world (no mapping), which is outside /real/proj
  expect(await tool($, { action: 'track', file: 'plan.md', groupMap: 'g.json' })).toBe(OUTSIDE + 'plan.md groups=g.json')
  expect(w.last.filter ?? null).toBe(null)
  expect(await tool($, { action: 'track', file: 'plan.md' })).toMatch(/^tracking \/w\/plan\.md/)
})

// ---------------------------------------------------------------- who runs /headway track

test('command: from any origin but the prompt, track, untrack and band are refused and touch nothing', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, '/h/.ssh/config': SECRET }, env: ENV })
  await start($)
  expect((await command($, 'track plan.md')).text).toMatch(/^tracking \/w\/plan\.md/)
  const touched = w.touched.length
  const writes = w.writes.length
  // a model-authored message (another session's SendMessage), a relay, a notification, another plugin's
  // $.command.run, a scheduled prompt, a run with no stamp: none is the user's own gesture
  for (const kind of ['peer-send-message', 'peer', 'task-notification', 'coordinator', 'channel', 'plugin', 'scheduled-trigger', 'unclassified', undefined]) {
    for (const args of ['track /h/.ssh/config', 'track plan.md', 'track nope.md bogus=1', 'untrack', 'band off', 'band on']) {
      expect(String(kind) + ' ' + args + ': ' + (await commandFrom($, kind, args)).text).toBe(String(kind) + ' ' + args + ': ' + FROM_PROMPT)
    }
  }
  expect(w.touched.slice(touched).filter((p) => p !== '/w/plan.md')).toEqual([]) // only the pinned plan's own poll
  expect(w.writes.slice(writes)).toEqual([])
  expect((w.last.filter as { file: string }).file).toBe('/w/plan.md')
  expect(w.store.band).toBe(undefined)
  // the user's own command pins anything, unbounded
  expect((await command($, 'track /h/.ssh/config')).text).toMatch(/^tracking \/h\/\.ssh\/config/)
  expect((w.last.filter as { bounds?: unknown }).bounds).toBe(undefined)
})

test('command: status and the pane forms answer from any origin', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN }, env: ENV })
  await start($)
  expect((await commandFrom($, 'peer-send-message', 'status')).text).toMatch(/^goal: nothing tracked/)
  await commandFrom($, 'plugin', '')
  expect(w.opens.length).toBe(1)
  await commandFrom($, 'task-notification', 'close')
  expect(w.closes.length).toBe(1)
  await commandFrom($, undefined, 'agents')
  expect(w.opens.length).toBe(2)
})

// Claude never pins a file under <configDir>/plans/: the plan-mode plan comes from the ExitPlanMode
// result, and a track of the approved file is answered without reading it.
const PLANS = CFG + '/plans'
const PROSE = 'Just some prose, no steps.\n'
const STEPS = '- [ ] A1 first\n- [ ] A2 second\n'
const ALREADY = 'already tracking this plan from plan mode; use report updates with ids: '

test('plan mode: Claude\'s track of another file under <configDir>/plans/ is refused and never read', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, [PLANS + '/p.md']: STEPS, [PLANS + '/q.md']: SECRET }, env: ENV })
  on('tool.call', async (_$, e) => ({ result: { plan: e.plan, isAgent: false, filePath: PLANS + '/p.md' } }))
  await start($)
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_p1', plan: STEPS, planFilePath: PLANS + '/p.md' })
  expect(await tool($, { action: 'track', file: PLANS + '/q.md' })).toBe(OUTSIDE + PLANS + '/q.md')
  expect(w.reads.filter((p) => p.startsWith(PLANS))).toEqual([])
  expect(w.last.filter ?? null).toBe(null)
})

test('plan mode: a track of the approved file while its plan is drawn answers with the ids and touches nothing', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, [PLANS + '/p.md']: STEPS }, env: ENV })
  on('tool.call', async (_$, e) => ({ result: { plan: e.plan, isAgent: false, filePath: PLANS + '/p.md' } }))
  await start($)
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_p2', plan: STEPS, planFilePath: PLANS + '/p.md' })
  expect(await tool($, { action: 'track', file: PLANS + '/p.md' })).toBe(ALREADY + 'A1, A2')
  expect(w.touched.filter((p) => p.startsWith(PLANS))).toEqual([])
  // under a pinned file the plan is not drawn: the approved file is outside the project like any other
  expect((await command($, 'track plan.md')).text).toMatch(/^tracking \/w\/plan\.md/)
  expect(await tool($, { action: 'track', file: PLANS + '/p.md' })).toBe(OUTSIDE + PLANS + '/p.md')
  expect(w.reads.filter((p) => p.startsWith(PLANS))).toEqual([])
  expect((w.last.filter as { file: string }).file).toBe('/w/plan.md')
})

test('plan mode: an approved file the engine or the call names, with no steps drawn, is outside the project and never read', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, '/h/.ssh/config': SECRET, [PLANS + '/p.md']: PROSE }, env: ENV, sessionId: 's-1' })
  let reply: Record<string, unknown> = { result: { plan: PROSE, isAgent: false, filePath: '/h/.ssh/config' } }
  on('tool.call', async () => reply)
  on('turn.complete', async () => ({ text: '' }))
  await start($)
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_p3', plan: PROSE, planFilePath: PLANS + '/p.md' })
  expect(await tool($, { action: 'track', file: '/h/.ssh/config' })).toBe(OUTSIDE + '/h/.ssh/config')
  reply = { result: { plan: PROSE, isAgent: false, filePath: PLANS + '/p.md' } }
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_p4', plan: PROSE, planFilePath: PLANS + '/p.md' })
  expect(await tool($, { action: 'track', file: PLANS + '/p.md' })).toBe(OUTSIDE + PLANS + '/p.md')
  // a rejected call carried across "clear context"
  reply = { result: 'rejected', isError: true }
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'toolu_p5', plan: PROSE, planFilePath: '/h/.ssh/config' })
  w.setSessionId('s-2')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
  expect(await tool($, { action: 'track', file: '/h/.ssh/config' })).toBe(OUTSIDE + '/h/.ssh/config')
  expect(w.reads.filter((p) => p === '/h/.ssh/config' || p.startsWith(PLANS))).toEqual([])
  expect(w.last.filter ?? null).toBe(null)
})

// ---------------------------------------------------------------- what a read may be

const MIB = 1024 * 1024
const KIB = 1024

test('track: a plan file over 2 MiB or a group map over 256 KiB is refused unread; exactly the cap is read', async ($, on) => {
  const w = world(on, {
    files: {
      '/w/plan.md': PLAN,
      '/w/big.md': '- [ ] T1 a\n' + 'x'.repeat(2 * MIB),
      '/w/edge.md': '- [ ] T1 a\n'.padEnd(2 * MIB, 'x'),
      '/w/g.json': '{"groups":[]}'.padEnd(256 * KIB, ' '),
      '/w/bigg.json': '{"groups":[]}'.padEnd(256 * KIB + 1, ' '),
    },
    env: ENV,
  })
  await start($)
  expect((await command($, 'track big.md')).text).toBe('refused: file too large: big.md')
  expect(await tool($, { action: 'track', file: 'big.md' })).toBe('refused: file too large: big.md')
  expect((await command($, 'track plan.md groups=bigg.json')).text).toBe('refused: file too large: bigg.json')
  expect(w.reads.filter((p) => p === '/w/big.md' || p === '/w/bigg.json')).toEqual([])
  expect((await command($, 'track edge.md')).text).toMatch(/^tracking \/w\/edge\.md/)
  expect((await command($, 'track plan.md groups=g.json')).text).toMatch(/^tracking \/w\/plan\.md/)
  // a pinned plan that grows past the cap is not read on the poll; the goal says why
  w.files['/w/plan.md'] = PLAN + 'x'.repeat(2 * MIB)
  w.mtimes['/w/plan.md'] = 2
  const reads = w.reads.length
  await w.clock.advance(2000)
  await settle()
  expect(w.reads.slice(reads).filter((p) => p === '/w/plan.md')).toEqual([])
  expect(goalOf(w)?.error).toBe('file too large: /w/plan.md')
})

test('track: a plan file or group map that is not a regular file (a pipe, a device, a directory) is refused unread', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, '/w/pipe.md': PLAN, '/w/dev.json': '{"groups":[]}', '/w/d/x.md': PLAN }, env: ENV })
  w.kinds['/w/pipe.md'] = 'other'
  w.kinds['/w/dev.json'] = 'other'
  await start($)
  expect((await command($, 'track pipe.md')).text).toBe('refused: not a regular file: pipe.md')
  expect(await tool($, { action: 'track', file: 'pipe.md' })).toBe('refused: not a regular file: pipe.md')
  expect((await command($, 'track plan.md groups=dev.json')).text).toBe('refused: not a regular file: dev.json')
  expect((await command($, 'track d')).text).toBe('refused: not a regular file: d')
  expect(w.reads.filter((p) => p === '/w/pipe.md' || p === '/w/dev.json' || p === '/w/d')).toEqual([])
})

// ---------------------------------------------------------------- a link swapped after the check

const settle = () => new Promise((r) => setTimeout(r, 30))
const goalOf = (w) => w.last.goal as { label: string; error?: string } | undefined

test('tool track: the real path that was checked is what is read, so a link swapped after the check reads nothing outside', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, '/w/docs/p.md': PLAN, '/w/g.json': '{"groups":[]}', '/w/docs/g.json': '{}', '/h/.ssh/config': SECRET, '/h/g.json': '{}' }, env: ENV })
  w.real['/w/docs/p.md'] = '/w/plan.md'
  w.real['/w/docs/g.json'] = '/w/g.json'
  // each link is swapped to land outside right after headway's first stat of it
  w.afterStat = (path) => {
    if (path === '/w/docs/p.md') w.real[path] = '/h/.ssh/config'
    if (path === '/w/docs/g.json') w.real[path] = '/h/g.json'
  }
  await start($)
  await tool($, { action: 'track', file: 'docs/p.md', groupMap: 'docs/g.json' })
  expect(w.reads.filter((p) => p.startsWith('/h/') || p.startsWith('/w/docs/'))).toEqual([])
  expect((await tool($, { action: 'state' })).includes('secret')).toBe(false)
})

test('tool track: a link inside the project, pinned, then swapped to land outside, is not read on the poll; the goal says why', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, '/w/docs/p.md': PLAN, '/h/.ssh/config': SECRET }, env: ENV })
  w.real['/w/docs/p.md'] = '/w/plan.md'
  await start($)
  expect(await tool($, { action: 'track', file: 'docs/p.md' })).toMatch(/^tracking \/w\/docs\/p\.md/)
  expect(w.reads).toContain('/w/plan.md')
  w.real['/w/docs/p.md'] = '/h/.ssh/config'
  w.mtimes['/w/docs/p.md'] = 2
  await w.clock.advance(2000)
  await settle()
  expect(w.reads.filter((p) => p === '/h/.ssh/config' || p === '/w/docs/p.md')).toEqual([])
  expect(goalOf(w)?.error).toBe('/w/docs/p.md lands outside /w')
  expect((await tool($, { action: 'state' })).includes('secret')).toBe(false)
  // swapped back inside, the poll reads it again and the error clears
  w.real['/w/docs/p.md'] = '/w/plan.md'
  w.mtimes['/w/docs/p.md'] = 3
  await w.clock.advance(2000)
  await settle()
  expect(goalOf(w)?.error).toBe(undefined)
})

test('track: the bound is saved with the pin and holds after a resume', async ($, on) => {
  const rec = { filter: { file: '/w/docs/p.md', bounds: { file: '/w' } }, report: null, agents: [], log: [], savedAt: 1_000_000 - 1000 }
  const w = world(on, { files: { '/w/plan.md': PLAN, '/w/docs/p.md': PLAN, '/h/.ssh/config': SECRET }, env: ENV, sessionId: 's-1', store: { 'session:s-2': rec } })
  w.real['/w/docs/p.md'] = '/h/.ssh/config'
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-2' })
  await settle()
  expect((w.last.filter as { bounds?: unknown }).bounds).toEqual({ file: '/w' })
  expect(w.reads.filter((p) => p === '/h/.ssh/config' || p === '/w/docs/p.md')).toEqual([])
  expect((await tool($, { action: 'state' })).includes('secret')).toBe(false)
})

test('track: Claude\'s pin carries its bound; the user\'s own pin of the same link carries none and reads where it lands', async ($, on) => {
  const w = world(on, { files: { '/w/plan.md': PLAN, '/w/docs/p.md': PLAN, '/h/.ssh/config': SECRET }, env: ENV })
  w.real['/w/docs/p.md'] = '/w/plan.md'
  await start($)
  await tool($, { action: 'track', file: 'docs/p.md' })
  expect((w.last.filter as { bounds?: unknown }).bounds).toEqual({ file: '/w' })
  expect((await command($, 'track docs/p.md')).text).toMatch(/^tracking \/w\/docs\/p\.md/)
  expect((w.last.filter as { bounds?: unknown }).bounds).toBe(undefined)
  w.real['/w/docs/p.md'] = '/h/.ssh/config'
  w.mtimes['/w/docs/p.md'] = 2
  await w.clock.advance(2000)
  await settle()
  expect(w.reads).toContain('/h/.ssh/config')
  expect(w.reads).not.toContain('/w/docs/p.md')
})

test('tool track: a file that is not there keeps the plain refusal', async ($, on) => {
  world(on, { files: { '/w/plan.md': PLAN }, env: ENV })
  await start($)
  expect(await tool($, { action: 'track', file: 'nope.md' })).toBe('refused: cannot read nope.md')
})

// ---------------------------------------------------------------- Workflow scriptPath

const FILE_SCRIPT = "export const meta = { name: 'fromfile', description: 'd', phases: [] }\nawait agent('p', { label: 'FILE-1' })"
const INLINE_SCRIPT = "export const meta = { name: 'inline', description: 'd', phases: [] }\nawait agent('p', { label: 'INLINE-1' })"
const r2Of = (name: string, label: string) => 'headway: Workflow "' + name + '": 1 agent() call(s) without model or effort: "' + label + '". Pass both on every call.'

function workflowWorld(on, files: Record<string, string>) {
  const w = world(on, { files: { '/w/plan.md': PLAN, ...files }, env: ENV })
  on('tool.call', async () => ({ result: { runId: 'wf_t' } }))
  return w
}
const workflow = ($, over: Record<string, unknown>) => $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_wf' + Math.random(), ...over })

test('Workflow: scriptPath inside the project or the config directory is read', async ($, on) => {
  workflowWorld(on, { '/w/wf/s.js': FILE_SCRIPT, [CFG + '/workflows/s.js']: FILE_SCRIPT })
  await start($)
  expect((await workflow($, { scriptPath: '/w/wf/s.js', script: INLINE_SCRIPT })).context).toEqual([r2Of('fromfile', 'FILE-1')])
  expect((await workflow($, { scriptPath: CFG + '/workflows/s.js', script: INLINE_SCRIPT })).context).toEqual([r2Of('fromfile', 'FILE-1')])
})

test('Workflow: scriptPath elsewhere, or a link landing elsewhere, is not read; the inline script is parsed instead', async ($, on) => {
  const w = workflowWorld(on, { '/tmp/s.js': FILE_SCRIPT, '/w/link.js': FILE_SCRIPT, '/h/.ssh/s.js': FILE_SCRIPT })
  w.real['/w/link.js'] = '/h/.ssh/s.js'
  await start($)
  expect((await workflow($, { scriptPath: '/tmp/s.js', script: INLINE_SCRIPT })).context).toEqual([r2Of('inline', 'INLINE-1')])
  expect((await workflow($, { scriptPath: '/w/link.js', script: INLINE_SCRIPT })).context).toEqual([r2Of('inline', 'INLINE-1')])
  // no inline script: nothing parsed, nothing said
  expect((await workflow($, { scriptPath: '/tmp/s.js' })).context).toBe(undefined)
  expect(w.reads.filter((p) => p === '/tmp/s.js' || p === '/h/.ssh/s.js' || p === '/w/link.js')).toEqual([])
})

test('Workflow: the real path that was checked is what is read; a link swapped after the check is not followed', async ($, on) => {
  const w = workflowWorld(on, { '/w/wf/s.js': FILE_SCRIPT, '/w/link.js': FILE_SCRIPT, '/h/.ssh/s.js': INLINE_SCRIPT })
  w.real['/w/link.js'] = '/w/wf/s.js'
  w.afterStat = (path) => {
    if (path === '/w/link.js') w.real[path] = '/h/.ssh/s.js'
  }
  await start($)
  expect((await workflow($, { scriptPath: '/w/link.js' })).context).toEqual([r2Of('fromfile', 'FILE-1')])
  expect(w.reads.filter((p) => p === '/w/link.js' || p === '/h/.ssh/s.js')).toEqual([])
})

test('Workflow: a script file over 256 KiB or not a regular file is not read; the inline script is parsed instead', async ($, on) => {
  const w = workflowWorld(on, { '/w/wf/big.js': FILE_SCRIPT + '\n//' + 'x'.repeat(256 * KIB), '/w/wf/pipe.js': FILE_SCRIPT, '/w/wf/edge.js': (FILE_SCRIPT + '\n//').padEnd(256 * KIB, 'x') })
  w.kinds['/w/wf/pipe.js'] = 'other'
  await start($)
  expect((await workflow($, { scriptPath: '/w/wf/big.js', script: INLINE_SCRIPT })).context).toEqual([r2Of('inline', 'INLINE-1')])
  expect((await workflow($, { scriptPath: '/w/wf/pipe.js', script: INLINE_SCRIPT })).context).toEqual([r2Of('inline', 'INLINE-1')])
  expect(w.reads.filter((p) => p === '/w/wf/big.js' || p === '/w/wf/pipe.js')).toEqual([])
  expect((await workflow($, { scriptPath: '/w/wf/edge.js', script: INLINE_SCRIPT })).context).toEqual([r2Of('fromfile', 'FILE-1')])
})

test('Workflow: an inline script over 256 KiB is not parsed, and the call goes on', async ($, on) => {
  workflowWorld(on, {})
  await start($)
  const big = await workflow($, { script: INLINE_SCRIPT + '\n//' + 'x'.repeat(256 * KIB) })
  expect(big.context).toBe(undefined)
  expect(big.result).toEqual({ runId: 'wf_t' })
  expect((await workflow($, { script: (INLINE_SCRIPT + '\n//').padEnd(256 * KIB, 'x') })).context).toEqual([r2Of('inline', 'INLINE-1')])
})

// ---------------------------------------------------------------- agent definitions

const defn = (model: string) => '---\nname: x\ndescription: d\nmodel: ' + model + '\n---\nBody.\n'
const NO_MODEL = 'names no model'

function agentsWorld(on, files: Record<string, string>) {
  const w = world(on, { files: { '/w/.git': '', ...files }, env: ENV })
  on('tool.call', async () => ({ result: 'ok' }))
  return w
}
const noteOf = async ($, type: string) => (await $.tool.call({ tool: 'Agent', description: 'sweep', prompt: 'p', tool_use_id: 'toolu_x', subagent_type: type })).context?.[0]

test('definitions: a definition linked out of its directory is not read, so R1 fires; one linked within it is read', async ($, on) => {
  const w = agentsWorld(on, {
    '/w/.claude/agents/leak.md': defn('haiku'),
    '/w/.claude/agents/alias.md': defn('haiku'),
    '/w/.claude/agents/real.md': defn('haiku'),
    '/h/.ssh/leak.md': defn('haiku'),
  })
  w.real['/w/.claude/agents/leak.md'] = '/h/.ssh/leak.md'
  w.real['/w/.claude/agents/alias.md'] = '/w/.claude/agents/real.md'
  await start($)
  expect(await noteOf($, 'leak')).toContain(NO_MODEL)
  expect(w.reads.filter((p) => p === '/w/.claude/agents/leak.md' || p === '/h/.ssh/leak.md')).toEqual([])
  expect(await noteOf($, 'alias')).toBe(undefined)
})

test('definitions: a user or plugin definition linked into the config directory is read; one linked out of it is not', async ($, on) => {
  const w = agentsWorld(on, {
    [CFG + '/agents/shared.md']: defn('haiku'),
    [CFG + '/agents/out.md']: defn('haiku'),
    [CFG + '/plugins/cache/mk/acme/1.0.0/agents/scout.md']: defn('sonnet'),
    [CFG + '/dotfiles/shared.md']: defn('haiku'),
    '/srv/out.md': defn('haiku'),
  })
  w.real[CFG + '/agents/shared.md'] = CFG + '/dotfiles/shared.md'
  w.real[CFG + '/agents/out.md'] = '/srv/out.md'
  await start($)
  expect(await noteOf($, 'shared')).toBe(undefined)
  expect(await noteOf($, 'acme:scout')).toBe(undefined)
  expect(await noteOf($, 'out')).toContain(NO_MODEL)
})

test('definitions: the real path that was checked is what is read; a link swapped after the check is not followed', async ($, on) => {
  const w = agentsWorld(on, { '/w/.claude/agents/alias.md': defn('haiku'), '/w/.claude/agents/real.md': defn('haiku'), '/h/.ssh/leak.md': '---\nname: x\n---\n' })
  w.real['/w/.claude/agents/alias.md'] = '/w/.claude/agents/real.md'
  w.afterStat = (path) => {
    if (path === '/w/.claude/agents/alias.md') w.real[path] = '/h/.ssh/leak.md'
  }
  await start($)
  expect(await noteOf($, 'alias')).toBe(undefined)
  expect(w.reads.filter((p) => p === '/w/.claude/agents/alias.md' || p === '/h/.ssh/leak.md')).toEqual([])
})

// ---------------------------------------------------------------- the containment test

test('insideDir: the directory itself and paths under it, never a sibling sharing its prefix; Windows paths in any case', async () => {
  expect(insideDir('/w', '/w')).toBe(true)
  expect(insideDir('/w/a/b.md', '/w')).toBe(true)
  expect(insideDir('/w/a/b.md', '/w/')).toBe(true)
  expect(insideDir('/wx/b.md', '/w')).toBe(false)
  expect(insideDir('/h/.ssh/config', '/w')).toBe(false)
  expect(insideDir('/anything', '/')).toBe(true)
  expect(insideDir('C:\\Users\\Me\\proj\\p.md', 'c:\\users\\me\\proj')).toBe(true)
  expect(insideDir('C:\\Users\\Me\\proj2\\p.md', 'C:\\Users\\Me\\proj')).toBe(false)
  expect(insideDir('D:\\proj\\p.md', 'C:\\proj')).toBe(false)
  expect(insideDir('C:\\x\\p.md', 'C:\\')).toBe(true)
})
