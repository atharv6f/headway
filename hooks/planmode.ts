// Plan-mode parser (pure): the steps of a plan Claude wrote in plan mode, SPEC.md 4.4. The file
// parser's reader (fences, headings, checklist items, the task ID rule) with four shapes, tried in
// order over the plan body outside its meta sections: checklist items, numbered items, headings of
// bullets, headings with an ID. Takes text, returns data; reads no file and calls no `$`.
import { atxHeading, fencedLines, headingText, ITEM, parseTaskId, planLines } from './plan.ts'
import { clean, TASKS_MAX, TITLE_MAX } from './format.ts'

export type StepStatus = 'open' | 'partial' | 'done'

export interface PlanModeStep {
  id: string
  title: string
  status: StepStatus
  group: number // index into PlanMode.groups
  sub?: { done: number; total: number } // the step's children
}

export interface PlanModeGroup {
  id: string
  title: string
  own?: true // the plan's own group, for steps under no heading of their own
}

export interface PlanMode {
  title?: string // the first `# ` heading, `Plan:` dropped
  groups: PlanModeGroup[]
  steps: PlanModeStep[] // empty: no shape found a step
  doneAt?: number // when every step became done (SPEC 4.1); unset while one is not
}

// A title as plain text (SPEC 4.4): `[text](url)` is its text, `**bold**`, `__bold__`, `*italic*`,
// `_italic_` and `~~strike~~` lose their markers, and an inline code span loses its backticks and
// keeps its content as it is. A lone `*` or an underscore inside a word is text. Ids never pass here.
// Plain scans, one pass each: a title is model or file text up to 8 KiB, and a regex that looks for a
// closer from every opener is quadratic on it. A scan that finds no closer for an opener knows that no
// opener before the same line break has one either, so it never looks twice.
export function plainTitle(s: string): string {
  const text = linkText(s)
  const { runs, byLen } = backtickRuns(text)
  let out = ''
  let at = 0
  for (let p = 0; p < runs.length; p++) {
    if (runs[p].start < at) continue
    const span = codeSpan(runs, byLen, p)
    if (span === undefined) continue
    out += emphasis(text.slice(at, span.open)) + text.slice(runs[p].end, span.to).trim()
    at = span.end
  }
  return out + emphasis(text.slice(at))
}

const isSpace = (ch: string) => /\s/.test(ch)
// what `.` does not match: a line break
const isBreak = (ch: string) => ch === '\n' || ch === '\r' || ch === ' ' || ch === ' '
const WORD = /[\p{L}\p{N}_]/u

// `[text](url)` and `![text](url "title")` become `text`. The text runs to the first `]`, and what
// follows that `]` is the same for every `[` before it, so a tail that fails is judged once.
function linkText(s: string): string {
  let out = ''
  let at = 0
  let from = 0
  let urlStop = -1 // the first `)` or space at or after an earlier position, kept while it still lies ahead
  let quoteStop = -1 // likewise the first `"`
  for (;;) {
    const open = s.indexOf('[', from)
    if (open < 0) break
    const close = s.indexOf(']', open + 1)
    if (close < 0) break
    let end = -1
    if (s[close + 1] === '(') {
      const url = close + 2
      if (urlStop < url) {
        urlStop = url
        while (urlStop < s.length && s[urlStop] !== ')' && !isSpace(s[urlStop])) urlStop++
      }
      if (s[urlStop] === ')') {
        end = urlStop + 1
      } else if (urlStop < s.length) {
        let q = urlStop
        while (q < s.length && isSpace(s[q])) q++
        if (s[q] === '"') {
          if (quoteStop < q + 1) {
            quoteStop = s.indexOf('"', q + 1)
            if (quoteStop < 0) quoteStop = s.length
          }
          if (s[quoteStop + 1] === ')') end = quoteStop + 2
        }
      }
    }
    if (end < 0) {
      from = close + 1
      continue
    }
    out += s.slice(at, open > at && s[open - 1] === '!' ? open - 1 : open) + s.slice(open + 1, close)
    at = end
    from = end
  }
  return out + s.slice(at)
}

