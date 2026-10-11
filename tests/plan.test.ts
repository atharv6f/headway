import { expect, test } from 'claude-code/testing'
import { candidateIds, parseGroupMap, parsePlan, parseTaskId } from '../hooks/plan.ts'
import type { Plan } from '../hooks/plan.ts'
import { checklistItems, isEmpty, sectionTable } from './count.ts'
import { text as checklistText } from './fixtures/release-steps.ts'
import { text as tableText } from './fixtures/check-table.ts'
import { text as tasksText } from './fixtures/release-table.ts'
import { text as boardText } from './fixtures/release-groups.ts'

function ok(r: ReturnType<typeof parsePlan>): Plan {
  if (!r.ok) throw new Error('expected a plan, got refusal: ' + r.error)
  return r.plan
}
function refused(r: ReturnType<typeof parsePlan>): string {
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}

// ---------------------------------------------------------------- fixture (a): checklist

// The file also holds prose tables; a section with checklist items ignores a table that has no
// done rule, so every task here is a checklist item. The phase sections keep Part 0 out.
const PHASES = ['A1 ', 'A2 ', 'A3 ']
function phasePlans(): Plan[] {
  return PHASES.map((s) => ok(parsePlan(checklistText, { section: s })))
}
function checklistTasks() {
  return phasePlans().flatMap((p) => p.tasks.map((t) => ({ t, p })))
}

test('fixture a: every checklist item is a task, done counted from the boxes', async () => {
  const items = checklistItems(checklistText)
  const tasks = checklistTasks()
  expect(items.length > 10).toBe(true)
  expect(tasks.length).toBe(items.length)
  expect(tasks.filter(({ t }) => t.status === 'done').length).toBe(items.filter((i) => i.checked).length)
  expect(tasks.every(({ p }) => p.partialWord === undefined)).toBe(true)
})

