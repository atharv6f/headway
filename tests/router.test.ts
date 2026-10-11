import { expect, test } from 'claude-code/testing'
import * as router from '../plugin/hooks/router.ts'
import { definitionModel, definitionName, definitionPlugin, parseRoles, projectDirs, roleOf, ruleR1, ruleR2, ruleR3, ruleR4, searchDirs } from '../plugin/hooks/router.ts'
import type { Roles } from '../plugin/hooks/router.ts'

// The example role file of SPEC.md section 7: the only place a role table lives.
const EXAMPLE = JSON.stringify({
  roles: {
    scout: { models: ['sonnet'], efforts: ['high'] },
    implementer: { models: ['sonnet', 'opus'], efforts: ['high', 'xhigh'] },
    reviewer: { models: ['opus'], efforts: ['high'] },
    runner: { models: ['sonnet'], efforts: ['low'] },
  },
})
const EXAMPLE_ROLES = (parseRoles(EXAMPLE) as { roles: Roles }).roles

// A fixture table for the rule tests (a user's file would look like this).
const ROLES: Roles = {
  scout: { models: ['sonnet'], efforts: ['high'] },
  implementer: { models: ['sonnet', 'opus', 'fable'], efforts: ['high', 'xhigh'] },
  debugger: { models: ['opus'], efforts: ['xhigh'] },
  evaluator: { models: ['fable', 'opus'], efforts: ['high'] },
  runner: { models: ['sonnet'], efforts: ['low'] },
  hand: { models: ['sonnet'], efforts: ['low'] },
}

test('no role table is built into the code', async () => {
  expect('ROLES' in router).toBe(false)
  expect(ruleR3({ description: 'x', subagentType: 'scout', model: 'opus' })).toBe(undefined)
  expect(ruleR4({ description: 'x', subagentType: 'scout', effort: 'low' })).toBe(undefined)
  expect(ruleR3({ description: 'x', subagentType: 'scout', model: 'opus' }, {})).toBe(undefined)
})

test('parseRoles: the spec example parses; names and sets are lower-cased', async () => {
  expect(EXAMPLE_ROLES.reviewer).toEqual({ models: ['opus'], efforts: ['high'] })
  const r = parseRoles('{ "roles": { "Scout": { "models": ["Sonnet"], "efforts": ["HIGH"] } } }') as { roles: Roles }
  expect(r.roles).toEqual({ scout: { models: ['sonnet'], efforts: ['high'] } })
})

test('parseRoles: a file that is not the schema is an error with a reason, never a throw', async () => {
  for (const bad of [
    '',
    'not json',
    '[]',
    '{}',
    '{ "roles": [] }',
    '{ "roles": { "scout": "sonnet" } }',
    '{ "roles": { "scout": { "models": "sonnet", "efforts": ["high"] } } }',
    '{ "roles": { "scout": { "models": ["sonnet"] } } }',
    '{ "roles": { "scout": { "models": [1], "efforts": ["high"] } } }',
    '{ "roles": { "scout": { "models": [], "efforts": ["high"] } } }',
  ]) {
    const r = parseRoles(bad)
    expect('error' in r).toBe(true)
    expect((r as { error: string }).error.length).toBeGreaterThan(0)
  }
  expect(parseRoles('{ "roles": {} }')).toEqual({ roles: {} })
})

test('R1: no model on an Agent call fires, with the SPEC text', async () => {
  const w = ruleR1({ description: 'R02-41 scope read', subagentType: 'acme:scout' })
  expect(w).toEqual({
    rule: 'R1',
    text:
      'headway: Agent "R02-41 scope read" (scout) names no model; pass model on every dispatch.',
  })
})

test('R1: a model, or a fork, does not fire; a missing subagent_type reads as general-purpose', async () => {
  expect(ruleR1({ description: 'd', subagentType: 'scout', model: 'haiku' })).toBe(undefined)
  expect(ruleR1({ description: 'd', subagentType: 'fork' })).toBe(undefined)
  expect(ruleR1({ description: 'd', subagentType: 'acme:fork' })).toBe(undefined)
  expect(ruleR1({ description: 'd', model: '' })?.text).toContain('(general-purpose)')
})

