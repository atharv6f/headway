import { expect, test } from 'claude-code/testing'
import { PLAN, start, world, userCommand } from './world.ts'
import type { World } from './world.ts'

// P5: the settings (SPEC 13), skins optional (SPEC 11), the role file (SPEC 7), bandDefault (SPEC 10.1).
const CFG = '/h/.claude'
const SKINS_ON = { 'skins@example-mods': true }
const SKINS_OFF = { 'skins@example-mods': false }

function themeFile(over: Record<string, string> = {}, light = false): string {
  const slots = ['read', 'write', 'run', 'search', 'web', 'mcp', 'other', 'user', 'fg', 'muted', 'surface', 'zebra', 'ok', 'err', 'warn']
  const block = (name: string, tint: string) =>
    '  ' + name + ': {\n' + slots.map((s) => "    " + s + ": '" + (over[s] ?? tint) + "',").join('\n') + '\n  },\n'
  return 'const skin = {\n  name: "dracula",\n' + block('palette', '#112233') + (light ? block('light', '#445566') : '') + '}\n'
}

function skinsFiles(marketplace = 'example-mods', over: Record<string, string> = {}, light = false): Record<string, string> {
  return {
    [CFG + '/plugins/store/skins_' + marketplace + '-abc123.json']: JSON.stringify({ prefs: { skin: 'dracula', icons: 'ascii' } }),
    [CFG + '/plugins/cache/' + marketplace + '/skins/0.5.1/hooks/themes/dracula.ts']: themeFile(over, light),
    [CFG + '/plugins/cache/' + marketplace + '/skins/0.5.1/hooks/themes/index.ts']: 'export {}',
    '/w/plan/p.md': PLAN,
  }
}

type ThemeOut = { name: string; ansi: boolean; light: boolean; icons: string; colors: Record<string, string | null> }
const themeOf = (w: World) => w.last.theme as ThemeOut

function open(on, o: Parameters<typeof world>[1] = {}) {
  return world(on, { env: { HOME: '/h' }, ...o })
}

// ---------------------------------------------------------------- skins optional: theme setting and enabledPlugins

test('theme auto: skins installed and enabled draws its palette, icons and name', { options: { theme: 'auto' } }, async ($, on) => {
  const w = open(on, { files: skinsFiles(), enabledPlugins: SKINS_ON })
  await start($)
  expect(themeOf(w)).toMatchObject({ name: 'dracula', ansi: false, icons: 'ascii' })
  expect(themeOf(w).colors.ok).toBe('#112233')
})

test('theme auto: skins disabled draws plain, though its files are on disk', async ($, on) => {
  const w = open(on, { files: skinsFiles(), enabledPlugins: SKINS_OFF })
  await start($)
  expect(themeOf(w)).toMatchObject({ name: 'plain', ansi: true, icons: 'unicode' })
  expect(themeOf(w).colors.ok).toBe('green')
  expect(w.toasts).toEqual([])
})

test('theme auto: skins not installed (no key), or settings unreadable, draws plain without a toast', async ($, on) => {
  const w = open(on, { files: skinsFiles(), enabledPlugins: { 'waypoint@example-mods': true } })
  await start($)
  expect(themeOf(w).name).toBe('plain')
  w.enabledPlugins = 'throws'
  await start($)
  expect(themeOf(w).name).toBe('plain')
  expect(w.toasts).toEqual([])
})

test('theme skins: forces the palette when skins is disabled; falls back when it is not installed', { options: { theme: 'skins' } }, async ($, on) => {
  const w = open(on, { files: skinsFiles(), enabledPlugins: SKINS_OFF })
  await start($)
  expect(themeOf(w)).toMatchObject({ name: 'dracula', ansi: false })
  w.enabledPlugins = {}
  await start($)
  expect(themeOf(w)).toMatchObject({ name: 'plain', ansi: true })
})

test('theme plain: never skins, even enabled', { options: { theme: 'plain' } }, async ($, on) => {
  const w = open(on, { files: skinsFiles(), enabledPlugins: SKINS_ON })
  await start($)
  expect(themeOf(w)).toMatchObject({ name: 'plain', ansi: true })
})

test('theme: the marketplace comes from the enabledPlugins key, not from a constant', async ($, on) => {
  const w = open(on, { files: skinsFiles('other-market', { ok: '#abcdef' }), enabledPlugins: { 'skins@other-market': true } })
  await start($)
  expect(themeOf(w)).toMatchObject({ name: 'dracula', ansi: false })
  expect(themeOf(w).colors.ok).toBe('#abcdef')
})

