// Pin arguments (pure): `<path> ["Section text"] [column=<name> | check=<name> | auto] [partial=<column>]
// [groups=<path>]`, the filter of SPEC.md 3.3. Paths are made absolute against the cwd.

export interface Filter {
  file: string
  section?: string
  doneRule?: string
  partial?: string
  groupMap?: string
  // Set when the pin was made on Claude's behalf (SPEC 14): the real directory each path must land
  // under, every link followed, at the pin and at every read after it. A pin of the user's has none.
  bounds?: { file: string; groupMap?: string }
}

// Two filters pin the same plan when every field matches; no rule is the `auto` rule. The bounds say
// who pinned it, not which plan, and are not compared.
export function sameFilter(a: Filter | null, b: Filter | null): boolean {
  if (a === null || b === null) return false
  return (
    a.file === b.file && a.section === b.section && (a.doneRule ?? 'auto') === (b.doneRule ?? 'auto') && a.partial === b.partial &&
    a.groupMap === b.groupMap
  )
}

const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/

// `path` made absolute against `cwd`, `.` and `..` resolved. A Windows-style path (a drive letter, or
// a relative or `\`-rooted path under a drive-letter cwd) takes either separator and comes back as
// `C:\...`; any other path is POSIX.
export function absolutePath(cwd: string, path: string): string {
  const drive = DRIVE.exec(path)?.[0] ?? (path.startsWith('/') ? undefined : DRIVE.exec(cwd)?.[0])
  const full = drive === undefined ? (path.startsWith('/') ? path : cwd + '/' + path) : DRIVE.test(path) ? path : /^[\\/]/.test(path) ? drive + path : cwd + '\\' + path
  const parts = (drive === undefined ? full : full.slice(2)).split(drive === undefined ? '/' : /[\\/]/)
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return drive === undefined ? '/' + out.join('/') : drive + '\\' + out.join('\\')
}

// The path without its trailing slashes and backslashes (a pattern for the run would try every start).
function trimSeparators(p: string): string {
  let end = p.length
  while (end > 0 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--
  return p.slice(0, end)
}

// Whether a resolved path is the directory or under it (SPEC 14), both as `$.fs.stat(..., { resolve:
// true })` answers them. A Windows directory (`C:\...` or a UNC share path) compares in any case and with
// either slash; a sibling that only shares the prefix (`/wx` for `/w`) is outside.
export function insideDir(path: string, dir: string): boolean {
  const win = /^[A-Za-z]:([\\/]|$)/.test(dir) || dir.startsWith('\\\\')
  const norm = (p: string) => trimSeparators(win ? p.replace(/\//g, '\\').toLowerCase() : p)
  const d = norm(dir)
  const p = norm(path)
  return p === d || p.startsWith(d + (win ? '\\' : '/'))
}

// The paths as the user typed them, for the text of a refusal.
export interface Typed {
  file: string
  groupMap?: string
}

// Why a file did not read, in a sentence that names no API: `file not found: p.md` (ENOENT) or
// `cannot read p.md`; `shown` is the path as typed.
export function readFailure(err: unknown, shown: string): string {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  return code === 'ENOENT' || /\bENOENT\b/.test(message) ? 'file not found: ' + shown : 'cannot read ' + shown
}

export type PinParse = { ok: true; filter: Filter; typed: Typed } | { ok: false; error: string }

export function parsePinArgs(args: string, cwd: string): PinParse {
  const tokens: string[] = []
  let section: string | undefined
  let rest = args.trim()
  while (rest !== '') {
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1)
      if (end < 0) return { ok: false, error: 'unclosed quote' }
      if (section !== undefined) return { ok: false, error: 'only one quoted section' }
      section = rest.slice(1, end)
      rest = rest.slice(end + 1).trim()
    } else {
      const m = /^\S+/.exec(rest)!
      tokens.push(m[0])
      rest = rest.slice(m[0].length).trim()
    }
  }
  if (tokens.length === 0) return { ok: false, error: 'no plan file given' }
  const filter: Filter = { file: absolutePath(cwd, tokens[0]) }
  const typed: Typed = { file: tokens[0] }
  if (section !== undefined) filter.section = section
  for (const t of tokens.slice(1)) {
    const error = applyToken(filter, t, cwd, typed)
    if (error !== undefined) return { ok: false, error }
  }
  return { ok: true, filter, typed }
}

// One rule token into the filter; the refusal text when it is not one.
function applyToken(filter: Filter, t: string, cwd: string, typed: Typed): string | undefined {
  const m = /^(column|check|partial|groups)=(.*)$/.exec(t)
  if (t === 'auto') filter.doneRule = 'auto'
  else if (m && m[2] === '') return 'empty value: ' + t
  else if (m && (m[1] === 'column' || m[1] === 'check')) filter.doneRule = t
  else if (m && m[1] === 'partial') filter.partial = m[2]
  else if (m && m[1] === 'groups') {
    filter.groupMap = absolutePath(cwd, m[2])
    typed.groupMap = m[2]
  }
  else return 'unknown argument: ' + t
  return undefined
}

// The tool's `track` input: each field goes through the same token rules as the command's
// arguments, so a refusal reads the same from either.
export function filterFromInput(i: Record<string, unknown>, cwd: string): PinParse {
  const fields: Array<[string, string]> = [['file', ''], ['section', ''], ['doneRule', ''], ['partial', 'partial='], ['groupMap', 'groups=']]
  for (const [k] of fields) if (i[k] !== undefined && typeof i[k] !== 'string') return { ok: false, error: k + ' must be a string' }
  const file = i.file as string | undefined
  if (file === undefined || file.trim() === '') return { ok: false, error: 'no plan file given' }
  const filter: Filter = { file: absolutePath(cwd, file.trim()) }
  const typed: Typed = { file: file.trim() }
  if (typeof i.section === 'string' && i.section !== '') filter.section = i.section
  for (const [k, prefix] of fields.slice(2)) {
    const v = i[k] as string | undefined
    if (v === undefined) continue
    const error = applyToken(filter, prefix + v, cwd, typed)
    if (error !== undefined) return { ok: false, error }
  }
  return { ok: true, filter, typed }
}
