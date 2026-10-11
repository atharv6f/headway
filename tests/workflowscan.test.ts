import { expect, test } from 'claude-code/testing'
import { parseWorkflow, scan } from '../plugin/hooks/workflow.ts'
import type { Span } from '../plugin/hooks/workflow.ts'
import * as flow from './fixtures/flow.ts'

// The script scanner is one forward pass: its time is linear in the script, whatever the nesting.
// `referenceScan` below is the earlier recursive scanner, kept here only as the oracle for the
// differential tests; it is quadratic on an unclosed `${` nesting and is never run on large input.

const REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^'
const REGEX_AFTER_WORDS = ['return', 'typeof', 'await', 'yield', 'case', 'in', 'of', 'void', 'delete']

function referenceScan(src: string): { masked: string; spans: Map<number, Span> } {
  const out = src.split('')
  const spans = new Map<number, Span>()
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }

  // Scans code from i until the end of the text, or, when `untilBrace`, the `}` that closes it.
  function code(i: number, untilBrace: boolean): number {
    let depth = 0
    let last = '' // last significant character of the masked code
    let lastWord = ''
    while (i < src.length) {
      const ch = src[i]
      const next = src[i + 1]
      if (ch === '/' && next === '/') {
        let j = i
        while (j < src.length && src[j] !== '\n') j++
        blank(i, j)
        i = j
        continue
      }
      if (ch === '/' && next === '*') {
        const j = src.indexOf('*/', i + 2)
        const end = j < 0 ? src.length : j + 2
        blank(i, end)
        i = end
        continue
      }
      if (ch === "'" || ch === '"') {
        let j = i + 1
        while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
        const end = Math.min(j + 1, src.length)
        spans.set(i, { start: i, end, quote: ch, exprs: [] })
        blank(i + 1, end - 1)
        i = end
        last = ch
        lastWord = ''
        continue
      }
      if (ch === '`') {
        const span: Span = { start: i, end: src.length, quote: '`', exprs: [] }
        let j = i + 1
        while (j < src.length) {
          if (src[j] === '\\') {
            j += 2
            continue
          }
          if (src[j] === '`') break
          if (src[j] === '$' && src[j + 1] === '{') {
            const close = code(j + 2, true)
            span.exprs.push([j, close])
            j = close
            continue
          }
          j++
        }
        span.end = Math.min(j + 1, src.length)
        spans.set(i, span)
        blank(i + 1, span.end - 1)
        i = span.end
        last = '`'
        lastWord = ''
        continue
      }
      if (ch === '/') {
        const after = last === '' || REGEX_AFTER.indexOf(last) >= 0 || REGEX_AFTER_WORDS.indexOf(lastWord) >= 0
        if (after) {
          let j = i + 1
          let inClass = false
          while (j < src.length && src[j] !== '\n') {
            if (src[j] === '\\') j++
            else if (src[j] === '[') inClass = true
            else if (src[j] === ']') inClass = false
            else if (src[j] === '/' && !inClass) break
            j++
          }
          const end = Math.min(j + 1, src.length)
          blank(i + 1, end - 1)
          i = end
          last = '/'
          lastWord = ''
          continue
        }
      }
      if (untilBrace) {
        if (ch === '{') depth++
        else if (ch === '}') {
          if (depth === 0) {
            return i + 1
          }
          depth--
        }
      }
      if (/\s/.test(ch)) {
        i++
        continue
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i
        while (j < src.length && /[\w$]/.test(src[j])) j++
        lastWord = src.slice(i, j)
        last = 'a'
        i = j
        continue
      }
      last = ch
      lastWord = ''
      i++
    }
    return src.length
  }

  code(0, false)
  // Template substitutions are blanked whole: nothing in them is code to this parser. A nested
  // template's substitution lies inside its outer one, so each character is blanked once.
  const exprs: Array<[number, number]> = []
  spans.forEach((s) => exprs.push(...s.exprs))
  exprs.sort((x, y) => x[0] - y[0])
  let blanked = 0
  for (const [a, b] of exprs) {
    blank(Math.max(a, blanked), b)
    blanked = Math.max(blanked, b)
  }
  const masked = out.join('')
  return { masked, spans }
}

const CAP = 256 * 1024 // the script cap
const BUDGET_MS = 200

