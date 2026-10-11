import { expect, mock, test } from 'claude-code/testing'
import { buildTree } from '../hooks/agents.ts'
import type { AgentRecord, LogEntry } from '../hooks/agents.ts'
import { agentRows, bodyRows, DEFAULT_UI, logRows, planView, rowText, rowWidth, usageRows } from '../hooks/pane.tsx'
import { modelEffort } from '../hooks/display.ts'
import { reportPlan, stateBlock } from '../hooks/tool.ts'
import { modePlan } from '../hooks/sources.ts'
import { parsePlanMode } from '../hooks/planmode.ts'
import type { PaneData, PaneRow, Tab, UiState } from '../hooks/pane.tsx'
import { parseGroupMap, parsePlan } from '../hooks/plan.ts'
import type { Plan } from '../hooks/plan.ts'
import { text as tasksText } from './fixtures/release-table.ts'
import { text as boardText } from './fixtures/release-groups.ts'
import { userCommand } from './world.ts'

const NOW = 1_000_000_000
const MIN = 60_000

const PLAN_TEXT = `
## Plan

### UI3 One dark-mode toggle placement

| Task | Title | landed | published |
| --- | --- | --- | --- |
| R02-40 | its Done greps red today | | |
| R02-41 | ParseThemeURN refuses theme://.../session: | | x |
| R02-39 | the toggle row's version | | |
| R02-73 | toggle_default.json case | x | |

### API1 Endpoint census

| Task | Title | landed | published |
| --- | --- | --- | --- |
| R03-1 | list the endpoints | | |
| R03-2 | count the endpoints | x | |

### UI1 One tag colour, one digest

| Task | Title | landed | published |
| --- | --- | --- | --- |
| R04-1 | digest the result | | |
`

function planOf(text: string, opts: { doneRule?: string; partial?: string } = {}): Plan {
  const r = parsePlan(text, { section: 'Plan', doneRule: 'column=landed', partial: 'published', ...opts })
  if (!r.ok) throw new Error(r.error)
  return r.plan
}
const PLAN = planOf(PLAN_TEXT)

function agent(over: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    description: 'a task',
    subagentType: 'acme:implementer',
    taskIds: [],
    role: 'implementer',
    status: 'running',
    spawnedAt: NOW - 6 * MIN,
    steps: 3,
    tokens: { in: 42_100, out: 3200, cacheRead: 310_000, cacheWrite: 12_000 },
    estUsd: 0,
    warnings: [],
    agentId: over.id,
    ...over,
  }
}

const AGENTS: AgentRecord[] = [
  agent({ id: 'a7f1aaaa', taskIds: ['R02-40'], groupId: 'UI3', model: 'claude-opus-5-5', effort: 'high', lastStepAt: NOW - 20_000, firstStepAt: NOW - 6 * MIN }),
  agent({ id: '5e11bbbb', taskIds: ['R02-40'], groupId: 'UI3', role: 'scout', model: 'claude-sonnet-5-5', effort: 'high', status: 'stalled', stalledAt: NOW - MIN, lastStepAt: NOW - 14 * MIN, spawnedAt: NOW - 18 * MIN }),
  agent({ id: '4b7dcccc', taskIds: ['R02-40'], groupId: 'UI3', role: 'hand', model: 'claude-opus-5-5', effort: 'low', status: 'done', warnings: ['R1'], spawnedAt: NOW - 30 * MIN, endedAt: NOW - 29 * MIN, durationMs: 65_000, lastStepAt: NOW - 29 * MIN }),
  agent({
    id: 'c3e9dddd', taskIds: [], groupId: 'UI3', status: 'blocked', question: 'which toggle placement holds the dark default and why is it the one we want here', endedAt: NOW - 2 * MIN,
    model: 'claude-opus-5-5', effort: 'high', spawnedAt: NOW - 12.5 * MIN, durationMs: 12.5 * MIN,
  }),
  agent({ id: '9c02eeee', taskIds: ['R03-1'], groupId: 'API1', role: 'scout', status: 'stalled', model: 'claude-sonnet-5-5', effort: 'high', lastStepAt: NOW - 14 * MIN, spawnedAt: NOW - 18 * MIN }),
  agent({ id: 'q111ffff', taskIds: ['R04-1'], groupId: 'UI1', role: 'runner', status: 'queued', spawnedAt: NOW - 5000, steps: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }),
  agent({ id: '1d20gggg', taskIds: [], role: 'runner', subagentType: 'acme:runner', status: 'failed', reason: 'error', model: 'claude-sonnet-5-5', effort: 'low', spawnedAt: NOW - 60 * MIN, endedAt: NOW - 59 * MIN, durationMs: 40_000 }),
]

const UI3_ONLY = AGENTS.filter((a) => a.groupId === 'UI3')

const LOG: LogEntry[] = [
  { at: NOW, kind: 'done', ref: 'R02-73', role: 'implementer', durationMs: 252_000, estUsd: 0.42 },
  { at: NOW - 1000, kind: 'blocked', ref: 'UI3', role: 'implementer', detail: 'which toggle placement holds the dark default' },
  { at: NOW - 2000, kind: 'stalled', ref: 'API1', role: 'scout', detail: 'no step for 10m' },
  { at: NOW - 3000, kind: 'task-done', ref: 'R02-41', detail: 'landed (plan changed)' },
  { at: NOW - 4000, kind: 'task-partial', ref: 'R02-42', detail: 'published (plan changed)' },
  { at: NOW - 5000, kind: 'pin', ref: '', detail: 'tracking release-table.md § Release 2 tasks  column=landed' },
]

const GOAL = {
  label: 'Plan',
  done: PLAN.counts.done,
  partial: PLAN.counts.partial,
  open: PLAN.counts.open,
  total: PLAN.counts.total,
  doneWord: PLAN.doneWord,
  partialWord: PLAN.partialWord,
}

function data(over: Partial<PaneData> = {}): PaneData {
  const agents = over.agents ?? AGENTS
  return {
    columns: 100,
    ascii: false,
    now: NOW,
    ui: { ...DEFAULT_UI },
    goal: GOAL,
    tree: buildTree(PLAN, agents),
    agents,
    log: LOG,
    usage: null,
    ...over,
  }
}