test('R1: a definition that names a model does not fire', async () => {
  expect(ruleR1({ description: 'd', subagentType: 'implementer', definedModel: true })).toBe(undefined)
  expect(ruleR1({ description: 'd', subagentType: 'implementer', definedModel: false })?.rule).toBe('R1')
})

test('definitionModel: the model of a frontmatter, none for inherit, empty, absent or a body line', async () => {
  const doc = (front: string) => '---\n' + front + '\n---\nmodel: opus\n'
  expect(definitionModel(doc('name: a\nmodel: claude-sonnet-5-5\neffort: high'))).toBe('claude-sonnet-5-5')
  expect(definitionModel(doc('name: a\nmodel: "haiku"'))).toBe('haiku')
  expect(definitionModel(doc("model: 'opus'  # the big one"))).toBe('opus')
  expect(definitionModel(doc('name: a').replace(/\n/g, '\r\n').replace('name: a', 'model: sonnet'))).toBe('sonnet')
  expect(definitionModel(doc('name: a\nmodel: inherit'))).toBe(undefined)
  expect(definitionModel(doc('name: a\nmodel:'))).toBe(undefined)
  expect(definitionModel(doc('name: a'))).toBe(undefined) // the body line is not frontmatter
  expect(definitionModel('model: opus\nno fence')).toBe(undefined)
})

test('projectDirs: the session directory and each parent up to home (inclusive), never the root', async () => {
  expect(projectDirs({ cwd: '/h/a/b', home: '/h' })).toEqual({ dirs: ['/h/a/b', '/h/a', '/h'], sep: '/', atHome: true })
  expect(projectDirs({ cwd: '/h', home: '/h' })).toEqual({ dirs: ['/h'], sep: '/', atHome: true })
  expect(projectDirs({ cwd: '/h/a/b/', home: '/h/' }).dirs).toEqual(['/h/a/b', '/h/a', '/h'])
  // outside home: up to, never including, the root
  expect(projectDirs({ cwd: '/srv/p/q', home: '/h' })).toEqual({ dirs: ['/srv/p/q', '/srv/p', '/srv'], sep: '/', atHome: false })
  expect(projectDirs({ cwd: '/srv', home: undefined }).dirs).toEqual(['/srv'])
  expect(projectDirs({ cwd: '/', home: '/h' }).dirs).toEqual([])
  // a home that is merely a name prefix is not home
  expect(projectDirs({ cwd: '/hx/a', home: '/h' }).atHome).toBe(false)
  // a home of / is no bound
  expect(projectDirs({ cwd: '/a', home: '/' })).toEqual({ dirs: ['/a'], sep: '/', atHome: false })
})

test('projectDirs: a Windows directory keeps its drive and its separator, either slash is read', async () => {
  expect(projectDirs({ cwd: 'C:\\Users\\me\\proj\\sub', home: 'C:\\Users\\me' })).toEqual({
    dirs: ['C:\\Users\\me\\proj\\sub', 'C:\\Users\\me\\proj', 'C:\\Users\\me'],
    sep: '\\',
    atHome: true,
  })
  expect(projectDirs({ cwd: 'c:/People/me/proj', home: 'C:\\people\\ME' }).dirs).toEqual(['c:\\People\\me\\proj', 'c:\\People\\me'])
  expect(projectDirs({ cwd: 'D:\\work\\p', home: 'C:\\Users\\me' })).toEqual({ dirs: ['D:\\work\\p', 'D:\\work'], sep: '\\', atHome: false })
  expect(projectDirs({ cwd: 'C:\\', home: 'C:\\Users\\me' }).dirs).toEqual([])
  expect(projectDirs({ cwd: '\\\\host\\share\\dir\\sub' }).dirs).toEqual(['\\\\host\\share\\dir\\sub', '\\\\host\\share\\dir'])
})