test('fixture a: Step n ids repeat, each occurrence its own task, grouped under Task n', async () => {
  const items = checklistItems(checklistText)
  const tasks = checklistTasks()
  const taskHeadings = checklistText.split('\n').filter((l) => /^### Task \d+:/.test(l)).length
  const step1 = tasks.filter(({ t }) => t.id === 'Step 1')
  expect(step1.length).toBe(taskHeadings)
  expect(step1.length > 1).toBe(true)
  tasks.forEach(({ t, p }, i) => {
    expect(t.groups.length).toBe(1)
    expect(p.groups[t.groups[0]].id).toBe(items[i].group as string)
    expect(t.id).toBe((items[i].text.match(/^\*\*(Step \d+)/) as RegExpMatchArray)[1])
  })
})

test('fixture a: heading groups carry the heading text after the id', async () => {
  const heads = checklistText.split('\n').filter((l) => /^### Task \d+:/.test(l))
  const used = phasePlans().flatMap((p) => p.groups.filter((g) => /^Task \d+$/.test(g.id)))
  expect(used.length).toBe(heads.length)
  used.forEach((g, i) => {
    expect(heads[i].endsWith(g.title)).toBe(true)
    expect(g.tasks.length > 0).toBe(true)
  })
})

test('fixture a: the whole file holds checklist items, so its prose tables add no tasks', async () => {
  const items = checklistItems(checklistText)
  const proseRows = checklistText.split('\n').filter((l) => l.startsWith('|')).length
  const plan = ok(parsePlan(checklistText))
  expect(proseRows > 0).toBe(true)
  expect(plan.tasks.length).toBe(items.length)
  expect(plan.noDoneRule).toBe(false)
  expect(plan.tasks.every((t) => t.shape === 'checklist')).toBe(true)
  expect(plan.counts.total).toBe(items.length)
  expect(plan.counts.done).toBe(items.filter((i) => i.checked).length)
})

test('fixture a: a section prefix picks the headings under it only', async () => {
  const plan = ok(parsePlan(checklistText, { section: 'a2 ' }))
  const lines = checklistText.split('\n')
  const s = lines.findIndex((l) => l.startsWith('## A2 '))
  let e = lines.length
  for (let i = s + 1; i < lines.length; i++) if (/^#{1,2} /.test(lines[i])) { e = i; break }
  const expected = checklistItems(lines.slice(s, e).join('\n'))
  expect(expected.length > 0).toBe(true)
  expect(plan.tasks.length).toBe(expected.length)
  expect(plan.section).toBe(lines[s].replace(/^#+ /, ''))
})

// ---------------------------------------------------------------- fixture (b): check table

test('fixture b: auto picks check on the column holding [ ]/[x] cells', async () => {
  const { rows } = sectionTable(tableText.replace(/^## /gm, '### '), 'Gates')
  const verified = rows.map((r) => r.cells['verified'])
  const plan = ok(parsePlan(tableText, { section: 'Gates' }))
  expect(plan.tasks.length).toBe(rows.length)
  expect(plan.counts.done).toBe(verified.filter((v) => /\[[xX]\]/.test(v)).length)
  expect(plan.counts.open).toBe(verified.filter((v) => !/\[[xX]\]/.test(v)).length)
  expect(plan.doneWord).toBe('verified')
  expect(plan.noDoneRule).toBe(false)
  expect(plan.tasks.map((t) => t.id)).toEqual(rows.map((r) => r.id))
  expect(plan.tasks[2].title).toBe('Signed artefacts | both formats')
})

test('fixture b: explicit check= gives the same as auto; [ ] is open', async () => {
  const a = ok(parsePlan(tableText, { section: 'Gates' }))
  const c = ok(parsePlan(tableText, { section: 'Gates', doneRule: 'check=verified' }))
  expect(c.counts).toEqual(a.counts)
  expect(c.tasks.filter((t) => t.status === 'open').length).toBe(2)
})

test('fixture b: a column named done is the fallback of auto', async () => {
  const plan = ok(parsePlan(tableText, { section: 'Later' }))
  expect(plan.tasks.map((t) => t.status)).toEqual(['done', 'open'])
  expect(plan.doneWord).toBe('done')
})

test('fixture b: the whole file holds both tables, each parsed on its own', async () => {
  const plan = ok(parsePlan(tableText))
  expect(plan.tasks.length).toBe(7)
  expect(plan.counts.done).toBe(3 + 1)
  expect(plan.tasks.map((t) => t.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7])
  expect(plan.tasks[0].groups.map((g) => plan.groups[g].id)).toEqual(['Gates'])
  expect(plan.tasks[5].groups.map((g) => plan.groups[g].id)).toEqual(['Later'])
})

// ---------------------------------------------------------------- fixture (c): generated plan

const SECTION = 'Release 2 tasks'
const RULE = { section: SECTION, doneRule: 'column=landed', partial: 'published' }

test('fixture c: landed / published / open sum to the total, computed from the cells', async () => {
  const { rows } = sectionTable(tasksText, SECTION)
  const landed = rows.filter((r) => !isEmpty(r.cells['landed'])).length
  const published = rows.filter((r) => isEmpty(r.cells['landed']) && !isEmpty(r.cells['published'])).length
  const plan = ok(parsePlan(tasksText, RULE))
  expect(plan.counts.total).toBe(rows.length)
  expect(plan.counts.done).toBe(landed)
  expect(plan.counts.partial).toBe(published)
  expect(plan.counts.open).toBe(rows.length - landed - published)
  expect(plan.counts.done + plan.counts.partial + plan.counts.open).toBe(plan.counts.total)
  expect(plan.doneWord).toBe('landed')
  expect(plan.partialWord).toBe('published')
  expect(published > 0).toBe(true)
})

test('fixture c: cells holding a dash, em dash or [ ] are open', async () => {
  const { rows } = sectionTable(tasksText, SECTION)
  const dashes = rows.filter((r) => ['-', '–', '—'].indexOf(r.cells['published']) >= 0)
  const plan = ok(parsePlan(tasksText, RULE))
  expect(dashes.length > 0).toBe(true)
  for (const r of dashes) {
    const t = plan.tasks.find((x) => x.id === r.id)
    expect(t?.status).toBe(isEmpty(r.cells['landed']) ? 'open' : 'done')
  }
})

test('fixture c: column=live gives a different done count and no partial', async () => {
  const { rows } = sectionTable(tasksText, SECTION)
  const live = rows.filter((r) => !isEmpty(r.cells['live'])).length
  const withLanded = rows.filter((r) => !isEmpty(r.cells['landed'])).length
  const plan = ok(parsePlan(tasksText, { section: SECTION, doneRule: 'column=live' }))
  expect(plan.counts.done).toBe(live)
  expect(plan.counts.partial).toBe(0)
  expect(plan.counts.open).toBe(rows.length - live)
  expect(live).not.toBe(withLanded)
  expect(plan.doneWord).toBe('live')
  expect(plan.partialWord).toBeUndefined()
})

test('fixture c: the group map replaces heading groups; unmapped rows are counted', async () => {
  const { rows } = sectionTable(tasksText, SECTION)
  const ids = new Set(rows.map((r) => r.id))
  const board = JSON.parse(boardText)
  const gm = parseGroupMap(boardText)
  if (!gm.ok) throw new Error(gm.error)
  expect(gm.groups.length).toBe(board.groups.length)
  const plan = ok(parsePlan(tasksText, RULE, gm.groups))

  let unmapped = 0
  for (const g of board.groups) for (const r of g.rows) if (!ids.has(r)) unmapped++
  expect(plan.unmapped).toBe(unmapped)
  expect(plan.unmappedIds).toContain('UI3/F2')
  expect(plan.unmappedIds).toContain('UI3/F3')

  for (const g of board.groups) {
    const pg = plan.groups.find((x) => x.kind === 'map' && x.id === g.id)
    expect(pg).toBeDefined()
    const want = rows.filter((r) => g.rows.indexOf(r.id) >= 0).map((r) => r.id)
    expect(pg!.tasks.map((i) => plan.tasks[i].id).sort()).toEqual(want.sort())
  }
})

test('fixture c: a task named by several groups appears under each; unnamed ones keep the heading group', async () => {
  const board = JSON.parse(boardText)
  const gm = parseGroupMap(boardText)
  if (!gm.ok) throw new Error(gm.error)
  const plan = ok(parsePlan(tasksText, RULE, gm.groups))
  const { rows } = sectionTable(tasksText, SECTION)
  const named = new Map<string, number>()
  for (const g of board.groups) for (const r of g.rows) named.set(r, (named.get(r) ?? 0) + 1)
  const multi = rows.find((r) => (named.get(r.id) ?? 0) > 1)
  expect(multi).toBeDefined()
  const t = plan.tasks.find((x) => x.id === multi!.id)!
  expect(t.groups.length).toBe(named.get(multi!.id))
  expect(t.groups.every((g) => plan.groups[g].kind === 'map')).toBe(true)
  const loose = rows.find((r) => !named.has(r.id))
  if (loose) {
    const lt = plan.tasks.find((x) => x.id === loose.id)!
    expect(lt.groups.length).toBe(1)
    expect(plan.groups[lt.groups[0]].kind).toBe('heading')
    expect(plan.groups[lt.groups[0]].id).toBe('Release 2 tasks (' + rows.length + ')')
  }
})

test('fixture c: without a map the table group is the section heading', async () => {
  const plan = ok(parsePlan(tasksText, RULE))
  expect(plan.groups.length).toBe(1)
  expect(plan.groups[0].id).toBe('Release 2 tasks (' + sectionTable(tasksText, SECTION).rows.length + ')')
  expect(plan.groups[0].tasks.length).toBe(plan.tasks.length)
  expect(plan.unmapped).toBe(0)
})

test('fixture c: candidate ids hold every task id and every group id, longest first', async () => {
  const gm = parseGroupMap(boardText)
  if (!gm.ok) throw new Error(gm.error)
  const plan = ok(parsePlan(tasksText, RULE, gm.groups))
  const c = candidateIds(plan)
  const { rows } = sectionTable(tasksText, SECTION)
  expect(c.taskIds.length).toBe(new Set(rows.map((r) => r.id)).size)
  for (const r of rows) expect(c.taskIds).toContain(r.id)
  for (const g of gm.groups) expect(c.groupIds).toContain(g.id)
  for (const list of [c.taskIds, c.groupIds]) {
    for (let i = 1; i < list.length; i++) expect(list[i - 1].length >= list[i].length).toBe(true)
  }
})

// ---------------------------------------------------------------- done rules and placeholders

const PLACEHOLDERS = `| task | title | landed |
|---|---|---|
| A1 | dash | - |
| A2 | en dash | – |
| A3 | em dash | — |
| A4 | box | [ ] |
| A5 | blank |  |
| A6 | real | train 4 |
| A7 | tick | [x] |
`

test('placeholders -, en dash, em dash, [ ] and blank are open under column=', async () => {
  const plan = ok(parsePlan(PLACEHOLDERS, { doneRule: 'column=landed' }))
  expect(plan.tasks.map((t) => t.status)).toEqual(['open', 'open', 'open', 'open', 'open', 'done', 'done'])
})

test('check= treats only [x]/[X] as done', async () => {
  const plan = ok(parsePlan(PLACEHOLDERS, { doneRule: 'check=landed' }))
  expect(plan.tasks.map((t) => t.status)).toEqual(['open', 'open', 'open', 'open', 'open', 'open', 'done'])
})

test('a table with no done rule counts every row open and says so', async () => {
  const plan = ok(parsePlan('| id | title |\n|---|---|\n| X1 | a |\n| X2 | b |\n'))
  expect(plan.noDoneRule).toBe(true)
  expect(plan.counts).toEqual({ done: 0, partial: 0, open: 2, total: 2 })
})

test('column names match case-insensitively; the header as written is the word', async () => {
  const text = '| Task | Title | Landed | Published |\n|---|---|---|---|\n| T1 | a | x | y |\n| T2 | b |  | y |\n| T3 | c |  |  |\n'
  const plan = ok(parsePlan(text, { doneRule: 'column=LANDED', partial: 'published' }))
  expect(plan.tasks.map((t) => t.status)).toEqual(['done', 'partial', 'open'])
  expect(plan.doneWord).toBe('Landed')
  expect(plan.partialWord).toBe('Published')
})

test('a done row is never partial', async () => {
  const text = '| task | title | landed | published |\n|---|---|---|---|\n| T1 | a | x | y |\n'
  const plan = ok(parsePlan(text, { doneRule: 'column=landed', partial: 'published' }))
  expect(plan.counts).toEqual({ done: 1, partial: 0, open: 0, total: 1 })
})

test('partial= on a missing column is refused', async () => {
  const e = refused(parsePlan(PLACEHOLDERS, { doneRule: 'column=landed', partial: 'nope' }))
  expect(e).toBe('partial column not found: nope')
})

test('partial= on a checklist is refused', async () => {
  const e = refused(parsePlan('- [ ] T1 one\n- [x] T2 two\n', { partial: 'published' }))
  expect(e).toBe('partial column not found: published')
})

test('column= or check= naming a missing column is refused', async () => {
  expect(refused(parsePlan(PLACEHOLDERS, { doneRule: 'column=ghost' }))).toBe('column not found: ghost')
  expect(refused(parsePlan(PLACEHOLDERS, { doneRule: 'check=ghost' }))).toBe('column not found: ghost')
})

test('an unknown done rule token is refused', async () => {
  expect(refused(parsePlan(PLACEHOLDERS, { doneRule: 'banana' })).length > 0).toBe(true)
})

// ---------------------------------------------------------------- prose tables and fences

test('in a section with checklist items a table with no done rule is prose and adds no tasks', async () => {
  const text = `## Work

- [x] T1 one
- [ ] T2 two

| id | note |
|---|---|
| X1 | prose |
| X2 | more prose |
`
  const plan = ok(parsePlan(text))
  expect(plan.tasks.map((t) => t.id)).toEqual(['T1', 'T2'])
  expect(plan.noDoneRule).toBe(false)
  expect(plan.counts).toEqual({ done: 1, partial: 0, open: 1, total: 2 })
})

test('prose is judged per section: the same table counts in a section with no checklist item', async () => {
  const text = `## With list

- [ ] T1 one

| id | note |
|---|---|
| X1 | prose |

## Only table

| id | note |
|---|---|
| Y1 | row |
| Y2 | row |
`
  const a = ok(parsePlan(text, { section: 'With list' }))
  expect(a.tasks.map((t) => t.id)).toEqual(['T1'])
  const b = ok(parsePlan(text, { section: 'Only table' }))
  expect(b.tasks.map((t) => t.id)).toEqual(['Y1', 'Y2'])
  expect(b.noDoneRule).toBe(true)
})

test('a table with a done rule still counts next to checklist items, wherever it sits', async () => {
  const text = `| id | note |
|---|---|
| X1 | prose first |

| id | title | done |
|---|---|---|
| T2 | row | yes |

- [ ] T1 list after
`
  const plan = ok(parsePlan(text))
  expect(plan.tasks.map((t) => t.id)).toEqual(['T2', 'T1'])
  expect(plan.noDoneRule).toBe(false)
})

test('lines inside fenced code blocks are no headings, items or tables', async () => {
  const text = `## Real

- [ ] T1 real item

\`\`\`md
## Fake heading
- [x] T9 fake item
| id | done |
|---|---|
| F1 | yes |
\`\`\`

~~~
- [x] T8 tilde item
~~~

- [x] T2 after
`
  const plan = ok(parsePlan(text))
  expect(plan.tasks.map((t) => t.id)).toEqual(['T1', 'T2'])
  expect(plan.groups.map((g) => g.id)).toEqual(['Real'])
  expect(refused(parsePlan(text, { section: 'Fake' }))).toBe('section not found: Fake')
})

test('a fence closes only on its own marker, at least as long; an unclosed fence runs to the end', async () => {
  const text = `- [ ] T1 before

\`\`\`\`
\`\`\`
- [x] T7 still inside
\`\`\`\`

~~~
\`\`\`
- [x] T6 still inside
\`\`\`
~~~

- [ ] T2 between

\`\`\`
- [x] T5 unclosed
`
  const plan = ok(parsePlan(text))
  expect(plan.tasks.map((t) => t.id)).toEqual(['T1', 'T2'])
})

test('a heading line inside a fence does not end a section', async () => {
  const text = `## A

- [ ] T1 one

\`\`\`
## B
\`\`\`

- [ ] T2 two

## C

- [ ] T3 three
`
  const plan = ok(parsePlan(text, { section: 'A' }))
  expect(plan.tasks.map((t) => t.id)).toEqual(['T1', 'T2'])
})

// ---------------------------------------------------------------- sections

const SECTIONED = `# Plan

## Alpha work

- [ ] A1 first
- [x] A2 second

### Alpha detail

- [x] A3 third

## Beta work (2)

- [ ] B1 fourth
`

test('a section matches as a case-insensitive prefix and runs to the next heading of the same or higher level', async () => {
  const alpha = ok(parsePlan(SECTIONED, { section: 'alpha' }))
  expect(alpha.tasks.map((t) => t.id)).toEqual(['A1', 'A2', 'A3'])
  expect(alpha.section).toBe('Alpha work')
  const beta = ok(parsePlan(SECTIONED, { section: 'BETA WORK' }))
  expect(beta.tasks.map((t) => t.id)).toEqual(['B1'])
  const detail = ok(parsePlan(SECTIONED, { section: 'Alpha detail' }))
  expect(detail.tasks.map((t) => t.id)).toEqual(['A3'])
})

test('a section that matches nothing is refused', async () => {
  expect(refused(parsePlan(SECTIONED, { section: 'Gamma' }))).toBe('section not found: Gamma')
})

test('a prefix is not a substring', async () => {
  expect(refused(parsePlan(SECTIONED, { section: 'work' }))).toBe('section not found: work')
})

// ---------------------------------------------------------------- groups (heading rule)

test('the group is the nearest ancestor heading with a real id; sub-headings without one are skipped', async () => {
  const text = `## A1 — Build

### Task 1: First

#### Notes

- [ ] Step 1: do it

### Task 2: Second

- [ ] Step 1: again
`
  const plan = ok(parsePlan(text))
  expect(plan.tasks.map((t) => plan.groups[t.groups[0]].id)).toEqual(['Task 1', 'Task 2'])
  expect(plan.groups[plan.tasks[0].groups[0]].title).toBe('First')
})

test('with no heading that yields an id the nearest heading is the group and its text is the id', async () => {
  const text = `# Notes

## Build

#### Details here

- [ ] one
`
  const plan = ok(parsePlan(text))
  const g = plan.groups[plan.tasks[0].groups[0]]
  expect(g.id).toBe('Details here')
})

test('a sibling heading above is not an ancestor', async () => {
  const text = `## Phase 2

### Alpha

- [ ] a

### Beta

- [ ] b
`
  const plan = ok(parsePlan(text))
  expect(plan.tasks.map((t) => plan.groups[t.groups[0]].id)).toEqual(['Phase 2', 'Phase 2'])
})

// ---------------------------------------------------------------- checklist shape

test('nested sub-items of any depth are the top-level item bar, not tasks', async () => {
  const text = `- [ ] T1 parent
  - [x] sub a
  - [ ] sub b
    - [x] deep
- [x] T2 plain
* [X] T3 star
`
  const plan = ok(parsePlan(text))
  expect(plan.tasks.map((t) => t.id)).toEqual(['T1', 'T2', 'T3'])
  expect(plan.tasks[0].sub).toEqual({ done: 2, total: 3 })
  expect(plan.tasks[0].status).toBe('open')
  expect(plan.tasks[1].sub).toBeUndefined()
  expect(plan.counts).toEqual({ done: 2, partial: 0, open: 1, total: 3 })
})

test('a mixed section holds checklist items and table rows in document order', async () => {
  const text = `- [x] T1 list one

| id | title | done |
|---|---|---|
| T2 | row | yes |
| T3 | row | |
`
  const plan = ok(parsePlan(text))
  expect(plan.tasks.map((t) => t.id)).toEqual(['T1', 'T2', 'T3'])
  expect(plan.tasks.map((t) => t.shape)).toEqual(['checklist', 'table', 'table'])
  expect(plan.counts.done).toBe(2)
})

// ---------------------------------------------------------------- ids

test('default ids: T1, A3, Step 2, Task 3, R08-25, API1', async () => {
  const cases: Array<[string, string, string]> = [
    ['T1 first thing', 'T1', 'first thing'],
    ['A3: second thing', 'A3', 'second thing'],
    ['Step 2: Run it', 'Step 2', 'Run it'],
    ['Task 3. Wire it', 'Task 3', 'Wire it'],
    ['R08-25 — a dash title', 'R08-25', 'a dash title'],
    ['API1 - hyphen title', 'API1', 'hyphen title'],
  ]
  for (const [src, id, title] of cases) {
    const p = parseTaskId(src)
    expect(p).not.toBeNull()
    expect(p!.id).toBe(id)
    expect(p!.title).toBe(title)
  }
})

test('opening ** or backticks are skipped; the closing ** leaves the title', async () => {
  expect(parseTaskId('**Step 1: Write the failing test** — a structural arm')).toEqual({
    id: 'Step 1',
    title: 'Write the failing test — a structural arm',
  })
  expect(parseTaskId('**R02-73** — case')).toEqual({ id: 'R02-73', title: 'case' })
  expect(parseTaskId('`API1` seam')).toEqual({ id: 'API1', title: 'seam' })
})

test('text without a token holding a digit has no id', async () => {
  expect(parseTaskId('Write the thing')).toBeNull()
  expect(parseTaskId('API-CORE census')).toBeNull()
  expect(parseTaskId('(2026) numbers first')).toBeNull()
})

test('an item or row with no id is #<ordinal> and the whole text is the title', async () => {
  const plan = ok(parsePlan('- [ ] T1 has one\n- [ ] Plain words here\n- [x] T3 again\n- [ ] More plain\n'))
  expect(plan.tasks.map((t) => t.id)).toEqual(['T1', '#2', 'T3', '#4'])
  expect(plan.tasks[1].title).toBe('Plain words here')
  const tbl = ok(parsePlan('| id | title | done |\n|---|---|---|\n| T1 | a | x |\n| plain | b | |\n'))
  expect(tbl.tasks.map((t) => t.id)).toEqual(['T1', '#2'])
})

test('a table title comes from the title column, else the second cell', async () => {
  const a = ok(parsePlan('| id | spec | title | done |\n|---|---|---|---|\n| T1 | 01 | the title | x |\n'))
  expect(a.tasks[0].title).toBe('the title')
  const b = ok(parsePlan('| id | what | done |\n|---|---|---|\n| T1 | the second | x |\n'))
  expect(b.tasks[0].title).toBe('the second')
})

test('candidate ids: longest first, ordinals included, task ids apart from group ids', async () => {
  const text = `## API-CORE2 program

- [ ] API1 a
- [ ] API12 b
- [ ] R08-25 c
- [ ] R08 d
- [ ] plain
`
  const plan = ok(parsePlan(text))
  const c = candidateIds(plan)
  expect(c.taskIds).toEqual(['R08-25', 'API12', 'API1', 'R08', '#5'])
  expect(c.groupIds).toEqual(['API-CORE2'])
})

// ---------------------------------------------------------------- group map reader

test('the group map reader takes id, rows and title, and ignores every other key', async () => {
  const r = parseGroupMap(JSON.stringify({ meta: { x: 1 }, groups: [{ id: 'UI1', title: 'One', rows: ['T1', 'T2'], lane: 'x', after: ['API1'] }, { id: 'UI2', rows: [] }], held: [] }))
  if (!r.ok) throw new Error(r.error)
  expect(r.groups).toEqual([{ id: 'UI1', title: 'One', rows: ['T1', 'T2'] }, { id: 'UI2', rows: [] }])
})

test('a group map without groups[] or with a bad entry is refused', async () => {
  for (const bad of ['not json', '{}', '{"groups": 3}', '{"groups":[{"id":4,"rows":[]}]}', '{"groups":[{"id":"A","rows":"T1"}]}']) {
    const r = parseGroupMap(bad)
    expect(r.ok).toBe(false)
  }
})

// ---------------------------------------------------------------- batch B: CRLF and parser edges

test('CRLF and lone CR line endings parse like LF: checklist, headings, tables', async () => {
  const lf = `## Work

- [x] T1 one
- [ ] T2 two

## Table

| id | title | done |
|---|---|---|
| T3 | three | x |
| T4 | four | |
`
  for (const eol of ['\r\n', '\r']) {
    const a = ok(parsePlan(lf))
    const b = ok(parsePlan(lf.replace(/\n/g, eol)))
    expect(b.tasks.map((t) => [t.id, t.title, t.status, t.line])).toEqual(a.tasks.map((t) => [t.id, t.title, t.status, t.line]))
    expect(b.groups.map((g) => g.title)).toEqual(a.groups.map((g) => g.title))
    const s = ok(parsePlan(lf.replace(/\n/g, eol), { section: 'Table' }))
    expect(s.counts).toEqual({ done: 1, partial: 0, open: 1, total: 2 })
  }
})

test('inline code that starts with three backticks never opens a fence', async () => {
  const text = '```js``` is a code span here\n\n- [ ] T1 one\n- [x] T2 two\n'
  expect(ok(parsePlan(text)).tasks.length).toBe(2)
  const text2 = 'See ```x``` and\n\n## Group\n\n- [ ] T1 one\n'
  expect(ok(parsePlan(text2)).tasks.length).toBe(1)
})

test('a fence opener is at most three spaces in, and a real fence still hides its lines', async () => {
  const fenced = '```\n- [ ] T1 hidden\n```\n- [ ] T2 shown\n'
  expect(ok(parsePlan(fenced)).tasks.map((t) => t.id)).toEqual(['T2'])
  const tilde = '   ~~~ txt\n- [ ] T1 hidden\n~~~\n- [ ] T2 shown\n'
  expect(ok(parsePlan(tilde)).tasks.map((t) => t.id)).toEqual(['T2'])
  const mid = 'text ``` not a fence\n- [ ] T1 shown\n'
  expect(ok(parsePlan(mid)).tasks.map((t) => t.id)).toEqual(['T1'])
})

test('a bare --- under a line with a pipe is a thematic break, not a table rule', async () => {
  const text = 'a | b\n---\n| T9 | nine |\n\n- [ ] T1 one\n'
  const plan = ok(parsePlan(text))
  expect(plan.tasks.map((t) => t.id)).toEqual(['T1'])
})

test('a table needs a pipe in its header row and a pipe in its delimiter row', async () => {
  const noHeaderPipe = 'Title\n|---|\n| T1 | one |\n'
  expect(ok(parsePlan(noHeaderPipe)).tasks.length).toBe(0)
  const bare = '| id | title |\n---\n| T1 | one |\n'
  expect(ok(parsePlan(bare)).tasks.length).toBe(0)
  const one = '| id |\n|---|\n| T1 |\n'
  expect(ok(parsePlan(one)).tasks.map((t) => t.id)).toEqual(['T1'])
  const aligned = 'id | title\n:-- | --:\nT1 | one\n'
  expect(ok(parsePlan(aligned)).tasks.map((t) => t.id)).toEqual(['T1'])
})

test('closing hashes are stripped from ATX headings', async () => {
  const text = '## Phase A ##\n\n- [ ] T1 one\n\n## C# ##\n\n- [ ] T2 two\n\n### Step 3 ###   \n\n- [ ] x\n'
  const plan = ok(parsePlan(text))
  expect(plan.groups.map((g) => g.id)).toEqual(['Phase A', 'C#', 'Step 3'])
  expect(ok(parsePlan('## Phase A ##\n\n- [ ] T1\n', { section: 'Phase A' })).section).toBe('Phase A')
  expect(ok(parsePlan('## C# ##\n- [ ] T1\n', { section: 'c#' })).section).toBe('C#')
})

test('the two-word ID form applies only to Step, Task, Phase, Stage, Part, Milestone and Item', async () => {
  expect(parseTaskId('Add 2 fields')).toBeNull()
  expect(parseTaskId('Update 3 files')).toBeNull()
  expect(parseTaskId('Step 2 build')).toEqual({ id: 'Step 2', title: 'build' })
  for (const w of ['task', 'PHASE', 'Stage', 'Part', 'milestone', 'Item']) {
    expect(parseTaskId(w + ' 4: go')).toEqual({ id: w + ' 4', title: 'go' })
  }
  const plan = ok(parsePlan('- [ ] Add 2 fields\n- [ ] Step 1 real\n'))
  expect(plan.tasks.map((t) => t.id)).toEqual(['#1', 'Step 1'])
})
