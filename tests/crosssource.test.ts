import { expect, test } from 'claude-code/testing'
import { start, TOOL, transcripts, world } from './world.ts'
import { text as flow } from './fixtures/flow.ts'
import { bandLines } from '../plugin/hooks/band.tsx'
import { bandCurrent } from '../plugin/hooks/agents.ts'
import { reportPlan } from '../plugin/hooks/tool.ts'

// Rules that cross the plan sources (SPEC 4.8, 3, 8): the goal label belongs to the prompt that
// started the active source; every in-memory source logs its task flips the same way and marks a
// task boundary; band line 2 shows a partial task with no agents by its status.
const USAGE = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }
type L = { kind: string; ref: string; detail?: string }

function engine(on) {
  let n = 0
  let task = 0
  on('tool.call', async (_$, e) => {
    if (e.tool === 'ExitPlanMode') return { result: { plan: e.plan, isAgent: false, filePath: '/p.md' } }
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++task), subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId } }
    if (e.tool === 'Workflow') return { result: { status: 'async_launched', runId: 'wf_' + e.tool_use_id.replace('toolu_', ''), taskId: 't' } }
    return { result: 'ok' }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  const spawned = transcripts(on)
  on('agent.spawn', async (_$, e) => {
    const agentId = 'w' + ++n
    spawned(agentId, e.prompt)
    return { model: 'claude-haiku-5-5', agentId }
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: [] }))
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
}

const say = ($, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
const tool = async ($, input: Record<string, unknown>) => (await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_w', ...input })).result as string
const goalLine = async ($) => (await tool($, { action: 'state' })).split('\n')[0]
const call = ($, name: string, input: Record<string, unknown>) => $.tool.call({ tool: name, tool_use_id: 'toolu_' + Math.random(), ...input })

test('label: a follow-up prompt does not rename a reported goal; a new full list takes the prompt of its turn', async ($, on) => {
  world(on, {})
  engine(on)
  await start($)
  await say($, 'Build the three files')
  await tool($, { action: 'report', tasks: [{ title: 'a' }, { title: 'b' }] })
  expect(await goalLine($)).toBe('goal: Build the three files — 0/2 done (reported)')
  await say($, 'ok continue')
  await tool($, { action: 'report', done: ['1'] })
  expect(await goalLine($)).toBe('goal: Build the three files — 1/2 done (reported)')
  await say($, 'Now write the docs')
  await tool($, { action: 'report', tasks: [{ title: 'docs' }] })
  expect(await goalLine($)).toBe('goal: Now write the docs — 0/1 done (reported)')
})

test('label: an untitled plan keeps the prompt it was approved under until the next approval', async ($, on) => {
  world(on, {})
  engine(on)
  await start($)
  await say($, 'Tidy the folder')
  await call($, 'ExitPlanMode', { plan: '1. move\n2. index\n', planFilePath: '/p.md' })
  await say($, 'thanks, go on')
  expect(await goalLine($)).toBe('goal: Tidy the folder — 0/2 done (plan)')
  await say($, 'Second job')
  await call($, 'ExitPlanMode', { plan: '1. one\n', planFilePath: '/p.md' })
  expect(await goalLine($)).toBe('goal: Second job — 0/1 done (plan)')
})

test('label and flips: a task list keeps the prompt that started it; its flips log and mark a boundary like any source', { options: { compactAtPercent: 1 } }, async ($, on) => {
  const w = world(on, {})
  engine(on)
  on('session.usage', async () => ({ value: { context: { percent: 50 }, cost: { usd: 1 } } }))
  await start($)
  await say($, 'Make the fruit files')
  await call($, 'TaskCreate', { subject: 'apple', description: 'd', activeForm: 'Making apple' })
  await call($, 'TaskCreate', { subject: 'pear', description: 'd', activeForm: 'Making pear' })
  await say($, 'keep going')
  await call($, 'TaskUpdate', { taskId: '1', status: 'in_progress' })
  await call($, 'TaskUpdate', { taskId: '1', status: 'completed' })
  expect(await goalLine($)).toBe('goal: Make the fruit files — 1/2 done (tasks)')
  const log = (w.last.log as L[]).map((l) => l.kind + ' ' + l.ref + ' ' + l.detail)
  expect(log.slice(0, 2)).toEqual(['task-done 1 done', 'task-partial 1 partial'])
  // the flip to done is a task boundary: the next main-loop turn end, with no agent running, says compact now
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 'main', reason: 'answer' })
  expect(await tool($, { action: 'state' })).toContain('contextHint: compact-now')
})

