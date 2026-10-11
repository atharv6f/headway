// Transcript rows for headway's own tool (pure): one dim line per call, the result folded in.
// SPEC.md 10.4. `quietSegs` makes the line from the call's input and stored result; `quietTree`
// draws it with the band's palette and glyphs. Neither calls `$`.
import type { Seg } from './band.tsx'
import { clean, stripControls, truncate } from './format.ts'
import { GLYPHS, style } from './theme.ts'
import type { Glyphs, Theme } from './theme.ts'

export interface QuietCall {
  input: unknown
  output?: unknown
  isErrored: boolean
  isRunning: boolean
  ascii: boolean
}

const TITLE_MAX = 48

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return clean(v) === '' ? undefined : clean(v)
  return typeof v === 'number' ? String(v) : undefined
}

// The stored result as text: the tool answers a string; an object with a text or result field is read too.
function resultText(output: unknown): string | undefined {
  if (typeof output === 'string') return clean(output) === '' ? undefined : clean(output)
  const o = obj(output)
  return str(o.result) ?? str(o.text)
}

function mark(g: Glyphs, status: unknown): Seg {
  if (status === 'done') return { text: g.done, el: 'doneGlyph' }
  if (status === 'partial') return { text: g.partial, el: 'partial' }
  return { text: g.queued, el: 'queued' }
}

const dim = (text: string): Seg => ({ text, el: 'counts' })

function steps(g: Glyphs, items: Array<{ id: string; status: unknown }>): Seg[] {
  const out: Seg[] = []
  items.forEach((it, i) => {
    if (i > 0) out.push(dim(' ' + g.sep + ' '))
    out.push(mark(g, it.status), dim(' step ' + it.id))
  })
  return out
}

function head(glyph: string, rest: string): Seg[] {
  return [dim(glyph), dim(' ' + rest)]
}

function callLine(g: Glyphs, input: Record<string, unknown>): Seg[] {
  const action = str(input.action)
  if (action === 'report') {
    const tasks = Array.isArray(input.tasks) ? input.tasks : []
    const items: Array<{ id: string; status: unknown }> = []
    if (Array.isArray(input.updates)) {
      for (const u of input.updates) {
        const id = str(obj(u).id)
        if (id !== undefined) items.push({ id, status: obj(u).status })
      }
    }
    if (Array.isArray(input.done)) {
      for (const d of input.done) {
        const id = str(d)
        if (id !== undefined) items.push({ id, status: 'done' })
      }
    }
    if (tasks.length > 0) {
      const titles = tasks.map((t) => truncate(str(obj(t).title) ?? '?', TITLE_MAX))
      return head(g.goal, 'headway ' + g.sep + ' ' + tasks.length + (tasks.length === 1 ? ' step: ' : ' steps: ') + titles.join(' ' + g.sep + ' '))
    }
    if (items.length > 0) return steps(g, items)
    return head(g.goal, 'headway ' + g.sep + ' report')
  }
  if (action === 'track') {
    const file = str(input.file)
    const section = str(input.section)
    return head(g.goal, 'tracking ' + (file ?? '?') + (section !== undefined ? ' § ' + section : ''))
  }
  if (action === 'state') return head(g.goal, 'headway state')
  if (action === 'focus') return head(g.current, 'focus ' + (str(input.taskId) ?? '?'))
  if (action === 'untrack') return head(g.goal, 'untracked')
  return head(g.goal, 'headway')
}

// The line for one call. A refusal or an error draws in the error colour with its text; a focus on an
// unknown task draws as a warning; unknown ids in an update's reply follow the line as a warning.
export function quietSegs(c: QuietCall): Seg[] {
  return lineSegs(c).map((s) => ({ ...s, text: stripControls(s.text) }))
}

function lineSegs(c: QuietCall): Seg[] {
  const g = GLYPHS[c.ascii ? 'ascii' : 'unicode']
  const reply = resultText(c.output)
  if (c.isErrored || (reply !== undefined && reply.startsWith('refused:'))) {
    const why = reply ?? 'failed'
    return [{ text: g.failed + ' headway ' + g.sep + ' ' + why, el: 'failed' }]
  }
  if (reply !== undefined && reply.startsWith('unknown task:')) {
    return [{ text: g.warning + ' headway ' + g.sep + ' ' + reply, el: 'warning' }]
  }
  const line = callLine(g, obj(c.input))
  const unknown = reply === undefined ? null : /;\s*(unknown task:.*)$/.exec(reply)
  if (unknown) line.push({ text: '  ' + g.warning + ' ' + unknown[1], el: 'warning' })
  return line
}

type El = (props: Record<string, unknown>) => unknown

// One `Text` (truncate-end, nothing wraps) holding one nested `Text` per segment.
export function quietTree(ui: { Text: El }, theme: Theme, segs: Seg[]) {
  const { Text } = ui
  return (
    <Text wrap="truncate-end">
      {segs.map((s, i) => (
        <Text key={i} {...style(theme, s.el)}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}
