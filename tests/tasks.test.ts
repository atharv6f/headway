import { expect, test } from 'claude-code/testing'
import { applyTaskCall, parseTaskFile, rebuildFromFiles, tasksPlan, todoId } from '../hooks/tasks.ts'
import { TASKS_MAX, TITLE_MAX } from '../hooks/format.ts'
import type { TaskItem } from '../hooks/tasks.ts'
import { activeSource, approvePlan, goalLabel, sourceFlips, sourcePlan } from '../hooks/sources.ts'
import type { Sources } from '../hooks/sources.ts'
import { parsePlanMode } from '../hooks/planmode.ts'

// Claude's task tools as a plan source (SPEC 4.5): the payloads of TaskCreate, TaskUpdate and TodoWrite
// folded into one list, the task files of a resume, and the list as a plan.
const create = (subject: string, id: string) => applyTaskCall.bind(null, 'TaskCreate', { subject, description: 'd', activeForm: 'Doing ' + subject }, { task: { id, subject } })
const upd = (taskId: string, extra: Record<string, unknown>, output: unknown = { success: true, taskId }) => applyTaskCall.bind(null, 'TaskUpdate', { taskId, ...extra }, output)
const ids = (l: TaskItem[] | null) => (l ?? []).map((t) => t.id + ':' + t.status)

test('TaskCreate adds an open task with the engine-assigned id; TaskUpdate maps the statuses', async () => {
  let l = create('a', '1')(null)
  l = create('b', '2')(l)
  l = create('c', '3')(l)
  expect(l).toEqual([
    { id: '1', title: 'a', status: 'open' },
    { id: '2', title: 'b', status: 'open' },
    { id: '3', title: 'c', status: 'open' },
  ])
  l = upd('1', { status: 'in_progress' })(l)
  expect(ids(l)).toEqual(['1:partial', '2:open', '3:open'])
  l = upd('1', { status: 'completed' })(l)
  l = upd('2', { status: 'in_progress' })(l)
  expect(ids(l)).toEqual(['1:done', '2:partial', '3:open'])
  l = upd('2', { status: 'pending' })(l)
  expect(ids(l)).toEqual(['1:done', '2:open', '3:open'])
})

test('TaskUpdate: a subject renames, a deleted status removes, an update without status keeps it', async () => {
  let l = create('b', '2')(create('a', '1')(null))
  l = upd('2', { subject: 'bee' })(l)
  expect(l![1]).toEqual({ id: '2', title: 'bee', status: 'open' })
  l = upd('2', { status: 'in_progress', subject: 'bee 2' })(l)
  expect(l![1]).toEqual({ id: '2', title: 'bee 2', status: 'partial' })
  l = upd('1', { status: 'deleted' })(l)
  expect(ids(l)).toEqual(['2:partial'])
  l = upd('2', { status: 'deleted' })(l)
  expect(l).toEqual([])
})

test('out of order: an update for an unknown id, a repeated create, a status that goes back, a failed result', async () => {
  const l = create('a', '1')(null)
  // unknown id: nothing to draw a row from
  expect(upd('9', { status: 'completed' })(l)).toEqual(l)
  expect(upd('1', { status: 'completed' })(null)).toBe(null)
  // a create for an id already listed renames it and keeps its place and status
  const dup = create('a again', '1')(upd('1', { status: 'in_progress' })(l))
  expect(dup).toEqual([{ id: '1', title: 'a again', status: 'partial' }])
  // completed, then back to in_progress: the last update stands
  expect(ids(upd('1', { status: 'in_progress' })(upd('1', { status: 'completed' })(l)))).toEqual(['1:partial'])
  // a result that says the call failed changes nothing
  expect(upd('1', { status: 'completed' }, { success: false, taskId: '1' })(l)).toEqual(l)
  expect(upd('1', { status: 'completed' }, 'Error: no such task')(l)).toEqual(l)
  expect(applyTaskCall('TaskCreate', { subject: 'x' }, 'Error: nope', l)).toEqual(l)
  expect(applyTaskCall('TaskCreate', { subject: 'x' }, { task: {} }, l)).toEqual(l)
  // an unknown status word changes the title only
  expect(ids(upd('1', { status: 'weird' })(l))).toEqual(['1:open'])
})

test('TaskList, TaskGet and other tools do not change the list', async () => {
  const l = create('a', '1')(null)
  expect(applyTaskCall('TaskList', {}, { tasks: [{ id: '1', subject: 'a', status: 'pending', blockedBy: [] }] }, l)).toEqual(l)
  expect(applyTaskCall('Read', {}, {}, l)).toEqual(l)
})

