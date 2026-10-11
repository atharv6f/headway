import { mock } from 'claude-code/testing'

// The world beneath the plugin for the tool, command and persistence tests: files by path, a store
// in memory that records each write with the clock's time, the session id, panes and toasts.
export const TOOL = 'mcp__headway__headway'

export interface World {
  clock: ReturnType<typeof mock.clock>
  store: Record<string, unknown>
  writes: Array<{ key: string; at: number; value: unknown }>
  opens: Array<{ id: string }>
  closes: string[]
  panes: Array<{ id: string; isPlaced: boolean }>
  setSessionId: (id: string) => void
  last: Record<string, unknown>
  files: Record<string, string> // mutable: a test may rewrite a file
  mtimes: Record<string, number> // a file's mtimeMs, 1 unless set
  kinds: Record<string, string> // what a path's stat says it is, 'file' unless set ('fifo', 'dir')
  real: Record<string, string> // where a path lands when statted with resolve (a symlink); itself unless set; a read of it reads there
  afterStat: (path: string) => void // runs after each stat answers: a test swaps a link here, between a stat and the read after it
  gates: Record<string, Promise<void>> // a read of the path waits for its promise
  enabledPlugins: Record<string, boolean> | 'throws' // what `$.settings.read()` answers; a test may change it
  themeRow: string | undefined // the Claude Code `theme` row of `$.config.list()`
  toasts: string[]
  processRuns: number // a subprocess headway ran (it must not)
  touched: string[] // every path headway read, statted or listed, in order
  reads: string[] // every path headway read, in order
}

