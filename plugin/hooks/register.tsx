// Every on(...) and every $.* call. The pure modules (plan.ts, format.ts, agents.ts, theme.ts,
// band.tsx, pane.tsx, pin.ts, tool.ts, persist.ts) carry the work.
import { atom, read, update } from 'claude-code'
import { JOIN_TEXT, RUN_TITLE_MAX, addPlanned, appendLog, bandCurrent, bindAgent, bindRun, buildTree, completeAgent, dropPlanned, dropUnjoined, isFinished, isShown, pinEntry, planFlips, promptHead, reconcileList, repinAgents, repointLog, rereadEntry, settleRestored, spawnAgent, spawnRecordId, stepEnd, stepStart, tick, unpinEntry } from './agents.ts'
import type { AgentRecord, JoinHints, LogEntry, Outcome, PlannedInput } from './agents.ts'
import { bandLines, bandTree, bandVisible } from './band.tsx'
import { clean, plainName } from './format.ts'
import { quietSegs, quietTree } from './quiet.tsx'
import { bandBody, DEFAULT_UI, isTab, paneTree } from './pane.tsx'
import type { Handlers, PaneData, Tab, UiState, UsageData } from './pane.tsx'
import { parseGroupMap, parsePlan } from './plan.ts'
import type { GroupMapEntry, Plan } from './plan.ts'
import { filterFromInput, insideDir, parsePinArgs, readFailure, sameFilter } from './pin.ts'
import type { Filter, Typed } from './pin.ts'
import { asSaved, BAND_PREF, capSession, isSessionKey, isStale, recordText, SAVE_MS, sessionKey } from './persist.ts'
import type { SavedSession } from './persist.ts'
import type { StatusUpdate } from './tool.ts'
import { GUIDE_ID, GUIDE_TEXT, guideWanted, idsText, parseReport, planNote, stateBlock, TOOL_SPEC, trackLine, updatedLine } from './tool.ts'
import type { Reported } from './tool.ts'
import { definitionModel, definitionName, definitionPlugin, parseRoles, projectDirs, roleOf, ruleR1, ruleR2, ruleR3, searchDirs, warningDetail, warningString } from './router.ts'
import type { Roles, Warning } from './router.ts'
import { phaseRun } from './phases.ts'
import { parseWorkflow } from './workflow.ts'
import { hideHint, hintAfterMeasure, hintAtTurnComplete, hintOnTurnStart, line3Data, noteBoundary, START } from './usage.ts'
import type { Boundary } from './usage.ts'
import type { Value } from './workflow.ts'
import { buildTheme, parseStore, parseThemeFile, pickVersion, resolveLight, resolveSkin, skinsEntry, themeModeOf, wantSkins } from './theme.ts'
import type { SkinsEntry, Theme, ThemeMode } from './theme.ts'
import { parsePlanMode } from './planmode.ts'
import type { PlanMode } from './planmode.ts'
import { applyTaskCall, rebuildFromFiles } from './tasks.ts'
import type { TaskItem } from './tasks.ts'
import { activeSource, applyReport, approvePlan, goalLabel, isNewWork, isPlanModeFile, isTemporal, promptLabel, sourceFlips, sourcePlan, startLabel, withDoneAt } from './sources.ts'
import type { SourceLabels, SourceTag, Sources } from './sources.ts'

// `$.state` atoms (SPEC 3.3). `filter` is the pinned plan; `report` the task list the `report`
// action gave, which stands in for the parsed plan until the next pin; `focus` the task the `focus`
// action named, until the next spawn; `goal` is the summary of the poll's last parse that the band
// draws; `theme` the resolved skins look; `agents` and `log` are written by the agent hooks; `ui`
// is the pane's tab and expand state; `usage` is the context and session figures (M6 writes it).
const filterAtom = atom({ plugin: 'headway', key: 'filter' } as const, null as Filter | null)
const goalAtom = atom({ plugin: 'headway', key: 'goal' } as const, null)
const themeAtom = atom({ plugin: 'headway', key: 'theme' } as const, null)
const agentsAtom = atom({ plugin: 'headway', key: 'agents' } as const, [] as AgentRecord[])
const logAtom = atom({ plugin: 'headway', key: 'log' } as const, [] as LogEntry[])
const uiAtom = atom({ plugin: 'headway', key: 'ui' } as const, DEFAULT_UI as UiState)
const usageAtom = atom({ plugin: 'headway', key: 'usage' } as const, null as UsageData | null)
const reportAtom = atom({ plugin: 'headway', key: 'report' } as const, null as Reported | null)
const focusAtom = atom({ plugin: 'headway', key: 'focus' } as const, null as string | null)
// The approved plan-mode plan (SPEC 4.4): its parsed steps and, in `$.state` only, its text.
type PlanModeState = PlanMode & { text?: string }
const planAtom = atom({ plugin: 'headway', key: 'plan' } as const, null as PlanModeState | null)
// The prompt labels (SPEC 4.8): each in-memory source's, the prompt line of the turn that started it;
// and `prompt`, the newest qualifying composer prompt line, which the next source to start takes.
const labelAtom = atom({ plugin: 'headway', key: 'label' } as const, {} as SourceLabels)
const promptAtom = atom({ plugin: 'headway', key: 'prompt' } as const, null as string | null)

// The task-tool list (SPEC 4.5): what TaskCreate, TaskUpdate and TodoWrite of the main loop made.
const tasksAtom = atom({ plugin: 'headway', key: 'tasks' } as const, null as TaskItem[] | null)

const MIN = 60_000

// ---- M2: theme, band, skins composition ------------------------------------------------------

// The theme is read once at session start and again only when the skins store file or the theme file
// changed (an mtime stat on every fifth 2 s tick), or when the skins plugin was enabled or disabled.
// A quiet headway (no plan, no agents) stats the store file alone and defers the re-read until it
// has something to draw. No subprocess is run (SPEC 11).
const THEME_EVERY_TICKS = 5
let toasted = false
let themeTicks = 0
let themeDirty = false
let themeCfg: string | undefined
let themeWatch: { sig?: string; marketplace?: string; store?: string; storeMtime?: number; file?: string; fileMtime?: number } = {}

// The settings (SPEC 13), from `register(on, options)`.
let themeMode: ThemeMode = 'auto'
let routerOn = true
let guideOn = true
let quietOn = true
const TOOL_NAME = 'mcp__headway__headway'
let bandDefaultOff = false

// The plan-mode handoff (SPEC 4.3, 4.4): the approved plan's file, and whether the approval is still
// fresh: its own turn, until the main loop's turn completes, a prompt arrives or an updates call is made.
// `awaitStart`: the plan crossed a /clear (12), so the turn that completes next is the one left behind;
// freshness runs through the new conversation's first turn instead.
let handoff: { file?: string; fresh: boolean; awaitStart?: true } = { fresh: false }

// An ExitPlanMode of the main loop whose turn has not completed. A /clear before the turn completes,
// within CARRY_MS, is the plan dialog's "clear context" choice (SPEC 12): the plan crosses it. The
// engine answers that choice with the rejection text and `isError`, so a rejected call is held too.
let planBeforeClear: { text: string; file?: string; label: string | null; at: number; approved: boolean } | undefined
const CARRY_MS = 10_000

// The home directory: HOME, else USERPROFILE (Windows sets that one).
async function homeDir($): Promise<string | undefined> {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || undefined
}

async function configDir($) {
  if (themeCfg !== undefined) return themeCfg
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  themeCfg = dir ? dir : ((await homeDir($)) ?? '') + '/.claude'
  return themeCfg
}