test('TodoWrite replaces the whole list in order; ids come from the content, same status map', async () => {
  const todos = (...rows: Array<[string, string]>) => ({ todos: rows.map(([content, status]) => ({ content, status, activeForm: 'Doing ' + content })) })
  const [A, B, G, D] = ['alpha', 'beta', 'gamma', 'delta'].map(todoId)
  let l = applyTaskCall('TodoWrite', todos(['alpha', 'in_progress'], ['beta', 'pending'], ['gamma', 'pending']), { oldTodos: [], newTodos: [] }, null)
  expect(l).toEqual([
    { id: A, title: 'alpha', status: 'partial' },
    { id: B, title: 'beta', status: 'open' },
    { id: G, title: 'gamma', status: 'open' },
  ])
  l = applyTaskCall('TodoWrite', todos(['alpha', 'completed'], ['beta', 'in_progress'], ['gamma', 'pending']), { oldTodos: [], newTodos: [] }, l)
  expect(ids(l)).toEqual([A + ':done', B + ':partial', G + ':open'])
  // a shorter, reordered list replaces: no leftovers of the old one, gamma keeps its id
  l = applyTaskCall('TodoWrite', todos(['gamma', 'completed'], ['delta', 'pending']), {}, l)
  expect(l).toEqual([
    { id: G, title: 'gamma', status: 'done' },
    { id: D, title: 'delta', status: 'open' },
  ])
  // the engine empties its own list once all are done: the input still names them
  l = applyTaskCall('TodoWrite', todos(['gamma', 'completed'], ['delta', 'completed']), { oldTodos: [], newTodos: [] }, l)
  expect(ids(l)).toEqual([G + ':done', D + ':done'])
  // an unusable row is skipped; a non-array input leaves the list; an error result leaves it
  expect(ids(applyTaskCall('TodoWrite', { todos: [null, { content: 'ok', status: 'pending' }, { status: 'pending' }] }, {}, null))).toEqual([todoId('ok') + ':open'])
  expect(applyTaskCall('TodoWrite', { todos: 'x' }, {}, l)).toEqual(l)
  expect(applyTaskCall('TodoWrite', todos(['z', 'pending']), 'Error: failed', l)).toEqual(l)
  expect(applyTaskCall('TodoWrite', { todos: [] }, {}, l)).toEqual([])
})

test('TodoWrite ids: normalised content (case, spacing) gives the same id; a repeated row is told apart; ids are short', async () => {
  expect(todoId('Write  the README ')).toBe(todoId('write the readme'))
  expect(todoId('alpha')).not.toBe(todoId('beta'))
  expect(todoId('alpha')).toMatch(/^[0-9a-z]{4}$/)
  const l = applyTaskCall('TodoWrite', { todos: [{ content: 'x', status: 'pending' }, { content: 'X', status: 'completed' }, { content: 'x', status: 'pending' }] }, {}, null)
  expect(ids(l)).toEqual([todoId('x') + ':open', todoId('x') + '-2:done', todoId('x') + '-3:open'])
})

test('TodoWrite: an insert at the top, a dropped completed row or a reorder logs no flip; a status change does', async () => {
  const todos = (...rows: Array<[string, string]>) => ({ todos: rows.map(([content, status]) => ({ content, status })) })
  const flips = (a: TaskItem[] | null, b: TaskItem[] | null) => sourceFlips(tasksPlan(a!), tasksPlan(b!), 1).map((f) => f.kind + ':' + f.ref)
  const l1 = applyTaskCall('TodoWrite', todos(['a', 'completed'], ['b', 'in_progress'], ['c', 'pending']), {}, null)
  const inserted = applyTaskCall('TodoWrite', todos(['new', 'pending'], ['a', 'completed'], ['b', 'in_progress'], ['c', 'pending']), {}, l1)
  expect(flips(l1, inserted)).toEqual([])
  const dropped = applyTaskCall('TodoWrite', todos(['b', 'in_progress'], ['c', 'pending']), {}, l1)
  expect(flips(l1, dropped)).toEqual([])
  const reordered = applyTaskCall('TodoWrite', todos(['c', 'pending'], ['b', 'in_progress'], ['a', 'completed']), {}, l1)
  expect(flips(l1, reordered)).toEqual([])
  const moved = applyTaskCall('TodoWrite', todos(['a', 'completed'], ['b', 'completed'], ['c', 'in_progress']), {}, l1)
  expect(flips(l1, moved)).toEqual(['task-done:' + todoId('b'), 'task-partial:' + todoId('c')])
  // the stamp moves only on the rows that changed
  const t1 = applyTaskCall('TodoWrite', todos(['a', 'pending'], ['b', 'pending']), {}, null, 10)
  const t2 = applyTaskCall('TodoWrite', todos(['b', 'pending'], ['new', 'pending'], ['a', 'completed']), {}, t1, 20)
  expect(t2!.map((t) => t.title + '@' + t.at)).toEqual(['b@10', 'new@20', 'a@20'])
})

