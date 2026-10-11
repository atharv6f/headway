# headway: a Workflow's phases as a plan. Has Claude run a tiny Workflow whose script declares
# meta.phases (Read, Write) with a haiku agent() in each, and screenshots the pane's Plan tab while
# it runs. "ultracode" in the prompt switches the Workflow tool on, and the dialog it raises is
# answered "Yes, run it". Frames land in docs/screenshots/raw/ (git-ignored). Run from the repository
# root:  vhs docs/screenshots/workflow-phases.tape
# workflow-phases.png is the second frame (both agents running), cropped to the pane and band.
Output docs/screenshots/raw/workflow-phases.gif

Set Shell zsh
Set FontSize 20
Set Width 1400
Set Height 1300
Set Padding 16
Set Theme "Catppuccin Mocha"
Set Framerate 10
Set TypingSpeed 15ms

Hide
Type "d=$(mktemp -d /tmp/headway-demo.XXXXXX) && cd $d && clear" Enter
Type "claude --model sonnet --permission-mode acceptEdits --allowedTools 'Bash(python3 *)'" Enter
Wait+Screen@60s /Yes, I trust this folder/
Sleep 1s
Down
Enter
Sleep 8s
Show
Type "ultracode: use the Workflow tool with a tiny inline script. It exports meta = { name: 'tiny', description: 'Read then write', phases: ['Read', 'Write'] } and calls agent() twice in parallel: one labelled 'read notes' with phase 'Read' and one labelled 'write summary' with phase 'Write'. Every agent() call passes model: 'haiku' and effort: 'low', and its prompt only runs python3 -c 'import time; time.sleep(25)' then replies done."
Sleep 1s
Enter
Wait+Screen@180s /Yes, run it/
Sleep 2s
Enter
Sleep 6s
Type "/headway "
Sleep 1s
Enter
Sleep 2s
Type "1"
Sleep 4s
Screenshot docs/screenshots/raw/wf1.png
Sleep 8s
Screenshot docs/screenshots/raw/wf2.png
Sleep 8s
Screenshot docs/screenshots/raw/wf3.png
Sleep 8s
Screenshot docs/screenshots/raw/wf4.png
Sleep 8s
Screenshot docs/screenshots/raw/wf5.png
Hide
Type "q"
Type "/exit"
Sleep 1s
Enter
Sleep 3s
Type "cd /tmp && rm -rf $d" Enter
Sleep 1s
