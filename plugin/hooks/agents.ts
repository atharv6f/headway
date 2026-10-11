// Agent tracking (pure): the agent record, its status transitions, ID matching against the pinned
// plan, the stall rule, log entries, and the Plan-tree data. SPEC.md sections 2, 4 and 8.2.
// Every reducer takes the agent list and one event and returns a new list; nothing is mutated,
// so register.tsx can run a reducer inside `update`, which may call it more than once.

import { candidateIds } from './plan.ts'
import type { Plan, Task } from './plan.ts'
import type { Filter } from './pin.ts'
import { familyOf, roleOf, ruleR3, ruleR4, warningDetail, warningString } from './router.ts'
import type { Roles } from './router.ts'
import type { Warning } from './router.ts'
import { costOf } from './prices.ts'
import { basename, escapeRegex } from './format.ts'

// `lost`: left queued, running or stalled by an earlier process, so no event can reach it again.
export type AgentStatus = 'queued' | 'running' | 'stalled' | 'blocked' | 'failed' | 'done' | 'lost'

export interface Tokens {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
}

export interface AgentRecord {
  id: string // agentId when known; a workflow agent without one `wf:<runId>:<agentIndex>`; else tool_use_id
  toolUseId?: string
  agentId?: string
  runId?: string
  agentIndex?: number
  label?: string
  phase?: string
  runTitle?: string // a workflow agent's run title (meta.description, else meta.name); the group title of the run (4.3)
  runPhases?: string[] // the run's `meta.phases`, in order: the tasks of the phases source (4.6)
  name?: string
  description: string
  subagentType: string
  taskIds: string[] // the matched task ID, at most one (first match wins)
  groupId?: string // the group the match resolved to, or the group the agent names
  role: string
  requestedModel?: string // the alias the call passed
  model?: string // resolved: from each turn.step (the spawn's answer is not read)
  effort?: string
  status: AgentStatus
  reason?: string // why it failed: error, refusal, aborted, failed, killed
  question?: string // a blocked answer's text after BLOCKED
  spawnedAt: number
  firstStepAt?: number
  lastStepAt?: number
  stalledAt?: number
  endedAt?: number
  durationMs?: number
  steps: number
  tokens: Tokens
  estUsd: number
  warnings: string[] // router warnings (router.ts warningString): the rule, a space, the one-line text
  planned?: true // a Workflow script's agent() call not yet spawned (addPlanned)
  skipped?: true // a planned call its run ended without spawning (tick): kept for a late spawn, never drawn or counted
  unordered?: true // a planned call of a script whose agentIndex order is not its source order: no join by ordinal
  provisional?: true // a step or completion seen before its agent.spawn wrote the record
  previous?: true // finished when a plan-mode approval or a new report list began new work: matched to nothing while it stays finished (4.1)
}

export type LogKind = 'done' | 'failed' | 'blocked' | 'stalled' | 'lost' | 'resumed' | 'task-done' | 'task-partial' | 'task-reopened' | 'pin' | 'unpin' | 'report' | 'plan' | 'warn'

export interface LogEntry {
  at: number
  kind: LogKind
  ref: string // task or group ID, `—` for an unassigned agent, '' for pin and unpin, the rule (R1-R4) for a warning
  role?: string
  label?: string // a workflow agent's call label, shown where the role would read `workflow-subagent`
  agentId?: string // the record's id
  detail?: string
  durationMs?: number
  estUsd?: number
}

export type { Filter }

export interface Outcome {
  agents: AgentRecord[]
  log: LogEntry[]
  changed: boolean
  repoint?: string[] // record ids whose step data moved: their log entries take the record's ref and role (repointLog)
}

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null
  speed?: string | null
  model?: string
}

export interface SpawnEvent {
  at: number
  toolUseId: string
  description: string
  subagentType: string
  prompt?: string
  name?: string
  requestedModel?: string // agent.spawn's e.model
  workflow?: { runId: string; agentIndex: number }
  // The spawn hook passes none of these (it does not read what next(e) answers; the agentId joins
  // later, joinSpawn); a caller that knows them may.
  agentId?: string
  model?: string
  deny?: string // a refused spawn: no record
  warnings?: string[] // router warnings found at the dispatch (tool.call), stored on the record
}

export interface MatchContext {
  plan: Plan | null
  temporal?: boolean // the active source is reported, plan-mode or task tools: an agent naming nothing joins the one partial task (5.3)
  roles?: Roles // the role table R3/R4 judge by; absent when no role file is in force
}

export interface Match {
  taskIds: string[]
  groupId?: string
}

const MIN = 60_000
const PROVISIONAL_TTL = 2 * MIN
// An early record that finished and that no spawn claimed this long after: not an agent whose
// spawn hook is about to write (that lands within the dispatch), but one the engine never raised
// agent.spawn for, such as a stalled workflow agent's retry (`agent.spawn`'s `workflow` docs).
const SURFACE_MS = 15_000
// A run whose spawned agents are all terminal and that saw no spawn, step or end for this long is
// over: its planned calls that never spawned are skipped. A sequential script spawns its next call
// within seconds of the last one ending.
export const RUN_QUIET_MS = MIN
const PROMPT_HEAD = 2000
const BLOCKED_HEAD = 4096

// The text after BLOCKED on the first line, in the first BLOCKED_HEAD characters of an answer, whose
// first word is BLOCKED (SPEC 3), an optional `:` dropped; undefined when there is none. String
// operations only: no pattern runs over the whole answer.
function blockedReason(answer: string): string | undefined {
  for (const line of answer.slice(0, BLOCKED_HEAD).split(/[\n\r\u2028\u2029]/)) {
    const t = line.trimStart()
    if (!t.startsWith('BLOCKED') || /[A-Za-z0-9_]/.test(t.charAt(7))) continue
    let rest = t.slice(7)
    let k = 0
    while (rest[k] === ' ' || rest[k] === '\t') k++
    if (rest[k] === ':') k++
    rest = rest.slice(k)
    return rest.trim()
  }
  return undefined
}
const LOG_MAX = 200

const ZERO: Tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }

export function isFinished(s: AgentStatus): boolean {
  return s === 'done' || s === 'failed' || s === 'blocked' || s === 'lost'
}

// Drawn and counted: not a provisional record waiting for its spawn, not a skipped planned call.
export function isShown(a: AgentRecord): boolean {
  return !a.provisional && !a.skipped
}

// Over for good: a blocked agent still waits on an answer, so it is not terminal.
export function isTerminal(s: AgentStatus): boolean {
  return s === 'done' || s === 'failed' || s === 'lost'
}

// When a finished agent last moved: the newest of these wins a cap.
export function agentRecency(a: AgentRecord): number {
  return a.endedAt ?? a.lastStepAt ?? a.spawnedAt
}

// Drops keys whose value is undefined, so records stay plain JSON.
function clean<T extends object>(o: T): T {
  const out = {} as T
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] !== undefined) out[k] = o[k]
  return out
}

function without<T extends object>(o: T, ...keys: Array<keyof T>): T {
  const out = { ...o }
  for (const k of keys) delete out[k]
  return out
}

// ---------------------------------------------------------------- role and model (4.4)

export { familyOf, roleOf }

// ---------------------------------------------------------------- ID matching (4.3)

const wordCache = new Map<string, RegExp>()

// A text an agent is matched by: the name, description and workflow label are words a dispatcher
// chose, where a heading-text ID may appear in any case; the prompt and the phase are not.
export interface AnyCase {
  text: string | undefined
  anyCase: true
}
export type MatchText = string | undefined | AnyCase
export const anyCase = (text: string | undefined): AnyCase => ({ text, anyCase: true })

const NEVER = /(?!)/

// An ID as a whole word. A bare number or a qualified one (a plan-mode or reported step `3`, `2.1`,
// SPEC 5.3) only in the step forms: `Step n` / `step n`, `#n`, or `n:` / `n.` opening the text; a
// loose number is no match. An ID is case-sensitive, except that one without a digit (a heading's
// text, as in a plan-mode plan) matches in any case in an `anyCase` text. An empty ID matches nothing.
function wordRe(id: string, loose = false): RegExp {
  if (id === '') return NEVER
  const fold = loose && !/\d/.test(id)
  const key = (fold ? 'i:' : 's:') + id
  let re = wordCache.get(key)
  if (!re) {
    const end = '(?![A-Za-z0-9-])'
    const num = escapeRegex(id)
    re = /^\d+(\.\d+)?$/.test(id)
      ? new RegExp('(?<![A-Za-z0-9-])(?:[Ss]tep |#)' + num + '(?![A-Za-z0-9-]|\\.\\d)|^\\s*' + num + '[:.](?!\\d)')
      : new RegExp('(?<![A-Za-z0-9-])' + escapeRegex(id) + end, fold ? 'i' : '')
    wordCache.set(key, re)
  }
  return re
}

