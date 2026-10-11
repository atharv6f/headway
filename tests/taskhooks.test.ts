import { expect, test } from 'claude-code/testing'
import { start, TOOL, world } from './world.ts'
import { todoId } from '../hooks/tasks.ts'
import { text as nested } from './fixtures/plan-nested.ts'

// Claude's task tools through the hooks (SPEC 4.5): the sequences for both families, a subagent's call,
// the source against the others, the saved record and the resume from the task files.
const CFG = '/cfg'
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 100, scroll: { offset: 0, bodyRows: 15 }, view: {} }
const PLAN_FILE = '/home/u/.claude/plans/some-plan.md'

// The engine's task tools beneath: ids are assigned in order, an update answers its status change.
function engine(on) {
  let next = 1
  on('tool.call', async (_$, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(next++), subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'], statusChange: { from: 'pending', to: e.status } } }
    if (e.tool === 'TodoWrite') return { result: { oldTodos: [], newTodos: e.todos } }
    if (e.tool === 'ExitPlanMode') return { result: { plan: e.plan, isAgent: false, filePath: PLAN_FILE } }
    return { result: 'ok' }
  })
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
}

const create = ($, subject: string, over: Record<string, unknown> = {}) => $.tool.call({ tool: 'TaskCreate', tool_use_id: 'toolu_c' + Math.random(), subject, description: 'd', activeForm: 'Doing ' + subject, ...over })
const update = ($, taskId: string, status: string, over: Record<string, unknown> = {}) => $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'toolu_u' + Math.random(), taskId, status, ...over })
const todos = ($, ...rows: Array<[string, string]>) => $.tool.call({ tool: 'TodoWrite', tool_use_id: 'toolu_t' + Math.random(), todos: rows.map(([content, status]) => ({ content, status, activeForm: 'Doing ' + content })) })

async function state($): Promise<string> {
  return (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_w', action: 'state' })).result as string
}
const goalLine = async ($) => (await state($)).split('\n')[0]

async function bandLine1($): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: 'headway', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const t = await ui.find({ type: 'Text', text: /◆/ })
  await ui.unmount()
  return t?.text as string | undefined
}

const file = (id: string, status: string, subject = 'task ' + id) => JSON.stringify({ id, subject, description: '', activeForm: '', status, blocks: [], blockedBy: [] })

test('TaskCreate then TaskUpdate: the list draws with the tasks tag and counts follow the statuses', async ($, on) => {
  const w = world(on)
  engine(on)
  await start($)
  await create($, 'one')
  await create($, 'two')
  await create($, 'three')
  expect(await goalLine($)).toMatch(/— 0\/3 done \(tasks\)$/)
  await update($, '1', 'in_progress')
  await update($, '1', 'completed')
  await update($, '2', 'in_progress')
  expect(await goalLine($)).toMatch(/— 1\/3 done \(tasks\)$/)
  expect(await bandLine1($)).toMatch(/1\/3 done {2}tasks$/)
  await update($, '2', 'deleted')
  expect(await goalLine($)).toMatch(/— 1\/2 done \(tasks\)$/)
  await update($, '3', 'completed')
  expect(await goalLine($)).toMatch(/— 2\/2 done \(tasks\)$/)
  expect((w.last.tasks as Array<{ id: string; status: string }>).map((t) => t.id + ':' + t.status)).toEqual(['1:done', '3:done'])
})

test('TodoWrite: the full list each call replaces the last', async ($, on) => {
  const w = world(on)
  engine(on)
  await start($)
  await todos($, ['alpha', 'in_progress'], ['beta', 'pending'], ['gamma', 'pending'])
  expect(await goalLine($)).toMatch(/— 0\/3 done \(tasks\)$/)
  await todos($, ['alpha', 'completed'], ['beta', 'in_progress'], ['gamma', 'pending'])
  expect(await goalLine($)).toMatch(/— 1\/3 done \(tasks\)$/)
  await todos($, ['alpha', 'completed'], ['beta', 'completed'], ['gamma', 'completed'])
  expect(await goalLine($)).toMatch(/— 3\/3 done \(tasks\)$/)
  expect((w.last.tasks as unknown[]).length).toBe(3)
})

