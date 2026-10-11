// Pane (pure): the four tabs of SPEC.md 8.2 as rows of segments, and the trees that draw them, from
// plain data and the resolved elements. `paneTree` is the pane body; `bandBody` is the same body in
// the expanded band (8.1) with letter hotkeys. Neither calls `$` or reads a file.
import { isShown, roleText, runTitleOf, sortAgents } from './agents.ts'
import type { AgentRecord, AgentStatus, GroupNode, LogEntry, NodeStatus, PlanTree, TaskNode } from './agents.ts'
import { bandLines } from './band.tsx'
import type { GoalData, Seg } from './band.tsx'
import { cell, elapsed, estCell, glyphsOf, len, logRows, lostGlyph, mkRow, modelEffort, modelName, pad, rowText, rowWidth, t } from './display.ts'
import type { PaneRow, PSeg, UsageData } from './display.ts'
import { bar, formatAgo, formatClock, formatDuration, formatTokens, formatUsd, truncate } from './format.ts'
import { PRICES_NOTE, priceFamily } from './prices.ts'
import { roleSlot, style } from './theme.ts'
import type { Element, Glyphs, Theme } from './theme.ts'

// The pieces the Log tab and the `state` block share live in display.ts.
export { logRows, rowText, rowWidth }
export type { PaneRow, PSeg, UsageData }

export type Tab = 'plan' | 'agents' | 'log' | 'usage'

export const TABS: Array<{ tab: Tab; label: string; digit: string; letter: string }> = [
  { tab: 'plan', label: 'Plan', digit: '1', letter: 'p' },
  { tab: 'agents', label: 'Agents', digit: '2', letter: 'a' },
  { tab: 'log', label: 'Log', digit: '3', letter: 'l' },
  { tab: 'usage', label: 'Usage', digit: '4', letter: 'u' },
]

export function isTab(s: string): s is Tab {
  return TABS.some((t) => t.tab === s)
}

// The `ui` atom: the open tab, hide-done, and the expand state that differs from the default.
export interface UiState {
  tab: Tab
  hideDone: boolean
  open: Record<string, boolean> // row key -> expanded, only where the person (or `e`) set it
  opened: boolean // the pane is open (set on open, cleared at ui.close)
}

export const DEFAULT_UI: UiState = { tab: 'plan', hideDone: false, open: {}, opened: false }

export interface PaneData {
  columns: number // e.props.bodyColumns
  ascii: boolean
  now: number
  ui: UiState
  goal: GoalData | null
  tree: PlanTree
  agents: AgentRecord[]
  log: LogEntry[]
  usage: UsageData | null
  compactAt?: number
}


function agentGlyph(g: Glyphs, s: AgentStatus): PSeg {
  switch (s) {
    case 'running':
      return t(g.running, 'running')
    case 'queued':
      return t(g.queued, 'queued')
    case 'stalled':
      return t(g.stalled, 'stalled')
    case 'blocked':
      return t(g.blocked, 'blocked')
    case 'failed':
      return t(g.failed, 'failed')
    case 'lost':
      return t(lostGlyph(g), 'queued')
    default:
      return t(g.done, 'doneGlyph')
  }
}

function nodeGlyph(g: Glyphs, s: NodeStatus): PSeg {
  switch (s) {
    case 'done':
      return t(g.done, 'doneGlyph')
    case 'active':
      return t(g.running, 'running')
    case 'partial':
      return t(g.partial, 'partial')
    case 'failed':
      return t(g.failed, 'failed')
    default:
      return t(g.queued, 'queued')
  }
}

// ---------------------------------------------------------------- column fitting

interface Col {
  key: string
  w: number
  drop?: number // lower drops first when the pane is too narrow; absent never drops
  flex?: number // how many cells of spare room it may take
}

function colsTotal(cols: Col[], gap: number, leading: boolean): number {
  return cols.reduce((n, c) => n + c.w, 0) + gap * (leading ? cols.length : Math.max(0, cols.length - 1))
}