function groupOfTask(plan: Plan, id: string, text: string, loose = false): Match {
  const occurrences = plan.tasks.filter((t) => t.id === id)
  const groupIds: string[] = []
  for (const t of occurrences) for (const gi of t.groups) if (groupIds.indexOf(plan.groups[gi].id) < 0) groupIds.push(plan.groups[gi].id)
  const named = groupIds.slice().sort((a, b) => b.length - a.length).find((g) => wordRe(g, loose).test(text))
  if (named !== undefined) return { taskIds: [id], groupId: named }
  const first = occurrences[0]
  if (first && first.groups.length > 0) return { taskIds: [id], groupId: plan.groups[first.groups[0]].id }
  return { taskIds: [id] }
}

// The first text with a match wins; within a text, task IDs (longest first) before group IDs. The
// candidates are the IDs the plan has, each matched as escaped literal text. With `temporal`
// (SPEC 5.3: the active source is reported, plan-mode or task tools) an agent that names nothing
// attaches to the plan's one partial task.
export function matchAgent(plan: Plan | null, texts: MatchText[], opts: { temporal?: boolean } = {}): Match {
  if (!plan) return { taskIds: [] }
  const { taskIds, groupIds } = candidateIds(plan)
  for (const entry of texts) {
    const loose = typeof entry === 'object'
    const text = typeof entry === 'object' ? entry.text : entry
    if (!text) continue
    for (const id of taskIds) if (wordRe(id, loose).test(text)) return groupOfTask(plan, id, text, loose)
    for (const id of groupIds) if (wordRe(id, loose).test(text)) return { taskIds: [], groupId: id }
  }
  return opts.temporal ? partialMatch(plan) : { taskIds: [] }
}

// 5.3 step 2: exactly one task partial; with none or several, no association.
function partialMatch(plan: Plan): Match {
  const partial = plan.tasks.filter((t) => t.status === 'partial')
  return partial.length === 1 ? groupOfTask(plan, partial[0].id, '') : { taskIds: [] }
}

// Under a phases plan (4.6) a record is placed by its run and its phase, never by the text of its
// description: an agent of the plan's run goes to the task named by its phase (else to the run's
// group), any other agent matches nothing. Undefined for every other plan.
export function phaseMatch(plan: Plan | null, run: { runId?: string; toolUseId?: string }, phase: string | undefined): Match | undefined {
  const pr = plan?.phaseRun
  if (!plan || !pr) return undefined
  const mine = (run.toolUseId !== undefined && run.toolUseId === pr.toolUseId) || (run.runId !== undefined && run.runId === pr.runId)
  if (!mine) return { taskIds: [] }
  const groupId = plan.groups[0]?.id
  if (phase !== undefined && plan.tasks.some((t) => t.id === phase)) return { taskIds: [phase], groupId }
  return { taskIds: [], groupId }
}

// ---------------------------------------------------------------- log entries

// What the role column reads: a workflow agent's call label (every workflow agent has the same role),
// else the role.
export function roleText(r: { role: string; label?: string }): string {
  return r.role === 'workflow-subagent' && r.label ? r.label : r.role
}

// The role (colours the cell) and, for a workflow agent, its label (the text) for a log entry.
function roleFields(r: AgentRecord): { role: string; label?: string } {
  return r.role === 'workflow-subagent' && r.label ? { role: r.role, label: r.label } : { role: r.role }
}

function refOf(r: AgentRecord): string {
  return r.taskIds[0] ?? r.groupId ?? '—'
}

function finishEntry(r: AgentRecord, at: number): LogEntry {
  const base = { at, ref: refOf(r), ...roleFields(r), agentId: r.id }
  if (r.status === 'blocked') return clean({ ...base, kind: 'blocked' as const, detail: r.question })
  if (r.status === 'failed') return clean({ ...base, kind: 'failed' as const, detail: r.reason })
  return clean({ ...base, kind: 'done' as const, durationMs: r.durationMs, estUsd: r.estUsd })
}

export function appendLog(log: LogEntry[], entries: LogEntry[], max: number = LOG_MAX): LogEntry[] {
  if (entries.length === 0) return log
  return [...entries.slice().reverse(), ...log].slice(0, max)
}

export function pinEntry(filter: Filter, at: number): LogEntry {
  let detail = 'tracking ' + basename(filter.file)
  if (filter.section) detail += ' § ' + filter.section
  const rules: string[] = []
  if (filter.doneRule && filter.doneRule !== 'auto') rules.push(filter.doneRule)
  if (filter.partial) rules.push('partial=' + filter.partial)
  if (filter.groupMap) rules.push('groups=' + basename(filter.groupMap))
  if (rules.length > 0) detail += '  ' + rules.join(' ')
  return { at, kind: 'pin', ref: '', detail }
}

// The same filter pinned again: only a re-read, logged as one.
export function rereadEntry(filter: Filter, at: number): LogEntry {
  const e = pinEntry(filter, at)
  return { ...e, detail: 're-read' + (e.detail ?? '').slice('tracking'.length) }
}

export function unpinEntry(at: number): LogEntry {
  return { at, kind: 'unpin', ref: '', detail: 'untracked' }
}

// Tasks whose status changed between two parses of the same pin, in plan order. A repeated ID is
// compared occurrence by occurrence; a task present in only one parse is not a flip.
// `suffix` follows each detail: the file's flips say " (plan changed)", an in-memory source's say nothing.
export function planFlips(prev: Plan, next: Plan, at: number, suffix: string = ' (plan changed)'): LogEntry[] {
  const keyed = (tasks: Task[]) => {
    const seen = new Map<string, number>()
    const out = new Map<string, Task>()
    for (const t of tasks) {
      const n = seen.get(t.id) ?? 0
      seen.set(t.id, n + 1)
      out.set(t.id + '\u0000' + n, t)
    }
    return out
  }
  const before = keyed(prev.tasks)
  const out: LogEntry[] = []
  keyed(next.tasks).forEach((t, key) => {
    const p = before.get(key)
    if (!p || p.status === t.status) return
    if (t.status === 'done') out.push({ at, kind: 'task-done', ref: t.id, detail: next.doneWord + suffix })
    else if (t.status === 'partial') out.push({ at, kind: 'task-partial', ref: t.id, detail: (next.partialWord ?? 'partial') + suffix })
    else out.push({ at, kind: 'task-reopened', ref: t.id, detail: 'reopened' + suffix })
  })
  return out
}

// Another filter pinned: the agents still at work (planned calls and early records included) stay,
// re-matched to the new plan; finished and skipped ones go. Any other change of the active source
// (SPEC 4.1) passes `keepFinished`: every agent stays and is re-matched. Only name, description, label and phase
// are kept, not the prompt, so when they name nothing the old task or group stays if the new plan
// still has that ID (the prompt named it as a whole word); else the agent is Unassigned.
// `retire` (a plan-mode approval, a new report list: new work begins) marks every finished agent
// `previous`; a previous agent that is still finished matches nothing, so it sits in its origin group
// (the workflow run or `Agents`) and never in the new plan's bars. One that resumed re-matches.
export function repinAgents(agents: AgentRecord[], ctx: MatchContext, opts: { keepFinished?: boolean; retire?: boolean } = {}): Outcome {
  const ids = ctx.plan ? candidateIds(ctx.plan) : { taskIds: [], groupIds: [] }
  const out: AgentRecord[] = []
  for (const a of agents) {
    if (a.skipped || (!opts.keepFinished && isFinished(a.status))) continue
    if (a.provisional) {
      out.push(a)
      continue
    }
    if (isFinished(a.status) && (a.previous || opts.retire)) {
      out.push({ ...without(a, 'groupId'), taskIds: [], previous: true })
      continue
    }
    const byPhase = phaseMatch(ctx.plan, a, a.phase)
    let m = byPhase ?? matchAgent(ctx.plan, [anyCase(a.name), anyCase(a.description), anyCase(a.label), a.phase])
    if (byPhase === undefined && m.taskIds.length === 0 && m.groupId === undefined) {
      const tid = a.taskIds[0]
      if (tid !== undefined && ids.taskIds.indexOf(tid) >= 0 && ctx.plan) m = groupOfTask(ctx.plan, tid, a.description)
      else if (tid === undefined && a.groupId !== undefined && ids.groupIds.indexOf(a.groupId) >= 0) m = { taskIds: [], groupId: a.groupId }
      else if (ctx.temporal && ctx.plan) m = matchAgent(ctx.plan, [], { temporal: true })
    }
    out.push(clean({ ...without(a, 'groupId', 'previous'), taskIds: m.taskIds, groupId: m.groupId }))
  }
  return { agents: out, log: [], changed: true }
}

