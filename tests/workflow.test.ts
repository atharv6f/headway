import { expect, test } from 'claude-code/testing'
import { parseWorkflow } from '../plugin/hooks/workflow.ts'
import type { PlannedCall, Value } from '../plugin/hooks/workflow.ts'

const lit = (value: string): Value => ({ kind: 'literal', value })
const pat = (value: string): Value => ({ kind: 'pattern', value })
const DYN: Value = { kind: 'dynamic' }

// The probe script of Milestone 0 check 1.
const PROBE = `export const meta = { name: 'wpm0-probe', description: 'probe', phases: ['Build', 'Verify'] }; phase('Build'); const a = await agent('Reply with the word ok and nothing else.', { label: 'UI3 residual grep', phase: 'Build', model: 'haiku', effort: 'low' }); phase('Verify'); const b = await agent('Reply with the word ok and nothing else.', { label: 'R02-73 case read', phase: 'Verify', model: 'haiku', effort: 'low' }); return [a, b]`

test('meta: name, description and the phases array', async () => {
  const w = parseWorkflow(PROBE)
  expect(w.name).toBe('wpm0-probe')
  expect(w.description).toBe('probe')
  expect(w.phases).toEqual(['Build', 'Verify'])
})

test('meta: double quotes, multi-line, trailing commas, a comment, no meta at all', async () => {
  const w = parseWorkflow(`
// the header
export const meta = {
  name: "release-train", // inline
  description: 'two "phases"',
  phases: [
    "Scan",
    'Verify', // last
  ],
}
`)
  expect(w).toMatchObject({ name: 'release-train', description: 'two "phases"', phases: ['Scan', 'Verify'] })
  const none = parseWorkflow(`await agent('x', { label: 'a', model: 'haiku', effort: 'low' })`)
  expect(none.name).toBe(undefined)
  expect(none.phases).toEqual([])
  expect(none.calls.length).toBe(1)
})

test('every agent() call: label, phase, model, effort, in source order with a 1-based ordinal', async () => {
  const w = parseWorkflow(PROBE)
  expect(w.calls.length).toBe(2)
  expect(w.calls[0]).toMatchObject({
    ordinal: 1, label: lit('UI3 residual grep'), phase: lit('Build'), model: lit('haiku'), effort: lit('low'),
    hasModel: true, hasEffort: true, dynamic: false, nesting: [],
  })
  expect(w.calls[1]).toMatchObject({ ordinal: 2, label: lit('R02-73 case read'), phase: lit('Verify') })
})

test('a call without model or effort, or without any options, says so', async () => {
  const w = parseWorkflow(`
export const meta = { name: 'w', description: 'd', phases: ['P'] }
await agent('one', { label: 'no model', phase: 'P', effort: 'high' })
await agent('two', { label: 'no effort', model: 'sonnet' })
await agent('three')
await agent('four', { label: 'both', model: 'haiku', effort: 'low' })
`)
  const [a, b, c, d] = w.calls
  expect(a).toMatchObject({ hasModel: false, hasEffort: true, dynamic: false })
  expect(b).toMatchObject({ hasModel: true, hasEffort: false, dynamic: false })
  expect(c).toMatchObject({ hasModel: false, hasEffort: false, dynamic: false })
  expect(c.label).toBe(undefined)
  expect(d).toMatchObject({ hasModel: true, hasEffort: true })
})

test('template-literal labels are patterns with each substitution replaced by *', async () => {
  const w = parseWorkflow(
    'await agent(`p ${x}`, { label: `scan ${item.id} of ${n}`, phase: `Build`, model: `haiku`, effort: "low" })',
  )
  expect(w.calls[0]).toMatchObject({ label: pat('scan * of *'), phase: lit('Build'), model: lit('haiku'), effort: lit('low') })
  // a nested template inside a substitution is one substitution
  const nested = parseWorkflow('await agent("p", { label: `a ${ `b ${c}` } d`, model: "haiku", effort: "low" })')
  expect(nested.calls[0].label).toEqual(pat('a * d'))
})

test('parallel and pipeline nesting is recorded outermost first', async () => {
  const w = parseWorkflow(`
export const meta = { name: 'n', description: 'd', phases: ['A'] }
await agent('top', { label: 'top', model: 'haiku', effort: 'low' })
await parallel([
  () => agent('p1', { label: 'p1', model: 'haiku', effort: 'low' }),
  () => agent('p2', { label: 'p2', model: 'haiku', effort: 'low' }),
])
await pipeline(items, (i) => agent('s1', { label: 's1 ' + i, model: 'haiku', effort: 'low' }),
  (r) => parallel([() => agent('s2', { label: 's2', model: 'haiku', effort: 'low' })]))
`)
  const nest = (c: PlannedCall) => c.nesting.join('>')
  expect(w.calls.map((c) => c.ordinal)).toEqual([1, 2, 3, 4, 5])
  expect(w.calls.map(nest)).toEqual(['', 'parallel', 'parallel', 'pipeline', 'pipeline>parallel'])
  // `s1 ' + i` is a concatenation, not a literal
  expect(w.calls[3].label).toEqual(DYN)
})

