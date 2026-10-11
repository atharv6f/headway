import { expect, test } from 'claude-code/testing'
import { applyUpdates, parseReport, reportPlan } from '../plugin/hooks/tool.ts'
import type { Reported } from '../plugin/hooks/tool.ts'
import { matchAgent } from '../plugin/hooks/agents.ts'
import { TASKS_MAX, TITLE_MAX } from '../plugin/hooks/format.ts'
import * as f from './fixtures/report.ts'

// 4.3 report inputs, pure: a list (ids optional, three statuses), updates, done, and the refusals.
function list(input: Record<string, unknown>): Reported {
  const r = parseReport(input)
  if (!r.ok || r.kind !== 'list') throw new Error(r.ok ? 'not a list' : r.error)
  return r.report
}

test('a list without ids gets 1..n by position; the status defaults to open', async () => {
  const r = list(f.noIds)
  expect(r.title).toBe('Fruit files')
  expect(r.tasks).toEqual([
    { id: '1', title: 'Create a.txt', status: 'open' },
    { id: '2', title: 'Create b.txt', status: 'open' },
    { id: '3', title: 'List them', status: 'open' },
  ])
})

test('a list with ids keeps them and the three statuses; a mixed list numbers only the tasks without one', async () => {
  expect(list(f.withIds).tasks.map((t) => t.id + ':' + t.status)).toEqual(['R1:done', 'R2:partial', 'R3:open'])
  expect(list(f.mixedIds).tasks.map((t) => t.id + ':' + t.status)).toEqual(['B:open', '2:open', '3:done'])
})

test('a repeated id refuses the list; so does an id that a number given by position would repeat', async () => {
  expect(parseReport(f.duplicateIds)).toEqual({ ok: false, error: 'duplicate id: A' })
  expect(parseReport({ tasks: [{ id: '2', title: 'a' }, { title: 'b' }] })).toEqual({ ok: false, error: 'duplicate id: 2' })
})

test('list refusals: not an array, a missing title, an unknown status, a title that is not text', async () => {
  expect(parseReport({ tasks: 'x' })).toEqual({ ok: false, error: 'tasks must be an array' })
  expect(parseReport({ tasks: [{ id: 'A1', status: 'open' }] })).toEqual({ ok: false, error: 'task 1: title must be a non-empty string' })
  expect(parseReport({ tasks: [{ title: 'a' }, { title: 'b', status: 'maybe' }] })).toEqual({ ok: false, error: 'task 2: status must be open, partial or done' })
  expect(parseReport({ tasks: [{ title: 't' }], title: 4 })).toEqual({ ok: false, error: 'title must be a string' })
})

test('updates: each named task takes its status; done is the shorthand; both may come in one call', async () => {
  const u = parseReport(f.unknownUpdate)
  expect(u).toEqual({ ok: true, kind: 'updates', updates: [{ id: 'R3', status: 'partial' }, { id: 'R9', status: 'done' }] })
  const d = parseReport(f.doneIds)
  expect(d).toEqual({ ok: true, kind: 'updates', updates: [{ id: 'R2', status: 'done' }, { id: 'R3', status: 'done' }] })
  expect(parseReport({ updates: [{ id: 'A', status: 'partial' }], done: ['B'] })).toEqual({
    ok: true,
    kind: 'updates',
    updates: [{ id: 'A', status: 'partial' }, { id: 'B', status: 'done' }],
  })
})

test('updates refusals: tasks with updates or done, nothing at all, a bad entry', async () => {
  expect(parseReport(f.both)).toEqual({ ok: false, error: 'tasks and updates or done cannot be combined in one call' })
  expect(parseReport({ tasks: [{ title: 'x' }], done: ['1'] })).toEqual({ ok: false, error: 'tasks and updates or done cannot be combined in one call' })
  expect(parseReport({ title: 'only a title' })).toEqual({ ok: false, error: 'tasks, updates or done required' })
  expect(parseReport({ updates: 'x' })).toEqual({ ok: false, error: 'updates must be an array' })
  expect(parseReport({ updates: [{ status: 'done' }] })).toEqual({ ok: false, error: 'update 1: id must be a non-empty string' })
  expect(parseReport({ updates: [{ id: '1', status: 'later' }] })).toEqual({ ok: false, error: 'update 1: status must be open, partial or done' })
  expect(parseReport({ done: 'x' })).toEqual({ ok: false, error: 'done must be an array of ids' })
  expect(parseReport({ done: [''] })).toEqual({ ok: false, error: 'done 1: id must be a non-empty string' })
})

test('applying updates: the known ids move, an unknown id is named and the rest still apply', async () => {
  const r = list(f.withIds)
  const out = applyUpdates(r.tasks, [{ id: 'R3', status: 'partial' }, { id: 'R9', status: 'done' }])
  expect(out.items.map((t) => t.id + ':' + t.status)).toEqual(['R1:done', 'R2:partial', 'R3:partial'])
  expect(out.applied).toBe(1)
  expect(out.unknown).toEqual(['R9'])
  expect(r.tasks[2].status).toBe('open') // the input list is not changed
  const all = applyUpdates(r.tasks, [{ id: 'R2', status: 'done' }, { id: 'R3', status: 'done' }])
  expect(all.items.map((t) => t.status)).toEqual(['done', 'done', 'done'])
  expect(all.applied).toBe(2)
})