// ---------------------------------------------------------------- transitions (section 2)

const SAME = (agents: AgentRecord[]): Outcome => ({ agents, log: [], changed: false })

function replaceAt(agents: AgentRecord[], i: number, r: AgentRecord): AgentRecord[] {
  const out = agents.slice()
  out[i] = r
  return out
}

function indexOfAgent(agents: AgentRecord[], agentId: string): number {
  return agents.findIndex((a) => a.agentId === agentId)
}

function provisional(agentId: string, at: number): AgentRecord {
  return {
    id: agentId, agentId, provisional: true, description: '', subagentType: '', role: '', taskIds: [],
    status: 'queued', spawnedAt: at, steps: 0, tokens: { ...ZERO }, estUsd: 0, warnings: [],
  }
}

// A label pattern (`*` for each template substitution) against a whole description, with no
// regex: the classic wildcard walk, which on a mismatch after a `*` resumes one character past
// where that `*` last started. Time is O(label · description) at worst, never exponential.
export function globMatch(label: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let resume = 0
  while (t < text.length) {
    if (p < label.length && label[p] !== '*' && label[p] === text[t]) {
      p++
      t++
    } else if (p < label.length && label[p] === '*') {
      star = p++
      resume = t
    } else if (star >= 0) {
      p = star + 1
      t = ++resume
    } else return false
  }
  while (p < label.length && label[p] === '*') p++
  return p === label.length
}

function labelMatches(label: string | undefined, description: string): boolean {
  if (label === undefined) return false
  if (label.indexOf('*') < 0) return label === description
  return globMatch(label, description)
}

// The workflow join (4.2): the planned call of the same run whose label (or label pattern)
// matches the spawn's description; `agentIndex` breaks ties.
function plannedFor(agents: AgentRecord[], wf: { runId: string; agentIndex: number }, description: string): number {
  let first = -1
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]
    if (!a.planned || a.agentId || a.runId !== wf.runId) continue
    // a call with no static label can only be told by its ordinal, and only in a script whose
    // agentIndex order is its source order; elsewhere it stays unjoined rather than mis-joined
    if (a.label === undefined) {
      if (!a.unordered && a.agentIndex === wf.agentIndex) return i
      continue
    }
    if (!labelMatches(a.label, description)) continue
    if (a.agentIndex === wf.agentIndex) return i
    if (first < 0) first = i
  }
  return first
}

export function spawnAgent(agents: AgentRecord[], ev: SpawnEvent, ctx: MatchContext): Outcome {
  if (ev.deny !== undefined) return SAME(agents)
  let list = agents
  let planned: AgentRecord | undefined
  let slot = -1
  if (ev.workflow) {
    slot = plannedFor(list, ev.workflow, ev.description)
    if (slot >= 0) planned = list[slot]
  }
  let early: AgentRecord | undefined
  if (ev.agentId) {
    const pi = indexOfAgent(list, ev.agentId)
    if (pi >= 0) {
      early = list[pi]
      list = list.filter((_, i) => i !== pi)
      if (slot > pi) slot--
    }
  }
  const label = ev.workflow ? ev.description : undefined
  const phase = planned?.phase
  const runTitle = ev.workflow ? planned?.runTitle ?? list.find((a) => a.runId === ev.workflow!.runId && a.runTitle !== undefined)?.runTitle : undefined
  const runPhases = ev.workflow ? planned?.runPhases ?? list.find((a) => a.runId === ev.workflow!.runId && a.runPhases !== undefined)?.runPhases : undefined
  const match =
    phaseMatch(ctx.plan, { runId: ev.workflow?.runId, toolUseId: ev.toolUseId || undefined }, phase) ??
    matchAgent(ctx.plan, [anyCase(ev.name), anyCase(ev.description), (ev.prompt ?? '').slice(0, PROMPT_HEAD), anyCase(label), phase], { temporal: ctx.temporal })
  const id = ev.agentId ?? (ev.workflow ? 'wf:' + ev.workflow.runId + ':' + ev.workflow.agentIndex : ev.toolUseId)
  const record: AgentRecord = clean({
    id,
    toolUseId: ev.toolUseId || undefined,
    agentId: ev.agentId,
    runId: ev.workflow?.runId,
    agentIndex: ev.workflow?.agentIndex,
    label,
    phase,
    runTitle,
    runPhases,
    name: ev.name,
    description: ev.description,
    subagentType: ev.subagentType,
    taskIds: match.taskIds,
    groupId: match.groupId,
    role: roleOf(ev.subagentType),
    requestedModel: ev.requestedModel ?? planned?.requestedModel,
    model: early?.model ?? ev.model,
    effort: early?.effort ?? planned?.effort,
    status: early ? early.status : 'queued',
    reason: early?.reason,
    question: early?.question,
    spawnedAt: Math.min(ev.at, early ? early.spawnedAt : ev.at),
    firstStepAt: early?.firstStepAt,
    lastStepAt: early?.lastStepAt,
    endedAt: early?.endedAt,
    durationMs: early?.durationMs,
    steps: early ? early.steps : 0,
    tokens: early ? early.tokens : { ...ZERO },
    // a planned call never steps (it has no agentId), so the two sums are disjoint
    estUsd: (planned?.estUsd ?? 0) + (early?.estUsd ?? 0),
    warnings: [...(planned?.warnings ?? []), ...(ev.warnings ?? [])],
  })
  // A step that beat this spawn could not be routed (its record had no role): do it now.
  const late = early && early.firstStepAt !== undefined ? firstStepWarnings(record, record.model, record.effort, ctx.roles) : []
  const routed = late.length > 0 ? { ...record, warnings: [...record.warnings, ...late.map(warningString)] } : record
  const next = slot >= 0 ? replaceAt(list, slot, routed) : [...list, routed]
  const log = [
    ...(early && isFinished(early.status) ? [finishEntry(routed, early.endedAt ?? ev.at)] : []),
    ...late.map((w) => warnEntry(w, routed, early?.firstStepAt ?? ev.at)),
  ]
  return { agents: next, log, changed: true }
}

// ---------------------------------------------------------------- the spawn join (5.1)
// The agent.spawn hook observes and passes the spawn on as it came (register.tsx), so its record is
// written from the event, before the engine starts the agent, and has no agentId. The agent's first
// step or its completion joins the agentId to it (joinSpawn); the Agent tool's result, which carries
// the agentId, settles it, correcting a wrong join (bindAgent); a spawn the engine refused is dropped (dropUnjoined).

// What tells a new agentId's spawn: the agent's transcript, which opens with the prompt it was
// spawned with; its `$.agent.list()` row; the head of each waiting spawn's prompt, by record id,
// kept in memory only; and the step's model and effort. A workflow agent has neither a readable
// transcript nor a row at its first step (2.1.296), so only its model and effort tell it apart.
export interface JoinHints {
  text?: string
  row?: { description: string; type: string }
  prompts: Record<string, string>
  model?: string
  effort?: string
}

const JOIN_HEAD = 160
// How much of a transcript's opening is searched for a head: the prompt may follow a preamble.
export const JOIN_TEXT = 65536

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// The part of a prompt a join compares: its first JOIN_HEAD characters, white space folded.
export function promptHead(prompt: string | undefined): string {
  return squash((prompt ?? '').slice(0, JOIN_HEAD * 4)).slice(0, JOIN_HEAD)
}

// The id spawnAgent gives a spawn's record (the agentId is not known at the spawn).
export function spawnRecordId(ev: { toolUseId: string; workflow?: { runId: string; agentIndex: number } }): string {
  return ev.workflow ? 'wf:' + ev.workflow.runId + ':' + ev.workflow.agentIndex : ev.toolUseId
}

function waitingSpawn(a: AgentRecord): boolean {
  return a.agentId === undefined && !a.planned && !a.provisional && !a.skipped && a.steps === 0 && (a.status === 'queued' || a.status === 'stalled')
}

// Whether a waiting workflow spawn could be the agent of a step on `model`: the family the call
// asked for, where both sides name one. Effort does not rule a spawn out (the engine may run a call
// at another effort than the script set); it only breaks a tie (workflowSpawn).
function fitsModel(a: AgentRecord, hints: JoinHints): boolean {
  const asked = familyOf(a.requestedModel)
  const ran = familyOf(hints.model)
  return asked === 'unknown' || ran === 'unknown' || asked === ran
}

