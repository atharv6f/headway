# headway demo. Renders docs/demo.gif from a real Claude Code session in an empty scratch
# directory: a plain three-step prompt, the band filling as Claude reports each step and its haiku
# subagents work, then the pane and its four tabs, each with real content, ending on the band with
# every step done. The prompt is typed and the waits pass while hidden, so the GIF shows the prompt
# once (submitted, in the transcript) and only the moments that matter. Needs vhs, Claude Code with
# headway installed, and a logged-in account. Run from the repository root:
#   vhs docs/demo.tape

Output docs/demo.gif

Set Shell zsh
Set FontSize 18
Set Width 1200
Set Height 1000
Set Padding 16
Set Theme "Catppuccin Mocha"
Set Framerate 8
Set TypingSpeed 1ms

# Start Claude Code in a fresh scratch directory. Hidden: the trust prompt for a new directory is
# answered "Yes, I trust this folder" (Down, Enter), and the prompt is typed and sent.
# python3 is allowed so the subagents can run the short wait without a permission prompt.
Hide
Type "d=$(mktemp -d /tmp/headway-demo.XXXXXX) && cd $d && clear" Enter
Type "claude --model haiku --permission-mode acceptEdits --allowedTools 'Bash(python3 *)'" Enter
Wait+Screen@60s /Yes, I trust this folder/
Sleep 1s
Down
Enter
Sleep 8s

# A plain multi-step prompt: no plan file, no setup. headway's guidance makes Claude report the
# steps and mark each one as it goes; the band above the prompt fills in, with the subagents'
# progress under the step each one works on.
Type "Do three things, one step each, and name each subagent 'step N: ...': 1. have a haiku subagent create red.txt containing the word red; 2. have a haiku subagent run python3 -c 'import time; time.sleep(4)' and then create blue.txt containing the word blue; 3. read both files back yourself and show me their contents."
Enter
Show
Sleep 1500ms

# Shown again once step 2 has an agent at work, then hidden through the rest of the wait.
Hide
Wait+Screen@180s /agents +● 1/
Show
Sleep 3500ms
Hide
Wait+Screen@180s /3\/3 done/
Sleep 1s
Show
Sleep 2s

# The pane and its tabs, after the agents have run: 1 Plan, 2 Agents, 3 Log, 4 Usage. Then the
# band again, with every step done.
Hide
Type "/headway "
Enter
Sleep 1s
Show
Type "1"
Sleep 1500ms
Type "2"
Sleep 1500ms
Type "3"
Sleep 1500ms
Type "4"
Sleep 1500ms
Hide
Type "q"
Sleep 1s
Show
Sleep 3s

# Leave Claude Code and remove the scratch directory.
Hide
Type "/exit"
Sleep 1s
Enter
Sleep 3s
Type "cd /tmp && rm -rf $d" Enter
Sleep 1s
