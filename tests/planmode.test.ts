import { expect, test } from 'claude-code/testing'
import { parsePlanMode } from '../hooks/planmode.ts'
import { TASKS_MAX, TITLE_MAX } from '../hooks/format.ts'
import type { PlanMode } from '../hooks/planmode.ts'
import { planModeSteps } from './count.ts'
import { text as bullets } from './fixtures/plan-bullets.ts'
import { text as phases } from './fixtures/plan-phases.ts'
import { text as nested } from './fixtures/plan-nested.ts'

// The plan-mode parser (SPEC 4.4) on the three synthetic plan shapes, against the independent counter.
const groupId = (p: PlanMode, i: number) => p.groups[p.steps[i].group].id
const children = (p: PlanMode) => p.steps.map((s) => s.sub?.total ?? 0)

test('plan-bullets: the heading steps outside the meta sections, their bullets as children; Context, Files, Notes, prose and fences add none', async () => {
  const want = planModeSteps(bullets)
  const p = parsePlanMode(bullets)
  // a counter that finds nothing cannot pass
  expect(want.steps.length).toBeGreaterThan(0)
  expect(p.steps.length).toBe(want.steps.length)
  expect(p.steps.map((s) => s.id)).toEqual(['Script', 'Tests', 'Checks'])
  expect(p.steps.map((s) => s.title)).toEqual(['Script', 'Tests', 'Checks'])
  expect(children(p)).toEqual(want.steps.map((s) => s.children))
  expect(p.steps.every((s) => s.status === 'open' && s.sub?.done === 0)).toBe(true)
  expect(p.title).toBe('Greeting script with a flag')
  expect(p.title).toBe(want.title)
  // heading steps sit under the plan's own group, named after its title
  expect(p.groups.map((g) => g.id)).toEqual(['Greeting script with a flag'])
})

test('plan-phases: twelve numbered steps continue across phase headings, each under its phase', async () => {
  const want = planModeSteps(phases)
  const p = parsePlanMode(phases)
  expect(want.steps.length).toBe(12)
  expect(p.steps.length).toBe(want.steps.length)
  expect(p.steps.map((s) => s.id)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)))
  expect(p.steps.map((_, i) => groupId(p, i))).toEqual(want.steps.map((s) => s.group))
  expect(p.groups).toEqual([
    { id: 'Phase 1', title: 'Setup' },
    { id: 'Phase 2', title: 'Core' },
    { id: 'Phase 3', title: 'Docs' },
    { id: 'Phase 4', title: 'Checks' },
  ])
  expect(p.steps[2].title).toBe('Write count.py that reads stdin.')
  expect(p.steps.every((s) => s.sub === undefined)).toBe(true)
})

test('plan-nested: four top-level steps, every deeper numbered or bulleted line in its bar', async () => {
  const want = planModeSteps(nested)
  const p = parsePlanMode(nested)
  expect(want.steps.length).toBe(4)
  expect(p.steps.length).toBe(want.steps.length)
  expect(p.steps.map((s) => s.id)).toEqual(['1', '2', '3', '4'])
  expect(p.steps.map((s) => s.title)).toEqual(['Make the folder', 'Write an index', 'Add a lint script', 'Verify'])
  expect(children(p)).toEqual(want.steps.map((s) => s.children))
  expect(p.steps[2].sub).toEqual({ done: 0, total: 5 })
  expect(p.groups).toEqual([{ id: 'Checklist', title: 'Checklist' }])
  expect(p.title).toBe('Tidy the notes folder')
})

test('shape precedence: checklist before numbered before headings; checklist sub-items are the parent bar; IDs by token, else the ordinal', async () => {
  const p = parsePlanMode(`# Plan: Mixed\n\n## Work\n- [ ] A1 Parse the input\n  - [x] read\n  - [ ] split\n- [ ] Wire the flag\n- [ ] Ship\n\n1. a numbered line\n2. another\n3. a third\n4. a fourth\n`)
  expect(p.steps.map((s) => s.id + ':' + s.title)).toEqual(['A1:Parse the input', '2:Wire the flag', '3:Ship'])
  expect(p.steps[0].sub).toEqual({ done: 1, total: 2 })
  expect(p.steps.every((s) => s.status === 'open')).toBe(true)
  expect(p.groups).toEqual([{ id: 'Work', title: 'Work' }])
  // one checklist item outranks numbered lines; numbered lines outrank more heading steps
  expect(parsePlanMode(`# Plan: T\n\n## Work\n- [ ] one\n\n1. first\n2. second\n`).steps.map((s) => s.title)).toEqual(['one'])
  const n = parsePlanMode(`# Plan: T\n\n## Build\n- compile\n\n## Ship\n- tag\n\n## Docs\n- write\n\n## Steps\n1. first\n`)
  expect(n.steps.map((s) => s.title)).toEqual(['first'])
  expect(parsePlanMode(`# Plan: T\n\n## Build\n- compile\n\n## Ship\n- tag\n`).steps.map((s) => s.id)).toEqual(['Build', 'Ship'])
})

