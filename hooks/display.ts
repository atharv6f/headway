// Shared display pieces (pure, no `$`, no JSX): the usage figures' shape, the segment and row types
// and their helpers, the log glyph and verb tables, the log rows (the Log tab and the `state` block
// read the same ones), and the agent cells the pane and `state` both print, so the two cannot drift.
import { familyOf, isFinished, roleText } from './agents.ts'
import type { AgentRecord, LogEntry } from './agents.ts'
import type { Seg } from './band.tsx'
import { formatDuration, formatEstUsd, formatUsd, stripControls, truncate, two } from './format.ts'
import { GLYPHS } from './theme.ts'
import type { Element, Glyphs } from './theme.ts'

// The `usage` atom (M6 fills it): the status line's context figures and the session ledger.
export interface UsageData {
  percent?: number
  tokens?: number
  window?: number
  usd?: number
  hint?: 'compact-at-next-boundary' | 'compact-now' | null
}

// A segment may colour by role (the role slot of 9.2), which no `Element` names.
export interface PSeg extends Seg {
  role?: string
}

// One line: `pre` spaces, then the row's Button (its label, a chevron) when it has children, then
// the segments. `zebra` rows are drawn on the zebra background across the whole width.
export interface PaneRow {
  pre: string
  press?: { key: string; label: string; open: boolean }
  segs: PSeg[]
  zebra?: true
}

export const len = (s: string) => Array.from(s).length

export function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - len(s)))
}

export function cell(s: string, width: number): string {
  return pad(truncate(s, width), width)
}

// A segment. Its text is what a model or a file may have written, so control characters and escape
// sequences go here, the one place every pane and log row is made (ingest cleans the lists already).
export const t = (text: string, el: Element = 'text', role?: string): PSeg => {
  const safe = stripControls(text)
  return role === undefined ? { text: safe, el } : { text: safe, el, role }
}

export function clipSegs(segs: PSeg[], width: number): PSeg[] {
  const total = segs.reduce((n, s) => n + len(s.text), 0)
  if (total <= width) return segs
  const out: PSeg[] = []
  let left = Math.max(0, width)
  for (const s of segs) {
    if (left <= 0) break
    const n = len(s.text)
    if (n <= left) {
      out.push(s)
      left -= n
    } else {
      out.push({ ...s, text: truncate(s.text, left) })
      left = 0
    }
  }
  return out
}

export function rowText(r: PaneRow): string {
  return r.pre + (r.press?.label ?? '') + r.segs.map((s) => s.text).join('')
}

export function rowWidth(r: PaneRow): number {
  return len(rowText(r))
}

// A row cut to `columns`; a zebra row is padded out to them.
export function mkRow(columns: number, pre: string, segs: PSeg[], press?: PaneRow['press'], zebra?: boolean): PaneRow {
  const head = len(pre) + (press ? len(press.label) : 0)
  const room = Math.max(0, columns - head)
  const clipped = clipSegs(segs, room)
  if (zebra) {
    const used = clipped.reduce((n, s) => n + len(s.text), 0)
    if (used < room) clipped.push(t(' '.repeat(room - used), 'zebra'))
  }
  const row: PaneRow = { pre: len(pre) > columns ? pre.slice(0, columns) : pre, segs: clipped }
  if (press && head <= columns) row.press = press
  if (zebra) row.zebra = true
  return row
}

// A lost agent (agents.ts settleRestored), in the muted slot. It belongs in theme.ts GLYPHS.
export const lostGlyph = (g: Glyphs): string => (g === GLYPHS.ascii ? '~' : '◇')

export const glyphsOf = (d: { ascii: boolean }): Glyphs => GLYPHS[d.ascii ? 'ascii' : 'unicode']

export const estCell = (n: number | undefined, known: boolean = true) => (n !== undefined && n > 0 ? (known ? formatEstUsd(n) : 'est.?' + formatUsd(n)) : 'est.n/a')

// An agent's model: the resolved one, else the alias the call asked for (a queued agent has only
// that), as the family name when it is one; `—` when neither is known.
export function modelName(a: AgentRecord): string {
  const model = a.model ?? a.requestedModel
  if (model === undefined) return '—'
  const fam = familyOf(model)
  return fam === 'unknown' ? model : fam
}

// The model and effort as one cell.
export function modelEffort(a: AgentRecord): string {
  const name = modelName(a)
  return name === '—' ? name : name + (a.effort !== undefined ? '/' + a.effort : '')
}

// Milliseconds an agent ran: its own duration when over, else since spawn.
export function elapsed(a: AgentRecord, now: number): number {
  if (isFinished(a.status)) return a.durationMs ?? Math.max(0, (a.endedAt ?? now) - a.spawnedAt)
  return Math.max(0, now - a.spawnedAt)
}

// ---------------------------------------------------------------- log

// HH:MM local.
function hm(at: number): string {
  const x = new Date(at)
  return two(x.getHours()) + ':' + two(x.getMinutes())
}

export const LOG_VERB: Record<string, string> = { done: 'done', failed: 'failed', blocked: 'BLOCKED', stalled: 'stalled', lost: 'lost', resumed: 'resumed' }

export function logGlyph(g: Glyphs, kind: string): PSeg {
  switch (kind) {
    case 'lost':
      return t(lostGlyph(g), 'queued')
    case 'done':
    case 'task-done':
      return t(g.done, 'doneGlyph')
    case 'failed':
      return t(g.failed, 'failed')
    case 'blocked':
      return t(g.blocked, 'blocked')
    case 'stalled':
      return t(g.stalled, 'stalled')
    case 'resumed':
      return t(g.running, 'running')
    case 'task-partial':
      return t(g.partial, 'partial')
    case 'task-reopened':
      return t(g.queued, 'queued')
    case 'warn':
      return t(g.warning, 'warning')
    default:
      return t(g.goal, 'goalGlyph')
  }
}

export function logRows(d: { columns: number; ascii: boolean; log: LogEntry[] }): PaneRow[] {
  const g = glyphsOf(d)
  const W = d.columns
  if (d.log.length === 0) return [mkRow(W, ' ', [t('no log entries', 'queued')])]
  const refW = Math.min(10, Math.max(6, ...d.log.map((e) => len(e.ref))))
  return d.log.map((e) => {
    const segs: PSeg[] = [t(hm(e.at), 'timestamp'), t('  '), logGlyph(g, e.kind), t(' ')]
    const verb = LOG_VERB[e.kind]
    if (verb !== undefined) {
      segs.push(t(cell(e.ref === '' ? '—' : e.ref, refW), 'id'), t(' '), t(cell(roleText({ role: e.role ?? '', label: e.label }), 11), 'text', e.role), t(' '), t(cell(verb, 8), e.kind === 'blocked' ? 'blocked' : e.kind === 'failed' ? 'failed' : e.kind === 'stalled' ? 'stalled' : 'text'))
      if (e.kind === 'done') {
        segs.push(t(' '), t(cell(e.durationMs !== undefined ? formatDuration(e.durationMs) : '', 7), 'counts'), t(' '), t(estCell(e.estUsd), 'counts'))
      } else if (e.detail !== undefined) segs.push(t(' '), t(e.detail, 'text'))
    } else if (e.kind === 'pin' || e.kind === 'unpin' || e.kind === 'report' || e.kind === 'plan') {
      segs.push(t(e.detail ?? '', 'text'))
    } else {
      segs.push(t(cell(e.ref, refW), 'id'), t(' '), t(e.detail ?? '', 'text'))
    }
    return mkRow(W, ' ', segs)
  })
}
