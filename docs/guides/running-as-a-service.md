# Running as a service

`defectloop run` is an ordinary foreground process: it runs until the kill switch, a halt, a signal
or `--max-rounds`. To keep it running across logouts and reboots, let your service manager start it.
defectloop **prints** the unit file; installing it is your decision.

Exit codes are chosen for service managers: a halt and the kill switch exit **0** (not restarted), a
preflight failure exits 1, a crash exits non-zero (restarted after a delay).

## The API key

Do not put the key in the unit file. Keep it in a file readable only by you:

```bash
mkdir -p ~/.config/defectloop
printf 'ANTHROPIC_API_KEY=%s\n' "<your key>" > ~/.config/defectloop/env
chmod 600 ~/.config/defectloop/env
```

`defectloop run --env-file <file>` loads it and refuses a file that other users can read.

## Linux (systemd, user service)

```bash
defectloop service systemd > ~/.config/systemd/user/defectloop-myrepo.service
systemctl --user daemon-reload
systemctl --user enable --now defectloop-myrepo
journalctl --user -u defectloop-myrepo -f      # or: defectloop status
```

To keep it running while you are logged out: `loginctl enable-linger $USER` (your decision too).

## macOS (launchd, LaunchAgent)

```bash
defectloop service launchd > ~/Library/LaunchAgents/io.defectloop.myrepo.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.defectloop.myrepo.plist
```

Stop and remove: `defectloop stop`, then
`launchctl bootout gui/$(id -u)/io.defectloop.myrepo` and delete the plist.

A Mac on battery or with the lid closed goes to sleep and the loop with it. To keep it awake while the
loop runs, start it under `caffeinate -i -s` (add `/usr/bin/caffeinate`, `-i`, `-s` at the front of
`ProgramArguments`). `caffeinate` does not prevent sleep when the lid is closed on battery.

## Windows

Not tested. Task Scheduler can run `node <path>\bin\defectloop.mjs run --config <path>` at logon;
set `agent.command` to the full path of the agent executable.

## Without a service manager

```bash
nohup defectloop run > /dev/null 2>&1 &
```

The journal is in `.defectloop/journal.log`; `defectloop status` reads the state.