test('meta sections: reviewer case (a), numbered steps beside bullet headings Critical files, Risks, Out of scope, Verification', async () => {
  const p = parsePlanMode(`# Plan: A\n\n## Steps\n1. write the parser\n2. wire the flag\n3. add the test\n\n## Critical files\n- hooks/a.ts\n- hooks/b.ts\n\n## Risks\n- slow\n\n## Out of scope\n- docs\n\n## Verification\n- run the tests\n- read the diff\n`)
  expect(p.steps.map((s) => s.id + ':' + s.title)).toEqual(['1:write the parser', '2:wire the flag', '3:add the test'])
  expect(p.groups.map((g) => g.id)).toEqual(['Steps'])
})

test('meta sections: reviewer case (b), explicit A1/A2 checkboxes beside bullet headings Notes, Risks and Out', async () => {
  const p = parsePlanMode(`# Plan: B\n\n## Phase A\n- [ ] A1 parse the input\n- [ ] A2 wire the flag\n\n## Notes\n- keep it small\n\n## Risks\n- none known\n\n## Out\n- the docs\n`)
  expect(p.steps.map((s) => s.id + ':' + s.title)).toEqual(['A1:parse the input', 'A2:wire the flag'])
  expect(p.groups.map((g) => g.id)).toEqual(['Phase A'])
})

test('meta sections: a stray checkbox under ## Verification does not displace numbered steps; nor one under ## Notes heading steps', async () => {
  const p = parsePlanMode(`# Plan: Rename\n\n## Steps\n1. rename the file\n2. update the imports\n3. run the tests\n\n## Verification\n- [ ] remember to tell the team\n`)
  expect(p.steps.map((s) => s.id + ':' + s.title)).toEqual(['1:rename the file', '2:update the imports', '3:run the tests'])
  const h = parsePlanMode(`# Plan: H\n\n## Build\n- a.txt\n- b.txt\n\n## Script\n- prints\n\n## Notes\n- [ ] maybe later\n`)
  expect(h.steps.map((s) => s.id)).toEqual(['Build', 'Script'])
})

test('meta sections: every listed heading in any case, numbering and punctuation stripped, is left out with everything under it', async () => {
  const META = ['Context', 'Background', 'Summary', 'Overview', 'Goal', 'Goals', 'Files', 'Critical files', 'Key files', 'Risks', 'Risk', 'Out of scope', 'Non-goals', 'Notes', 'Open questions', 'Questions', 'Alternatives', 'Assumptions', 'Dependencies', 'Verification', 'Testing', 'Test plan', 'Acceptance', 'Acceptance criteria', 'Done when', 'Rollback', 'References']
  for (const heading of META) {
    for (const written of [heading, heading.toUpperCase(), '3. ' + heading + ':', '**' + heading.toLowerCase() + '**']) {
      const p = parsePlanMode(`# Plan: M\n\n## ${written}\n- [ ] meta item\n1. meta number\n### Under it\n- meta bullet\n\n## Do\n1. real step\n`)
      expect(heading + '=' + p.steps.map((s) => s.title).join('|')).toBe(heading + '=real step')
    }
  }
  // a heading that only starts with a listed word is not a meta section
  const q = parsePlanMode(`# Plan: Q\n\n## Files to write\n- [ ] the parser\n\n## Do\n1. real step\n`)
  expect(q.steps.map((s) => s.title)).toEqual(['the parser'])
})

test('meta sections: with no step outside them, the same precedence runs over the whole body including them', async () => {
  const r = parsePlanMode(`# Plan: Only checks\n\n## Context\nprose\n\n## Verification\n- [ ] run the tests\n- [ ] read the diff\n\n## Notes\n1. a number\n`)
  expect(r.steps.map((s) => s.title)).toEqual(['run the tests', 'read the diff'])
  const s2 = parsePlanMode('# Plan: Hidden\n\n## Summary\n- one\n- two\n\n## Background\n1. three\n')
  expect(s2.steps.map((s) => s.title)).toEqual(['three'])
  const h = parsePlanMode('# Plan: Hidden\n\n## Files\n- a\n\n## Risks\n- b\n')
  expect(h.steps.map((s) => s.id)).toEqual(['Files', 'Risks'])
})

