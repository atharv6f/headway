// Independent counting over fixture text. Deliberately shares no code with hooks/plan.ts.

const EMPTY = ['', '-', '–', '—', '[ ]']

export function isEmpty(cell: string): boolean {
  return EMPTY.indexOf(cell.trim()) >= 0
}

export function tableCells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

export interface CountedRow { id: string; cells: Record<string, string> }

// Rows of the first table inside the `### <heading>` section of a generated plan.
export function sectionTable(text: string, headingPrefix: string): { headers: string[]; rows: CountedRow[] } {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('### ' + headingPrefix))
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('### ')) { end = i; break }
  }
  const body = lines.slice(start + 1, end).filter((l) => l.startsWith('|'))
  const headers = tableCells(body[0]).map((h) => h.toLowerCase())
  const rows = body.slice(2).map((l) => {
    const c = tableCells(l)
    const cells: Record<string, string> = {}
    headers.forEach((h, i) => { cells[h] = c[i] ?? '' })
    return { id: c[0], cells }
  })
  return { headers, rows }
}

export interface CountedItem { text: string; checked: boolean; group: string | null }

// Top-level checklist items (smallest indent seen) with the last `### Task n` heading above each.
// Lines inside fenced code blocks (``` or ~~~) are skipped.
export function checklistItems(text: string): CountedItem[] {
  const out: CountedItem[] = []
  let group: string | null = null
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const f = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence !== null) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null
      continue
    }
    if (f) {
      fence = f[1]
      continue
    }
    const h = line.match(/^### (Task \d+):/)
    if (h) group = h[1]
    const m = line.match(/^( *)[-*] \[([ xX])\] (.*)$/)
    if (m && m[1].length === 0) out.push({ text: m[3], checked: m[2] !== ' ', group })
  }
  return out
}

export interface CountedStep { children: number; group: string }

// Plan-mode steps (SPEC 4.4) for the plan fixtures, by a different route than hooks/planmode.ts:
// fenced blocks cut out first, the text split into heading sections, the skipped sections dropped,
// then the shape that finds the most (numbered at column 0, headings of bullets, checklist outside
// the check sections; ties in that order), else the checklist with the check sections.
export function planModeSteps(text: string): { title: string | null; steps: CountedStep[] } {
  const unfenced = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
  const sections: Array<{ heading: string; level: number; body: string[] }> = [{ heading: '', level: 0, body: [] }]
  for (const line of unfenced.split('\n')) {
    const h = line.match(/^(#+) (.*)$/)
    if (h) sections.push({ heading: h[2].trim(), level: h[1].length, body: [] })
    else sections[sections.length - 1].body.push(line)
  }
  const top = sections.find((s) => s.level === 1)
  const title = top ? top.heading.replace(/^plan:\s*/i, '') : null
  const META = 'context|background|summary|overview|goal|goals|files|critical files|key files|risks|risk|out of scope|non goals|notes|open questions|questions|alternatives|assumptions|dependencies|verification|testing|test plan|acceptance|acceptance criteria|done when|rollback|references'.split('|')
  const plain = (h: string) => h.toLowerCase().replace(/^\d+(\.\d+)*[.)]?\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim()
  // a meta section runs to the next heading of its level or higher
  let metaLevel = 0
  const kept = sections.filter((s) => {
    if (metaLevel > 0 && s.level > 0 && s.level <= metaLevel) metaLevel = 0
    if (metaLevel === 0 && s !== top && META.includes(plain(s.heading))) metaLevel = s.level
    return metaLevel === 0
  })
  const groupOf = (heading: string) => {
    const m = heading.match(/^(Phase|Step|Part|Stage) \d+/)
    return m ? m[0] : heading
  }

  const shapes = (from: typeof sections): CountedStep[] => {
    const checks: CountedStep[] = []
    for (const s of from) {
      for (const line of s.body) {
        if (/^[-*] \[[ xX]\] /.test(line)) checks.push({ children: 0, group: groupOf(s.heading) })
        else if (/^\s+[-*] \[[ xX]\] /.test(line) && checks.length > 0) checks[checks.length - 1].children++
      }
    }
    if (checks.length > 0) return checks
    const numbered: CountedStep[] = []
    for (const s of from) {
      let open = false
      for (const line of s.body) {
        if (/^\d+[.)] /.test(line)) {
          numbered.push({ children: 0, group: groupOf(s.heading) })
          open = true
        } else if (open && /^\s+(\d+[.)]|[-*]) /.test(line)) numbered[numbered.length - 1].children++
      }
    }
    if (numbered.length > 0) return numbered
    const heads: CountedStep[] = []
    for (const s of from) {
      if (s.level < 2 || s.level > 4) continue
      const bullets = s.body.filter((l) => /^\s*[-*] /.test(l)).length
      if (bullets > 0) heads.push({ children: bullets, group: title ?? '' })
    }
    if (heads.length > 0) return heads
    // headings that carry an id hold steps even with prose only
    return from
      .filter((s) => s.level >= 2 && s.level <= 4 && /^(\d+[.)] |(step|task|phase|stage|part|milestone|item) \d|[a-z][a-z0-9]*\d)/i.test(s.heading))
      .map(() => ({ children: 0, group: title ?? '' }))
  }
  const best = shapes(kept)
  return { title, steps: best.length > 0 ? best : shapes(sections) }
}
