// The `$.state` atoms. The validator wants this file self-contained, so the shapes are written out
// here; the sources they mirror are pin.ts (Filter), agents.ts (AgentRecord, LogEntry), band.tsx
// (the goal summary), theme.ts (Theme), pane.tsx (UiState, UsageData), tool.ts (Reported) and
// planmode.ts (PlanMode, with the plan text beside it).
declare module 'claude-code' {
  interface PluginState {
    waypoint: {
      filter: {
        file: string
        section?: string
        doneRule?: string
        partial?: string
        groupMap?: string
        pattern?: string
      } | null
      report: {
        title?: string
        tasks: Array<{ id: string; title: string; status: 'open' | 'partial' | 'done' }>
        doneAt?: number
      } | null
      plan: {
        title?: string
        groups: Array<{ id: string; title: string; own?: true }>
        steps: Array<{ id: string; title: string; status: 'open' | 'partial' | 'done'; group: number; sub?: { done: number; total: number } }>
        doneAt?: number
        text?: string
      } | null
      tasks: Array<{ id: string; title: string; status: 'open' | 'partial' | 'done'; at?: number }> | null
      label: { reported?: string; plan?: string; tasks?: string; phases?: string }
      prompt: string | null
      focus: string | null
      goal: {
        label: string
        done: number
        partial: number
        open: number
        total: number
        doneWord: string
        partialWord?: string
        noDoneRule: boolean
        error?: string
        source?: 'file' | 'reported' | 'plan' | 'tasks' | 'phases'
      } | null
      theme: {
        name: string
        ansi: boolean
        light: boolean
        icons: 'unicode' | 'ascii'
        colors: Record<string, string | null>
        dim: string[]
        glyphs: Record<string, string>
      } | null
      agents: Array<{
        id: string
        toolUseId?: string
        agentId?: string
        runId?: string
        agentIndex?: number
        label?: string
        phase?: string
        runTitle?: string
        runPhases?: string[]
        name?: string
        description: string
        subagentType: string
        taskIds: string[]
        groupId?: string
        outside?: true
        role: string
        requestedModel?: string
        model?: string
        effort?: string
        status: 'queued' | 'running' | 'stalled' | 'blocked' | 'failed' | 'done' | 'lost'
        reason?: string
        question?: string
        spawnedAt: number
        firstStepAt?: number
        lastStepAt?: number
        stalledAt?: number
        endedAt?: number
        durationMs?: number
        steps: number
        tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
        estUsd: number
        warnings: string[]
        planned?: true
        skipped?: true
        unordered?: true
        provisional?: true
        previous?: true
      }>
      log: Array<{
        at: number
        kind: 'done' | 'failed' | 'blocked' | 'stalled' | 'lost' | 'resumed' | 'task-done' | 'task-partial' | 'task-reopened' | 'pin' | 'unpin' | 'report' | 'plan' | 'warn'
        ref: string
        role?: string
        agentId?: string
        detail?: string
        durationMs?: number
        estUsd?: number
      }>
      ui: {
        tab: 'plan' | 'agents' | 'log' | 'usage'
        hideDone: boolean
        open: Record<string, boolean>
        opened: boolean
      }
      usage: {
        percent?: number
        tokens?: number
        window?: number
        usd?: number
        hint?: 'compact-at-next-boundary' | 'compact-now' | null
      } | null
    }
  }
}
