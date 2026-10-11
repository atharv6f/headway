// Router warnings R1-R4 (pure, plain data in and out). SPEC.md section 7. A warning informs; this
// module never denies or rewrites anything.
import { clean, plainName } from './format.ts'

export type Rule = 'R1' | 'R2' | 'R3' | 'R4'

export interface Warning {
  rule: Rule
  text: string // one line, "waypoint: ..."
}

// Role rules (R3, R4) read a table the user writes in `<configDir>/waypoint-roles.json`; the code holds
// none. A role the table does not name is not judged.
export interface RoleRow {
  models: string[]
  efforts: string[]
}
export type Roles = Record<string, RoleRow>

function names(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string' || x.trim() === '') return undefined
    out.push(x.trim().toLowerCase())
  }
  return out
}

// The role file: `{ "roles": { "<role>": { "models": [...], "efforts": [...] } } }`. Names and sets are
// lower-cased. Anything else is an `error` saying why; this never throws.
export function parseRoles(text: string): { roles: Roles } | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    return { error: 'not JSON: ' + clean(err instanceof Error ? err.message : String(err)) }
  }
  const top = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined
  const table = top && typeof top.roles === 'object' && top.roles !== null && !Array.isArray(top.roles) ? (top.roles as Record<string, unknown>) : undefined
  if (!table) return { error: 'expected {"roles": {...}}' }
  const roles: Roles = {}
  for (const name of Object.keys(table)) {
    const row = table[name]
    const o = typeof row === 'object' && row !== null && !Array.isArray(row) ? (row as Record<string, unknown>) : undefined
    const models = o ? names(o.models) : undefined
    const efforts = o ? names(o.efforts) : undefined
    if (!models || !efforts) return { error: 'role "' + clean(name) + '" needs "models" and "efforts", each a non-empty list of names' }
    roles[name.trim().toLowerCase()] = { models, efforts }
  }
  return { roles }
}

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku']

// Role = the last `:`-separated segment of `subagentType`, lower-cased (4.4).
export function roleOf(subagentType: string | undefined): string {
  const parts = (subagentType ?? '').split(':')
  return (parts[parts.length - 1] ?? '').trim().toLowerCase()
}

// Model family = the first of fable, opus, sonnet, haiku found in the lower-cased alias or id.
export function familyOf(model: string | undefined): string {
  const m = (model ?? '').toLowerCase()
  for (const f of FAMILIES) if (m.indexOf(f) >= 0) return f
  return 'unknown'
}

// A set from the role file, each name cleaned (format.ts clean): the file is text on disk.
function listOf(raw: string[]): string {
  const items = raw.map((x) => clean(x))
  if (items.length <= 1) return items.join('')
  return items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1]
}

export interface CallInput {
  description: string
  subagentType?: string
  model?: string
  definedModel?: string // the model the agent type's definition names, when it names one
}

// R1: an Agent call with no explicit model (a fork inherits and is exempt; so is a type whose
// definition names a model: the dispatch routes it already).
export function ruleR1(i: CallInput): Warning | undefined {
  const role = roleOf(i.subagentType)
  if (i.model || role === 'fork' || i.definedModel) return undefined
  return {
    rule: 'R1',
    text: 'waypoint: Agent "' + clean(i.description) + '" (' + (clean(role) || 'general-purpose') + ') names no model; pass model on every dispatch.',
  }
}

// The agent type's segments: `type`, or `plugin:type`. Every segment must be a plain name (format.ts
// plainName): a type that is not is looked up nowhere, so R1 fires as for any type with no definition.
function typeParts(subagentType: string | undefined): string[] | undefined {
  const parts = (subagentType ?? '').split(':').map((p) => p.trim())
  return parts.length <= 2 && parts.every(plainName) ? parts : undefined
}

// The file name an agent type is defined under: the last segment, case kept; '' for a type that is
// not made of plain names.
export function definitionName(subagentType: string | undefined): string {
  const parts = typeParts(subagentType)
  return parts ? parts[parts.length - 1] ?? '' : ''
}

// The plugin of a `plugin:type` name; undefined for a bare type or a name that is not plain.
export function definitionPlugin(subagentType: string | undefined): string | undefined {
  const parts = typeParts(subagentType)
  return parts && parts.length === 2 ? parts[0] : undefined
}

// The directories a project definition may live in, nearest first: the session directory and each
// parent up to the home directory (inclusive) when the session is inside it, else up to but never
// including the filesystem root. Either separator is read; the paths are written with the session
// directory's own (a `C:\...` or `\\host\share\...` directory is a Windows one).
export function projectDirs(o: { cwd: string; home?: string }): { dirs: string[]; sep: string; atHome: boolean } {
  const win = /^[A-Za-z]:([\\/]|$)/.test(o.cwd) || o.cwd.startsWith('\\\\')
  const sep = win ? '\\' : '/'
  const split = (p: string) => p.split(win ? /[\\/]+/ : /\/+/).filter((x) => x !== '')
  const parts = split(o.cwd)
  const unc = win && o.cwd.startsWith('\\\\')
  const rootLen = win ? (unc ? 2 : 1) : 0
  const root = win ? (unc ? '\\\\' + (parts[0] ?? '') + sep + (parts[1] ?? '') : (parts[0] ?? '')) : ''
  const segs = parts.slice(rootLen)
  const at = (n: number) => root + sep + segs.slice(0, n).join(sep)
  const same = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b)
  const homeParts = o.home ? split(o.home) : []
  const homeSegs = homeParts.slice(rootLen)
  const inHome =
    homeSegs.length > 0 &&
    homeSegs.length <= segs.length &&
    (!win || same(homeParts.slice(0, rootLen).join(sep), parts.slice(0, rootLen).join(sep))) &&
    homeSegs.every((h, k) => same(h, segs[k] ?? ''))
  const dirs: string[] = []
  for (let n = segs.length; n >= (inHome ? homeSegs.length : 1); n--) dirs.push(at(n))
  return { dirs, sep, atHome: inHome }
}