test('a subagent call (e.agentId) is ignored by all three tools', async ($, on) => {
  const w = world(on)
  engine(on)
  await start($)
  await create($, 'sub task', { agentId: 'sub-1' })
  await todos($, ['x', 'pending']).then(() => {})
  expect(((w.last.tasks as unknown[]) ?? []).length).toBe(1) // the main-loop TodoWrite above
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 't2', agentId: 'sub-1', todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] })
  await update($, '1', 'completed', { agentId: 'sub-1' })
  expect(await goalLine($)).toMatch(/— 0\/1 done \(tasks\)$/)
})

test('a denied or failed call changes nothing; the call itself still reaches the engine', async ($, on) => {
  const w = world(on)
  on('tool.call', async (_$, e) => {
    if (e.tool === 'TaskCreate' && e.subject === 'denied') return { deny: 'no' }
    if (e.tool === 'TaskCreate') return { result: { task: { id: '1', subject: e.subject } } }
    return { result: 'Error: no such task', isError: true }
  })
  await start($)
  await create($, 'denied')
  expect(w.last.tasks ?? null).toBe(null)
  const r = await create($, 'ok')
  expect((r.result as { task: { id: string } }).task.id).toBe('1')
  await update($, '1', 'completed')
  expect(await goalLine($)).toMatch(/— 0\/1 done \(tasks\)$/)
})

test('precedence: a reported list hides the task list; an ExitPlanMode approval clears it', async ($, on) => {
  const w = world(on)
  engine(on)
  await start($)
  await create($, 'one')
  await $.tool.call({ tool: TOOL, tool_use_id: 'r', action: 'report', title: 'Mine', tasks: [{ id: 'S1', title: 's', status: 'open' }] })
  expect(await goalLine($)).toBe('goal: Mine — 0/1 done (reported)')
  await $.tool.call({ tool: TOOL, tool_use_id: 'r2', action: 'report', tasks: [] }).catch(() => {})
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'p', plan: nested, planFilePath: PLAN_FILE })
  expect(await goalLine($)).toContain('(plan)')
  expect(w.last.tasks ?? null).toBe(null)
})

test('the goal label is the prompt that started the task list; a later prompt does not rename it', async ($, on) => {
  world(on)
  engine(on)
  await start($)
  await $.prompt.submit({ text: 'Make three files', origin: { kind: 'composer' }, wait: false })
  await create($, 'one')
  expect(await goalLine($)).toBe('goal: Make three files — 0/1 done (tasks)')
  await $.prompt.submit({ text: 'Now something else', origin: { kind: 'composer' }, wait: false })
  await create($, 'two')
  expect(await goalLine($)).toBe('goal: Make three files — 0/2 done (tasks)')
})

test('persistence: the list is saved with the record and a /clear clears it; a fork keeps it', async ($, on) => {
  const w = world(on, { sessionId: 's-1', env: { CLAUDE_CONFIG_DIR: CFG } })
  engine(on)
  await start($)
  await todos($, ['a', 'completed'], ['b', 'pending'])
  await w.clock.advance(1100)
  expect((w.store['session:s-1'] as { tasks: unknown[] }).tasks).toEqual([
    { id: todoId('a'), title: 'a', status: 'done', at: 1_000_000 },
    { id: todoId('b'), title: 'b', status: 'open', at: 1_000_000 },
  ])
  w.setSessionId('s-2')
  await $.classic.SessionStart({ source: 'fork', session_id: 's-2' })
  expect(await goalLine($)).toMatch(/— 1\/2 done \(tasks\)$/)
  w.setSessionId('s-3')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-3' })
  expect(await goalLine($)).toBe('goal: nothing tracked')
  expect((w.store['session:s-3'] as { tasks: unknown } | undefined)?.tasks ?? null).toBe(null)
})

