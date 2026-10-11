// Band above the prompt (pure): the quiet rule, the line layout and the tree, from plain data and the
// resolved elements. SPEC.md 8.1. `bandLines` makes lines of segments (text and the element that
// decides its colour); `bandTree` draws them. Neither calls `$` or reads a file.
import { logGlyph } from './display.ts'
import { bar, formatCounts, stripControls, truncate } from './format.ts'
import { GLYPHS, style } from './theme.ts'
import type { Element, Theme } from './theme.ts'

export interface Seg {
  text: string
  el: Element
}

export interface GoalData {
  label: string // the section heading, or the file name when there is none
  done: number
  partial: number
  open: number
  total: number
  doneWord: string
  partialWord?: string
  noDoneRule?: boolean
  note?: 'unreadable'
  source?: string // the active source's tag, one dim word after the count (SPEC 4.1)
}

export interface CurrentData {
  id: string
  title: string
  done: number
  total: number
  unit: 'agents' | 'items' // agents finished / dispatched, or the task's own sub-checklist
  status?: 'partial' | 'done' // partial: a task no agent works, drawn by its status, not `0 agents`; done: the task is done, its bar is drawn in the done colour
}

export interface Marks {
  warned?: number
  blocked?: number
  running?: number
  stalled?: number
}

export type LogKind = 'done' | 'failed' | 'blocked' | 'stalled' | 'warn' | 'info'

export interface Line3Data {
  ctx?: { percent: number; level: 'ok' | 'warn' | 'err' }
  cost?: string // '$12.34' or 'cost n/a'
  log?: { kind: LogKind; text: string }
  hint?: string // the compact hint; replaces the log slot
}

export interface BandData {
  columns: number // e.props.bodyColumns
  ascii: boolean
  goal: GoalData | null // null: nothing pinned (the band draws for agents still at work)
  current?: CurrentData
  allDone?: boolean // every task is done and no agent is at work: line 2 reads `all done`
  marks?: Marks
  line3?: Line3Data
}

// The band is quiet (8.1) with a survey up, with the band switched off, or when nothing is pinned
// and no agent is still at work (`agents` counts the shown records not yet finished).
export function bandVisible(o: { hasSurvey: boolean; pinned: boolean; agents: number; off?: boolean }): boolean {
  if (o.hasSurvey || o.off === true) return false
  return o.pinned || o.agents > 0
}

const LABEL = 30
const BAR = 40
const MIN = 12
const FIXED = 1 + 2 + 2 + 2 // margin, glyph and space, two gaps

// Widths: label 30 and bar 40; when the count does not fit beside them the bar shrinks first (to 12),
// then the label (to 12), then the count is cut to what is left.
export function bandLayout(columns: number, countLen: number): { label: number; bar: number; count: number } {
  let label = LABEL
  let barW = BAR
  if (FIXED + label + barW + countLen > columns) {
    barW = Math.max(MIN, columns - FIXED - label - countLen)
    if (FIXED + label + barW + countLen > columns) label = Math.max(MIN, columns - FIXED - barW - countLen)
  }
  const room = Math.max(0, columns - FIXED - label - barW)
  return { label, bar: barW, count: Math.min(countLen, room) }
}

const len = (s: string) => Array.from(s).length

// Cut a line to `width` cells; the last kept cell becomes an ellipsis when anything was cut.
function clip(segs: Seg[], width: number): Seg[] {
  const total = segs.reduce((n, s) => n + len(s.text), 0)
  if (total <= width) return segs
  const out: Seg[] = []
  let left = Math.max(0, width)
  for (const s of segs) {
    if (left <= 0) break
    const n = len(s.text)
    if (n <= left) {
      out.push(s)
      left -= n
    } else {
      out.push({ text: truncate(s.text, left), el: s.el })
      left = 0
    }
  }
  return out
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - len(s)))
}

function barSegs(b: { done: string; partial: string; track: string }, fill: Element, mid: Element): Seg[] {
  const out: Seg[] = []
  if (b.done !== '') out.push({ text: b.done, el: fill })
  if (b.partial !== '') out.push({ text: b.partial, el: mid })
  if (b.track !== '') out.push({ text: b.track, el: 'track' })
  return out
}

function goalLine(d: BandData, label: number, barW: number, countRoom: number): Seg[] {
  const g = d.goal
  const gl = GLYPHS[d.ascii ? 'ascii' : 'unicode']
  if (g === null) {
    return [
      { text: ' ', el: 'queued' },
      { text: gl.goal, el: 'queued' },
      { text: ' ', el: 'queued' },
      { text: 'no plan', el: 'queued' },
    ]
  }
  const b = bar({ done: g.done, partial: g.partial, total: g.total, width: barW, ascii: d.ascii })
  const counts = formatCounts({ ...g, ascii: d.ascii })
  const segs: Seg[] = [
    { text: ' ', el: 'text' },
    { text: gl.goal, el: 'goalGlyph' },
    { text: ' ', el: 'text' },
    { text: pad(truncate(g.label, label), label), el: 'goalLabel' },
    { text: '  ', el: 'text' },
    ...barSegs(b, 'barFill', 'barPartial'),
    { text: '  ', el: 'text' },
  ]
  const rest: Seg[] = [{ text: counts, el: 'counts' }]
  if (g.source !== undefined) rest.push({ text: '  ', el: 'text' }, { text: g.source, el: 'counts' })
  if (g.note === 'unreadable') rest.push({ text: '  ', el: 'text' }, { text: 'plan unreadable', el: 'warning' })
  return [...segs, ...clip(rest, countRoom)]
}

