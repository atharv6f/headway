// hand-written plan-mode fixture: top-level numbered steps with indented sub-steps (SPEC 16, plan-nested)
export const text: string = `# Plan: Tidy the notes folder

## Background
Three loose note files sit at the root; they should move into one folder with an index.

## Checklist
1. Make the folder
   1. \`mkdir notes\`
   2. move the three files into it
2. Write an index
   1. a heading line
   2. one link per file
   - a bulleted sub-step counts as well
3. Add a lint script
   1. start with a shebang and strict mode
   2. loop over the note files
   3. count the words in each
   4. fail when a file has more than one word
   5. make the script executable
4. Verify
   1. list the folder
   2. run the lint script
   3. try one bad file, then remove it
`
