import { expect, test } from 'claude-code/testing'
import { activeSource, applyReport, approvePlan, goalLabel, isNewWork, isPlanModeFile, modePlan, promptLabel, sourcePlan, startLabel } from '../hooks/sources.ts'
import type { Sources } from '../hooks/sources.ts'
import { parsePlanMode } from '../hooks/planmode.ts'
import { text as nested } from './fixtures/plan-nested.ts'
import { candidateIds } from '../hooks/plan.ts'
import { matchAgent } from '../hooks/agents.ts'
import { reportPlan } from '../hooks/tool.ts'
import { TASKS_MAX, TITLE_MAX } from '../hooks/format.ts'
import { tasksPlan } from '../hooks/tasks.ts'

// The source model (SPEC 4.1, 4.8): one precedence table, the tag it names, the label it draws.
const FILE = { file: '/w/plan/p.md', section: 'Work' }
const REPORT = { title: 'Ship it', tasks: [{ id: 'S1', title: 'a', status: 'open' as const }] }
const MODE = parsePlanMode(nested)
const NONE: Sources = { filter: null, report: null, planMode: null, tasks: null, phases: null }

test('precedence: every pair of sources, the higher one is active; alone, each is active', async () => {
  expect(activeSource(NONE)).toBe(null)
  expect(activeSource({ ...NONE, filter: FILE })).toBe('file')
  expect(activeSource({ ...NONE, report: REPORT })).toBe('reported')
  expect(activeSource({ ...NONE, planMode: MODE })).toBe('plan')
  expect(activeSource({ ...NONE, filter: FILE, report: REPORT })).toBe('file')
  expect(activeSource({ ...NONE, filter: FILE, planMode: MODE })).toBe('file')
  expect(activeSource({ ...NONE, report: REPORT, planMode: MODE })).toBe('reported')
  expect(activeSource({ ...NONE, filter: FILE, report: REPORT, planMode: MODE })).toBe('file')
})

test('has data: an empty report or a plan with no steps is no source, and the next one shows', async () => {
  const empty = parsePlanMode('# Plan: Talk\n\nprose only\n')
  expect(activeSource({ ...NONE, report: { tasks: [] } })).toBe(null)
  expect(activeSource({ ...NONE, report: { tasks: [] }, planMode: MODE })).toBe('plan')
  expect(activeSource({ ...NONE, planMode: empty })).toBe(null)
})

test('approval: the plan-mode plan replaces the last one and clears the reported list; the file stays', async () => {
  const before: Sources = { ...NONE, filter: FILE, report: REPORT, planMode: parsePlanMode('# Plan: Old\n1. old step\n') }
  const after = approvePlan(before, MODE)
  expect(after.report).toBe(null)
  expect(after.filter).toEqual(FILE)
  expect(after.planMode).toEqual(MODE)
  expect(activeSource(after)).toBe('file')
  expect(activeSource({ ...after, filter: null })).toBe('plan')
  // an approval that found no step still starts new work: the old plan and the report are gone
  const blank = approvePlan(before, parsePlanMode('just prose'))
  expect(blank.report).toBe(null)
  expect(activeSource({ ...blank, filter: null })).toBe(null)
})

test('plan of a source: a plan-mode plan becomes steps under their groups with the children as bars; the file has none here', async () => {
  const plan = modePlan(MODE)
  expect(plan.tasks.map((t) => t.id)).toEqual(['1', '2', '3', '4'])
  expect(plan.tasks.map((t) => t.sub?.total)).toEqual(MODE.steps.map((s) => s.sub?.total))
  expect(plan.groups.map((g) => g.id + ':' + g.tasks.join(','))).toEqual(['Checklist:0,1,2,3'])
  expect(plan.counts).toEqual({ done: 0, partial: 0, open: 4, total: 4 })
  expect(sourcePlan({ ...NONE, planMode: MODE }, 'plan')?.tasks.length).toBe(4)
  expect(sourcePlan({ ...NONE, report: REPORT }, 'reported')?.tasks.map((t) => t.id)).toEqual(['S1'])
  expect(sourcePlan({ ...NONE, filter: FILE }, 'file')).toBe(null)
})

