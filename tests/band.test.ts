import { expect, test } from 'claude-code/testing'
import { bandLayout, bandLines, bandVisible } from '../plugin/hooks/band.tsx'
import type { BandData, Seg } from '../plugin/hooks/band.tsx'

const plain = (line: Seg[]) => line.map((s) => s.text).join('')
const width = (line: Seg[]) => Array.from(plain(line)).length

const REL2: BandData = {
  columns: 100,
  ascii: false,
  goal: { label: 'Release 2 tasks', done: 0, partial: 141, open: 186, total: 327, doneWord: 'landed', partialWord: 'published' },
}

const PLAIN: BandData = {
  columns: 100,
  ascii: false,
  goal: { label: 'Release 2 tasks', done: 163, partial: 0, open: 164, total: 327, doneWord: 'done' },
}

// ---------------------------------------------------------------- the quiet rule

test('quiet rule: nothing pinned and no agents, a survey, or the band off draws nothing', async () => {
  expect(bandVisible({ hasSurvey: false, pinned: false, agents: 0 })).toBe(false)
  expect(bandVisible({ hasSurvey: true, pinned: true, agents: 3 })).toBe(false)
  expect(bandVisible({ hasSurvey: false, pinned: true, agents: 0, off: true })).toBe(false)
  expect(bandVisible({ hasSurvey: false, pinned: true, agents: 0 })).toBe(true)
  expect(bandVisible({ hasSurvey: false, pinned: false, agents: 2 })).toBe(true)
})

// ---------------------------------------------------------------- layout

test('widths: label 30, bar 40 when the count fits beside them', async () => {
  expect(bandLayout(100, 12)).toEqual({ label: 30, bar: 40, count: 12 })
  expect(bandLayout(200, 12)).toEqual({ label: 30, bar: 40, count: 12 })
})

test('a long count shrinks the bar first, to a minimum of 12', async () => {
  // 1 + 2 + 30 + 2 + bar + 2 + 40 = 77 + bar <= 100: bar 23
  expect(bandLayout(100, 40)).toEqual({ label: 30, bar: 23, count: 40 })
  const l = bandLayout(80, 40)
  expect(l.bar).toBe(12)
  expect(l.label).toBe(30 - (1 + 2 + 30 + 2 + 12 + 2 + 40 - 80))
})

test('then the label shrinks, to a minimum of 12, then the count is cut', async () => {
  const l = bandLayout(60, 40)
  expect(l.bar).toBe(12)
  expect(l.label).toBe(12)
  expect(l.count).toBe(60 - (1 + 2 + 12 + 2 + 12 + 2))
  expect(bandLayout(20, 40).count).toBe(0)
})

// ---------------------------------------------------------------- line 1

test('line 1 with a plain goal: glyph, label, bar with one fractional cell, count', async () => {
  const [l1] = bandLines(PLAIN)
  expect(plain(l1)).toBe(' ◆ Release 2 tasks' + ' '.repeat(15) + '  ' + '█'.repeat(19) + '▉' + ' '.repeat(20) + '  163/327 done')
  expect(width(l1)).toBeLessThanOrEqual(100)
})

test('line 1 with a partial rule: done solid, partial cells in run, track on the surface; count names the columns', async () => {
  const [l1] = bandLines(REL2)
  const text = plain(l1)
  expect(text.endsWith('landed 0 · published 141 · open 186 / 327')).toBe(true)
  expect(text.startsWith(' ◆ Release 2 tasks')).toBe(true)
  expect(width(l1)).toBe(100)
  const fills = l1.filter((s) => s.el === 'barPartial')
  expect(fills.length).toBe(1)
  // the count is 41 cells, so the bar is 100 - 7 - 30 - 41 = 22 cells; 141/327 of 22 rounds to 9
  expect(fills[0].text).toBe('▓'.repeat(9))
  expect(l1.filter((s) => s.el === 'barFill').map((s) => s.text).join('')).toBe('')
  const track = l1.find((s) => s.el === 'track')!
  expect(track.text.trim()).toBe('')
  expect(Array.from(track.text).length + 9).toBe(22)
})

test('line 1 elements: goal glyph and label, count in counts', async () => {
  const [l1] = bandLines(PLAIN)
  expect(l1.find((s) => s.text === '◆')!.el).toBe('goalGlyph')
  expect(l1.find((s) => s.text.startsWith('Release 2 tasks'))!.el).toBe('goalLabel')
  expect(l1.find((s) => s.text === '163/327 done')!.el).toBe('counts')
  expect(l1.find((s) => s.el === 'barFill')!.text).toBe('█'.repeat(19) + '▉')
})

test('ascii: * glyph, # fill without a fractional cell, = partial, - track, - separator', async () => {
  const [l1] = bandLines({ ...REL2, ascii: true, goal: { ...REL2.goal, done: 100, partial: 100, open: 127 } })
  const text = plain(l1)
  expect(text.startsWith(' * Release 2 tasks')).toBe(true)
  expect(text.includes('#')).toBe(true)
  expect(text.includes('=')).toBe(true)
  expect(text.includes('-')).toBe(true)
  expect(/[█▓▏▎▍▌▋▊▉◆·]/.test(text)).toBe(false)
  expect(text.endsWith('landed 100 - published 100 - open 127 / 327')).toBe(true)
})