test('task files: one file is one task; locks, junk and deleted tasks are skipped; ids sort numerically', async () => {
  const f = (id: string, status: string, subject = 's' + id) => JSON.stringify({ id, subject, description: '', activeForm: '', status, blocks: [], blockedBy: [] })
  expect(parseTaskFile(f('1', 'in_progress'))).toEqual({ id: '1', title: 's1', status: 'partial' })
  expect(parseTaskFile(f('2', 'completed'))).toEqual({ id: '2', title: 's2', status: 'done' })
  expect(parseTaskFile(f('3', 'deleted'))).toBe(null)
  expect(parseTaskFile('not json')).toBe(null)
  expect(parseTaskFile('{"id":"1"}')).toBe(null)
  expect(parseTaskFile('')).toBe(null)
  expect(rebuildFromFiles([f('10', 'pending'), f('2', 'completed'), 'junk', f('1', 'in_progress')])).toEqual([
    { id: '1', title: 's1', status: 'partial' },
    { id: '2', title: 's2', status: 'done' },
    { id: '10', title: 's10', status: 'open' },
  ])
  expect(rebuildFromFiles([])).toBe(null)
  expect(rebuildFromFiles(['junk'])).toBe(null)
})

test('as a plan: the tasks under one group, the counts include partial, the title is the goal label elsewhere', async () => {
  const plan = tasksPlan([
    { id: '1', title: 'a', status: 'done' },
    { id: '2', title: 'b', status: 'partial' },
    { id: '3', title: 'c', status: 'open' },
  ])
  expect(plan.tasks.map((t) => t.id + ':' + t.status)).toEqual(['1:done', '2:partial', '3:open'])
  expect(plan.counts).toEqual({ done: 1, partial: 1, open: 1, total: 3 })
  expect(plan.groups.length).toBe(1)
  expect(plan.groups[0].tasks).toEqual([0, 1, 2])
  expect(plan.doneWord).toBe('done')
})

const LIST: TaskItem[] = [{ id: '1', title: 'a', status: 'open' }]
const NONE: Sources = { filter: null, report: null, planMode: null, tasks: null, phases: null }

test('the tasks row sits after plan: it shows alone, yields to the others, is cleared by an approval, takes the prompt label', async () => {
  expect(activeSource({ ...NONE, tasks: LIST })).toBe('tasks')
  expect(activeSource({ ...NONE, tasks: [] })).toBe(null)
  expect(activeSource({ ...NONE, tasks: LIST, report: { tasks: [{ id: 'S1', title: 's', status: 'open' }] } })).toBe('reported')
  const mode = parsePlanMode('# Plan: P\n1. one\n')
  expect(activeSource({ ...NONE, tasks: LIST, planMode: mode })).toBe('plan')
  expect(approvePlan({ ...NONE, tasks: LIST }, mode).tasks).toBe(null)
  expect(approvePlan({ ...NONE, tasks: LIST }, parsePlanMode('prose')).tasks).toBe(null)
  expect(sourcePlan({ ...NONE, tasks: LIST }, 'tasks')?.tasks.map((t) => t.id)).toEqual(['1'])
  expect(goalLabel({ ...NONE, tasks: LIST }, 'tasks', 'Do the thing')).toBe('Do the thing')
  expect(goalLabel({ ...NONE, tasks: LIST }, 'tasks', null)).toBe('tasks')
})

test('ingest caps: a 300-row TodoWrite keeps TASKS_MAX rows of clean titles; TaskCreate past the cap and long subjects are bounded', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ content: 'row ' + i + (i === 0 ? '\u001b[31m red\u001b[0m\nnext' : ''), status: 'pending' }))
  const l = applyTaskCall('TodoWrite', { todos: rows }, {}, null)!
  expect(l.length).toBe(TASKS_MAX)
  expect(l[0].title).toBe('row 0 red next')
  const long = applyTaskCall('TaskCreate', { subject: 'x'.repeat(1000) }, { task: { id: '1' } }, null)!
  expect(long[0].title.length).toBeLessThanOrEqual(TITLE_MAX)
  const full = Array.from({ length: TASKS_MAX }, (_, i) => ({ id: String(i + 1), title: 't' + i, status: 'open' as const }))
  expect(applyTaskCall('TaskCreate', { subject: 'one more' }, { task: { id: '999' } }, full)!.length).toBe(TASKS_MAX)
  const renamed = applyTaskCall('TaskUpdate', { taskId: '1', subject: 'y'.repeat(1000) }, { success: true }, full)!
  expect(renamed[0].title.length).toBeLessThanOrEqual(TITLE_MAX)
})
