# waypoint demo. Renders docs/demo.gif from a real Claude Code session in an empty scratch
# directory: a plain three-step prompt, the band filling as Claude reports each step, then the pane
# and its four tabs. Needs vhs, Claude Code with waypoint installed, and a logged-in account.
# Run from the repository root:  vhs docs/demo.tape

Output docs/demo.gif

Set Shell zsh
Set FontSize 16
Set Width 1200
Set Height 800
Set Padding 16
Set Theme "Catppuccin Mocha"
Set Framerate 12
Set TypingSpeed 30ms

# Start Claude Code in a fresh scratch directory. Hidden: the trust prompt for a new directory is
# answered "Yes, I trust this folder" (Down, Enter), and the recording begins at the ready prompt.
Hide
Type "d=$(mktemp -d /tmp/waypoint-demo.XXXXXX) && cd $d && clear" Enter
Type "claude --model haiku --permission-mode acceptEdits" Enter
Wait+Screen@60s /Yes, I trust this folder/
Sleep 1s
Down
Enter
Sleep 8s
Show

# A plain multi-step prompt: no plan file, no setup. waypoint's guidance makes Claude report the
# steps and mark each one as it goes; the band above the prompt fills in.
Type "Do three things: 1. create red.txt containing the word red; 2. create blue.txt containing the word blue; 3. read both files back and show me their contents."
Sleep 1s
Enter
Wait+Screen@180s /reported/
Sleep 2s
Wait+Screen@180s /3.3 done/
Sleep 4s

# The pane and its tabs: 1 Plan, 2 Agents, 3 Log, 4 Usage; q closes.
Type "/waypoint "
Sleep 1s
Enter
Sleep 4s
Type "2"
Sleep 3s
Type "3"
Sleep 3s
Type "4"
Sleep 3s
Type "1"
Sleep 3s
Type "q"
Sleep 3s

# Leave Claude Code and remove the scratch directory.
Hide
Type "/exit"
Sleep 1s
Enter
Sleep 3s
Type "cd /tmp && rm -rf $d" Enter
Sleep 1s