test('theme: an unreadable skins theme file falls to plain with one toast naming the reason', async ($, on) => {
  const files = skinsFiles()
  files[CFG + '/plugins/cache/example-mods/skins/0.5.1/hooks/themes/dracula.ts'] = 'export default {}'
  const w = open(on, { files, enabledPlugins: SKINS_ON })
  await start($)
  expect(themeOf(w).ansi).toBe(true)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('dracula.ts')
})

test('theme: enabling skins in a running session recolours at the next tenth second', async ($, on) => {
  const w = open(on, { files: skinsFiles(), enabledPlugins: SKINS_OFF })
  await start($)
  await userCommand($, 'track plan/p.md "Work" column=landed')
  expect(themeOf(w).name).toBe('plain')
  w.enabledPlugins = SKINS_ON
  await w.clock.advance(10_000)
  expect(themeOf(w).name).toBe('dracula')
  w.enabledPlugins = SKINS_OFF
  await w.clock.advance(10_000)
  expect(themeOf(w).name).toBe('plain')
})

// ---------------------------------------------------------------- light or dark (skins palette)

test('light or dark: SKINS_THEME, then the Claude Code theme row, then COLORFGBG, else dark', async ($, on) => {
  const files = skinsFiles('example-mods', {}, true)
  const w = open(on, { files, enabledPlugins: SKINS_ON, env: { HOME: '/h', SKINS_THEME: 'light', COLORFGBG: '15;0' }, themeRow: 'dark' })
  await start($)
  expect(themeOf(w).light).toBe(true)
  expect(themeOf(w).colors.ok).toBe('#445566')
})

test('light or dark: the theme row beats COLORFGBG; auto reads COLORFGBG; nothing says dark', async ($, on) => {
  const files = skinsFiles('example-mods', {}, true)
  const w = open(on, { files, enabledPlugins: SKINS_ON, env: { HOME: '/h', COLORFGBG: '0;15' }, themeRow: 'dark-ansi' })
  await start($)
  expect(themeOf(w).light).toBe(false)
  w.themeRow = 'light'
  await start($)
  expect(themeOf(w).light).toBe(true)
  // B6: automatic is the value `auto`: it says neither, so the terminal does
  w.themeRow = 'auto'
  await start($)
  expect(themeOf(w).light).toBe(true)
})

test('light or dark: auto with no COLORFGBG and no row is dark', async ($, on) => {
  const w = open(on, { files: skinsFiles('example-mods', {}, true), enabledPlugins: SKINS_ON, themeRow: 'auto' })
  await start($)
  expect(themeOf(w).light).toBe(false)
  expect(themeOf(w).colors.ok).toBe('#112233')
  expect(w.processRuns).toBe(0)
})

// ---------------------------------------------------------------- the role file and the router

const ROLE_FILE = CFG + '/waypoint-roles.json'
const ROLES = JSON.stringify({ roles: { scout: { models: ['sonnet'], efforts: ['high'] }, reviewer: { models: ['opus'], efforts: ['high'] } } })