test('searchDirs: ends at the first .git, else at home, else is the session directory alone', async () => {
  const chain = { dirs: ['/h/a/b', '/h/a', '/h'], atHome: true }
  expect(searchDirs(chain, 1)).toEqual(['/h/a/b', '/h/a'])
  expect(searchDirs(chain, 0)).toEqual(['/h/a/b'])
  expect(searchDirs(chain, undefined)).toEqual(['/h/a/b', '/h/a', '/h'])
  expect(searchDirs({ dirs: ['/s/p', '/s'], atHome: false }, undefined)).toEqual(['/s/p'])
  expect(searchDirs({ dirs: [], atHome: false }, undefined)).toEqual([])
})

test('definitionName and definitionPlugin: plain names only, `plugin:type` allowed', async () => {
  expect(definitionName('scout')).toBe('scout')
  expect(definitionName('acme.tools:Scout_2-b')).toBe('Scout_2-b')
  expect(definitionPlugin('acme:scout')).toBe('acme')
  expect(definitionPlugin('scout')).toBe(undefined)
  for (const bad of ['../../etc/x', '../x', 'a/b', 'a\\b', '..', '.', 'a..b', 'acme:../x', '../a:x', 'a\u0000b', 'a b', 'a:b:c', ':', 'acme:', '', 'x\ny']) {
    expect(definitionName(bad)).toBe('')
    expect(definitionPlugin(bad)).toBe(undefined)
  }
  expect(definitionName(undefined)).toBe('')
})

test('definitionModel: a byte order mark before the frontmatter is tolerated', async () => {
  expect(definitionModel('\uFEFF---\nname: a\nmodel: opus\n---\nbody\n')).toBe('opus')
  expect(definitionModel('\uFEFF---\r\nmodel: haiku\r\n---\r\n')).toBe('haiku')
})

test('R3 at dispatch: the model a definition names is judged when the call names none; the call\'s own model wins', async () => {
  expect(ruleR3({ description: 'd', subagentType: 'scout', definedModel: 'opus' }, ROLES)?.text).toBe('headway: scout "d" dispatched on opus; the role table expects sonnet.')
  expect(ruleR3({ description: 'd', subagentType: 'scout', definedModel: 'opus', model: 'sonnet' }, ROLES)).toBe(undefined)
  expect(ruleR3({ description: 'd', subagentType: 'scout', definedModel: 'sonnet' }, ROLES)).toBe(undefined)
  expect(ruleR3({ description: 'd', subagentType: 'scout', definedModel: 'opus' })).toBe(undefined) // no role table
})

test('rules: a description with a line break or an escape is one clean line in the warning', async () => {
  expect(ruleR1({ description: 'a\nb \u001b[31mc' })?.text).toBe('headway: Agent "a b c" (general-purpose) names no model; pass model on every dispatch.')
})

test('rules: an escape or OSC in the agent type, the model, the effort or the role file never reaches the text', async () => {
  const OSC = '\u001b]0;pwned\u0007'
  const CSI = '\u001b[2J'
  const type = 'acme:' + OSC + 'sc' + CSI + 'out'
  const role = roleOf(type)
  // a role file whose role name and sets carry escapes too (the file is text on disk)
  const roles: Roles = { [role]: { models: ['son' + OSC + 'net', 'h' + CSI + 'aiku\u009b31m'], efforts: ['lo' + OSC + 'w', 'x\u001b[1mhigh'] } }
  const texts = [
    ruleR1({ description: 'd', subagentType: type })?.text,
    ruleR3({ description: 'd', subagentType: type, model: 'opus' + OSC + CSI }, roles)?.text,
    ruleR3({ description: 'd', subagentType: type, definedModel: OSC + 'claude-opus-5-5' }, roles)?.text,
    ruleR4({ description: 'd', subagentType: type, effort: 'hi' + OSC + 'gh' + CSI }, roles)?.text,
  ]
  for (const t of texts) {
    expect(typeof t).toBe('string')
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(t!)).toBe(false)
  }
  expect(texts[0]).toBe('headway: Agent "d" (scout) names no model; pass model on every dispatch.')
  expect(texts[1]).toBe('headway: scout "d" dispatched on opus; the role table expects sonnet or haiku.')
  expect(texts[3]).toBe('headway: scout "d" ran at effort high; the role table expects low or xhigh.')
})