test('flips: the reported and plan-mode sources log done, partial and reopened in the same words', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await tool($, { action: 'report', tasks: [{ title: 'a' }, { title: 'b' }] })
  await tool($, { action: 'report', updates: [{ id: '1', status: 'partial' }] })
  await tool($, { action: 'report', done: ['1'] })
  await tool($, { action: 'report', updates: [{ id: '1', status: 'open' }] })
  const kinds = (w.last.log as L[]).filter((l) => l.kind.startsWith('task-')).map((l) => l.kind + ' ' + l.ref + ' ' + l.detail)
  expect(kinds).toEqual(['task-reopened 1 reopened', 'task-done 1 done', 'task-partial 1 partial'])
})

test('flips: a workflow phase that finishes logs task-done', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Workflow', script: flow, tool_use_id: 'toolu_f' })
  const spawn = (index: number, label: string) =>
    $.agent.spawn({ tool_use_id: 'toolu_f', prompt: 'Reply ok', description: label, subagentType: 'workflow-subagent', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, model: 'haiku', workflow: { runId: 'wf_f', agentIndex: index } })
  await spawn(1, 'build core')
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'w1', reason: 'answer', usage: USAGE })
  await spawn(2, 'verify xyz')
  const flips = (w.last.log as L[]).filter((l) => l.kind.startsWith('task-')).map((l) => l.kind + ' ' + l.ref)
  expect(flips).toContain('task-done Build')
})

test('flips: the first spawn of a run, made while its Workflow call still runs, logs its phase partial', async ($, on) => {
  const w = world(on, {})
  let entered = () => {}
  const atEngine = new Promise<void>((r) => (entered = r))
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  on('tool.call', async () => {
    entered()
    await gate
    return { result: { status: 'async_launched', runId: 'wf_f', taskId: 't' } }
  })
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'w1' }))
  on('agent.list', async () => ({ value: [] }))
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  await start($)
  const running = $.tool.call({ tool: 'Workflow', script: flow, tool_use_id: 'toolu_f' })
  await atEngine
  // the engine spawns the first agent before the call returns: the run id binds at that spawn
  await $.agent.spawn({ tool_use_id: 'toolu_f', prompt: 'Reply ok', description: 'build core', subagentType: 'workflow-subagent', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, model: 'haiku', workflow: { runId: 'wf_f', agentIndex: 1 } })
  release()
  await running
  const flips = (w.last.log as L[]).filter((l) => l.kind.startsWith('task-')).map((l) => l.kind + ' ' + l.ref)
  expect(flips).toEqual(['task-partial Build'])
})

test('flips: a phase whose agent fails logs no task-done and no reopened; the goal does not count it', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Workflow', script: flow, tool_use_id: 'toolu_f' })
  await $.agent.spawn({ tool_use_id: 'toolu_f', prompt: 'Reply ok', description: 'build core', subagentType: 'workflow-subagent', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, model: 'haiku', workflow: { runId: 'wf_f', agentIndex: 1 } })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'w1', reason: 'error', usage: USAGE })
  const flips = (w.last.log as L[]).filter((l) => l.kind.startsWith('task-')).map((l) => l.kind + ' ' + l.ref)
  expect(flips).toEqual(['task-partial Build'])
  expect(await goalLine($)).toMatch(/— 0\/2 done \(phases\)$/)
})

test('band line 2: the single partial task with no agents reads its status, not 0 agents', async () => {
  const plan = reportPlan({ tasks: [{ id: '1', title: 'Write a', status: 'done' }, { id: '2', title: 'Write b', status: 'partial' }] })
  const cur = bandCurrent(plan, [], null, { partialSource: true }).current!
  expect(cur).toMatchObject({ id: '2', title: 'Write b', total: 0, status: 'partial' })
  const line2 = bandLines({ columns: 100, ascii: false, goal: { label: 'g', done: 1, partial: 1, open: 0, total: 2, doneWord: 'done', partialWord: 'partial' }, current: cur })[1]
  const text = line2.map((s) => s.text).join('')
  expect(text).toContain('2 Write b')
  expect(text.trimEnd().endsWith('◐ in progress')).toBe(true)
  expect(text).not.toContain('0 agents')
  expect(line2[line2.length - 1].el).toBe('partial')
})