function beneathAgents(on, ids: string[]) {
  let n = 0
  on('tool.call', async () => ({ result: 'ok' }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: ids[n++] }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' } }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('agent.list', async () => ({ value: [] }))
}

const agentCall = ($, over: Record<string, unknown>) => $.tool.call({ tool: 'Agent', description: 'sweep', prompt: 'p', tool_use_id: 'toolu_x', ...over })

test('roles: no file means R1 and R2 only; a scout on opus is not judged', async ($, on) => {
  const w = open(on, {})
  beneathAgents(on, [])
  await start($)
  expect((await agentCall($, { subagent_type: 'scout', model: 'opus' })).context).toBe(undefined)
  const r1 = await agentCall($, { subagent_type: 'scout' })
  expect(r1.context).toEqual(['waypoint: Agent "sweep" (scout) names no model; pass model on every dispatch.'])
  expect(w.toasts.length).toBe(1)
})

// R1 reads what the agent type's definition says: a model in its frontmatter is a model named. The
// resolved model cannot tell (a definition with no model resolves to the engine's default, not the
// parent's), so the definition file is read: project (the session directory and above), user, plugin.
const defn = (model?: string) => '---\nname: x\ndescription: d\n' + (model === undefined ? '' : 'model: ' + model + '\n') + '---\nBody.\n'

test('R1: a typed agent whose definition names a model draws no note; general-purpose still does', async ($, on) => {
  const w = open(on, { files: { [CFG + '/agents/implementer.md']: defn('claude-sonnet-5-5') } })
  beneathAgents(on, [])
  await start($)
  const typed = await agentCall($, { subagent_type: 'implementer' })
  expect(typed.context).toBe(undefined)
  expect(w.toasts).toEqual([])
  const plain = await agentCall($, { subagent_type: 'general-purpose' })
  expect(plain.context).toEqual(['waypoint: Agent "sweep" (general-purpose) names no model; pass model on every dispatch.'])
  expect(w.toasts.length).toBe(1)
})

test('R1: the definition is found in the project, the user directory, and a plugin', async ($, on) => {
  const w = open(on, {
    files: {
      '/w/.claude/agents/local.md': defn('haiku'),
      [CFG + '/plugins/cache/mk/acme/1.2.0/agents/scout.md']: defn('sonnet'),
      [CFG + '/plugins/cache/mk/other/1.0.0/agents/unrelated.md']: defn('sonnet'),
    },
  })
  beneathAgents(on, [])
  await start($)
  for (const type of ['local', 'acme:scout']) expect((await agentCall($, { subagent_type: type })).context).toBe(undefined)
  // a plugin agent is looked up in its own plugin only
  expect((await agentCall($, { subagent_type: 'other:scout' })).context?.[0]).toContain('names no model')
  expect(w.toasts.length).toBe(1)
})

test('R1: a definition with no model, or model inherit, or none found, still draws the note', async ($, on) => {
  open(on, { files: { [CFG + '/agents/bare.md']: defn(), [CFG + '/agents/inheritor.md']: defn('inherit') } })
  beneathAgents(on, [])
  await start($)
  for (const type of ['bare', 'inheritor', 'missing']) expect((await agentCall($, { subagent_type: type })).context?.[0]).toContain('names no model')
})

// ---------------------------------------------------------------- batch B: where a definition is looked for

const noteOf = async ($, type: string) => (await agentCall($, { subagent_type: type })).context?.[0]
const NO_MODEL = 'names no model'

test('R1 lookup: a type name that could leave the agents directory is no definition and is never read', async ($, on) => {
  const w = open(on, {
    files: {
      '/w/.claude/agents/ok.md': defn('haiku'),
      '/etc/x.md': defn('haiku'),
      '/x.md': defn('haiku'),
      [CFG + '/agents/x.md']: defn('haiku'),
      [CFG + '/plugins/cache/mk/acme/1.0.0/agents/x.md']: defn('haiku'),
    },
  })
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'ok')).toBe(undefined) // the lookup itself works
  w.touched.length = 0
  for (const type of ['../../etc/x', '../x', 'a/b', 'a\\b', '..', '.', 'acme:../x', '../acme:x', '../../x:y', 'a\u0000b', 'a b', 'acme:sub/x', 'a:b:c', 'x%2e%2e', ':', 'acme:']) {
    expect(await noteOf($, type)).toContain(NO_MODEL)
  }
  expect(w.touched.filter((p) => p.includes('..') || p.includes('\u0000') || p.startsWith('/etc') || p === '/x.md')).toEqual([])
  expect(w.touched.filter((p) => p.endsWith('.md'))).toEqual([])
})

test('R1 lookup: a name of letters, digits, dot, dash and underscore is looked up; plugin:type too', async ($, on) => {
  open(on, { files: { '/w/.claude/agents/my_agent-2.v1.md': defn('haiku'), [CFG + '/plugins/cache/mk/acme.tools/1.0.0/agents/s-1.md']: defn('sonnet') } })
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'my_agent-2.v1')).toBe(undefined)
  expect(await noteOf($, 'acme.tools:s-1')).toBe(undefined)
})

test('R1 lookup: the walk up from the session directory stops at the first .git, and never goes past it', async ($, on) => {
  const w = open(on, {
    cwd: '/h/work/repo/pkg/deep',
    files: {
      '/h/work/repo/.git': '',
      '/h/work/repo/.claude/agents/inrepo.md': defn('haiku'),
      '/h/work/repo/pkg/.claude/agents/nested.md': defn('haiku'),
      '/h/work/.claude/agents/above.md': defn('haiku'),
      '/h/.claude/agents/ofhome.md': defn('haiku'),
    },
  })
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'inrepo')).toBe(undefined)
  expect(await noteOf($, 'nested')).toBe(undefined)
  expect(await noteOf($, 'above')).toContain(NO_MODEL)
  expect(await noteOf($, 'ofhome')).toBe(undefined) // the user directory (configDir/agents) is always read
  expect(w.touched.filter((p) => p.startsWith('/h/work/.claude') || p.startsWith('/.claude'))).toEqual([])
})

