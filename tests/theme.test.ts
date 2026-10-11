import { expect, test } from 'claude-code/testing'
import {
  ANSI_COLORS,
  GLYPHS,
  SLOTS,
  skinsEntry,
  themeModeOf,
  wantSkins,
  buildTheme,
  deriveLight,
  parseStore,
  parseThemeFile,
  pickVersion,
  resolveLight,
  resolveSkin,
  roleSlot,
  style,
} from '../plugin/hooks/theme.ts'

const NOIR = `import type { Skin } from '../skin'

// Black and white, and white and black on a light background.
const skin: Skin = {
  name: 'noir',
  label: 'Noir',
  palette: {
    read: '#ededed',
    write: '#ededed',
    run: '#ededed',
    search: '#ededed',
    web: '#ededed',
    mcp: '#ededed',
    other: '#ededed',
    user: '#f5f5f5',
    fg: '#ededed',
    muted: '#8c8c8c',
    surface: '#151515',
    zebra: '#1c1c1c',
    ok: '#ededed',
    err: '#f87171',
    warn: '#a3a3a3',
  },
  light: {
    read: '#111111',
    write: '#111111',
    run: '#111111',
    search: '#111111',
    web: '#111111',
    mcp: '#111111',
    other: '#111111',
    user: '#111111',
    fg: '#151515',
    muted: '#6b6b6b',
    surface: '#ffffff',
    zebra: '#f2f2f2',
    ok: '#151515',
    err: '#c42b2b',
    warn: '#6b6b6b',
  },
  spinner: ['Thinking'],
  done: ['Done'],
}

export default skin
`

const DRACULA = `const skin: Skin = {
  name: 'dracula',
  label: 'Dracula',
  palette: {
    read: '#8be9fd',
    write: '#ffb86c',
    run: '#f1fa8c',
    search: '#bd93f9',
    web: '#ff79c6',
    mcp: '#50fa7b',
    other: '#f8f8f2',
    user: '#ff79c6',
    fg: '#f8f8f2',
    muted: '#6272a4',
    surface: '#282a36',
    zebra: '#2f3140',
    ok: '#50fa7b',
    err: '#ff5555',
    warn: '#ffb86c',
  },
  spinner: ['Thinking'],
}
`

const BUILTINS = ['noir', 'dracula', 'nord']

// ---------------------------------------------------------------- the skins store

test('a missing, empty or broken store means skins at its defaults: noir and unicode', async () => {
  for (const text of [undefined, null, '', 'not json', '[]', '3']) {
    const s = parseStore(text, '/work')
    expect(s.skin).toBe('noir')
    expect(s.icons).toBe('unicode')
    expect(s.custom).toEqual({})
  }
})

test('a store without prefs is the defaults, custom skins still read', async () => {
  const s = parseStore(JSON.stringify({ updateCheck: { at: 1 }, custom: { mine: { name: 'mine', base: 'nord', label: 'Mine', palette: { ok: '#112233' } } } }), '/work')
  expect(s.skin).toBe('noir')
  expect(s.icons).toBe('unicode')
  expect(s.custom.mine).toEqual({ base: 'nord', palette: { ok: '#112233' } })
})

test('prefs.skin and prefs.icons are read; an icons value other than ascii is unicode', async () => {
  const a = parseStore(JSON.stringify({ prefs: { skin: 'dracula', icons: 'ascii' } }), '/work')
  expect([a.skin, a.icons]).toEqual(['dracula', 'ascii'])
  const b = parseStore(JSON.stringify({ prefs: { skin: 'off', icons: 'weird' } }), '/work')
  expect([b.skin, b.icons]).toEqual(['off', 'unicode'])
  const c = parseStore(JSON.stringify({ prefs: { skin: 7 } }), '/work')
  expect(c.skin).toBe('noir')
})

test('the folder entry whose key equals the cwd replaces prefs; other folders do not', async () => {
  const store = JSON.stringify({
    prefs: { skin: 'dracula', icons: 'ascii' },
    folders: { '/work': { skin: 'nord' }, '/other': { skin: 'noir', icons: 'ascii' } },
  })
  const hit = parseStore(store, '/work')
  expect([hit.skin, hit.icons]).toEqual(['nord', 'unicode'])
  expect(parseStore(store, '/work/sub').skin).toBe('dracula')
  expect(parseStore(store, '/work/sub').icons).toBe('ascii')
})

test('malformed custom entries are dropped, bad colours too', async () => {
  const s = parseStore(
    JSON.stringify({ custom: { a: { base: 'nord', palette: { ok: '#123456', err: 'red', nope: '#000000' } }, b: 4, c: { palette: {} } } }),
    '/w',
  )
  expect(s.custom.a).toEqual({ base: 'nord', palette: { ok: '#123456' } })
  expect(s.custom.b).toBeUndefined()
  expect(s.custom.c).toEqual({ base: 'noir', palette: {} })
})