test('a long label is cut with an ellipsis to its width and the bar still lines up', async () => {
  const [l1] = bandLines({ ...PLAIN, goal: { ...PLAIN.goal, label: 'A very long section heading that does not fit in thirty cells' } })
  const text = plain(l1)
  expect(text.slice(3, 33)).toBe('A very long section heading t…')
  expect(Array.from(text.slice(0, 33)).length).toBe(33)
})

test('the no-done-rule mark, the source tag and the unreadable note follow the count', async () => {
  const none = bandLines({ ...PLAIN, goal: { ...PLAIN.goal, done: 0, partial: 0, open: 327, noDoneRule: true } })[0]
  expect(plain(none).endsWith('0/327 done · no done rule')).toBe(true)
  const bad = bandLines({ ...PLAIN, goal: { ...PLAIN.goal, note: 'unreadable', source: 'file' } })[0]
  expect(plain(bad).endsWith('163/327 done  file  plan unreadable')).toBe(true)
  expect(bad[bad.length - 1].el).toBe('warning')
  for (const source of ['file', 'reported', 'plan']) {
    const tagged = bandLines({ ...PLAIN, goal: { ...PLAIN.goal, source } })[0]
    expect(plain(tagged).endsWith('163/327 done  ' + source)).toBe(true)
    // the tag is one dim word in the muted (counts) slot
    expect(tagged[tagged.length - 1]).toEqual({ text: source, el: 'counts' })
  }
})

test('every line fits the body width, at every width', async () => {
  for (const columns of [20, 40, 59, 60, 80, 99, 100, 140]) {
    const lines = bandLines({
      ...REL2,
      columns,
      current: { id: 'R02-40', title: 'its Done greps red today', done: 1, total: 3, unit: 'agents' },
      marks: { warned: 1, blocked: 1, running: 2, stalled: 1 },
      line3: { ctx: { percent: 42, level: 'ok' }, cost: '$12.34', log: { kind: 'done', text: 'R02-73 implementer done 4m12s est.$0.42' } },
    })
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(columns)
  }
})

// ---------------------------------------------------------------- line 2

test('line 2: no current task in muted when nothing is dispatched', async () => {
  const lines = bandLines(REL2)
  expect(lines.length).toBe(2)
  expect(plain(lines[1])).toBe(' ▸ no current task')
  expect(lines[1].every((s) => s.el === 'queued')).toBe(true)
})

test('line 2: current task, its bar lined up under the goal bar, agents count and marks', async () => {
  const lines = bandLines({
    ...PLAIN,
    columns: 140,
    current: { id: 'UI3', title: 'One dark-mode toggle', done: 2, total: 4, unit: 'agents' },
    marks: { running: 2, stalled: 1 },
  })
  const l1 = plain(lines[0])
  const l2 = plain(lines[1])
  expect(l2.startsWith(' ▸ UI3 One dark-mode toggle')).toBe(true)
  expect(l2.slice(33, 35)).toBe('  ')
  expect(l2.slice(35, 55)).toBe('█'.repeat(20))
  expect(l1.indexOf('█')).toBe(l2.indexOf('█'))
  expect(l2.endsWith('2/4 agents  ● 2  ◌ 1 stalled')).toBe(true)
  const sp = lines[1]
  expect(sp.find((s) => s.text === '▸')!.el).toBe('currentGlyph')
  expect(sp.find((s) => s.text.startsWith('UI3'))!.el).toBe('id')
  expect(sp.find((s) => s.el === 'taskBar')!.text).toBe('█'.repeat(20))
  expect(sp.find((s) => s.text === '◌ 1 stalled')!.el).toBe('stalled')
  expect(sp.find((s) => s.text === '● 2')!.el).toBe('running')
})

test('line 2 when everything is done reads all done in the done colour; ascii uses +', async () => {
  const l2 = bandLines({ ...PLAIN, allDone: true })[1]
  expect(plain(l2)).toBe(' ✓ all done')
  expect(l2.every((s) => s.el === 'doneGlyph' || s.el === 'taskDone' || s.el === 'text')).toBe(true)
  expect(l2.find((s) => s.text === '✓')!.el).toBe('doneGlyph')
  expect(l2.find((s) => s.text === 'all done')!.el).toBe('taskDone')
  expect(plain(bandLines({ ...PLAIN, ascii: true, allDone: true })[1])).toBe(' + all done')
})

test('line 2 draws a done task\'s agent bar in the done colour, never the partial one', async () => {
  const l2 = bandLines({ ...PLAIN, current: { id: 'S2', title: 'b', done: 1, total: 1, unit: 'agents', status: 'done' } })[1]
  expect(l2.find((s) => s.text.startsWith('█'))!.el).toBe('barFill')
  expect(l2.some((s) => s.el === 'taskBar')).toBe(false)
  expect(plain(l2).endsWith('1/1 agents')).toBe(true)
})