test('a finished reported list yields to a task list made after it; a new full list takes over again', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await say($, 'Rename and update')
  await tool($, { action: 'report', tasks: [{ title: 'rename' }, { title: 'update' }] })
  await tool($, { action: 'report', done: ['1', '2'] })
  expect(await goalLine($)).toBe('goal: Rename and update — 2/2 done (reported)')
  await w.clock.advance(1000)
  await say($, 'Now track three more')
  await call($, 'TaskCreate', { subject: 'one' })
  await call($, 'TaskCreate', { subject: 'two' })
  expect(await goalLine($)).toBe('goal: Now track three more — 0/2 done (tasks)')
  await say($, 'Another list')
  await tool($, { action: 'report', tasks: [{ title: 'x' }] })
  expect(await goalLine($)).toBe('goal: Another list — 0/1 done (reported)')
})

test('a finished plan-mode plan yields to a Workflow run with phases started after it', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await call($, 'ExitPlanMode', { plan: '# Plan: P\n1. one\n', planFilePath: '/p.md' })
  await tool($, { action: 'report', done: ['1'] })
  expect(await goalLine($)).toBe('goal: P — 1/1 done (plan)')
  await w.clock.advance(1000)
  await call($, 'Workflow', { script: "export const meta = { name: 'flow', description: 'Flow run', phases: ['Read', 'Write'] }\nawait agent('r', { label: 'reader', phase: 'Read' })\n" })
  expect(await goalLine($)).toMatch(/^goal: Flow run — 0\/2 done \(phases\)$/)
})

test('/clear: the new conversation keeps the pinned file and the agents, never the prompt-driven sources', async ($, on) => {
  const w = world(on, { sessionId: 's-1', files: { '/w/plan.md': '## Work\n- [ ] T1 one\n' } })
  engine(on)
  await start($)
  await say($, 'Old work')
  await tool($, { action: 'report', title: 'Old', tasks: [{ title: 'a' }] })
  await call($, 'TaskCreate', { subject: 'old task' })
  await $.agent.spawn({ tool_use_id: 'toolu_a', description: 'helper', subagentType: 'general-purpose', prompt: 'p' })
  await w.clock.advance(1100)
  w.setSessionId('s-2')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
  expect(await goalLine($)).toBe('goal: nothing tracked')
  expect(w.last.report ?? null).toBe(null)
  expect(w.last.tasks ?? null).toBe(null)
  expect(w.last.label ?? {}).toEqual({})
  expect(w.last.prompt ?? null).toBe(null)
  expect((w.last.agents as unknown[]).length).toBe(1)
  // the pinned file does carry over
  await tool($, { action: 'track', file: 'plan.md' })
  w.setSessionId('s-3')
  await w.clock.advance(1100)
  await $.classic.SessionStart({ source: 'clear', session_id: 's-3' })
  expect(await goalLine($)).toMatch(/\(file: \/w\/plan\.md\)$/)
})

const spawnStep = ($, id: string, description: string) =>
  $.agent.spawn({ tool_use_id: 'toolu_' + id, prompt: 'go', description, subagentType: 'x:implementer', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
const finish = ($, agentId: string) => $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't-' + agentId, agentId, reason: 'answer', usage: USAGE })
type A = { id: string; description: string; taskIds: string[]; groupId?: string; status: string }
const agentNamed = (w, description: string) => (w.last.agents as A[]).find((a) => a.description === description)!

test('a plan-mode approval: finished agents of the earlier work stay out of the new plan; running ones re-match (the reviewer case)', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await tool($, { action: 'report', tasks: [{ title: 'old one' }, { title: 'old two' }] })
  await spawnStep($, 'a', 'step 1: old work')
  await finish($, 'w1')
  await spawnStep($, 'b', 'step 2: still going')
  expect(agentNamed(w, 'step 1: old work').taskIds).toEqual(['1'])
  await call($, 'ExitPlanMode', { plan: '# Plan: New\n1. fresh one\n2. fresh two\n', planFilePath: '/p.md' })
  const old = agentNamed(w, 'step 1: old work')
  expect(old.taskIds).toEqual([])
  expect(old.groupId).toBe(undefined)
  expect(agentNamed(w, 'step 2: still going').taskIds).toEqual(['2'])
  // a later re-match (the task list starting under the plan, an untrack) keeps it out too
  await tool($, { action: 'report', updates: [{ id: '1', status: 'partial' }] })
  await call($, 'TaskCreate', { subject: 'side' })
  expect(agentNamed(w, 'step 1: old work').taskIds).toEqual([])
})