function timed<T>(f: () => T): number {
  const at = performance.now()
  f()
  return performance.now() - at
}

function sized(unit: string, tail = ''): string {
  return unit.repeat(Math.ceil((CAP - tail.length) / unit.length)).slice(0, CAP - tail.length) + tail
}

// `depth` unclosed substitutions, then plain text up to the cap
function nested(depth: number, unit = '`${'): string {
  return unit.repeat(depth) + 'x'.repeat(CAP - unit.length * depth)
}

const WORST: Array<[string, string]> = [
  ['unclosed ${ nesting', sized('`${')],
  ['unclosed ${ nesting, 1000 deep, then text', nested(1000)],
  ['unclosed ${ nesting, 3000 deep, then text', nested(3000)],
  ['unclosed ${ nesting, 3000 deep, then closers', '`${'.repeat(3000) + 'x'.repeat(CAP - 15000) + '}`'.repeat(3000)],
  ['unclosed ${ nesting, then quoted text', nested(2000, "`${'") ],
  ['unclosed ${ nesting with text between', sized('`a${b')],
  ['unclosed ${ nesting through strings', sized("`${'x'")],
  ['deep template nesting, closed', '`${'.repeat(40000) + 'x'.repeat(CAP - 200000) + '}`'.repeat(40000)],
  ['deep expression braces', '`${' + '{'.repeat(CAP - 3)],
  ['many unclosed single quotes', sized("'a\n")],
  ['many unclosed double quotes', sized('"a\n')],
  ['many unclosed quotes on one line', sized("'")],
  ['many unclosed block comments', sized('/*')],
  ['many unclosed block comments in expressions', sized('`${/*')],
  ['many line comments', sized('// a\n')],
  ['many unclosed regex literals', sized('(/[\n')],
  ['many unclosed templates', sized('`\\')],
  ['many empty substitutions', '`' + '${}'.repeat(Math.floor((CAP - 2) / 3)).padEnd(CAP - 2, ' ') + '`'],
  ['unclosed agent calls', sized('agent(')],
]

for (const [name, script] of WORST) {
  test(`linear: ${name} at 256 KiB scans in under ${BUDGET_MS} ms`, async () => {
    expect(script.length).toBe(CAP)
    expect(timed(() => scan(script))).toBeLessThan(BUDGET_MS)
    expect(timed(() => parseWorkflow(script))).toBeLessThan(BUDGET_MS)
  })
}

// ---------------------------------------------------------------- differential

function same(src: string): void {
  const a = referenceScan(src)
  const b = scan(src)
  expect(b.masked).toBe(a.masked)
  const view = (m: Map<number, Span>) => JSON.stringify(Array.from(m.entries()))
  expect(view(b.spans)).toBe(view(a.spans))
}

const SCRIPTS: string[] = [
  flow.text,
  flow.objects,
  flow.bare,
  `export const meta = { name: 'probe', description: "two 'phases'", phases: ['Build', 'Verify'] }; phase('Build'); const a = await agent('ok', { label: \`n \${i + 1} \${\`in \${deep}\`}\`, model: 'haiku' }) // tail`,
  'const re = /a[/]b\\/c/g; const x = a / b / c; return /*c*/ `t${ {a: 1}.a }u`',
  'const s = `a${`b${`c`}`}d` + "e\\"f" + \'g\'\n/* block\n over lines */ agent(`x`)',
]

test('differential: the existing workflow fixtures scan as the recursive scanner did', async () => {
  for (const s of SCRIPTS) same(s)
})

test('differential: every prefix of the fixtures scans as the recursive scanner did', async () => {
  for (const s of SCRIPTS) for (let k = 0; k <= s.length; k++) same(s.slice(0, k))
})

const PIECES = [
  "'", '"', '`', '`', '${', '${', '}', '}', '{', '(', ')', '[', ']', '/', '/', '//', '/*', '*/', '\\', '\n', ' ',
  'a', 'x1', 'agent', 'return', 'typeof', 'in', ',', ';', '=', ':', '+', '$', '1', '*',
]

test('differential: random short scripts scan as the recursive scanner did', async () => {
  let seed = 20240607
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % n
  }
  for (let t = 0; t < 20000; t++) {
    let s = ''
    for (let k = rand(40); k > 0; k--) s += PIECES[rand(PIECES.length)]
    same(s)
  }
})