// ---------------------------------------------------------------- the theme file

test('a theme file is read by regex: palette block, and the light block when it has one', async () => {
  const noir = parseThemeFile(NOIR)
  expect(noir).not.toBeNull()
  expect(Object.keys(noir!.palette).sort()).toEqual([...SLOTS].sort())
  expect(noir!.palette.muted).toBe('#8c8c8c')
  expect(noir!.light?.muted).toBe('#6b6b6b')
  const dracula = parseThemeFile(DRACULA)
  expect(dracula!.palette.surface).toBe('#282a36')
  expect(dracula!.light).toBeUndefined()
})

test('a theme file with a slot missing, or no palette, does not parse', async () => {
  expect(parseThemeFile(NOIR.replace("    warn: '#a3a3a3',\n", ''))).toBeNull()
  expect(parseThemeFile('export default {}')).toBeNull()
  expect(parseThemeFile('')).toBeNull()
})

test('a light block missing a slot is ignored, not half used', async () => {
  const t = parseThemeFile(NOIR.replace("    warn: '#6b6b6b',\n", ''))
  expect(t!.light).toBeUndefined()
})

test('the highest installed skins version wins, compared as numbers', async () => {
  expect(pickVersion(['0.5.1', '0.10.0', '0.9.9'])).toBe('0.10.0')
  expect(pickVersion(['0.5.1'])).toBe('0.5.1')
  expect(pickVersion([])).toBeUndefined()
  expect(pickVersion(['readme', '1.0.0'])).toBe('1.0.0')
})

// ---------------------------------------------------------------- which skin

test('a built-in skin loads its own theme file', async () => {
  const s = parseStore(JSON.stringify({ prefs: { skin: 'dracula' } }), '/w')
  expect(resolveSkin(s, BUILTINS)).toEqual({ off: false, name: 'dracula', file: 'dracula', overrides: {} })
})

test('a custom skin is its base with its overrides; an unknown base falls to noir', async () => {
  const s = parseStore(JSON.stringify({ prefs: { skin: 'mine' }, custom: { mine: { base: 'nord', palette: { ok: '#112233' } } } }), '/w')
  expect(resolveSkin(s, BUILTINS)).toEqual({ off: false, name: 'mine', file: 'nord', overrides: { ok: '#112233' } })
  const t = parseStore(JSON.stringify({ prefs: { skin: 'mine' }, custom: { mine: { base: 'gone', palette: {} } } }), '/w')
  expect(resolveSkin(t, BUILTINS).off).toBe(false)
  expect((resolveSkin(t, BUILTINS) as { file: string }).file).toBe('noir')
})

test('a built-in name beats a custom one of the same name; an unknown skin is noir; off is off', async () => {
  const s = parseStore(JSON.stringify({ prefs: { skin: 'nord' }, custom: { nord: { base: 'dracula', palette: {} } } }), '/w')
  expect((resolveSkin(s, BUILTINS) as { file: string }).file).toBe('nord')
  const u = parseStore(JSON.stringify({ prefs: { skin: 'ghost' } }), '/w')
  expect((resolveSkin(u, BUILTINS) as { file: string }).file).toBe('noir')
  const o = parseStore(JSON.stringify({ prefs: { skin: 'off' } }), '/w')
  expect(resolveSkin(o, BUILTINS).off).toBe(true)
})

// ---------------------------------------------------------------- light or dark

test('light or dark: SKINS_THEME, then the Claude Code theme row, then COLORFGBG, else dark', async () => {
  expect(resolveLight({ override: 'light' })).toBe(true)
  expect(resolveLight({ override: 'dark', theme: 'light' })).toBe(false)
  expect(resolveLight({ override: 'light', theme: 'dark', colorfgbg: '15;0' })).toBe(true)
  expect(resolveLight({ theme: 'light-daltonized' })).toBe(true)
  expect(resolveLight({ theme: 'dark-ansi' })).toBe(false)
  expect(resolveLight({ theme: 'dark', colorfgbg: '0;15' })).toBe(false)
  expect(resolveLight({ theme: 'light', colorfgbg: '15;0' })).toBe(true)
  // B6: the automatic case is the row value `auto`, which says neither
  expect(resolveLight({ theme: 'auto', colorfgbg: '0;15' })).toBe(true)
  expect(resolveLight({ theme: 'auto', colorfgbg: '15;0' })).toBe(false)
  expect(resolveLight({ theme: 'auto', colorfgbg: '0;default;7' })).toBe(true)
  expect(resolveLight({ theme: 'auto' })).toBe(false)
  expect(resolveLight({})).toBe(false)
  expect(resolveLight({ theme: 'auto', colorfgbg: 'nonsense' })).toBe(false)
})

