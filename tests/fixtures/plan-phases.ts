// hand-written plan-mode fixture: numbered steps continuing across phase headings (SPEC 16, plan-phases)
export const text: string = `# Plan: Word count tool

## Context
Nothing here yet. The tool reads stdin and prints how many words it saw.
1. a numbered line inside the context section, which is skipped whole

## Phase 1: Setup
1. Create \`pyproject.toml\` with a name and a version.
2. Add a \`.gitignore\` for caches.

## Phase 2: Core
3. Write \`count.py\` that reads stdin.
4. Split the input on whitespace.
5. Print the number of words.
6. Exit 1 when stdin cannot be read.

## Phase 3: Docs
7. Write a README with one usage example.

## Phase 4: Checks
8. \`echo a b c | python3 count.py\` prints \`3\`.
9. Empty input prints \`0\`.

\`\`\`sh
1. a fenced line that looks numbered
\`\`\`

10. A file with blank lines counts only words.
11. A closed stdin exits 1.
12. The README example runs as written.
`
