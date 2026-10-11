# headway: a router warning. Has Claude dispatch an Agent with no model, which draws the amber
# warning mark and one quiet note, then screenshots the toast, the pane and the band. Frames land in
# docs/screenshots/raw/ (git-ignored). Run from the repository root:  vhs docs/screenshots/warning.tape
# warning.png is the frame with the Agents tab open, cropped to the pane and band (the header shows
# your plan name and the scratch path).
Output docs/screenshots/raw/warning.gif

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
Type "claude --model haiku --permission-mode acceptEdits --allowedTools 'Bash(python3 *)'" Enter
Wait+Screen@60s /Yes, I trust this folder/
Sleep 1s
Down
Enter
Sleep 8s
Show
Type "Dispatch one subagent with the Agent tool and do not pass a model parameter. Its prompt only runs python3 -c 'import time; time.sleep(30)' and replies done."
Sleep 1s
Enter
Wait+Screen@120s /⚠/
Sleep 1s
Screenshot docs/screenshots/raw/warn1.png
Sleep 1s
Sleep 2s
Screenshot docs/screenshots/raw/warn2.png
Sleep 1s
Type "/headway "
Sleep 1s
Enter
Sleep 1s
Type "2"
Sleep 3s
Screenshot docs/screenshots/raw/warn3.png
Sleep 1s
Type "3"
Sleep 3s
Screenshot docs/screenshots/raw/warn4.png
Sleep 1s
Type "1"
Sleep 3s
Screenshot docs/screenshots/raw/warn5.png
Sleep 1s
Hide
Type "q"
Type "/exit"
Sleep 1s
Enter
Sleep 3s
Type "cd /tmp && rm -rf $d" Enter
Sleep 1s