test('resume: the list is rebuilt from the task files, over the saved one', async ($, on) => {
  const files = {
    [CFG + '/tasks/s-res/1.json']: file('1', 'completed', 'first'),
    [CFG + '/tasks/s-res/2.json']: file('2', 'in_progress', 'second'),
    [CFG + '/tasks/s-res/10.json']: file('10', 'pending', 'tenth'),
    [CFG + '/tasks/s-res/.lock']: '',
    [CFG + '/tasks/s-res/.highwatermark']: '10',
  }
  const old = { filter: null, report: null, tasks: [{ id: '1', title: 'stale', status: 'open' }], agents: [], log: [], savedAt: 999_000 }
  const w = world(on, { files, sessionId: 's-res', env: { CLAUDE_CONFIG_DIR: CFG }, store: { 'session:s-res': old } })
  engine(on)
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-res' })
  expect(w.last.tasks).toEqual([
    { id: '1', title: 'first', status: 'done' },
    { id: '2', title: 'second', status: 'partial' },
    { id: '10', title: 'tenth', status: 'open' },
  ])
  expect(await goalLine($)).toMatch(/— 1\/3 done \(tasks\)$/)
  // the next update after the resume lands on the rebuilt list
  await update($, '2', 'completed')
  expect(await goalLine($)).toMatch(/— 2\/3 done \(tasks\)$/)
})

test('resume: a task file over 64 KiB or not a regular file is skipped with one debug line; at most 500 task files are read', async ($, on) => {
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  const dir = CFG + '/tasks/s-cap/'
  const files: Record<string, string> = {
    [dir + '1.json']: file('1', 'pending', 'small'),
    [dir + '2.json']: file('2', 'pending', 'big') + ' '.repeat(64 * 1024),
    [dir + '3.json']: file('3', 'pending', 'pipe'),
    [dir + '4.json']: file('4', 'pending', 'edge').padEnd(64 * 1024, ' '),
  }
  for (let i = 0; i < 600; i++) files[dir + 'z' + i + '.json'] = file('z' + i, 'pending', 'filler ' + i)
  const w = world(on, { files, sessionId: 's-cap', env: { CLAUDE_CONFIG_DIR: CFG } })
  w.kinds[dir + '3.json'] = 'fifo'
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-cap' })
  const ids = (w.last.tasks as Array<{ id: string }>).map((t) => t.id)
  expect(ids.slice(0, 2)).toEqual(['1', '4']) // the small file and the one of exactly 64 KiB
  expect(ids.includes('2') || ids.includes('3')).toBe(false)
  expect(w.reads.filter((p) => p.startsWith(dir))).not.toContain(dir + '2.json')
  expect(w.reads.filter((p) => p.startsWith(dir)).length).toBeLessThanOrEqual(500)
  expect(w.reads.filter((p) => p.startsWith(dir)).length).toBeGreaterThan(400) // the cap bounds the reads, it does not stop them
  expect(logs.filter((l) => l.includes('2.json'))).toHaveLength(1)
  expect(logs.filter((l) => l.includes('3.json'))).toHaveLength(1)
  expect(logs.filter((l) => l.includes('over 500'))).toHaveLength(1)
})

test('resume with no record: the task files alone give the list; HOME is the config dir when CLAUDE_CONFIG_DIR is unset', async ($, on) => {
  const files = { '/home/u/.claude/tasks/s-new/1.json': file('1', 'in_progress', 'only') }
  const w = world(on, { files, sessionId: 's-new', env: { HOME: '/home/u' } })
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-new' })
  expect(w.last.tasks).toEqual([{ id: '1', title: 'only', status: 'partial' }])
  expect(await goalLine($)).toMatch(/— 0\/1 done \(tasks\)$/)
})

test('resume after every task completed: the files are gone, the saved list stays and reads n/n done', async ($, on) => {
  const done = { filter: null, report: null, tasks: [{ id: '1', title: 'a', status: 'done' }, { id: '2', title: 'b', status: 'done' }], agents: [], log: [], savedAt: 999_000 }
  const w = world(on, { files: { [CFG + '/tasks/s-fin/.lock']: '', [CFG + '/tasks/s-fin/.highwatermark']: '2' }, sessionId: 's-fin', env: { CLAUDE_CONFIG_DIR: CFG }, store: { 'session:s-fin': done } })
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-fin' })
  expect(await goalLine($)).toMatch(/— 2\/2 done \(tasks\)$/)
  expect(w.last.tasks).toEqual(done.tasks)
})