test('R1 lookup: with no .git, the walk stops at the home directory, and root and above home are never read', async ($, on) => {
  const w = open(on, {
    cwd: '/h/a/b',
    files: {
      '/h/a/.claude/agents/mid.md': defn('haiku'),
      '/.claude/agents/root.md': defn('haiku'),
      '/.claude/agents/mid.md': defn('haiku'),
    },
  })
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'mid')).toBe(undefined)
  expect(await noteOf($, 'root')).toContain(NO_MODEL)
  expect(w.touched.filter((p) => p.startsWith('/.claude'))).toEqual([])
  expect(w.touched.filter((p) => p === '/.git' || p === '/' || p === '')).toEqual([])
})

test('R1 lookup: outside home with no .git, only the session directory is searched', async ($, on) => {
  const w = open(on, {
    cwd: '/srv/proj/sub',
    files: { '/srv/proj/sub/.claude/agents/here.md': defn('haiku'), '/srv/proj/.claude/agents/up.md': defn('haiku'), '/srv/.claude/agents/up2.md': defn('haiku') },
  })
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'here')).toBe(undefined)
  expect(await noteOf($, 'up')).toContain(NO_MODEL)
  expect(await noteOf($, 'up2')).toContain(NO_MODEL)
  expect(w.touched.filter((p) => p.startsWith('/srv/proj/.claude') || p.startsWith('/srv/.claude'))).toEqual([])
})

test('R1 lookup: a Windows session directory is walked with its own separator', async ($, on) => {
  const w = open(on, {
    cwd: 'C:\\Users\\me\\proj\\sub',
    env: { HOME: 'C:\\Users\\me' },
    files: {
      'C:\\Users\\me\\proj\\.git': '',
      'C:\\Users\\me\\proj\\.claude\\agents\\win.md': defn('haiku'),
      'C:\\Users\\me\\.claude\\agents\\above.md': defn('haiku'),
      'C:\\.claude\\agents\\root.md': defn('haiku'),
    },
  })
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'win')).toBe(undefined)
  expect(await noteOf($, 'above')).toContain(NO_MODEL)
  expect(await noteOf($, 'root')).toContain(NO_MODEL)
  expect(w.touched.filter((p) => p.startsWith('C:\\.claude') || p.includes('C:\\Users\\me\\.claude\\agents\\above'))).toEqual([])
  // the files are looked up under the session directory's own separator
  expect(w.touched).toContain('C:\\Users\\me\\proj\\sub\\.claude\\agents\\win.md')
})

test('R1 lookup: with HOME unset the walk is bounded by USERPROFILE', async ($, on) => {
  const w = open(on, {
    cwd: 'C:\\Users\\me\\proj\\sub',
    env: { USERPROFILE: 'C:\\Users\\me' },
    files: {
      'C:\\Users\\me\\proj\\.claude\\agents\\up.md': defn('haiku'),
      'C:\\Users\\me\\.claude\\agents\\home.md': defn('haiku'),
      'C:\\Users\\.claude\\agents\\above.md': defn('haiku'),
    },
  })
  beneathAgents(on, [])
  await start($)
  // no .git anywhere: the walk climbs to the home directory and no further
  expect(await noteOf($, 'up')).toBe(undefined)
  expect(await noteOf($, 'home')).toBe(undefined)
  expect(await noteOf($, 'above')).toContain(NO_MODEL)
  expect(w.touched.filter((p) => p.startsWith('C:\\Users\\.claude'))).toEqual([])
})

test('R1 lookup: a UTF-8 byte order mark before the frontmatter is tolerated', async ($, on) => {
  open(on, { files: { '/w/.claude/agents/bom.md': '\uFEFF' + defn('haiku'), '/w/.claude/agents/bombare.md': '\uFEFF' + defn() } })
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'bom')).toBe(undefined)
  expect(await noteOf($, 'bombare')).toContain(NO_MODEL)
})

