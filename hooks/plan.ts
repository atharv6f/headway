// Plan parser (pure): checklist and table shapes, sections, task and group IDs, done and partial
// rules, the group map. SPEC.md section 3. Takes text, returns data; reads no file and calls no `$`.

export type Status = 'done' | 'partial' | 'open'

export interface ParseOptions {
  section?: string
  doneRule?: string // 'auto' | 'column=<name>' | 'check=<name>'
  partial?: string // column name
}

export interface GroupMapEntry {
  id: string
  title?: string
  rows: string[]
}

export interface Task {
  id: string
  title: string
  ordinal: number // 1-based within the section, across both shapes
  line: number // 1-based line in the parsed text
  shape: 'checklist' | 'table'
  status: Status
  sub?: { done: number; total: number } // a checklist item's nested items, any depth
  groups: number[] // indexes into Plan.groups; a task named by several map groups has several
  failed?: true // a workflow phase whose agents all settled with one failed or lost (4.6): status open, drawn failed
}

export interface Group {
  id: string
  title: string
  kind: 'heading' | 'map'
  tasks: number[] // indexes into Plan.tasks
  own?: true // a source's own group (its title, or a fallback word): drawn, never an ID to match
}

export interface Plan {
  section: string // the matched heading text, '' for the whole file
  tasks: Task[]
  groups: Group[]
  counts: { done: number; partial: number; open: number; total: number }
  doneWord: string // the done column's header as written; 'done' for a checklist or no column
  partialWord?: string // the partial column's header as written
  noDoneRule: boolean // a table with neither a check column nor a done column was seen
  unmapped: number // group-map rows that match no task, per occurrence
  unmappedIds: string[]
  phaseRun?: { runId?: string; toolUseId?: string } // the workflow run a phases plan stands for (4.6)
}

export type ParseResult = { ok: true; plan: Plan } | { ok: false; error: string }

interface Heading {
  level: number
  text: string
  line: number // 0-based
}

const HEADING_OPEN = /^(#{1,6})[ \t]+/
export const ITEM = /^(\s*)[-*] \[( |x|X)\] (.+)$/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const TWO_WORD = /^(?:step|task|phase|stage|part|milestone|item)$/i
const TOKEN = /^[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*/
export const LINE_MAX = 8192 // a line is read to its first 8 KiB
const RULE_CELL = /^ *:?-+:? *$/
const EMPTY_CELLS = ['', '-', '–', '—', '[ ]']

function isEmptyCell(cell: string): boolean {
  return EMPTY_CELLS.indexOf(cell.trim()) >= 0
}

function splitCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
}

// Default task ID rule (3.1). Returns null when the text holds no token with a digit.
export function parseTaskId(text: string): { id: string; title: string } | null {
  let s = text.trim()
  const opens: string[] = []
  for (;;) {
    if (s.startsWith('**')) {
      opens.push('**')
      s = s.slice(2)
    } else if (s.startsWith('`')) {
      opens.push('`')
      s = s.slice(1)
    } else break
  }
  const m = TOKEN.exec(s)
  if (!m) return null
  let id = m[0]
  let len = id.length
  if (!/\d/.test(id)) {
    if (!TWO_WORD.test(id)) return null
    const d = /^\s+(\d+)/.exec(s.slice(len))
    if (!d) return null
    id = id + ' ' + d[1]
    len += d[0].length
  }
  let rest = s.slice(len)
  for (let i = opens.length - 1; i >= 0; i--) {
    const at = rest.indexOf(opens[i])
    if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + opens[i].length)
  }
  rest = rest.trim().replace(/^[:.—-]\s*/, '').trim()
  return { id, title: rest }
}

// An opener starts a line (after at most three spaces) with a run of ``` or ~~~ that the same
// line does not close, so inline code such as ```x``` never opens a fence.
function fenceOpener(line: string): string | null {
  const m = FENCE.exec(line)
  if (!m) return null
  const rest = m[2]
  if (m[1][0] === '`' ? rest.indexOf('`') >= 0 : rest.indexOf(m[1]) >= 0) return null
  return m[1]
}

// Marks the lines of fenced code blocks (``` or ~~~), fence lines included. A fence closes on a
// line of the same marker at least as long as its opener; an unclosed one runs to the end.
export function fencedLines(lines: string[]): boolean[] {
  const out: boolean[] = []
  let open: string | null = null
  for (const line of lines) {
    if (open === null) {
      open = fenceOpener(line)
      out.push(open !== null)
    } else {
      const m = FENCE_CLOSE.exec(line)
      if (m && m[1][0] === open[0] && m[1].length >= open.length) open = null
      out.push(true)
    }
  }
  return out
}