const texts = (rows: PaneRow[]) => rows.map(rowText)
const withUi = (u: Partial<UiState>): UiState => ({ ...DEFAULT_UI, ...u })
const find = (rows: PaneRow[], re: RegExp) => texts(rows).find((t) => re.test(t))
const indexOfRow = (rows: PaneRow[], re: RegExp) => texts(rows).findIndex((t) => re.test(t))

// ---------------------------------------------------------------- Plan tab

test('plan tab: goal line first, then the groups and unmapped summary', async () => {
  const { rows } = planView(data())
  const t = texts(rows)
  expect(t[0]).toContain('Plan')
  expect(t[0]).toContain('landed 2 · published 1 · open 4 / 7')
  expect(t[1]).toContain('3 groups')
  expect(t[1]).toContain('3 active')
  expect(t[1]).not.toContain('unmapped')
})

test('plan tab: the Release 2 footer names the groups and the unmapped rows, counted from the parse', async () => {
  const gm = parseGroupMap(boardText)
  if (!gm.ok) throw new Error(gm.error)
  const r = parsePlan(tasksText, { section: 'Release 2 tasks', doneRule: 'column=landed', partial: 'published' }, gm.groups)
  if (!r.ok) throw new Error(r.error)
  const plan = r.plan
  expect(plan.unmapped).toBeGreaterThan(0)
  const d = data({
    agents: [],
    tree: buildTree(plan, []),
    goal: { label: 'Release 2 tasks', done: plan.counts.done, partial: plan.counts.partial, open: plan.counts.open, total: plan.counts.total, doneWord: plan.doneWord, partialWord: plan.partialWord },
  })
  const t = texts(planView(d).rows)
  expect(t[1]).toContain(plan.groups.length + ' groups')
  expect(t[1]).toContain(plan.unmapped + ' unmapped rows')
})

test('plan tab: one unmapped row is singular', async () => {
  const plan = { ...PLAN, unmapped: 1 }
  const t = texts(planView(data({ tree: buildTree(plan, AGENTS) })).rows)
  expect(t[1]).toContain('1 unmapped row')
  expect(t[1]).not.toContain('1 unmapped rows')
})

test('plan tab: loud groups first, then active, then queued; counts are agents or tasks', async () => {
  const t = texts(planView(data()).rows)
  const ui3 = indexOfRow(planView(data()).rows, /UI3 +One dark-mode/)
  const api1 = indexOfRow(planView(data()).rows, /API1 +Endpoint census/)
  const ui1 = indexOfRow(planView(data()).rows, /UI1 +One tag colour/)
  expect(ui3).toBeGreaterThan(1)
  expect(api1).toBeGreaterThan(ui3)
  expect(ui1).toBeGreaterThan(api1)
  // UI3 has 4 agents, 1 done and 1 blocked (finished 2); API1 has 1 stalled; UI1 has 1 queued
  expect(t[ui3]).toContain('2/4 agents')
  expect(t[ui3]).toContain('⊘ 1 blocked')
  expect(t[ui3]).toContain('◌ 1 stalled')
  expect(t[api1]).toContain('0/1 agents')
  expect(t[api1]).toContain('◌ 1 stalled')
  expect(t[ui1]).toContain('0/1 agents')
})

test('plan tab: a group without agents counts its tasks', async () => {
  const t = texts(planView(data({ agents: [], tree: buildTree(PLAN, []) })).rows)
  expect(t.some((x) => /UI3 +One dark-mode.*1\/4 tasks/.test(x))).toBe(true)
  expect(t.some((x) => /UI1 +One tag colour.*0\/1 tasks/.test(x))).toBe(true)
})

test('plan tab: active groups and tasks start expanded, the rest collapsed', async () => {
  const { rows } = planView(data())
  const t = texts(rows)
  // UI3 is expanded: its tasks, the task's agents and the group-named agent are drawn
  expect(t.some((x) => /● +R02-40 +its Done greps/.test(x))).toBe(true)
  expect(t.some((x) => /● a7f1 +implementer +opus\/high/.test(x))).toBe(true)
  expect(t.some((x) => /◌ 5e11 +scout +sonnet\/high/.test(x))).toBe(true)
  expect(t.some((x) => /⚠ ✓ 4b7d +hand/.test(x))).toBe(true)
  expect(t.some((x) => /⊘ c3e9/.test(x))).toBe(true)
  // UI1 is queued with one queued agent: its row is a group row, collapsed? it is active (unfinished agent)
  // a done task sorts last in its group
  const iDone = indexOfRow(rows, /✓ +R02-73/)
  const iOpen = indexOfRow(rows, /○ +R02-39/)
  expect(iDone).toBeGreaterThan(iOpen)
})

