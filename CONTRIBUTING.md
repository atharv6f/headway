# Contributing to headway

headway is a Claude Code mod: a plugin whose one hooks module (`plugin/hooks/register.tsx`)
registers every hook, and a set of pure modules beside it. [SPEC.md](SPEC.md) is the design; the
code is the source of truth where the two differ, and a pull request that changes behaviour updates
both.

## Layout

The plugin is the `plugin/` folder: its manifest (`plugin/.claude-plugin/plugin.json`, with the
listing icon beside it), the hooks module and its pure modules (`plugin/hooks/`), the `$.state`
contract (`plugin/types/index.d.ts`), its README and its LICENSE. That folder is all a user
installs and all the Claude plugin directory reads. Everything else stays at the repository root,
outside what ships: the marketplace manifest (`.claude-plugin/marketplace.json`, whose one entry
has `source: "./plugin"`), the tests, the docs and media, SPEC.md and this file. Keep it that way:
a test, a script or an image inside `plugin/` is shipped to every user and scanned as part of the
plugin.

## The dev loop

Run your checkout as an inline plugin, from the repository root:

```
claude --plugin-dir plugin
```

If you also have headway installed from the marketplace, two copies would load and both would
draw. Disable the installed one for the session:

```
claude --plugin-dir plugin --settings '{"enabledPlugins":{"headway@headway":false}}'
```

An inline plugin is `headway@inline`; its settings come from `--settings` as
`{"pluginConfigs":{"headway@inline":{"options":{"compactAtPercent":1}}}}` (that example forces
the compact hint early). Hook faults go to the debug log (`$.ui.log(..., { to: 'debug' })`), so
`claude --debug` shows them.

## Tests

```
scripts/test.sh
```

runs every `tests/*.test.ts` in an environment like the one the hooks run in; a test imports its
kit from `claude-code/testing` and the modules under test from `../plugin/hooks/`. `claude plugin
test` runs only the tests under the plugin folder it is given, and the tests stay outside
`plugin/` so they are not shipped; the script copies `plugin/` and `tests/` into a temporary
folder, points the imports at the copy and runs `claude plugin test` there. The rules for
fixtures:

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
claude plugin validate plugin --strict
claude plugin validate . --strict
```

must both pass before every commit. Strict mode treats warnings as errors; the first checks the
plugin manifest, `hooks/hooks.json` and `types/index.d.ts` and runs the static analyser over the
hooks module, the second the marketplace manifest. The manifest's `types` field names the `$.state`
contract for this validator (it fails every atom as undeclared without it); the Claude plugin
directory's validation reports the same field as unknown, a warning that does not block a
submission. The analyser's rules, which shape the code layout:

- **`$` stays in `register.tsx`.** The engine handle `$` may be passed only to top-level functions
  defined in `hooks/register.tsx`, never to an imported function. The other modules in `hooks/`
  take plain data and return plain data; that is what makes them testable without an engine.
- **Relative imports only.** `import ... from './plan.ts'`; no `require`, no dynamic `import()`,
  no bare package names.
- **One hook per event and matcher.** A second `on('<event>', { <same matcher> })` in the module is
  refused. `ui.render` serves the band and the pane through `component: ['AbovePrompt', 'Pane']`, and
  the transcript rows of headway's own tool through `component: ['ToolUse', 'ToolResult']` with a
  `props: { tool }` matcher; the `tool.call` hooks are distinct `{ tool }` matchers on the one event.
- **Gating hooks catch their own faults.** A hook that stands between the engine and a tool call
  or a spawn ends in `.catch(($, e, next) => next(e))`, so a bug in headway never blocks the
  work it is watching.
- **`agent.spawn` passes the spawn on as it came.** Its hook records the spawn from the event and
  ends in `return next(e)`, with no use of what `next` answers; the directory requires that of
  every hook on `agent.spawn` (and on `config.set`, `agent.register`, `command.run` other than a
  command the plugin registers itself, and `fs.write`). The agent's id is joined to the record
  later, at its first step (see `joinSpawn` in `plugin/hooks/agents.ts`).

## Adding a plan source

The source precedence is one ordered table in `plugin/hooks/sources.ts`. A new source is one row there
(its tag, its has-data test, its plan and title) plus the hook in `register.tsx` that writes its
data, a `$.state` atom if the data must survive `/compact`, and a field in the saved session
record (`plugin/hooks/persist.ts`) if it must survive a restart. The band, the pane and the `state`
block read the table and need no change. Add a fixture and a test for the source's shapes, and a
row to the sources table in SPEC.md section 4.1 and in `plugin/README.md`.

## The demo

`docs/demo.gif` is rendered from `docs/demo.tape` with [vhs](https://github.com/charmbracelet/vhs)
and records a real Claude Code session in an empty scratch directory. Re-render it after a change
to the band or the pane. To record from a checkout rather than an installed copy, replace the
`claude` line in a copy of the tape with the dev-loop command above; keep the committed tape on
plain `claude`.

## Releasing

1. Bump `version` in `plugin/.claude-plugin/plugin.json` (a manifest change reaches an installed copy only
   through `claude plugin update headway@headway` plus a restart, so every behaviour change that
   users should see ships with a bump).
2. Run `scripts/test.sh` and both strict validations.
3. Commit, tag `v<version>`, push the tag. The marketplace is this repository, so the tag is the
   release; a GitHub release note is optional.
