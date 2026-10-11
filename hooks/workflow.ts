// Workflow script parser (pure). SPEC.md 4.2: textual, never an evaluator. The script is scanned
// once to mask strings, templates, comments and regex literals, so brackets and `agent(` are found
// on code only; values are then read back from the original text by offset.

export type Value =
  | { kind: 'literal'; value: string } // a plain string, or a template without substitutions
  | { kind: 'pattern'; value: string } // a template literal, each `${...}` replaced by `*`
  | { kind: 'dynamic' } // anything else

export interface PlannedCall {
  ordinal: number // 1-based, source order (matches agentIndex in a sequential script)
  label?: Value
  phase?: Value
  model?: Value
  effort?: Value
  hasModel: boolean // the options object has a `model:` key
  hasEffort: boolean
  dynamic: boolean // the options are not a plain object literal (a variable, a call, a spread): their keys are unknown
  nesting: string[] // enclosing `parallel` / `pipeline` calls, outermost first; at most NESTING_MAX
}

export interface ParsedWorkflow {
  name?: string
  description?: string
  phases: string[]
  calls: PlannedCall[]
}

export interface Span {
  start: number // index of the opening quote
  end: number // index just past the closing quote
  quote: string
  exprs: Array<[number, number]> // template substitutions, `${` .. `}` inclusive
}

export interface Scanned {
  masked: string // same length as the source; literal contents and comments blanked
  spans: Map<number, Span> // by start index
  close: Int32Array // by index of an opening bracket in `masked`: the index of the bracket closing it, else -1
}

const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^'
const REGEX_AFTER_WORDS = ['return', 'typeof', 'await', 'yield', 'case', 'in', 'of', 'void', 'delete']

export function scan(src: string): Scanned {
  const n = src.length
  const out = src.split('')
  const spans = new Map<number, Span>()
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' '
  }

  // One forward pass, never back: `stack` holds what is open, innermost last. Element 0 is the
  // top-level code. Above it come template literals and, inside each, the code of a `${` substitution.
  // Everything in a template is blanked with it, so only a literal, comment or regex outside every
  // template, and the outermost template with its substitutions, are blanked here.
  interface Code {
    code: true
    dollar: number // index of the `$` that opened this substitution (unused for the top level)
    depth: number // `{` open in this substitution
    last: string // last significant character of the masked code
    lastWord: string
  }
  interface Template {
    code: false
    span: Span
  }
  const stack: Array<Code | Template> = [{ code: true, dollar: -1, depth: 0, last: '', lastWord: '' }]

  // The template on top of the stack ends at `end`.
  const closeTemplate = (end: number) => {
    const { span } = stack.pop() as Template
    span.end = end
    spans.set(span.start, span)
    if (stack.length === 1) {
      blank(span.start + 1, end - 1)
      for (const [a, b] of span.exprs) blank(a, b)
    }
    const outer = stack[stack.length - 1] as Code
    outer.last = '`'
    outer.lastWord = ''
  }

  let i = 0
  while (i < n) {
    const top = stack[stack.length - 1]
    const ch = src[i]
    if (!top.code) {
      if (ch === '\\') i += 2
      else if (ch === '`') {
        closeTemplate(Math.min(i + 1, n))
        i = Math.min(i + 1, n)
      } else if (ch === '$' && src[i + 1] === '{') {
        stack.push({ code: true, dollar: i, depth: 0, last: '', lastWord: '' })
        i += 2
      } else i++
      continue
    }
    const outside = stack.length === 1 // not inside any template
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      if (outside) blank(i, j)
      i = j
      continue
    }
    if (ch === '/' && next === '*') {
      const j = src.indexOf('*/', i + 2)
      const end = j < 0 ? n : j + 2
      if (outside) blank(i, end)
      i = end
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < n && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      const end = Math.min(j + 1, n)
      spans.set(i, { start: i, end, quote: ch, exprs: [] })
      if (outside) blank(i + 1, end - 1)
      i = end
      top.last = ch
      top.lastWord = ''
      continue
    }
    if (ch === '`') {
      stack.push({ code: false, span: { start: i, end: n, quote: '`', exprs: [] } })
      i++
      continue
    }
    if (ch === '/') {
      const after = top.last === '' || REGEX_AFTER.indexOf(top.last) >= 0 || REGEX_AFTER_WORDS.indexOf(top.lastWord) >= 0
      if (after) {
        let j = i + 1
        let inClass = false
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') j++
          else if (src[j] === '[') inClass = true
          else if (src[j] === ']') inClass = false
          else if (src[j] === '/' && !inClass) break
          j++
        }
        const end = Math.min(j + 1, n)
        if (outside) blank(i + 1, end - 1)
        i = end
        top.last = '/'
        top.lastWord = ''
        continue
      }
    }
    if (!outside) {
      if (ch === '{') top.depth++
      else if (ch === '}') {
        if (top.depth === 0) {
          // the substitution ends: back to the template around it
          stack.pop()
          ;(stack[stack.length - 1] as Template).span.exprs.push([top.dollar, i + 1])
          i++
          continue
        }
        top.depth--
      }
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < n && /[\w$]/.test(src[j])) j++
      top.lastWord = src.slice(i, j)
      top.last = 'a'
      i = j
      continue
    }
    top.last = ch
    top.lastWord = ''
    i++
  }
  // The text ended inside templates and substitutions: each closes at the end, innermost first.
  while (stack.length > 1) {
    const top = stack[stack.length - 1]
    if (top.code) {
      stack.pop()
      ;(stack[stack.length - 1] as Template).span.exprs.push([top.dollar, n])
    } else closeTemplate(n)
  }
  const masked = out.join('')
  return { masked, spans, close: closings(masked) }
}