// Drops detail columns (lowest `drop` first) until the row fits; spare room goes to `flex` columns.
function fitCols(cols: Col[], avail: number, gaps: number[], leading = false): { cols: Col[]; gap: number } {
  let gap = gaps[0]
  let kept = cols
  for (const g of gaps) {
    gap = g
    if (colsTotal(kept, g, leading) <= avail) break
  }
  while (colsTotal(kept, gap, leading) > avail) {
    const drops = kept.filter((c) => c.drop !== undefined)
    if (drops.length === 0) break
    const first = drops.reduce((a, b) => ((b.drop as number) < (a.drop as number) ? b : a))
    kept = kept.filter((c) => c !== first)
  }
  let spare = avail - colsTotal(kept, gap, leading)
  kept = kept.map((c) => {
    if (spare <= 0 || !c.flex) return c
    const add = Math.min(spare, c.flex)
    spare -= add
    return { ...c, w: c.w + add }
  })
  return { cols: kept, gap }
}

// ---------------------------------------------------------------- agent cells

function shortId(a: AgentRecord): string {
  if (a.planned) return 'wf:' + (a.agentIndex ?? '?')
  return Array.from(a.agentId ?? a.id).slice(0, 4).join('')
}

function taskOf(a: AgentRecord): string {
  return a.taskIds[0] ?? a.groupId ?? runTitleOf(a) ?? '—'
}

function lastActivity(a: AgentRecord, now: number): { text: string; el: Element } {
  switch (a.status) {
    case 'running':
      return { text: 'step ' + formatAgo(now - (a.lastStepAt ?? a.spawnedAt)) + ' ago', el: 'counts' }
    case 'stalled':
      return { text: 'step ' + formatAgo(now - (a.lastStepAt ?? a.spawnedAt)) + ' ago', el: 'stalled' }
    case 'queued':
      return { text: 'queued', el: 'counts' }
    case 'blocked':
      return { text: 'answered ' + formatAgo(now - (a.endedAt ?? now)), el: 'blocked' }
    case 'failed':
      return { text: a.reason ?? 'failed', el: 'failed' }
    case 'lost':
      return { text: 'lost', el: 'queued' }
    default:
      return { text: 'done', el: 'counts' }
  }
}

// An agent's figure is an estimate priced in prices.ts; n/a until a step reported usage. A model the
// price table lacks was priced at the sonnet row and is marked `est.?` (a trailing `?` where the
// column already says est.).
const priced = (a: AgentRecord) => a.model === undefined || priceFamily(a.model) !== undefined
const costCell = (a: AgentRecord) => (a.estUsd > 0 ? formatUsd(a.estUsd) + (priced(a) ? '' : '?') : 'n/a')

const realAgents = (agents: AgentRecord[]) => agents.filter(isShown)

// ---------------------------------------------------------------- Plan tab

const GROUP_BAR = 4
const TASK_PRE = 3
const AGENT_PRE = 5

function plural(n: number, one: string, many: string): string {
  return n + ' ' + (n === 1 ? one : many)
}

// The sources whose group is the plan itself (a reported list, a plan-mode plan, the task tools): their
// group rows count tasks, whatever agents work them, and start expanded.
const OWN_SOURCES = ['reported', 'plan', 'tasks']
const isOwn = (d: { goal: GoalData | null }, gn: GroupNode) => d.goal?.source !== undefined && OWN_SOURCES.includes(d.goal.source) && (gn.kind === 'heading' || gn.kind === 'map') && gn.tasksTotal > 0

function groupCounts(gn: GroupNode, own: boolean): string {
  if (own) return gn.tasksDone + '/' + gn.tasksTotal + ' tasks'
  if (gn.dispatched > 0) return gn.finished + '/' + gn.dispatched + ' agents'
  if (gn.tasksTotal > 0) return gn.tasksDone + '/' + gn.tasksTotal + ' tasks'
  return ''
}

function taskCounts(tn: TaskNode): string {
  if (tn.sub) return tn.sub.done + '/' + tn.sub.total + ' items'
  if (tn.dispatched > 0) return tn.finished + '/' + tn.dispatched + ' agents'
  return ''
}

function marksText(g: Glyphs, loud: { blocked: number; stalled: number }): PSeg[] {
  const out: PSeg[] = []
  if (loud.blocked > 0) out.push(t('  '), t(g.blocked + ' ' + loud.blocked + ' blocked', 'blocked'))
  if (loud.stalled > 0) out.push(t('  '), t(g.stalled + ' ' + loud.stalled + ' stalled', 'stalled'))
  return out
}