// The workflow spawn a step with no transcript and no row joins, or -1. Candidates: queued (never a
// stalled one), of a run not over (endedRuns, when `at` is given). The most recently started run
// goes first (a run starts at the earliest record it has); only when none of its spawns fits the
// step's model does the next run get a turn. Within a run, a spawn that set the step's effort
// before one that did not, then the lowest agentIndex.
function workflowSpawn(agents: AgentRecord[], waiting: Array<[AgentRecord, number]>, hints: JoinHints, at: number | undefined): number {
  const over = at === undefined ? new Set<string>() : endedRuns(agents, at)
  const flows = waiting.filter(([a]) => a.runId !== undefined && a.status === 'queued' && !over.has(a.runId))
  if (flows.length === 0) return -1
  const starts = new Map<string, number>()
  for (const a of agents) if (a.runId !== undefined) starts.set(a.runId, Math.min(starts.get(a.runId) ?? a.spawnedAt, a.spawnedAt))
  const runs = [...new Set(flows.map(([a]) => a.runId as string))].sort((x, y) => (starts.get(y) ?? 0) - (starts.get(x) ?? 0))
  for (const run of runs) {
    const fit = flows.filter(([a]) => a.runId === run && fitsModel(a, hints))
    if (fit.length === 0) continue
    const same = fit.filter(([a]) => a.effort !== undefined && a.effort === hints.effort)
    const pool = same.length > 0 ? same : fit
    return pool.reduce((b, x) => ((x[0].agentIndex ?? 0) < (b[0].agentIndex ?? 0) ? x : b))[1]
  }
  return -1
}

// The waiting spawn a new agentId belongs to, or -1. A transcript decides when some waiting spawn has
// a prompt head: the earliest whose head the transcript's first JOIN_TEXT characters hold. When it
// holds none, only a list row decides (an engine fork, which no spawn announced, joins nothing).
// Else a list row decides: the earliest with its description and type. With neither, the agent is a
// workflow agent (or an engine fork): it joins a waiting workflow spawn (workflowSpawn), and never an
// Agent-tool spawn, however alone it waits: that one waits for a hint or its Agent call's result.
export function joinSpawn(agents: AgentRecord[], hints: JoinHints, at?: number): number {
  const waiting: Array<[AgentRecord, number]> = []
  agents.forEach((a, i) => {
    if (waitingSpawn(a)) waiting.push([a, i])
  })
  if (waiting.length === 0) return -1
  const earliest = (xs: Array<[AgentRecord, number]>) => (xs.length === 0 ? -1 : xs.reduce((b, x) => (x[0].spawnedAt < b[0].spawnedAt ? x : b))[1])
  const row = hints.row
  const byRow = (xs: Array<[AgentRecord, number]>) => (row ? xs.filter(([a]) => a.description === row.description && a.subagentType === row.type) : [])
  if (hints.text !== undefined) {
    const headed = waiting.filter(([a]) => (hints.prompts[a.id] ?? '') !== '')
    if (headed.length > 0) {
      const text = squash(hints.text.slice(0, JOIN_TEXT))
      const found = headed.filter(([a]) => text.includes(hints.prompts[a.id]))
      if (found.length > 0) {
        // spawns with the same prompt are told apart by the row, where there is one
        const told = found.length > 1 ? byRow(found) : []
        return earliest(told.length > 0 ? told : found)
      }
      return row ? earliest(byRow(waiting)) : -1
    }
  }
  if (row) return earliest(byRow(waiting))
  return workflowSpawn(agents, waiting, hints, at)
}

// What an agent's own events wrote on a record: they belong to its agentId, not to the spawn, and
// move with it when a join is corrected (bindAgent).
const STEP_FIELDS = ['agentId', 'model', 'effort', 'status', 'reason', 'question', 'firstStepAt', 'lastStepAt', 'stalledAt', 'endedAt', 'durationMs', 'steps', 'tokens', 'estUsd'] as const
type StepData = Pick<AgentRecord, (typeof STEP_FIELDS)[number]>

function stepData(r: AgentRecord): StepData {
  const out: Record<string, unknown> = {}
  for (const k of STEP_FIELDS) out[k] = r[k]
  return out as unknown as StepData
}

const NO_STEPS = { status: 'queued' as const, steps: 0, tokens: { ...ZERO }, estUsd: 0 }

// R3 and R4 for step data a record took from elsewhere: those steps were routed on another record,
// or on none (a provisional record has no role).
function routeTaken(r: AgentRecord, roles: Roles | undefined): { record: AgentRecord; warnings: Warning[] } {
  if (r.firstStepAt === undefined) return { record: r, warnings: [] }
  const found = firstStepWarnings(r, r.model, r.effort, roles)
  return { record: found.length > 0 ? { ...r, warnings: [...r.warnings, ...found.map(warningString)] } : r, warnings: found }
}

// The record for step data `held` of another agent: on `base`'s spawn fields, under its agentId.
function holding(base: AgentRecord, held: StepData): AgentRecord {
  return clean({ ...without(base, ...STEP_FIELDS), ...held, id: held.agentId as string })
}

// The Agent tool's result names the agentId of the call's spawn, and it outranks any join made from
// hints. The call's record takes that agent's step data, from a provisional record or from another
// record a join gave it to. Step data the call's record held of another agent go back: to the record
// that agent's data came from when two joins crossed (a swap), else to a provisional record of that
// agent, which the provisional rules then keep, surface or drop. A record that gives up its data and
// gets none back waits again under its spawn id. Log entries of both agents are re-pointed.
export function bindAgent(agents: AgentRecord[], toolUseId: string, agentId: string, at: number, roles?: Roles): Outcome {
  const i = agents.findIndex((a) => a.toolUseId === toolUseId && a.runId === undefined && !a.planned && !a.provisional)
  if (i < 0 || agents[i].agentId === agentId) return SAME(agents)
  const r = agents[i]
  const k = agents.findIndex((a, n) => n !== i && a.agentId === agentId)
  const other = k >= 0 ? agents[k] : undefined
  const held = r.agentId !== undefined ? stepData(r) : undefined
  const log: LogEntry[] = []
  let mine: AgentRecord
  if (other) {
    const taken = stepData(other)
    const routed = routeTaken(
      clean({
        ...without(r, ...STEP_FIELDS),
        ...taken,
        id: agentId,
        spawnedAt: other.provisional ? Math.min(r.spawnedAt, other.spawnedAt) : r.spawnedAt,
        // a spawn that held nothing has only its planned cost, which a step never adds to
        estUsd: (held ? 0 : r.estUsd) + taken.estUsd,
      }),
      roles,
    )
    mine = routed.record
    // a provisional record logs no finish: the record that takes its data does
    if (other.provisional && isFinished(mine.status)) log.push(finishEntry(mine, mine.endedAt ?? at))
    log.push(...routed.warnings.map((w) => warnEntry(w, mine, mine.firstStepAt ?? at)))
  } else if (held) mine = clean({ ...without(r, ...STEP_FIELDS), ...NO_STEPS, id: agentId, agentId })
  else mine = clean({ ...r, id: agentId, agentId })
  let out = replaceAt(agents, i, mine)
  if (other && !other.provisional) {
    let theirs: AgentRecord
    if (held) {
      const swapped = routeTaken(holding(other, held), roles)
      theirs = swapped.record
      log.push(...swapped.warnings.map((w) => warnEntry(w, theirs, theirs.firstStepAt ?? at)))
    } else {
      const wf = other.runId !== undefined && other.agentIndex !== undefined ? { runId: other.runId, agentIndex: other.agentIndex } : undefined
      theirs = clean({ ...without(other, ...STEP_FIELDS), ...NO_STEPS, id: spawnRecordId({ toolUseId: other.toolUseId ?? other.id, workflow: wf }) })
    }
    out = replaceAt(out, k, theirs)
  } else {
    const loose = held ? holding(provisional(held.agentId as string, held.firstStepAt ?? at), held) : undefined
    if (other) out = loose ? replaceAt(out, k, loose) : out.filter((_, n) => n !== k)
    else if (loose) out = [...out, loose]
  }
  if (!other && !held) return { agents: out, log, changed: true }
  return { agents: out, log, changed: true, repoint: held ? [agentId, held.agentId as string] : [agentId] }
}

// Log entries of the given record ids take the ref and role of the record that now holds the id
// (its step data moved, bindAgent). A warning's ref is its rule, so only its role is taken.
export function repointLog(log: LogEntry[], agents: AgentRecord[], ids: string[]): LogEntry[] {
  let changed = false
  const out = log.map((l) => {
    if (l.agentId === undefined || ids.indexOf(l.agentId) < 0) return l
    const r = agents.find((a) => a.id === l.agentId)
    if (!r) return l
    const next = clean({ ...without(l, 'role', 'label'), ...(l.kind === 'warn' ? {} : { ref: refOf(r) }), ...roleFields(r) })
    if (JSON.stringify(next) === JSON.stringify(l)) return l
    changed = true
    return next
  })
  return changed ? out : log
}