test('R1 lookup: the answer is kept for the session; a changed definition file is read again', async ($, on) => {
  const w = open(on, { files: { '/w/.claude/agents/kept.md': defn('haiku') } })
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'kept')).toBe(undefined)
  const reads = () => w.touched.filter((p) => p.endsWith('/kept.md') && !p.includes('/plugins/')).length
  const before = w.touched.length
  expect(await noteOf($, 'kept')).toBe(undefined)
  expect(await noteOf($, 'kept')).toBe(undefined)
  // the repeat dispatches read nothing but the file's mtime
  expect(w.touched.slice(before).every((p) => p === '/w/.claude/agents/kept.md')).toBe(true)
  expect(reads()).toBeGreaterThan(0)
  // the file now names no model: its mtime moved, so it is read again
  w.files['/w/.claude/agents/kept.md'] = defn('inherit')
  w.mtimes['/w/.claude/agents/kept.md'] = 2
  expect(await noteOf($, 'kept')).toContain(NO_MODEL)
  // and a type with no definition is looked up once per session
  expect(await noteOf($, 'nothere')).toContain(NO_MODEL)
  const mark = w.touched.length
  expect(await noteOf($, 'nothere')).toContain(NO_MODEL)
  expect(w.touched.length).toBe(mark)
})

// ---------------------------------------------------------------- a definition file is statted before it is read

function logsOf(on): string[] {
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  return logs
}

test('R1 lookup: a definition over 64 KiB is not read; R1 fires and one debug line says why', async ($, on) => {
  const logs = logsOf(on)
  const w = open(on, { files: { '/w/.claude/agents/big.md': defn('haiku') + 'x'.repeat(64 * 1024), '/w/.claude/agents/edge.md': defn('haiku').padEnd(64 * 1024, ' ') } })
  beneathAgents(on, [])
  await start($)
  const before = w.touched.length
  expect(await noteOf($, 'big')).toContain(NO_MODEL)
  expect(w.touched.slice(before).filter((p) => p === '/w/.claude/agents/big.md').length).toBe(1) // statted, once
  expect(logs.filter((l) => l.includes('big.md'))).toEqual(['waypoint: definition /w/.claude/agents/big.md not read: ' + (64 * 1024 + defn('haiku').length) + ' bytes is over 65536'])
  expect(await noteOf($, 'edge')).toBe(undefined) // exactly 64 KiB is read
})

test('R1 lookup: a path that is not a regular file is not read, and the dispatch goes on', async ($, on) => {
  const logs = logsOf(on)
  const w = open(on, { files: { '/w/.claude/agents/pipe.md': defn('haiku'), '/w/.claude/agents/ok.md': defn('haiku') } })
  w.kinds['/w/.claude/agents/pipe.md'] = 'fifo'
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'pipe')).toContain(NO_MODEL) // the file names a model; reading it would have silenced R1
  expect(logs.filter((l) => l.includes('pipe.md')).length).toBe(1)
  expect(logs.find((l) => l.includes('pipe.md'))).toContain('not a regular file')
  expect(await noteOf($, 'ok')).toBe(undefined)
})

test('R1 lookup: a type with no definition is looked up again after 60 seconds, not once for the session', async ($, on) => {
  const w = open(on, { files: {} })
  beneathAgents(on, [])
  await start($)
  expect(await noteOf($, 'later')).toContain(NO_MODEL)
  w.files['/w/.claude/agents/later.md'] = defn('haiku')
  const lookups = () => w.touched.filter((p) => p.endsWith('/later.md')).length
  const mark = lookups()
  await w.clock.advance(59_000)
  expect(await noteOf($, 'later')).toContain(NO_MODEL) // still inside the minute: not looked up
  expect(lookups()).toBe(mark)
  await w.clock.advance(2_000)
  expect(await noteOf($, 'later')).toBe(undefined)
  // and once found it is kept, as before
  const found = w.touched.length
  expect(await noteOf($, 'later')).toBe(undefined)
  expect(w.touched.slice(found).filter((p) => p.endsWith('/later.md')).every((p) => p === '/w/.claude/agents/later.md')).toBe(true)
})