test('plan tab: task order is active, partial, queued, done; a partial task shows its column word', async () => {
  const { rows } = planView(data())
  const order = ['R02-40', 'R02-41', 'R02-39', 'R02-73'].map((id) => indexOfRow(rows, new RegExp(' ' + id + ' ')))
  expect(order.every((i) => i > 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  const partial = find(rows, /◐ +R02-41/)
  expect(partial).toContain('published')
})

test('plan tab: expand state overrides the default, per row', async () => {
  const agents = UI3_ONLY
  const base = planView(data({ agents, tree: buildTree(PLAN, agents) }))
  const keys = base.keys
  expect(keys.length).toBeGreaterThan(3)
  // UI3 has agents in flight and is open; API1 and UI1 have none and are closed
  expect(find(base.rows, /R02-40/)).toBeDefined()
  expect(find(base.rows, /R03-1/)).toBeUndefined()
  const ui3Key = keys.find((k) => k.startsWith('g:UI3'))!
  const collapsed = planView(data({ agents, tree: buildTree(PLAN, agents), ui: withUi({ open: { [ui3Key]: false } }) }))
  expect(collapsed.rows.length).toBeLessThan(base.rows.length)
  expect(find(collapsed.rows, /R02-40/)).toBeUndefined()
  expect(find(collapsed.rows, /UI3 +One dark-mode/)).toContain('▸')
  expect(find(base.rows, /UI3 +One dark-mode/)).toContain('▾')
  const api1Key = keys.find((k) => k.startsWith('g:API1'))!
  const opened = planView(data({ agents, tree: buildTree(PLAN, agents), ui: withUi({ open: { [api1Key]: true } }) }))
  expect(find(opened.rows, /R03-1/)).toBeDefined()
  expect(find(opened.rows, /API1 +Endpoint census/)).toContain('▾')
})

test('plan tab: a task with agents is a row of its own that opens and closes', async () => {
  const agents = UI3_ONLY
  const base = planView(data({ agents, tree: buildTree(PLAN, agents) }))
  const taskKey = base.keys.find((k) => k.startsWith('t:UI3/R02-40'))!
  expect(taskKey).toBeDefined()
  expect(base.rows.some((r) => r.press?.key === taskKey)).toBe(true)
  const shut = planView(data({ agents, tree: buildTree(PLAN, agents), ui: withUi({ open: { [taskKey]: false } }) }))
  expect(find(shut.rows, /a7f1/)).toBeUndefined()
  expect(find(shut.rows, /R02-40/)).toBeDefined()
  // a task without agents has no button
  expect(base.rows.find((r) => /R02-39/.test(rowText(r)))?.press).toBeUndefined()
})

test('plan tab: expand all opens every row that has children, collapse all closes them', async () => {
  const agents = UI3_ONLY
  const tree = buildTree(PLAN, agents)
  const base = planView(data({ agents, tree }))
  expect(base.allOpen).toBe(false)
  // the keys cover the rows under closed groups too, so one press opens everything
  expect(base.keys.some((k) => k.startsWith('t:API1/'))).toBe(false)
  const all: Record<string, boolean> = {}
  for (const k of base.keys) all[k] = true
  const open = planView(data({ agents, tree, ui: withUi({ open: all }) }))
  expect(open.allOpen).toBe(true)
  expect(open.rows.length).toBeGreaterThan(base.rows.length)
  expect(find(open.rows, /R04-1/)).toBeDefined()
  const none: Record<string, boolean> = {}
  for (const k of base.keys) none[k] = false
  const shut = planView(data({ agents, tree, ui: withUi({ open: none }) }))
  expect(shut.allOpen).toBe(false)
  // goal line, summary and the three groups
  expect(shut.rows.length).toBe(2 + 3)
})

test('plan tab: the Agents group lists the Agent-tool agents no task or group names, after the plan groups', async () => {
  const { rows } = planView(data())
  expect(find(rows, /Agents .*1\/1 agents/)).toBeDefined()
  // a group whose agents all finished long ago starts closed
  expect(find(rows, /✕ 1d20/)).toBeUndefined()
  expect(find(planView(data({ ui: withUi({ open: { 'g:agents': true } }) })).rows, /✕ 1d20/)).toBeDefined()
  expect(find(rows, /Unassigned/)).toBeUndefined()
  expect(indexOfRow(rows, /Agents .*1\/1 agents/)).toBeGreaterThan(indexOfRow(rows, /UI1 +One tag colour/))
  expect(texts(rows)[1]).toContain('3 groups')
})

test('plan tab: a record with neither a run nor an Agent-tool origin stays under Unassigned, the last resort', async () => {
  const bare = agent({ id: 'b0b0bbbb', subagentType: '', role: '', status: 'done', endedAt: NOW - MIN, durationMs: 1000 })
  const { rows } = planView(data({ agents: [bare], tree: buildTree(PLAN, [bare]) }))
  expect(find(rows, /Unassigned +1 agent/)).toBeDefined()
})

test('plan tab: hide done drops done tasks, and keeps the others', async () => {
  const shown = texts(planView(data()).rows)
  const hidden = texts(planView(data({ ui: withUi({ hideDone: true }) })).rows)
  expect(shown.some((x) => /R02-73/.test(x))).toBe(true)
  expect(hidden.some((x) => /R02-73/.test(x))).toBe(false)
  expect(hidden.some((x) => /R02-39/.test(x))).toBe(true)
})

test('plan tab: nothing pinned and no agents says so', async () => {
  const d = data({ goal: null, agents: [], tree: buildTree(null, []) })
  const t = texts(planView(d).rows)
  expect(t[0]).toMatch(/no plan$/)
})

test('plan tab: an unpinned session still lists its agents, under Agents', async () => {
  const d = data({ goal: null, tree: buildTree(null, AGENTS) })
  const t = texts(planView(d).rows)
  expect(t.some((x) => /Agents/.test(x))).toBe(true)
  expect(t.some((x) => /Unassigned/.test(x))).toBe(false)
  expect(t.some((x) => /a7f1/.test(x))).toBe(true)
})

// ---------------------------------------------------------------- Agents tab

test('agents tab: header, then blocked, stalled, running, queued, finished newest first', async () => {
  const t = texts(agentRows(data()))
  expect(t[0]).toMatch(/^ st +id +task +role +model\/effort +elapsed +last activity +est\. cost/)
  const at = ['c3e9', '5e11', '9c02', 'a7f1', 'q111', '4b7d', '1d20'].map((id) => t.findIndex((x) => x.includes(' ' + id + ' ')))
  expect(at.every((i) => i > 0)).toBe(true)
  expect(at).toEqual([...at].sort((a, b) => a - b))
})

test('agents tab: a row reads status, id, task, role, model/effort, elapsed, last activity, cost', async () => {
  const t = texts(agentRows(data()))
  const run = t.find((x) => x.includes('a7f1'))!
  expect(run).toContain('●')
  expect(run).toMatch(/R02-40 +implementer +opus\/high +06:00 +step 20s ago +n\/a/)
  const stalled = t.find((x) => x.includes('9c02'))!
  expect(stalled).toContain('◌')
  expect(stalled).toMatch(/R03-1 +scout +sonnet\/high +18:00 +step 14m ago/)
  const done = t.find((x) => x.includes('4b7d'))!
  expect(done).toMatch(/⚠ ✓|⚠✓/)
  expect(done).toMatch(/01:05 +done/)
  const failed = t.find((x) => x.includes('1d20'))!
  expect(failed).toContain('✕')
  expect(failed).toMatch(/— +runner +sonnet\/low +00:40 +error/)
})

test('agents tab: a blocked row is followed by the first 60 characters after BLOCKED', async () => {
  const t = texts(agentRows(data()))
  const i = t.findIndex((x) => x.includes('c3e9'))
  expect(t[i]).toContain('answered 2m')
  const q = t[i + 1]
  expect(q).toContain('BLOCKED: which toggle placement holds the dark default and why is it')
  const after = q.slice(q.indexOf('BLOCKED: ') + 'BLOCKED: '.length).trim()
  expect(Array.from(after).length).toBeLessThanOrEqual(60)
})

test('agents tab: no cost is shown as n/a, never as $0.00', async () => {
  const t = texts(agentRows(data())).join('\n')
  expect(t).not.toContain('$0.00')
  expect(t).toContain('n/a')
  const priced = texts(agentRows(data({ agents: [agent({ id: 'p1p1p1p1', estUsd: 0.4234, taskIds: ['R02-40'] })], tree: buildTree(PLAN, []) }))).join('\n')
  expect(priced).toContain('$0.42')
})

test('agents tab: provisional records are not rows', async () => {
  const a = [...AGENTS, agent({ id: 'zzzzprov', provisional: true })]
  expect(texts(agentRows(data({ agents: a }))).join('\n')).not.toContain('zzzz')
})

test('agents tab: nothing dispatched says so', async () => {
  const t = texts(agentRows(data({ agents: [] })))
  expect(t[t.length - 1]).toContain('no agents')
})

test('agents tab: zebra marks alternate data rows only', async () => {
  const rows = agentRows(data())
  const marks = rows.map((r) => r.zebra === true)
  expect(marks[0]).toBe(false)
  expect(marks[1]).toBe(false)
  expect(marks.filter((m) => m).length).toBeGreaterThan(0)
  expect(marks.some((m, i) => m && marks[i + 1])).toBe(false)
})

test('agents tab: a planned workflow agent is a queued row', async () => {
  const planned = agent({ id: 'wf:run1:3', agentId: undefined, planned: true, status: 'queued', runId: 'run1', agentIndex: 3, label: 'UI3 residual grep', phase: 'Verify', taskIds: [], groupId: 'UI3', steps: 0 })
  const t = texts(agentRows(data({ agents: [planned] })))
  expect(t.some((x) => /wf:3/.test(x) && /workflow, queued/.test(x) && /Verify/.test(x))).toBe(true)
})

// ---------------------------------------------------------------- Log tab

test('log tab: newest first, HH:MM, glyph, ref, role and verb', async () => {
  const t = texts(logRows(data()))
  expect(t.length).toBe(LOG.length)
  expect(t[0]).toMatch(/^ \d\d:\d\d +✓ R02-73 +implementer done +4m12s +est\.\$0\.42/)
  expect(t[1]).toMatch(/\d\d:\d\d +⊘ UI3 +implementer BLOCKED +which toggle placement holds the dark default/)
  expect(t[2]).toMatch(/◌ API1 +scout +stalled +no step for 10m/)
  expect(t[3]).toMatch(/✓ R02-41 +landed \(plan changed\)/)
  expect(t[4]).toMatch(/◐ R02-42 +published \(plan changed\)/)
  expect(t[5]).toMatch(/◆ tracking release-table.md § Release 2 tasks {2}column=landed/)
})

test('log tab: an unpriced completion shows est.n/a, never est.$0.00', async () => {
  const log: LogEntry[] = [{ at: NOW, kind: 'done', ref: 'R02-73', role: 'implementer', durationMs: 252_000, estUsd: 0 }]
  const t = texts(logRows(data({ log })))[0]
  expect(t).toContain('est.n/a')
  expect(t).not.toContain('$0.00')
})

test('log tab: empty says so', async () => {
  expect(texts(logRows(data({ log: [] })))[0]).toContain('no log entries')
})

// ---------------------------------------------------------------- Usage tab

test('usage tab: no usage data is n/a, no number is invented', async () => {
  const t = texts(usageRows(data()))
  expect(t[0]).toMatch(/^ context +n\/a/)
  expect(t[1]).toMatch(/^ session +n\/a/)
  expect(t[2]).toMatch(/^ agents +est\. n\/a over 7 agents/)
  expect(t.join('\n')).not.toContain('$0')
})

test('usage tab: the usage atom fills context and session; agents list tokens', async () => {
  const d = data({ usage: { percent: 42, tokens: 84_000, window: 200_000, usd: 12.34, hint: null } })
  const t = texts(usageRows(d))
  expect(t[0]).toContain('42%')
  expect(t[0]).toContain('84k / 200k')
  expect(t[0]).toContain('compact hint: off')
  expect(t[1]).toContain('$12.34')
  expect(t[1]).toContain('exact')
  const a7 = t.find((x) => x.includes('a7f1'))!
  expect(a7).toMatch(/implementer +opus +42\.1k +3\.2k +310k \/ 12k +n\/a/)
})

test('usage tab: cost without a ledger and a hint that is armed', async () => {
  const d = data({ usage: { percent: 71, hint: 'compact-at-next-boundary' } })
  const t = texts(usageRows(d))
  expect(t[0]).toContain('71%')
  expect(t[0]).toContain('compact hint: armed')
  expect(t[1]).toMatch(/^ session +n\/a/)
})

test('usage tab: priced agents add up under est.', async () => {
  const a = [agent({ id: 'u1u1u1u1', estUsd: 0.42 }), agent({ id: 'u2u2u2u2', estUsd: 0.11 })]
  const t = texts(usageRows(data({ agents: a, tree: buildTree(PLAN, a) })))
  expect(t[2]).toMatch(/^ agents +est\. \$0\.53 over 2 agents \(prices: claude-api skill, 2026-10-06\)/)
})

test('usage tab: an agent on a model the price table lacks is marked est.? in its row and in the sum', async () => {
  const a = [
    agent({ id: 'k1k1k1k1', estUsd: 0.42, model: 'claude-opus-5-5' }),
    agent({ id: 'k2k2k2k2', estUsd: 0.11, model: 'claude-newthing-9' }),
  ]
  const t = texts(usageRows(data({ agents: a, tree: buildTree(PLAN, a) })))
  expect(t[2]).toMatch(/^ agents +est\.\? \$0\.53 over 2 agents/)
  expect(t.find((x) => x.includes('k1k1'))).toMatch(/\$0\.42 *$/)
  expect(t.find((x) => x.includes('k2k2'))).toMatch(/\$0\.11\? *$/)
  // every agent on a known model: plain est.
  const known = [agent({ id: 'k3k3k3k3', estUsd: 0.2, model: 'claude-haiku-5-5' })]
  expect(texts(usageRows(data({ agents: known, tree: buildTree(PLAN, known) })))[2]).toMatch(/^ agents +est\. \$0\.20 over 1 agent/)
})

test('plan tab and agents tab show the agent figure, est.? when its model is not in the table', async () => {
  const a = [
    agent({ id: 'k1k1k1k1', taskIds: ['R02-40'], groupId: 'UI3', estUsd: 0.42, model: 'claude-opus-5-5' }),
    agent({ id: 'k2k2k2k2', taskIds: ['R02-40'], groupId: 'UI3', estUsd: 0.11, model: 'claude-newthing-9' }),
  ]
  const d = data({ agents: a, tree: buildTree(PLAN, a), ui: withUi({ open: { 'g:UI3': true } }), columns: 120 })
  const plan = texts(planView(d).rows)
  expect(plan.find((x) => x.includes('k1k1'))).toContain('est.$0.42')
  expect(plan.find((x) => x.includes('k2k2'))).toContain('est.?$0.11')
  const agents = texts(agentRows(d))
  expect(agents.find((x) => x.includes('k2k2'))).toContain('$0.11?')
})

// ---------------------------------------------------------------- widths, ascii, truncation

const TABS: Tab[] = ['plan', 'agents', 'log', 'usage']
const USAGE = { percent: 42, tokens: 84_000, window: 200_000, usd: 12.34, hint: null }

test('narrow widths: no row of any tab is wider than the pane, and none holds a line break', async () => {
  for (const columns of [20, 30, 40, 50, 60, 72, 100, 140]) {
    for (const tab of TABS) {
      const rows = bodyRows(data({ columns, usage: USAGE, ui: withUi({ tab }) }))
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) {
        expect(rowWidth(r)).toBeLessThanOrEqual(columns)
        expect(rowText(r)).not.toContain('\n')
      }
    }
  }
})

test('narrow widths: every tab keeps its first column and drops detail columns first', async () => {
  const wide = texts(agentRows(data({ columns: 100 })))[0]
  const mid = texts(agentRows(data({ columns: 60 })))[0]
  const narrow = texts(agentRows(data({ columns: 36 })))[0]
  expect(wide).toContain('last activity')
  expect(wide).toContain('model/effort')
  expect(mid).toContain('id')
  expect(mid).not.toContain('role')
  expect(narrow).toContain('st')
  expect(narrow).toContain('id')
  expect(narrow).not.toContain('model/effort')
})

test('truncation: a long title ends in an ellipsis inside the pane width', async () => {
  const long = planOf(PLAN_TEXT.replace('its Done greps red today', 'x'.repeat(200)))
  const rows = planView(data({ columns: 60, tree: buildTree(long, AGENTS) })).rows
  const row = rows.find((r) => /R02-40/.test(rowText(r)) && /●/.test(rowText(r)) && !/a7f1/.test(rowText(r)))!
  expect(rowText(row)).toContain('…')
  expect(rowWidth(row)).toBeLessThanOrEqual(60)
})

test('ascii: no unicode glyph from the table appears on any tab', async () => {
  const banned = /[◆▸▾●○◐✓✕⊘◌⚠█▓·▏▎▍▌▋▊▉…]/
  for (const tab of TABS) {
    const rows = bodyRows(data({ columns: 100, ascii: true, usage: USAGE, ui: withUi({ tab, open: { 'g:UI3': true } }) }))
    for (const r of rows) {
      const s = rowText(r)
      // the ellipsis is the one truncation mark; the glyph table has no ascii form for it
      expect(s.replace(/…/g, '')).not.toMatch(banned)
    }
  }
  const plan = texts(planView(data({ ascii: true, agents: UI3_ONLY, tree: buildTree(PLAN, UI3_ONLY) })).rows).join('\n')
  expect(plan).toContain('* Plan')
  expect(plan).toMatch(/v UI3/)
  expect(plan).toMatch(/> UI1/)
  expect(plan).toMatch(/\+ +R02-73/)
  expect(plan).toMatch(/W \+ 4b7d/)
  const agents = texts(agentRows(data({ ascii: true }))).join('\n')
  expect(agents).toMatch(/! +c3e9/)
  expect(agents).toMatch(/\? +5e11/)
  expect(agents).toMatch(/x +1d20/)
})

// ---------------------------------------------------------------- the hooks, driven through the engine

const PANE_PROPS = { title: 'Waypoint', isFocused: true, bodyColumns: 72, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 38 }, view: {} }