const segsLen = (segs: PSeg[]) => segs.reduce((n, s) => n + len(s.text), 0)

// `id  title` (the id alone when there is no title or it is the id's own text), cut to `width`: the id keeps its colour, the title is plain, the rest padded.
function idTitle(id: string, title: string, width: number): PSeg[] {
  const whole = truncate(title === '' || title === id ? id : id + '  ' + title, width)
  const chars = Array.from(whole)
  const idLen = Math.min(len(id), chars.length)
  const head = chars.slice(0, idLen).join('')
  const tail = pad(chars.slice(idLen).join(''), width - idLen)
  return [t(head, 'id'), t(tail, 'title')]
}

const PLAN_AGENT_COLS: Col[] = [
  { key: 'role', w: 11, drop: 1 },
  { key: 'model', w: 12, drop: 2 },
  { key: 'status', w: 8, drop: 0 },
  { key: 'elapsed', w: 7 },
  { key: 'last', w: 12, drop: 3 },
  { key: 'est', w: 10 },
]

function planAgentRow(d: PaneData, g: Glyphs, a: AgentRecord, cols: Col[]): PaneRow {
  const segs: PSeg[] = [
    t(a.warnings.length > 0 ? g.warning + ' ' : '  ', 'warning'),
    agentGlyph(g, a.status),
    t(' '),
    t(shortId(a), 'id'),
  ]
  const last = lastActivity(a, d.now)
  for (const c of cols) {
    segs.push(t(' '))
    if (c.key === 'role') segs.push(t(cell(roleText(a) === '' ? '—' : roleText(a), c.w), 'text', a.role))
    else if (c.key === 'model') segs.push(t(cell(modelEffort(a), c.w), 'modelEffort'))
    else if (c.key === 'status') segs.push(t(cell(a.status, c.w), last.el === 'counts' ? 'queued' : last.el))
    else if (c.key === 'elapsed') segs.push(t(cell(formatClock(elapsed(a, d.now)), c.w), 'timestamp'))
    else if (c.key === 'last') segs.push(t(cell(last.text, c.w), last.el))
    else segs.push(t(cell(estCell(a.estUsd, priced(a)), c.w), 'counts'))
  }
  return mkRow(d.columns, ' '.repeat(AGENT_PRE), segs)
}

