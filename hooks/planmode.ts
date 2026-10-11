// Plan-mode parser (pure): the steps of a plan Claude wrote in plan mode, SPEC.md 4.4. The file
// parser's reader (fences, headings, checklist items, the task ID rule) with four shapes, tried in
// order over the plan body outside its meta sections: checklist items, numbered items, headings of
// bullets, headings with an ID. Takes text, returns data; reads no file and calls no `$`.
import { fencedLines, HEADING, headingText, ITEM, parseTaskId } from './plan.ts'
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
export function plainTitle(s: string): string {
  const text = s.replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
  let out = ''
  let at = 0
  for (const m of text.matchAll(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
    out += emphasis(text.slice(at, m.index)) + m[2].trim()
    at = m.index + m[0].length
  }
  return out + emphasis(text.slice(at))
}

const emphasis = (s: string) =>
  s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1')

interface Heading {
  level: number
  text: string
  line: number
}

const NUMBERED = /^(\s*)(\d+)[.)]\s+(.+)$/
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
  titleLine: number // the title heading's line, -1 without one
  title?: string
}

// `meta`: leave out every meta section, the title heading excepted, to the next heading of its
// level or higher.
function read(text: string, meta: boolean): Body {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const fenced = fencedLines(lines)
  const all: Heading[] = []
  lines.forEach((l, i) => {
    const m = fenced[i] ? null : HEADING.exec(l)
    if (m) all.push({ level: m[1].length, text: headingText(m[2]).trim(), line: i })
  })
  const keep = lines.map((_, i) => !fenced[i])
  const top = all.find((h) => h.level === 1)
  for (const h of meta ? all : []) {
    if (h === top || !META.has(metaText(h.text))) continue
    const end = all.find((x) => x.line > h.line && x.level <= h.level)?.line ?? lines.length
    for (let i = h.line; i < end; i++) keep[i] = false
  }
  const headings = all.filter((h) => keep[h.line])
  const title = top ? plainTitle(top.text.replace(/^plan:\s*/i, '')).trim() : undefined
  return { lines, keep, headings, titleLine: top && keep[top.line] ? top.line : -1, title: title === '' ? undefined : title }
}

// Groups in order of first use: a step's nearest ancestor heading with a real ID, else its nearest
// ancestor heading (the 4.2 rule), the title heading left out; with neither, the plan's own group
// named after its title.
function grouper(b: Body): { groups: PlanModeGroup[]; of: (line: number, below?: number) => number } {
  const groups: PlanModeGroup[] = []
  const byLine = new Map<number, number>()
  // `below`: a heading step's own level, so only headings above it in rank are its ancestors.
  const of = (line: number, below: number = Infinity): number => {
    const chain: Heading[] = []
    let level = below
    for (let i = b.headings.length - 1; i >= 0; i--) {
      const h = b.headings[i]
      if (h.line >= line || h.level >= level) continue
      level = h.level
      if (h.line !== b.titleLine) chain.push(h)
    }
    const h = chain.find((x) => parseTaskId(x.text) !== null) ?? chain[0]
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
  return b.headings.some((h) => h.line === i)
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
    const m = b.keep[i] ? NUMBERED.exec(line) : null
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
    const m = NUMBERED.exec(line)
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
const NUMBERED_HEADING = /^(\d+)[.)]\s+(.+)$/
function idHeadings(b: Body): Draft[] {
  const out: Draft[] = []
  for (const h of b.headings) {
    if (h.level < 2 || h.level > 4) continue
    const n = NUMBERED_HEADING.exec(h.text)
    const p = n ? { id: n[1], title: n[2].trim() } : parseTaskId(h.text)
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
    const held = [...new Set(nums.map((s) => s.group))]
    for (const s of nums) s.id = (listed ? s.group : held.indexOf(s.group)) + 1 + '.' + s.id
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