function spawnInput(over: Record<string, unknown>) {
  return {
    tool_use_id: 'toolu_1', prompt: 'Reply ok', description: 'a task', subagentType: 'acme:scout',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...over,
  }
}

test('hooks: the pane draws the tab row and the plan tab; a tab button switches the body', async ($, on) => {
  mock.clock(on, { now: 5000 })
  mock.env(on, {})
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ab12cd34' }))
  await $.agent.spawn(spawnInput({ description: 'census of the seams' }))
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'Pane', requestId: 'waypoint', props: PANE_PROPS })
  for (const k of ['tab-plan', 'tab-agents', 'tab-log', 'tab-usage', 'expand', 'hide', 'reread', 'quit']) expect(await ui.find({ key: k })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no plan$/ })).toBeDefined()
  await ui.press({ key: 'tab-agents' })
  expect(await ui.find({ type: 'Text', text: /last activity/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ab12/ })).toBeDefined()
  expect(await ui.find({ key: 'expand' })).toBeUndefined()
  await ui.press({ key: 'tab-log' })
  expect(await ui.find({ type: 'Text', text: /no log entries/ })).toBeDefined()
  await ui.press({ key: 'tab-usage' })
  expect(await ui.find({ type: 'Text', text: /context/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /n\/a/ })).toBeDefined()
  await ui.press({ key: 'tab-plan' })
  expect(await ui.find({ key: 'expand' })).toBeDefined()
  await ui.unmount()
})