// The bracket closing each opening one, in one pass with a stack. A closer that does not match the
// innermost open bracket leaves every bracket open at that point unclosed, as does the end of the text.
function closings(masked: string): Int32Array {
  const close = new Int32Array(masked.length).fill(-1)
  const stack: number[] = []
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]
    if (pairs[ch] !== undefined) stack.push(i)
    else if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop()
      if (open === undefined) continue
      if (pairs[masked[open]] === ch) close[open] = i
      else stack.length = 0
    }
  }
  return close
}

// Index of the bracket closing the one at `open` (masked text), or -1.
function closeOf(sc: Scanned, open: number): number {
  return sc.close[open] ?? -1
}

// Top-level comma-separated pieces of (from, to), as [start, end) index pairs, blanks trimmed. A
// closed bracket is stepped over whole, so each piece of nested text is walked by its own call only.
function splitTop(sc: Scanned, from: number, to: number): Array<[number, number]> {
  const masked = sc.masked
  const pieces: Array<[number, number]> = []
  let depth = 0
  let start = from
  const push = (a: number, b: number) => {
    while (a < b && /\s/.test(masked[a])) a++
    while (b > a && /\s/.test(masked[b - 1])) b--
    if (b > a) pieces.push([a, b])
  }
  for (let i = from; i < to; i++) {
    const ch = masked[i]
    if (ch === '(' || ch === '[' || ch === '{') {
      const end = sc.close[i]
      if (depth === 0 && end > i && end < to) i = end
      else depth++
    } else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      push(start, i)
      start = i + 1
    }
  }
  push(start, to)
  return pieces
}

function unescape(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, c: string) => {
    if (c[0] === 'u' && c.length > 1) return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ''), 16))
    if (c[0] === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16))
    if (c === 'n') return '\n'
    if (c === 't') return '\t'
    if (c === 'r') return '\r'
    if (c === '\n') return ''
    return c
  })
}