interface Run {
  start: number
  end: number
  seg: number // how many line breaks lie before it: a code span stays inside one
}

// The runs of backticks, and for each run length the indexes of the runs that long, in order.
function backtickRuns(s: string): { runs: Run[]; byLen: Map<number, number[]> } {
  const runs: Run[] = []
  const byLen = new Map<number, number[]>()
  let seg = 0
  for (let i = 0; i < s.length; i++) {
    if (isBreak(s[i])) {
      seg++
    } else if (s[i] === '`') {
      let j = i + 1
      while (s[j] === '`') j++
      const at = byLen.get(j - i)
      if (at) at.push(runs.length)
      else byLen.set(j - i, [runs.length])
      runs.push({ start: i, end: j, seg })
      i = j - 1
    }
  }
  return { runs, byLen }
}

// The code span a run opens, if any: the opener is the last k backticks of the run, the longest k
// first, and it closes at the nearest later run of exactly k backticks on the same line; the backticks
// before the opener stay text. `to` is where the content ends, `end` where the closer does.
function codeSpan(runs: Run[], byLen: Map<number, number[]>, p: number): { open: number; to: number; end: number } | undefined {
  const run = runs[p]
  for (let k = run.end - run.start; k >= 1; k--) {
    const same = byLen.get(k)
    if (same === undefined) continue
    let lo = 0
    let hi = same.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (same[mid] > p) hi = mid
      else lo = mid + 1
    }
    const q = same[lo]
    if (q !== undefined && runs[q].seg === run.seg) return { open: run.end - k, to: runs[q].start, end: runs[q].end }
  }
  return undefined
}

// Strips one marker pair from a text. `word`: the pair counts only at a word edge (underscores).
// An opener needs a non-space after it; a closer a non-space before it; the closer is the nearest
// valid one on the opener's line with at least one character between. An opener with no closer
// means no later opener on that line has one, so the scan goes on past the line.
function strip(s: string, marker: string, word: boolean): string {
  const n = marker.length
  let out = ''
  let at = 0
  let i = 0
  while (i < s.length) {
    const open = s.indexOf(marker, i)
    if (open < 0) break
    i = open + 1
    if (open + n >= s.length || isSpace(s[open + n])) continue
    if (word && open > 0 && WORD.test(prevPoint(s, open))) continue
    let found = -1
    let j = open + n + 1
    while (j <= s.length && !isBreak(s[j - 1])) {
      if (s.startsWith(marker, j) && !isSpace(s[j - 1]) && !(word && j + n < s.length && WORD.test(nextPoint(s, j + n)))) {
        found = j
        break
      }
      j++
    }
    if (found < 0) {
      i = j
      continue
    }
    out += s.slice(at, open) + s.slice(open + n, found)
    at = found + n
    i = at
  }
  return out + s.slice(at)
}

const prevPoint = (s: string, i: number) => (i >= 2 && /[\udc00-\udfff]/.test(s[i - 1]) && /[\ud800-\udbff]/.test(s[i - 2]) ? s.slice(i - 2, i) : s[i - 1])
const nextPoint = (s: string, i: number) => (i + 1 < s.length && /[\ud800-\udbff]/.test(s[i]) && /[\udc00-\udfff]/.test(s[i + 1]) ? s.slice(i, i + 2) : s[i])

const emphasis = (s: string) => strip(strip(strip(strip(strip(s, '**', false), '__', true), '~~', false), '*', false), '_', true)

interface Heading {
  level: number
  text: string
  line: number
}

