import { expect, test } from 'claude-code/testing'
import { PLAN, start, TOOL, world } from './world.ts'

// The plan poll's single-flight load and its generation: a load begun under an older pin writes no
// plan, goal or log when it lands; a load with nothing pinned clears the goal.
const OTHER = `# Q

## Other

- [ ] X1 first
- [x] X2 second
`
const DAY = 24 * 60 * 60_000

const settle = () => new Promise((r) => setTimeout(r, 30))

test('plan load: a read begun under the old pin lands after a new pin and writes nothing', async ($, on) => {
  const w = world(on, { files: { '/w/plan/p.md': PLAN, '/w/plan/q.md': OTHER }, sessionId: 's-1' })
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't1', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect((w.last.goal as { label: string }).label).toBe('Work')
  // the plan changes on disk (T3 lands); the poll's read of it hangs until released
  let release = () => {}
  w.gates['/w/plan/p.md'] = new Promise<void>((r) => {
    release = r
  })
  w.files['/w/plan/p.md'] = PLAN.replace('| T3 | third | | |', '| T3 | third | yes | |')
  w.mtimes['/w/plan/p.md'] = 2
  await w.clock.advance(2000)
  await $.tool.call({ tool: TOOL, tool_use_id: 't2', action: 'track', file: 'plan/q.md', section: 'Other' })
  expect((w.last.goal as { label: string }).label).toBe('Other')
  delete w.gates['/w/plan/p.md']
  release()
  await settle()
  expect((w.last.goal as { label: string; total: number }).label).toBe('Other')
  expect((w.last.log as Array<{ kind: string }>).map((l) => l.kind)).not.toContain('task-done')
  const state = (await $.tool.call({ tool: TOOL, tool_use_id: 't3', action: 'state' })).result as string
  expect(state.split('\n')[0]).toContain('Other')
  expect(state.split('\n')[0]).toContain('1/2 done')
})

test('plan load: a reload that leaves nothing pinned clears the goal', async ($, on) => {
  const now = 6 * DAY
  const rec = { filter: null, report: null, agents: [], log: [], savedAt: now - 1000 }
  const w = world(on, { files: { '/w/plan/p.md': PLAN }, sessionId: 's-1', store: { 'session:s-2': rec }, now })
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't1', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect(w.last.goal).not.toBe(null)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-2' })
  expect(w.last.filter).toBe(null)
  expect(w.last.goal).toBe(null)
})