test('a report replacement: finished agents of the old list do not attach to the new one, by id or by the one partial task', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await tool($, { action: 'report', tasks: [{ title: 'a' }] })
  await spawnStep($, 'a', 'step 1: a')
  await finish($, 'w1')
  await tool($, { action: 'report', tasks: [{ title: 'b', status: 'partial' }, { title: 'c' }] })
  expect(agentNamed(w, 'step 1: a').taskIds).toEqual([])
  const state = await tool($, { action: 'state' })
  expect(state).toContain('[done] w1')
})

const resumeStep = ($, agentId: string) => {
  const s = $.turn.step({ turnId: 't2-' + agentId, index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId })
  return (async () => {
    for (;;) if ((await s.next()).done) return
  })()
}

test('a resumed previous agent drops the mark and re-matches the current plan, by id or by the one partial step (the reviewer case)', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  await tool($, { action: 'report', tasks: [{ title: 'old' }] })
  await spawnStep($, 'a', 'step 2: scout the code')
  await spawnStep($, 'b', 'helper with no id')
  await finish($, 'w1')
  await finish($, 'w2')
  await call($, 'ExitPlanMode', { plan: '# Plan: New\n1. fresh one\n2. fresh two\n', planFilePath: '/p.md' })
  expect(agentNamed(w, 'step 2: scout the code').taskIds).toEqual([])
  // SendMessage resumes it: the step reopens it under step 2 of the new plan
  await resumeStep($, 'w1')
  const back = agentNamed(w, 'step 2: scout the code') as A & { previous?: boolean }
  expect(back.status).toBe('running')
  expect(back.taskIds).toEqual(['2'])
  expect(back.previous).toBe(undefined)
  // one naming no step joins the single partial step
  await tool($, { action: 'report', updates: [{ id: '1', status: 'partial' }] })
  await resumeStep($, 'w2')
  expect(agentNamed(w, 'helper with no id').taskIds).toEqual(['1'])
})

test('a report re-send that adds a task keeps the finished agents on their steps; a wholly new list retires them (the reviewer case)', async ($, on) => {
  const w = world(on, {})
  engine(on)
  await start($)
  const four = [{ title: 'parse' }, { title: 'wire' }, { title: 'test' }, { title: 'docs' }]
  await tool($, { action: 'report', tasks: four })
  await spawnStep($, 'a', 'step 1: parse')
  await spawnStep($, 'b', 'step 2: wire')
  await finish($, 'w1')
  await finish($, 'w2')
  await tool($, { action: 'report', done: ['1', '2'] })
  await tool($, { action: 'report', tasks: [...four.map((t, i) => (i < 2 ? { ...t, status: 'done' } : t)), { title: 'release' }] })
  expect(agentNamed(w, 'step 1: parse').taskIds).toEqual(['1'])
  expect(agentNamed(w, 'step 2: wire').taskIds).toEqual(['2'])
  expect(await tool($, { action: 'state' })).toContain('2/5 done')
  await tool($, { action: 'report', tasks: [{ title: 'pack' }, { title: 'ship' }] })
  expect(agentNamed(w, 'step 1: parse').taskIds).toEqual([])
  expect(agentNamed(w, 'step 2: wire').taskIds).toEqual([])
})

test('overlapping report updates each log only their own flips (the reviewer case)', async ($, on) => {
  world(on, { watchState: false })
  engine(on)
  let hold = false
  let release: () => void = () => {}
  const held = new Promise<void>((r) => (release = r))
  let log: L[] = []
  on('state.set', async ($, e, next) => {
    if (e.plugin === 'headway' && e.key === 'report' && hold) {
      hold = false
      await held
    }
    if (e.plugin === 'headway' && e.key === 'log') log = e.value
    return next(e)
  })
  await start($)
  await tool($, { action: 'report', tasks: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
  hold = true
  const a = tool($, { action: 'report', updates: [{ id: '2', status: 'done' }] })
  await new Promise((r) => setTimeout(r, 20))
  await tool($, { action: 'report', updates: [{ id: '3', status: 'partial' }] })
  release()
  await a
  const flips = log.filter((l) => l.kind.startsWith('task-')).map((l) => l.kind + ' ' + l.ref)
  expect(flips.sort()).toEqual(['task-done 2', 'task-partial 3'])
  expect(await goalLine($)).toMatch(/1\/3 done|done 1 · partial 1/)
})
