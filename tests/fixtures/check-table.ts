// hand-written fixture (b): tables with [x] check cells and a done column
export const text: string = `# Release checklist

Some intro text.

## Gates

| id | title | owner | verified |
|---|---|---|---|
| G1 | Build is reproducible | ci | [x] |
| G2 | Docs link check | docs | [ ] |
| G3 | Signed artefacts \\| both formats | release | [X] |
| G4 | Smoke test on a fresh stack | qa | [ ] |
| G5 | Changelog entry | docs | [x] |

## Later

| id | title | done |
|---|---|---|
| L1 | Archive notes | 2026-10-01 |
| L2 | Retire flag | — |
`
