# headway: the band, the Plan tab and the Agents tab, from one real session. Pins a small ROADMAP.md
# with a group map, has Claude dispatch two haiku subagents, and screenshots the band while they run,
# then the pane's Plan and Agents tabs. Frames land in docs/screenshots/raw/ (git-ignored). Run from
# the repository root:  vhs docs/screenshots/plan.tape
# They are whole-terminal frames, kept as pane-plan.png, pane-agents.png and band.png after cropping
# to the pane and band (the Claude Code header shows your plan name and the scratch path).
Output docs/screenshots/raw/plan.gif

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
Type `printf '# Roadmap\n\n## Parser\n- [x] P1 Parse the config file\n- [ ] P2 Wire the --name flag\n  - [x] argparse\n  - [ ] tests\n- [ ] P3 Add a --verbose flag\n\n## Release\n- [x] R1 Tag and build\n- [ ] R2 Publish the package\n- [ ] R3 Update the install docs\n- [ ] R4 Announce it\n' > ROADMAP.md` Enter
Type `printf '{"groups":[{"id":"G1","title":"Parser","rows":["P1","P2","P3"]},{"id":"G2","title":"Release","rows":["R1","R2"]},{"id":"G3","title":"Docs and comms","rows":["R3","R4"]}]}' > groups.json` Enter
Type "clear" Enter
Type "claude --model haiku --permission-mode acceptEdits --allowedTools 'Bash(python3 *)'" Enter
Wait+Screen@60s /Yes, I trust this folder/
Sleep 1s
Down
Enter
Sleep 8s
Show
Type "/headway track ROADMAP.md groups=groups.json"
Sleep 1s
Enter
Sleep 3s

Type "Dispatch two haiku subagents in parallel, one with description 'P2 wire the --name flag' and one with description 'R2 publish the package'. Each only runs python3 -c 'import time; time.sleep(45)' and replies done. Edit no files."
Sleep 1s
Enter
Wait+Screen@120s /▸ [PR]2/
Sleep 4s

Type "/headway "
Sleep 1s
Enter
Sleep 2s
Type "1"
Sleep 2s
Screenshot docs/screenshots/raw/pane-plan.png
Sleep 1s
Type "2"
Sleep 3s
Screenshot docs/screenshots/raw/pane-agents.png
Sleep 1s
Type "q"
Sleep 2s
Screenshot docs/screenshots/raw/band.png
Sleep 1s
Sleep 2s
Hide
Type "q"
Type "/exit"
Sleep 1s
Enter
Sleep 3s
Type "cd /tmp && rm -rf $d" Enter
Sleep 1s