// An ATX heading: one to six #s, a space or tab, then text, which loses its trailing spaces and tabs.
// The prefix is matched by an anchored regex and the end trimmed by hand, so no pattern backtracks
// over a run of spaces inside the line.
export function atxHeading(line: string): { level: number; raw: string } | null {
  const m = HEADING_OPEN.exec(line)
  if (!m) return null
  let end = line.length
  while (end > m[0].length && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--
  const raw = line.slice(m[0].length, end)
  if (raw === '' || raw.indexOf('\u2028') >= 0 || raw.indexOf('\u2029') >= 0) return null
  return { level: m[1].length, raw }
}

// ATX heading text without its closing run of #s (CommonMark): `## Phase A ##` is `Phase A`. The run
// goes when it is the whole text or follows a space or tab, which go with it.
export function headingText(raw: string): string {
  let hashes = raw.length
  while (hashes > 0 && raw[hashes - 1] === '#') hashes--
  if (hashes === raw.length) return raw
  if (hashes === 0) return ''
  let cut = hashes
  while (cut > 0 && (raw[cut - 1] === ' ' || raw[cut - 1] === '\t')) cut--
  return cut === hashes ? raw : raw.slice(0, cut)
}

// A GFM delimiter row: cells of `-`s, each with an optional `:` either side and spaces around, split
// by pipes; a leading pipe after at most three spaces, a trailing pipe and trailing spaces allowed.
// Split by hand, each cell tested by an anchored regex with no two quantifiers over the same text.
function isTableRule(line: string): boolean {
  let lead = 0
  while (line[lead] === ' ') lead++
  let body = line
  if (line[lead] === '|') {
    if (lead > 3) return false
    body = line.slice(lead + 1)
  }
  let end = body.length
  while (end > 0 && body[end - 1] === ' ') end--
  if (end > 0 && body[end - 1] === '|') end--
  return body
    .slice(0, end)
    .split('|')
    .every((cell) => RULE_CELL.test(cell))
}

// A table starts at a header row with a pipe, followed by a GFM delimiter row that has a pipe;
// a bare `---` is a thematic break.
function isTableStart(header: string, delim: string): boolean {
  return header.indexOf('|') >= 0 && delim.indexOf('|') >= 0 && delim.indexOf('-') >= 0 && isTableRule(delim)
}

function lc(s: string): string {
  return s.trim().toLowerCase()
}

function findColumn(headers: string[], name: string): number {
  const want = lc(name)
  for (let i = 0; i < headers.length; i++) if (lc(headers[i]) === want) return i
  return -1
}

type Rule = { kind: 'column' | 'check'; col: number } | { kind: 'none' }

function resolveRule(headers: string[], rule: string, firstRow: string[] | undefined): Rule | string {
  const r = rule.trim()
  if (r === '' || r === 'auto') {
    if (firstRow) {
      for (let i = 0; i < firstRow.length; i++) {
        if (firstRow[i].indexOf('[ ]') >= 0 || /\[[xX]\]/.test(firstRow[i])) return { kind: 'check', col: i }
      }
    }
    const d = findColumn(headers, 'done')
    return d >= 0 ? { kind: 'column', col: d } : { kind: 'none' }
  }
  const m = /^(column|check)=(.+)$/.exec(r)
  if (!m) return 'unknown done rule: ' + r
  const col = findColumn(headers, m[2])
  if (col < 0) return 'column not found: ' + m[2].trim()
  return { kind: m[1] as 'column' | 'check', col }
}

// The lines of a plan's text: `\r\n` and lone `\r` read as `\n`, each line cut to its first LINE_MAX
// characters, so no single line costs more than that to scan.
export function planLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => (l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l))
}