// ---------------------------------------------------------------- skins installed and enabled (B1)

test('skinsEntry: the marketplace comes from the enabledPlugins key; no key is not installed', async () => {
  expect(skinsEntry({ 'headway@example-mods': true, 'skins@example-mods': true })).toEqual({ marketplace: 'example-mods', enabled: true })
  expect(skinsEntry({ 'skins@other-market': false })).toEqual({ marketplace: 'other-market', enabled: false })
  expect(skinsEntry({ 'skins@a': false, 'skins@b': true })).toEqual({ marketplace: 'b', enabled: true })
  expect(skinsEntry({ 'headway@example-mods': true, 'skinsy@x': true })).toBeUndefined()
  expect(skinsEntry({})).toBeUndefined()
  expect(skinsEntry(undefined)).toBeUndefined()
  expect(skinsEntry('skins@x')).toBeUndefined()
  expect(skinsEntry({ 'skins@x': 'yes' })).toEqual({ marketplace: 'x', enabled: false })
})

test('theme setting: auto uses skins when enabled, skins when installed, plain never', async () => {
  const on = { marketplace: 'm', enabled: true }
  const off = { marketplace: 'm', enabled: false }
  expect(wantSkins('auto', on)).toBe(true)
  expect(wantSkins('auto', off)).toBe(false)
  expect(wantSkins('auto', undefined)).toBe(false)
  expect(wantSkins('skins', on)).toBe(true)
  expect(wantSkins('skins', off)).toBe(true)
  expect(wantSkins('skins', undefined)).toBe(false)
  expect(wantSkins('plain', on)).toBe(false)
  expect(wantSkins('plain', off)).toBe(false)
  expect(themeModeOf('skins')).toBe('skins')
  expect(themeModeOf('plain')).toBe('plain')
  expect(themeModeOf('auto')).toBe('auto')
  expect(themeModeOf('neon')).toBe('auto')
  expect(themeModeOf(undefined)).toBe('auto')
})

test('the derived light palette follows skins: fixed fg, muted, surface, zebra; the rest deepened', async () => {
  const dark = parseThemeFile(DRACULA)!.palette
  const light = deriveLight(dark)
  expect([light.fg, light.muted, light.surface, light.zebra]).toEqual(['#1f1f1f', '#6b6b6b', '#ffffff', '#f2f2f2'])
  // 0.45 of the way to black: 0x8b * 0.55 = 76.45 -> 0x4c, 0xe9 * 0.55 = 128.15 -> 0x80, 0xfd * 0.55 = 139.15 -> 0x8b
  expect(light.read).toBe('#4c808b')
  // ok by 0.5: 0x50 * 0.5 = 40 -> 0x28, 0xfa * .5 = 125 -> 0x7d, 0x7b * .5 = 61.5 -> 0x3e (rounded)
  expect(light.ok).toBe('#287d3e')
  // err by 0.25: 0xff * .75 = 191.25 -> 0xbf, 0x55 * .75 = 63.75 -> 0x40
  expect(light.err).toBe('#bf4040')
})

test('a light theme uses the skin light block when present, else the derivation', async () => {
  const noir = buildTheme({ name: 'noir', icons: 'unicode', file: parseThemeFile(NOIR), light: true })
  expect(noir.colors.muted).toBe('#6b6b6b')
  expect(noir.colors.err).toBe('#c42b2b')
  const dracula = buildTheme({ name: 'dracula', icons: 'unicode', file: parseThemeFile(DRACULA), light: true })
  expect(dracula.colors.surface).toBe('#ffffff')
  expect(dracula.colors.read).toBe('#4c808b')
})

test('a custom skin overrides its base; in light it is derived from the merged palette', async () => {
  const file = parseThemeFile(NOIR)
  const dark = buildTheme({ name: 'mine', icons: 'unicode', file, overrides: { ok: '#112233' }, light: false })
  expect(dark.colors.ok).toBe('#112233')
  expect(dark.colors.muted).toBe('#8c8c8c')
  const light = buildTheme({ name: 'mine', icons: 'unicode', file, overrides: { ok: '#112233' }, light: true, custom: true })
  expect(light.colors.fg).toBe('#1f1f1f')
  expect(light.colors.ok).toBe('#09111a')
})

// ---------------------------------------------------------------- ANSI fallback

