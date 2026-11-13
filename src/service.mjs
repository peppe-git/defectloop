// SPDX-License-Identifier: Apache-2.0
//
// Unit files to run the loop as a user service. Printed, never installed: installing a service is a
// decision for the user (docs/guides/running-as-a-service.md).

import { basename } from "node:path";

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function systemdUnit({ node, bin, config, root, envFile }) {
  return `# defectloop user service. Install (your decision):
#   mkdir -p ~/.config/systemd/user && defectloop service systemd > ~/.config/systemd/user/defectloop-${basename(root)}.service
#   systemctl --user daemon-reload && systemctl --user enable --now defectloop-${basename(root)}
# The API key lives in ${envFile} (chmod 600), never in this file.
[Unit]
Description=defectloop unattended audit loop (${basename(root)})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${node} ${bin} run --config ${config} --env-file ${envFile}
# A halt or the kill switch exits 0 and is not restarted; crashes are.
Restart=on-failure
RestartSec=60
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

export function launchdPlist({ node, bin, config, root, envFile, label, stateDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- defectloop LaunchAgent. Install (your decision):
       defectloop service launchd > ~/Library/LaunchAgents/${xml(label)}.plist
       launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${xml(label)}.plist
     The API key lives in ${xml(envFile)} (chmod 600), never in this file.
     To keep the Mac awake while it runs, prefix ProgramArguments with /usr/bin/caffeinate -i -s. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(bin)}</string>
    <string>run</string>
    <string>--config</string><string>${xml(config)}</string>
    <string>--env-file</string><string>${xml(envFile)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <!-- Restarted after a crash; not after a clean exit (halt, kill switch). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(stateDir)}/supervisor.err.log</string>
</dict>
</plist>
`;
}
