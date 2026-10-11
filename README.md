# headway

**Goal, tasks and agents above your Claude Code prompt — zero setup.**

[![version](https://img.shields.io/github/v/tag/atharv6f/headway?label=version&sort=semver)](https://github.com/atharv6f/headway/tags)
[![licence MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Claude Code 2.1.287+](https://img.shields.io/badge/Claude%20Code-2.1.287%2B%20mod-d97757.svg)](plugin/README.md#compatibility-and-known-limits)

![headway: the band above the prompt, then the pane](docs/demo.gif)

Type a prompt that asks for more than one thing. Claude reports the steps; headway draws the goal,
the step it is on, every subagent under the step it works on, who is blocked or stalled, and what the
session costs. No plan file needed; pin one if you keep one.

## Install

Inside Claude Code:

```
/plugin marketplace add atharv6f/headway
/plugin install headway@headway
```

then restart Claude Code. Needs Claude Code 2.1.287 or later. No dependencies.

Update with `claude plugin marketplace update headway` and `claude plugin update headway@headway`,
then restart.

## What you get

- **A band above the prompt, always on.** Line 1 the goal and its progress, line 2 the current step
  and its agents, line 3 context fill, the exact session cost and the newest event.

  ![the band: goal, current step, context and cost](docs/screenshots/band.png)

- **A Plan tab** (`/headway`): the tree of groups, steps and the agents under each. The plan comes
  from the first of these that has data: a plan file you pin, the list Claude reports, a plan you
  approve in plan mode, Claude's task tools, or a Workflow's phases.

  ![the Plan tab: groups, steps, agents under each](docs/screenshots/pane-plan.png)

- **An Agents tab:** every subagent with its status, model and effort, elapsed time and estimated
  cost; blocked and stalled ones called out, each with the short id `SendMessage` takes.

  ![the Agents tab: status, model, elapsed, estimated cost](docs/screenshots/pane-agents.png)

- **Workflow phases as the plan.** A Workflow script that declares `meta.phases` is tracked as one
  group, one task per phase, each `agent()` call under its phase.

  ![a Workflow run: phases as tasks, agents under each](docs/screenshots/workflow-phases.png)

- **Router warnings.** A dispatch that names no model, a Workflow `agent()` without model or effort,
  or a role sent to a model your role file does not allow gets an amber `⚠`, a toast and one line in
  Claude's context so the next dispatch is right. Warnings never block a call.

  ![a router warning on an Agent dispatch](docs/screenshots/warning.png)

- **Quiet transcript rows and a small footprint.** headway's own tool calls draw as one dim line
  each, not a JSON block. It never writes a file of yours, never denies or rewrites a tool call,
  makes no network request and runs no subprocess. [Trust](plugin/README.md#trust) lists everything it reads,
  and [What the hooks do](plugin/README.md#what-the-hooks-do) every hook.

## Why headway

The nearest mods, as their READMEs and the awesome-claude-code-mods scanner data described them on
2026-10-10. "yes" and "no" are what a README says; "—" means its README does not describe the point.
Found a row that is wrong? Open an issue.

| | headway | [Flightdeck](https://github.com/scasella/claude-flightdeck) | [plan-progress](https://github.com/zycck/claude-mods) | [savvy-progress](https://github.com/JohnnyVizz/claude-kit) | [GlanceFlow](https://github.com/Antreas-Strb/glanceflow) |
| :- | :- | :- | :- | :- | :- |
| Works from a plain prompt, no plan file | yes | no plan concept; observes events | yes | through the author's savvy-flow skill | yes |
| Pins a plan file you keep (checklist or table), read and never written | yes | — | no | — | no |
| Plan-mode plan as the source | yes | no | yes | — | — |
| Claude's task tools as the source | yes (opt-in in Claude Code) | — | — | — | — |
| Workflow phases as the plan | yes | workflow agents shown, not as a plan | — | — | — |
| Agents grouped under their step | yes, by step id | cards and swimlanes, no steps | yes | agent panel | yes |
| Model and effort warnings on a dispatch | yes, plus an optional role file | no | — | — | — |
| Session cost | exact, from the engine ledger | yes | no | its own estimate | per job, where Claude Code keeps a cost |
| Per-agent cost | estimate, labelled `est.` | no | no | estimate | per job |
| Network calls | none | none | none in the scanner call list | none in the scanner call list | none in the call list; one Haiku model call per job |
| Subprocesses | none | none | `$.process.run` | none in the scanner call list | `$.process.run` |

What headway adds to Claude's context, in full, is quoted in [Trust](plugin/README.md#trust): one 153-word guidance
section per session and a 50-word note at a plan-mode approval.

## Quickstart (60 seconds)

No setup. In any directory, type a prompt that asks for more than one thing:

```
Create hello.py that prints a greeting, add a --name flag to it, then write a test for it.
```

Claude calls the `headway` tool once with the three steps, then marks each one as it starts and
finishes. The band appears above your prompt:

```
 ◆ Add a --name flag to hello.py  ██████████▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░  done 1 · partial 1 · open 1 / 3  reported
 ▸ 2 Add a --name flag            ◐ in progress
 ctx 6%  $0.04   ✓ 1 done
```

and ends at `3/3 done`. The goal label is the short title Claude passes with the list (six words at
most), else the first line of your prompt. The dim word after the count (`reported`) names where the
plan came from. `/headway` opens the pane, `1`–`4` switch tabs, `q` closes it. A prompt that asks for
one thing draws nothing.

## Documentation

The full reference is the plugin's own README, [plugin/README.md](plugin/README.md), which is also
the description the Claude plugin directory shows:

- [Plan sources](plugin/README.md#plan-sources): a pinned plan file, a list Claude reports, a
  plan-mode plan, Claude's task tools, a Workflow's phases, and how an agent is matched to a step
- [Commands and keys](plugin/README.md#commands-and-keys) and [Settings](plugin/README.md#settings)
- [Router warnings](plugin/README.md#router-warnings) and [Cost and usage](plugin/README.md#cost-and-usage)
- [Trust](plugin/README.md#trust): everything headway reads and writes, and the text it adds to
  Claude's context
- [What the hooks do](plugin/README.md#what-the-hooks-do): one row per hook
- [Compatibility and known limits](plugin/README.md#compatibility-and-known-limits) and
  [Troubleshooting](plugin/README.md#troubleshooting)

## Contributing

Dev loop, tests, strict validation and the release steps are in [CONTRIBUTING.md](CONTRIBUTING.md).
The design is [SPEC.md](SPEC.md); the code is the source of truth where the two differ.

## Licence

MIT. See [LICENSE](LICENSE).