// An Agent call that came back denied or as an error before its agent ever stepped: the engine
// refused the spawn, so its record goes.
export function dropUnjoined(agents: AgentRecord[], toolUseId: string): Outcome {
  const out = agents.filter((a) => !(a.toolUseId === toolUseId && a.runId === undefined && !a.planned && a.agentId === undefined && a.steps === 0))
  return out.length === agents.length ? SAME(agents) : { agents: out, log: [], changed: true }
}

// The record a first step or a completion of an unknown agentId lands on: the waiting spawn it joins
// (given the agentId), else a new provisional record.
function landing(list: AgentRecord[], agentId: string, at: number, join: JoinHints | undefined): { list: AgentRecord[]; i: number } {
  const j = joinSpawn(list, join ?? { prompts: {} }, at)
  if (j >= 0) return { list: replaceAt(list, j, { ...list[j], id: agentId, agentId }), i: j }
  return { list: [...list, provisional(agentId, at)], i: list.length }
}

// ---------------------------------------------------------------- planned workflow calls (4.2)

export interface PlannedInput {
  ordinal: number // 1-based position of the call in the script
  label?: string // a literal, or a template pattern with `*` for each substitution; absent when dynamic
  phase?: string
  requestedModel?: string
  effort?: string
  warnings: string[] // the call's router warnings (R2)
  unordered?: boolean // the script has a loop, a nested or dynamic call, a function: agentIndex is not the ordinal
}

// The Workflow tool call's agent() calls become queued, planned records, written before the tool
// runs (its agents spawn while it does). They carry the tool_use_id until the run id is known.
export function addPlanned(agents: AgentRecord[], ev: { at: number; toolUseId: string; calls: PlannedInput[]; runTitle?: string; runPhases?: string[] }, ctx: MatchContext): Outcome {
  const kept = agents.filter((a) => !(a.planned && a.toolUseId === ev.toolUseId))
  const added = ev.calls.map((c): AgentRecord => {
    const match = phaseMatch(ctx.plan, { toolUseId: ev.toolUseId }, c.phase) ?? matchAgent(ctx.plan, [anyCase(c.label), c.phase])
    return clean({
      id: 'wf:' + ev.toolUseId + ':' + c.ordinal,
      planned: true as const,
      toolUseId: ev.toolUseId,
      agentIndex: c.ordinal,
      label: c.label,
      phase: c.phase,
      runTitle: ev.runTitle,
      runPhases: ev.runPhases && ev.runPhases.length > 0 ? ev.runPhases : undefined,
      description: c.label ?? 'agent #' + c.ordinal,
      subagentType: 'workflow-subagent',
      taskIds: match.taskIds,
      groupId: match.groupId,
      role: 'workflow-subagent',
      requestedModel: c.requestedModel,
      effort: c.effort,
      unordered: c.unordered === true ? (true as const) : undefined,
      status: 'queued' as const,
      spawnedAt: ev.at,
      steps: 0,
      tokens: { ...ZERO },
      estUsd: 0,
      warnings: c.warnings,
    })
  })
  if (added.length === 0 && kept.length === agents.length) return SAME(agents)
  return { agents: [...kept, ...added], log: [], changed: true }
}

// Gives a tool call's planned records the run id (the join key of plannedFor) once it is known. A
// resumed run keeps its run id: the planned calls an earlier call of that run left go first, so
// their `wf:<runId>:<n>` ids cannot collide with the new plan's.
export function bindRun(agents: AgentRecord[], toolUseId: string, runId: string): Outcome {
  const kept = agents.filter((a) => !(a.planned && a.runId === runId && a.toolUseId !== toolUseId))
  let changed = kept.length !== agents.length
  const out = kept.map((a) => {
    if (!a.planned || a.toolUseId !== toolUseId || a.runId !== undefined) return a
    changed = true
    return { ...a, runId, id: 'wf:' + runId + ':' + a.agentIndex }
  })
  return changed ? { agents: out, log: [], changed } : SAME(agents)
}

// A Workflow call that was denied runs no agents: its planned records go.
export function dropPlanned(agents: AgentRecord[], toolUseId: string): Outcome {
  const out = agents.filter((a) => !(a.planned && a.toolUseId === toolUseId))
  return out.length === agents.length ? SAME(agents) : { agents: out, log: [], changed: true }
}

// ---------------------------------------------------------------- router warnings after the fact (5)

function warnEntry(w: Warning, r: AgentRecord, at: number): LogEntry {
  return { at, kind: 'warn', ref: w.rule, ...roleFields(r), agentId: r.id, detail: warningDetail(w) }
}

// R3 (when R1 fired: the dispatch named no model) and R4 on an agent's first step; marks only, no
// text to Claude. A rule already on the record is not added twice.
function firstStepWarnings(r: AgentRecord, model: string | undefined, effort: string | number | undefined, roles: Roles | undefined): Warning[] {
  if (r.provisional || r.planned) return []
  const found: Warning[] = []
  if (r.warnings.some((w) => w.startsWith('R1 '))) {
    const w = ruleR3({ description: r.description, subagentType: r.subagentType, model }, roles)
    if (w) found.push(w)
  }
  const w4 = ruleR4({ description: r.description, subagentType: r.subagentType, effort }, roles)
  if (w4) found.push(w4)
  return found.filter((w) => !r.warnings.some((x) => x.startsWith(w.rule + ' ')))
}

// `match`: the context a resumed `previous` agent is matched in afresh (5.3); it then drops the mark.
export function stepStart(
  agents: AgentRecord[],
  ev: { at: number; agentId: string; model?: string; effort?: string | number; roles?: Roles; match?: MatchContext; join?: JoinHints },
): Outcome {
  let list = agents
  let i = indexOfAgent(list, ev.agentId)
  if (i < 0) ({ list, i } = landing(list, ev.agentId, ev.at, ev.join))
  const r = list[i]
  // A step for a finished agent is a SendMessage resume (no new agent.spawn fires): it reopens.
  const resumed = isFinished(r.status)
  const base = resumed ? without(r, 'stalledAt', 'endedAt', 'durationMs', 'reason', 'question') : without(r, 'stalledAt')
  const ctx = ev.match
  const rematch: Partial<AgentRecord> =
    r.previous && ctx
      ? (phaseMatch(ctx.plan, r, r.phase) ?? matchAgent(ctx.plan, [anyCase(r.name), anyCase(r.description), anyCase(r.label), r.phase], { temporal: ctx.temporal }))
      : {}
  const next: AgentRecord = clean({
    ...(r.previous && ctx ? without(base, 'previous', 'groupId') : base),
    ...rematch,
    status: 'running' as const,
    firstStepAt: r.firstStepAt ?? ev.at,
    lastStepAt: ev.at,
    steps: r.steps + 1,
    model: ev.model ?? r.model,
    effort: ev.effort !== undefined ? String(ev.effort) : r.effort,
  })
  const log: LogEntry[] = resumed ? [{ at: ev.at, kind: 'resumed', ref: refOf(r), ...roleFields(r), agentId: r.id, detail: 'was ' + r.status }] : []
  let routed = next
  if (r.firstStepAt === undefined) {
    const found = firstStepWarnings(next, next.model, next.effort, ev.roles)
    if (found.length > 0) {
      routed = { ...next, warnings: [...next.warnings, ...found.map(warningString)] }
      log.push(...found.map((w) => warnEntry(w, routed, ev.at)))
    }
  }
  return { agents: replaceAt(list, i, routed), log, changed: true }
}

function addUsage(t: Tokens, u: Usage): Tokens {
  return {
    in: t.in + (u.input_tokens ?? 0),
    out: t.out + (u.output_tokens ?? 0),
    cacheRead: t.cacheRead + (u.cache_read_input_tokens ?? 0),
    cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens ?? 0),
  }
}

// A step's response is in: its usage adds up and is priced (per step, as the haiku-5-5 long-prompt
// tier is), and it counts as activity for the stall rule.
export function stepEnd(agents: AgentRecord[], ev: { at: number; agentId: string; usage: Usage | null }): Outcome {
  const i = indexOfAgent(agents, ev.agentId)
  if (i < 0) return SAME(agents)
  const r = agents[i]
  let next: AgentRecord = ev.usage ? { ...r, tokens: addUsage(r.tokens, ev.usage), estUsd: r.estUsd + costOf(r.model, ev.usage).usd } : r
  if (!isFinished(r.status)) next = { ...without(next, 'stalledAt'), status: 'running', lastStepAt: ev.at }
  return { agents: replaceAt(agents, i, next), log: [], changed: true }
}

