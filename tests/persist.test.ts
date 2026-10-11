import { expect, test } from 'claude-code/testing'
import { PLAN, start, TOOL, world } from './world.ts'
import { TASKS_MAX, TITLE_MAX } from '../hooks/format.ts'
import { capSession, MAX_RECORD_BYTES, recordText } from '../hooks/persist.ts'

// `$.store` persistence: debounced saves under `session:<id>`, the reload on classic.SessionStart
// (clear, resume, fork; more in reload.test.ts) and the 14-day prune.
const FILES = { '/w/plan/p.md': PLAN }
const DAY = 24 * 60 * 60_000
const FILTER = { file: '/w/plan/p.md', section: 'Work', doneRule: 'column=landed' }
const CLAUDE_FILTER = { ...FILTER, bounds: { file: '/w' } } // Claude's pin through the tool carries its bound (SPEC 14)

function savedAgent(id: string) {
  return {
    id, agentId: id, description: 'T2 build', subagentType: 'acme:implementer', taskIds: ['T2'], role: 'implementer', status: 'blocked',
    question: 'which toggle', spawnedAt: 1, steps: 3, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, estUsd: 0, warnings: [],
  }
}

function saved(at: number) {
  return { filter: FILTER, report: null, agents: [savedAgent('ag-old')], log: [{ at: 1, kind: 'pin', ref: '', detail: 'tracking p.md § Work' }], savedAt: at }
}

function spawnInput(n: number) {
  return {
    tool_use_id: 'toolu_' + n, prompt: 'Reply ok', description: 'T' + ((n % 3) + 1) + ' work', subagentType: 'acme:scout',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  }
}

test('save: a pin is written under session:<id> a second later', async ($, on) => {
  const w = world(on, { files: FILES, sessionId: 's-a' })
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  expect(w.writes.filter((x) => x.key === 'session:s-a')).toEqual([])
  await w.clock.advance(1000)
  const rec = w.store['session:s-a'] as { filter: unknown; agents: unknown[]; log: unknown[]; savedAt: number }
  expect(rec.filter).toEqual(CLAUDE_FILTER)
  expect(rec.agents).toEqual([])
  expect(rec.log.length).toBe(1)
  expect(rec.savedAt).toBe(w.clock.now())
})

test('save: a burst of changes writes at most once a second, and the last write holds the last change', async ($, on) => {
  const w = world(on, { files: FILES, sessionId: 's-b' })
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag' + n++ }))
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  for (let i = 0; i < 30; i++) {
    await $.agent.spawn(spawnInput(i))
    await w.clock.advance(100)
  }
  await w.clock.advance(1000)
  const saves = w.writes.filter((x) => x.key === 'session:s-b')
  expect(saves.length).toBeGreaterThan(1)
  expect(saves.length).toBeLessThanOrEqual(4)
  for (let i = 1; i < saves.length; i++) expect(saves[i].at - saves[i - 1].at).toBeGreaterThanOrEqual(1000)
  expect((saves[saves.length - 1].value as { agents: unknown[] }).agents.length).toBe(30)
})

test('reload: /resume restores session:<e.session_id>, even while $.session.id() still names the old session', async ($, on) => {
  const w = world(on, { files: FILES, sessionId: 's-prev', store: { 'session:s-res': saved(5 * DAY) }, now: 6 * DAY })
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's-res' })
  expect(w.last.filter).toEqual(FILTER)
  expect((w.last.agents as Array<{ id: string }>).map((a) => a.id)).toEqual(['ag-old'])
  expect((w.last.goal as { done: number; total: number }).total).toBe(3)
  const state = (await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'state' })).result as string
  expect(state).toContain('blocked: ag-old implementer "T2 build" — BLOCKED: which toggle')
})

test('reload: a save still pending from before /clear lands under the old id before the reload reads it', async ($, on) => {
  const w = world(on, { files: FILES, sessionId: 's-1' })
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  w.setSessionId('s-2')
  await $.classic.SessionStart({ source: 'clear', session_id: 's-2' })
  expect((w.store['session:s-1'] as { filter: unknown }).filter).toEqual(CLAUDE_FILTER)
  expect((w.store['session:s-2'] as { filter: unknown }).filter).toEqual(CLAUDE_FILTER)
  expect(w.last.filter).toEqual(CLAUDE_FILTER)
  await w.clock.advance(2000)
  expect((w.store['session:s-1'] as { filter: unknown }).filter).toEqual(CLAUDE_FILTER)
})

