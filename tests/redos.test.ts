import { expect, test } from 'claude-code/testing'
import { globMatch, matchAgent } from '../hooks/agents.ts'
import { parsePlan } from '../hooks/plan.ts'
import type { Plan } from '../hooks/plan.ts'
import { filterFromInput, parsePinArgs } from '../hooks/pin.ts'
import { TOOL_SPEC } from '../hooks/tool.ts'
import { PLAN, start, TOOL, world } from './world.ts'

// Text a model or a file supplies never makes a match run long (SPEC 5.2, 5.3, 14): a workflow
// label pattern is a linear glob, never a regex; there is no user regex at all (no `pattern=`), and
// plan IDs are matched as escaped literals.

function timed<T>(f: () => T): { value: T; ms: number } {
  const at = performance.now()
  const value = f()
  return { value, ms: performance.now() - at }
}

function ok(r: ReturnType<typeof parsePlan>): Plan {
  if (!r.ok) throw new Error('expected a plan, got refusal: ' + r.error)
  return r.plan
}

// ---------------------------------------------------------------- 1a: workflow label patterns

test('globMatch: a literal is equality; `*` matches any run, including none', async () => {
  expect(globMatch('read', 'read')).toBe(true)
  expect(globMatch('read', 'reads')).toBe(false)
  expect(globMatch('case * read', 'case R02-73 read')).toBe(true)
  expect(globMatch('case * read', 'case  read')).toBe(true)
  expect(globMatch('case * read', 'case R02 write')).toBe(false)
  expect(globMatch('*', '')).toBe(true)
  expect(globMatch('a*', 'a')).toBe(true)
  expect(globMatch('*b', 'ab')).toBe(true)
  expect(globMatch('*b', 'ba')).toBe(false)
  expect(globMatch('a*b*c', 'axxbyyc')).toBe(true)
  expect(globMatch('a*b*c', 'axxcyyb')).toBe(false)
  // regex metacharacters are plain text
  expect(globMatch('x.y (z)+', 'x.y (z)+')).toBe(true)
  expect(globMatch('x.y', 'xzy')).toBe(false)
})

test('globMatch: a label with 30 `*` against a 2000-character description returns quickly', async () => {
  const label = Array(31).fill('a').join('*') + 'b'
  const description = 'a'.repeat(2000)
  const r = timed(() => globMatch(label, description))
  expect(r.value).toBe(false)
  expect(r.ms).toBeLessThan(50)
  const hit = timed(() => globMatch(label.slice(0, -1), description))
  expect(hit.value).toBe(true)
  expect(hit.ms).toBeLessThan(50)
})

// ---------------------------------------------------------------- 1b: no pattern=

test('pattern=: the command refuses it as an unknown argument, and the tool schema has no pattern field', async () => {
  expect(parsePinArgs('p.md pattern=EX-\\d+', '/w')).toEqual({ ok: false, error: 'unknown argument: pattern=EX-\\d+' })
  expect('pattern' in TOOL_SPEC.inputSchema.properties).toBe(false)
  expect(TOOL_SPEC.description.includes('pattern')).toBe(false)
  // a pattern the model sends anyway is not part of the filter
  const r = filterFromInput({ file: 'p.md', pattern: '(a+)+$' }, '/w')
  expect(r).toEqual({ ok: true, filter: { file: '/w/p.md' }, typed: { file: 'p.md' } })
})

test('pattern=: through the command and the tool, the same plan pins by its own IDs', async ($, on) => {
  world(on, { files: { '/w/plan.md': PLAN } })
  await start($)
  expect((await $.command.run({ command: 'waypoint', args: 'track plan.md pattern=(a+)+$', origin: { kind: 'composer' } } as never)).text).toBe('refused: unknown argument: pattern=(a+)+$')
  const pinned = (await $.tool.call({ tool: TOOL, tool_use_id: 't1', action: 'track', file: 'plan.md', pattern: '(a+)+$' })).result as string
  expect(pinned).toMatch(/^tracking \/w\/plan\.md/)
  const state = (await $.tool.call({ tool: TOOL, tool_use_id: 't2', action: 'state' })).result as string
  expect(state.includes('pattern')).toBe(false)
})

test('plan IDs: a long agent text still matches a plan ID literally and finishes fast', async () => {
  const plan = ok(parsePlan('- [ ] T1 one\n- [ ] T2 two\n'))
  const far = 'y'.repeat(1500)
  expect(matchAgent(plan, [far + ' T2'])).toMatchObject({ taskIds: ['T2'] })
  const digits = '1'.repeat(5000)
  const r = timed(() => matchAgent(plan, [digits, digits, digits]))
  expect(r.ms).toBeLessThan(50)
  expect(r.value).toEqual({ taskIds: [] })
})