test('a reported list as a plan: partial tasks count and the count words are done and partial', async () => {
  const plan = reportPlan(list(f.withIds))
  expect(plan.counts).toEqual({ done: 1, partial: 1, open: 1, total: 3 })
  expect(plan.partialWord).toBe('partial')
  expect(plan.doneWord).toBe('done')
  expect(plan.tasks.map((t) => t.status)).toEqual(['done', 'partial', 'open'])
  // no partial task: the plain count, no partial word
  const plain = reportPlan(list(f.noIds))
  expect(plain.partialWord).toBe(undefined)
  expect(plain.counts).toEqual({ done: 0, partial: 0, open: 3, total: 3 })
})

test('temporal association: no id matched and exactly one task partial attaches the agent to it', async () => {
  const one = reportPlan(list({ tasks: [{ title: 'a' }, { title: 'b', status: 'partial' }, { title: 'c' }] }))
  const m = matchAgent(one, ['write the file'], { temporal: true })
  expect(m.taskIds).toEqual(['2'])
  expect(m.groupId).toBe('reported') // the list's own group
  // an id in the text still wins
  expect(matchAgent(one, ['step 3: write the file'], { temporal: true }).taskIds).toEqual(['3'])
  // not asked for: no association
  expect(matchAgent(one, ['write the file']).taskIds).toEqual([])
  // none partial, two partial
  const none = reportPlan(list(f.noIds))
  expect(matchAgent(none, ['write the file'], { temporal: true }).taskIds).toEqual([])
  const two = reportPlan(list({ tasks: [{ title: 'a', status: 'partial' }, { title: 'b', status: 'partial' }] }))
  expect(matchAgent(two, ['write the file'], { temporal: true }).taskIds).toEqual([])
})

// ---------------------------------------------------------------- batch B: text and size at ingest

test('ingest: a title with line breaks and escape sequences is one clean line', async () => {
  const r = list({
    title: 'Ship\nit \u001b[31mnow\u001b[0m',
    tasks: [
      { title: 'Read\r\nthe file' },
      { title: 'Open \u001b]8;;https://evil.example/x\u001b\\the link\u001b]8;;\u001b\\ ok' },
      { id: 'A\u001b[2J1', title: '\u001b]0;pwned\u0007Plain' },
    ],
  })
  expect(r.title).toBe('Ship it now')
  expect(r.tasks.map((t) => t.title)).toEqual(['Read the file', 'Open the link ok', 'Plain'])
  expect(r.tasks[2].id).toBe('A1')
})

test('ingest: a title that is only escapes is empty and refused like an empty one', async () => {
  expect(parseReport({ tasks: [{ title: '\u001b[31m\u001b[0m  \n' }] })).toEqual({ ok: false, error: 'task 1: title must be a non-empty string' })
})

test('ingest: a title is cut at 200 characters, the goal title too', async () => {
  const r = list({ title: 'g'.repeat(500), tasks: [{ title: 't'.repeat(1000) }] })
  expect(Array.from(r.tasks[0].title).length).toBe(TITLE_MAX)
  expect(r.tasks[0].title.endsWith('…')).toBe(true)
  expect(Array.from(r.title ?? '').length).toBe(TITLE_MAX)
})

test('ingest: a list of more than 200 tasks is refused, 200 are taken', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ title: 'task ' + i }))
  expect(list({ tasks: many(TASKS_MAX) }).tasks.length).toBe(TASKS_MAX)
  expect(parseReport({ tasks: many(TASKS_MAX + 1) })).toEqual({ ok: false, error: 'at most ' + TASKS_MAX + ' tasks' })
  // the reviewer's case: 5000 tasks of about a kilobyte each, 5.2 MB, never reaches the store
  const huge = Array.from({ length: 5000 }, (_, i) => ({ title: String(i).padEnd(1040, 'x') }))
  expect(JSON.stringify(huge).length).toBeGreaterThan(5_200_000)
  expect(parseReport({ tasks: huge })).toEqual({ ok: false, error: 'at most ' + TASKS_MAX + ' tasks' })
})

test('ingest: updates and done lists are bounded the same way', async () => {
  const ids = Array.from({ length: TASKS_MAX + 1 }, (_, i) => String(i + 1))
  expect(parseReport({ done: ids })).toEqual({ ok: false, error: 'at most ' + TASKS_MAX + ' done ids' })
  expect(parseReport({ updates: ids.map((id) => ({ id, status: 'done' })) })).toEqual({ ok: false, error: 'at most ' + TASKS_MAX + ' updates' })
  expect(parseReport({ done: ids.slice(0, TASKS_MAX) }).ok).toBe(true)
})