test('R3 for a typed agent: the model its definition names is judged against the role file', async ($, on) => {
  const w = open(on, {
    files: {
      [ROLE_FILE]: ROLES,
      '/w/.claude/agents/scout.md': defn('opus'),
      '/w/.claude/agents/reviewer.md': defn('claude-opus-5-5'),
    },
  })
  beneathAgents(on, [])
  await start($)
  const scout = await agentCall($, { subagent_type: 'scout' })
  expect(scout.context).toEqual(['waypoint: scout "sweep" dispatched on opus; the role table expects sonnet.']) // no R1: the definition names a model
  expect((await agentCall($, { subagent_type: 'reviewer' })).context).toBe(undefined) // opus is what the table expects
  expect(w.toasts.length).toBe(1)
  // a call that names its own model is judged by that one, not the definition's
  expect((await agentCall($, { subagent_type: 'scout', model: 'sonnet' })).context).toBe(undefined)
})

test('R3 for a typed agent: the warning is on the agent\'s row, and the first step adds R4 only', async ($, on) => {
  const w = open(on, { files: { [ROLE_FILE]: ROLES, '/w/.claude/agents/scout.md': defn('opus') } })
  beneathAgents(on, ['sc1'])
  await start($)
  await agentCall($, { subagent_type: 'scout', tool_use_id: 'toolu_s1' })
  await $.agent.spawn({
    tool_use_id: 'toolu_s1', prompt: 'p', description: 'sweep', subagentType: 'scout', provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5', background: false, fork: false,
  })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'low', messageCount: 1, agentId: 'sc1' })
  for await (const _ of step) {
    // drain
  }
  const rec = (w.last.agents as Array<{ warnings: string[] }>)[0]
  expect(rec.warnings.map((x) => x.slice(0, 2))).toEqual(['R3', 'R4'])
})

test('skins marketplace: a name from enabledPlugins that is not a plain name is not an installed skins, and no path is built from it', async ($, on) => {
  const w = open(on, { files: skinsFiles(), enabledPlugins: { 'skins@../../etc': true, 'skins@a/b': true, 'skins@a\\b': true } })
  await start($)
  expect(themeOf(w).name).toBe('plain')
  expect(w.touched.filter((p) => p.includes('..') || p.includes('a/b') || p.includes('a\\b'))).toEqual([])
})

test('roles: a file makes R3 fire for the roles it names, and only those', async ($, on) => {
  const w = open(on, { files: { [ROLE_FILE]: ROLES } })
  beneathAgents(on, [])
  await start($)
  expect((await agentCall($, { subagent_type: 'acme:scout', model: 'opus' })).context).toEqual(['waypoint: scout "sweep" dispatched on opus; the role table expects sonnet.'])
  expect((await agentCall($, { subagent_type: 'reviewer', model: 'haiku' })).context).toEqual(['waypoint: reviewer "sweep" dispatched on haiku; the role table expects opus.'])
  expect((await agentCall($, { subagent_type: 'scout', model: 'sonnet' })).context).toBe(undefined)
  expect((await agentCall($, { subagent_type: 'hand', model: 'opus' })).context).toBe(undefined) // not named
  expect((await agentCall($, { subagent_type: 'scout', model: 'inherit' })).context).toBe(undefined) // unknown family
  expect(w.toasts.length).toBe(2)
})

test('roles: R3 and R4 after the fact come from the first step when a file names the role', async ($, on) => {
  const w = open(on, { files: { [ROLE_FILE]: ROLES } })
  beneathAgents(on, ['sc1'])
  await start($)
  await agentCall($, { subagent_type: 'acme:scout', tool_use_id: 'toolu_s1' })
  await $.agent.spawn({
    tool_use_id: 'toolu_s1', prompt: 'p', description: 'sweep', subagentType: 'acme:scout', provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5', background: false, fork: false,
  })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'sc1' })
  for await (const _ of step) {
    // drain
  }
  const rec = (w.last.agents as Array<{ warnings: string[] }>)[0]
  expect(rec.warnings.map((x) => x.slice(0, 2))).toEqual(['R1', 'R3', 'R4'])
})

test('roles: a file that does not parse turns R3/R4 off, logs one line and toasts once; no throw', async ($, on) => {
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  const w = open(on, { files: { [ROLE_FILE]: '{ "roles": { "scout": "sonnet" } }' } })
  beneathAgents(on, [])
  await start($)
  expect((await agentCall($, { subagent_type: 'scout', model: 'opus' })).context).toBe(undefined)
  expect((await agentCall($, { subagent_type: 'scout' })).context?.[0]).toContain('names no model') // R1 still on
  expect(logs.filter((l) => l.includes('waypoint-roles.json')).length).toBe(1)
  expect(w.toasts.filter((t) => t.includes('waypoint-roles.json')).length).toBe(1)
  // a second bad read in the same session logs again but does not toast again
  w.files[ROLE_FILE] = 'not json'
  w.mtimes[ROLE_FILE] = 2
  await w.clock.advance(10_000)
  expect(logs.filter((l) => l.includes('waypoint-roles.json')).length).toBe(2)
  expect(w.toasts.filter((t) => t.includes('waypoint-roles.json')).length).toBe(1)
})