test('ANSI fallback: only when there is no theme file; colour names, muted dim', async () => {
  const t = buildTheme({ name: 'off', icons: 'unicode', file: null, light: false })
  expect(t.ansi).toBe(true)
  expect(t.colors.ok).toBe('green')
  expect(t.colors.err).toBe('red')
  expect(t.colors.warn).toBe('yellow')
  expect(t.colors.surface).toBe('gray')
  expect(t.colors.fg).toBeNull()
  expect(t.colors.zebra).toBeNull()
  expect(t.colors.muted).toBeNull()
  expect(style(t, 'counts')).toEqual({ dimColor: true })
  expect(style(t, 'track')).toEqual({ backgroundColor: 'gray' })
  expect(ANSI_COLORS.user).toBe('yellow')
  expect(ANSI_COLORS.mcp).toBe('cyan')
})

test('plain palette: no slot is white or black, which vanish on a light or a dark terminal', async () => {
  const unreadable = /^(white|black|whiteBright|blackBright|#fff(fff)?|#000(000)?)$/i
  const bad = Object.entries(ANSI_COLORS).filter(([, c]) => c !== null && unreadable.test(c))
  expect(bad).toEqual([])
  // an uncategorised tool kind draws in the terminal's own foreground, readable on every background
  expect(ANSI_COLORS.other).toBeNull()
  const t = buildTheme({ name: 'off', icons: 'unicode', file: null, light: true })
  expect(t.colors.other).toBeNull()
})

// ---------------------------------------------------------------- slots and glyphs

test('element to slot mapping (9.2)', async () => {
  const t = buildTheme({ name: 'noir', icons: 'unicode', file: parseThemeFile(DRACULA), light: false })
  expect(style(t, 'goalGlyph')).toEqual({ color: '#ff79c6', bold: true })
  expect(style(t, 'goalLabel')).toEqual({ color: '#ff79c6', bold: true })
  expect(style(t, 'barFill')).toEqual({ color: '#50fa7b' })
  expect(style(t, 'doneGlyph')).toEqual({ color: '#50fa7b' })
  expect(style(t, 'currentGlyph')).toEqual({ color: '#f1fa8c' })
  expect(style(t, 'partial')).toEqual({ color: '#f1fa8c' })
  expect(style(t, 'barPartial')).toEqual({ color: '#f1fa8c' })
  expect(style(t, 'track')).toEqual({ backgroundColor: '#282a36' })
  expect(style(t, 'queued')).toEqual({ color: '#6272a4' })
  expect(style(t, 'counts')).toEqual({ color: '#6272a4' })
  expect(style(t, 'failed')).toEqual({ color: '#ff5555' })
  expect(style(t, 'stalled')).toEqual({ color: '#ff5555' })
  expect(style(t, 'blocked')).toEqual({ color: '#ffb86c', bold: true })
  expect(style(t, 'warning')).toEqual({ color: '#ffb86c', bold: true })
  expect(style(t, 'compactHint')).toEqual({ color: '#ffb86c', bold: true })
  expect(style(t, 'title')).toEqual({ color: '#f8f8f2' })
  expect(style(t, 'zebra')).toEqual({ backgroundColor: '#2f3140' })
})

test('role text slots', async () => {
  expect(roleSlot('scout')).toBe('search')
  expect(roleSlot('implementer')).toBe('write')
  expect(roleSlot('debugger')).toBe('err')
  expect(roleSlot('evaluator')).toBe('read')
  expect(roleSlot('runner')).toBe('run')
  expect(roleSlot('hand')).toBe('other')
  expect(roleSlot('workflow-subagent')).toBe('mcp')
  expect(roleSlot('mystery')).toBe('fg')
})

test('glyph table (9.3): unicode and ascii, single cells, no emoji', async () => {
  const u = GLYPHS.unicode
  const a = GLYPHS.ascii
  expect([u.goal, u.current, u.expanded, u.collapsed, u.running, u.queued, u.partial, u.done, u.failed, u.blocked, u.stalled, u.warning, u.sep]).toEqual(
    ['◆', '▸', '▾', '▸', '●', '○', '◐', '✓', '✕', '⊘', '◌', '⚠', '·'],
  )
  expect([a.goal, a.current, a.expanded, a.collapsed, a.running, a.queued, a.partial, a.done, a.failed, a.blocked, a.stalled, a.warning, a.sep]).toEqual(
    ['*', '>', 'v', '>', 'o', '.', '/', '+', 'x', '!', '?', 'W', '-'],
  )
  expect([u.fill, u.partialFill, a.fill, a.partialFill]).toEqual(['█', '▓', '#', '='])
  for (const g of [...Object.values(u), ...Object.values(a)]) expect(Array.from(g).length).toBe(1)
})

test('the theme carries its icon set', async () => {
  expect(buildTheme({ name: 'n', icons: 'ascii', file: parseThemeFile(NOIR), light: false }).glyphs).toEqual(GLYPHS.ascii)
  expect(buildTheme({ name: 'n', icons: 'unicode', file: null, light: false }).glyphs).toEqual(GLYPHS.unicode)
})