test('hooks: a group row is a Button that toggles; e expands all; h hides done', async ($, on) => {
  mock.clock(on, { now: 5000 })
  mock.env(on, {})
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ab12cd34' }))
  await $.agent.spawn(spawnInput({ description: 'census of the seams' }))
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'Pane', requestId: 'waypoint', props: PANE_PROPS })
  // no plan: the agent sits under Agents, which starts open
  expect(await ui.find({ key: 'row:g:agents' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ab12/ })).toBeDefined()
  await ui.press({ key: 'row:g:agents' })
  expect(await ui.find({ type: 'Text', text: /ab12/ })).toBeUndefined()
  await ui.press({ key: 'row:g:agents' })
  expect(await ui.find({ type: 'Text', text: /ab12/ })).toBeDefined()
  // the one expandable row is open, so e offers to collapse; pressing it closes every row
  expect((await ui.find({ key: 'expand' }))?.text ?? '').toContain('collapse all')
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /ab12/ })).toBeUndefined()
  expect((await ui.find({ key: 'expand' }))?.text ?? '').toContain('expand all')
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /ab12/ })).toBeDefined()
  expect((await ui.find({ key: 'hide' }))?.text ?? '').toContain('hide done')
  await ui.press({ key: 'hide' })
  expect((await ui.find({ key: 'hide' }))?.text ?? '').toContain('show done')
  await ui.unmount()
})