test('resume of a TodoWrite session: no task directory at all, the saved list restores', async ($, on) => {
  const saved = { filter: null, report: null, tasks: [{ id: '1', title: 'alpha', status: 'partial' }, { id: '2', title: 'beta', status: 'open' }], agents: [], log: [], savedAt: 999_000 }
  world(on, { sessionId: 's-todo', env: { CLAUDE_CONFIG_DIR: CFG }, store: { 'session:s-todo': saved } })
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-todo' })
  expect(await goalLine($)).toMatch(/— 0\/2 done \(tasks\)$/)
})

test('resume of an old record that has no tasks field starts the task source empty', async ($, on) => {
  const old = { filter: null, report: null, agents: [], log: [], savedAt: 999_000 }
  const w = world(on, { sessionId: 's-old', env: { CLAUDE_CONFIG_DIR: CFG }, store: { 'session:s-old': old } })
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-old' })
  expect(w.last.tasks ?? null).toBe(null)
  expect(await goalLine($)).toBe('goal: nothing tracked')
})

test('parallel TaskCreate calls in one message: every task lands, none overwrites another', async ($, on) => {
  const w = world(on)
  engine(on)
  await start($)
  await Promise.all([create($, 'one'), create($, 'two'), create($, 'three')])
  expect(await goalLine($)).toMatch(/— 0\/3 done \(tasks\)$/)
  expect((w.last.tasks as Array<{ id: string }>).map((t) => t.id).sort()).toEqual(['1', '2', '3'])
  await Promise.all([update($, '1', 'completed'), update($, '2', 'completed'), update($, '3', 'in_progress')])
  expect(await goalLine($)).toMatch(/— 2\/3 done/)
})

test('five parallel TaskCreate calls, the first starting the source: the goal written counts all five (the reviewer case)', async ($, on) => {
  world(on, { watchState: false })
  engine(on)
  // the first call's label write (it starts the source) is held until the other four have landed
  let release: () => void = () => {}
  const held = new Promise<void>((r) => (release = r))
  let goal: { total?: number; source?: string } | null = null
  let tasks: unknown[] = []
  on('state.set', async ($, e, next) => {
    if (e.plugin === 'headway' && e.key === 'label') await held
    if (e.plugin === 'headway' && e.key === 'goal') goal = e.value
    if (e.plugin === 'headway' && e.key === 'tasks') tasks = e.value
    return next(e)
  })
  await start($)
  const first = create($, 'one')
  await new Promise((r) => setTimeout(r, 20))
  await Promise.all(['two', 'three', 'four', 'five'].map((t) => create($, t)))
  release()
  await first
  expect(tasks.length).toBe(5)
  // the goal atom as the band draws it, not a re-read through the state action
  expect(goal).toMatchObject({ total: 5, source: 'tasks' })
})

test('two sources starting in one message both keep their prompt label', async ($, on) => {
  const w = world(on)
  engine(on)
  await start($)
  await $.prompt.submit({ text: 'Make three files', origin: { kind: 'composer' }, wait: false })
  await Promise.all([create($, 'one'), $.tool.call({ tool: TOOL, tool_use_id: 'r', action: 'report', tasks: [{ title: 'a' }] })])
  expect(w.last.label).toEqual({ tasks: 'Make three files', reported: 'Make three files' })
})

test('TodoWrite through the hooks: insert, drop and reorder log no task flips; a status change logs one', async ($, on) => {
  const w = world(on)
  engine(on)
  await start($)
  const flips = () => ((w.last.log as Array<{ kind: string; ref: string }>) ?? []).filter((l) => l.kind.startsWith('task-'))
  await todos($, ['a', 'completed'], ['b', 'in_progress'], ['c', 'pending'])
  await todos($, ['new', 'pending'], ['a', 'completed'], ['b', 'in_progress'], ['c', 'pending'])
  await todos($, ['new', 'pending'], ['b', 'in_progress'], ['c', 'pending'])
  await todos($, ['c', 'pending'], ['b', 'in_progress'], ['new', 'pending'])
  expect(flips()).toEqual([])
  await todos($, ['c', 'pending'], ['b', 'completed'], ['new', 'pending'])
  expect(flips().map((f) => f.kind)).toEqual(['task-done'])
})