// The Value of the source text [a, b): one string or template literal, else dynamic.
function valueOf(src: string, sc: Scanned, a: number, b: number): Value {
  const span = sc.spans.get(a)
  if (!span || span.end !== b) return { kind: 'dynamic' }
  if (span.quote !== '`') return { kind: 'literal', value: unescape(src.slice(a + 1, b - 1)) }
  if (span.exprs.length === 0) return { kind: 'literal', value: src.slice(a + 1, b - 1) }
  let raw = ''
  let at = a + 1
  for (const [x, y] of span.exprs) {
    raw += src.slice(at, x) + '*'
    at = y
  }
  raw += src.slice(at, b - 1)
  return { kind: 'pattern', value: raw }
}

interface Entry {
  key: string | null // null: a spread or a computed key
  valueStart: number
  valueEnd: number
}

const KEY = /[A-Za-z_$][\w$]*/y

// The entries of the object literal whose braces are at [open, close].
function entriesOf(src: string, sc: Scanned, open: number, close: number): Entry[] {
  const entries: Entry[] = []
  for (const [a, b] of splitTop(sc, open + 1, close)) {
    if (sc.masked.startsWith('...', a) || sc.masked[a] === '[') {
      entries.push({ key: null, valueStart: a, valueEnd: b })
      continue
    }
    let key: string | undefined
    let after: number
    const quoted = sc.spans.get(a)
    if (quoted && (quoted.quote === "'" || quoted.quote === '"')) {
      key = unescape(src.slice(a + 1, quoted.end - 1))
      after = quoted.end
    } else {
      KEY.lastIndex = a
      const m = KEY.exec(sc.masked)
      if (!m || m.index + m[0].length > b) {
        entries.push({ key: null, valueStart: a, valueEnd: b })
        continue
      }
      key = m[0]
      after = a + m[0].length
    }
    while (after < b && /\s/.test(sc.masked[after])) after++
    if (after >= b) {
      entries.push({ key, valueStart: a, valueEnd: a }) // shorthand `{ label }`: the value is a variable
    } else if (sc.masked[after] === ':') {
      let v = after + 1
      while (v < b && /\s/.test(sc.masked[v])) v++
      entries.push({ key, valueStart: v, valueEnd: b })
    } else {
      entries.push({ key: null, valueStart: a, valueEnd: b }) // a method shorthand or something else
    }
  }
  return entries
}

function openBrace(sc: Scanned, a: number, b: number): number {
  return sc.masked[a] === '{' && closeOf(sc, a) === b - 1 ? a : -1
}

// A `meta.phases` entry: a string literal, or an object whose `title:` is one. Else nothing.
function phaseTitle(src: string, sc: Scanned, a: number, b: number): string | undefined {
  if (sc.masked[a] === '{') {
    if (closeOf(sc, a) !== b - 1) return undefined
    const title = entriesOf(src, sc, a, b - 1).find((e) => e.key === 'title')
    const v = title ? valueOf(src, sc, title.valueStart, title.valueEnd) : undefined
    return v?.kind === 'literal' ? v.value : undefined
  }
  const v = valueOf(src, sc, a, b)
  return v.kind === 'literal' ? v.value : undefined
}

