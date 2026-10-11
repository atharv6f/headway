import { expect, test } from 'claude-code/testing'
import { bandLines, bandVisible } from '../plugin/hooks/band.tsx'
import { PLAN, start, TOOL, world } from './world.ts'

// The band with agents and no plan (SPEC 8.1): line 1 says no plan is pinned, line 2 carries the
// agents; quiet only when nothing is pinned and no agent is still at work.
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 100, scroll: { offset: 0, bodyRows: 15 }, view: {} }
const FILES = { '/w/plan/p.md': PLAN }

function spawnInput(n: number, description: string) {
  return {
    tool_use_id: 'toolu_' + n, prompt: 'Reply ok', description, subagentType: 'acme:scout',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  }
}

async function band($): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: 'headway', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const out: string[] = []
  for (const re of [/no plan$/, /Agents|T2/, /no current task/, /below/]) {
    const t = await ui.find({ type: 'Text', text: re })
    if (t !== undefined) out.push(re.source)
  }
  await ui.unmount()
  return out
}

test('band lines: with no goal, line 1 reads no plan in the muted slot and draws no bar', async () => {
  const lines = bandLines({ columns: 100, ascii: false, goal: null, current: { id: 'Agents', title: '', done: 0, total: 1, unit: 'agents' }, marks: { stalled: 1 } })
  const l1 = lines[0].map((s) => s.text).join('')
  expect(l1.trim()).toBe('◆ no plan')
  expect(lines[0].every((s) => s.el === 'queued' || s.text.trim() === '')).toBe(true)
  expect(lines[1].map((s) => s.text).join('')).toContain('◌ 1 stalled')
})

test('band quiet rule: nothing pinned and no agent at work is quiet; a live agent alone draws', async () => {
  expect(bandVisible({ hasSurvey: false, pinned: false, agents: 0 })).toBe(false)
  expect(bandVisible({ hasSurvey: false, pinned: false, agents: 1 })).toBe(true)
})

test('band: agents with no plan draw no plan and the agent line; once they finish the band is quiet', async ($, on) => {
  const w = world(on, { files: FILES })
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag1' }))
  on('turn.complete', async () => ({ text: '' }))
  await start($)
  await $.agent.spawn(spawnInput(1, 'T2 build'))
  const shown = await band($)
  expect(shown).toContain('no plan$')
  expect(shown).toContain('Agents|T2')
  expect(shown).toContain('below')
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't', agentId: 'ag1', reason: 'answer' })
  expect(await band($)).toEqual(['below'])
  expect(w.last.agents).toBeDefined()
})

test('band: untrack with an agent still running keeps the band, with no plan on line 1', async ($, on) => {
  world(on, { files: FILES })
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag1' }))
  await start($)
  await $.tool.call({ tool: TOOL, tool_use_id: 't', action: 'track', file: 'plan/p.md', section: 'Work', doneRule: 'column=landed' })
  await $.agent.spawn(spawnInput(1, 'T2 build'))
  await $.tool.call({ tool: TOOL, tool_use_id: 't2', action: 'untrack' })
  const shown = await band($)
  expect(shown).toContain('no plan$')
  expect(shown).toContain('Agents|T2')
})