// The directories to read, from the chain above and where a `.git` was found in it (its index, or
// none): the walk ends at the first `.git`, else at the home directory; a chain that reaches
// neither is only the session directory.
export function searchDirs(chain: { dirs: string[]; atHome: boolean }, gitAt: number | undefined): string[] {
  if (gitAt !== undefined) return chain.dirs.slice(0, gitAt + 1)
  return chain.atHome ? chain.dirs : chain.dirs.slice(0, 1)
}

// The `model:` of a definition's frontmatter (the block between the first two `---` lines), quotes
// and a trailing comment removed. `inherit`, an empty value and no model line give undefined.
// Read line by line with string operations, so no pattern backtracks over a long line.
export function definitionModel(text: string): string | undefined {
  const lines = (text.startsWith('\uFEFF') ? text.slice(1) : text).split('\n')
  if (lines[0].trimEnd() !== '---') return undefined
  let line: string | undefined
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trimEnd()
    if (l === '---') {
      if (line === undefined) return undefined
      let v = line.slice('model:'.length).trim()
      const quote = v[0] === '"' || v[0] === "'" ? v.indexOf(v[0], 1) : -1
      if (quote > 0) v = v.slice(1, quote)
      else {
        // a trailing comment: the first `#` after whitespace, and that whitespace, go
        for (let k = 1; k < v.length; k++) {
          if (v[k] === '#' && /\s/.test(v[k - 1])) {
            v = v.slice(0, k)
            break
          }
        }
      }
      v = v.trim()
      return v === '' || v.toLowerCase() === 'inherit' ? undefined : v
    }
    if (line === undefined && l.startsWith('model:')) line = l
  }
  return undefined
}

// R3: a model family outside the role's set. At dispatch `model` is the call's, else the model the
// type's definition names; after the fact it is the first step's resolved model (judged only when R1
// fired: no model was named anywhere). An unknown role or family is not judged.
export function ruleR3(i: CallInput, roles?: Roles): Warning | undefined {
  const row = roles?.[roleOf(i.subagentType)]
  const model = i.model || i.definedModel
  const family = familyOf(model)
  if (!row || !model || family === 'unknown' || row.models.indexOf(family) >= 0) return undefined
  return {
    rule: 'R3',
    text: 'waypoint: ' + clean(roleOf(i.subagentType)) + ' "' + clean(i.description) + '" dispatched on ' + clean(family) + '; the role table expects ' + listOf(row.models) + '.',
  }
}

// R4: the first step's effort outside the role's expected set. Log and row mark only.
export function ruleR4(i: { description: string; subagentType?: string; effort?: string | number }, roles?: Roles): Warning | undefined {
  const role = roleOf(i.subagentType)
  const row = roles?.[role]
  if (!row || i.effort === undefined || i.effort === '') return undefined
  const effort = String(i.effort).toLowerCase()
  if (row.efforts.indexOf(effort) >= 0) return undefined
  return {
    rule: 'R4',
    text: 'waypoint: ' + clean(role) + ' "' + clean(i.description) + '" ran at effort ' + clean(effort) + '; the role table expects ' + listOf(row.efforts) + '.',
  }
}

export interface CallShape {
  ordinal: number
  label?: string // a literal, or a template pattern with `*`; absent when dynamic or missing
  hasModel: boolean
  hasEffort: boolean
  dynamic: boolean
}

const R2_BUDGET = 600
const NAME_MAX = 80

function callName(c: CallShape): string {
  const label = c.label === undefined ? '' : clean(c.label, NAME_MAX)
  if (label === '') return '#' + c.ordinal
  return '"' + label + '"'
}

function r2Text(workflow: string | undefined, count: number, names: string[]): string {
  const head = 'waypoint: Workflow "' + (workflow === undefined ? '(unnamed)' : clean(workflow, NAME_MAX)) + '": ' + count + ' agent() call(s) without model or effort: '
  const tail = '. Pass both on every call.'
  let shown = names.length
  const text = () => head + names.slice(0, shown).join(', ') + (shown < names.length ? ', +' + (names.length - shown) + ' more' : '') + tail
  while (shown > 1 && text().length > R2_BUDGET) shown--
  return text()
}

// R2: agent() calls whose options lack `model:` or `effort:`. A call whose options are dynamic (a
// variable, a spread) is not claimed to lack anything. Names the calls by label, else ordinal.
// `warning` is the whole list, cut near 600 characters with `+n more`, for the log, the toast and
// Claude; `perCall` is what each offending record stores, naming that call only.
export function ruleR2(i: { name?: string; calls: CallShape[] }): {
  warning: Warning
  ordinals: number[]
  perCall: Array<{ ordinal: number; warning: Warning }>
} | undefined {
  const missing = i.calls.filter((c) => !c.dynamic && (!c.hasModel || !c.hasEffort))
  if (missing.length === 0) return undefined
  return {
    ordinals: missing.map((c) => c.ordinal),
    warning: { rule: 'R2', text: r2Text(i.name, missing.length, missing.map(callName)) },
    perCall: missing.map((c) => ({ ordinal: c.ordinal, warning: { rule: 'R2', text: r2Text(i.name, 1, [callName(c)]) } })),
  }
}

// The text a warning is stored as on a record (warnings[]): the rule, a space, the one-line text.
export function warningString(w: Warning): string {
  return w.rule + ' ' + w.text
}

// "waypoint: " is dropped for the log and the pane, which already say what they are.
export function warningDetail(w: Warning): string {
  return w.text.replace(/^waypoint: /, '')
}