test('goal label: file section or name, the reported title, the plan-mode title, else the prompt line', async () => {
  expect(goalLabel({ ...NONE, filter: FILE }, 'file', 'typed')).toBe('Work')
  expect(goalLabel({ ...NONE, filter: { file: '/w/plan/p.md' } }, 'file', 'typed')).toBe('p.md')
  expect(goalLabel({ ...NONE, report: REPORT }, 'reported', 'typed')).toBe('Ship it')
  expect(goalLabel({ ...NONE, report: { tasks: REPORT.tasks } }, 'reported', 'typed')).toBe('typed')
  expect(goalLabel({ ...NONE, planMode: MODE }, 'plan', 'typed')).toBe('Tidy the notes folder')
  const untitled = parsePlanMode('## Steps\n1. a\n')
  expect(goalLabel({ ...NONE, planMode: untitled }, 'plan', 'typed')).toBe('typed')
  expect(goalLabel({ ...NONE, planMode: untitled }, 'plan', null)).toBe('plan')
})

test('prompt label: a composer prompt first line, pasted tags stripped, slash commands and notifications ignored, cut to 60', async () => {
  expect(promptLabel('Add a --name flag to hello.py\nand a test', 'composer')).toBe('Add a --name flag to hello.py')
  expect(promptLabel('\n\n<pasted_content id="ab12">\nGoal from a paste: tidy up\nsecond line\n</pasted_content id="ab12">\n', 'composer')).toBe('Goal from a paste: tidy up')
  expect(promptLabel('fix this <pasted_content id="x">trace</pasted_content id="x">', 'composer')).toBe('fix this trace')
  expect(promptLabel('/headway status', 'composer')).toBe(undefined)
  expect(promptLabel('  /compact', 'composer')).toBe(undefined)
  expect(promptLabel('<task-notification>\n<status>completed</status>', 'task-notification')).toBe(undefined)
  expect(promptLabel('from a script', 'sdk')).toBe(undefined)
  expect(promptLabel('\n  \n', 'composer')).toBe(undefined)
  const long = 'x'.repeat(80)
  const cut = promptLabel(long, 'composer')!
  expect(Array.from(cut).length).toBe(60)
  expect(cut.endsWith('…')).toBe(true)
})

test('start label: a starting source takes the newest prompt line; the other sources keep theirs', async () => {
  const one = startLabel({}, 'reported', 'Build the files')
  expect(one).toEqual({ reported: 'Build the files' })
  const two = startLabel(one, 'tasks', 'Track it')
  expect(two).toEqual({ reported: 'Build the files', tasks: 'Track it' })
  expect(startLabel(two, 'reported', null)).toEqual({ tasks: 'Track it' })
})

test('a source\'s own group (named after its title, or the plan or reported fallback) is no match candidate', async () => {
  const untitled = modePlan(parsePlanMode('1. write x.txt\n2. read it back\n'))
  expect(untitled.groups.map((g) => g.id)).toEqual(['plan'])
  expect(candidateIds(untitled).groupIds).toEqual([])
  expect(matchAgent(untitled, ['Write two-step x.txt plan'])).toEqual({ taskIds: [] })
  // a real heading group stays a candidate
  expect(candidateIds(modePlan(MODE)).groupIds).toEqual(['Checklist'])
  const reported = reportPlan({ tasks: [{ id: 'S1', title: 'a', status: 'open' }] })
  expect(candidateIds(reported).groupIds).toEqual([])
  expect(matchAgent(reported, ['the reported fix'])).toEqual({ taskIds: [] })
})