export function planView(d: PaneData): { rows: PaneRow[]; keys: string[]; allOpen: boolean } {
  const g = glyphsOf(d)
  const W = d.columns
  const rows: PaneRow[] = []
  const keys: string[] = []
  const used = new Map<string, number>()
  const keyFor = (base: string) => {
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return n === 1 ? base : base + '#' + n
  }
  const isOpen = (key: string, def: boolean) => d.ui.open[key] ?? def
  const tree = d.tree
  const sep = g.sep

  if (d.goal) rows.push(mkRow(W, '', bandLines({ columns: W, ascii: d.ascii, goal: d.goal })[0]))
  else rows.push(mkRow(W, ' ', [t(g.goal, 'goalGlyph'), t(' '), t('no plan', 'queued')]))

  // the summary counts the plan's groups, not the workflow and Agents groups
  const planGroups = tree.groups.filter((x) => x.kind === 'heading' || x.kind === 'map')
  if (planGroups.length > 0 || tree.unmapped > 0) {
    const active = planGroups.filter((x) => x.status === 'active').length
    const parts = [plural(planGroups.length, 'group', 'groups')]
    if (active > 0) parts.push(active + ' active')
    if (tree.unmapped > 0) parts.push(plural(tree.unmapped, 'unmapped row', 'unmapped rows'))
    rows.push(mkRow(W, ' ', [t(parts.join(' ' + sep + ' '), 'counts')]))
  }

  const finishedAll = (gn: GroupNode) => gn.status === 'done' && gn.loud.blocked + gn.loud.stalled === 0 && gn.finished === gn.dispatched
  const groups = d.ui.hideDone ? tree.groups.filter((gn) => !finishedAll(gn)) : tree.groups
  const taskShown = (tn: TaskNode) => !(d.ui.hideDone && tn.status === 'done' && tn.finished === tn.dispatched)

  // Widths shared by every row of a kind, from the rows the tree could draw.
  const allTasks = groups.flatMap((gn) => gn.tasks.filter(taskShown))
  const countsW = Math.max(0, ...groups.map((gn) => len(groupCounts(gn, isOwn(d, gn)))))
  const marksW = Math.max(0, ...groups.map((gn) => segsLen(marksText(g, gn.loud))))
  const groupRest = GROUP_BAR + 2 + countsW + marksW
  const groupLabelW = Math.max(8, W - 3 - groupRest - 2)
  const idW = Math.min(12, Math.max(4, ...allTasks.map((tn) => len(tn.id))))
  const rightOf = (tn: TaskNode) => {
    const parts: string[] = []
    if (tn.status === 'partial' && tn.partialWord) parts.push(tn.partialWord)
    const c = taskCounts(tn)
    if (c !== '') parts.push(c)
    return parts.join('  ')
  }
  const rightW = Math.min(26, Math.max(0, ...allTasks.map((tn) => len(rightOf(tn)))))
  const taskTitleW = Math.max(6, W - (TASK_PRE + 1 + 1 + 1 + 1 + idW + 2) - (rightW > 0 ? rightW + 2 : 0))
  const agentCols = fitCols(PLAN_AGENT_COLS, W - (AGENT_PRE + 2 + 1 + 1 + 4), [1], true).cols

  const agentRows = (list: AgentRecord[]) => sortAgents(list).map((a) => planAgentRow(d, g, a, agentCols))

  const taskRows = (key: string, tn: TaskNode) => {
    const has = tn.agents.length > 0
    const open = has && isOpen(key, tn.status === 'active' || tn.recent)
    const right = rightOf(tn)
    const segs: PSeg[] = [t(' '), nodeGlyph(g, tn.status), t(' '), t(cell(tn.id, idW), 'id'), t('  '), t(cell(tn.title, taskTitleW), 'title')]
    if (rightW > 0) {
      segs.push(t('  '))
      if (tn.status === 'partial' && tn.partialWord) {
        segs.push(t(tn.partialWord, 'counts'))
        const c = taskCounts(tn)
        if (c !== '') segs.push(t('  ' + c, 'counts'))
      } else segs.push(t(right, 'counts'))
    }
    const press = has ? { key, label: open ? g.expanded : g.collapsed, open } : undefined
    const out = [mkRow(W, press ? ' '.repeat(TASK_PRE) : ' '.repeat(TASK_PRE + 1), press ? segs : segs.slice(1), press)]
    if (open) out.push(...agentRows(tn.agents))
    return out
  }

  for (const gn of groups) {
    const key = keyFor('g:' + gn.id)
    const children = gn.tasks.length + gn.agents.length
    if (children > 0) keys.push(key)
    // Every expandable task key is collected whether or not its group is open: `e` acts on all of them.
    const tasks = gn.tasks.filter(taskShown).map((tn) => ({ tn, key: keyFor('t:' + gn.id + '/' + tn.id + (tn.line !== undefined ? '@' + tn.line : '')) }))
    for (const x of tasks) if (x.tn.agents.length > 0) keys.push(x.key)
    const own = isOwn(d, gn)
    const open = children > 0 && isOpen(key, groupOpensByDefault(gn, own))
    // the plan's own group draws its tasks' progress; any other group draws its agents' (finished / dispatched) or its tasks'
    const b = own
      ? bar({ done: gn.tasksDone, partial: gn.tasks.filter((x) => x.status === 'partial' || x.status === 'active').length, total: gn.tasksTotal, width: GROUP_BAR, ascii: d.ascii })
      : bar({ done: gn.dispatched > 0 ? gn.finished : gn.tasksDone, total: gn.dispatched > 0 ? gn.dispatched : gn.tasksTotal, width: GROUP_BAR, ascii: d.ascii })
    const fill: Element = own || gn.status === 'done' ? 'barFill' : 'taskBar'
    const mid: Element = own ? 'barPartial' : 'taskBar'
    const segs: PSeg[] = [
      ...(gn.kind === 'run' || gn.kind === 'agents' ? [t(cell(gn.title, groupLabelW), 'title')] : idTitle(gn.id, gn.title, groupLabelW)),
      t('  '),
      ...(b.done !== '' ? [t(b.done, fill)] : []),
      ...(b.partial !== '' ? [t(b.partial, mid)] : []),
      ...(b.track !== '' ? [t(b.track, 'track')] : []),
      t('  '),
      t(pad(groupCounts(gn, own), countsW), 'counts'),
      ...marksText(g, gn.loud),
    ]
    const press = children > 0 ? { key, label: open ? g.expanded : g.collapsed, open } : undefined
    rows.push(mkRow(W, ' ', press ? [t(' '), ...segs] : [t('  '), ...segs], press))
    if (open) {
      rows.push(...agentRows(gn.agents))
      for (const x of tasks) rows.push(...taskRows(x.key, x.tn))
    }
  }

  const un = tree.unassigned
  const unAgents = un.agents.length
  if (unAgents > 0) {
    const loud = {
      blocked: un.agents.filter((a) => a.status === 'blocked').length,
      stalled: un.agents.filter((a) => a.status === 'stalled').length,
    }
    keys.push('u')
    const open = isOpen('u', true)
    const segs: PSeg[] = [t(' '), t('Unassigned', 'unassigned'), t('  '), t(plural(unAgents, 'agent', 'agents'), 'counts'), ...marksText(g, loud)]
    rows.push(mkRow(W, ' ', segs, { key: 'u', label: open ? g.expanded : g.collapsed, open }))
    if (open) rows.push(...agentRows(un.agents))
  }

  const allOpen = keys.length > 0 && keys.every((k) => isOpen(k, defaultOpenOf(k, d, tree)))
  return { rows, keys, allOpen }
}

