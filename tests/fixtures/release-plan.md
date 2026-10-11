# Dark mode has no offline proof, and the sync badge it cannot show is the symptom

> **For agentic workers:** REQUIRED SUB-SKILL: `executing-plans` or `subagent-driven-development`.
> Steps use checkbox (`- [ ]`) syntax.
> **Do not start A2 without A1 green.** A1 is what makes a measurement of A2 mean anything: until
> a theme override exists in the sample app, every A2 result is read off a build where nothing
> could change colour.

**Goal:** `scenario-dark-mode-offline` shows, on a real device and against the real sync service,
that the app switches theme while its sibling screens keep working, and writes a report whose every
assertion is a **positive observation the run caused**, not an expectation the plan restated.

**Why this is not a report bug.** The scenario fails with *"a theme report needs the per-screen
colours the renderer recorded, and none were observed"*. That refusal is correct and is the only
thing currently protecting the claim. The defect it reports is one layer down: **the sample app
configures no theme override at all**, so no screen ever changes colour, so there is nothing to
record. Fixing the report writer would produce a green proof of nothing.

---

## Part 0 — What the review established

Measured 2026-09-10 against `registry.example.com/todo/sync-service:v2.4.1` on a clean device,
driving the real scenario with a real test account.

### 0.1 · The renderer records per-screen colours correctly. This is not the gap.

Two writers of `todo.audit.colour.v1` exist and both work:

| writer | path | carries |
|---|---|---|
| `internal/render/paint.go:416` | the cache-miss paint | `ScreenID`, `Colour`, `Reason`, `Source=renderer` |
| `internal/processors/theme/processor.go:91` | a late theme change arriving as a `ThemeEvent` | `ScreenID` (`:78`), `Colour=DARK`, `Source=settings`, reason |

The theme processor is wired (`cmd/todo-app/main.go:848`), the settings screen does emit
`THEME_CHANGED` on its toggle path (`settings.ts:619`), and `theme/events.go` classifies exactly that
event as one that writes a colour record.

**So a switched screen DOES produce a per-screen record today.** Any plan that begins "teach the
renderer to record theme changes" is solving a problem that is already solved.

### 0.2 · Nothing in the sample app can switch.

`samples/inbox/config/app.yaml`, in full:

```yaml
account: ${env:TODO_ACCOUNT}
sync_service: ${env:TODO_SYNC}
screens: []
display:
  max_lists: 40
```

One global ceiling of 40 lists, and **no screen-scoped anything** — no per-screen theme, no
`per_screen_*` override, nothing a run could cross.

```text
- [ ] this checkbox sits inside a fenced block and must not count as a task
- [x] neither must this one
~~~
- [ ] still inside the outer fence
~~~
```

### 0.3 · The report asks for evidence the renderer deliberately does not produce.

The report writer wants a per-screen colour count:

```ts
const colours = await renderer.coloursFor(screenId)
if (colours.length === 0) throw new Error('no colours observed')
```

That count is aggregated and dropped at paint time. It is by design and is not changed here.

### 0.4 · What a proof of dark mode must assert

| half | evidence | why this one |
|---|---|---|
| the inbox **switched** | `colour.v1` with `screen_id=inbox`, `colour=DARK`, `source=settings`, a non-empty `reason` | a record the run caused |
| the sibling **kept working** | `render.v1` with `screen_id=calendar` and a timestamp **after** the switch | work observed after the event |

---

## Global Constraints

### G-1 · The shipped build is the only target

Every step names the build by digest. A local debug build does not count.

### G-2 · No schema change

A schema change here is almost certainly a mistake; stop and say so.

### G-3 · Real device, real account, fresh install

A simulator or a fixture-only run does not count.

### G-4 · Product copy

No user-facing string changes in this plan.

---

## A1 — The sample app configures a theme override

### Task 1: Declare a per-screen override the inbox will use and the calendar will not

The override must be a field the renderer already reads.

#### Decided (2026-09-10): `screen_theme`, and only it