test('line 2 marks: warning and blocked come before stalled', async () => {
  const l2 = bandLines({
    ...PLAIN,
    columns: 140,
    current: { id: 'UI3', title: 't', done: 0, total: 1, unit: 'agents' },
    marks: { warned: 1, blocked: 2, stalled: 3 },
  })[1]
  expect(plain(l2).endsWith('0/1 agents  ⚠ 1  ⊘ 2 blocked  ◌ 3 stalled')).toBe(true)
})

test('the longer line-2 text shrinks the shared bar so the marks are not cut', async () => {
  const lines = bandLines({
    ...PLAIN,
    current: { id: 'UI3', title: 't', done: 2, total: 4, unit: 'agents' },
    marks: { running: 2, stalled: 1 },
  })
  expect(plain(lines[1]).endsWith('2/4 agents  ● 2  ◌ 1 stalled')).toBe(true)
  expect(width(lines[1])).toBe(100)
  expect(plain(lines[0]).indexOf('█')).toBe(plain(lines[1]).indexOf('█'))
})

test('line 2 with a sub-checklist bar says items', async () => {
  const l2 = bandLines({ ...PLAIN, current: { id: 'T1', title: 'a', done: 1, total: 3, unit: 'items' } })[1]
  expect(plain(l2).endsWith('1/3 items')).toBe(true)
})

// ---------------------------------------------------------------- line 3

test('line 3: absent without data and under 60 columns', async () => {
  expect(bandLines(PLAIN).length).toBe(2)
  const data = { ...PLAIN, line3: { ctx: { percent: 42, level: 'ok' as const } } }
  expect(bandLines(data).length).toBe(3)
  expect(bandLines({ ...data, columns: 59 }).length).toBe(2)
  expect(bandLines({ ...data, columns: 60 }).length).toBe(3)
})

test('line 3: context, cost and the newest log entry; the compact hint replaces the log', async () => {
  const base = { ...PLAIN, line3: { ctx: { percent: 42, level: 'ok' as const }, cost: '$12.34', log: { kind: 'done' as const, text: 'R02-73 implementer done 4m12s est.$0.42' } } }
  const l3 = bandLines(base)[2]
  expect(plain(l3)).toBe(' ctx 42%  $12.34   ✓ R02-73 implementer done 4m12s est.$0.42')
  expect(l3.find((s) => s.text === 'ctx 42%')!.el).toBe('counts')
  expect(l3.find((s) => s.text === '✓')!.el).toBe('doneGlyph')
  const hint = bandLines({ ...base, line3: { ...base.line3, hint: 'compact now: task boundary' } })[2]
  expect(plain(hint)).toBe(' ctx 42%  $12.34   ◆ compact now: task boundary')
  expect(hint[hint.length - 1].el).toBe('compactHint')
  const warn = bandLines({ ...base, line3: { ...base.line3, ctx: { percent: 75, level: 'warn' } } })[2]
  expect(warn.find((s) => s.text === 'ctx 75%')!.el).toBe('ctxWarn')
  const err = bandLines({ ...base, line3: { ...base.line3, ctx: { percent: 93, level: 'err' } } })[2]
  expect(err.find((s) => s.text === 'ctx 93%')!.el).toBe('ctxCritical')
})

test('line 3 log glyphs by kind, ascii too', async () => {
  const kinds: Array<[string, string, string, string]> = [
    ['done', '✓', '+', 'doneGlyph'],
    ['failed', '✕', 'x', 'failed'],
    ['blocked', '⊘', '!', 'blocked'],
    ['stalled', '◌', '?', 'stalled'],
    ['warn', '⚠', 'W', 'warning'],
  ]
  for (const [kind, uni, asc, el] of kinds) {
    const mk = (ascii: boolean) => bandLines({ ...PLAIN, ascii, line3: { log: { kind: kind as 'done', text: 'x' } } })[2]
    expect(plain(mk(false))).toBe(' ' + uni + ' x')
    expect(plain(mk(true))).toBe(' ' + asc + ' x')
    expect(mk(false)[1].el).toBe(el)
  }
})

// ---------------------------------------------------------------- batch B: model text on the band

test('lines: a goal label, a current task and a log text with escapes and line breaks draw as plain text', async () => {
  const evil = 'Read\nthe \u001b]8;;https://evil.example/x\u0007file\u001b]8;;\u0007 \u001b[2J'
  const lines = bandLines({
    ...PLAIN,
    goal: { ...PLAIN.goal!, label: evil },
    current: { id: '1', title: evil, done: 0, total: 1, unit: 'agents' },
    line3: { log: { kind: 'warn', text: evil } },
  })
  expect(lines.length).toBe(3)
  const all = lines.map(plain).join('\n')
  expect(all).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
  expect(all).not.toContain('evil.example')
  expect(all).toContain('file')
  expect(lines.every((l) => !plain(l).includes('\n'))).toBe(true)
})