// A numbered line, `3. text` or `3) text`, as [line, indent, number, text]; null when it is not one.
// The indent is the whitespace before the number, allowed only with `indent`. The text starts after the
// whitespace that follows the marker, or inside it by one character when nothing else follows, and
// holds no line break (the `.` of the pattern this stands for, `^(\s*)(\d+)[.)]\s+(.+)$`, which backtracks
// over a long run of spaces to no end). One pass.
export function numberedLine(line: string, indent: boolean): [string, string, string, string] | null {
  let i = 0
  if (indent) while (i < line.length && isSpace(line[i])) i++
  let d = i
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++
  if (d === i || (line[d] !== '.' && line[d] !== ')')) return null
  const marker = d + 1
  let w = marker
  while (w < line.length && isSpace(line[w])) w++
  if (w === marker) return null
  const lastBreak = Math.max(line.lastIndexOf('\n'), line.lastIndexOf('\r'), line.lastIndexOf('\u2028'), line.lastIndexOf('\u2029'))
  const from = Math.min(w, line.length - 1)
  if (from <= marker || from <= lastBreak) return null // the whitespace is at least one character, the text at least one
  return [line, line.slice(0, i), line.slice(i, d), line.slice(from)]
}
const BULLET = /^(\s*)[-*]\s+\S/
// Sections about the work rather than steps of it, by heading text lower-cased with numbering and
// punctuation stripped (`3. Critical files:` is `critical files`).
const META = new Set(
  'context|background|summary|overview|goal|goals|files|critical files|key files|risks|risk|out of scope|non goals|notes|open questions|questions|alternatives|assumptions|dependencies|verification|testing|test plan|acceptance|acceptance criteria|done when|rollback|references'.split('|'),
)
const metaText = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/^\d+(?:\.\d+)*[.)]?\s*/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

interface Body {
  lines: string[]
  keep: boolean[] // not fenced, and (when the body outside them has a step) not in a meta section
  headings: Heading[] // on kept lines
  headingAt: boolean[] // by line: a kept heading is there
  titleLine: number // the title heading's line, -1 without one
  title?: string
}

// `meta`: leave out every meta section, the title heading excepted, to the next heading of its
// level or higher.
function read(text: string, meta: boolean): Body {
  const lines = planLines(text)
  const fenced = fencedLines(lines)
  const all: Heading[] = []
  lines.forEach((l, i) => {
    const h = fenced[i] ? null : atxHeading(l)
    if (h) all.push({ level: h.level, text: headingText(h.raw).trim(), line: i })
  })
  const keep = lines.map((_, i) => !fenced[i])
  const top = all.find((h) => h.level === 1)
  if (meta) {
    // each heading's section ends at the next heading of its level or higher: one pass from the end
    const ends: number[] = []
    const after: Heading[] = [] // headings below, nearest last, each of a higher rank than the ones after it
    for (let k = all.length - 1; k >= 0; k--) {
      const h = all[k]
      while (after.length > 0 && after[after.length - 1].level > h.level) after.pop()
      ends[k] = after.length > 0 ? after[after.length - 1].line : lines.length
      after.push(h)
    }
    // a meta section inside another one is already left out: skip the lines already cleared
    let cleared = -1
    all.forEach((h, k) => {
      if (h === top || !META.has(metaText(h.text))) return
      for (let i = Math.max(h.line, cleared); i < ends[k]; i++) keep[i] = false
      cleared = Math.max(cleared, ends[k])
    })
  }
  const headings = all.filter((h) => keep[h.line])
  const headingAt = lines.map(() => false)
  for (const h of headings) headingAt[h.line] = true
  const title = top ? plainTitle(top.text.replace(/^plan:\s*/i, '')).trim() : undefined
  return { lines, keep, headings, headingAt, titleLine: top && keep[top.line] ? top.line : -1, title: title === '' ? undefined : title }
}