test('meta sections: reviewer case (c), Step headings holding only prose are the steps, not a numbered Verification list', async () => {
  const p = parsePlanMode(`# Plan: C\n\n## Steps\n\n### Step 1\nWrite the parser so it reads stdin.\n\n### Step 2\nWire the flag into main.\n\n## Verification\n1. run the tests\n2. read the diff\n`)
  expect(p.steps.map((s) => s.id + ':' + s.title + ':' + (s.sub?.total ?? 0))).toEqual(['Step 1:Step 1:0', 'Step 2:Step 2:0'])
  expect(p.groups.map((g) => g.id)).toEqual(['Steps'])
})

test('id-headings: a ## to #### heading with a real id is a step though it holds only prose; it comes after headings of bullets', async () => {
  const p = parsePlanMode(`# Plan: I\n\n## 1. Write the parser\nIt reads stdin.\n\n## 2) Wire the flag\nInto main.\n\n### A3 Ship it\nTag and push.\n\n## Task 4: Announce\nOne post.\n\n## Later\nProse only, no id: not a step.\n\n##### Step 9\ntoo deep\n`)
  expect(p.steps.map((s) => s.id + ':' + s.title + ':' + (s.sub?.total ?? 0))).toEqual(['1:Write the parser:0', '2:Wire the flag:0', 'A3:Ship it:0', 'Task 4:Announce:0'])
  // one heading of bullets outranks them
  const q = parsePlanMode(`# Plan: I\n\n## Step 1\nprose\n\n## Step 2\nprose\n\n## Build\n- compile\n`)
  expect(q.steps.map((s) => s.id)).toEqual(['Build'])
  // the whole-body fallback runs only when all four shapes find nothing outside the meta sections
  const r = parsePlanMode(`# Plan: I\n\n## Step 1\nprose\n\n## Verification\n- [ ] run it\n`)
  expect(r.steps.map((s) => s.id)).toEqual(['Step 1'])
})

test('shape order: numbered lines win over headings of bullets', async () => {
  const p = parsePlanMode(`# Plan: Both\n\n## Build\n- a.txt\n- b.txt\n\n## Steps\n1. write a\n2. write b\n`)
  expect(p.steps.map((s) => s.id + ':' + s.title)).toEqual(['1:write a', '2:write b'])
  expect(p.groups.map((g) => g.id)).toEqual(['Steps'])
})

test('heading steps: a heading token is the ID; deeper headings and prose-only headings follow the rule', async () => {
  const p = parsePlanMode(`# Plan: Tokens\n\n## Step 2: Build\n- compile\n\n## Later\nOnly prose.\n\n### Deploy\n* push\n* tag\n\n##### Too deep\n- not a step\n`)
  expect(p.steps.map((s) => s.id + '|' + s.title + '|' + (s.sub?.total ?? 0))).toEqual(['Step 2|Build|1', 'Deploy|Deploy|2'])
  // Deploy sits under Later; the nearest ancestor heading is its group
  expect(groupId(p, 1)).toBe('Later')
  expect(groupId(p, 0)).toBe('Tokens')
})

test('no steps under any shape: prose or fenced lines alone give an empty plan', async () => {
  expect(parsePlanMode('# Plan: Talk\n\nJust a paragraph about the idea.\n').steps).toEqual([])
  expect(parsePlanMode('# Plan: Talk\n\n## Context\nJust a paragraph.\n').steps).toEqual([])
  expect(parsePlanMode('# Plan: Fenced\n\n```\n- [ ] x\n1. y\n```\n').steps).toEqual([])
  expect(parsePlanMode('').steps).toEqual([])
})

test('title: the first # heading, a Plan: prefix dropped in any case; none without a # heading', async () => {
  expect(parsePlanMode('# PLAN:  Ship the thing\n1. a\n').title).toBe('Ship the thing')
  expect(parsePlanMode('# Planning notes\n1. a\n').title).toBe('Planning notes')
  expect(parsePlanMode('## Steps\n1. a\n').title).toBe(undefined)
  expect(parsePlanMode('# Plan: Late\n\n# Second\n1. a\n').title).toBe('Late')
})

test('reader: CRLF line endings, a multi-line item titled by its first line, a skipped section ending at the next heading of its level', async () => {
  const p = parsePlanMode('# Plan: Lines\r\n\r\n## Context\r\n1. skipped\r\n### Inside context\r\n2. skipped too\r\n## Do\r\n1. first line\r\n   continued here\r\n2. second\r\n')
  expect(p.steps.map((s) => s.id + ':' + s.title)).toEqual(['1:first line', '2:second'])
  expect(p.title).toBe('Lines')
})