async function mtimeOf($, path: string | undefined): Promise<number | undefined> {
  if (path === undefined) return undefined
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

async function tryRead($, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

// A config-directory file is read only as a regular file of at most `max` bytes, read where it lands (the
// real path that was statted). A missing file is silent; one that is a pipe, a device or too large is
// not read, with one debug line saying why (SPEC 14).
const ROLES_MAX = 64 * 1024
const STORE_MAX = 256 * 1024
const THEME_MAX = 64 * 1024
const TASK_FILE_MAX = 64 * 1024
const TASK_FILES_MAX = 500

async function tryReadBounded($, path: string, max: number): Promise<string | undefined> {
  let st: { kind?: string; size?: number; realPath?: string }
  try {
    st = await $.fs.stat(path, { resolve: true })
  } catch {
    return undefined
  }
  const why = unreadable(st, max)
  if (why !== undefined) {
    fault($, path + ' not read', new Error(why))
    return undefined
  }
  return tryRead($, st.realPath ?? path)
}

// Where a path lands, every link followed (`$.fs.stat` with `resolve`); undefined when it does not
// stat or the answer carries no real path. The boundaries of SPEC 14 compare these.
async function realPathOf($, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    return undefined
  }
}

async function tryList($, path: string): Promise<Array<{ name: string; kind: string }>> {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

async function isLight($): Promise<boolean> {
  return resolveLight({
    override: await $.env.get('SKINS_THEME'),
    theme: (await $.config.list()).find((row) => row.key === 'theme')?.value,
    colorfgbg: await $.env.get('COLORFGBG'),
  })
}

// The skins plugin as the merged settings name it (B1); undefined when not installed or unreadable.
async function skinsInstalled($): Promise<SkinsEntry | undefined> {
  try {
    return skinsEntry(((await $.settings.read()) as { enabledPlugins?: unknown }).enabledPlugins)
  } catch {
    return undefined
  }
}

function storeRe(marketplace: string): RegExp {
  return new RegExp('^skins_' + marketplace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[0-9a-f]+\\.json$')
}

async function toastOnce($, reason: string) {
  if (toasted) return
  toasted = true
  await $.ui.toast('headway: skins theme unreadable, using ANSI colours (' + reason + ')')
}

// Which colours to draw: skins' palette when `theme` and the settings say so (SPEC 11), else plain.
// Writes `theme` when it changed.
async function refreshTheme($) {
  themeDirty = false
  const entry = await skinsInstalled($)
  const sig = themeSig(entry)
  if (!wantSkins(themeMode, entry)) {
    themeWatch = { sig }
    await writeTheme($, buildTheme({ name: 'plain', icons: 'unicode', file: null, light: await isLight($) }))
    return
  }
  const cfg = await configDir($)
  const store = (await tryList($, cfg + '/plugins/store')).find((x) => storeRe(entry.marketplace).test(x.name))
  const storePath = store ? cfg + '/plugins/store/' + store.name : undefined
  const text = storePath ? await tryReadBounded($, storePath, STORE_MAX) : undefined
  const settings = parseStore(text, await $.session.cwd())
  let filePath: string | undefined

  let file = null
  let reason = ''
  let overrides = {}
  let name = settings.skin
  let custom = false
  const resolvedOff = settings.skin === 'off'
  if (!resolvedOff) {
    const skinsDir = cfg + '/plugins/cache/' + entry.marketplace + '/skins'
    const version = pickVersion((await tryList($, skinsDir)).map((x) => x.name))
    if (version === undefined) {
      reason = 'no skins plugin under ' + skinsDir
    } else {
      const themes = skinsDir + '/' + version + '/hooks/themes'
      const builtins = (await tryList($, themes)).map((x) => x.name.replace(/\.ts$/, '')).filter((n) => n !== 'index')
      const pick = resolveSkin(settings, builtins)
      if (!pick.off) {
        name = pick.name
        overrides = pick.overrides
        custom = pick.file !== pick.name
        filePath = themes + '/' + pick.file + '.ts'
        const src = await tryReadBounded($, filePath, THEME_MAX)
        file = src === undefined ? null : parseThemeFile(src)
        if (file === null) reason = (src === undefined ? 'cannot read ' : 'cannot parse ') + themes + '/' + pick.file + '.ts'
      }
    }
  }
  if (reason !== '') await toastOnce($, reason)
  themeWatch = { sig, marketplace: entry.marketplace, store: storePath, storeMtime: await mtimeOf($, storePath), file: filePath, fileMtime: await mtimeOf($, filePath) }
  await writeTheme($, buildTheme({ name, icons: settings.icons, file, overrides, light: await isLight($), custom }))
}

async function writeTheme($, theme: Theme): Promise<void> {
  if (JSON.stringify(await read($, themeAtom)) !== JSON.stringify(theme)) await update($, themeAtom, () => theme)
}

// What the theme depends on besides the skins files: the setting and the skins entry of the settings.
function themeSig(entry: SkinsEntry | undefined): string {
  return themeMode + ':' + (entry ? entry.marketplace + ':' + entry.enabled : '-')
}

// The band pref, read from the store at session start and kept here for the band: `/headway band
// on|off` is stored and beats `bandDefault`, which stands until the command has been run.
let bandOff = false

// ---- M3: agent tracking ----------------------------------------------------------------------
// Agent events write `agents` through `update`, whose read-apply-write retries on a version miss,
// so interleaved hooks never lose a transition; the reducers in agents.ts are pure and may run
// more than once per write.

let stallMs = 10 * MIN
let startMs = 2 * MIN
let trackingTimers: Array<{ cancel: () => void }> = []

// The last good parse of the pinned plan, kept in memory: derived from the filter and the file,
// re-read by the 2 s poll on a changed mtime. A failed read or parse keeps the last good one. It is
// the only plan read path: the band draws `goal`, written from this parse, and reads it for line 2.
let planCache: { key: string; mtime: number; gmMtime: number; plan: Plan | null; error?: string } | undefined
let planLoading: Promise<Plan | null> | undefined
// Bumped by every pin, unpin and reload: a load begun under an older generation writes no plan
// cache, goal or log when it lands, and never clears the newer load's slot.
let planGen = 0

// What a load reads the plan from: every source's data (sources.ts) and the prompt label. A read of
// an atom inside the dispatch that wrote it still answers the value from before the write, so
// `readInputs` takes each value from `written` (the newest write this process made) before the atom.
interface PlanInputs extends Sources {
  labels: SourceLabels
  prompt: string | null
}

async function readInputs($): Promise<PlanInputs> {
  const w = written
  return {
    filter: 'filter' in w ? w.filter ?? null : await read($, filterAtom),
    report: 'report' in w ? w.report ?? null : await read($, reportAtom),
    planMode: 'plan' in w ? w.plan ?? null : await read($, planAtom),
    tasks: 'tasks' in w ? w.tasks ?? null : await read($, tasksAtom),
    phases: phaseRun('agents' in w ? w.agents ?? [] : await read($, agentsAtom)),
    labels: 'label' in w ? w.label ?? {} : (await read($, labelAtom)) ?? {},
    prompt: 'prompt' in w ? w.prompt ?? null : await read($, promptAtom),
  }
}

// A source starts (a full report list, a plan approval, a task list out of nothing, a new run with
// phases): it takes the newest prompt line as its label (SPEC 4.8). Answers the labels written.
async function startSource($, tag: SourceTag): Promise<SourceLabels> {
  const { prompt } = await readInputs($)
  // inside the reducer, so two sources starting at once both keep their label
  const labels = await update($, labelAtom, (cur) => startLabel(cur ?? {}, tag, prompt))
  remember({ label: labels })
  return labels
}

// The task flips of the active in-memory source between two states of it (not across a start, which
// is a new list): logged in one wording for every source, each `task-done` a task boundary (SPEC 8).
async function noteSourceFlips($, before: PlanInputs, after: PlanInputs): Promise<void> {
  const tag = activeSource(after)
  if (tag === null || tag === 'file' || activeSource(before) !== tag) return
  const prev = sourcePlan(before, tag)
  const next = sourcePlan(after, tag)
  if (!prev || !next) return
  // another run is a new list, not a flip; the run is told by its call (the key phaseRun groups by),
  // since its run id binds only at the first spawn or the call's return
  const run = (p: Plan) => p.phaseRun?.toolUseId ?? p.phaseRun?.runId
  if (tag === 'phases' && run(prev) !== run(next)) return
  // a phase that failed logs no flip: its agent's own `failed` entry says it
  const failed = new Set(next.tasks.filter((t) => t.failed).map((t) => t.id))
  const flips = sourceFlips(prev, next, await $.clock.now()).filter((f) => !failed.has(f.ref))
  if (flips.length === 0) return
  await addLog($, flips)
  noteTaskFlips(flips)
}

function resetPlan(): void {
  planGen++
  planCache = undefined
  planLoading = undefined
}

// The band's goal summary of a parse; written only when it changed. An error keeps the last counts.
async function writeGoal($, gen: number, source: SourceTag, label: string, plan: Plan | null, error?: string): Promise<void> {
  if (gen !== planGen) return
  const current = await read($, goalAtom)
  let goal = current
  if (plan) {
    goal = {
      label,
      done: plan.counts.done,
      partial: plan.counts.partial,
      open: plan.counts.open,
      total: plan.counts.total,
      doneWord: plan.doneWord,
      noDoneRule: plan.noDoneRule,
      ...(plan.partialWord !== undefined ? { partialWord: plan.partialWord } : {}),
      ...(error !== undefined ? { error } : {}),
      source,
    }
  } else if (current && error !== undefined) {
    goal = { ...current, error }
  }
  if (gen === planGen && JSON.stringify(goal) !== JSON.stringify(current)) await update($, goalAtom, () => goal)
}

function fileLabel(filter: Filter): string {
  return goalLabel({ filter, report: null, planMode: null, tasks: null, phases: null }, 'file', null)
}

// Runs a reducer over the agent list inside `update`, then appends the log entries of the write that
// landed. Every get of one dispatch reads the moment the dispatch began, so a plain read here would
// miss a write made earlier in the same dispatch (a step's stepStart, then its stepEnd); `update`
// reads again after a missed write and the reducer sees what stands. When the reducer changed
// nothing the same list goes back and nothing is logged or saved. Answers the list written.
async function applyAgents($, fn: (agents: AgentRecord[]) => Outcome): Promise<AgentRecord[]> {
  let out: Outcome = { agents: [], log: [], changed: false }
  let seen: AgentRecord[] = []
  const written = await update($, agentsAtom, (agents) => {
    seen = agents
    out = fn(agents)
    return out.changed ? out.agents : agents
  })
  if (!out.changed) return written
  remember({ agents: written })
  prunePrompts(written)
  // a corrected join moved step data between records: the entries they wrote follow (bindAgent)
  const moved = out.repoint
  if (moved !== undefined && moved.length > 0) remember({ log: await update($, logAtom, (log) => appendLog(repointLog(log, written, moved), out.log)) })
  else if (out.log.length > 0) remember({ log: await update($, logAtom, (log) => appendLog(log, out.log)) })
  // The phases source is derived from the agents: a write that moved a phase is its flip.
  if (written.some((a) => a.runPhases !== undefined)) {
    await guarded($, 'phase flips', async () => {
      const after = await readInputs($)
      await noteSourceFlips($, { ...after, phases: phaseRun(seen) }, after)
    })
  }
  await safely(scheduleSave($))
  return written
}

async function addLog($, entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return
  remember({ log: await update($, logAtom, (log) => appendLog(log, entries)) })
  await safely(scheduleSave($))
}

function currentPlan($, known?: PlanInputs): Promise<Plan | null> {
  if (!planLoading) {
    const loading: Promise<Plan | null> = loadPlan($, planGen, known).finally(() => {
      if (planLoading === loading) planLoading = undefined
    })
    planLoading = loading
  }
  return planLoading
}

// A file read for the plan (SPEC 4.2, 14): stat with every link followed, then, for a bounded pin, the
// real path must land under the bound, and what it leads to must be a regular file of at most `max`
// bytes (a pipe or a device is never read); the real path that was statted, never the path as given,
// is what is read, so a link swapped after the check is not followed. Its text, or the refusal in
// plain words (pin.ts readFailure) naming the path as the user typed it, else as it was resolved.
type ReadOutcome = { ok: true; text: string } | { ok: false; error: string }
const PLAN_MAX = 2 * 1024 * 1024
const GROUP_MAP_MAX = 256 * 1024

// Why a stat's answer is not a file headway reads: not a regular file, or over `max` bytes; else none.
function unreadable(st: { kind?: string; size?: number }, max: number): string | undefined {
  if (st.kind !== 'file') return 'not a regular file'
  if (!(typeof st.size === 'number' && st.size <= max)) return 'file too large'
  return undefined
}

async function readText($, path: string, shown: string, max: number, bound?: string): Promise<ReadOutcome> {
  let st: { kind?: string; size?: number; realPath?: string }
  try {
    st = await $.fs.stat(path, { resolve: true })
  } catch (err) {
    return { ok: false, error: readFailure(err, shown) }
  }
  const real = st.realPath
  if (bound !== undefined && (real === undefined || !insideDir(real, bound))) return { ok: false, error: shown + ' lands outside ' + bound }
  const why = unreadable(st, max)
  if (why !== undefined) return { ok: false, error: why + ': ' + shown }
  try {
    return { ok: true, text: await $.fs.read(real ?? path) }
  } catch (err) {
    return { ok: false, error: readFailure(err, shown) }
  }
}

async function readPlan($, filter: Filter, typed?: Typed): Promise<{ ok: true; plan: Plan } | { ok: false; error: string }> {
  try {
    const file = await readText($, filter.file, typed?.file ?? filter.file, PLAN_MAX, filter.bounds?.file)
    if (!file.ok) return file
    let groups: GroupMapEntry[] | undefined
    if (filter.groupMap) {
      const map = await readText($, filter.groupMap, typed?.groupMap ?? filter.groupMap, GROUP_MAP_MAX, filter.bounds?.groupMap)
      if (!map.ok) return map
      const gm = parseGroupMap(map.text)
      if (!gm.ok) return { ok: false, error: gm.error }
      groups = gm.groups
    }
    return parsePlan(file.text, { section: filter.section, doneRule: filter.doneRule, partial: filter.partial }, groups)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// The active source (sources.ts) gives the plan. For the file: stat the plan (and the group map);
// on a changed mtime re-parse and log the tasks that flipped. No source clears the goal. Every write
// is skipped once a newer generation has begun.
async function loadPlan($, gen: number, known?: PlanInputs): Promise<Plan | null> {
  const inputs = known ?? (await readInputs($))
  const tag = activeSource(inputs)
  if (tag !== null && tag !== 'file') return loadInMemory($, gen, inputs, tag)
  const filter = tag === 'file' ? inputs.filter : null
  if (!filter) {
    if (gen !== planGen) return null
    planCache = undefined
    if ((await read($, goalAtom)) !== null && gen === planGen) await update($, goalAtom, () => null)
    return null
  }
  const key = JSON.stringify(filter)
  const prev = planCache && planCache.key === key ? planCache : undefined
  let mtime = -1
  let gmMtime = -1
  try {
    mtime = (await $.fs.stat(filter.file)).mtimeMs
    if (filter.groupMap) gmMtime = (await $.fs.stat(filter.groupMap)).mtimeMs
  } catch (err) {
    if (gen !== planGen) return prev?.plan ?? null
    planCache = { key, mtime: -1, gmMtime: -1, plan: prev?.plan ?? null, error: String(err) }
    await writeGoal($, gen, 'file', fileLabel(filter), planCache.plan, planCache.error)
    return planCache.plan
  }
  if (prev && prev.mtime === mtime && prev.gmMtime === gmMtime) return prev.plan
  const r = await readPlan($, filter)
  if (gen !== planGen) return r.ok ? r.plan : prev?.plan ?? null
  if (!r.ok) {
    planCache = { key, mtime: -1, gmMtime: -1, plan: prev?.plan ?? null, error: r.error }
    await writeGoal($, gen, 'file', fileLabel(filter), planCache.plan, planCache.error)
    return planCache.plan
  }
  planCache = { key, mtime, gmMtime, plan: r.plan }
  await writeGoal($, gen, 'file', fileLabel(filter), r.plan)
  if (prev?.plan && gen === planGen) {
    const flips = planFlips(prev.plan, r.plan, await $.clock.now())
    if (gen !== planGen) return r.plan
    await addLog($, flips)
    noteTaskFlips(flips)
  }
  return r.plan
}

// A source held in memory (a reported list, a plan-mode plan): no file to stat, the goal from its plan.
async function loadInMemory($, gen: number, inputs: PlanInputs, tag: SourceTag): Promise<Plan> {
  const plan = sourcePlan(inputs, tag)!
  const label = goalLabel(inputs, tag, inputs.labels[tag])
  const key = 'src:' + tag + ':' + label + ':' + JSON.stringify(plan)
  if (planCache && planCache.key === key && planCache.plan) return planCache.plan
  if (gen !== planGen) return plan
  planCache = { key, mtime: -1, gmMtime: -1, plan }
  await writeGoal($, gen, tag, label, plan)
  return plan
}

// The active source changed to an in-memory one or to none (an approval, a report, an untrack that
// reveals a lower source): every agent stays and is re-matched to its plan (SPEC 4.1).
// `retire`: new work begins (an approval, a new report list), so the finished agents of the earlier
// work are kept out of the new plan (agents.ts repinAgents).
async function rematchAgents($, inputs: PlanInputs, retire = false): Promise<void> {
  const tag = activeSource(inputs)
  const plan = sourcePlan(inputs, tag)
  await applyAgents($, (agents) => (agents.length === 0 ? { agents, log: [], changed: false } : repinAgents(agents, { plan, temporal: isTemporal(tag) }, { keepFinished: true, retire })))
}

// What a newly seen agent is matched against (5.3): the plan drawn now, and whether the source
// associates by its one partial task.
async function matchContext($): Promise<{ plan: Plan | null; temporal: boolean }> {
  const inputs = await readInputs($)
  return { plan: await currentPlan($, inputs), temporal: isTemporal(activeSource(inputs)) }
}

async function stallTick($): Promise<void> {
  const at = await $.clock.now()
  await applyAgents($, (agents) => tick(agents, { at, stallMs, startMs }))
  let rows: Array<{ id: string; status: string; name?: string }> = []
  try {
    rows = (await $.agent.list()).map((x) => ({ id: x.id, status: x.status, name: x.name }))
  } catch {
    rows = []
  }
  if (rows.length > 0) await applyAgents($, (agents) => reconcileList(agents, rows, at))
  // The ledger also takes spend that no turn event announces (background calls); read it here too.
  await measureUsage($, false)
}

// Starts the agent timers: the 15 s stall timer and the 2 s plan poll.
function startTracking($): void {
  for (const t of trackingTimers) t.cancel()
  trackingTimers = [
    $.clock.every(15_000, () => {
      void guarded($, 'stall timer', () => stallTick($))
    }),
    $.clock.every(2000, () => {
      void guarded($, 'plan poll', () => pollTick($))
    }),
  ]
}

async function startBand($): Promise<void> {
  themeTicks = 0
  themeCfg = undefined
  await refreshTheme($)
}

// Nothing to draw: no plan or report pinned and no agents tracked.
async function isQuiet($): Promise<boolean> {
  return activeSource(await readInputs($)) === null && (await read($, agentsAtom)).length === 0
}

// Every fifth 2 s tick: whether skins was enabled or disabled; stat the skins store file (and, once
// there is something to draw, the theme file); re-read the theme when any of them moved.
async function themeTick($): Promise<void> {
  const quiet = await isQuiet($)
  const entry = await skinsInstalled($)
  if (themeSig(entry) !== themeWatch.sig) themeDirty = true
  if (wantSkins(themeMode, entry)) {
    if (themeWatch.store === undefined) {
      // No store file was found at the last read; a listing is the stat.
      const cfg = await configDir($)
      const found = (await tryList($, cfg + '/plugins/store')).some((x) => storeRe(entry.marketplace).test(x.name))
      if (found) themeDirty = true
    } else if ((await mtimeOf($, themeWatch.store)) !== themeWatch.storeMtime) {
      themeDirty = true
    }
    if (!quiet && !themeDirty && themeWatch.file !== undefined && (await mtimeOf($, themeWatch.file)) !== themeWatch.fileMtime) themeDirty = true
  }
  if (themeDirty && !quiet) await refreshTheme($)
}

// The 2 s tick: the plan poll, and on every fifth tick the theme check.
async function pollTick($): Promise<void> {
  await currentPlan($)
  themeTicks++
  if (themeTicks % THEME_EVERY_TICKS === 0) {
    await guarded($, 'theme', () => themeTick($))
    await guarded($, 'roles', () => rolesTick($))
  }
}

// ---- M4: the pane and the expanded band ------------------------------------------------------
// Pure trees and rows live in pane.tsx; these top-level functions take `$` and do the calling.

const PANE_ID = 'headway'
const PANE_REDRAW_MS = 5000
let paneTimer: { cancel: () => void } | undefined
let compactAt = 70

const FALLBACK_THEME: Theme = buildTheme({ name: 'noir', icons: 'unicode', file: null, light: false })

// A press must not reject: a failed write is dropped, the pane stays as it was.
async function safely(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch {
    // nothing to tell the person; the next redraw shows the true state
  }
}

// A hook body or a timer callback never rejects: a fault goes to the debug log, named by where it
// happened, and the work is dropped.
function fault($, where: string, err: unknown): void {
  try {
    $.ui.log('headway: ' + where + ': ' + (err instanceof Error ? err.message : String(err)), { to: 'debug' })
  } catch {
    // nowhere left to tell
  }
}

async function guarded($, where: string, work: () => unknown): Promise<void> {
  try {
    await work()
  } catch (err) {
    fault($, where, err)
  }
}

async function paneView($, columns: number): Promise<{ theme: Theme; data: PaneData }> {
  const theme = (await read($, themeAtom)) ?? FALLBACK_THEME
  const goal = await read($, goalAtom)
  const agents = await read($, agentsAtom)
  const data: PaneData = {
    columns,
    ascii: theme.icons === 'ascii',
    now: await $.clock.now(),
    ui: await read($, uiAtom),
    goal: goal === null ? null : { ...goal, note: await goalNote($, goal) },
    tree: buildTree(planCache?.plan ?? null, agents, await $.clock.now()),
    agents,
    log: await read($, logAtom),
    usage: await read($, usageAtom),
    compactAt,
  }
  return { theme, data }
}

async function goalNote($, goal: { error?: string }): Promise<'unreadable' | undefined> {
  return goal.error !== undefined ? 'unreadable' : undefined
}

// A pane the person opens by command is placed; one opened unasked below 110 columns waits, and the
// band then draws the pane body (8.1).
async function paneWaiting($): Promise<boolean> {
  try {
    const mine = (await $.ui.panes()).find((p) => p.id === PANE_ID)
    return mine !== undefined && mine.isPlaced === false
  } catch {
    return false
  }
}

async function rereadPlan($): Promise<void> {
  if (planCache) planCache = { ...planCache, mtime: -2 }
  await currentPlan($)
  $.ui.invalidate('ui.render')
}

async function openPane($, tab?: Tab): Promise<void> {
  await update($, uiAtom, (u) => ({ ...u, tab: tab ?? u.tab, opened: true }))
  await $.ui.open({ id: PANE_ID, title: 'Headway', focus: true, rows: 18, columns: 72 })
  paneTimer?.cancel()
  // Elapsed times and "step 14m ago" age without any event; redraw while the pane is up.
  paneTimer = $.clock.every(PANE_REDRAW_MS, () => {
    try {
      $.ui.invalidate('ui.render')
    } catch (err) {
      fault($, 'pane redraw', err)
    }
  })
}

async function closePane($): Promise<void> {
  await $.ui.close({ id: PANE_ID })
}

function paneHandlers($): Handlers {
  const set = (fn: (u: UiState) => UiState) => safely(update($, uiAtom, fn).then(() => $.ui.invalidate('ui.render')))
  return {
    tab: (tab) => set((u) => ({ ...u, tab })),
    toggle: (key, open) => set((u) => ({ ...u, open: { ...u.open, [key]: open } })),
    expandAll: (keys, open) => set((u) => ({ ...u, open: { ...u.open, ...Object.fromEntries(keys.map((k) => [k, open])) } })),
    hideDone: () => set((u) => ({ ...u, hideDone: !u.hideDone })),
    reread: () => safely(rereadPlan($)),
    close: () => safely(closePane($)),
  }
}

async function drawPane($, e, next) {
  if (e.requestId !== PANE_ID) return next(e)
  const ui = $.ui.resolve(e)
  const view = await paneView($, e.props.bodyColumns)
  return paneTree(ui, view.theme, view.data, paneHandlers($))
}

// ---- M7: the model tool, the /headway command, persistence ------------------------------------
// The tool's `track` and the command's `track` share `pin`; `status` and the tool's `state` share
// `stateText`. Every write to filter, report, agents or log schedules a save (`scheduleSave`).

const ARGUMENT_HINT = '[track <path> ["section"] [column=..|check=..|auto] [partial=<column>] [groups=<path>] | untrack | plan|agents|log|usage | close | status | band off|on]'
const USAGE = 'usage: /headway ' + ARGUMENT_HINT

// Pins a filter: refused unless the plan reads and parses. The filter already pinned only re-reads
// the plan and logs `re-read`. Another filter replaces the old one, clears the focus and the compact
// hint's boundary, keeps the agents still at work re-matched to the new plan, drops the finished
// ones, and adds the pin entry to the log. The other sources keep their data under it (SPEC 4.1).
// The same plan pinned again takes the new pin's bounds (SPEC 14): the user's pin lifts Claude's.
async function pin($, filter: Filter, typed?: Typed): Promise<string> {
  const r = await readPlan($, filter, typed)
  if (!r.ok) return 'refused: ' + r.error
  const at = await $.clock.now()
  const before = await readInputs($)
  if (sameFilter(before.filter, filter)) {
    if (JSON.stringify(before.filter!.bounds) !== JSON.stringify(filter.bounds)) {
      remember({ filter: await update($, filterAtom, () => filter) })
      await safely(scheduleSave($))
    }
    // a new generation that keeps the last parse, so a changed plan still logs its flips
    planGen++
    planLoading = undefined
    if (planCache) planCache = { ...planCache, mtime: -2 }
    await addLog($, [rereadEntry(filter, at)])
    await currentPlan($, { ...before, filter })
    return trackLine(filter, r.plan)
  }
  boundary = START
  remember({ filter: await update($, filterAtom, () => filter) })
  await update($, focusAtom, () => null)
  resetPlan()
  remember({ agents: await update($, agentsAtom, (agents) => repinAgents(agents, { plan: r.plan }).agents) })
  remember({ log: await update($, logAtom, (log) => appendLog(log, [pinEntry(filter, at)])) })
  await safely(scheduleSave($))
  await currentPlan($, { ...(await readInputs($)), filter })
  return trackLine(filter, r.plan)
}

// Unpins the file only: a lower source with data shows next, its agents re-matched to it (SPEC 4.1).
async function unpin($): Promise<string> {
  remember({ filter: await update($, filterAtom, () => null) })
  await update($, focusAtom, () => null)
  resetPlan()
  const inputs = await readInputs($)
  await rematchAgents($, inputs)
  await addLog($, [unpinEntry(await $.clock.now())])
  await currentPlan($, inputs)
  return 'untracked'
}

// The step ids of the plan-mode plan when it is the source drawn (and, with `open`, not finished); none otherwise.
async function planModeIds($, open = false): Promise<string[]> {
  const inputs = await readInputs($)
  if (activeSource(inputs) !== 'plan' || !inputs.planMode || (open && inputs.planMode.doneAt !== undefined)) return []
  return inputs.planMode.steps.map((s) => s.id)
}

async function reportTasks($, input: Record<string, unknown>): Promise<string> {
  const parsed = parseReport(input)
  if (!parsed.ok) return 'refused: ' + parsed.error
  if (parsed.kind === 'updates') return reportUpdates($, parsed.updates)
  const ids = handoff.fresh ? await planModeIds($, true) : []
  if (ids.length > 0) return 'refused: a plan from plan mode is tracked; send updates with its ids: ' + idsText(ids)
  const report = withDoneAt(parsed.report, parsed.report.tasks, await $.clock.now())
  let fresh = true
  remember({
    report: await update($, reportAtom, (old) => {
      fresh = isNewWork(old, report)
      return report
    }),
  })
  await startSource($, 'reported')
  resetPlan()
  const inputs = await readInputs($)
  // under a pinned file the report waits beneath it; otherwise the agents follow the new list, and
  // a list that is new work rather than a re-send retires the finished ones (4.1)
  if (activeSource(inputs) !== 'file') await rematchAgents($, inputs, fresh)
  await currentPlan($, inputs)
  const text = 'reported ' + parsed.report.tasks.length + ' tasks'
  await addLog($, [{ at: await $.clock.now(), kind: 'report', ref: '', detail: text + (parsed.report.title ? ' § ' + parsed.report.title : '') }])
  await guarded($, 'invalidate', () => $.ui.invalidate('ui.render'))
  return text
}

// `report` updates (SPEC 4.3): the tasks of the active reported or plan-mode list take their new
// status. The agents are not re-matched (5.3: never when a status changes); the flips are logged.
async function reportUpdates($, updates: StatusUpdate[]): Promise<string> {
  handoff.fresh = false // Claude is sending updates: the handoff has reached it (4.4)
  const before = await readInputs($)
  const tag = activeSource(before)
  const at = await $.clock.now()
  let out: ReturnType<typeof applyReport> = applyReport(before, updates, at)
  if (!out.ok) return 'refused: ' + out.error
  // the flips are this call's own: from the list as the reducer found it to what it wrote, so an
  // overlapping call's changes are not logged twice
  let from: PlanInputs = before
  let to: PlanInputs = before
  if (tag === 'reported') {
    const report = await update($, reportAtom, (cur) => {
      from = { ...before, report: cur }
      if (cur === null) return cur
      out = applyReport(from, updates, at)
      return out.ok ? out.sources.report : cur
    })
    remember({ report })
    to = { ...before, report }
  } else {
    const kept = await update($, planAtom, (cur) => {
      from = { ...before, planMode: cur }
      if (cur === null) return cur
      out = applyReport(from, updates, at)
      return out.ok && out.sources.planMode ? { ...out.sources.planMode, ...(cur.text !== undefined ? { text: cur.text } : {}) } : cur
    })
    remember({ plan: withoutText(kept) })
    to = { ...before, planMode: kept }
  }
  if (!out.ok) return 'refused: ' + out.error
  resetPlan()
  await currentPlan($, await readInputs($))
  await noteSourceFlips($, from, to)
  await guarded($, 'invalidate', () => $.ui.invalidate('ui.render'))
  return updatedLine(out.applied, out.unknown)
}

async function focusTask($, taskId: unknown): Promise<string> {
  const id = typeof taskId === 'string' ? taskId.trim() : ''
  const plan = await currentPlan($)
  const known = plan !== null && id !== '' && (plan.tasks.some((t) => t.id === id) || plan.groups.some((g) => g.id === id))
  if (!known) return 'unknown task: ' + id
  await update($, focusAtom, () => id)
  return 'current task: ' + id
}

async function stateText($, logEntries: unknown): Promise<string> {
  const inputs = await readInputs($)
  const plan = await currentPlan($, inputs)
  const agents = await read($, agentsAtom)
  return stateBlock({
    source: activeSource(inputs),
    filter: inputs.filter,
    goal: await read($, goalAtom),
    current: bandCurrent(plan, agents, await read($, focusAtom), { partialSource: isTemporal(activeSource(inputs)) }).current,
    ...(activeSource(inputs) === 'plan' && plan ? { steps: plan.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })) } : {}),
    agents,
    log: await read($, logAtom),
    usage: await currentUsage($),
    now: await $.clock.now(),
    logEntries: typeof logEntries === 'number' && Number.isFinite(logEntries) ? Math.floor(logEntries) : 10,
  })
}

// A pin made on Claude's behalf (SPEC 14), through the model tool, lands only inside the project: the
// plan file and the group map must land, every link followed, under the session directory's own real
// path, since what headway reads flows back to Claude through `state` outside Claude Code's
// permissions. A path that does not stat keeps the plain refusal; one that stats without a real path
// is outside. Answers the filter with its bounds, which every later read of the pin holds to
// (readText), or the refusal.
async function boundedFilter($, filter: Filter, typed: Typed): Promise<{ filter: Filter } | { refusal: string }> {
  const root = await realPathOf($, await $.session.cwd())
  const paths: Array<['file' | 'groupMap', string, string]> = [['file', filter.file, typed.file]]
  if (filter.groupMap) paths.push(['groupMap', filter.groupMap, typed.groupMap ?? filter.groupMap])
  const bounds: { file?: string; groupMap?: string } = {}
  for (const [key, path, shown] of paths) {
    let real: string | undefined
    try {
      real = (await $.fs.stat(path, { resolve: true })).realPath
    } catch (err) {
      return { refusal: 'refused: ' + readFailure(err, shown) }
    }
    const bound = real !== undefined && root !== undefined && insideDir(real, root) ? root : undefined
    if (bound === undefined) {
      const again = typed.file + (filter.groupMap ? ' groups=' + (typed.groupMap ?? filter.groupMap) : '')
      return { refusal: 'refused: outside the project; ask the user to run /headway track ' + clean(again) }
    }
    bounds[key] = bound
  }
  return { filter: { ...filter, bounds: { file: bounds.file!, ...(bounds.groupMap !== undefined ? { groupMap: bounds.groupMap } : {}) } } }
}

async function runTool($, e): Promise<string> {
  switch (e.action) {
    case 'track': {
      const parsed = filterFromInput(e, await $.session.cwd())
      if (!parsed.ok) return 'refused: ' + parsed.error
      // the approved plan-mode file (4.4) is not read: while its plan is drawn and unfinished the plan
      // came with the approval; otherwise it is a path like any other, outside the project
      const ids = await planModeIds($, true)
      if (ids.length > 0 && isPlanModeFile(parsed.filter.file, handoff.file)) {
        return 'already tracking this plan from plan mode; use report updates with ids: ' + idsText(ids)
      }
      const bounded = await boundedFilter($, parsed.filter, parsed.typed)
      if ('refusal' in bounded) return bounded.refusal
      return pin($, bounded.filter, parsed.typed)
    }
    case 'state':
      return stateText($, e.logEntries)
    case 'report':
      return reportTasks($, e)
    case 'focus':
      return focusTask($, e.taskId)
    case 'untrack':
      return unpin($)
    default:
      return 'refused: unknown action: ' + String(e.action)
  }
}

async function paneIsOpen($): Promise<boolean> {
  try {
    return (await $.ui.panes()).some((p) => p.id === PANE_ID)
  } catch {
    return (await read($, uiAtom)).opened
  }
}

async function setBand($, enabled: boolean): Promise<void> {
  bandOff = !enabled
  await $.store.set(BAND_PREF, enabled)
  $.ui.invalidate('ui.render')
}

// `typed`: the person ran it at the prompt (origin `composer`, SPEC 9.2). Any other run (a message a
// model wrote, a relay, a notification, another plugin's `$.command.run`, a scheduled prompt, a run
// with no stamp) may only read: `track`, `untrack` and `band on|off` are refused before they touch
// anything; the pane, its tabs and `status` answer as usual.
const FROM_PROMPT = 'refused: run this from the prompt'

async function runCommand($, args: string, typed: boolean) {
  const [word, ...more] = args.split(/\s+/)
  const rest = args.slice(word.length).trim()
  if (word === '') {
    if (await paneIsOpen($)) await closePane($)
    else await openPane($)
    return {}
  }
  const mutating = word === 'track' || (word === 'untrack' && rest === '') || (word === 'band' && more.length === 1 && (rest === 'off' || rest === 'on'))
  if (mutating && !typed) return { text: FROM_PROMPT }
  if (word === 'track') {
    const parsed = parsePinArgs(rest, await $.session.cwd())
    if (!parsed.ok) return { text: 'refused: ' + parsed.error }
    return { text: await pin($, parsed.filter, parsed.typed) }
  }
  if (word === 'untrack' && rest === '') return { text: await unpin($) }
  if (word === 'status' && rest === '') return { text: await stateText($, undefined) }
  if (word === 'close' && rest === '') {
    await closePane($)
    return {}
  }
  if (isTab(word) && rest === '') {
    await openPane($, word)
    return {}
  }
  if (word === 'band' && more.length === 1 && (rest === 'off' || rest === 'on')) {
    await setBand($, rest === 'on')
    return {}
  }
  return { text: USAGE }
}

// One save in flight at most: the first change arms a one-second timer, later changes replace the
// pending record, the timer writes the newest. The record is read at the change, under the id of
// that moment, so a save that fires after /clear or /resume reset `$.state` still writes the old
// session's data under the old id.
let saveTimer: { cancel: () => void } | undefined
let pendingSave: { id: string; record: SavedSession; seq: number } | undefined
let saveSeq = 0
// What the store holds for the session last written, serialised without its save time: a record
// equal to it is not written again.
let lastWritten: { id: string; text: string } | undefined

// The plan-mode plan as it is saved: its parsed steps, not its text (SPEC 4.4).
function withoutText(p: PlanModeState | null): PlanMode | null {
  if (!p) return null
  const { text: _text, ...rest } = p
  return rest
}

// The values of filter, report, plan, label, agents and log written since the session's state was last loaded,
// newest per atom. Every get of one dispatch reads the moment it began, so a save scheduled right
// after a write would read the value from before it; each write hands its result here instead, and
// the save reads an atom only when nothing wrote it since.
type Saved = Omit<SavedSession, 'savedAt'>
let written: Partial<Saved> = {}

function remember(values: Partial<Saved>): void {
  written = { ...written, ...values }
}

async function scheduleSave($): Promise<void> {
  const seq = ++saveSeq
  const known = written
  const id = await $.session.id()
  const record: SavedSession = {
    filter: 'filter' in known ? known.filter ?? null : await read($, filterAtom),
    report: 'report' in known ? known.report ?? null : await read($, reportAtom),
    plan: 'plan' in known ? known.plan ?? null : withoutText(await read($, planAtom)),
    label: 'label' in known ? known.label ?? {} : (await read($, labelAtom)) ?? {},
    prompt: 'prompt' in known ? known.prompt ?? null : await read($, promptAtom),
    tasks: 'tasks' in known ? known.tasks ?? null : await read($, tasksAtom),
    agents: known.agents ?? (await read($, agentsAtom)),
    log: known.log ?? (await read($, logAtom)),
    savedAt: 0,
  }
  if (pendingSave && pendingSave.seq > seq) return
  pendingSave = { id, record, seq }
  if (saveTimer) return
  saveTimer = $.clock.after(SAVE_MS, () => {
    saveTimer = undefined
    void safely(flushSave($))
  })
}

async function flushSave($): Promise<void> {
  saveTimer?.cancel()
  saveTimer = undefined
  const p = pendingSave
  pendingSave = undefined
  if (!p) return
  const record = capSession(p.record)
  const text = recordText(record)
  if (lastWritten && lastWritten.id === p.id && lastWritten.text === text) return
  await $.store.set(sessionKey(p.id), { ...record, savedAt: await $.clock.now() })
  lastWritten = { id: p.id, text }
}

// The session whose state the atoms hold: read at session start, moved by each reload. On /clear
// it still names the session being left, whose record the new id starts from.
let sessionNow: string | undefined

// /clear, /resume and /branch reset `$.state`: copy the session's record back, keyed by
// `e.session_id` (inside this hook `$.session.id()` may still name the session left behind). With
// no record under that id, /clear and /branch start from the record of the session being left,
// copied under the new id; a resume starts empty. Never another session's record.
async function reloadSession($, sessionId: string, source: string): Promise<void> {
  await flushSave($)
  // the reset state starts from defaults (or the record below), not from the last session's writes
  written = {}
  handoff = { fresh: false }
  const leaving = sessionNow
  sessionNow = sessionId
  let saved = asSaved(await $.store.get(sessionKey(sessionId)))
  if (!saved) {
    if (source === 'resume') await resumeTasks($, sessionId)
    if (source === 'resume' || leaving === undefined || leaving === sessionId) return
    saved = asSaved(await $.store.get(sessionKey(leaving)))
    if (!saved) return
    if (source === 'clear') saved = cleared(saved)
    await $.store.set(sessionKey(sessionId), { ...saved, savedAt: await $.clock.now() })
  }
  const record = source === 'clear' ? cleared(saved) : saved
  // A resume rebuilds the list from the task files; an emptied directory (every task completed) keeps the saved one.
  const tasks = source === 'resume' ? (await taskFilesList($, sessionId)) ?? record.tasks : record.tasks
  // An agent whose last sign of life predates this process cannot be reached by any event now.
  const at = await $.clock.now()
  const settled = settleRestored(record.agents, { at, aliveSince: aliveSince ?? at })
  resetPlan()
  remember({
    filter: await update($, filterAtom, () => record.filter),
    report: await update($, reportAtom, () => record.report),
    plan: withoutText(await update($, planAtom, () => record.plan)),
    label: await update($, labelAtom, () => record.label),
    prompt: await update($, promptAtom, () => record.prompt),
    tasks: await update($, tasksAtom, () => tasks),
    agents: await update($, agentsAtom, () => settled.agents),
    log: await update($, logAtom, () => appendLog(record.log, settled.log)),
  })
  await currentPlan($, { filter: record.filter, report: record.report, planMode: record.plan, tasks, phases: phaseRun(settled.agents), labels: record.label, prompt: record.prompt })
  await refreshTheme($)
}

// The plan dialog's "clear context" (SPEC 12): the plan approved in the turn just left, within
// CARRY_MS, starts the new conversation with its label, fresh through that conversation's first turn.
async function carryPlan($, carry: NonNullable<typeof planBeforeClear>): Promise<void> {
  if ((await $.clock.now()) - carry.at > CARRY_MS) return
  const labels = await update($, labelAtom, (cur) => startLabel(cur ?? {}, 'plan', carry.label))
  remember({ label: labels })
  const steps = await installPlanMode($, carry.text, carry.file, labels, !carry.approved)
  if (steps > 0) handoff.awaitStart = true
  await safely(scheduleSave($))
}

// A new conversation after /clear (SPEC 12): the prompt-driven sources (the reported list, the
// plan-mode plan, the task list, their labels and the newest prompt) and the log belong to the one
// left; the pinned file and the agents carry over.
function cleared(record: SavedSession): SavedSession {
  return { ...record, report: null, plan: null, tasks: null, label: {}, prompt: null, log: [] }
}

// The task list of `<configDir>/tasks/<session_id>/*.json` (SPEC 4.5); null when the directory has no task file.
async function taskFilesList($, sessionId: string): Promise<TaskItem[] | null> {
  const dir = (await configDir($)) + '/tasks/' + sessionId
  const all = (await tryList($, dir)).filter((f) => f.kind === 'file' && f.name.endsWith('.json')).map((f) => f.name)
  if (all.length > TASK_FILES_MAX) fault($, dir, new Error(all.length + ' task files, over ' + TASK_FILES_MAX + '; the rest are not read'))
  const names = all.slice(0, TASK_FILES_MAX)
  const texts = await Promise.all(names.map((n) => tryReadBounded($, dir + '/' + n, TASK_FILE_MAX)))
  return rebuildFromFiles(texts.filter((t): t is string => t !== undefined))
}

// A resume with no saved record: the task files alone give the list.
async function resumeTasks($, sessionId: string): Promise<void> {
  const tasks = await taskFilesList($, sessionId)
  if (tasks === null) return
  resetPlan()
  remember({ tasks: await update($, tasksAtom, () => tasks) })
  await currentPlan($, await readInputs($))
}

// When this process (or this module, after a hot reload) started: a reloaded agent with no sign of
// life since then belongs to another process (settleRestored).
let aliveSince: number | undefined

// At session start: drop records saved more than 14 days ago, and read the band pref.
async function startStore($): Promise<void> {
  const now = await $.clock.now()
  aliveSince ??= now
  try {
    sessionNow = await $.session.id()
  } catch {
    // unknown: a /clear before the first save then starts empty
  }
  for (const key of await $.store.keys()) {
    if (isSessionKey(key) && isStale(await $.store.get(key), now)) await $.store.delete(key)
  }
  const pref = await $.store.get(BAND_PREF)
  bandOff = pref === undefined || pref === null ? bandDefaultOff : pref === false
}

async function drawBand($, e, next) {
  const goal = await read($, goalAtom)
  const theme = await read($, themeAtom)
  const agents = await read($, agentsAtom)
  const focus = await read($, focusAtom)
  const source = activeSource(await readInputs($))
  const pinned = source !== null
  const live = agents.filter((a) => isShown(a) && !isFinished(a.status)).length
  const draws = bandVisible({ hasSurvey: e.props.hasSurvey === true, pinned, agents: live, off: bandOff })
  // pinned but not yet parsed: nothing to draw until the first load writes the goal
  if (!draws || (pinned && goal === null) || theme === null) return next(e)
  const ui = $.ui.resolve(e)
  const below = await next(e)
  // Line 2 from the agents atom and the poll's parse (module memory; a re-parse that changes the
  // counts writes `goal`, and every agent event writes `agents`; both redraw this site).
  const line2 = bandCurrent(planCache?.plan ?? null, agents, focus, { partialSource: isTemporal(source) })
  const lines = bandLines({
    columns: e.props.bodyColumns,
    ascii: theme.icons === 'ascii',
    goal: goal === null ? null : { ...goal, note: goal.error !== undefined ? 'unreadable' : undefined },
    current: line2.current,
    allDone: line2.allDone,
    marks: line2.marks,
    line3: line3Data({ usage: await read($, usageAtom), threshold: compactAt, log: await read($, logAtom) }),
  })
  if (!(await paneWaiting($))) return bandTree(ui, theme, lines, below)
  // The pane is open but unplaced: the band carries its body, under the lines (8.1).
  const view = await paneView($, e.props.bodyColumns)
  const body = bandBody(ui, theme, view.data, paneHandlers($), Math.max(0, e.props.maxRows - 1 - lines.length))
  return bandTree(ui, theme, lines, ui.Box({ flexDirection: 'column', children: [body, below] }))
}

// headway's own tool in the transcript (SPEC 10.4): ToolUse is one dim line with the result folded in,
// ToolResult draws nothing. Any other tool, or quietToolRows off, keeps the stock row.
async function drawQuietRow($, e, next) {
  if (!quietOn || e.props.tool !== TOOL_NAME) return next(e)
  const theme = (await read($, themeAtom)) ?? FALLBACK_THEME
  const ui = $.ui.resolve(e)
  if (e.component === 'ToolResult') return ui.Box({})
  const segs = quietSegs({ input: e.props.input, output: e.props.output, isErrored: e.props.isErrored === true, isRunning: e.props.isRunning === true, ascii: theme.icons === 'ascii' })
  return quietTree(ui, theme, segs)
}

// The band above the prompt and the pane: one ui.render hook for both sites.
function registerRender(on) {
  on('ui.render', { component: ['AbovePrompt', 'Pane'] }, async ($, e, next) => {
    try {
      if (e.component === 'Pane') return await drawPane($, e, next)
      return await drawBand($, e, next)
    } catch (err) {
      fault($, 'ui.render', err)
      return next(e)
    }
  })
}

// The transcript rows of headway's own tool: the engine runs this hook for that tool's rows alone (a
// props matcher). With quietToolRows off it passes every row on (drawQuietRow); it is registered
// either way, since a registration under a condition is one static analysis cannot read.
function registerQuietRows(on) {
  on('ui.render', { component: ['ToolUse', 'ToolResult'], props: { tool: TOOL_NAME } }, async ($, e, next) => {
    try {
      return await drawQuietRow($, e, next)
    } catch (err) {
      fault($, 'ui.render', err)
      return next(e)
    }
  })
}

// The pane closed (by `q`, a command, Ctrl+X X, or an unload): clear the open flag and the redraw timer.
function registerPaneClose(on) {
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE_ID) {
      paneTimer?.cancel()
      paneTimer = undefined
      await guarded($, 'ui.close', () => update($, uiAtom, (u) => ({ ...u, opened: false })))
    }
    return result
  }).catch(async ($, e, next) => next(e))
}