// A group opens by default when it has an agent at work, one that finished lately, a loud one, or is the plan's own.
function groupOpensByDefault(gn: GroupNode, own: boolean): boolean {
  return own || gn.status === 'active' || gn.recent || gn.loud.blocked + gn.loud.stalled > 0
}

// Whether a key opens by default: the rule planView applied when it drew the row.
function defaultOpenOf(key: string, d: PaneData, tree: PlanTree): boolean {
  const bare = key.replace(/#\d+$/, '')
  if (bare === 'u') return true
  if (bare.startsWith('g:')) {
    const gn = tree.groups.find((x) => 'g:' + x.id === bare)
    return gn !== undefined && groupOpensByDefault(gn, isOwn(d, gn))
  }
  const m = /^t:(.*)\/(.*?)(@\d+)?$/.exec(bare)
  if (m) {
    const gn = tree.groups.find((x) => x.id === m[1])
    const tn = gn?.tasks.find((x) => x.id === m[2] && (m[3] === undefined || '@' + x.line === m[3]))
    return tn !== undefined && (tn.status === 'active' || tn.recent)
  }
  return false
}

// ---------------------------------------------------------------- Agents tab

const AGENT_COLS: Col[] = [
  { key: 'st', w: 2 },
  { key: 'id', w: 4 },
  { key: 'task', w: 6, flex: 8 },
  { key: 'role', w: 11, drop: 1 },
  { key: 'model', w: 12, drop: 2 },
  { key: 'elapsed', w: 7 },
  { key: 'last', w: 13, flex: 10, drop: 3 },
  { key: 'cost', w: 9 },
]

const AGENT_HEAD: Record<string, string> = {
  st: 'st',
  id: 'id',
  task: 'task',
  role: 'role',
  model: 'model/effort',
  elapsed: 'elapsed',
  last: 'last activity',
  cost: 'est. cost',
}

function headRow(columns: number, cols: Col[], gap: number, head: Record<string, string>): PaneRow {
  const segs: PSeg[] = []
  cols.forEach((c, i) => {
    if (i > 0) segs.push(t(' '.repeat(gap)))
    segs.push(t(cell(head[c.key], c.w), 'counts'))
  })
  return mkRow(columns, ' ', segs)
}

export function agentRows(d: PaneData): PaneRow[] {
  const g = glyphsOf(d)
  const W = d.columns
  const { cols, gap } = fitCols(AGENT_COLS, W - 1, [2, 1])
  const rows: PaneRow[] = [headRow(W, cols, gap, AGENT_HEAD)]
  const list = sortAgents(realAgents(d.agents))
  if (list.length === 0) {
    rows.push(mkRow(W, ' ', [t('no agents dispatched', 'queued')]))
    return rows
  }
  list.forEach((a, i) => {
    const zebra = i % 2 === 1
    const segs: PSeg[] = []
    const last = lastActivity(a, d.now)
    cols.forEach((c, ci) => {
      if (ci > 0) segs.push(t(' '.repeat(gap)))
      if (c.key === 'st') segs.push(t(a.warnings.length > 0 ? g.warning : ' ', 'warning'), agentGlyph(g, a.status))
      else if (c.key === 'id') segs.push(t(cell(shortId(a), c.w), 'id'))
      else if (c.key === 'task') segs.push(t(cell(taskOf(a), c.w), taskOf(a) === '—' ? 'queued' : 'text'))
      else if (c.key === 'role') segs.push(t(cell(roleText(a) === '' ? '—' : roleText(a), c.w), 'text', a.role))
      else if (c.key === 'model') segs.push(t(cell(modelEffort(a), c.w), 'modelEffort'))
      else if (c.key === 'elapsed') segs.push(t(cell(formatClock(elapsed(a, d.now)), c.w), 'timestamp'))
      else if (c.key === 'last') segs.push(t(cell(last.text, c.w), last.el))
      else segs.push(t(cell(costCell(a), c.w), 'counts'))
    })
    if (a.planned) {
      const label = [a.groupId ?? '—', a.phase !== undefined ? '·phase ' + a.phase : '', '(workflow, queued)'].filter((x) => x !== '').join(' ')
      rows.push(mkRow(W, ' ', [t(' '), agentGlyph(g, a.status), t(' '), t(cell(shortId(a), 4), 'id'), t(' '.repeat(gap)), t(label, 'queued')], undefined, zebra))
      return
    }
    if (a.warnings.length > 0) {
      segs.push(t(' '.repeat(gap)), t(g.warning + ' ' + a.warnings.map((w) => w.split(' ')[0]).join(','), 'warning'))
    }
    rows.push(mkRow(W, ' ', segs, undefined, zebra))
    if (a.status === 'blocked' && a.question !== undefined) {
      const q = Array.from(a.question).slice(0, 60).join('')
      rows.push(mkRow(W, ' ', [t(' '.repeat(cols.slice(0, 2).reduce((n, c) => n + c.w + gap, 0))), t('BLOCKED: ' + q, 'blocked')], undefined, zebra))
    }
  })
  return rows
}

// ---------------------------------------------------------------- Log tab

// ---------------------------------------------------------------- Usage tab

const USAGE_COLS: Col[] = [
  { key: 'id', w: 4 },
  { key: 'role', w: 11, drop: 1 },
  { key: 'model', w: 8 },
  { key: 'in', w: 7 },
  { key: 'out', w: 7 },
  { key: 'cache', w: 13 },
  { key: 'cost', w: 9 },
]

const USAGE_HEAD: Record<string, string> = { id: 'id', role: 'role', model: 'model', in: 'in', out: 'out', cache: 'cache r/w', cost: 'est. cost' }

export function usageRows(d: PaneData): PaneRow[] {
  const W = d.columns
  const u = d.usage
  const rows: PaneRow[] = []
  const label = (s: string) => t(pad(s, 10), 'counts')

  const ctx: PSeg[] = [label('context')]
  if (u && u.percent !== undefined) {
    const critical = u.percent >= 90
    const warn = u.percent >= (d.compactAt ?? 70)
    const el: Element = critical ? 'ctxCritical' : warn ? 'ctxWarn' : 'barFill'
    const width = Math.max(8, Math.min(24, W - 11 - 2 - 4))
    const b = bar({ done: u.percent, total: 100, width, ascii: d.ascii })
    ctx.push(t(b.done, el), t(b.track, 'track'), t('  ' + Math.round(u.percent) + '%', critical ? 'ctxCritical' : warn ? 'ctxWarn' : 'text'))
    if (u.tokens !== undefined && u.window !== undefined) ctx.push(t('  ' + formatTokens(u.tokens) + ' / ' + formatTokens(u.window), 'counts'))
    ctx.push(t('  compact hint: ' + (u.hint === 'compact-now' ? 'now' : u.hint === 'compact-at-next-boundary' ? 'armed' : 'off'), 'counts'))
  } else ctx.push(t('n/a', 'queued'))
  rows.push(mkRow(W, ' ', ctx))

  const session: PSeg[] = [label('session')]
  if (u && u.usd !== undefined) session.push(t(formatUsd(u.usd), 'text'), t(' exact', 'counts'))
  else session.push(t('n/a', 'queued'))
  rows.push(mkRow(W, ' ', session))

  const list = sortAgents(realAgents(d.agents).filter((a) => !a.planned))
  const total = list.reduce((n, a) => n + a.estUsd, 0)
  const est = list.some((a) => a.estUsd > 0 && !priced(a)) ? 'est.? ' : 'est. '
  const figure = list.length === 0 ? 'no agents' : (total > 0 ? est + formatUsd(total) : 'est. n/a') + ' over ' + plural(list.length, 'agent', 'agents') + (total > 0 ? ' (' + PRICES_NOTE + ')' : '')
  const agentsLine: PSeg[] = [label('agents'), t(figure, 'text')]
  rows.push(mkRow(W, ' ', agentsLine))

  const { cols, gap } = fitCols(USAGE_COLS, W - 1, [2, 1])
  rows.push(headRow(W, cols, gap, USAGE_HEAD))
  list.forEach((a, i) => {
    const segs: PSeg[] = []
    cols.forEach((c, ci) => {
      if (ci > 0) segs.push(t(' '.repeat(gap)))
      if (c.key === 'id') segs.push(t(cell(shortId(a), c.w), 'id'))
      else if (c.key === 'role') segs.push(t(cell(roleText(a) === '' ? '—' : roleText(a), c.w), 'text', a.role))
      else if (c.key === 'model') segs.push(t(cell(modelName(a), c.w), 'modelEffort'))
      else if (c.key === 'in') segs.push(t(cell(formatTokens(a.tokens.in), c.w), 'counts'))
      else if (c.key === 'out') segs.push(t(cell(formatTokens(a.tokens.out), c.w), 'counts'))
      else if (c.key === 'cache') segs.push(t(cell(formatTokens(a.tokens.cacheRead) + ' / ' + formatTokens(a.tokens.cacheWrite), c.w), 'counts'))
      else segs.push(t(cell(costCell(a), c.w), 'counts'))
    })
    rows.push(mkRow(W, ' ', segs, undefined, i % 2 === 1))
  })
  return rows
}

// ---------------------------------------------------------------- the body of the open tab

export function bodyRows(d: PaneData): PaneRow[] {
  switch (d.ui.tab) {
    case 'agents':
      return agentRows(d)
    case 'log':
      return logRows(d)
    case 'usage':
      return usageRows(d)
    default:
      return planView(d).rows
  }
}

// ---------------------------------------------------------------- trees

type El = (props: Record<string, unknown>) => unknown

export interface PaneEls {
  Box: El
  Text: El
  Button: El
}

// What a press runs. They return a promise so the press settles once the write and the redraw are done.
export interface Handlers {
  tab: (tab: Tab) => Promise<void>
  toggle: (key: string, open: boolean) => Promise<void>
  expandAll: (keys: string[], open: boolean) => Promise<void>
  hideDone: () => Promise<void>
  reread: () => Promise<void>
  close: () => Promise<void>
}

function segStyle(theme: Theme, s: PSeg) {
  if (s.role !== undefined && s.role !== '') {
    const c = theme.colors[roleSlot(s.role)]
    return c === null ? {} : { color: c }
  }
  return style(theme, s.el)
}

function rowNode(ui: PaneEls, theme: Theme, row: PaneRow, i: number, act: Handlers) {
  const { Box, Text, Button } = ui
  const bg = row.zebra ? style(theme, 'zebra') : {}
  const text = (
    <Text key={'t' + i} wrap="truncate-end">
      {row.segs.length === 0
        ? ' '
        : row.segs.map((s, j) => (
            <Text key={j} {...segStyle(theme, s)} {...bg}>
              {s.text}
            </Text>
          ))}
    </Text>
  )
  const press = row.press
  if (!press) {
    if (row.pre === '') return text
    return (
      <Box key={'r' + i} flexDirection="row">
        <Text key="pre">{row.pre}</Text>
        {text}
      </Box>
    )
  }
  const kids = []
  if (row.pre !== '') kids.push(<Text key="pre">{row.pre}</Text>)
  kids.push(<Button key={'row:' + press.key} label={press.label} plain onPress={async () => act.toggle(press.key, !press.open)} />)
  kids.push(text)
  return (
    <Box key={'r' + i} flexDirection="row">
      {kids}
    </Box>
  )
}

function tabButtons(ui: PaneEls, d: PaneData, act: Handlers, letters: boolean) {
  const { Box, Text, Button } = ui
  const tail = letters ? [<Button key="close" label="close" hotkey="x" plain dimColor={true} onPress={async () => act.close()} />] : []
  return (
    <Box key="tabs" flexDirection="row" columnGap={2}>
      <Text key="m"> </Text>
      {TABS.map((x) => (
        <Button key={'tab-' + x.tab} label={x.label} hotkey={letters ? x.letter : x.digit} plain dimColor={d.ui.tab !== x.tab} onPress={async () => act.tab(x.tab)} />
      ))}
      {tail}
    </Box>
  )
}

function actionButtons(ui: PaneEls, d: PaneData, act: Handlers, view: { keys: string[]; allOpen: boolean } | undefined) {
  const { Box, Text, Button } = ui
  const kids = [<Text key="m"> </Text>]
  if (view) {
    kids.push(<Button key="expand" label={view.allOpen ? 'collapse all' : 'expand all'} hotkey="e" plain dimColor={true} onPress={async () => act.expandAll(view.keys, !view.allOpen)} />)
    kids.push(<Button key="hide" label={d.ui.hideDone ? 'show done' : 'hide done'} hotkey="h" plain dimColor={!d.ui.hideDone} onPress={async () => act.hideDone()} />)
  }
  kids.push(<Button key="reread" label="re-read" hotkey="r" plain dimColor={true} onPress={async () => act.reread()} />)
  kids.push(<Button key="quit" label="close" hotkey="q" plain dimColor={true} onPress={async () => act.close()} />)
  return (
    <Box key="actions" flexDirection="row" columnGap={2}>
      {kids}
    </Box>
  )
}

// The pane body: tab row, action row, then the open tab. A tree taller than the pane scrolls.
export function paneTree(ui: PaneEls, theme: Theme, d: PaneData, act: Handlers) {
  const { Box } = ui
  let rows: PaneRow[]
  let view: { keys: string[]; allOpen: boolean } | undefined
  if (d.ui.tab === 'plan') {
    const v = planView(d)
    rows = v.rows
    view = v
  } else rows = bodyRows(d)
  return (
    <Box flexDirection="column">
      {tabButtons(ui, d, act, false)}
      {actionButtons(ui, d, act, view)}
      {rows.map((r, i) => rowNode(ui, theme, r, i, act))}
    </Box>
  )
}

// The same body in the expanded band: letter hotkeys and `x` to close, at most `budget` rows
// (the tab row included); what does not fit is replaced by a `n more` row.
export function bandBody(ui: PaneEls, theme: Theme, d: PaneData, act: Handlers, budget: number) {
  const { Box, Text } = ui
  const rows = bodyRows(d)
  const room = Math.max(0, budget - 1)
  let shown = rows
  let more = 0
  if (rows.length > room) {
    shown = rows.slice(0, Math.max(0, room - 1))
    more = rows.length - shown.length
  }
  const tailRows =
    more > 0
      ? [
          <Text key="more" wrap="truncate-end" {...style(theme, 'counts')}>
            {' ' + more + ' more'}
          </Text>,
        ]
      : []
  return (
    <Box flexDirection="column">
      {tabButtons(ui, d, act, true)}
      {shown.map((r, i) => rowNode(ui, theme, r, i, act))}
      {tailRows}
    </Box>
  )
}