test('R3 at dispatch: the model family outside the role set fires with the SPEC text', async () => {
  expect(ruleR3({ description: 'sweep', subagentType: 'acme:scout', model: 'opus' }, ROLES)).toEqual({
    rule: 'R3',
    text: 'headway: scout "sweep" dispatched on opus; the role table expects sonnet.',
  })
  expect(ruleR3({ description: 'x', subagentType: 'evaluator', model: 'claude-haiku-5-5' }, ROLES)?.text).toBe(
    'headway: evaluator "x" dispatched on haiku; the role table expects fable or opus.',
  )
  expect(ruleR3({ description: 'x', subagentType: 'implementer', model: 'haiku' }, ROLES)?.text).toContain('expects sonnet, opus or fable')
})

test('R3 does not fire inside the set, on a full id of an allowed family, or with no model', async () => {
  expect(ruleR3({ description: 'x', subagentType: 'scout', model: 'sonnet' }, ROLES)).toBe(undefined)
  expect(ruleR3({ description: 'x', subagentType: 'scout', model: 'claude-sonnet-5-5' }, ROLES)).toBe(undefined)
  expect(ruleR3({ description: 'x', subagentType: 'debugger', model: 'Opus' }, ROLES)).toBe(undefined)
  expect(ruleR3({ description: 'x', subagentType: 'implementer', model: 'fable' }, ROLES)).toBe(undefined)
  expect(ruleR3({ description: 'x', subagentType: 'scout' }, ROLES)).toBe(undefined)
})

test('an unknown role fires no R3 or R4; neither does a fork or an unknown model family', async () => {
  expect(ruleR3({ description: 'x', subagentType: 'general-purpose', model: 'haiku' }, ROLES)).toBe(undefined)
  expect(ruleR3({ description: 'x', subagentType: 'workflow-subagent', model: 'haiku' }, ROLES)).toBe(undefined)
  expect(ruleR3({ description: 'x', subagentType: 'fork', model: 'haiku' }, ROLES)).toBe(undefined)
  expect(ruleR4({ description: 'x', subagentType: 'general-purpose', effort: 'max' }, ROLES)).toBe(undefined)
  expect(ruleR4({ description: 'x', subagentType: '', effort: 'low' }, ROLES)).toBe(undefined)
  // the family cannot be told from `inherit`: not claimed to be outside the set
  expect(ruleR3({ description: 'x', subagentType: 'scout', model: 'inherit' }, ROLES)).toBe(undefined)
})

test('R4: effort outside the role set fires (log and mark text); inside or absent does not', async () => {
  expect(ruleR4({ description: 'sweep', subagentType: 'acme:hand', effort: 'high' }, ROLES)).toEqual({
    rule: 'R4',
    text: 'headway: hand "sweep" ran at effort high; the role table expects low.',
  })
  expect(ruleR4({ description: 'x', subagentType: 'debugger', effort: 'high' }, ROLES)?.text).toContain('expects xhigh')
  expect(ruleR4({ description: 'x', subagentType: 'scout', effort: 'high' }, ROLES)).toBe(undefined)
  expect(ruleR4({ description: 'x', subagentType: 'implementer', effort: 'xhigh' }, ROLES)).toBe(undefined)
  expect(ruleR4({ description: 'x', subagentType: 'implementer', effort: 'low' }, ROLES)?.text).toContain('expects high or xhigh')
  expect(ruleR4({ description: 'x', subagentType: 'scout', effort: 5 }, ROLES)?.text).toContain('effort 5')
  expect(ruleR4({ description: 'x', subagentType: 'scout' }, ROLES)).toBe(undefined)
})