// The head of each waiting spawn's prompt, by record id, until its agent is joined (agents.ts
// joinSpawn). Memory only: after a restart a waiting spawn joins by its list row or its Agent result.
const spawnPrompts = new Map<string, string>()

// The opening of each agentId's transcript as read for a join (its first JOIN_TEXT characters, or
// undefined when it was not readable): read once per agent, though the agent may ask again (its
// provisional record expired, or its completion comes before any spawn claimed it). Memory only,
// the oldest dropped past OPENINGS_MAX.
const openings = new Map<string, string | undefined>()
const OPENINGS_MAX = 32

async function openingOf($, agentId: string): Promise<string | undefined> {
  if (openings.has(agentId)) return openings.get(agentId)
  let text: string | undefined
  try {
    const messages = await $.session.messages({ agentId })
    if (Array.isArray(messages)) text = messages.find((m) => m.role === 'user' && typeof m.text === 'string')?.text
  } catch {
    // not readable: the list row, or the step's model and effort, decides
  }
  if (openings.size >= OPENINGS_MAX) openings.delete(openings.keys().next().value as string)
  openings.set(agentId, text?.slice(0, JOIN_TEXT))
  return text?.slice(0, JOIN_TEXT)
}

function prunePrompts(agents: AgentRecord[]): void {
  for (const id of spawnPrompts.keys()) {
    if (!agents.some((a) => a.id === id && a.agentId === undefined)) spawnPrompts.delete(id)
  }
}