// Groups in order of first use: a step's nearest ancestor heading with a real ID, else its nearest
// ancestor heading (the 4.2 rule), the title heading left out; with neither, the plan's own group
// named after its title.
function grouper(b: Body): { groups: PlanModeGroup[]; of: (line: number, below?: number) => number } {
  const groups: PlanModeGroup[] = []
  const byLine = new Map<number, number>()
  const hasId = new Map<Heading, boolean>()
  const withId = (h: Heading): boolean => {
    let v = hasId.get(h)
    if (v === undefined) hasId.set(h, (v = parseTaskId(h.text) !== null))
    return v
  }
  // The ancestors of a line are the outline chain of the headings above it: at most six, one per
  // level. Asked for in line order (the shapes find their steps top to bottom), the chain only moves
  // forward; a query for an earlier line starts it again.
  let chain: Heading[] = [] // outermost first
  let next = 0 // the next heading not yet in the chain
  let at = -1
  // `below`: a heading step's own level, so only headings above it in rank are its ancestors.
  const of = (line: number, below: number = Infinity): number => {
    if (line < at) {
      chain = []
      next = 0
    }
    at = line
    for (; next < b.headings.length && b.headings[next].line < line; next++) {
      const h = b.headings[next]
      while (chain.length > 0 && chain[chain.length - 1].level >= h.level) chain.pop()
      chain.push(h)
    }
    const ancestors: Heading[] = [] // nearest first
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].level < below && chain[i].line !== b.titleLine) ancestors.push(chain[i])
    const h = ancestors.find(withId) ?? ancestors[0]
    const key = h ? h.line : -1
    let gi = byLine.get(key)
    if (gi === undefined) {
      gi = groups.length
      byLine.set(key, gi)
      const p = h ? parseTaskId(h.text) : null
      groups.push(h ? { id: p ? p.id : h.text, title: p ? p.title : h.text } : { id: b.title ?? 'plan', title: '', own: true as const })
    }
    return gi
  }
  return { groups, of }
}

function isHeading(b: Body, i: number): boolean {
  return b.headingAt[i]
}

type Draft = Omit<PlanModeStep, 'group'> & { line: number; level?: number; numbered?: true } // numbered: its id is a number as written

// Checklist items by the 4.2 rule: an item deeper than the step above it is in that step's bar.
function checklist(b: Body): Draft[] {
  const out: Draft[] = []
  let parent: { step: Draft; indent: number } | undefined
  b.lines.forEach((line, i) => {
    if (!b.keep[i]) return
    if (isHeading(b, i)) {
      parent = undefined
      return
    }
    const m = ITEM.exec(line)
    if (!m) return
    const indent = m[1].length
    if (parent && indent > parent.indent) {
      const sub = parent.step.sub ?? (parent.step.sub = { done: 0, total: 0 })
      sub.total++
      if (m[2] !== ' ') sub.done++
      return
    }
    const p = parseTaskId(m[3])
    const step: Draft = { id: p ? p.id : String(out.length + 1), title: p && p.title !== '' ? p.title : m[3], status: 'open', line: i }
    out.push(step)
    parent = { step, indent }
  })
  return out
}

// Numbered items: the smallest indent among them is the top level; every numbered or bulleted line
// deeper than it, up to the next top-level item or heading, is a child of the step above.
function numbered(b: Body): Draft[] {
  let top = Infinity
  b.lines.forEach((line, i) => {
    const m = b.keep[i] ? numberedLine(line, true) : null
    if (m) top = Math.min(top, m[1].length)
  })
  const out: Draft[] = []
  let parent: Draft | undefined
  b.lines.forEach((line, i) => {
    if (!b.keep[i]) return
    if (isHeading(b, i)) {
      parent = undefined
      return
    }
    const m = numberedLine(line, true)
    if (m && m[1].length === top) {
      parent = { id: m[2], title: m[3].trim(), status: 'open', line: i, numbered: true }
      out.push(parent)
      return
    }
    const child = m ?? BULLET.exec(line)
    if (child && parent && child[1].length > top) {
      const sub = parent.sub ?? (parent.sub = { done: 0, total: 0 })
      sub.total++
      const item = ITEM.exec(line)
      if (item && item[2] !== ' ') sub.done++
    }
  })
  return out
}

