// hand-written plan-mode fixture: bullet sections with no numbers (SPEC 16, plan-bullets)
export const text: string = `# Plan: Greeting script with a flag

## Context
The folder holds nothing yet. The goal is a one-file script and a test for it.
- a bullet inside the context section, which is skipped whole

## Files
- \`greet.sh\` (new)
- \`greet_test.sh\` (new)

## Script
- prints a greeting to stdout
- takes \`--who\`, defaulting to \`there\`
- exits 0 on success

## Tests
- runs the script with no flag
- runs it with \`--who Sam\`

## Notes
Prose only under this heading, so it is not a step.

\`\`\`text
- [ ] a fenced checkbox that must not count
1. a fenced numbered line that must not count
\`\`\`

## Checks
- run both scripts by hand
- the test script exits 0

Small enough to do in one pass.
`