// The spawn is recorded from the event alone, before the engine starts the agent: what the engine
// answers is not read (the hook passes the spawn on as it came), so the record has no agentId until
// the agent's first step or its completion joins it (joinHints), or its Agent call's result does.
async function recordSpawn($, e): Promise<void> {
  const inputs = await readInputs($)
  const plan = await currentPlan($, inputs)
  const temporal = isTemporal(activeSource(inputs))
  const at = await $.clock.now()
  const dispatchWarnings = pendingWarnings.get(e.tool_use_id)
  pendingWarnings.delete(e.tool_use_id)
  const head = promptHead(e.prompt)
  if (head !== '') spawnPrompts.set(spawnRecordId({ toolUseId: e.tool_use_id, workflow: e.workflow }), head)
  // The focus action holds the current task until the next spawn.
  if ((await read($, focusAtom)) !== null) await update($, focusAtom, () => null)
  await applyAgents($, (current) => {
    // A Workflow's agents spawn while its tool call runs: the run id binds its planned calls here
    // as well as when the call returns, whichever comes first.
    const agents = e.workflow ? bindRun(current, e.tool_use_id, e.workflow.runId).agents : current
    return spawnAgent(
      agents,
      {
        at,
        toolUseId: e.tool_use_id,
        description: e.description,
        subagentType: e.subagentType,
        prompt: e.prompt,
        name: e.name,
        requestedModel: e.model,
        workflow: e.workflow ? { runId: e.workflow.runId, agentIndex: e.workflow.agentIndex } : undefined,
        warnings: dispatchWarnings,
      },
      { plan, temporal, roles: routerOn ? roles : undefined },
    )
  })
  await hideCompactHint($)
}