function currentRest(d: BandData, c: CurrentData): Seg[] {
  const gl = GLYPHS[d.ascii ? 'ascii' : 'unicode']
  const progress = c.total > 0 ? `${c.done}/${c.total} ${c.unit}` : `0 ${c.unit}`
  const rest: Seg[] = c.status === 'partial' ? [{ text: gl.partial + ' in progress', el: 'partial' }] : [{ text: progress, el: 'counts' }]
  const m = d.marks ?? {}
  if (m.warned) rest.push({ text: '  ', el: 'text' }, { text: `${gl.warning} ${m.warned}`, el: 'warning' })
  if (m.blocked) rest.push({ text: '  ', el: 'text' }, { text: `${gl.blocked} ${m.blocked} blocked`, el: 'blocked' })
  if (m.running) rest.push({ text: '  ', el: 'text' }, { text: `${gl.running} ${m.running}`, el: 'running' })
  if (m.stalled) rest.push({ text: '  ', el: 'text' }, { text: `${gl.stalled} ${m.stalled} stalled`, el: 'stalled' })
  return rest
}

function currentLine(d: BandData, label: number, barW: number, room: number): Seg[] {
  const gl = GLYPHS[d.ascii ? 'ascii' : 'unicode']
  const c = d.current
  if (d.allDone === true) {
    return [
      { text: ' ', el: 'text' },
      { text: gl.done, el: 'doneGlyph' },
      { text: ' ', el: 'text' },
      { text: 'all done', el: 'taskDone' },
    ]
  }
  if (!c) {
    return [
      { text: ' ', el: 'queued' },
      { text: gl.current, el: 'queued' },
      { text: ' ', el: 'queued' },
      { text: 'no current task', el: 'queued' },
    ]
  }
  const whole = truncate(c.id + ' ' + c.title, label)
  const idLen = Math.min(len(c.id), len(whole))
  const chars = Array.from(whole)
  const idText = chars.slice(0, idLen).join('')
  const titleText = chars.slice(idLen).join('')
  const b = bar({ done: c.done, total: c.total, width: barW, ascii: d.ascii })
  const rest = currentRest(d, c)
  return [
    { text: ' ', el: 'text' },
    { text: gl.current, el: 'currentGlyph' },
    { text: ' ', el: 'text' },
    { text: idText, el: 'id' },
    { text: pad(titleText, label - idLen), el: 'title' },
    { text: '  ', el: 'text' },
    ...(c.status === 'done' ? barSegs(b, 'barFill', 'barFill') : barSegs(b, 'taskBar', 'taskBar')),
    { text: '  ', el: 'text' },
    ...clip(rest, room),
  ]
}

function lastLine(d: BandData, l3: Line3Data): Seg[] {
  const g = GLYPHS[d.ascii ? 'ascii' : 'unicode']
  const segs: Seg[] = [{ text: ' ', el: 'text' }]
  const head: Seg[] = []
  if (l3.ctx) {
    const el: Element = l3.ctx.level === 'err' ? 'ctxCritical' : l3.ctx.level === 'warn' ? 'ctxWarn' : 'counts'
    head.push({ text: `ctx ${Math.round(l3.ctx.percent)}%`, el })
  }
  if (l3.cost !== undefined) {
    if (head.length > 0) head.push({ text: '  ', el: 'text' })
    head.push({ text: l3.cost, el: 'counts' })
  }
  segs.push(...head)
  if (l3.hint !== undefined) {
    if (head.length > 0) segs.push({ text: '   ', el: 'text' })
    segs.push({ text: g.goal, el: 'compactHint' }, { text: ' ', el: 'compactHint' }, { text: l3.hint, el: 'compactHint' })
  } else if (l3.log) {
    if (head.length > 0) segs.push({ text: '   ', el: 'text' })
    segs.push(logGlyph(g, l3.log.kind), { text: ' ' + l3.log.text, el: 'text' })
  }
  return segs
}

// Two lines, or three: line 3 appears only with data for it and is dropped under 60 columns.
export function bandLines(d: BandData): Seg[][] {
  const g = d.goal
  const goalRest = g === null ? 0 : len(formatCounts({ ...g, ascii: d.ascii })) + (g.source !== undefined ? 2 + len(g.source) : 0) + (g.note === 'unreadable' ? 2 + 15 : 0)
  // Both lines share one label and bar width so the bars line up; the longer text sets them.
  const currentRestLen = d.current ? currentRest(d, d.current).reduce((n, s) => n + len(s.text), 0) : 0
  const w = bandLayout(d.columns, Math.max(goalRest, currentRestLen))
  const room = Math.max(0, d.columns - FIXED - w.label - w.bar)
  const lines: Seg[][] = [
    clip(goalLine(d, w.label, w.bar, room), d.columns),
    clip(currentLine(d, w.label, w.bar, room), d.columns),
  ]
  const l3 = d.line3
  if (l3 && d.columns >= 60 && (l3.ctx || l3.cost !== undefined || l3.log || l3.hint !== undefined)) {
    lines.push(clip(lastLine(d, l3), d.columns))
  }
  // Labels and titles are what a model or a file wrote: no control character or escape reaches the terminal.
  return lines.map((line) => line.map((s) => ({ ...s, text: stripControls(s.text) })))
}

type El = (props: Record<string, unknown>) => unknown

// The tree: one `Text` per line (truncate-end, nothing wraps) holding one nested `Text` per segment.
export function bandTree(ui: { Box: El; Text: El }, theme: Theme, lines: Seg[][], below: unknown) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={'wp-' + i} wrap="truncate-end">
          {line.map((s, j) => (
            <Text key={j} {...style(theme, s.el)}>
              {s.text}
            </Text>
          ))}
        </Text>
      ))}
      {below}
    </Box>
  )
}
