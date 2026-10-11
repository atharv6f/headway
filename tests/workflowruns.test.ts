import { expect, mock, test } from 'claude-code/testing'

// The Workflow tool.call hook's side of a run's planned calls: a call with no run id runs nothing
// headway can join, and a script whose agentIndex order is not its source order marks its calls.
function watch(on) {
  const last: Record<string, unknown> = {}
  on('state.set', async ($, e, next) => {
    if (e.plugin === 'headway') last[e.key] = e.value
    return next(e)
  })
  on('ui.toast', async () => ({ value: {} }))
  return { agents: () => (last.agents ?? []) as Array<{ id: string; planned?: true; unordered?: true }> }
}

const STATIC = `export const meta = { name: 's', description: 'd', phases: [] }
await agent('one', { model: 'haiku', effort: 'low' })
await agent('two', { model: 'haiku', effort: 'low' })`

const LOOPED = `export const meta = { name: 'l', description: 'd', phases: [] }
for (const f of args) { await agent('review ' + f, { model: 'haiku', effort: 'low' }) }
await agent('sum', { model: 'haiku', effort: 'low' })`

test('workflow run: a call that returns no run id (a failed syntax check, a remote launch) leaves no planned calls', async ($, on) => {
  mock.clock(on, { now: 0 })
  const st = watch(on)
  on('tool.call', async () => ({ result: { status: 'async_launched', taskId: 't', error: 'syntax check failed' } }))
  await $.tool.call({ tool: 'Workflow', script: STATIC, tool_use_id: 'toolu_x' })
  expect(st.agents()).toEqual([])
})

test('workflow run: a script with a loop marks its calls unordered; a straight script does not', async ($, on) => {
  mock.clock(on, { now: 0 })
  const st = watch(on)
  on('tool.call', async (_$, e) => ({ result: { status: 'async_launched', taskId: 't', runId: 'wf_' + e.tool_use_id } }))
  await $.tool.call({ tool: 'Workflow', script: STATIC, tool_use_id: 'toolu_s' })
  expect(st.agents().map((a) => a.id + ':' + (a.unordered ?? false))).toEqual(['wf:wf_toolu_s:1:false', 'wf:wf_toolu_s:2:false'])
  await $.tool.call({ tool: 'Workflow', script: LOOPED, tool_use_id: 'toolu_l' })
  expect(st.agents().filter((a) => a.id.startsWith('wf:wf_toolu_l')).map((a) => a.unordered)).toEqual([true, true])
})