// What joins a new agentId to its waiting spawn (agents.ts joinSpawn): the opening of the agent's
// transcript, its agent-list row, and the step's model and effort (a workflow agent has neither a
// readable transcript nor a row). Undefined when the agentId already has its record.
async function joinHints($, agentId: string, step: { model?: string; effort?: string | number } = {}): Promise<JoinHints | undefined> {
  const known = 'agents' in written ? written.agents ?? [] : await read($, agentsAtom)
  if (known.some((a) => a.agentId === agentId)) return undefined
  const text = await openingOf($, agentId)
  let row: { description: string; type: string } | undefined
  try {
    const found = (await $.agent.list()).find((x) => x.id === agentId)
    if (found) row = { description: found.description, type: found.type }
  } catch {
    // no row
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(row ? { row } : {}),
    prompts: Object.fromEntries(spawnPrompts),
    ...(step.model !== undefined ? { model: step.model } : {}),
    ...(step.effort !== undefined ? { effort: String(step.effort) } : {}),
  }
}

function registerTracking(on) {
  // Observed, never answered: the spawn is recorded from the event and passed on as it came; the
  // agent's first step joins its agentId to the record (joinHints).
  on('agent.spawn', async ($, spawnEvent, passOn) => {
    await guarded($, 'agent.spawn', () => recordSpawn($, spawnEvent))
    return passOn(spawnEvent)
  }).catch(async ($, spawnEvent, passOn) => {
    return passOn(spawnEvent)
  }) // tracking never gates a spawn: fail open

  // Main loop vs subagent: a subagent's step carries `agentId`, the main loop's does not.
  // The step-start bookkeeping runs beside the model call, not before it; it is settled before the
  // step-end write, so the order of the two writes holds.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    const started = agentId
      ? guarded($, 'turn.step', async () => {
          const at = await $.clock.now()
          // a previous agent that resumes is matched afresh against the plan drawn now (5.3)
          const match = (await read($, agentsAtom)).some((a) => a.agentId === agentId && a.previous) ? await matchContext($) : undefined
          const join = await joinHints($, agentId, { model: e.model, effort: e.effort })
          await applyAgents($, (agents) => stepStart(agents, { at, agentId, model: e.model, effort: e.effort, roles: routerOn ? roles : undefined, match, join }))
        })
      : undefined
    let result
    try {
      result = yield* next(e)
    } finally {
      await started
    }
    await guarded($, 'turn.step', async () => {
      if (agentId) {
        const at = await $.clock.now()
        await applyAgents($, (agents) => stepEnd(agents, { at, agentId, usage: result.usage }))
      } else {
        await measureUsage($, false)
      }
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const agentId = e.agentId
    await guarded($, 'turn.complete', async () => {
      if (agentId) {
        const at = await $.clock.now()
        const join = await joinHints($, agentId)
        const agents = await applyAgents($, (list) =>
          completeAgent(list, { at, agentId, reason: e.reason, answer: e.answer, durationMs: e.durationMs, usage: e.usage, join }),
        )
        noteAgentFinished(agents, agentId)
      } else {
        // the approval's own turn is over (4.4), unless this is the turn a carried plan left behind
        if (!handoff.awaitStart) handoff.fresh = false
        planBeforeClear = undefined
        // A main-loop turn.complete triggers one immediate stat of the plan (SPEC 3.3).
        await currentPlan($)
        await measureUsage($, true)
      }
    })
    return result
  })
}