test('a finished reported or plan-mode list yields to a lower source with data newer than its completion', async () => {
  const doneReport = { title: 'Ship it', doneAt: 100, tasks: [{ id: 'S1', title: 'a', status: 'done' as const }] }
  const doneMode = { ...MODE, doneAt: 100, steps: MODE.steps.map((s) => ({ ...s, status: 'done' as const })) }
  const tasksAt = (at: number) => [{ id: '1', title: 't', status: 'open' as const, at }]
  const run = (at: number) => ({ at, phases: [{ name: 'Read', status: 'open' as const }] })
  // newer task-tool data or a newer phases run takes over
  expect(activeSource({ ...NONE, report: doneReport, tasks: tasksAt(200) })).toBe('tasks')
  expect(activeSource({ ...NONE, report: doneReport, phases: run(200) })).toBe('phases')
  expect(activeSource({ ...NONE, planMode: doneMode, tasks: tasksAt(200) })).toBe('tasks')
  expect(activeSource({ ...NONE, planMode: doneMode, phases: run(200) })).toBe('phases')
  // older data does not; nor does newer data under a list with a task still open
  expect(activeSource({ ...NONE, report: doneReport, tasks: tasksAt(50), phases: run(100) })).toBe('reported')
  expect(activeSource({ ...NONE, report: { ...REPORT, tasks: [...REPORT.tasks] }, tasks: tasksAt(200) })).toBe('reported')
  // the file never yields
  expect(activeSource({ ...NONE, filter: FILE, report: doneReport, tasks: tasksAt(200) })).toBe('file')
})

test('applyReport stamps the moment every task is done and clears it when one reopens', async () => {
  const two = { tasks: [{ id: '1', title: 'a', status: 'open' as const }, { id: '2', title: 'b', status: 'open' as const }] }
  const a = applyReport({ ...NONE, report: two }, [{ id: '1', status: 'done' }], 10)
  expect(a.ok && a.sources.report!.doneAt).toBe(undefined)
  const b = applyReport(a.ok ? a.sources : NONE, [{ id: '2', status: 'done' }], 20)
  expect(b.ok && b.sources.report!.doneAt).toBe(20)
  // a later update that leaves it all done keeps the first moment
  const c = applyReport(b.ok ? b.sources : NONE, [{ id: '2', status: 'done' }], 30)
  expect(c.ok && c.sources.report!.doneAt).toBe(20)
  const d = applyReport(c.ok ? c.sources : NONE, [{ id: '1', status: 'partial' }], 40)
  expect(d.ok && d.sources.report!.doneAt).toBe(undefined)
  const m = applyReport({ ...NONE, planMode: parsePlanMode('# Plan: P\n1. one\n') }, [{ id: '1', status: 'done' }], 50)
  expect(m.ok && m.sources.planMode!.doneAt).toBe(50)
})

test('a qualified plan-mode id matches only as step 2.1, #2.1 or 2.1: opening the text, never loose', async () => {
  const pm = parsePlanMode(`# Plan: Two\n\n## Phase 1\n1. a\n2. b\n\n## Phase 2\n1. c\n2. d\n`)
  const plan = modePlan(pm)
  expect(matchAgent(plan, ['step 2.1: write c']).taskIds).toEqual(['2.1'])
  expect(matchAgent(plan, ['Step 1.2 — b']).taskIds).toEqual(['1.2'])
  expect(matchAgent(plan, ['#2.2 d']).taskIds).toEqual(['2.2'])
  expect(matchAgent(plan, ['2.1: c']).taskIds).toEqual(['2.1'])
  expect(matchAgent(plan, ['bump to version 2.1 now']).taskIds).toEqual([])
  expect(matchAgent(plan, ['step 2.10']).taskIds).toEqual([])
})

// ---------------------------------------------------------------- batch B: the plan that is drawn is bounded and clean