test('roles: the file is read again when its mtime moves, created, fixed or removed', async ($, on) => {
  const w = open(on, {})
  beneathAgents(on, [])
  await start($)
  const r3 = async () => (await agentCall($, { subagent_type: 'scout', model: 'opus' })).context
  expect(await r3()).toBe(undefined)
  w.files[ROLE_FILE] = ROLES
  await w.clock.advance(10_000)
  expect(await r3()).toEqual([expect.stringContaining('dispatched on opus')])
  w.files[ROLE_FILE] = '{ "roles": { "scout": { "models": ["opus"], "efforts": ["high"] } } }'
  w.mtimes[ROLE_FILE] = 5
  await w.clock.advance(10_000)
  expect(await r3()).toBe(undefined)
  delete w.files[ROLE_FILE]
  w.files[ROLE_FILE] = ROLES
  w.mtimes[ROLE_FILE] = 9
  await w.clock.advance(10_000)
  expect(await r3()).toEqual([expect.stringContaining('dispatched on opus')])
  delete w.files[ROLE_FILE]
  await w.clock.advance(10_000)
  expect(await r3()).toBe(undefined)
})

test('routerWarnings false: R1, R2 and R3 are all off, role file or not, and nothing is toasted', { options: { routerWarnings: false } }, async ($, on) => {
  const w = open(on, { files: { [ROLE_FILE]: ROLES } })
  beneathAgents(on, [])
  await start($)
  expect((await agentCall($, { subagent_type: 'scout' })).context).toBe(undefined)
  expect((await agentCall($, { subagent_type: 'scout', model: 'opus' })).context).toBe(undefined)
  const script = "const a = await agent('x', { label: 'one' })"
  const wf = await $.tool.call({ tool: 'Workflow', script, tool_use_id: 'toolu_wf' })
  expect(wf.context).toBe(undefined)
  expect(w.toasts).toEqual([])
  expect(((w.last.log ?? []) as Array<{ kind: string }>).filter((l) => l.kind === 'warn')).toEqual([])
})

test('routerWarnings true (the default): R2 fires on a Workflow call lacking model and effort', async ($, on) => {
  open(on, {})
  beneathAgents(on, [])
  await start($)
  const script = "export const meta = { name: 'w' }\nconst a = await agent('x', { label: 'one' })"
  const wf = await $.tool.call({ tool: 'Workflow', script, tool_use_id: 'toolu_wf' })
  expect(wf.context?.[0]).toContain('Workflow "w": 1 agent() call(s) without model or effort')
})

// ---------------------------------------------------------------- bandDefault

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 16, bodyColumns: 100, scroll: { offset: 0, bodyRows: 15 }, view: {} }

async function bandShows($): Promise<boolean> {
  const ui = await $.ui.mount({ plugin: 'waypoint', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const found = (await ui.find({ type: 'Text', text: /Work/ })) !== undefined
  await ui.unmount()
  return found
}

const FILES = { '/w/plan/p.md': PLAN }
const TRACK = 'track plan/p.md "Work" column=landed'

test('bandDefault on (the default): the band shows before any /waypoint band', async ($, on) => {
  open(on, { files: FILES })
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  await start($)
  await userCommand($, TRACK)
  expect(await bandShows($)).toBe(true)
})

test('bandDefault off: the band starts hidden, band on shows it and the pref then beats the default', { options: { bandDefault: 'off' } }, async ($, on) => {
  const w = open(on, { files: FILES })
  on('ui.render', async (u, e) => u.ui.resolve(e).Text({ children: ['below'] }))
  await start($)
  await userCommand($, TRACK)
  expect(await bandShows($)).toBe(false)
  await userCommand($, 'band on')
  expect(w.store.band).toBe(true)
  expect(await bandShows($)).toBe(true)
  await start($) // the next session start: the stored pref stands over the default
  expect(await bandShows($)).toBe(true)
  await userCommand($, 'band off')
  expect(await bandShows($)).toBe(false)
})