// ---- P5: role rules from a file (SPEC 7) ----------------------------------------------------
// R3 and R4 judge only the roles `<configDir>/headway-roles.json` names. It is read at session start
// and again when its mtime moves (checked every fifth 2 s tick). A file that does not parse turns
// R3/R4 off, logs one line and toasts once per session; nothing here throws.

let roles: Roles | undefined
let rolesWatch: { mtime?: number } = {}
let rolesToasted = false

async function loadRoles($): Promise<void> {
  const path = (await configDir($)) + '/headway-roles.json'
  rolesWatch = { mtime: await mtimeOf($, path) }
  roles = undefined
  if (!routerOn || rolesWatch.mtime === undefined) return
  const text = await tryReadBounded($, path, ROLES_MAX)
  if (text === undefined) return
  const parsed = parseRoles(text)
  if ('roles' in parsed) {
    roles = parsed.roles
    return
  }
  const line = 'headway: ' + path + ' ignored, R3 and R4 are off (' + parsed.error + ')'
  fault($, 'roles', new Error(line))
  if (rolesToasted) return
  rolesToasted = true
  await $.ui.toast(line)
}

async function startRoles($): Promise<void> {
  rolesToasted = false
  await loadRoles($)
}

async function rolesTick($): Promise<void> {
  const mtime = await mtimeOf($, (await configDir($)) + '/headway-roles.json')
  if (mtime !== rolesWatch.mtime) await loadRoles($)
}

// ---- M5: router warnings (SPEC 5) and Workflow scripts (SPEC 4.2) ---------------------------
// One tool.call hook per matcher: Agent (R1, R3) and Workflow (R2). They warn and never deny or
// rewrite; the note reaches Claude as the result's `context` (Milestone 0 check 3), the user gets a
// log entry, a toast and, through the agent records' `warnings`, the amber mark.

// R1/R3 found at an Agent dispatch, kept until its agent.spawn writes the record (same tool_use_id).
const pendingWarnings = new Map<string, string[]>()

function valueText(v: Value | undefined): string | undefined {
  return v && v.kind !== 'dynamic' ? v.value : undefined
}

async function announce($, found: Warning[], role: string | undefined): Promise<void> {
  const at = await $.clock.now()
  await addLog($, found.map((w) => ({ at, kind: 'warn' as const, ref: w.rule, ...(role ? { role } : {}), detail: warningDetail(w) })))
  try {
    await $.ui.toast(found.map((w) => w.text).join(' '))
  } catch {
    // a toast that fails is not worth the dispatch
  }
}

function withContext(result, found: Warning[]) {
  if (found.length === 0 || ('deny' in result && result.deny)) return result
  return { ...result, context: [...(result.context ?? []), ...found.map((w) => w.text)] }
}

// The model the type's definition file names (SPEC 7, R1), undefined when none is found, readable or
// named. The first definition found decides: the project (the session directory and each parent up to
// the first .git, or the home directory), then the user directory, then the plugin the type is
// prefixed with. A type name that is not made of plain names (format.ts plainName) is looked up
// nowhere, and no directory above home or the filesystem root is read.
interface Definition {
  path?: string // the file that decided, with its mtime; absent when none was found
  mtime?: number
  model?: string
  checkedAt?: number // when a lookup found nothing
}

async function findDefinition($, cwd: string, subagentType: string | undefined, name: string): Promise<Definition> {
  const cfg = await configDir($)
  const chain = projectDirs({ cwd, home: await homeDir($) })
  let gitAt: number | undefined
  for (let n = 0; n < chain.dirs.length; n++) {
    if ((await mtimeOf($, chain.dirs[n] + chain.sep + '.git')) !== undefined) {
      gitAt = n
      break
    }
  }
  const paths = searchDirs(chain, gitAt).map((dir) => [dir, '.claude', 'agents', name + '.md'].join(chain.sep))
  paths.push(cfg + '/agents/' + name + '.md')
  const plugin = definitionPlugin(subagentType)
  if (plugin) {
    const cache = cfg + '/plugins/cache'
    for (const mk of await tryList($, cache)) {
      if (!plainName(mk.name)) continue
      for (const version of await tryList($, cache + '/' + mk.name + '/' + plugin)) {
        if (plainName(version.name)) paths.push(cache + '/' + mk.name + '/' + plugin + '/' + version.name + '/agents/' + name + '.md')
      }
    }
  }
  for (const path of new Set(paths)) {
    const st = await definitionStat($, path)
    if (st === undefined || !(await definitionPlaced($, path, st.real, cfg))) continue
    const text = await tryRead($, st.real!)
    if (text !== undefined) return { path, mtime: st.mtime, model: definitionModel(text) }
  }
  return { checkedAt: await $.clock.now() }
}

// A definition is read only when its path is a regular file of at most 64 KiB; a pipe, a device or a
// huge file counts as no definition (one debug line says so) and the dispatch goes on. The mtime of an
// acceptable file, undefined for a missing path or one rejected. A stat that reports no type is
// trusted as a file unless it is empty, since a pipe or a device reports no size.
const DEFINITION_MAX = 64 * 1024

async function definitionStat($, path: string): Promise<{ mtime: number; real?: string } | undefined> {
  let st: { kind?: string; size?: number; mtimeMs: number; realPath?: string }
  try {
    st = await $.fs.stat(path, { resolve: true })
  } catch {
    return undefined
  }
  const why =
    st.kind !== undefined && st.kind !== 'file'
      ? 'not a regular file (' + st.kind + ')'
      : st.kind === undefined && !(st.size! > 0)
        ? 'not a regular file'
        : st.size! > DEFINITION_MAX
          ? st.size + ' bytes is over ' + DEFINITION_MAX
          : undefined
  if (why === undefined) return { mtime: st.mtimeMs, real: st.realPath }
  try {
    $.ui.log('headway: definition ' + path + ' not read: ' + why, { to: 'debug' })
  } catch {
    // nowhere left to tell
  }
  return undefined
}