test('reload: startup and compact do not reload', async ($, on) => {
  const w = world(on, { files: FILES, sessionId: 's-x', store: { 'session:s-old': saved(5 * DAY) }, now: 6 * DAY })
  await start($)
  await $.classic.SessionStart({ source: 'startup', session_id: 's-x' })
  await $.classic.SessionStart({ source: 'compact', session_id: 's-x' })
  expect(w.last.filter).toBe(undefined)
})

test('reload: nothing saved anywhere leaves the state empty and writes nothing', async ($, on) => {
  const w = world(on, { files: FILES, sessionId: 's-y' })
  await start($)
  await $.classic.SessionStart({ source: 'clear', session_id: 's-y' })
  expect(w.last.filter).toBe(undefined)
  expect(w.writes).toEqual([])
})

test('prune: session.start deletes records saved more than 14 days ago and keeps the rest', async ($, on) => {
  const now = 40 * DAY
  const w = world(on, { files: FILES, now, store: { 'session:old': saved(now - 15 * DAY), 'session:fresh': saved(now - 13 * DAY), band: false } })
  await start($)
  expect(Object.keys(w.store).sort()).toEqual(['band', 'session:fresh'])
})

// ---------------------------------------------------------------- batch B: bounded record size

function finishedAgent(i: number, over: Record<string, unknown> = {}) {
  return { ...savedAgent('a' + i), status: 'done', spawnedAt: i, endedAt: 1000 + i, ...over }
}

test('cap: at most 300 agents, every non-terminal one kept, the newest finished ones fill the rest', async () => {
  const live = Array.from({ length: 3 }, (_, i) => ({ ...savedAgent('live' + i), status: i === 0 ? 'running' : i === 1 ? 'queued' : 'stalled', spawnedAt: 0 }))
  const done = Array.from({ length: 400 }, (_, i) => finishedAgent(i))
  const rec = capSession({ filter: null, report: null, agents: [...live, ...done] as never, log: [], savedAt: 1 })
  expect(rec.agents.length).toBe(300)
  expect(rec.agents.slice(0, 3).map((a) => a.id)).toEqual(['live0', 'live1', 'live2'])
  const ids = rec.agents.map((a) => a.id)
  expect(ids).toContain('a399')
  expect(ids).toContain('a103')
  expect(ids).not.toContain('a102')
  const many = Array.from({ length: 350 }, (_, i) => ({ ...savedAgent('r' + i), status: 'running' }))
  expect(capSession({ filter: null, report: null, agents: many as never, log: [], savedAt: 1 }).agents.length).toBe(350)
})

test('cap: the log keeps the newest 500 entries (the list is newest first)', async () => {
  const log = Array.from({ length: 700 }, (_, i) => ({ at: 700 - i, kind: 'pin' as const, ref: '', detail: 'e' + i }))
  const rec = capSession({ filter: null, report: null, agents: [], log, savedAt: 1 })
  expect(rec.log.length).toBe(500)
  expect(rec.log[0].detail).toBe('e0')
  expect(rec.log[499].detail).toBe('e499')
})

test('cap: a record over 3 MiB loses its oldest finished agents, then its oldest log entries, until it fits', async () => {
  const fat = 'x'.repeat(40_000)
  const done = Array.from({ length: 120 }, (_, i) => finishedAgent(i, { question: fat }))
  const live = { ...savedAgent('live'), status: 'running', question: fat }
  const rec = capSession({ filter: null, report: null, agents: [live, ...done] as never, log: [], savedAt: 1 })
  expect(JSON.stringify(rec).length).toBeLessThanOrEqual(MAX_RECORD_BYTES)
  expect(rec.agents.length).toBeLessThan(121)
  expect(rec.agents.map((a) => a.id)).toContain('live')
  expect(rec.agents.map((a) => a.id)).toContain('a119')
  expect(rec.agents.map((a) => a.id)).not.toContain('a0')
  const log = Array.from({ length: 400 }, (_, i) => ({ at: 400 - i, kind: 'pin' as const, ref: '', detail: fat + i }))
  const rec2 = capSession({ filter: null, report: null, agents: [], log, savedAt: 1 })
  expect(JSON.stringify(rec2).length).toBeLessThanOrEqual(MAX_RECORD_BYTES)
  expect(rec2.log[0].detail).toBe(fat + '0')
  expect(rec2.log.length).toBeLessThan(400)
})