export function world(
  on,
  o: {
    files?: Record<string, string>
    store?: Record<string, unknown>
    sessionId?: string
    now?: number
    watchState?: boolean
    env?: Record<string, string>
    enabledPlugins?: Record<string, boolean> | 'throws'
    themeRow?: string
    cwd?: string
  } = {},
): World {
  const clock = mock.clock(on, { now: o.now ?? 1_000_000 })
  mock.env(on, o.env ?? {})
  const files = o.files ?? {}
  const store: Record<string, unknown> = JSON.parse(JSON.stringify(o.store ?? {}))
  const w: World = { clock, store, writes: [], opens: [], closes: [], panes: [], setSessionId: () => {}, last: {}, files, mtimes: {}, kinds: {}, real: {}, afterStat: () => {}, gates: {}, enabledPlugins: o.enabledPlugins ?? {}, themeRow: o.themeRow, toasts: [], processRuns: 0, touched: [], reads: [] }
  let sessionId = o.sessionId ?? 'sess-1'
  w.setSessionId = (id) => {
    sessionId = id
  }
  // a test that serves `$.state` itself (snapshotState) watches it there
  if (o.watchState !== false) {
    on('state.set', async ($, e, next) => {
      if (e.plugin === 'headway') w.last[e.key] = e.value
      return next(e)
    })
  }
  // The engine makes a `C:\...` path absolute against the test process's directory; the files here are
  // keyed by the path as the plugin wrote it.
  const asWritten = (p: string) => {
    const win = /[A-Za-z]:\\/.exec(p)
    return win && win.index > 0 ? p.slice(win.index) : p
  }
  on('fs.read', async (_$, e) => {
    const path = asWritten(e.path)
    w.touched.push(path)
    w.reads.push(path)
    const gate = w.gates[path]
    if (gate) await gate
    if (!(path in files)) throw new Error('ENOENT: no such file: ' + path)
    const target = w.real[path]
    return { value: target !== undefined && target in files ? files[target] : files[path] }
  })
  // a path some file sits under is a directory; with `resolve`, the answer carries where the path lands
  on('fs.stat', async (_$, e) => {
    const path = asWritten(e.path)
    w.touched.push(path)
    const realPath = e.resolve ? { realPath: w.real[path] ?? path } : {}
    try {
      if (!(path in files)) {
        const dir = path.replace(/[\\/]+$/, '')
        if (Object.keys(files).some((f) => f.startsWith(dir + '/') || f.startsWith(dir + '\\'))) return { value: { kind: 'dir', size: 0, mtimeMs: 1, isLink: false, ...realPath } }
        throw new Error('ENOENT: no such file: ' + path)
      }
      return { value: { kind: w.kinds[path] ?? 'file', size: w.kinds[path] === undefined ? files[path].length : 0, mtimeMs: w.mtimes[path] ?? 1, isLink: path in w.real, ...realPath } }
    } finally {
      w.afterStat(path)
    }
  })
  // a directory lists the files under it and the names of the directories one level down
  on('fs.list', async (_$, e) => {
    w.touched.push(e.path)
    const dir = e.path.replace(/\/$/, '') + '/'
    const seen = new Map<string, string>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(dir)) continue
      const rest = path.slice(dir.length)
      const slash = rest.indexOf('/')
      seen.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir')
    }
    if (seen.size === 0) throw new Error('ENOENT: no such directory: ' + e.path)
    return { value: [...seen].map(([name, kind]) => ({ name, kind, size: 0 })) }
  })
  on('settings.read', async () => {
    if (w.enabledPlugins === 'throws') throw new Error('settings unreadable')
    return { value: { enabledPlugins: w.enabledPlugins } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', async () => ({}))
  on('session.cwd', async () => ({ value: o.cwd ?? '/w' }))
  on('session.id', async () => ({ value: sessionId }))
  on('config.list', async () => ({ value: w.themeRow === undefined ? [] : [{ key: 'theme', label: 'Theme', kind: 'choice', value: w.themeRow }] }))
  on('process.run', async () => {
    w.processRuns++
    throw new Error('headway runs no subprocess')
  })
  on('ui.toast', async (_$, e) => {
    w.toasts.push(e.text)
    return { value: {} }
  })
  on('ui.open', async (_$, e) => {
    w.opens.push({ id: e.id })
    w.panes = [{ id: e.id, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.close', async (_$, e) => {
    w.closes.push(e.id)
    w.panes = w.panes.filter((p) => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', async () => ({ value: w.panes }))
  on('store.get', async (_$, e) => ({ value: store[e.key] }))
  on('store.set', async (_$, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    w.writes.push({ key: e.key, at: clock.now(), value: store[e.key] })
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: Object.keys(store) }))
  return w
}

export const PLAN = `# Plan

## Work

| task | title | landed | published |
|---|---|---|---|
| T1 | first | yes | yes |
| T2 | second | | yes |
| T3 | third | | |
`

// The engine's agent transcripts (`$.session.messages({ agentId })`): an agent's opens with the
// prompt it was spawned with. A test engine's agent.spawn calls `spawned(agentId, prompt)`; headway
// joins a spawn to its agentId by that opening (agents.ts joinSpawn).
export function transcripts(on): (agentId: string, prompt: string | undefined) => void {
  const prompts: Record<string, string> = {}
  on('session.messages', async (_$, e) => {
    const p = e.agentId !== undefined ? prompts[e.agentId] : undefined
    return { value: p === undefined ? { deny: 'no such agent' } : [{ role: 'user', text: p, toolUses: [] }] }
  })
  return (agentId, prompt) => {
    if (prompt !== undefined) prompts[agentId] = prompt
  }
}

// The user's own `/headway <args>`, typed at the prompt: the engine stamps it `composer` (SPEC 9.2).
export function userCommand($, args: string) {
  return $.command.run({ command: 'headway', args, origin: { kind: 'composer' } } as never)
}

export async function start($) {
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
}

// `$.state` as the engine serves it: every get of one dispatch reads the moment the dispatch began,
// whatever is written meanwhile; a set given `ifVersion` that another write beat misses, and a get
// after the miss reads what stands. `begin` and `end` bracket one dispatch the test drives.
type Cell = { value: unknown; version: number }

export function snapshotState(on) {
  const store: Record<string, Cell> = {}
  let snap: Record<string, Cell> | null = null
  const k = (e: { plugin: string; key: string }) => e.plugin + '/' + e.key
  const cur = (key: string): Cell => store[key] ?? { value: undefined, version: 0 }
  on('state.get', async (_$, e) => {
    const key = k(e)
    const c = snap ? snap[key] ?? { value: undefined, version: 0 } : cur(key)
    return { value: { value: c.value === undefined ? undefined : JSON.parse(JSON.stringify(c.value)), version: c.version } }
  })
  on('state.set', async (_$, e) => {
    const key = k(e)
    const c = cur(key)
    if (e.ifVersion !== undefined && e.ifVersion !== c.version) {
      if (snap) snap[key] = c
      return { value: { isSet: false, version: c.version } }
    }
    store[key] = { value: JSON.parse(JSON.stringify(e.value)), version: c.version + 1 }
    return { value: { isSet: true, version: c.version + 1 } }
  })
  return {
    begin: () => {
      snap = JSON.parse(JSON.stringify(store))
    },
    end: () => {
      snap = null
    },
    value: (key: string) => cur('headway/' + key).value,
  }
}

