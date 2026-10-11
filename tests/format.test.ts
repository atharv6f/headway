import { expect, test } from 'claude-code/testing'
import { bar, basename, clean, formatAgo, formatClock, formatCounts, formatDuration, formatEstUsd, formatTokens, formatUsd, stripControls, truncate } from '../hooks/format.ts'

const FRAC = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

test('a done bar fills whole cells then one fractional cell, floored to an eighth', async () => {
  // 163/327 of 40 cells = 19.94 cells: 19 full, then 7/8
  const b = bar({ done: 163, total: 327, width: 40 })
  expect(b.done).toBe('█'.repeat(19) + '▉')
  expect(b.partial).toBe('')
  expect(b.track).toBe(' '.repeat(20))
  expect(b.text).toBe(b.done + b.track)
  expect(Array.from(b.text).length).toBe(40)
})

test('every eighth maps to its glyph', async () => {
  for (let e = 0; e < 8; e++) {
    const b = bar({ done: 4 * 8 + e, total: 10 * 8, width: 10 })
    // (32+e)/80 of 10 cells = 4 + e/8 cells
    expect(b.done).toBe('█'.repeat(4) + FRAC[e])
    expect(Array.from(b.text).length).toBe(10)
  }
})

test('empty and full bars', async () => {
  expect(bar({ done: 0, total: 5, width: 12 }).text).toBe(' '.repeat(12))
  expect(bar({ done: 5, total: 5, width: 12 }).text).toBe('█'.repeat(12))
  expect(bar({ done: 0, total: 0, width: 12 }).text).toBe(' '.repeat(12))
  expect(bar({ done: 9, total: 5, width: 12 }).text).toBe('█'.repeat(12))
})

test('two-tone at 40 cells: done, then partial rounded to whole cells, then track', async () => {
  // 141/327 of 40 = 17.25 -> 17 partial cells
  const only = bar({ done: 0, partial: 141, total: 327, width: 40 })
  expect(only.done).toBe('')
  expect(only.partial).toBe('▓'.repeat(17))
  expect(only.track).toBe(' '.repeat(23))
  // 100/327 of 40 = 12.23: done 12 full + 1/8; partial round(12.23) = 12
  const both = bar({ done: 100, partial: 100, total: 327, width: 40 })
  expect(both.done).toBe('█'.repeat(12) + '▏')
  expect(both.partial).toBe('▓'.repeat(12))
  expect(both.track).toBe(' '.repeat(15))
  expect(Array.from(both.text).length).toBe(40)
})

test('two-tone at 12 cells', async () => {
  // 141/327 of 12 = 5.17 -> 5
  const only = bar({ done: 0, partial: 141, total: 327, width: 12 })
  expect(only.partial).toBe('▓'.repeat(5))
  expect(Array.from(only.text).length).toBe(12)
  const both = bar({ done: 4, partial: 2, total: 12, width: 12 })
  expect(both.done).toBe('█'.repeat(4))
  expect(both.partial).toBe('▓▓')
  expect(both.track).toBe(' '.repeat(6))
})

test('the fractional cell belongs to the done fill only; the bar never exceeds its width', async () => {
  // done 2.5 cells = 2 full + 4/8; partial round(2.5) = 3 would overflow 5 cells, so it is clamped
  const b = bar({ done: 5, partial: 5, total: 10, width: 5 })
  expect(b.done).toBe('██▌')
  expect(b.partial).toBe('▓▓')
  expect(b.track).toBe('')
  expect(Array.from(b.text).length).toBe(5)
})

test('ascii mode: # fill, no fractional cell, = partial, - track', async () => {
  const a = bar({ done: 163, total: 327, width: 40, ascii: true })
  expect(a.done).toBe('#'.repeat(19))
  expect(a.track).toBe('-'.repeat(21))
  const t = bar({ done: 100, partial: 100, total: 327, width: 40, ascii: true })
  expect(t.done).toBe('#'.repeat(12))
  expect(t.partial).toBe('='.repeat(12))
  expect(t.track).toBe('-'.repeat(16))
  expect(t.text.length).toBe(40)
  const s = bar({ done: 0, partial: 141, total: 327, width: 12, ascii: true })
  expect(s.text).toBe('=====' + '-------')
})

test('count text names the columns with a partial rule, else done/total', async () => {
  expect(formatCounts({ done: 0, partial: 141, open: 186, total: 327, doneWord: 'landed', partialWord: 'published' })).toBe('landed 0 · published 141 · open 186 / 327')
  expect(formatCounts({ done: 0, partial: 141, open: 186, total: 327, doneWord: 'landed', partialWord: 'published', ascii: true })).toBe('landed 0 - published 141 - open 186 / 327')
  expect(formatCounts({ done: 163, partial: 0, open: 164, total: 327, doneWord: 'live' })).toBe('163/327 done')
  expect(formatCounts({ done: 0, partial: 0, open: 3, total: 3, doneWord: 'done', noDoneRule: true })).toBe('0/3 done · no done rule')
})

test('durations', async () => {
  expect(formatClock(372_000)).toBe('06:12')
  expect(formatClock(40_000)).toBe('00:40')
  expect(formatClock(3_723_000)).toBe('1:02:03')
  expect(formatClock(-5)).toBe('00:00')
  expect(formatDuration(867)).toBe('0s')
  expect(formatDuration(20_000)).toBe('20s')
  expect(formatDuration(252_000)).toBe('4m12s')
  expect(formatDuration(65_000)).toBe('1m05s')
  expect(formatDuration(3_660_000)).toBe('1h01m')
  expect(formatAgo(20_000)).toBe('20s')
  expect(formatAgo(14 * 60_000 + 5_000)).toBe('14m')
  expect(formatAgo(2 * 3_600_000 + 1)).toBe('2h')
})