export function parsePlan(text: string, opts: ParseOptions = {}, groupMap?: GroupMapEntry[]): ParseResult {
  const lines = planLines(text)
  const fenced = fencedLines(lines)
  const headings: Heading[] = []
  const isHeading: boolean[] = []
  lines.forEach((l, i) => {
    const h = fenced[i] ? null : atxHeading(l)
    isHeading.push(h !== null)
    if (h) headings.push({ level: h.level, text: headingText(h.raw), line: i })
  })

  // Section range [from, to) in 0-based lines; the heading itself is at `from`.
  let from = 0
  let to = lines.length
  let sectionText = ''
  const want = opts.section === undefined ? '' : lc(opts.section)
  if (opts.section !== undefined && want !== '') {
    const h = headings.find((x) => x.text.toLowerCase().startsWith(want))
    if (!h) return { ok: false, error: 'section not found: ' + opts.section }
    from = h.line
    sectionText = h.text
    const next = headings.find((x) => x.line > h.line && x.level <= h.level)
    if (next) to = next.line
  }
  const inRange = headings.filter((h) => h.line >= from && h.line < to)

  // Nearest ancestor heading with a real ID, else the nearest heading (3.2), for a task on each line of
  // the range: one pass keeps the chain of ancestors (at most six, one per level) of the line.
  const groupAt: Array<Heading | undefined> = []
  {
    const chain: Array<{ h: Heading; withId: Heading | undefined }> = []
    let k = 0
    for (let i = from; i < to; i++) {
      const top = chain[chain.length - 1]
      groupAt[i] = top ? top.withId ?? top.h : undefined
      while (k < inRange.length && inRange[k].line < i) k++
      const h = inRange[k]
      if (h === undefined || h.line !== i) continue
      while (chain.length > 0 && chain[chain.length - 1].h.level >= h.level) chain.pop()
      const below = chain[chain.length - 1]
      chain.push({ h, withId: parseTaskId(h.text) !== null ? h : below?.withId })
    }
  }
  const groupFor = (line: number): Heading | undefined => groupAt[line]

  const tasks: Task[] = []
  const headingOf: Array<Heading | undefined> = []
  let doneWord = ''
  let partialWord: string | undefined
  let noDoneRule = false
  let sawChecklist = false
  let sawTable = false
  let parent: { task: Task; indent: number } | undefined

  const makeId = (firstText: string, ordinal: number): { id: string; title: string | null } => {
    const p = parseTaskId(firstText)
    return p ? { id: p.id, title: p.title } : { id: '#' + ordinal, title: null }
  }

  // A table with no done rule is prose in a section that has checklist items (3.1).
  let hasChecklist = false
  for (let i = from; i < to; i++) if (!fenced[i] && ITEM.test(lines[i])) hasChecklist = true

  for (let i = from; i < to; i++) {
    if (fenced[i]) continue
    const line = lines[i]
    if (isHeading[i]) {
      parent = undefined
      continue
    }

    const item = ITEM.exec(line)
    if (item) {
      sawChecklist = true
      const indent = item[1].length
      const checked = item[2] !== ' '
      if (parent && indent > parent.indent) {
        const sub = parent.task.sub ?? (parent.task.sub = { done: 0, total: 0 })
        sub.total++
        if (checked) sub.done++
        continue
      }
      const ordinal = tasks.length + 1
      const body = item[3]
      const got = makeId(body, ordinal)
      const task: Task = {
        id: got.id,
        title: got.title === null ? body : got.title,
        ordinal,
        line: i + 1,
        shape: 'checklist',
        status: checked ? 'done' : 'open',
        groups: [],
      }
      tasks.push(task)
      headingOf.push(groupFor(i))
      parent = { task, indent }
      continue
    }

    if (i + 1 < to && !fenced[i + 1] && isTableStart(line, lines[i + 1])) {
      parent = undefined
      const headers = splitCells(line)
      const rows: Array<{ cells: string[]; line: number }> = []
      let j = i + 2
      while (j < to && !fenced[j] && lines[j].trim() !== '' && lines[j].indexOf('|') >= 0) {
        rows.push({ cells: splitCells(lines[j]), line: j })
        j++
      }
      const rule = resolveRule(headers, opts.doneRule ?? 'auto', rows[0]?.cells)
      if (typeof rule === 'string') return { ok: false, error: rule }
      if (rule.kind === 'none' && hasChecklist) {
        i = j - 1
        continue
      }
      sawTable = true
      let partialCol = -1
      if (opts.partial !== undefined) {
        partialCol = findColumn(headers, opts.partial)
        if (partialCol < 0) return { ok: false, error: 'partial column not found: ' + opts.partial.trim() }
      }
      if (doneWord === '') {
        doneWord = rule.kind === 'none' ? 'done' : headers[rule.col]
        if (partialCol >= 0) partialWord = headers[partialCol]
      }
      if (rule.kind === 'none') noDoneRule = true
      let titleCol = findColumn(headers, 'title')
      if (titleCol < 0) titleCol = headers.length > 1 ? 1 : 0
      for (const row of rows) {
        const cell = (c: number) => row.cells[c] ?? ''
        const ordinal = tasks.length + 1
        const got = makeId(cell(0), ordinal)
        let status: Status = 'open'
        if (rule.kind === 'column' && !isEmptyCell(cell(rule.col))) status = 'done'
        else if (rule.kind === 'check' && /\[[xX]\]/.test(cell(rule.col))) status = 'done'
        else if (partialCol >= 0 && !isEmptyCell(cell(partialCol))) status = 'partial'
        tasks.push({
          id: got.id,
          title: cell(titleCol) !== '' ? cell(titleCol) : cell(0),
          ordinal,
          line: row.line + 1,
          shape: 'table',
          status,
          groups: [],
        })
        headingOf.push(groupFor(row.line))
      }
      i = j - 1
    }
  }

  if (opts.partial !== undefined && (sawChecklist || !sawTable)) {
    return { ok: false, error: 'partial column not found: ' + opts.partial.trim() }
  }
  if (doneWord === '') doneWord = 'done'

  // Heading groups, in order of first use.
  const groups: Group[] = []
  const byLine = new Map<number, number>()
  tasks.forEach((t, ti) => {
    const h = headingOf[ti]
    if (!h) return
    let gi = byLine.get(h.line)
    if (gi === undefined) {
      const p = parseTaskId(h.text)
      gi = groups.length
      byLine.set(h.line, gi)
      groups.push({ id: p ? p.id : h.text, title: p ? p.title : h.text, kind: 'heading', tasks: [] })
    }
    groups[gi].tasks.push(ti)
    t.groups.push(gi)
  })

  let finalGroups = groups
  let unmapped = 0
  const unmappedIds: string[] = []
  if (groupMap) {
    const idToTasks = new Map<string, number[]>()
    tasks.forEach((t, ti) => {
      const l = idToTasks.get(t.id)
      if (l) l.push(ti)
      else idToTasks.set(t.id, [ti])
    })
    const named = new Set<number>()
    const mapGroups: Group[] = groupMap.map((g) => {
      const members: number[] = []
      const seen = new Set<number>()
      for (const r of g.rows) {
        const hit = idToTasks.get(r)
        if (!hit) {
          unmapped++
          unmappedIds.push(r)
          continue
        }
        for (const ti of hit) {
          if (seen.has(ti)) continue
          seen.add(ti)
          members.push(ti)
        }
      }
      members.forEach((ti) => named.add(ti))
      return { id: g.id, title: g.title ?? g.id, kind: 'map', tasks: members }
    })
    const keptHeading = groups
      .map((g) => ({ ...g, tasks: g.tasks.filter((ti) => !named.has(ti)) }))
      .filter((g) => g.tasks.length > 0)
    finalGroups = [...mapGroups, ...keptHeading]
    tasks.forEach((t) => (t.groups = []))
    finalGroups.forEach((g, gi) => g.tasks.forEach((ti) => tasks[ti].groups.push(gi)))
  }

  const counts = { done: 0, partial: 0, open: 0, total: tasks.length }
  for (const t of tasks) counts[t.status]++

  return {
    ok: true,
    plan: { section: sectionText, tasks, groups: finalGroups, counts, doneWord, partialWord, noDoneRule, unmapped, unmappedIds },
  }
}