test('save: the record written to the store is capped', async ($, on) => {
  // not watching $.state: the watch hook copies the whole agent list on each of the 640 writes,
  // which alone took this test past the 5 s limit under a loaded run
  const w = world(on, { files: FILES, sessionId: 's-cap', watchState: false })
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag' + n++ }))
  on('turn.complete', async () => ({ text: '' }))
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  for (let i = 0; i < 320; i++) {
    await $.agent.spawn(spawnInput(i))
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', agentId: 'ag' + i, reason: 'answer' })
  }
  await w.clock.advance(1000)
  const rec = w.store['session:s-cap'] as { agents: unknown[] }
  expect(rec.agents.length).toBe(300)
})

test('save: records that differ only in savedAt have the same text, so the second is not written', async () => {
  const a = { filter: null, report: null, agents: [savedAgent('x')] as never, log: [], savedAt: 1 }
  expect(recordText(capSession({ ...a, savedAt: 2 }))).toBe(recordText(capSession(a)))
  expect(recordText(capSession({ ...a, agents: [] }))).not.toBe(recordText(capSession(a)))
})

// ---------------------------------------------------------------- batch B: the lists a model wrote are bounded

const longTitle = (i: number) => String(i).padEnd(1040, 'x')

test('cap: a reported list of 5000 one-kilobyte tasks (5.2 MB) is cut to 200 tasks of 200 characters', async () => {
  const tasks = Array.from({ length: 5000 }, (_, i) => ({ id: String(i + 1), title: longTitle(i), status: 'open' as const }))
  const rec = { filter: null, report: { title: 'g'.repeat(900), tasks }, agents: [], log: [], savedAt: 1 }
  expect(JSON.stringify(rec).length).toBeGreaterThan(5_200_000)
  const out = capSession(rec as never)
  expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_RECORD_BYTES)
  expect(out.report?.tasks.length).toBe(TASKS_MAX)
  expect(out.report?.tasks[0].id).toBe('1')
  expect(Array.from(out.report?.tasks[199].title ?? '').length).toBe(TITLE_MAX)
  expect(Array.from(out.report?.title ?? '').length).toBe(TITLE_MAX)
})

test('cap: plan-mode steps and task-tool items are bounded the same way', async () => {
  const items = Array.from({ length: 3000 }, (_, i) => ({ id: String(i + 1), title: longTitle(i), status: 'open' as const }))
  const plan = { title: 't', groups: [{ id: 'g', title: 'G' }], steps: items.map((s) => ({ ...s, group: 0 })) }
  const out = capSession({ filter: null, report: null, plan, tasks: items, agents: [], log: [], savedAt: 1 } as never)
  expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_RECORD_BYTES)
  expect(out.plan?.steps.length).toBe(TASKS_MAX)
  expect(out.tasks?.length).toBe(TASKS_MAX)
  expect(Array.from(out.tasks?.[0].title ?? '').length).toBe(TITLE_MAX)
  expect(Array.from(out.plan?.steps[0].title ?? '').length).toBe(TITLE_MAX)
})

test('cap: a record inside the caps is not touched', async () => {
  const report = { title: 'Ship', tasks: [{ id: '1', title: 'one', status: 'done' as const }] }
  const rec = { filter: null, report, agents: [], log: [], savedAt: 1 }
  expect(capSession(rec as never).report).toEqual(report)
})

test('cap: over 3 MiB with nothing left to drop from agents or log, the lists go before the guard gives up', async () => {
  const fat = 'x'.repeat(10_900)
  const live = Array.from({ length: 280 }, (_, i) => ({ ...savedAgent('live' + i), status: 'running', question: fat }))
  const report = { title: 'Ship', tasks: Array.from({ length: 200 }, (_, i) => ({ id: String(i + 1), title: 'x'.repeat(190), status: 'open' as const })) }
  const rec = { filter: null, report, plan: null, tasks: null, agents: live, log: [], savedAt: 1 }
  const bare = JSON.stringify({ ...rec, report: null }).length
  expect(bare).toBeLessThan(MAX_RECORD_BYTES)
  expect(JSON.stringify(rec).length).toBeGreaterThan(MAX_RECORD_BYTES)
  const out = capSession(rec as never)
  expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_RECORD_BYTES)
  expect((out.report?.tasks.length ?? 0)).toBeLessThan(200)
  expect(out.agents.length).toBe(280) // an agent still at work is never shed
})