| Link | `screen_theme` | `screen_density` |
|---|---|---|
| Applied at | `render/theme.go:511` `applyTheme` — paint path | `render/layout.go:366` — the layout pass |
| Reaches the mobile shell? | yes, as a `ThemeUpdate` on the sync stream | **no** — the shell has **zero** layout call sites |
| Record on change | `todo.audit.colour.v1` via `theme/processor.go:91` | `todo.audit.colour.v1` via `layout.go:90` |

#### The arming preconditions, which are not obvious from the field name

- The override only applies when `display.max_lists` is also set.
- A screen named in `screens: []` and absent from the registry is skipped silently.

- [ ] **Step 1: Write the failing test** — a structural check asserting this sample declares at
  least one screen override and that `max_lists` is set alongside it.
- [ ] **Step 2: Run it and watch it fail.** Expected: the sample declares no override.
- [ ] **Step 3: Declare `screen_theme` plus the `max_lists` coupling**, with the
  comment saying why the number is 40 and not 4.
- [ ] **Step 4: Run to verify.**
- [ ] **Step 5: Prove the override is reachable.** Drive the sample once and confirm the inbox changes
  colour.
  - [ ] first sub-check: the inbox record exists
    - [ ] second sub-check: its `reason` is non-empty
  - [x] other sub-check: the calendar record is absent
- [ ] **Step 6: Commit.**

### Task 2: The metric requirement names something this sample emits

- [ ] **Step 1: Measure** which metric families carry series on the sync service after an A1
  run.
- [ ] **Step 2: Require a family the run produces**, and state in the comment why the previous
  requirement could never be met.
- [ ] **Step 3: Differential** — plant a family nothing emits and watch the run redden.
- [ ] **Step 4: Commit.**

---

## A2 — The report asserts what the run caused

### Task 3: Replace the SAME/SAME assertion with the two-positive shape

The old assertion compared the inbox against itself.

- [ ] **Step 1: Write the failing test** — three arms:
  the inbox switched, the calendar kept rendering, and the calendar render is later.
- [ ] **Step 2: Run and watch all three fail.**
- [ ] **Step 3: Implement.** Keep the existing refusal as the fallback: a theme plan with no
  observed switch still fails loudly.
- [ ] **Step 4: Run to verify.**
- [ ] **Step 5: Prove the gate can fail** — force the override off so that nothing
  switches, and watch the report refuse.
- [ ] **Step 6: Commit.**

### Task 4: The sibling screen id is read, not declared

- [ ] **Step 1: Decide, in writing,** whether the sibling id is read from the observed renders
  or from the sample config, and say which one cannot lie.
- [ ] **Step 2: TDD it, then commit.**

---

## A3 — Live verification on a fresh install

### Task 5: The scenario passes for the reason it claims

- [ ] **Step 1: Fresh install.** Wipe the device, pull by the G-1 digest, and confirm the
  running build is the one just built.
- [ ] **Step 2: Run `scenario-dark-mode-offline` live** with a real test account.
- [ ] **Step 3: Read the report, not the exit code.** It must carry an inbox switch sourced from
  `settings`, and a calendar render after it.
- [ ] **Step 4: Ask of each assertion — can this pass while the thing it claims is false?**
- [ ] **Step 5: Un-void the report.** `dark-mode.offline.live.report.yaml` is one of
  the files marked void; regenerate it from this run.
- [ ] **Step 6: Regenerate the tablet sibling proof.** `dark-mode.tablet.live` is a
  second run and gets its own report.

### Task 6: Review, then close out

- [ ] **Step 1: One code review.** Scoped to the diff, run **once**. Verify every finding.
- [ ] **Step 2: Ledger** — V-383 carries the finding; close it with the live evidence.
- [ ] **Step 3: Log the docs consequence** per G-4: the theming page describes a
  behaviour this change makes visible.
- [ ] **Step 4: Notes**, mirrored to both config folders.

---

## Verification (end-to-end)

1. The sample declares the override.
2. The report carries both positives.
3. A forced-off run fails the report.

## Out of scope / residual

- Tablet layouts.
- The settings screen copy.

## The decision this plan makes

Prove the claim on the thing that can fail, not on the thing that cannot.