export function completeAgent(
  agents: AgentRecord[],
  ev: { at: number; agentId: string; reason: string; answer: string; durationMs: number; usage?: Usage; join?: JoinHints },
): Outcome {
  let list = agents
  let i = indexOfAgent(list, ev.agentId)
  if (i < 0) ({ list, i } = landing(list, ev.agentId, ev.at, ev.join))
  const r = list[i]
  if (isFinished(r.status)) return SAME(agents)
  let status: AgentStatus = 'failed'
  let question: string | undefined
  let reason: string | undefined
  if (ev.reason === 'answer') {
    const why = blockedReason(ev.answer)
    if (why !== undefined) {
      status = 'blocked'
      question = why.slice(0, 200)
    } else status = 'done'
  } else reason = ev.reason
  const counted = r.tokens.in + r.tokens.out + r.tokens.cacheRead + r.tokens.cacheWrite > 0
  const next: AgentRecord = clean({
    ...without(r, 'stalledAt'),
    status,
    reason,
    question,
    endedAt: ev.at,
    durationMs: ev.durationMs,
    tokens: !counted && ev.usage ? addUsage(r.tokens, ev.usage) : r.tokens,
    estUsd: !counted && ev.usage ? r.estUsd + costOf(r.model, ev.usage).usd : r.estUsd,
  })
  return { agents: replaceAt(list, i, next), log: next.provisional ? [] : [finishEntry(next, ev.at)], changed: true }
}

// The stall rule, run by the 15 s timer: queued past `startMs` since spawn, or running past
// `stallMs` since the last step, is stalled. A provisional record nobody spawned is dropped once
// quiet, unless it finished: then it is surfaced (surfaceRetries).
export function tick(agents: AgentRecord[], ev: { at: number; stallMs: number; startMs: number }): Outcome {
  const log: LogEntry[] = []
  let changed = false
  const out: AgentRecord[] = []
  const over = endedRuns(agents, ev.at)
  for (const r of agents) {
    if (r.provisional && isFinished(r.status)) {
      out.push(r)
      continue
    }
    if (r.provisional) {
      const last = Math.max(r.spawnedAt, r.lastStepAt ?? 0, r.endedAt ?? 0)
      if (ev.at - last >= PROVISIONAL_TTL) {
        changed = true
        continue
      }
      out.push(r)
      continue
    }
    if (r.planned) {
      if (!r.skipped && r.runId !== undefined && over.has(r.runId)) {
        out.push({ ...r, skipped: true })
        changed = true
      } else out.push(r)
      continue
    }
    const since = r.status === 'queued' ? r.spawnedAt : r.status === 'running' ? r.lastStepAt ?? r.spawnedAt : undefined
    const limit = r.status === 'queued' ? ev.startMs : ev.stallMs
    if (since !== undefined && ev.at - since >= limit) {
      const next: AgentRecord = { ...r, status: 'stalled', stalledAt: ev.at }
      out.push(next)
      log.push({ at: ev.at, kind: 'stalled', ref: refOf(r), ...roleFields(r), agentId: r.id, detail: 'no step for ' + Math.floor((ev.at - since) / MIN) + 'm' })
      changed = true
      continue
    }
    out.push(r)
  }
  const surfaced = surfaceRetries(out, ev.at)
  if (surfaced.changed) return { agents: surfaced.agents, log: [...log, ...surfaced.log], changed: true }
  return changed ? { agents: out, log, changed } : SAME(agents)
}

// A finished early record no spawn claimed within SURFACE_MS is shown, never dropped: its answer,
// BLOCKED question and cost stay visible. The events carry no run, so it joins a workflow record
// only when exactly one workflow agent is stalled (across every run) and went quiet before the
// retry began: the retry then takes that record's place (label, phase, run, task, warnings) and the
// original is settled as failed, reason `retried`. Otherwise it stands alone, Unassigned.
function surfaceRetries(agents: AgentRecord[], at: number): Outcome {
  const due = agents.filter((r) => r.provisional && isFinished(r.status) && r.endedAt !== undefined && at - r.endedAt >= SURFACE_MS)
  if (due.length === 0) return SAME(agents)
  let list = agents
  const log: LogEntry[] = []
  for (const p of due.slice().sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))) {
    const pi = list.indexOf(p)
    const stalled = list.filter((a) => a.status === 'stalled' && a.runId !== undefined && !a.planned && !a.provisional)
    const orig = stalled.length === 1 && (stalled[0].lastStepAt ?? stalled[0].spawnedAt) <= p.spawnedAt ? stalled[0] : undefined
    let shown: AgentRecord = without(p, 'provisional')
    if (orig) {
      shown = clean({
        ...shown,
        toolUseId: orig.toolUseId,
        runId: orig.runId,
        agentIndex: orig.agentIndex,
        label: orig.label,
        phase: orig.phase,
        runTitle: orig.runTitle,
        runPhases: orig.runPhases,
        name: orig.name,
        description: orig.description,
        subagentType: orig.subagentType,
        taskIds: orig.taskIds,
        groupId: orig.groupId,
        role: orig.role,
        requestedModel: orig.requestedModel,
        warnings: orig.warnings,
      })
      const settled: AgentRecord = { ...without(orig, 'stalledAt'), status: 'failed', reason: 'retried', endedAt: p.spawnedAt }
      list = replaceAt(list, list.indexOf(orig), settled)
      log.push(finishEntry(settled, p.spawnedAt))
    }
    list = replaceAt(list, pi, shown)
    log.push(finishEntry(shown, shown.endedAt ?? at))
  }
  return { agents: list, log, changed: true }
}

// A record reloaded into a new process (claude --resume, an in-session /resume of a session another
// process saved): an agent left queued, running or stalled whose last sign of life predates this
// process can never receive an event, so it is lost, logged once. Blocked, done and failed stay; a
// provisional record from then is dropped. A step that does arrive reopens it (stepStart).
export function settleRestored(agents: AgentRecord[], ev: { at: number; aliveSince: number }): Outcome {
  const log: LogEntry[] = []
  let changed = false
  const out: AgentRecord[] = []
  for (const r of agents) {
    const last = Math.max(r.spawnedAt, r.firstStepAt ?? 0, r.lastStepAt ?? 0, r.endedAt ?? 0)
    if (last >= ev.aliveSince || r.planned) {
      out.push(r)
      continue
    }
    if (r.provisional) {
      changed = true
      continue
    }
    if (isFinished(r.status)) {
      out.push(r)
      continue
    }
    const next: AgentRecord = { ...without(r, 'stalledAt'), status: 'lost', endedAt: r.lastStepAt ?? r.spawnedAt }
    out.push(next)
    log.push({ at: ev.at, kind: 'lost', ref: refOf(r), ...roleFields(r), agentId: r.id, detail: '(session restarted)' })
    changed = true
  }
  return changed ? { agents: out, log, changed } : SAME(agents)
}

// The runs that are over (RUN_QUIET_MS): every agent the run spawned is terminal (lost included),
// and nothing of the run (the call, a spawn, a step, an end) happened for RUN_QUIET_MS.
function endedRuns(agents: AgentRecord[], at: number): Set<string> {
  const last = new Map<string, number>()
  const busy = new Set<string>()
  for (const a of agents) {
    if (a.runId === undefined || a.provisional) continue
    if (!a.planned && !isFinished(a.status)) busy.add(a.runId)
    const t = Math.max(a.spawnedAt, a.lastStepAt ?? 0, a.endedAt ?? 0)
    last.set(a.runId, Math.max(last.get(a.runId) ?? 0, t))
  }
  const over = new Set<string>()
  last.forEach((t, runId) => {
    if (!busy.has(runId) && at - t >= RUN_QUIET_MS) over.add(runId)
  })
  return over
}

// `$.agent.list()` on the timer: catch `failed`/`killed` the events missed, and fill `name`.
export function reconcileList(agents: AgentRecord[], list: Array<{ id: string; status: string; name?: string }>, at: number): Outcome {
  let out = agents
  const log: LogEntry[] = []
  for (const row of list) {
    const i = indexOfAgent(out, row.id)
    if (i < 0 || out[i].provisional) continue
    let r = out[i]
    let touched = false
    if (row.name && !r.name) {
      r = { ...r, name: row.name }
      touched = true
    }
    if ((row.status === 'failed' || row.status === 'killed') && !isFinished(r.status)) {
      r = { ...without(r, 'stalledAt'), status: 'failed', reason: row.status, endedAt: at }
      log.push(finishEntry(r, at))
      touched = true
    }
    if (touched) out = replaceAt(out, i, r)
  }
  return { agents: out, log, changed: out !== agents }
}