// A definition is read only where it lands, every link followed, under the directory it was found in
// or under the config directory (the user's agents and the plugin cache); a link that leads out of
// both is no definition, with one debug line (SPEC 7, 14).
async function definitionPlaced($, path: string, real: string | undefined, cfg: string): Promise<boolean> {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  if (real !== undefined && (await insideAny($, real, [() => dir, () => cfg]))) return true
  try {
    $.ui.log('headway: definition ' + path + ' not read: it lands outside its directory', { to: 'debug' })
  } catch {
    // nowhere left to tell
  }
  return false
}

// What was found, per (session directory, type), for the session: a found file is read again when its
// mtime moves or it goes; a type with no definition is looked up again after 60 seconds.
const NOT_FOUND_RECHECK_MS = 60_000
const definitionMemo = new Map<string, Definition>()

async function definedModel($, subagentType: string | undefined): Promise<string | undefined> {
  try {
    const name = definitionName(subagentType)
    if (name === '') return undefined
    const cwd = await $.session.cwd()
    const key = cwd + '\u0000' + (subagentType ?? '')
    const hit = definitionMemo.get(key)
    if (hit && (hit.path === undefined ? (await $.clock.now()) - (hit.checkedAt ?? 0) < NOT_FOUND_RECHECK_MS : (await mtimeOf($, hit.path)) === hit.mtime)) return hit.model
    const found = await findDefinition($, cwd, subagentType, name)
    definitionMemo.set(key, found)
    return found.model
  } catch (err) {
    fault($, 'definedModel', err)
    return undefined
  }
}

async function settleSpawn($, toolUseId: string, result): Promise<void> {
  const agentId = result?.result?.agentId
  if (typeof agentId === 'string' && agentId !== '') {
    const at = await $.clock.now()
    await applyAgents($, (agents) => bindAgent(agents, toolUseId, agentId, at, routerOn ? roles : undefined))
  } else if (('deny' in result && result.deny) || result?.isError) {
    await applyAgents($, (agents) => dropUnjoined(agents, toolUseId))
  }
}

async function routeAgentCall($, e, next) {
  const named = routerOn && !e.model && roleOf(e.subagent_type) !== 'fork' ? await definedModel($, e.subagent_type) : undefined
  const input = { description: e.description ?? '', subagentType: e.subagent_type, model: e.model, definedModel: named }
  const found = routerOn ? [ruleR1(input), ruleR3(input, roles)].filter((w): w is Warning => w !== undefined) : []
  // The mark is kept before next(e), which is where the agent.spawn that reads it happens.
  if (found.length > 0 && e.tool_use_id) pendingWarnings.set(e.tool_use_id, found.map(warningString))
  const result = await next(e)
  // The result names the call's agentId: its spawn takes it if no step has joined it yet. A call
  // that came back denied or as an error with none: the engine refused the spawn, its record goes.
  // Past next(e) a fault must not reach the caller's .catch, which would run the Agent call again.
  if (e.tool_use_id) await guarded($, 'tool.call Agent join', () => settleSpawn($, e.tool_use_id, result))
  if ('deny' in result && result.deny) {
    if (e.tool_use_id) pendingWarnings.delete(e.tool_use_id)
    return result
  }
  // R1 and R3 are said only for a call that went on: a denied one leaves no log entry and no toast.
  // Past next(e) a fault must not reach the caller's .catch, which would run the Agent call again.
  if (found.length > 0) await guarded($, 'tool.call Agent R1', () => announce($, found, roleOf(e.subagent_type) || undefined))
  return withContext(result, found)
}

// The script text of a Workflow call: the file when `scriptPath` is given (the tool prefers it to
// `script`), else the inline script. A named workflow has neither. The file is read only where it
// lands inside the project or the Claude Code config directory, where workflow scripts are kept
// (SPEC 14), and only when it is a regular file of at most SCRIPT_MAX bytes; otherwise the path is
// ignored and the inline script, if any, is parsed. An inline script longer than SCRIPT_MAX
// characters is not parsed at all.
const SCRIPT_MAX = 256 * 1024

async function workflowScript($, e): Promise<string | undefined> {
  if (typeof e.scriptPath === 'string' && e.scriptPath !== '') {
    let st: { kind?: string; size?: number; realPath?: string } | undefined
    try {
      st = await $.fs.stat(e.scriptPath, { resolve: true })
    } catch {
      st = undefined
    }
    const real = st?.realPath
    if (st && real !== undefined && unreadable(st, SCRIPT_MAX) === undefined && (await insideAny($, real, [() => $.session.cwd(), () => configDir($)]))) {
      const text = await tryRead($, real)
      if (text !== undefined) return text
    }
  }
  return typeof e.script === 'string' && e.script.length <= SCRIPT_MAX ? e.script : undefined
}

// Whether a real path is under the real path of any of the directories, asked for in order.
async function insideAny($, real: string, dirs: Array<() => string | Promise<string>>): Promise<boolean> {
  for (const dir of dirs) {
    const root = await realPathOf($, await dir())
    if (root !== undefined && insideDir(real, root)) return true
  }
  return false
}

// agentIndex counts agent() calls as the script makes them (check 2), which is the source order only
// in a straight script. A loop, a function (an arrow too: parallel's thunks), a call nested in
// parallel or pipeline, or options the parser cannot read make the order unknown. The text test
// also sees strings and comments, which only errs toward unordered.
function scriptUnordered(script: string, calls: Array<{ dynamic: boolean; nesting: string[] }>): boolean {
  if (calls.some((c) => c.dynamic || c.nesting.length > 0)) return true
  return /\b(for|while|do|function)\b|=>|\.(map|forEach|flatMap|reduce)\s*\(/.test(script)
}

// A new run with phases becomes the phases source the moment its planned calls are written (SPEC
// 4.6): every agent is re-matched to the new plan, the earlier run's falling back to its run group.
// Under a higher source nothing changes, so nothing is re-matched.
async function rematchPhases($): Promise<void> {
  const inputs = await readInputs($)
  if (activeSource(inputs) === 'phases') await rematchAgents($, inputs)
}

async function routeWorkflowCall($, e, next) {
  await hideCompactHint($)
  const script = await workflowScript($, e)
  if (script === undefined || !e.tool_use_id) return next(e)
  const parsed = parseWorkflow(script)
  const shapes = parsed.calls.map((c) => ({ ordinal: c.ordinal, label: valueText(c.label), hasModel: c.hasModel, hasEffort: c.hasEffort, dynamic: c.dynamic }))
  const r2 = routerOn ? ruleR2({ name: parsed.name, calls: shapes }) : undefined
  const unordered = scriptUnordered(script, parsed.calls)
  const calls: PlannedInput[] = parsed.calls.map((c) => ({
    ordinal: c.ordinal,
    label: valueText(c.label),
    phase: valueText(c.phase),
    requestedModel: c.model?.kind === 'literal' ? c.model.value : undefined,
    effort: c.effort?.kind === 'literal' ? c.effort.value : undefined,
    warnings: [r2?.perCall.find((p) => p.ordinal === c.ordinal)].flatMap((p) => (p ? [warningString(p.warning)] : [])),
    unordered,
  }))
  const at = await $.clock.now()
  const plan = await currentPlan($)
  // the run's group title (4.3): the script's description, else its name; capped, it is persisted per record
  const runTitle = [parsed.description, parsed.name].find((x) => x !== undefined && x.trim() !== '')?.trim().slice(0, RUN_TITLE_MAX)
  await applyAgents($, (agents) => addPlanned(agents, { at, toolUseId: e.tool_use_id, calls, runTitle, runPhases: parsed.phases }, { plan }))
  if (parsed.phases !== undefined && parsed.phases.length > 0) await guarded($, 'tool.call Workflow label', () => startSource($, 'phases'))
  await guarded($, 'tool.call Workflow phases', () => rematchPhases($))
  const found = r2 ? [r2.warning] : []

  const result = await next(e)
  if ('deny' in result && result.deny) {
    // Past next(e) a fault must not reach the caller's .catch, which would run the Workflow again.
    await guarded($, 'tool.call Workflow', () => applyAgents($, (agents) => dropPlanned(agents, e.tool_use_id)))
    return result
  }
  await guarded($, 'tool.call Workflow', async () => {
    const runId = result.result?.runId
    // No run id: a failed syntax check or a remote launch, whose agents no local event names.
    if (typeof runId === 'string') await applyAgents($, (agents) => bindRun(agents, e.tool_use_id, runId))
    else await applyAgents($, (agents) => dropPlanned(agents, e.tool_use_id))
  })
  // R2 is said only for a call that went on: a denied one leaves no log entry naming its script
  if (found.length > 0) await guarded($, 'tool.call Workflow R2', () => announce($, found, undefined))
  return withContext(result, found)
}

function registerRouter(on) {
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => routeAgentCall($, e, next)).catch(async ($, e, next) => next(e)) // warnings never gate a dispatch: fail open
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => routeWorkflowCall($, e, next)).catch(async ($, e, next) => next(e))
}

// ---- M6: usage, prices, compact hint (SPEC 6) ------------------------------------------------
// Pure rules live in usage.ts and prices.ts. Nothing here may throw: the callers sit after a
// `next(e)` whose error handler would run the event again.

// A boundary the main loop acts on at its next turn.complete: set by a subagent finishing and by a
// plan flip to done (usage.ts Boundary).
let boundary: Boundary = START

function noteTaskFlips(flips: LogEntry[]): void {
  const done = flips.filter((f) => f.kind === 'task-done').map((f) => f.ref)
  if (done.length > 0) boundary = noteBoundary(boundary, done)
}

// Takes the list the completion wrote: a read in the same dispatch would answer the one before it.
function noteAgentFinished(agents: AgentRecord[], agentId: string): void {
  const a = agents.find((x) => x.agentId === agentId)
  boundary = noteBoundary(boundary, a ? [a.taskIds[0] ?? a.groupId ?? ''] : [])
}

// The figures of `$.session.usage()` (or of a session.measure event, which carries the same) into the
// `usage` atom: context fill and exact session cost, written only when a figure or the hint moved.
// At a main-loop turn.complete the hint can become `now`; elsewhere it only arms or disarms.
async function writeUsage($, u: { context?: { percent?: number; tokens?: number; window?: number }; cost?: { usd?: number } }, atComplete: boolean): Promise<void> {
  const prev = await read($, usageAtom)
  const percent = u.context?.percent
  let hint = hintAfterMeasure(prev?.hint, percent, compactAt)
  if (atComplete) {
    const at = hintAtTurnComplete({ agents: await read($, agentsAtom), plan: planCache?.plan ?? null, prev: prev?.hint, percent, threshold: compactAt, boundary })
    hint = at.hint
    boundary = at.boundary
  }
  const next: UsageData = {
    ...(percent !== undefined ? { percent } : {}),
    ...(u.context?.tokens !== undefined ? { tokens: u.context.tokens } : {}),
    ...(u.context?.window !== undefined ? { window: u.context.window } : {}),
    ...(u.cost?.usd !== undefined ? { usd: u.cost.usd } : {}),
    hint,
  }
  if (JSON.stringify(next) !== JSON.stringify(prev)) await update($, usageAtom, () => next)
  return next
}

// What the `state` tool reports: `$.session.usage()` read now and written to the atom the band draws
// from, so the two agree. The atom alone can be empty (after /clear reset `$.state`) or a step
// behind at tool-call time; a get in this dispatch still answers the moment it began, so the
// figures are handed back rather than read again. No reading keeps the atom's.
async function currentUsage($): Promise<UsageData | null> {
  try {
    return await writeUsage($, await $.session.usage(), false)
  } catch {
    return read($, usageAtom)
  }
}