test('hooks: q closes the pane', async ($, on) => {
  mock.clock(on, { now: 5000 })
  mock.env(on, {})
  const closed: string[] = []
  on('ui.close', async (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'Pane', requestId: 'waypoint', props: PANE_PROPS })
  await ui.press({ key: 'quit' })
  expect(closed).toEqual(['waypoint'])
  await ui.unmount()
})

// ---------------------------------------------------------------- the expanded band

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 100, scroll: { offset: 0, bodyRows: 15 }, view: {} }

async function pinned($, on, panes: unknown[]) {
  mock.clock(on, { now: 5000 })
  mock.env(on, {})
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: '/tmp' }))
  on('config.list', async () => ({ value: [] }))
  on('ui.toast', async () => ({ value: {} }))
  on('fs.read', async () => ({ value: PLAN_TEXT }))
  on('fs.stat', async () => ({ value: { mtimeMs: 1, size: 1, kind: 'file' } }))
  on('ui.panes', async () => ({ value: panes }))
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ab12cd34' }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  const r = await userCommand($, 'track /tmp/plan.md "Plan" column=landed partial=published')
  expect(r.text).toContain('tracking')
  await $.agent.spawn(spawnInput({ description: 'R02-40 read the greps' }))
}

test('hooks: a pane that is not placed expands the band with the pane body and letter hotkeys', async ($, on) => {
  await pinned($, on, [{ id: 'waypoint', title: 'Waypoint', isShown: true, isFocused: false, isPlaced: false }])
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: /Plan/ })).toBeDefined()
  for (const [key, hotkey] of [['tab-plan', 'p'], ['tab-agents', 'a'], ['tab-log', 'l'], ['tab-usage', 'u'], ['close', 'x']]) {
    expect((await ui.find({ key }))?.props?.hotkey).toBe(hotkey)
  }
  // the plan tab body is under the band lines
  expect(await ui.find({ type: 'Text', text: /R02-40/ })).toBeDefined()
  await ui.press({ key: 'tab-agents' })
  expect(await ui.find({ type: 'Text', text: /last activity/ })).toBeDefined()
  await ui.unmount()
})

test('hooks: a placed pane, or none, leaves the band to its lines', async ($, on) => {
  await pinned($, on, [{ id: 'waypoint', title: 'Waypoint', isShown: true, isFocused: false, isPlaced: true }])
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ type: 'Text', text: /Plan/ })).toBeDefined()
  expect(await ui.find({ key: 'tab-agents' })).toBeUndefined()
  await ui.unmount()
})

// ---------------------------------------------------------------- warnings and recent groups

test('log tab: a router warning is a ⚠ row with its rule and text', async () => {
  const log: LogEntry[] = [{ at: NOW, kind: 'warn', ref: 'R2', role: undefined, detail: 'Workflow "release-train": 2 agent() calls without model or effort' }]
  const t = texts(logRows(data({ log })))[0]
  expect(t).toMatch(/^ \d\d:\d\d +⚠ R2 +Workflow "release-train": 2 agent\(\) calls without model or effort/)
  expect(texts(logRows(data({ log, ascii: true })))[0]).toMatch(/ W R2 /)
})

test('agents tab: a warned row shows ⚠ and its rule ids after the cost when there is room', async () => {
  const a = [agent({ id: 'w1w1w1w1', taskIds: ['R02-40'], warnings: ['R1 no explicit model', 'R3 scout on opus'] }), agent({ id: 'n2n2n2n2', taskIds: ['R02-40'] })]
  const wide = texts(agentRows(data({ agents: a, tree: buildTree(PLAN, a), columns: 140 })))
  expect(wide.find((x) => x.includes('w1w1'))).toMatch(/⚠ R1,R3$/)
  expect(wide.find((x) => x.includes('w1w1'))).toMatch(/^ ⚠●/)
  expect(wide.find((x) => x.includes('n2n2'))).not.toContain('⚠')
  // at 72 columns the rule ids do not fit; the mark before the glyph stays
  const narrow = texts(agentRows(data({ agents: a, tree: buildTree(PLAN, a), columns: 72 })))
  expect(narrow.find((x) => x.includes('w1w1'))).toMatch(/^ ⚠●/)
})

test('plan tab: a group that just finished stays open near the top with its finished agent visible', async () => {
  const done = agent({ id: 'f1f1f1f1', taskIds: ['R03-1'], groupId: 'API1', role: 'scout', status: 'done', endedAt: NOW - 5 * MIN, durationMs: 60_000, model: 'claude-sonnet-5-5', effort: 'high' })
  const tree = buildTree(PLAN, [done], NOW)
  const rows = texts(planView(data({ agents: [done], tree })).rows)
  const api1 = rows.findIndex((x) => /API1 +Endpoint census/.test(x))
  const ui3 = rows.findIndex((x) => /UI3 +One dark-mode/.test(x))
  expect(api1).toBe(2)
  expect(api1).toBeLessThan(ui3)
  expect(rows[api1]).toContain('▾')
  expect(rows.some((x) => /f1f1/.test(x))).toBe(true)
  // outside the window it is an ordinary group again: closed, below nothing special
  const old = buildTree(PLAN, [done], NOW + 40 * MIN)
  const later = texts(planView(data({ agents: [done], tree: old, now: NOW + 40 * MIN })).rows)
  expect(later.some((x) => /f1f1/.test(x))).toBe(false)
})