test('numbering that restarts under phase headings: every numbered id becomes <phase ordinal>.<n>; the title stays the item text', async () => {
  const p = parsePlanMode(`# Plan: Two phases\n\n## Phase 1: Setup\n1. make the folder\n2. write the config\n\n## Phase 2: Build\n1. write the script\n2. add a test\n`)
  expect(p.steps.map((s) => s.id + ':' + s.title)).toEqual(['1.1:make the folder', '1.2:write the config', '2.1:write the script', '2.2:add a test'])
  expect(p.steps.map((_, i) => groupId(p, i))).toEqual(['Phase 1', 'Phase 1', 'Phase 2', 'Phase 2'])
  // numbers that never repeat stay as written
  expect(parsePlanMode(`# Plan: P\n\n## A\n1. a\n2. b\n\n## B\n3. c\n`).steps.map((s) => s.id)).toEqual(['1', '2', '3'])
  // steps under no heading take the first ordinal
  expect(parsePlanMode(`# Plan: P\n\n1. a\n2. b\n\n## Later\n1. c\n`).steps.map((s) => s.id)).toEqual(['1.1', '1.2', '2.1'])
})

test('inline markdown: bold, italic, code and links are stripped from step, group and plan titles; ids keep their rules', async () => {
  const p = parsePlanMode('# Plan: **Ship** the `parser`\n\n## 1. Do it\n\n1. **Write the parser**\n2. Run `npm test` and *check* [the docs](https://x.io/a_b) now\n3. Keep 2 * 3 and snake_case_name as written\n')
  expect(p.title).toBe('Ship the parser')
  expect(p.steps.map((s) => s.title)).toEqual(['Write the parser', 'Run npm test and check the docs now', 'Keep 2 * 3 and snake_case_name as written'])
  expect(p.steps.map((s) => s.id)).toEqual(['1', '2', '3'])
  // a checklist step with a bold id keeps the 4.2 token rule
  const c = parsePlanMode('# Plan: P\n\n- [ ] **A3** Ship the `thing`\n- [ ] __Plain__ step\n')
  expect(c.steps.map((s) => s.id + ':' + s.title)).toEqual(['A3:Ship the thing', '2:Plain step'])
  // a heading group is titled without markdown
  const g = parsePlanMode('# Plan: P\n\n## **Phase 2**: *Core*\n1. a\n')
  expect(g.groups.map((x) => x.title)).toEqual(['Core'])
  expect(g.steps.map((s) => s.title)).toEqual(['a'])
})

test('numbered headings that repeat under phase headings: ids become <phase>.<n>; unique numbers stay as written', async () => {
  const p = parsePlanMode('# Plan: Two phases\n\n## Phase 1\n\n### 1. Write\nprose\n\n### 2. Test\nprose\n\n## Phase 2\n\n### 1. Write\nmore\n\n### 2. Test\nmore\n')
  expect(p.steps.map((s) => s.id + ':' + s.title)).toEqual(['Phase 1:Phase 1', '1.1:Write', '1.2:Test', 'Phase 2:Phase 2', '2.1:Write', '2.2:Test'])
  const once = parsePlanMode('# Plan: P\n\n## Phase 1\n\n### 1. Write\nprose\n\n## Phase 2\n\n### 2. Test\nprose\n')
  expect(once.steps.map((s) => s.id)).toEqual(['Phase 1', '1', 'Phase 2', '2'])
})

test('ingest caps: a 1000-character title, step titles and heading ids are one clean line of TITLE_MAX; at most TASKS_MAX steps', async () => {
  const p = parsePlanMode('# Plan: ' + 'T'.repeat(1000) + '\n\n## ' + 'H'.repeat(500) + '\n- a bullet\n\n## Steps\n1. ' + 's'.repeat(1000) + '\n2. tab\there \u001b[1mbold\u001b[0m\n')
  expect(p.title!.length).toBeLessThanOrEqual(TITLE_MAX)
  expect(p.steps[0].title.length).toBeLessThanOrEqual(TITLE_MAX)
  expect(p.steps[1].title).toBe('tab here bold')
  const h = parsePlanMode('# Plan: H\n\n## ' + 'H'.repeat(500) + '\n- a\n- b\n')
  expect(h.steps[0].id.length).toBeLessThanOrEqual(TITLE_MAX)
  expect(h.groups.every((g) => g.id.length <= TITLE_MAX && g.title.length <= TITLE_MAX)).toBe(true)
  const many = parsePlanMode('# Plan: Many\n\n' + Array.from({ length: 300 }, (_, i) => i + 1 + '. step ' + i).join('\n') + '\n')
  expect(many.steps.length).toBe(TASKS_MAX)
})
