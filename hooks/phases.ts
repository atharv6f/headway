// Workflow phases as a plan source (pure). SPEC.md 4.6. The source is derived from the agent
// records, which carry the run's `meta.phases` (runPhases), title (runTitle) and each call's phase;
// nothing of it is stored apart from them.
import { isShown, isTerminal, runShort } from './agents.ts'
import type { AgentRecord } from './agents.ts'
import type { Plan, Task } from './plan.ts'
import { buildPlan } from './planbuild.ts'

// A phase's status: a task's, or `failed` (every call settled, one's latest attempt failed).
export type PhaseStatus = Task['status'] | 'failed'

export interface PhaseRun {
  runId?: string
  toolUseId?: string
  title?: string // meta.description, else meta.name
  phases: Array<{ name: string; status: PhaseStatus }>
  at?: number // the newest call or spawn of the run (SPEC 4.1: newer data than a finished list above)
}

// The most recent run whose script declared phases, by the order its records first appear (a
// call's planned records are written when it is made); null when no run did. The run's end changes
// nothing: it stays the source until a newer run with phases replaces it or a higher source hides it.
export function phaseRun(agents: AgentRecord[]): PhaseRun | null {
  const runs = new Map<string, AgentRecord[]>()
  for (const a of agents) {
    const key = a.toolUseId ?? a.runId
    if (a.provisional || key === undefined) continue
    const list = runs.get(key)
    if (list) list.push(a)
    else runs.set(key, [a])
  }
  let latest: AgentRecord[] | undefined
  runs.forEach((list) => {
    if (list.some((a) => a.runPhases !== undefined)) latest = list
  })
  if (!latest) return null
  const names = [...new Set(latest.find((a) => a.runPhases !== undefined)!.runPhases)]
  const run: PhaseRun = {
    phases: names.map((name) => ({ name, status: phaseStatus(latest!.filter((a) => a.phase === name && isShown(a))) })),
    at: Math.max(...latest.map((a) => a.spawnedAt)),
  }
  const withRun = latest.find((a) => a.runId !== undefined)
  if (withRun) run.runId = withRun.runId
  const withCall = latest.find((a) => a.toolUseId !== undefined)
  if (withCall) run.toolUseId = withCall.toolUseId
  const title = latest.find((a) => a.runTitle !== undefined)?.runTitle
  if (title !== undefined) run.title = title
  return run
}

// Judged per planned call by its latest attempt (a retry surfaced in a stalled call's place shares its
// agentIndex and label): partial while a call's latest attempt has spawned and is not over; open
// while a call has not spawned, or with no call (a skipped one is not counted); once every call's
// latest attempt is over, failed when one failed, else done when one is done, else (every one lost)
// open. A lost attempt, settled by a restart, fails nothing.
function phaseStatus(agents: AgentRecord[]): PhaseStatus {
  const latest = new Map<string, AgentRecord>()
  for (const a of agents) {
    const key = a.planned ? 'p:' + a.id : a.agentIndex !== undefined ? 'i:' + a.agentIndex : 'l:' + (a.label ?? a.id)
    const seen = latest.get(key)
    if (!seen || a.spawnedAt >= seen.spawnedAt) latest.set(key, a)
  }
  const calls = [...latest.values()]
  if (calls.some((a) => !a.planned && !isTerminal(a.status))) return 'partial'
  if (calls.length === 0 || calls.some((a) => a.planned)) return 'open'
  if (calls.some((a) => a.status === 'failed')) return 'failed'
  return calls.some((a) => a.status === 'done') ? 'done' : 'open'
}

// The run as a plan: one group named after the run (never an ID to match), a task per phase.
export function phasePlan(run: PhaseRun): Plan {
  // a failed phase is not done: it counts as open toward the goal and is drawn failed
  const tasks: Task[] = run.phases.map((p, i) => ({ id: p.name, title: '', ordinal: i + 1, line: 0, shape: 'checklist', status: p.status === 'failed' ? 'open' : p.status, groups: [0], ...(p.status === 'failed' ? { failed: true as const } : {}) }))
  return {
    ...buildPlan({
      section: run.title ?? '',
      tasks,
      groups: [{ id: run.title ?? 'Workflow ' + runShort(run.runId ?? run.toolUseId ?? ''), title: '', kind: 'heading', own: true, tasks: tasks.map((_, i) => i) }],
    }),
    phaseRun: { ...(run.runId !== undefined ? { runId: run.runId } : {}), ...(run.toolUseId !== undefined ? { toolUseId: run.toolUseId } : {}) },
  }
}