export function parseGroupMap(text: string): { ok: true; groups: GroupMapEntry[] } | { ok: false; error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: 'group map is not JSON: ' + (err instanceof Error ? err.message : String(err)) }
  }
  const list = (data as { groups?: unknown } | null)?.groups
  if (!Array.isArray(list)) return { ok: false, error: 'group map has no groups[]' }
  const groups: GroupMapEntry[] = []
  for (let i = 0; i < list.length; i++) {
    const g = list[i] as { id?: unknown; rows?: unknown; title?: unknown } | null
    if (!g || typeof g.id !== 'string') return { ok: false, error: 'group map: groups[' + i + '] has no string id' }
    if (!Array.isArray(g.rows) || g.rows.some((r) => typeof r !== 'string')) {
      return { ok: false, error: 'group map: groups[' + i + '] rows is not a string array' }
    }
    const entry: GroupMapEntry = { id: g.id, rows: g.rows as string[] }
    if (typeof g.title === 'string') entry.title = g.title
    groups.push(entry)
  }
  return { ok: true, groups }
}

function longestFirst(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out.sort((a, b) => b.length - a.length)
}

// The IDs agent matching (4.3) may search for: the plan's own, never a regex.
export function candidateIds(plan: Plan): { taskIds: string[]; groupIds: string[] } {
  return {
    taskIds: longestFirst(plan.tasks.map((t) => t.id)),
    groupIds: longestFirst(plan.groups.filter((g) => !g.own).map((g) => g.id)),
  }
}