const call = (ordinal: number, over: Record<string, unknown> = {}) => ({ ordinal, hasModel: true, hasEffort: true, dynamic: false, ...over })

test('R2: calls lacking model or effort are named by label, else ordinal, with the SPEC text', async () => {
  const r = ruleR2({
    name: 'release-train',
    calls: [call(1, { hasEffort: false, label: 'R02-73 case read' }), call(2), call(3, { hasModel: false, hasEffort: false })],
  })
  expect(r?.ordinals).toEqual([1, 3])
  expect(r?.warning).toEqual({
    rule: 'R2',
    text: 'headway: Workflow "release-train": 2 agent() call(s) without model or effort: "R02-73 case read", #3. Pass both on every call.',
  })
})

test('R2: nothing missing, or options that are dynamic, does not fire; a pattern label is named by its pattern', async () => {
  expect(ruleR2({ name: 'w', calls: [call(1), call(2)] })).toBe(undefined)
  expect(ruleR2({ name: 'w', calls: [] })).toBe(undefined)
  expect(ruleR2({ name: 'w', calls: [call(1, { dynamic: true, hasModel: false, hasEffort: false })] })).toBe(undefined)
  const r = ruleR2({ name: undefined, calls: [call(1, { hasModel: false, label: 'scan *' })] })
  expect(r?.warning.text).toBe('headway: Workflow "(unnamed)": 1 agent() call(s) without model or effort: "scan *". Pass both on every call.')
})

// ---------------------------------------------------------------- batch B: R2 size

test('R2: escape sequences and controls in the name and the labels never reach the text', async () => {
  const r = ruleR2({
    name: 'ev\u001b]0;pwn\u0007il\u001b[31m',
    calls: [call(1, { hasModel: false, label: 'one\u001b]8;;http://x\u0007two\u0007' }), call(2, { hasModel: false, label: '\u202eflip' })],
  })!
  for (const text of [r.warning.text, ...r.perCall.map((p) => p.warning.text)]) {
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e]/)
  }
  expect(r.warning.text).toBe('headway: Workflow "evil": 2 agent() call(s) without model or effort: "onetwo", "flip". Pass both on every call.')
})

test('R2: each offending call gets its own warning naming that call only; the shared text is the full one', async () => {
  const r = ruleR2({ name: 'w', calls: [call(1, { hasEffort: false, label: 'one' }), call(2), call(3, { hasModel: false, label: 'three' })] })
  expect(r?.perCall.map((p) => p.ordinal)).toEqual([1, 3])
  expect(r?.perCall[0].warning.text).toBe('headway: Workflow "w": 1 agent() call(s) without model or effort: "one". Pass both on every call.')
  expect(r?.perCall[1].warning.text).toBe('headway: Workflow "w": 1 agent() call(s) without model or effort: "three". Pass both on every call.')
  expect(r?.warning.text).toContain('2 agent() call(s)')
})

test('R2: a long list is cut near 600 characters with +n more, and a long label is cut', async () => {
  const calls = Array.from({ length: 200 }, (_, i) => call(i + 1, { hasModel: false, label: 'call number ' + (i + 1) }))
  const r = ruleR2({ name: 'big', calls })!
  expect(r.warning.text.length).toBeLessThan(700)
  expect(r.warning.text).toMatch(/\+\d+ more\. Pass both on every call\.$/)
  expect(r.warning.text).toContain('200 agent() call(s)')
  expect(r.ordinals.length).toBe(200)
  const shown = (r.warning.text.match(/"call number/g) ?? []).length
  expect(r.warning.text).toContain('+' + (200 - shown) + ' more')
  const long = ruleR2({ name: 'w', calls: [call(1, { hasModel: false, label: 'x'.repeat(5000) })] })!
  expect(long.warning.text.length).toBeLessThan(700)
  expect(long.perCall[0].warning.text.length).toBeLessThan(700)
})