// `$.session.usage()` after a main-loop step or turn.complete. The ledger takes a response's cost
// after those events, so this read can trail by one response; session.measure (below) settles it.
async function measureUsage($, atComplete: boolean): Promise<void> {
  try {
    await writeUsage($, await $.session.usage(), atComplete)
  } catch {
    // no reading this time; the figures stay as they were
  }
}

// The engine raises session.measure after each turn is in the ledger, with the figures pushed: the
// session cost the Usage tab shows equals the session cost Claude Code shows from here.
function registerMeasure(on) {
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      await writeUsage($, e, false)
    } catch {
      // as measureUsage
    }
    return result
  })
}

async function setHint($, change: (prev: UsageData['hint']) => UsageData['hint']): Promise<void> {
  try {
    const prev = await read($, usageAtom)
    if (!prev) return
    const hint = change(prev.hint)
    if (hint !== prev.hint) await update($, usageAtom, (u) => (u ? { ...u, hint } : u))
  } catch {
    // a hint left shown until the next measure
  }
}

// An agent.spawn or a Workflow call: work has begun on something, so a shown hint goes back to armed.
function hideCompactHint($): Promise<void> {
  return setHint($, hideHint)
}

// A turn.start whose text names a task other than the boundary's does the same.
async function hintOnStart($, text: string): Promise<void> {
  try {
    await setHint($, (prev) => hintOnTurnStart({ text, plan: planCache?.plan ?? null, prev, boundary }))
  } catch {
    // as above
  }
}

function registerTurnStart(on) {
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) delete handoff.awaitStart
    await hintOnStart($, typeof e.text === 'string' ? e.text : '')
    return result
  })
}

// The tool, the command and the reload after /clear, /resume and /branch (SPEC 3.3, 7).
function registerSession(on) {
  on('tool.call', { tool: TOOL_NAME }, async ($, e) => {
    try {
      return { result: await runTool($, e) }
    } catch (err) {
      return { result: 'refused: ' + (err instanceof Error ? err.message : String(err)) }
    }
  })

  on('command.run', { command: 'headway' }, async ($, e) => {
    try {
      return await runCommand($, (e.args ?? '').trim(), e.origin?.kind === 'composer')
    } catch (err) {
      fault($, 'command.run', err)
      return { text: 'refused: ' + (err instanceof Error ? err.message : String(err)) }
    }
  })

  // startup and compact keep `$.state`; only these three reset it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    // taken before any await: the turn left behind completes while this reload runs
    const carry = e.source === 'clear' ? planBeforeClear : undefined
    planBeforeClear = undefined
    await guarded($, 'reload', () => reloadSession($, e.session_id, e.source))
    if (carry) await guarded($, 'carry plan', () => carryPlan($, carry))
    return next(e)
  }).catch(async ($, e, next) => next(e))
}

// ---- 0.2 P1: plan-mode plans and the prompt label (SPEC 4.4, 4.8) ------------------------------

// An approved ExitPlanMode of the main loop: the plan replaces the plan-mode source and clears the
// reported list (sources.ts approvePlan). A rejection (`isError`), a denial and a subagent's plan
// (`e.agentId`) change nothing. The plan text is the result's, as the user approved it. Answers the
// note for Claude's context when the approval yields steps (SPEC 4.4), else nothing.
async function approvePlanMode($, e, result): Promise<string | undefined> {
  if (e.agentId || !result || ('deny' in result && result.deny)) return
  const approved = !result.isError && typeof result.result?.plan === 'string'
  const text = approved ? result.result.plan : e.plan
  if (typeof text !== 'string') return
  // the engine's own result names the file it saved; the call's planFilePath only when there is none
  const file = typeof result.result?.filePath === 'string' ? result.result.filePath : typeof e.planFilePath === 'string' ? e.planFilePath : undefined
  // held until the turn completes, for a /clear that is the dialog's "clear context" (SPEC 12)
  planBeforeClear = { text, ...(file !== undefined ? { file } : {}), label: (await readInputs($)).prompt, at: await $.clock.now(), approved }
  if (!approved) return
  await installPlanMode($, text, file, await startSource($, 'plan'), true)
  const inputs = await readInputs($)
  if (!guideOn || activeSource(inputs) !== 'plan' || !inputs.planMode || inputs.planMode.steps.length === 0) return
  return planNote(inputs.planMode.steps)
}

// The approved plan becomes the plan-mode source with `labels`, the reported and task lists go, and
// the agents re-match. Answers the number of steps.
async function installPlanMode($, text: string, file: string | undefined, labels: SourceLabels, log: boolean): Promise<number> {
  const parsed = parsePlanMode(text)
  handoff = { ...(file !== undefined ? { file } : {}), fresh: parsed.steps.length > 0 }
  const before = await readInputs($)
  const inputs: PlanInputs = { ...before, ...approvePlan(before, parsed), labels }
  await update($, planAtom, () => (inputs.planMode ? { ...inputs.planMode, text } : null))
  remember({ plan: inputs.planMode, report: await update($, reportAtom, () => null), tasks: await update($, tasksAtom, () => null) })
  resetPlan()
  if (activeSource(inputs) !== 'file') {
    await update($, focusAtom, () => null)
    await rematchAgents($, inputs, true)
  }
  const detail = parsed.steps.length === 0 ? 'plan: no steps found' : 'plan: ' + parsed.steps.length + ' steps' + (parsed.title ? ' § ' + parsed.title : '')
  if (log) await addLog($, [{ at: await $.clock.now(), kind: 'plan', ref: '', detail }])
  await currentPlan($, inputs)
  return parsed.steps.length
}

// ---- 0.2 P2: the guidance section (SPEC 6) --------------------------------------------------

// One section appended after the engine's own, session scope, left out when guideClaude is off, a file
// is pinned, or the session draws nowhere. A fault here leaves the prompt as the engine built it.
async function composeGuide($, e, result) {
  try {
    const pinned = (await read($, filterAtom)) !== null
    if (!guideWanted({ enabled: guideOn, pinned, surfaces: e.surfaces ?? [], traits: e.traits ?? [], tools: e.tools ?? [] })) return result
    return { ...result, sections: [...result.sections, { id: GUIDE_ID, text: GUIDE_TEXT, scope: 'session' as const }] }
  } catch (err) {
    fault($, 'prompt.compose', err)
    return result
  }
}

function registerGuide(on) {
  on('prompt.compose', async ($, e, next) => composeGuide($, e, await next(e)))
}

// A composer prompt names the work (sources.ts promptLabel): it is kept as the newest prompt line,
// which the next source to start takes as its label; it renames no source already standing.
async function notePrompt($, e): Promise<void> {
  handoff.fresh = false // any prompt ends the approval's turn: a full list may replace the plan (4.4)
  planBeforeClear = undefined
  const line = promptLabel(e.text, e.origin?.kind)
  if (line === undefined || line === (await readInputs($)).prompt) return
  remember({ prompt: await update($, promptAtom, () => line) })
  await safely(scheduleSave($))
}

function registerPlanSources(on) {
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const result = await next(e)
    // Past next(e) a fault must not reach the .catch below, which would run the call again.
    let note: string | undefined
    await guarded($, 'tool.call ExitPlanMode', async () => {
      note = await approvePlanMode($, e, result)
    })
    return typeof note === 'string' ? { ...result, context: [...(result.context ?? []), note] } : result
  }).catch(async ($, e, next) => next(e)) // tracking never gates the plan: fail open

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await guarded($, 'prompt.submit', () => notePrompt($, e))
    return result
  })
}

// ---- 0.2 P3: Claude's task tools (SPEC 4.5) ----------------------------------------------------

// A TaskCreate, TaskUpdate or TodoWrite of the main loop that the engine accepted (not a denial, an
// error result or a subagent's call) changes the task list. Lower sources do not move the band
// while a higher one is drawn: then only the list and its save change.
async function noteTaskCall($, e, result): Promise<void> {
  if (e.agentId || !result || result.isError || ('deny' in result && result.deny)) return
  // The call is applied inside the reducer, to the list as it stands: parallel calls of one message
  // each land on the others' writes rather than on the list their dispatch began with.
  let prior: TaskItem[] | null = null
  let changed = false
  const at = await $.clock.now()
  const tasks = await update($, tasksAtom, (cur) => {
    prior = cur
    const next = applyTaskCall(e.tool, e, result.result, cur, at)
    changed = next !== cur
    return next
  })
  if (!changed) return
  remember({ tasks })
  const before: PlanInputs = { ...(await readInputs($)), tasks: prior }
  // a list out of nothing starts the source; any other change moves the standing list
  const starts = ((prior as TaskItem[] | null)?.length ?? 0) === 0 && (tasks?.length ?? 0) > 0
  if (starts) await startSource($, 'tasks')
  else await noteSourceFlips($, before, { ...before, tasks }) // this call's own flips
  // the plan drawn is the list as it stands now, which parallel calls of one message may have moved
  // past this call's own result while it waited
  const inputs = await readInputs($)
  if (activeSource(before) === 'tasks' || activeSource(inputs) === 'tasks') {
    resetPlan()
    if (activeSource(inputs) !== 'file') await rematchAgents($, inputs)
    await currentPlan($, inputs)
  }
  await safely(scheduleSave($))
}

function registerTaskTools(on) {
  on('tool.call', { tool: ['TaskCreate', 'TaskUpdate', 'TodoWrite'] }, async ($, e, next) => {
    const result = await next(e)
    // Past next(e) a fault must not reach the .catch below, which would run the call again.
    await guarded($, 'tool.call ' + e.tool, () => noteTaskCall($, e, result))
    return result
  }).catch(async ($, e, next) => next(e)) // tracking never gates a task call: fail open
}

// One hook per event: session.start serves every block.
export function register(on, options) {
  if (typeof options?.stallMinutes === 'number') stallMs = options.stallMinutes * MIN
  if (typeof options?.startMinutes === 'number') startMs = options.startMinutes * MIN
  if (typeof options?.compactAtPercent === 'number') compactAt = options.compactAtPercent
  routerOn = options?.routerWarnings !== false
  guideOn = options?.guideClaude !== false
  handoff = { fresh: false }
  quietOn = options?.quietToolRows !== false
  themeMode = themeModeOf(options?.theme)
  bandDefaultOff = options?.bandDefault === 'off'
  roles = undefined // a module reload starts without a table; the next tick or session start reads the file
  rolesWatch = {}

  // Fires again on every module reload, which stops timers.
  // The tool and the command first, then each start-up step on its own: one that fails is logged and
  // the rest still run.
  on('session.start', async ($, e, next) => {
    await guarded($, 'tool.register', () => $.tool.register(TOOL_SPEC))
    await guarded($, 'command.register', () =>
      $.command.register({
        name: 'headway',
        description: 'headway: open the pane, pin a plan, print the state',
        argumentHint: ARGUMENT_HINT,
        immediate: true,
      }),
    )
    await guarded($, 'timers', () => startTracking($))
    await guarded($, 'store', () => startStore($))
    await guarded($, 'band', () => startBand($))
    await guarded($, 'roles', () => startRoles($))
    definitionMemo.clear()
    return next(e)
  })

  registerRender(on)
  registerQuietRows(on)
  registerPaneClose(on)
  registerTracking(on)
  registerRouter(on)
  registerSession(on)
  registerTurnStart(on)
  registerMeasure(on)
  registerPlanSources(on)
  registerGuide(on)
  registerTaskTools(on)
}
