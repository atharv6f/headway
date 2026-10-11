// The plan an in-memory source stands for (pure): one constructor for the reported list, the
// plan-mode plan, the task-tool list and the workflow phases, the status counts they share, and the
// bound a drawn plan is held to (SPEC 4.3, 12). Calls no `$`.
import { clean, TASKS_MAX, TITLE_MAX } from './format.ts'
import type { Group, Plan, Status, Task } from './plan.ts'

export function countStatuses(tasks: Array<{ status: Status }>): Plan['counts'] {
  const counts = { done: 0, partial: 0, open: 0, total: tasks.length }
  for (const t of tasks) counts[t.status]++
  return counts
}

// `partialWord`: the plan names its partial tasks (a reported list, a plan-mode plan) once one exists.
export function buildPlan(o: { section: string; tasks: Task[]; groups: Group[]; partialWord?: true }): Plan {
  const counts = countStatuses(o.tasks)
  return {
    section: o.section,
    tasks: o.tasks,
    groups: o.groups,
    counts,
    doneWord: 'done',
    ...(o.partialWord && counts.partial > 0 ? { partialWord: 'partial' } : {}),
    noDoneRule: false,
    unmapped: 0,
    unmappedIds: [],
  }
}

const tidy = (s: string) => clean(s, TITLE_MAX)

// A source's plan as it is drawn: at most TASKS_MAX tasks, every id, title and heading one clean line
// of at most TITLE_MAX characters. The model wrote these lists; a plan inside both is returned as it is.
export function boundPlan(plan: Plan): Plan {
  const cut = plan.tasks.length > TASKS_MAX
  const tasks = cut ? plan.tasks.slice(0, TASKS_MAX) : plan.tasks
  const section = tidy(plan.section)
  const ids = tasks.map((t) => tidy(t.id))
  const titles = tasks.map((t) => tidy(t.title))
  const groupIds = plan.groups.map((g) => tidy(g.id))
  const groupTitles = plan.groups.map((g) => tidy(g.title))
  const same =
    !cut &&
    section === plan.section &&
    tasks.every((t, i) => ids[i] === t.id && titles[i] === t.title) &&
    plan.groups.every((g, i) => groupIds[i] === g.id && groupTitles[i] === g.title)
  if (same) return plan
  return {
    ...plan,
    section,
    tasks: tasks.map((t, i) => ({ ...t, id: ids[i], title: titles[i] })),
    groups: plan.groups.map((g, i) => ({ ...g, id: groupIds[i], title: groupTitles[i], tasks: cut ? g.tasks.filter((ti) => ti < TASKS_MAX) : g.tasks })),
    counts: cut ? countStatuses(tasks) : plan.counts,
  }
}
