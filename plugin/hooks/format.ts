// Bars, counts, durations, money and truncation (pure). SPEC.md sections 2, 8.1 and 9.3.

const FRACTION = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

export interface Bar {
  done: string // solid fill, plus the fractional cell (unicode only)
  partial: string // whole cells, drawn in the `run` slot
  track: string // drawn on the `surface` background
  text: string // done + partial + track, exactly `width` cells
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

// One bar. Done cells are floored to an eighth with one fractional cell; partial cells are whole
// cells rounded to nearest, after the done fill, and clipped so the bar never exceeds `width`.
// ascii: `#` fill, no fractional cell, `=` partial, `-` track.
export function bar(o: { done: number; partial?: number; total: number; width: number; ascii?: boolean }): Bar {
  const width = Math.max(0, Math.floor(o.width))
  const ascii = o.ascii === true
  const fill = ascii ? '#' : '█'
  const mid = ascii ? '=' : '▓'
  const empty = ascii ? '-' : ' '
  if (!(o.total > 0) || width === 0) {
    const track = empty.repeat(width)
    return { done: '', partial: '', track, text: track }
  }
  const done = clamp(o.done, 0, o.total)
  const partial = clamp(o.partial ?? 0, 0, o.total - done)
  const eighths = Math.floor((done * width * 8) / o.total + 1e-9)
  const full = Math.floor(eighths / 8)
  const rem = ascii ? 0 : eighths % 8
  const doneText = fill.repeat(full) + FRACTION[rem]
  const doneCells = full + (rem > 0 ? 1 : 0)
  const partialCells = Math.min(Math.round((partial * width) / o.total), width - doneCells)
  const track = empty.repeat(width - doneCells - partialCells)
  const partialText = mid.repeat(partialCells)
  return { done: doneText, partial: partialText, track, text: doneText + partialText + track }
}

// Goal count text: `landed 0 · published 141 · open 186 / 327` with a partial rule, else `163/327 done`.
export function formatCounts(o: {
  done: number
  partial: number
  open: number
  total: number
  doneWord: string
  partialWord?: string
  noDoneRule?: boolean
  ascii?: boolean
}): string {
  const sep = o.ascii === true ? '-' : '·'
  if (o.partialWord !== undefined) {
    return `${o.doneWord} ${o.done} ${sep} ${o.partialWord} ${o.partial} ${sep} open ${o.open} / ${o.total}`
  }
  const base = `${o.done}/${o.total} done`
  return o.noDoneRule === true ? `${base} ${sep} no done rule` : base
}

export function two(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

// A string as a literal inside a regular expression.
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function wholeSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000))
}

// 06:12, or 1:02:03 from an hour up.
export function formatClock(ms: number): string {
  const s = wholeSeconds(ms)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`
}

// 20s, 4m12s, 1h01m.
export function formatDuration(ms: number): string {
  const s = wholeSeconds(ms)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${two(s % 60)}s`
  return `${Math.floor(s / 3600)}h${two(Math.floor((s % 3600) / 60))}m`
}

// The coarse age shown after "step ... ago": 20s, 14m, 2h.
export function formatAgo(ms: number): string {
  const s = wholeSeconds(ms)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

// $12.34; a positive amount under one cent is <$0.01, so a small spend never reads as $0.00.
export function formatUsd(n: number): string {
  return n > 0 && n < 0.01 ? '<$0.01' : '$' + n.toFixed(2)
}

export function formatEstUsd(n: number): string {
  return 'est.' + formatUsd(n)
}

// 999, 42.1k, 310k, 1.3M.
export function formatTokens(n: number): string {
  const one = (v: number) => v.toFixed(1).replace(/\.0$/, '')
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return one(n / 1000) + 'k'
  if (n < 999_500) return Math.round(n / 1000) + 'k'
  return one(n / 1_000_000) + 'M'
}

// Cut to `width` cells (code points), ending in an ellipsis when something was cut.
export function truncate(s: string, width: number): string {
  if (width <= 0) return ''
  const cps = Array.from(s)
  if (cps.length <= width) return s
  return cps.slice(0, width - 1).join('') + '…'
}

// ---------------------------------------------------------------- text that a model or a file wrote

// Caps on what a model's list may hold, at ingest, in the saved record and in the plan that is drawn.
export const TASKS_MAX = 200
export const TITLE_MAX = 200

// Terminal escape sequences, whole: OSC and the other string sequences (DCS, SOS, PM, APC) to their
// terminator or the end of the text, CSI, then any other ESC with the one character after it. The
// 8-bit introducers (C1) read the same way.
const STRINGS = /(?:\u001b[\]PX^_]|[\u009d\u0090\u0098\u009e\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g
const ESC = /\u001b[ -~]?/g
const BREAKS = /[\t\n\r\u2028\u2029]/g
// The controls and format characters that go: every C0, C1 and DEL, and every format character except
// the ones writing needs, which stay: the joiner and non-joiner (U+200C, U+200D: emoji sequences,
// Persian and Indic words) and the direction marks (U+200E, U+200F, U+061C: they reorder only
// neutral characters, and RTL text uses them). That drops the bidi embeddings, overrides and
// isolates, the Unicode tag characters, the byte order mark, the zero-width space and the rest.
// Variation selectors are not format characters and are never touched.
const KEPT = String.raw`(?![\u200c-\u200f\u061c])`
const CONTROLS = new RegExp(KEPT + String.raw`[\p{Cc}\p{Cf}]`, 'gu')
const NEEDS_WORK = new RegExp(KEPT + String.raw`[\p{Cc}\p{Cf}]|[\u2028\u2029]`, 'u')

// A string with its escape sequences and control characters removed (C0, C1, DEL, and the format
// characters such as bidi overrides, but not the joiners or direction marks); a tab, a line break or
// a line separator becomes one space.
// Runs of spaces stay, since a row is padded with them.
export function stripControls(s: string): string {
  if (!NEEDS_WORK.test(s)) return s
  return s.replace(STRINGS, '').replace(CSI, '').replace(ESC, '').replace(BREAKS, ' ').replace(CONTROLS, '')
}

// Text a model or a file wrote, made safe for one line of a band, a pane, a log or a reply:
// stripControls, then every run of whitespace is one space, trimmed. `max` cuts to that many
// code points, ending in an ellipsis.
export function clean(s: string, max?: number): string {
  const one = stripControls(s).replace(/\s+/g, ' ').trim()
  return max === undefined ? one : truncate(one, max)
}

// The last segment of a path, with either separator.
export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

// A name that is safe as one segment of a path: letters, digits, dot, dash and underscore, and
// neither `.` nor anything holding `..`. The names a model, a settings file or a directory listing
// supplies pass through this before they are spliced into a path.
export function plainName(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && !s.includes('..')
}