// Headings of bullets: a ## to #### heading with at least one bullet before the next heading.
function headingSteps(b: Body): Draft[] {
  const out: Draft[] = []
  b.headings.forEach((h, k) => {
    if (h.level < 2 || h.level > 4) return
    const end = b.headings[k + 1]?.line ?? b.lines.length
    let total = 0
    for (let i = h.line + 1; i < end; i++) if (b.keep[i] && BULLET.test(b.lines[i])) total++
    if (total === 0) return
    const p = parseTaskId(h.text)
    out.push({ id: p ? p.id : h.text, title: p && p.title !== '' ? p.title : h.text, status: 'open', sub: { done: 0, total }, line: h.line, level: h.level })
  })
  return out
}

// Headings with an ID: a ## to #### heading whose text has a real ID by the task ID rule, or a
// leading `2.`/`2)`, is a step though it holds only prose; its prose is not children.
function idHeadings(b: Body): Draft[] {
  const out: Draft[] = []
  for (const h of b.headings) {
    if (h.level < 2 || h.level > 4) continue
    const n = numberedLine(h.text, false)
    const p = n ? { id: n[2], title: n[3].trim() } : parseTaskId(h.text)
    if (p) out.push({ id: p.id, title: p.title !== '' ? p.title : h.text, status: 'open', line: h.line, level: h.level, ...(n ? { numbered: true as const } : {}) })
  }
  return out
}

// The first shape with a step: checklist, numbered, headings of bullets, headings with an ID.
function shape(b: Body): { drafts: Draft[]; listed: boolean } {
  const c = checklist(b)
  if (c.length > 0) return { drafts: c, listed: false }
  const n = numbered(b)
  if (n.length > 0) return { drafts: n, listed: true }
  const h = headingSteps(b)
  return { drafts: h.length > 0 ? h : idHeadings(b), listed: false }
}

export function parsePlanMode(text: string): PlanMode {
  // Meta sections are left out of every shape; with no step outside them, the whole body is read.
  let b = read(text, true)
  let found = shape(b)
  if (found.drafts.length === 0) {
    b = read(text, false)
    found = shape(b)
  }
  const { drafts, listed } = found
  const g = grouper(b)
  const steps = drafts.map(({ line, level, numbered, ...s }) => ({ ...s, group: g.of(line, level), numbered: numbered === true }))
  // Numbering that restarts (under each phase heading): when a number repeats among the numbered
  // steps, each one's id is qualified by its group's ordinal, `2.1`, so no two share one; the title
  // stays the item text. Numbered items count groups in order of first use; numbered headings count
  // only the groups that hold them, so a `## Phase 1` that is a step of its own shifts nothing.
  const nums = steps.filter((s) => s.numbered)
  if (new Set(nums.map((s) => s.id)).size < nums.length) {
    const held = new Map<number, number>()
    for (const s of nums) if (!held.has(s.group)) held.set(s.group, held.size)
    for (const s of nums) s.id = (listed ? s.group : held.get(s.group)!) + 1 + '.' + s.id
  }
  // Taken in bounded (SPEC 12): at most TASKS_MAX steps, every title, id and heading one clean line
  // of at most TITLE_MAX characters.
  const tidy = (s: string) => clean(s, TITLE_MAX)
  const title = b.title === undefined ? '' : tidy(b.title)
  const plain = (s: string) => tidy(plainTitle(s))
  return {
    ...(title !== '' ? { title } : {}),
    groups: g.groups.map((x) => ({ ...x, id: tidy(x.id), title: plain(x.title) })),
    // an id that cleans to nothing (a heading of only invisible characters) is the step's ordinal
    steps: steps.slice(0, TASKS_MAX).map(({ numbered, ...s }, i) => ({ ...s, id: tidy(s.id) || String(i + 1), title: plain(s.title) })),
  }
}