// ---------------------------------------------------------------- Plan tree (8.2)

export type NodeStatus = 'active' | 'partial' | 'queued' | 'done' | 'failed'

export interface Loud {
  blocked: number
  stalled: number
}

export interface TaskNode {
  id: string
  title: string
  line?: number
  status: NodeStatus
  partialWord?: string // shown after a partial task's title
  sub?: { done: number; total: number } // the task's own bar when it has a sub-checklist
  agents: AgentRecord[]
  finished: number
  dispatched: number
  loud: Loud
  recent: boolean // an agent of the task finished within RECENT_MS of the clock given to buildTree
}

export interface GroupNode {
  id: string
  title: string
  kind: 'heading' | 'map' | 'run' | 'agents' // run, agents: the unmatched agents of one workflow run, or the plain Agent-tool ones (4.3)
  status: NodeStatus
  tasks: TaskNode[]
  agents: AgentRecord[] // agents that name the group, not a task; for a run or agents group, all of its agents
  finished: number // over the group's own agents and its tasks' agents
  dispatched: number
  tasksDone: number
  tasksTotal: number
  loud: Loud
  recent: boolean // an agent of the group finished within RECENT_MS of the clock given to buildTree
}

export interface PlanTree {
  groups: GroupNode[]
  unassigned: { agents: AgentRecord[] }
  unmapped: number
}

// ---------------------------------------------------------------- unmatched agents (4.3)

export interface LooseGroup {
  id: string // `wf:<runId>` for a workflow run, `agents` for the plain Agent-tool ones
  kind: 'run' | 'agents'
  title: string
  agents: AgentRecord[]
}

export const AGENTS_GROUP = 'agents'
export const RUN_TITLE_MAX = 120

// The id a run's short title uses when its script gave none: the run id without its `wf_` prefix, cut to 6.
export function runShort(id: string): string {
  return id.replace(/^(wf_|toolu_)/, '').slice(0, 6)
}

// Where an agent that matched no task of the plan goes: its workflow run, else the Agents group
// (an Agent-tool call). A record with neither stays Unassigned (undefined), the last resort.
function looseOf(a: AgentRecord): { id: string; kind: 'run' | 'agents' } | undefined {
  if (a.runId !== undefined) return { id: 'wf:' + a.runId, kind: 'run' }
  if (a.planned && a.toolUseId !== undefined) return { id: 'wf:' + a.toolUseId, kind: 'run' }
  if (a.provisional || a.planned) return undefined
  if (a.subagentType !== '' || a.toolUseId !== undefined) return { id: AGENTS_GROUP, kind: 'agents' }
  return undefined
}

export const matchedToPlan = (a: AgentRecord): boolean => a.taskIds[0] !== undefined || a.groupId !== undefined

// The groups of the given unmatched agents, in order of first appearance, and the agents with no
// group. A run's title is the first one any of its records carries, else `Workflow <short run id>`.
export function looseGroups(agents: AgentRecord[]): { groups: LooseGroup[]; rest: AgentRecord[] } {
  const groups = new Map<string, LooseGroup>()
  const rest: AgentRecord[] = []
  for (const a of agents) {
    const k = looseOf(a)
    if (!k) {
      rest.push(a)
      continue
    }
    let g = groups.get(k.id)
    if (!g) {
      g = { id: k.id, kind: k.kind, title: k.kind === 'agents' ? 'Agents' : 'Workflow ' + runShort(k.id.slice(3)), agents: [] }
      groups.set(k.id, g)
    }
    g.agents.push(a)
    if (k.kind === 'run' && a.runTitle !== undefined && g.title === 'Workflow ' + runShort(k.id.slice(3))) g.title = a.runTitle
  }
  return { groups: [...groups.values()], rest }
}

// A workflow agent's run title, for the Agents tab's task column; undefined for any other agent.
export function runTitleOf(a: AgentRecord): string | undefined {
  if (a.runId === undefined && !(a.planned && a.toolUseId !== undefined)) return undefined
  return a.runTitle ?? 'Workflow ' + runShort(a.runId ?? a.toolUseId ?? '')
}

const NODE_RANK: Record<NodeStatus, number> = { active: 0, failed: 1, partial: 2, queued: 3, done: 4 }
// A group whose agents finished this recently sorts right after the active groups (8.2).
export const RECENT_MS = 30 * 60_000

const AGENT_RANK: Record<AgentStatus, number> = { blocked: 0, stalled: 1, running: 2, queued: 3, failed: 4, done: 4, lost: 4 }

// Blocked, stalled, running, queued, then finished newest first; spawn order otherwise.
export function sortAgents(agents: AgentRecord[]): AgentRecord[] {
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const d = AGENT_RANK[x.a.status] - AGENT_RANK[y.a.status]
      if (d !== 0) return d
      if (AGENT_RANK[x.a.status] === 4) {
        const e = (y.a.endedAt ?? 0) - (x.a.endedAt ?? 0)
        if (e !== 0) return e
      }
      return x.i - y.i
    })
    .map((x) => x.a)
}

function loudOf(agents: AgentRecord[]): Loud {
  return {
    blocked: agents.filter((a) => a.status === 'blocked').length,
    stalled: agents.filter((a) => a.status === 'stalled').length,
  }
}

function addLoud(a: Loud, b: Loud): Loud {
  return { blocked: a.blocked + b.blocked, stalled: a.stalled + b.stalled }
}

// Loud nodes first, then active, recent (groups only), partial, queued, done; plan order otherwise.
// `late` nodes (the workflow and Agents groups) follow the others of the same rank.
function sortNodes<T extends { status: NodeStatus; loud: Loud; recent?: boolean }>(nodes: T[], byRecent = false, late?: (n: T) => boolean): T[] {
  const rank = (n: T) => (n.status === 'active' ? 0 : byRecent && n.recent === true ? 1 : NODE_RANK[n.status] + 1)
  return nodes
    .map((n, i) => ({ n, i }))
    .sort((x, y) => {
      const lx = x.n.loud.blocked + x.n.loud.stalled > 0 ? 0 : 1
      const ly = y.n.loud.blocked + y.n.loud.stalled > 0 ? 0 : 1
      if (lx !== ly) return lx - ly
      const d = rank(x.n) - rank(y.n)
      if (d !== 0) return d
      const l = (late?.(x.n) ? 1 : 0) - (late?.(y.n) ? 1 : 0)
      return l !== 0 ? l : x.i - y.i
    })
    .map((x) => x.n)
}

const isRecent = (agents: AgentRecord[], now: number | undefined) =>
  now !== undefined && agents.some((a) => isFinished(a.status) && a.endedAt !== undefined && now - a.endedAt <= RECENT_MS)

function taskNode(id: string, title: string, planStatus: Task['status'] | 'failed' | undefined, agents: AgentRecord[], extra: Partial<TaskNode>, now?: number): TaskNode {
  const finished = agents.filter((a) => isFinished(a.status)).length
  let status: NodeStatus = 'queued'
  if (planStatus === 'done') status = 'done'
  else if (finished < agents.length) status = 'active'
  else if (planStatus === 'failed') status = 'failed'
  else if (planStatus === 'partial') status = 'partial'
  return clean({ id, title, status, agents: sortAgents(agents), finished, dispatched: agents.length, loud: loudOf(agents), recent: isRecent(agents, now), ...extra })
}