test('plan of a source: more than 200 steps draw as 200, titles as one clean line of at most 200 characters', async () => {
  const steps = Array.from({ length: 300 }, (_, i) => ({ id: String(i + 1), title: i === 0 ? 'Read\nthe \u001b[31mfile' : 'x'.repeat(500), status: 'open' as const, group: 0 }))
  const mode = { title: 'Big\nplan', groups: [{ id: 'g', title: 'Grp\u001b[2J' }], steps }
  const plan = sourcePlan({ ...NONE, planMode: mode }, 'plan')!
  expect(plan.tasks.length).toBe(TASKS_MAX)
  expect(plan.counts).toEqual({ done: 0, partial: 0, open: TASKS_MAX, total: TASKS_MAX })
  expect(plan.groups[0].tasks.length).toBe(TASKS_MAX)
  expect(plan.tasks[0].title).toBe('Read the file')
  expect(Array.from(plan.tasks[1].title).length).toBe(TITLE_MAX)
  expect(plan.groups[0].title).toBe('Grp')
  expect(plan.section).toBe('Big plan')
})

test('plan of a source: the task-tool list is bounded the same way, and a status past the cap does not count', async () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: String(i + 1), title: 'item\n' + i, status: i < 220 ? ('done' as const) : ('open' as const) }))
  const plan = sourcePlan({ ...NONE, tasks: items }, 'tasks')!
  expect(plan.tasks.length).toBe(TASKS_MAX)
  expect(plan.counts).toEqual({ done: TASKS_MAX, partial: 0, open: 0, total: TASKS_MAX })
  expect(plan.tasks[3].title).toBe('item 3')
  expect(tasksPlan(items).tasks.length).toBe(250) // the constructor itself is not the bound
})

test('prompt label: control characters are removed from the line', async () => {
  expect(promptLabel('Fix \u001b[31mthe\u001b[0m bug \u001b]0;x\u0007now', 'composer')).toBe('Fix the bug now')
})

test('new work: a full list is new work when fewer than half of its tasks share an id and title (any case, spacing) with the old list', async () => {
  const t = (id: string, title: string) => ({ id, title, status: 'open' as const })
  const old = { tasks: [t('1', 'Write the parser'), t('2', 'Wire the flag'), t('3', 'Add tests'), t('4', 'Docs')] }
  // the same list with a fifth task: 4 of 5 shared
  expect(isNewWork(old, { tasks: [...old.tasks, t('5', 'Release')] })).toBe(false)
  // titles compared in any case and spacing; statuses do not matter
  expect(isNewWork(old, { tasks: [t('1', 'write  the PARSER'), { ...t('2', 'Wire the flag'), status: 'done' as const }] })).toBe(false)
  // exactly half shared is not fewer than half
  expect(isNewWork(old, { tasks: [t('1', 'Write the parser'), t('2', 'other')] })).toBe(false)
  // fewer than half: 1 of 3; the same ids with other titles; nothing before
  expect(isNewWork(old, { tasks: [t('1', 'Write the parser'), t('2', 'x'), t('3', 'y')] })).toBe(true)
  expect(isNewWork(old, { tasks: [t('1', 'Plan the trip'), t('2', 'Book it')] })).toBe(true)
  expect(isNewWork(null, { tasks: [t('1', 'a')] })).toBe(true)
})

test('the approved plan file: compared after normalising; a Windows-style path in either separator and any case', async () => {
  expect(isPlanModeFile('/home/u/.claude/plans/x.md', '/home/u/.claude/plans/./x.md')).toBe(true)
  expect(isPlanModeFile('/home/u/.claude/plans/X.md', '/home/u/.claude/plans/x.md')).toBe(false)
  expect(isPlanModeFile('/home/u/.claude/plans/y.md', '/home/u/.claude/plans/x.md')).toBe(false)
  expect(isPlanModeFile('/home/u/.claude/plans/x.md', undefined)).toBe(false)
  expect(isPlanModeFile('c:/users/U/.claude/plans/X.md', 'C:\\Users\\u\\.claude\\plans\\x.md')).toBe(true)
  expect(isPlanModeFile('C:\\Users\\u\\.claude\\plans\\y.md', 'C:\\Users\\u\\.claude\\plans\\x.md')).toBe(false)
  expect(isPlanModeFile('D:\\Users\\u\\.claude\\plans\\x.md', 'C:\\Users\\u\\.claude\\plans\\x.md')).toBe(false)
})