function parseMeta(src: string, sc: Scanned): Pick<ParsedWorkflow, 'name' | 'description' | 'phases'> {
  const out: Pick<ParsedWorkflow, 'name' | 'description' | 'phases'> = { phases: [] }
  const m = /\bmeta\s*=\s*\{/.exec(sc.masked)
  if (!m) return out
  const open = m.index + m[0].length - 1
  const close = closeOf(sc, open)
  if (close < 0) return out
  for (const e of entriesOf(src, sc, open, close)) {
    if (e.key === 'name' || e.key === 'description') {
      const v = valueOf(src, sc, e.valueStart, e.valueEnd)
      if (v.kind === 'literal') out[e.key] = v.value
    } else if (e.key === 'phases' && sc.masked[e.valueStart] === '[') {
      const end = closeOf(sc, e.valueStart)
      if (end < 0) continue
      for (const [a, b] of splitTop(sc, e.valueStart + 1, end)) {
        const v = phaseTitle(src, sc, a, b)
        if (v !== undefined) out.phases.push(v)
      }
    }
  }
  return out
}

interface Combinator {
  name: string
  open: number
  close: number
}

// `nesting` names at most this many enclosing calls, so a deeply nested script costs no more than
// this per call; only whether there are any is acted on.
const NESTING_MAX = 8

// Never throws: a script that cannot be read gives what was read before the fault. An escape that
// is not a code point (`\u{110000}`) makes its agent() call dynamic; one in `meta` is skipped.
export function parseWorkflow(script: string): ParsedWorkflow {
  const result: ParsedWorkflow = { phases: [], calls: [] }
  try {
    parseInto(script, result)
  } catch {
    // a malformed script: keep the calls read so far
  }
  return result
}

function parseInto(script: string, result: ParsedWorkflow): void {
  const sc = scan(script)
  const masked = sc.masked
  try {
    Object.assign(result, parseMeta(script, sc))
  } catch {
    result.phases = []
  }

  const callRe = /(?<![\w$.])(agent|parallel|pipeline)\s*\(/g
  const found: Combinator[] = []
  for (let m = callRe.exec(masked); m !== null; m = callRe.exec(masked)) {
    const open = m.index + m[0].length - 1
    const close = closeOf(sc, open)
    if (close < 0) continue
    found.push({ name: m[1], open, close })
  }

  const statements = phaseStatements(script, sc)
  let stmt = 0 // statements before the current call: they are in source order, as the calls are
  // The parallel and pipeline calls around the current one, outermost first. Brackets nest, so in
  // source order the enclosing calls are a stack: one that closed before this call opens is left.
  const around: Combinator[] = []
  for (const f of found) {
    while (around.length > 0 && around[around.length - 1].close < f.open) around.pop()
    if (f.name !== 'agent') {
      around.push(f)
      continue
    }
    const args = splitTop(sc, f.open + 1, f.close)
    const call: PlannedCall = {
      ordinal: result.calls.length + 1,
      hasModel: false,
      hasEffort: false,
      dynamic: false,
      nesting: around.slice(0, NESTING_MAX).map((c) => c.name),
    }
    if (args.length > 1) {
      const [a, b] = args[args.length - 1]
      const brace = openBrace(sc, a, b)
      if (brace < 0) call.dynamic = true
      else {
        try {
          for (const e of entriesOf(script, sc, brace, b - 1)) {
            if (e.key === null) {
              call.dynamic = true
              continue
            }
            if (e.key !== 'label' && e.key !== 'phase' && e.key !== 'model' && e.key !== 'effort') continue
            call[e.key] = valueOf(script, sc, e.valueStart, e.valueEnd)
            if (e.key === 'model') call.hasModel = true
            if (e.key === 'effort') call.hasEffort = true
          }
        } catch {
          call.dynamic = true
        }
      }
    }
    while (stmt < statements.length && statements[stmt].open < f.open) stmt++
    if (call.phase === undefined) {
      const last = statements[stmt - 1]
      if (last?.value.kind === 'literal') call.phase = last.value
    }
    result.calls.push(call)
  }
}

interface PhaseStatement {
  open: number
  value: Value
}

// The `phase('name')` statements, in source order, by which a later agent() call with no `phase:`
// option is attributed to the last one before it. Only while that is certain: every phase() call is
// at the top level (no bracket around it), and the script defines no function, whose body may run
// in another order. Otherwise none, and those calls stay unattributed.
function phaseStatements(src: string, sc: Scanned): PhaseStatement[] {
  const masked = sc.masked
  if (/\bfunction\b/.test(masked)) return []
  const out: PhaseStatement[] = []
  const re = /(?<![\w$.])phase\s*\(/g
  let depth = 0
  let at = 0
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    for (; at < m.index; at++) {
      const ch = masked[at]
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
    }
    if (depth !== 0) return []
    const open = m.index + m[0].length - 1
    const close = closeOf(sc, open)
    if (close < 0) return []
    const args = splitTop(sc, open + 1, close)
    out.push({ open, value: args.length === 0 ? { kind: 'dynamic' } : valueOf(src, sc, args[0][0], args[0][1]) })
  }
  return out
}