test('money under one cent: the Agents and Usage tabs and the Log tab read <$0.01', async () => {
  const a = agent({ id: 'cent1234', status: 'done', model: 'claude-haiku-5-5', estUsd: 0.0004, endedAt: NOW, durationMs: 1000 })
  const log: LogEntry[] = [{ at: NOW, kind: 'done', ref: 'R02-73', role: 'hand', agentId: 'cent1234', durationMs: 1000, estUsd: 0.0004 }]
  const d = data({ agents: [a], log, usage: { percent: 1, usd: 0.003, hint: null } })
  expect(texts(agentRows(d)).some((x) => x.includes('<$0.01'))).toBe(true)
  const usage = texts(usageRows(d))
  expect(usage.some((x) => /session +<\$0\.01 exact/.test(x))).toBe(true)
  expect(usage.some((x) => x.includes('est. <$0.01 over 1 agent'))).toBe(true)
  expect(texts(logRows(d))[0]).toContain('est.<$0.01')
})

// ---------------------------------------------------------------- batch B: one model text

test('a queued agent shows the alias it was asked for in the Agents tab and in the state block alike', async () => {
  const queued = agent({ id: 'qq11ffff', status: 'queued', steps: 0, requestedModel: 'haiku', effort: undefined, model: undefined, lastStepAt: undefined })
  const row = texts(agentRows(data({ agents: [queued] }))).find((x) => x.includes('qq11'))!
  expect(row).toMatch(/ haiku /)
  const state = stateBlock({ filter: null, report: null, goal: null, agents: [queued], log: [], usage: null, now: NOW, logEntries: 1 })
  expect(state).toContain('[queued] qq11ffff')
  expect(state).toMatch(/\[queued\] qq11ffff [^\n]* haiku /)
  expect(modelEffort(queued)).toBe('haiku')
  const none = agent({ id: 'nn22ffff', status: 'queued', model: undefined, effort: undefined })
  expect(modelEffort(none)).toBe('—')
})

// ---------------------------------------------------------------- workflow labels in the role slot

const WF = agent({ id: 'wf9aaaaa', taskIds: ['R02-73'], groupId: 'UI3', role: 'workflow-subagent', subagentType: 'workflow-subagent', label: 'R02-73 case read', description: 'R02-73 case read', model: 'claude-haiku-5-5', status: 'done', spawnedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN, durationMs: 60_000 })

test('workflow agent: the Agents tab shows its label where the role would read workflow-subagent, cut to the column', async () => {
  const wide = texts(agentRows(data({ agents: [WF, AGENTS[1]] })))
  const row = wide.find((x) => x.includes('wf9a'))!
  expect(row).toContain('R02-73 cas')
  expect(row).not.toContain('workflow-s')
  expect(wide.find((x) => x.includes('5e11'))).toContain('scout')
})

test('workflow agent: the Log tab shows the label, a normal role stays', async () => {
  const log: LogEntry[] = [
    { at: NOW, kind: 'done', ref: 'R02-73', role: 'workflow-subagent', label: 'R02-73 case read', agentId: 'wf9aaaaa', durationMs: 60_000, estUsd: 0.01 },
    { at: NOW - 1000, kind: 'done', ref: 'UI3', role: 'scout', durationMs: 1000, estUsd: 0.01 },
  ]
  const t = texts(logRows(data({ log })))
  expect(t[0]).toMatch(/R02-73 +R02-73 cas… +done/)
  expect(t[0]).not.toContain('workflow-s')
  expect(t[1]).toMatch(/UI3 +scout +done/)
})

test('workflow agent: the state agents line and log line name the label in the role slot', async () => {
  const log: LogEntry[] = [{ at: NOW, kind: 'done', ref: 'R02-73', role: 'workflow-subagent', label: 'R02-73 case read', agentId: 'wf9aaaaa', durationMs: 60_000, estUsd: 0.01 }]
  const lines = stateBlock({ filter: null, report: null, goal: null, agents: [WF, AGENTS[1]], log, usage: null, now: NOW, logEntries: 5 }).split('\n')
  const agents = lines.find((l) => l.startsWith('agents: '))!
  expect(agents).toContain('[done] wf9aaaaa R02-73 case read haiku')
  expect(agents).not.toContain('workflow-subagent')
  expect(agents).toContain('[stalled] 5e11bbbb scout "a task"')
  expect(lines.find((l) => l.startsWith('log: '))).toContain('R02-73 R02-73 cas… done 1m')
})

test('plan tab: a failed workflow phase draws ✕ in the failed colour', async () => {
  const plan: Plan = {
    section: 'Run', tasks: [{ id: 'Build', title: '', ordinal: 1, line: 0, shape: 'checklist', status: 'open', groups: [0], failed: true }, { id: 'Verify', title: '', ordinal: 2, line: 0, shape: 'checklist', status: 'done', groups: [0] }],
    groups: [{ id: 'Run', title: '', kind: 'heading', own: true, tasks: [0, 1] }], counts: { done: 1, partial: 0, open: 1, total: 2 }, doneWord: 'done', noDoneRule: false, unmapped: 0, unmappedIds: [],
  }
  const rows = planView(data({ tree: buildTree(plan, []), ui: withUi({ open: { 'g:Run': true } }) })).rows
  const row = rows.find((r) => rowText(r).includes('Build'))!
  const glyph = row.segs.find((s) => s.text === '✕')
  expect(glyph?.el).toBe('failed')
})

// ---------------------------------------------------------------- batch B: the reported and plan-mode groups

const REPORTED = (statuses: Array<'open' | 'partial' | 'done'>) =>
  reportPlan({ title: 'Colour files', tasks: statuses.map((status, i) => ({ id: String(i + 1), title: 'step ' + (i + 1), status })) })
const goalOf = (plan: Plan, source: string) => ({ label: 'Colour files', done: plan.counts.done, partial: plan.counts.partial, open: plan.counts.open, total: plan.counts.total, doneWord: 'done', partialWord: plan.partialWord, source })
const groupRow = (rows: PaneRow[], re: RegExp) => rows.find((r) => re.test(rowText(r)))!