test('money and tokens', async () => {
  expect(formatUsd(12.3449)).toBe('$12.34')
  expect(formatUsd(0)).toBe('$0.00')
  expect(formatEstUsd(0.42)).toBe('est.$0.42')
  // a positive amount under one cent never reads as nothing spent
  expect(formatUsd(0.004)).toBe('<$0.01')
  expect(formatUsd(0.0099)).toBe('<$0.01')
  expect(formatUsd(0.01)).toBe('$0.01')
  expect(formatEstUsd(0.0004)).toBe('est.<$0.01')
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(42_100)).toBe('42.1k')
  expect(formatTokens(310_000)).toBe('310k')
  expect(formatTokens(1_250_000)).toBe('1.3M')
})

test('truncate cuts to the width with an ellipsis and leaves short text alone', async () => {
  expect(truncate('hello', 10)).toBe('hello')
  expect(truncate('hello', 5)).toBe('hello')
  expect(truncate('hello world', 8)).toBe('hello w…')
  expect(Array.from(truncate('One dark-mode toggle placement', 12)).length).toBe(12)
  expect(truncate('abc', 1)).toBe('…')
  expect(truncate('abc', 0)).toBe('')
})

// ---------------------------------------------------------------- the one sanitizer

test('clean: line breaks, tabs and runs of whitespace become one space', async () => {
  expect(clean('Read\nthe\r\nfile\tnow')).toBe('Read the file now')
  expect(clean('  a   b \u2028 c  ')).toBe('a b c')
  expect(clean('goal: x\ndone: 9/9')).toBe('goal: x done: 9/9')
})

test('clean: ESC sequences go, their text stays: colour, cursor, title, a screen clear', async () => {
  expect(clean('\u001b[31mred\u001b[0m')).toBe('red')
  expect(clean('a\u001b[2J\u001b[Hb')).toBe('ab')
  expect(clean('\u001b]0;pwned title\u0007visible')).toBe('visible')
  expect(clean('\u001b]0;pwned title\u001b\\visible')).toBe('visible')
  expect(clean('\u001bcreset')).toBe('reset')
})

test('clean: an OSC 8 link keeps its text and loses its target', async () => {
  const link = '\u001b]8;;https://evil.example/x\u001b\\click here\u001b]8;;\u001b\\'
  expect(clean('see ' + link + ' now')).toBe('see click here now')
  expect(clean('\u001b]8;;https://evil.example/x\u0007text\u001b]8;;\u0007')).toBe('text')
  // the 8-bit forms of the same introducers
  expect(clean('\u009d8;;https://evil.example/x\u009ctext')).toBe('text')
  expect(clean('\u009b31mred')).toBe('red')
})

test('clean: C0 and C1 controls, DEL, bell, NUL and bidi overrides are dropped; ordinary text is not', async () => {
  expect(clean('a\u0000b\u0007c\u007fd\u0085e\u0080f')).toBe('abcdef')
  expect(clean('abc\u202edef')).toBe('abcdef')
  expect(clean('naïve — café ✓ 日本語 👍🏽')).toBe('naïve — café ✓ 日本語 👍🏽')
})

test('clean: join controls, direction marks and variation selectors survive; bidi embeddings, overrides, isolates and tag characters go', async () => {
  const family = '👨\u200d👩\u200d👧\u200d👦'
  expect(clean('see ' + family + ' ok')).toBe('see ' + family + ' ok')
  expect(clean('❤\ufe0f ✌\ufe0e')).toBe('❤\ufe0f ✌\ufe0e')
  const persian = 'می\u200cخواهم'
  expect(clean(persian)).toBe(persian)
  expect(clean('a\u200eb\u200fc\u061cd')).toBe('a\u200eb\u200fc\u061cd')
  expect(clean('x\u202ay\u202bz\u202cw\u202dv\u202eu')).toBe('xyzwvu')
  expect(clean('x\u2066y\u2067z\u2068w\u2069v')).toBe('xyzwv')
  const tagged = '\u{E0001}\u{E0041}\u{E007F}'
  expect(clean('flag🏴' + tagged + 'ok')).toBe('flag🏴ok')
  expect(stripControls('a\ufeffb\u00adc\u200bd')).toBe('abcd')
})

test('clean: an unterminated OSC or a lone ESC at the end does not eat the rest of a later line', async () => {
  expect(clean('x\u001b')).toBe('x')
  expect(clean('x\u001b]0;never closed')).toBe('x')
})

test('clean: a cap in code points ends in an ellipsis', async () => {
  expect(clean('a'.repeat(300), 200)).toBe('a'.repeat(199) + '…')
  expect(clean('short', 200)).toBe('short')
  expect(Array.from(clean('é'.repeat(500), 200)).length).toBe(200)
})

test('stripControls: keeps the layout spaces a row is padded with, still turns breaks into one space', async () => {
  expect(stripControls('id    title')).toBe('id    title')
  expect(stripControls('a\nb\tc\u001b[1mD')).toBe('a b cD')
})

test('basename: the last segment of a path, either separator', async () => {
  expect(basename('/a/b/c.md')).toBe('c.md')
  expect(basename('C:\\Users\\me\\plan.md')).toBe('plan.md')
  expect(basename('plan.md')).toBe('plan.md')
})