test('dynamic options: a variable, a spread, a call, a computed value', async () => {
  const w = parseWorkflow(`
await agent('a', opts)
await agent('b', { ...base, label: 'b' })
await agent('c', makeOpts('c'))
await agent('d', { label: name, phase: P, model: pick(), effort: 'low' })
await agent('e', { label, model: 'haiku', effort: 'low' })
`)
  const [a, b, c, d, e] = w.calls
  // the whole options object is unknown: nothing is claimed about model or effort
  expect(a).toMatchObject({ dynamic: true, hasModel: false, hasEffort: false })
  expect(b).toMatchObject({ dynamic: true, label: lit('b') })
  expect(c.dynamic).toBe(true)
  // a literal object with dynamic values: the keys are known, the values are `dynamic`
  expect(d).toMatchObject({ dynamic: false, label: DYN, phase: DYN, model: DYN, effort: lit('low'), hasModel: true, hasEffort: true })
  // shorthand `label` is a dynamic value
  expect(e).toMatchObject({ dynamic: false, label: DYN, hasModel: true })
})

test('strings, comments and regexes never fake a call, a brace or a key', async () => {
  const w = parseWorkflow(`
// await agent('commented', { label: 'no' })
/* await agent('block', { label: 'no' }) */
const s = "agent('in a string', { label: 'no' })"
const t = \`agent('in a template', { label: 'no' }) \${ '}' }\`
const r = /agent\\(["'{]/g
await agent('real ) } ( {', { label: 'real {x}', model: 'haiku', effort: 'low' })
obj.agent('a member call', { label: 'no' })
`)
  expect(w.calls.length).toBe(1)
  expect(w.calls[0]).toMatchObject({ label: lit('real {x}'), hasModel: true })
})

test('escapes in a string literal are decoded', async () => {
  const w = parseWorkflow(`await agent('p', { label: 'it\\'s\\n"ok"', model: 'haiku', effort: 'low' })`)
  expect(w.calls[0].label).toEqual(lit('it\'s\n"ok"'))
})

test('a script that is not a script yields no calls and does not throw', async () => {
  expect(parseWorkflow('').calls).toEqual([])
  expect(parseWorkflow('agent(').calls.length).toBe(0)
  expect(parseWorkflow('export const meta = { name: ').name).toBe(undefined)
  expect(parseWorkflow("await agent('x', { label: 'unterminated").calls.length).toBe(0)
})

test('the script is never evaluated', async () => {
  const w = parseWorkflow(`globalThis.__wp_evaluated = true; await agent('x', { label: (globalThis.__wp_evaluated2 = 'y'), model: 'haiku', effort: 'low' })`)
  expect((globalThis as Record<string, unknown>).__wp_evaluated).toBe(undefined)
  expect(w.calls[0].label).toEqual(DYN)
})

// ---------------------------------------------------------------- batch B: never throws

test('an invalid code point in a string makes that call dynamic and the parse goes on', async () => {
  const script = `export const meta = { name: 'bad\\u{110000}' }
const a = await agent('x', { label: 'bad\\u{110000}', model: 'haiku', effort: 'low' })
const b = await agent('y', { label: 'fine', model: 'haiku', effort: 'low' })`
  const r = parseWorkflow(script)
  expect(r.calls.length).toBe(2)
  expect(r.calls[0].dynamic).toBe(true)
  expect(r.calls[1]).toMatchObject({ dynamic: false, label: lit('fine') })
  expect(parseWorkflow(`agent('x', { ['k\\u{FFFFFF}']: 1, label: 'q' })`).calls[0].dynamic).toBe(true)
})

// ---------------------------------------------------------------- P4: phases as objects, phase() statements

test('meta.phases: objects with a title are read as well as strings; an entry with no literal title is skipped', async () => {
  const w = parseWorkflow(`export const meta = { name: 'o', phases: [{ title: 'Read' }, 'Mid', { title: "Write", detail: 'x' }, { detail: 'no title' }, { title: dyn }] }`)
  expect(w.phases).toEqual(['Read', 'Mid', 'Write'])
})

test('phase() statements: a call with no phase: option takes the last preceding top-level phase(); the option wins', async () => {
  const w = parseWorkflow(`export const meta = { name: 's', phases: ['A', 'B'] }
await agent('x', { label: 'before', model: 'haiku', effort: 'low' })
phase('A')
await agent('x', { label: 'one', model: 'haiku', effort: 'low' })
await parallel([() => agent('y', { label: 'two', model: 'haiku', effort: 'low' }), () => agent('z', { label: 'three', phase: 'B', model: 'haiku', effort: 'low' })])
await phase("B")
await agent('w', { label: 'four', model: 'haiku', effort: 'low' })`)
  expect(w.calls.map((c) => c.label && (c.label as { value: string }).value + ':' + ((c.phase as { value: string } | undefined)?.value ?? '-'))).toEqual(['before:-', 'one:A', 'two:A', 'three:B', 'four:B'])
})

test('phase() statements: not attributed when the order is unknowable (a phase() inside a block or function, a non-literal name)', async () => {
  const inBlock = parseWorkflow(`for (const p of args) { phase('A'); await agent('x', { label: 'one', model: 'haiku', effort: 'low' }) }`)
  expect(inBlock.calls[0].phase).toBe(undefined)
  const inFn = parseWorkflow(`phase('A')\nfunction go() { return agent('x', { label: 'one', model: 'haiku', effort: 'low' }) }\nawait go()`)
  expect(inFn.calls[0].phase).toBe(undefined)
  const dyn = parseWorkflow(`phase('A')\nphase(next)\nawait agent('x', { label: 'one', model: 'haiku', effort: 'low' })`)
  expect(dyn.calls[0].phase).toBe(undefined)
  const method = parseWorkflow(`ctx.phase('A')\nawait agent('x', { label: 'one', model: 'haiku', effort: 'low' })`)
  expect(method.calls[0].phase).toBe(undefined)
})
