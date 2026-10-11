// Theme (pure): the skins store and theme-file readers, the 15-slot palette and its light variant,
// the slot map (SPEC.md 9.2) and the glyph table (9.3). Takes text and plain values; reads no file.
import { plainName } from './format.ts'

export const SLOTS = [
  'read',
  'write',
  'run',
  'search',
  'web',
  'mcp',
  'other',
  'user',
  'fg',
  'muted',
  'surface',
  'zebra',
  'ok',
  'err',
  'warn',
] as const

export type Slot = (typeof SLOTS)[number]
export type Palette = Record<Slot, string>
export type IconSet = 'unicode' | 'ascii'

export interface CustomSkin {
  base: string
  palette: Partial<Palette>
}

export interface StoreSettings {
  skin: string // a built-in name, a custom name, or 'off'
  icons: IconSet
  custom: Record<string, CustomSkin>
}

export interface ThemeFile {
  palette: Palette
  light?: Palette
}

const DEFAULT_SKIN = 'noir'
const HEX = /^#[0-9a-fA-F]{6}$/

function isSlot(s: string): s is Slot {
  return (SLOTS as readonly string[]).indexOf(s) >= 0
}

function object(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

// What skins' parsePrefs keeps of a prefs object: a skin name (noir when missing) and the icon set.
function prefsOf(raw: unknown): { skin: string; icons: IconSet } {
  const saved = object(raw) ?? {}
  return {
    skin: typeof saved.skin === 'string' ? saved.skin : DEFAULT_SKIN,
    icons: saved.icons === 'ascii' ? 'ascii' : 'unicode',
  }
}

// Reads the skins store file text. A missing or unreadable store, or one without `prefs`, is skins
// at its defaults. The `folders` entry whose key equals `cwd` (exact match) replaces `prefs`.
export function parseStore(text: string | undefined | null, cwd: string): StoreSettings {
  let data: Record<string, unknown> = {}
  if (typeof text === 'string' && text !== '') {
    try {
      data = object(JSON.parse(text)) ?? {}
    } catch {
      data = {}
    }
  }
  const folders = object(data.folders)
  const prefs = folders && Object.prototype.hasOwnProperty.call(folders, cwd) ? prefsOf(folders[cwd]) : prefsOf(data.prefs)

  const custom: Record<string, CustomSkin> = {}
  const saved = object(data.custom) ?? {}
  for (const name of Object.keys(saved)) {
    const entry = object(saved[name])
    if (!entry) continue
    const palette: Partial<Palette> = {}
    const given = object(entry.palette) ?? {}
    for (const slot of Object.keys(given)) {
      const v = given[slot]
      if (isSlot(slot) && typeof v === 'string' && HEX.test(v)) palette[slot] = v
    }
    custom[name] = { base: typeof entry.base === 'string' ? entry.base : DEFAULT_SKIN, palette }
  }
  return { skin: prefs.skin, icons: prefs.icons, custom }
}

function readBlock(text: string, key: string): Palette | undefined {
  const m = new RegExp('^\\s*' + key + ':\\s*\\{([^}]*)\\}', 'm').exec(text)
  if (!m) return undefined
  const out: Record<string, string> = {}
  const line = /\b(\w+):\s*'(#[0-9a-fA-F]{6})'/g
  let hit: RegExpExecArray | null
  while ((hit = line.exec(m[1])) !== null) if (isSlot(hit[1])) out[hit[1]] = hit[2]
  return SLOTS.every((s) => out[s] !== undefined) ? (out as Palette) : undefined
}

// A skins theme file (`hooks/themes/<skin>.ts`): the `palette:` block and the optional `light:`
// block, 15 `slot: '#rrggbb'` lines each, by regex and never evaluated. Null when no palette parses.
export function parseThemeFile(text: string): ThemeFile | null {
  const palette = readBlock(text, 'palette')
  if (!palette) return null
  const light = readBlock(text, 'light')
  return light ? { palette, light } : { palette }
}

// The highest dotted version among directory names; names that are not versions are skipped.
export function pickVersion(names: string[]): string | undefined {
  const parsed = names
    .filter((n) => /^\d+(\.\d+)*$/.test(n))
    .map((n) => ({ n, parts: n.split('.').map(Number) }))
  parsed.sort((a, b) => {
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
      const d = (b.parts[i] ?? 0) - (a.parts[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  })
  return parsed[0]?.n
}

// ---------------------------------------------------------------- skins installed and enabled (SPEC 11)

export type ThemeMode = 'auto' | 'skins' | 'plain'

// The `theme` setting; anything else is `auto`.
export function themeModeOf(v: unknown): ThemeMode {
  return v === 'skins' || v === 'plain' ? v : 'auto'
}

export interface SkinsEntry {
  marketplace: string
  enabled: boolean
}

// `enabledPlugins` of the merged settings (B1): `<name>@<marketplace>` keys with boolean values. The
// skins plugin is the key `skins@<marketplace>`; the marketplace comes from the key. No such key is
// not installed. An enabled entry wins over a disabled one when two marketplaces carry a skins.
export function skinsEntry(enabledPlugins: unknown): SkinsEntry | undefined {
  const plugins = object(enabledPlugins)
  if (!plugins) return undefined
  let found: SkinsEntry | undefined
  for (const key of Object.keys(plugins)) {
    const m = /^skins@(.+)$/.exec(key)
    // the marketplace is spliced into the cache and store paths: a name that is not a plain one is no skins
    if (!m || !plainName(m[1])) continue
    const entry = { marketplace: m[1], enabled: plugins[key] === true }
    if (entry.enabled) return entry
    found ??= entry
  }
  return found
}

// `auto`: skins installed and enabled. `skins`: installed (its files stay on disk when disabled).
// `plain`: never.
export function wantSkins(mode: ThemeMode, entry: SkinsEntry | undefined): entry is SkinsEntry {
  if (mode === 'plain' || entry === undefined) return false
  return mode === 'skins' || entry.enabled
}

export type Resolved = { off: true } | { off: false; name: string; file: string; overrides: Partial<Palette> }

// Which theme file to load, as skins resolves a name: built-in first, then a custom skin (its base's
// file plus its overrides; an unknown base is noir), else noir. 'off' is the ANSI fallback.
export function resolveSkin(settings: StoreSettings, builtins: string[]): Resolved {
  const name = settings.skin
  if (name === 'off') return { off: true }
  if (builtins.indexOf(name) >= 0) return { off: false, name, file: name, overrides: {} }
  const made = Object.prototype.hasOwnProperty.call(settings.custom, name) ? settings.custom[name] : undefined
  if (made) {
    const file = builtins.indexOf(made.base) >= 0 ? made.base : DEFAULT_SKIN
    return { off: false, name, file, overrides: made.palette }
  }
  return { off: false, name: DEFAULT_SKIN, file: DEFAULT_SKIN, overrides: {} }
}

// ---------------------------------------------------------------- light or dark

function named(value: unknown): boolean | undefined {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return s.includes('light') ? true : s.includes('dark') ? false : undefined
}

// COLORFGBG is `<fg>;<bg>` (sometimes `<fg>;<default>;<bg>`); background 7 or 15 is light.
function terminalLight(colorfgbg: string | undefined): boolean | undefined {
  if (colorfgbg === undefined) return undefined
  const parts = colorfgbg.split(';')
  const bg = Number(parts[parts.length - 1])
  return Number.isNaN(bg) ? undefined : bg === 7 || bg === 15
}

// SPEC 11: the `SKINS_THEME` variable, then a Claude Code theme name that says light or dark (the
// automatic setting is the name `auto`, which says neither), then `COLORFGBG`; dark when nothing says.
// No subprocess, so the system appearance is not asked.
export function resolveLight(h: { override?: string; theme?: unknown; colorfgbg?: string }): boolean {
  return named(h.override) ?? named(h.theme) ?? terminalLight(h.colorfgbg) ?? false
}

function channels(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

// `amount` of the way from `hex` to black.
function deepen(hex: string, amount: number): string {
  return (
    '#' +
    channels(hex)
      .map((v) => Math.round(Math.max(0, Math.min(255, v * (1 - amount)))).toString(16).padStart(2, '0'))
      .join('')
  )
}

// skins' derivation of a light palette from a dark one.
export function deriveLight(p: Palette): Palette {
  const d = (hex: string) => deepen(hex, 0.45)
  return {
    read: d(p.read),
    write: d(p.write),
    run: d(p.run),
    search: d(p.search),
    web: d(p.web),
    mcp: d(p.mcp),
    other: d(p.other),
    user: d(p.user),
    fg: '#1f1f1f',
    muted: '#6b6b6b',
    surface: '#ffffff',
    zebra: '#f2f2f2',
    ok: deepen(p.ok, 0.5),
    err: deepen(p.err, 0.25),
    warn: deepen(p.warn, 0.5),
  }
}

// ---------------------------------------------------------------- glyphs (9.3)

export interface Glyphs {
  goal: string
  current: string
  expanded: string
  collapsed: string
  running: string
  queued: string
  partial: string
  done: string
  failed: string
  blocked: string
  stalled: string
  warning: string
  fill: string
  partialFill: string
  sep: string
}

export const GLYPHS: Record<IconSet, Glyphs> = {
  unicode: {
    goal: '◆',
    current: '▸',
    expanded: '▾',
    collapsed: '▸',
    running: '●',
    queued: '○',
    partial: '◐',
    done: '✓',
    failed: '✕',
    blocked: '⊘',
    stalled: '◌',
    warning: '⚠',
    fill: '█',
    partialFill: '▓',
    sep: '·',
  },
  ascii: {
    goal: '*',
    current: '>',
    expanded: 'v',
    collapsed: '>',
    running: 'o',
    queued: '.',
    partial: '/',
    done: '+',
    failed: 'x',
    blocked: '!',
    stalled: '?',
    warning: 'W',
    fill: '#',
    partialFill: '=',
    sep: '-',
  },
}

// ---------------------------------------------------------------- the theme and the slot map (9.2)

export interface Theme {
  name: string
  ansi: boolean
  light: boolean
  icons: IconSet
  colors: Record<Slot, string | null> // null: the terminal default (ANSI fg, muted, zebra)
  dim: Slot[] // slots drawn with dimColor (ANSI muted)
  glyphs: Glyphs
}

// The ANSI fallback (9.2): colour names the terminal's own palette keeps readable on light and dark
// backgrounds; never white or black. `fg`, `muted`, `zebra` and `other` carry none (the terminal's
// foreground); muted is dim.
export const ANSI_COLORS: Record<Slot, string | null> = {
  read: 'cyan',
  write: 'magenta',
  run: 'yellow',
  search: 'blue',
  web: 'blue',
  mcp: 'cyan',
  other: null,
  user: 'yellow',
  fg: null,
  muted: null,
  surface: 'gray',
  zebra: null,
  ok: 'green',
  err: 'red',
  warn: 'yellow',
}

// `file` null is the ANSI fallback (skin off, or a theme file that cannot be read). `custom` marks a
// skin made from a base: its light palette is derived from the merged dark one, as skins does.
export function buildTheme(o: {
  name: string
  icons: IconSet
  file: ThemeFile | null
  overrides?: Partial<Palette>
  light: boolean
  custom?: boolean
}): Theme {
  const glyphs = GLYPHS[o.icons]
  if (o.file === null) {
    return { name: o.name, ansi: true, light: o.light, icons: o.icons, colors: { ...ANSI_COLORS }, dim: ['muted'], glyphs }
  }
  const dark: Palette = { ...o.file.palette, ...(o.overrides ?? {}) }
  let colors: Palette = dark
  if (o.light) colors = o.custom === true ? deriveLight(dark) : o.file.light ?? deriveLight(dark)
  return { name: o.name, ansi: false, light: o.light, icons: o.icons, colors: { ...colors }, dim: [], glyphs }
}

export type Element =
  | 'goalGlyph'
  | 'goalLabel'
  | 'activeTab'
  | 'barFill'
  | 'doneGlyph'
  | 'taskDone'
  | 'currentGlyph'
  | 'taskBar'
  | 'running'
  | 'partial'
  | 'barPartial'
  | 'track'
  | 'queued'
  | 'timestamp'
  | 'modelEffort'
  | 'counts'
  | 'inactiveTab'
  | 'unassigned'
  | 'failed'
  | 'stalled'
  | 'ctxCritical'
  | 'blocked'
  | 'warning'
  | 'ctxWarn'
  | 'compactHint'
  | 'title'
  | 'id'
  | 'text'
  | 'zebra'

interface ElementSpec {
  slot: Slot
  bold?: true
  bg?: true // drawn as a background
}

export const ELEMENTS: Record<Element, ElementSpec> = {
  goalGlyph: { slot: 'user', bold: true },
  goalLabel: { slot: 'user', bold: true },
  activeTab: { slot: 'user', bold: true },
  barFill: { slot: 'ok' },
  doneGlyph: { slot: 'ok' },
  taskDone: { slot: 'ok' },
  currentGlyph: { slot: 'run' },
  taskBar: { slot: 'run' },
  running: { slot: 'run' },
  partial: { slot: 'run' },
  barPartial: { slot: 'run' },
  track: { slot: 'surface', bg: true },
  queued: { slot: 'muted' },
  timestamp: { slot: 'muted' },
  modelEffort: { slot: 'muted' },
  counts: { slot: 'muted' },
  inactiveTab: { slot: 'muted' },
  unassigned: { slot: 'muted' },
  failed: { slot: 'err' },
  stalled: { slot: 'err' },
  ctxCritical: { slot: 'err' },
  blocked: { slot: 'warn', bold: true },
  warning: { slot: 'warn', bold: true },
  ctxWarn: { slot: 'warn', bold: true },
  compactHint: { slot: 'warn', bold: true },
  title: { slot: 'fg' },
  id: { slot: 'fg' },
  text: { slot: 'fg' },
  zebra: { slot: 'zebra', bg: true },
}

// Role text by role (9.2); a workflow agent is `mcp`. A role the table does not name is plain text.
export function roleSlot(role: string): Slot {
  switch (role) {
    case 'scout':
      return 'search'
    case 'implementer':
      return 'write'
    case 'debugger':
      return 'err'
    case 'evaluator':
      return 'read'
    case 'runner':
      return 'run'
    case 'hand':
      return 'other'
    case 'workflow-subagent':
    case 'workflow':
      return 'mcp'
    default:
      return 'fg'
  }
}

export interface TextStyle {
  color?: string
  backgroundColor?: string
  dimColor?: true
  bold?: true
}

// The `Text` props of an element: a hex goes straight into `color` (Milestone 0 check 4).
export function style(theme: Theme, el: Element): TextStyle {
  const spec = ELEMENTS[el]
  const c = theme.colors[spec.slot]
  const out: TextStyle = {}
  if (spec.bg === true) {
    if (c !== null) out.backgroundColor = c
    return out
  }
  if (c !== null) out.color = c
  if (theme.dim.indexOf(spec.slot) >= 0) out.dimColor = true
  if (spec.bold === true) out.bold = true
  return out
}