export function buildTree(plan: Plan | null, agents: AgentRecord[], now?: number): PlanTree {
  const visible = agents.filter(isShown)
  const byTask = new Map<number, AgentRecord[]>()
  const byGroup = new Map<number, AgentRecord[]>()
  const loose: AgentRecord[] = []
  const push = <K>(m: Map<K, AgentRecord[]>, k: K, a: AgentRecord) => {
    const l = m.get(k)
    if (l) l.push(a)
    else m.set(k, [a])
  }

  for (const a of visible) {
    const tid = a.taskIds[0]
    if (!plan) {
      loose.push(a)
      continue
    }
    if (tid !== undefined) {
      const hits: number[] = []
      plan.tasks.forEach((t, ti) => {
        if (t.id === tid) hits.push(ti)
      })
      const inGroup = a.groupId === undefined ? -1 : hits.find((ti) => plan.tasks[ti].groups.some((gi) => plan.groups[gi].id === a.groupId)) ?? -1
      const ti = inGroup >= 0 ? inGroup : hits[0]
      if (ti === undefined) loose.push(a)
      else push(byTask, ti, a)
      continue
    }
    if (a.groupId !== undefined) {
      const gi = plan.groups.findIndex((g) => g.id === a.groupId)
      if (gi < 0) loose.push(a)
      else push(byGroup, gi, a)
      continue
    }
    loose.push(a)
  }

  const groups: GroupNode[] = (plan?.groups ?? []).map((g, gi) => {
    const tasks = g.tasks.map((ti) => {
      const t = plan!.tasks[ti]
      return taskNode(t.id, t.title, t.failed ? 'failed' : t.status, byTask.get(ti) ?? [], {
        line: t.line,
        sub: t.sub,
        partialWord: t.status === 'partial' ? plan!.partialWord : undefined,
      }, now)
    })
    const own = byGroup.get(gi) ?? []
    const all = [...own, ...tasks.flatMap((t) => t.agents)]
    const finished = all.filter((a) => isFinished(a.status)).length
    const tasksDone = tasks.filter((t) => t.status === 'done').length
    let status: NodeStatus = 'queued'
    if (tasks.length > 0 && tasksDone === tasks.length) status = 'done'
    else if (finished < all.length) status = 'active'
    else if (tasks.some((t) => t.status === 'failed') && tasks.every((t) => t.status === 'done' || t.status === 'failed')) status = 'failed'
    else if (tasks.some((t) => t.status === 'partial')) status = 'partial'
    const loud = tasks.reduce((l, t) => addLoud(l, t.loud), loudOf(own))
    return {
      id: g.id,
      title: g.title,
      kind: g.kind,
      status,
      tasks: sortNodes(tasks),
      agents: sortAgents(own),
      finished,
      dispatched: all.length,
      tasksDone,
      tasksTotal: tasks.length,
      loud,
      recent: isRecent(all, now),
    }
  })

  const placed = looseGroups(loose)
  const runGroups: GroupNode[] = placed.groups.map((lg): GroupNode => {
    const finished = lg.agents.filter((a) => isFinished(a.status)).length
    return {
      id: lg.id,
      title: lg.title,
      kind: lg.kind,
      status: finished < lg.agents.length ? 'active' : 'done',
      tasks: [],
      agents: sortAgents(lg.agents),
      finished,
      dispatched: lg.agents.length,
      tasksDone: 0,
      tasksTotal: 0,
      loud: loudOf(lg.agents),
      recent: isRecent(lg.agents, now),
    }
  })

  return {
    groups: sortNodes([...groups, ...runGroups], true, (g) => g.kind === 'run' || g.kind === 'agents'),
    unassigned: { agents: sortAgents(placed.rest) },
    unmapped: plan?.unmapped ?? 0,
  }
}

// ---------------------------------------------------------------- band line 2 (sections 2 and 8.1)

export interface BandCurrent {
  current?: { id: string; title: string; done: number; total: number; unit: 'agents' | 'items'; status?: 'partial' | 'done' } // status: a partial task no agent works, or a done task (its bar is drawn done)
  allDone?: true // every task of the plan is done and no agent is at work: line 2 reads `all done`, no task is current
  marks: { warned?: number; blocked?: number; running?: number; stalled?: number }
}

function nodeKey(a: AgentRecord): string {
  const tid = a.taskIds[0]
  if (tid !== undefined) return 't:' + tid + '\u0000' + (a.groupId ?? '')
  if (a.groupId !== undefined) return 'g:' + a.groupId
  const loose = looseOf(a)
  return loose ? 'l:' + loose.id : 'u'
}

// The current task (2): the task (or group) the `focus` action named, until the next spawn; else
// that of the most recently spawned agent that is not finished, a plan task's before an unmatched
// workflow or Agents group's; if none, that of the most recent completion. Its bar is agents finished / dispatched, or the task's own sub-checklist. Marks count
// blocked, running and stalled agents plan-wide.
// Between an agent on a plan task and any other agent comes the plan's one partial task, for a source
// that reports it (`partialSource`: reported, plan-mode, task tools; SPEC 3).
export function bandCurrent(plan: Plan | null, agents: AgentRecord[], focus?: string | null, opts: { partialSource?: boolean } = {}): BandCurrent {
  const spawned = agents.filter((a) => !a.provisional && !a.planned)
  const marks: BandCurrent['marks'] = {}
  const count = (s: AgentStatus) => spawned.filter((a) => a.status === s).length
  const warned = spawned.filter((a) => !isFinished(a.status) && a.warnings.length > 0).length
  if (warned > 0) marks.warned = warned
  if (count('blocked') > 0) marks.blocked = count('blocked')
  if (count('running') > 0) marks.running = count('running')
  if (count('stalled') > 0) marks.stalled = count('stalled')

  if (plan && plan.tasks.length > 0 && plan.tasks.every((t) => t.status === 'done') && !spawned.some((a) => !isFinished(a.status))) return { allDone: true, marks }

  const focused = plan && focus ? focusedCurrent(plan, spawned, focus) : undefined
  if (focused) return { current: focused, marks }

  // a lost agent ended with no completion: it names no current task
  const candidates = spawned.filter((a) => a.status !== 'lost')
  let pick: AgentRecord | undefined
  for (const a of candidates) if (!isFinished(a.status) && matchedToPlan(a) && (!pick || a.spawnedAt >= pick.spawnedAt)) pick = a
  if (!pick && opts.partialSource && plan) {
    const partial = plan.tasks.filter((t) => t.status === 'partial')
    const current = partial.length === 1 ? focusedCurrent(plan, spawned, partial[0].id) : undefined
    if (current) return { current, marks }
  }
  if (!pick) for (const a of candidates) if (!isFinished(a.status) && (!pick || a.spawnedAt >= pick.spawnedAt)) pick = a
  if (!pick) for (const a of candidates) if (!pick || (a.endedAt ?? 0) >= (pick.endedAt ?? 0)) pick = a
  if (!pick) return { marks }

  const key = nodeKey(pick)
  const same = spawned.filter((a) => nodeKey(a) === key)
  const done = same.filter((a) => isFinished(a.status)).length
  const byAgents = { done, total: same.length, unit: 'agents' as const }
  const tid = pick.taskIds[0]
  if (tid !== undefined) {
    const hits = plan ? plan.tasks.filter((t) => t.id === tid) : []
    const task = hits.find((t) => t.groups.some((gi) => plan!.groups[gi].id === pick!.groupId)) ?? hits[0]
    const done = task?.status === 'done' ? { status: 'done' as const } : {}
    if (task?.sub) return { current: { id: tid, title: task.title, done: task.sub.done, total: task.sub.total, unit: 'items', ...done }, marks }
    return { current: { id: tid, title: task?.title ?? '', ...byAgents, ...done }, marks }
  }
  if (pick.groupId !== undefined) {
    const g = plan?.groups.find((x) => x.id === pick!.groupId)
    return { current: { id: pick.groupId, title: g?.title ?? '', ...byAgents, ...(g && plan && groupDone(plan, g) ? { status: 'done' as const } : {}) }, marks }
  }
  const loose = looseOf(pick)
  if (loose) {
    // an unmatched run or Agents group: its title stands in for the id, and its bar counts the group's agents
    const title = looseGroups(agents.filter((a) => nodeKey(a) === key)).groups[0]?.title ?? ''
    return { current: { id: title, title: '', ...byAgents }, marks }
  }
  return { current: { id: 'Unassigned', title: '', ...byAgents }, marks }
}

const groupDone = (plan: Plan, g: Plan['groups'][number]) => g.tasks.length > 0 && g.tasks.every((ti) => plan.tasks[ti].status === 'done')

function focusedCurrent(plan: Plan, spawned: AgentRecord[], id: string): BandCurrent['current'] {
  const finished = (list: AgentRecord[]) => ({ done: list.filter((a) => isFinished(a.status)).length, total: list.length, unit: 'agents' as const })
  const task = plan.tasks.find((t) => t.id === id)
  if (task) {
    const done = task.status === 'done' ? { status: 'done' as const } : {}
    if (task.sub) return { id, title: task.title, done: task.sub.done, total: task.sub.total, unit: 'items', ...done }
    const own = finished(spawned.filter((a) => a.taskIds[0] === id))
    return { id, title: task.title, ...own, ...(own.total === 0 && task.status === 'partial' ? { status: 'partial' as const } : done) }
  }
  const group = plan.groups.find((g) => g.id === id)
  if (!group) return undefined
  const ids = new Set(group.tasks.map((ti) => plan.tasks[ti].id))
  const mine = spawned.filter((a) => a.groupId === id || (a.taskIds[0] !== undefined && ids.has(a.taskIds[0])))
  return { id, title: group.title, ...finished(mine), ...(groupDone(plan, group) ? { status: 'done' as const } : {}) }
}
