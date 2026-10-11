# Contributing to waypoint

waypoint is a Claude Code mod: a plugin whose one hooks module (`hooks/register.tsx`) registers
every hook, and a set of pure modules beside it. [SPEC.md](SPEC.md) is the design; the code is
the source of truth where the two differ, and a pull request that changes behaviour updates both.

## The dev loop

Run your checkout as an inline plugin, from the repository root:

```
claude --plugin-dir .
```

If you also have waypoint installed from the marketplace, two copies would load and both would
draw. Disable the installed one for the session:

```
claude --plugin-dir . --settings '{"enabledPlugins":{"waypoint@waypoint":false}}'
```

An inline plugin is `waypoint@inline`; its settings come from `--settings` as
`{"pluginConfigs":{"waypoint@inline":{"options":{"compactAtPercent":1}}}}` (that example forces
the compact hint early). Hook faults go to the debug log (`$.ui.log(..., { to: 'debug' })`), so
`claude --debug` shows them.

## Tests

```
claude plugin test
```

runs every `tests/*.test.ts` in an environment like the one the hooks run in; a test imports its
kit from `claude-code/testing`. The rules for fixtures:

- **Every fixture is synthetic.** Write the text for the test. Nothing under `tests/fixtures/` may
  be copied from a real project, plan or transcript, and no fixture may name a person, a company
  or a path on someone's machine.
- **Expected counts are computed, not typed.** `tests/count.ts` counts a fixture independently
  of the parser under test; a test compares the parser to that count rather than to a number
  written by hand.
- **Assert what the fixture caused.** A test passes on a positive outcome (the task flipped, the
  warning fired, the agent landed under its step), never on the absence of a mark.

## Validate

```
claude plugin validate . --strict
```

must pass before every commit. Strict mode treats warnings as errors; it checks the two manifests
in `.claude-plugin/`, `hooks/hooks.json`, `types/index.d.ts`, and runs the static analyser over
the hooks module. The analyser's rules, which shape the code layout:

- **`$` stays in `register.tsx`.** The engine handle `$` may be passed only to top-level functions
  defined in `hooks/register.tsx`, never to an imported function. The other modules in `hooks/`
  take plain data and return plain data; that is what makes them testable without an engine.
- **Relative imports only.** `import ... from './plan.ts'`; no `require`, no dynamic `import()`,
  no bare package names.
- **One hook per event and matcher.** A second `on('<event>', { <same matcher> })` in the module is
  refused. `ui.render` serves the band and the pane through `component: ['AbovePrompt', 'Pane']`, and
  the transcript rows of waypoint's own tool through `component: ['ToolUse', 'ToolResult']` with a
  `props: { tool }` matcher; the `tool.call` hooks are distinct `{ tool }` matchers on the one event.
- **Gating hooks catch their own faults.** A hook that stands between the engine and a tool call
  or a spawn ends in `.catch(($, e, next) => next(e))`, so a bug in waypoint never blocks the
  work it is watching.

## Adding a plan source

The source precedence is one ordered table in `hooks/sources.ts`. A new source is one row there
(its tag, its has-data test, its plan and title) plus the hook in `register.tsx` that writes its
data, a `$.state` atom if the data must survive `/compact`, and a field in the saved session
record (`hooks/persist.ts`) if it must survive a restart. The band, the pane and the `state`
block read the table and need no change. Add a fixture and a test for the source's shapes, and a
row to the sources table in SPEC.md section 4.1 and in the README.

## The demo

`docs/demo.gif` is rendered from `docs/demo.tape` with [vhs](https://github.com/charmbracelet/vhs)
and records a real Claude Code session in an empty scratch directory. Re-render it after a change
to the band or the pane. To record from a checkout rather than an installed copy, replace the
`claude` line in a copy of the tape with the dev-loop command above; keep the committed tape on
plain `claude`.

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json` (a manifest change reaches an installed copy only
   through `claude plugin update waypoint@waypoint` plus a restart, so every behaviour change that
   users should see ships with a bump).
2. Run the tests and the strict validation.
3. Commit, tag `v<version>`, push the tag. The marketplace is this repository, so the tag is the
   release; a GitHub release note is optional.