test('plan tab: a reported group bar is its task progress, full and in the done colour at 3/3', async () => {
  const plan = REPORTED(['done', 'done', 'done'])
  // one agent still counted against the group must not shorten the bar
  const a = [agent({ id: 'r1r1r1r1', taskIds: ['3'], groupId: 'Colour files', status: 'done' }), agent({ id: 'r2r2r2r2', taskIds: ['3'], groupId: 'Colour files', status: 'running' })]
  const rows = planView(data({ agents: a, tree: buildTree(plan, a), goal: goalOf(plan, 'reported') })).rows
  const g = groupRow(rows, /Colour files .*tasks/)
  expect(g.segs.find((x) => x.text === '████')?.el).toBe('barFill')
  expect(g.segs.some((x) => x.el === 'taskBar')).toBe(false)
  expect(rowText(g)).toContain('3/3 tasks')
})

test('plan tab: a group bar for a plan-mode plan counts done tasks and draws partial ones in their own colour', async () => {
  const mode = parsePlanMode('# Plan: Tidy\n\n## Phase 1\n1. a\n2. b\n3. c\n4. d\n')
  mode.steps[0].status = 'done'
  mode.steps[1].status = 'partial'
  const plan = modePlan(mode)
  const rows = planView(data({ agents: [], tree: buildTree(plan, []), goal: goalOf(plan, 'plan') })).rows
  const g = groupRow(rows, /Phase 1 .*tasks/)
  expect(g.segs.find((x) => x.el === 'barFill')?.text).toBe('█')
  expect(g.segs.find((x) => x.el === 'barPartial')?.text).toBe('▓')
  expect(rowText(g)).toContain('1/4 tasks')
})

test('plan tab: a plan-mode group whose id and title are the same text shows it once', async () => {
  const mode = parsePlanMode('# Plan: Tidy\n\n## Steps\n1. first\n2. second\n')
  expect(mode.groups[0]).toEqual({ id: 'Steps', title: 'Steps' })
  const plan = modePlan(mode)
  const g = groupRow(planView(data({ agents: [], tree: buildTree(plan, []), goal: goalOf(plan, 'plan') })).rows, /Steps .*tasks/)
  expect(rowText(g).match(/Steps/g)).toHaveLength(1)
})

test('plan tab: a done plan-mode step shows its child count complete, an open one its own', async () => {
  const mode = parsePlanMode('# Plan: Tidy\n\n1. first\n   - a\n   - b\n   - c\n2. second\n   - d\n   - e\n')
  mode.steps[0].status = 'done'
  const plan = modePlan(mode)
  const t = texts(planView(data({ agents: [], tree: buildTree(plan, []), goal: goalOf(plan, 'plan') })).rows)
  expect(t.find((x) => /first/.test(x))).toContain('3/3 items')
  expect(t.find((x) => /second/.test(x))).toContain('0/2 items')
})

test('plan tab: a file group keeps the agents bar and the agents count', async () => {
  const g = groupRow(planView(data()).rows, /UI3 +One dark-mode/)
  expect(g.segs.some((x) => x.el === 'taskBar')).toBe(true)
  expect(rowText(g)).toContain('2/4 agents')
})

test('plan tab: reported and plan-mode groups start expanded; a file group without agents does not', async () => {
  const plan = REPORTED(['open', 'partial', 'open'])
  const t = texts(planView(data({ agents: [], tree: buildTree(plan, []), goal: goalOf(plan, 'reported') })).rows)
  expect(t.some((x) => /step 1/.test(x))).toBe(true)
  expect(t.some((x) => /step 3/.test(x))).toBe(true)
  const mode = modePlan(parsePlanMode('# Plan: Tidy\n## Phase 1\n1. first\n2. second\n'))
  const m = texts(planView(data({ agents: [], tree: buildTree(mode, []), goal: goalOf(mode, 'plan') })).rows)
  expect(m.some((x) => /second/.test(x))).toBe(true)
  const file = texts(planView(data({ agents: [], tree: buildTree(PLAN, []) })).rows)
  expect(file.some((x) => /R02-40/.test(x))).toBe(false)
  // a person's own toggle still wins
  const shut = planView(data({ agents: [], tree: buildTree(plan, []), goal: goalOf(plan, 'reported'), ui: withUi({ open: { 'g:Colour files': false } }) }))
  expect(texts(shut.rows).some((x) => /step 1/.test(x))).toBe(false)
  // expand all / collapse all agree with the default
  const open = planView(data({ agents: [], tree: buildTree(plan, []), goal: goalOf(plan, 'reported') }))
  expect(open.allOpen).toBe(true)
})

test('usage tab: the session figure says exact, not where it came from', async () => {
  const t = texts(usageRows(data({ usage: { percent: 42, usd: 12.34, hint: null } })))
  expect(t[1]).toMatch(/^ session +\$12\.34 exact$/)
  expect(t[1]).not.toContain('$.session')
})

test('usage tab: no agents at all reads no agents, not an estimate over zero', async () => {
  const t = texts(usageRows(data({ agents: [], tree: buildTree(PLAN, []) })))
  expect(t[2]).toMatch(/^ agents +no agents$/)
  expect(t.join('\n')).not.toContain('over 0')
})

// ---------------------------------------------------------------- batch B: nothing the model wrote reaches the terminal as a control

test('rows: an agent description, a log detail and a blocked question carry no escape or line break', async () => {
  const evil = 'x\ny \u001b]8;;https://evil.example/x\u001b\\link\u001b]8;;\u001b\\ \u001b[2J\u001b]0;pwned\u0007z'
  const a = [agent({ id: 'e1e1e1e1', taskIds: ['R02-40'], groupId: 'UI3', description: evil, name: evil, status: 'blocked', question: evil, endedAt: NOW })]
  const log: LogEntry[] = [{ at: NOW, kind: 'warn', ref: 'R1', detail: evil }, { at: NOW, kind: 'pin', ref: '', detail: evil }]
  const d = data({ agents: a, tree: buildTree(PLAN, a), log, ui: withUi({ open: { 'g:UI3': true, 't:UI3/R02-40@6': true } }) })
  const all = [...planView(d).rows, ...agentRows(d), ...logRows(d), ...usageRows(d)].map(rowText).join('\n')
  expect(all).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
  expect(all).toContain('link')
  expect(all).not.toContain('evil.example')
  expect(all).not.toContain('pwned')
})
