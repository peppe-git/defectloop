// SPDX-License-Identifier: Apache-2.0
//
// The guard's rules: given a PreToolUse payload, the reason to block it, or null.
//
// It is the boundary that does not depend on the prompt, and it is deliberately prudent: a block too
// many costs the round a rephrasing, an allow too many can cost data or a publication. It is NOT a
// sandbox: the agent runs with the user's permissions, and anything the guard cannot read (a script, a
// test suite, a build tool, a program that opens sockets) runs unchecked. See docs/security.md.

import { readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { programWords, redirectTargets, splitSegments, stripQuoted, words } from "./shell.mjs";

export const GUARD_KEYS = ["publish", "destructive", "network", "secrets", "protectedPaths", "removableDirs", "writableOutsideRepo", "deniedCommands", "allowCommands", "tools", "sharedWorkingTree"];

const DEFAULT_PROTECTED = [".git/**", ".github/workflows/**", ".githooks/**", ".husky/**", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/**", ".mcp.json"];
const DEFAULT_REMOVABLE = ["node_modules/.cache", "node_modules/.vite", "dist", "build", "out", "coverage", "target", ".cache", "test-results", "playwright-report", ".pytest_cache", "__pycache__", ".next", ".turbo", ".nyc_output"];
const DEFAULT_DENIED_TOOLS = ["AskUserQuestion", "ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "RemoteTrigger", "EnterWorktree", "ExitWorktree", "EnterPlanMode", "ExitPlanMode", "PushNotification", "SendMessage"];
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "TodoRead", "Task", "Agent", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "BashOutput", "KillShell", "ToolSearch", "LSP"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Cloud, infrastructure and deploy CLIs: blocked unless named in guard.allowCommands. */
export const CLOUD_CLIS = ["wrangler", "vercel", "netlify", "flyctl", "fly", "firebase", "heroku", "terraform", "tofu", "pulumi", "kubectl", "helm", "aws", "gcloud", "gsutil", "az", "doctl", "serverless", "sls", "eksctl", "ansible", "ansible-playbook"];
const SYSTEM_CMDS = ["launchctl", "systemctl", "service", "defaults", "pmset", "systemsetup", "csrutil", "security", "osascript", "crontab", "diskutil", "shutdown", "reboot", "halt", "poweroff", "chown", "chgrp", "killall", "networksetup", "scutil", "tccutil", "spctl", "iptables", "ufw", "mount", "umount", "fdisk", "parted", "useradd", "usermod", "userdel", "passwd", "chsh", "visudo"];
const SYSTEM_PKG = ["apt", "apt-get", "yum", "dnf", "pacman", "apk", "port", "choco", "winget", "snap", "flatpak", "zypper"];
const NET_TOOLS_URL = ["curl", "wget", "http", "https", "xh", "xhs", "aria2c"];
const NET_TOOLS_HOST = ["nc", "ncat", "netcat", "telnet", "ftp", "tftp"];

export const DEFAULT_POLICY = Object.freeze({
  publish: true,
  destructive: true,
  network: { allowHosts: ["localhost", "127.0.0.1", "::1"], allowPackageInstall: false, allowGitFetch: false, allowWebSearch: false, readOnlySsh: [] },
  secrets: { allowRead: false, paths: [] },
  protectedPaths: [],
  removableDirs: [],
  writableOutsideRepo: [],
  deniedCommands: [],
  allowCommands: [],
  tools: { deny: [], allow: [], mcpAllow: [], skillDeny: [] },
  sharedWorkingTree: { enabled: true, windowSeconds: 120, ignore: [] },
});

const uniq = (a) => [...new Set(a)];

/** Merges the user's `guard` section over the defaults. Lists extend the defaults, never replace them. */
export function resolvePolicy(g = {}) {
  const d = DEFAULT_POLICY;
  return {
    publish: g.publish ?? d.publish,
    destructive: g.destructive ?? d.destructive,
    network: {
      ...d.network,
      ...(g.network ?? {}),
      allowHosts: uniq([...d.network.allowHosts, ...(g.network?.allowHosts ?? [])].map((h) => String(h).toLowerCase())),
      readOnlySsh: [...(g.network?.readOnlySsh ?? [])],
    },
    secrets: { ...d.secrets, ...(g.secrets ?? {}), paths: [...(g.secrets?.paths ?? [])] },
    protectedPaths: uniq([...DEFAULT_PROTECTED, ...(g.protectedPaths ?? [])]),
    removableDirs: uniq([...DEFAULT_REMOVABLE, ...(g.removableDirs ?? [])]),
    writableOutsideRepo: [...(g.writableOutsideRepo ?? [])],
    deniedCommands: [...(g.deniedCommands ?? [])],
    allowCommands: [...(g.allowCommands ?? [])],
    tools: {
      deny: uniq([...DEFAULT_DENIED_TOOLS, ...(g.tools?.deny ?? [])]),
      allow: [...(g.tools?.allow ?? [])],
      mcpAllow: [...(g.tools?.mcpAllow ?? [])],
      skillDeny: [...(g.tools?.skillDeny ?? [])],
    },
    sharedWorkingTree: { ...d.sharedWorkingTree, ...(g.sharedWorkingTree ?? {}) },
  };
}

// ── paths ─────────────────────────────────────────────────────────────────────────────────────

/** Minimal glob: `**` any depth, `*` one segment, `?` one character. Paths use forward slashes. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const toPosix = (p) => p.split(sep).join("/");
const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const expandHome = (p, home) => String(p).replace(/^~(?=\/|$)/, home);
const full = (p, ctx) => resolve(ctx.cwd ?? ctx.root, expandHome(p, ctx.home));
const repoRel = (abs, ctx) => toPosix(relative(ctx.root, abs));
const matchesAny = (rel, globs) => globs.some((g) => globToRegExp(g).test(rel) || globToRegExp(`${g}/**`).test(rel));

const SECRET_NAME = /^(\.env(\..+)?|\.netrc|\.pgpass|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(_[a-z0-9]+)?|.+\.(pem|key|p12|pfx|jks|keystore))$/i;
const NOT_SECRET = /^\.env\.(example|sample|template|dist)$/i;

/** Whether an absolute path holds secrets (env files, keys, credential stores). */
export function isSecretPath(abs, ctx) {
  const name = basename(abs);
  const h = ctx.home;
  if (NOT_SECRET.test(name)) return false;
  if (SECRET_NAME.test(name)) return true;
  if (inside(abs, `${h}/.ssh`) && !name.endsWith(".pub") && name !== "known_hosts" && name !== "config") return true;
  if ([`${h}/.aws/credentials`, `${h}/.config/gh/hosts.yml`, `${h}/.docker/config.json`, `${h}/.kube/config`].includes(abs)) return true;
  const extra = ctx.policy.secrets.paths;
  if (extra.length && (matchesAny(repoRel(abs, ctx), extra) || matchesAny(toPosix(abs), extra))) return true;
  return false;
}

/** Why the loop may not write (or delete) this path, or null. */
export function writeProblem(p, ctx) {
  if (typeof p !== "string" || !p) return "no target path";
  if (p === "/dev/null" || p === "/dev/stdout" || p === "/dev/stderr") return null;
  const abs = full(p, ctx);
  const h = ctx.home;
  const name = basename(abs);
  if (SECRET_NAME.test(name) && !NOT_SECRET.test(name)) return `${name} holds secrets: the loop does not write it`;
  if (inside(abs, `${h}/.ssh`)) return "ssh keys and configuration";
  if (/^\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|bash_login|profile|gitconfig|npmrc)$/.test(name) && inside(abs, h)) return "personal shell or tool configuration";
  if (abs === `${h}/.claude.json` || inside(abs, `${h}/.claude/settings.json`) || inside(abs, `${h}/.claude/settings.local.json`) || /\/\.claude\/settings(\.local)?\.json$/.test(toPosix(abs))) return "Claude Code settings";
  if (inside(abs, `${h}/.claude/projects`) && toPosix(abs).includes("/memory/")) return "the user's persistent memory";
  for (const d of ["Library/LaunchAgents", ".config/systemd", ".config/autostart", ".aws", ".kube", ".docker", ".config/gh"]) {
    if (inside(abs, `${h}/${d}`)) return `${d} is system or account configuration`;
  }
  for (const f of ctx.protectedFiles ?? []) if (abs === resolve(f)) return `${name} is part of the loop's own configuration: propose the change in the outcome instead`;
  if (ctx.globalDir && inside(abs, ctx.globalDir)) return "the global defectloop directory (kill switch)";
  if (ctx.stateDir && inside(abs, ctx.stateDir)) {
    const rel = toPosix(relative(ctx.stateDir, abs));
    if (rel === "tmp" || rel.startsWith("tmp/")) return null;
    if (ctx.round && rel === `rounds/${ctx.round}.outcome.json`) return null;
    return `${rel} belongs to the supervisor: the loop writes only tmp/ and this round's outcome file`;
  }
  if (inside(abs, ctx.root)) {
    const rel = repoRel(abs, ctx);
    if (matchesAny(rel, ctx.policy.protectedPaths)) return `${rel} is a protected path (guard.protectedPaths)`;
    return null;
  }
  for (const t of [...(ctx.tmpDirs ?? []), ...ctx.policy.writableOutsideRepo.map((d) => full(d, ctx))]) if (inside(abs, t)) return null;
  return `${abs} is outside the repository: the loop writes only in the repository and in temporary directories`;
}

function removable(p, ctx) {
  const abs = full(p, ctx);
  if (ctx.stateDir && inside(abs, join(ctx.stateDir, "tmp"))) return true;
  if (inside(abs, ctx.root)) {
    // inside the repository only the configured build/cache directories, even when the repository
    // itself lives under a temporary directory
    if (abs === ctx.root) return false;
    const rel = repoRel(abs, ctx);
    return ctx.policy.removableDirs.some((d) => rel === d || rel.startsWith(`${d}/`) || globToRegExp(d).test(rel));
  }
  return (ctx.tmpDirs ?? []).some((t) => inside(abs, t) && abs !== resolve(t));
}

// ── words helpers ─────────────────────────────────────────────────────────────────────────────

/** Drops redirection operators and their targets from a word list (they are checked separately). */
function withoutRedirections(w) {
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    if (/^[0-9&]?(>{1,2}|<{1,3})\|?$/.test(x)) {
      i++;
      continue;
    }
    if (/^[0-9&]?(>{1,2}|<)\|?\S/.test(x)) continue;
    out.push(x);
  }
  return out;
}

const operands = (a) => a.filter((x) => x === "" || !x.startsWith("-"));

function hostAllowed(host, ctx) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return ctx.policy.network.allowHosts.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

function urlHost(s) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
    return u.hostname || null;
  } catch {
    return null;
  }
}

// ── command rules ─────────────────────────────────────────────────────────────────────────────

const PUBLISH_MSG = "publishing is a human decision: the loop commits locally and never publishes";

function gitRule(a, ctx) {
  const sub = a[0];
  const rest = a.slice(1);
  const p = ctx.policy;
  if (sub === "push") return `git push: ${PUSH_REASON}`;
  if (p.destructive) {
    if (sub === "commit" && rest.includes("--amend")) return "git commit --amend rewrites a commit that may not be the loop's: make a new commit";
    if (sub === "reset" && rest.some((x) => ["--hard", "--merge", "--keep"].includes(x))) return "destructive git reset: undo only your own files with `git checkout -- <file>`";
    if (sub === "clean") return "git clean deletes untracked files, including other people's";
    if (["rebase", "filter-branch", "filter-repo", "update-ref", "replace"].includes(sub)) return `git ${sub} rewrites history`;
    if (sub === "merge") return "git merge: the loop does not merge branches";
    if (sub === "switch") return "the loop stays on its branch: no branch switching";
    if (sub === "checkout" || sub === "restore") {
      const i = rest.indexOf("--");
      const paths = i >= 0 ? rest.slice(i + 1) : sub === "restore" ? operands(rest) : [];
      if (sub === "checkout" && i < 0) return "git checkout without `-- <file>` switches branch or commit: the loop stays on its branch";
      if (!paths.length || paths.some((x) => [".", "./", ":/", "*", ":(top)"].includes(x))) return `git ${sub} of the whole tree would discard other people's work: name your files`;
      for (const x of paths) {
        const why = writeProblem(x, ctx);
        if (why) return `git ${sub} ${x}: ${why}`;
      }
    }
    if (sub === "stash" && ["drop", "clear", "pop"].includes(rest[0])) return `git stash ${rest[0]} can lose work or apply it over other people's changes`;
    if (sub === "stash" && (rest.length === 0 || (rest[0] === "push" && !rest.includes("--")) || rest[0] === "save")) return "git stash without a pathspec would set aside other people's files too: `git stash push -m … -- <file>`";
    if (sub === "branch" && rest.some((x) => /^-(d|D|m|M|-delete|-move|f|-force|c|C|-copy)$/.test(x))) return "git branch: no deletions, renames or forced moves";
    if (sub === "tag" && rest.length && !rest.every((x) => x.startsWith("-l") || x === "--list")) return "git tag: tags are a release decision";
    if (sub === "remote" && rest.length && !["-v", "show", "get-url"].includes(rest[0])) return "git remote: repository configuration";
    if (sub === "config" && !rest.some((x) => ["--get", "--list", "-l", "--get-all", "--show-origin", "--get-regexp"].includes(x))) return "git config in write mode";
    if (sub === "gc" && rest.some((x) => /--prune/.test(x))) return "git gc --prune";
  }
  if (!p.network.allowGitFetch && (["clone", "fetch", "pull", "ls-remote"].includes(sub) || (sub === "submodule" && rest.length) || (sub === "remote" && rest[0] === "update"))) {
    return `git ${sub} uses the network (guard.network.allowGitFetch is false)`;
  }
  if (p.sharedWorkingTree.enabled) {
    if (sub === "add" && rest.some((x) => ["-A", "--all", ".", ":/", "*", "-u", "--update", ":(top)"].includes(x))) return "git add of everything would stage other people's work in progress: add your files by name";
    if (sub === "commit") {
      if (rest.some((x) => x === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(x))) return "git commit -a commits every modified tracked file, other people's included: `git commit -m … -- <your files>`";
      if (!rest.includes("--amend") && !commitHasPathspec(rest)) {
        const recent = (ctx.recentFiles?.() ?? []).slice(0, 8);
        if (recent.length) {
          const shown = recent.map((f) => (inside(f, ctx.root) ? repoRel(f, ctx) : f));
          return `the working tree is moving (files modified in the last ${p.sharedWorkingTree.windowSeconds}s: ${shown.join(", ")}). A commit without a pathspec takes the whole index, other people's work included: \`git commit -m … -- <your files>\``;
        }
      }
    }
  }
  return null;
}
const PUSH_REASON = PUBLISH_MSG;

const COMMIT_VALUE_FLAGS = new Set(["-m", "--message", "-F", "--file", "-C", "-c", "--reuse-message", "--reedit-message", "--author", "--date", "-t", "--template", "--fixup", "--squash", "--cleanup", "--trailer"]);
function commitHasPathspec(rest) {
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (x === "--") return i + 1 < rest.length;
    if (COMMIT_VALUE_FLAGS.has(x)) {
      i++;
      continue;
    }
    if (x.startsWith("-")) continue;
    return true;
  }
  return false;
}

function ghRule(a) {
  const [g, s] = a;
  const writes = {
    workflow: ["run", "enable", "disable"],
    run: ["rerun", "cancel", "delete"],
    pr: ["create", "merge", "close", "edit", "comment", "review", "ready", "reopen", "lock"],
    issue: ["create", "close", "edit", "comment", "delete", "reopen", "transfer", "lock", "pin"],
    release: null,
    repo: ["create", "delete", "edit", "rename", "archive", "fork", "sync"],
    secret: null,
    variable: null,
    cache: ["delete"],
    label: ["create", "edit", "delete", "clone"],
    gist: ["create", "edit", "delete"],
    ssh_key: null,
    "gpg-key": null,
    auth: null,
  };
  if (g in writes && (writes[g] === null || writes[g].includes(s))) return `gh ${g} ${s ?? ""}: writes to the remote; ${PUBLISH_MSG}`.replace("  ", " ");
  if (g === "api") {
    const m = a.findIndex((x) => x === "-X" || x === "--method");
    const method = m >= 0 ? (a[m + 1] ?? "").toUpperCase() : "";
    if ((method && method !== "GET") || a.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x) || /^--method=(?!GET)/i.test(x))) return "gh api in write mode: the loop only reads the remote";
  }
  return null;
}

function packageRule(cmd, a, ctx) {
  const p = ctx.policy;
  const sub = a[0];
  const pm = ["npm", "pnpm", "yarn", "bun"].includes(cmd);
  if (pm) {
    const publishSubs = ["publish", "unpublish", "deprecate", "owner", "dist-tag", "login", "adduser", "logout", "token", "access"];
    if (p.publish && (publishSubs.includes(sub) || (cmd === "yarn" && sub === "npm" && ["publish", "login"].includes(a[1])))) return `${cmd} ${sub}: ${PUBLISH_MSG}`;
    const global = a.some((x) => x === "-g" || x === "--global") || (cmd === "yarn" && sub === "global");
    if (p.destructive && global) return `${cmd} global install changes the system: use the project's own dependencies`;
    const fetching = ["install", "i", "ci", "add", "update", "upgrade", "up", "exec", "x", "dlx", "create", "init", "audit", "outdated", "view", "info"].includes(sub) || (cmd === "yarn" && a.length === 0);
    if (fetching && !p.network.allowPackageInstall) return `${cmd} ${sub ?? ""}: package installation and registry access use the network (guard.network.allowPackageInstall is false)`.replace(" :", ":");
    if (sub === "dlx" || sub === "exec" || sub === "x") return cloudRule(a.slice(1).find((x) => !x.startsWith("-")) ?? "", ctx);
    return null;
  }
  if (["npx", "pnpx", "bunx"].includes(cmd)) {
    if (!p.network.allowPackageInstall) return `${cmd} downloads and runs packages from the registry (guard.network.allowPackageInstall is false)`;
    return cloudRule(a.find((x) => !x.startsWith("-"))?.replace(/@.*$/, "") ?? "", ctx);
  }
  const pyInstall = ((cmd === "pip" || cmd === "pip3" || cmd === "pipx") && ["install", "download"].includes(sub)) || (cmd === "uv" && (["add", "sync"].includes(sub) || (sub === "pip" && a[1] === "install") || sub === "tool")) || (cmd === "poetry" && ["install", "add", "update"].includes(sub));
  const otherInstall = (cmd === "go" && ["get", "install"].includes(sub)) || (cmd === "go" && sub === "mod" && a[1] === "download") || (cmd === "cargo" && ["install", "add", "fetch", "update"].includes(sub)) || (cmd === "gem" && ["install", "update"].includes(sub)) || (cmd === "bundle" && ["install", "update"].includes(sub)) || (cmd === "composer" && ["install", "require", "update"].includes(sub));
  if ((pyInstall || otherInstall) && !p.network.allowPackageInstall) return `${cmd} ${sub}: package installation uses the network (guard.network.allowPackageInstall is false)`;
  if (p.publish && ((cmd === "cargo" && ["publish", "login", "yank", "owner"].includes(sub)) || (cmd === "twine" && sub === "upload") || (cmd === "gem" && ["push", "owner", "yank"].includes(sub)) || (cmd === "poetry" && sub === "publish") || (cmd === "uv" && sub === "publish") || (["flit", "hatch"].includes(cmd) && sub === "publish") || (cmd === "vsce" && sub === "publish") || (cmd === "ovsx" && sub === "publish"))) {
    return `${cmd} ${sub}: ${PUBLISH_MSG}`;
  }
  if (p.publish && ["mvn", "mvnw", "gradle", "gradlew"].includes(cmd) && a.some((x) => ["deploy", "publish", "release:perform"].includes(x) || /^publish/.test(x))) return `${cmd} deploy/publish: ${PUBLISH_MSG}`;
  return null;
}

function cloudRule(cmd, ctx) {
  const name = basename(String(cmd));
  if (CLOUD_CLIS.includes(name) && !ctx.policy.allowCommands.includes(name)) return `${name}: cloud, infrastructure and deploy CLIs are outside the loop (guard.allowCommands to allow)`;
  return null;
}

function dockerRule(cmd, a, ctx) {
  const s = a[0];
  if (ctx.policy.publish && (s === "push" || s === "login")) return `${cmd} ${s}: ${PUBLISH_MSG}`;
  if (s === "pull" && !ctx.policy.network.allowPackageInstall) return `${cmd} pull uses the network`;
  if (!ctx.policy.destructive) return null;
  if (a.includes("prune") || s === "system") return `${cmd} prune/system would delete images and volumes, the user's included`;
  if (s === "volume" && ["rm", "remove", "prune"].includes(a[1])) return `${cmd} volume rm deletes data`;
  if (s === "compose" && a.includes("down") && a.some((x) => x === "-v" || x === "--volumes")) return `${cmd} compose down -v deletes data volumes (without -v it is fine)`;
  return null;
}

function rmRule(a, ctx) {
  const recursive = a.some((x) => /^-[a-zA-Z]*[rR]/.test(x) || x === "--recursive");
  const targets = operands(a);
  for (const t of targets) {
    const why = writeProblem(t, ctx);
    if (why && !(recursive && removable(t, ctx))) return `rm ${t}: ${why}`;
    if (recursive && !removable(t, ctx)) return `recursive rm on "${t}": allowed only on build output, caches, the loop's tmp/ and temporary directories (guard.removableDirs)`;
  }
  return null;
}

function findRule(a, ctx) {
  const firstExpr = a.findIndex((x) => /^[-(!]/.test(x));
  const starts = (firstExpr < 0 ? a : a.slice(0, firstExpr)).filter(Boolean);
  const deletes = a.includes("-delete") || a.some((x, i) => ["-exec", "-execdir", "-ok", "-okdir"].includes(x) && ["rm", "shred", "unlink", "mv"].includes(basename(a[i + 1] ?? "")));
  if (deletes && !(starts.length && starts.every((s) => removable(s, ctx)))) return "find that deletes files: allowed only under removable directories";
  if (a.some((x) => ["-fprint", "-fprintf", "-fls"].includes(x))) return "find writing files";
  return null;
}

function curlLikeRule(cmd, a, ctx) {
  const blockedFlags = ["-x", "--proxy", "--preproxy", "--socks4", "--socks4a", "--socks5", "--socks5-hostname", "--resolve", "--connect-to", "-K", "--config", "-i", "--input-file", "-e", "--execute"];
  const valueFlags = new Set(["-o", "--output", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-X", "--request", "-u", "--user", "-A", "--user-agent", "-b", "--cookie", "-c", "--cookie-jar", "-F", "--form", "-T", "--upload-file", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "--retry", "-O", "--output-document", "-P", "--directory-prefix", "-t", "--tries", "-T", "--timeout", "--header", "--method", "--body-data", "--post-data", "-a", "--append-output", "--user-agent"]);
  const urls = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const flag = x.split("=")[0];
    if (blockedFlags.includes(flag) && !(cmd !== "curl" && cmd !== "wget" && flag === "-i")) return `${cmd} ${flag}: proxies, resolver overrides and URL lists are not allowed`;
    if (valueFlags.has(x)) {
      i++;
      continue;
    }
    if (x.startsWith("-")) continue;
    if (cmd !== "curl" && cmd !== "wget" && /^[A-Za-z-]+[:=]/.test(x) && !x.includes("://")) continue; // httpie items (Header:value, field=value)
    urls.push(x);
  }
  for (const u of urls) {
    const host = urlHost(u);
    if (!host) return `${cmd}: cannot read the host of "${u}"`;
    if (!hostAllowed(host, ctx)) return `${cmd} to ${host}: the host is not in guard.network.allowHosts`;
  }
  return null;
}

function sshRule(w, ctx) {
  const VALUE = new Set(["-p", "-i", "-o", "-l", "-F", "-J", "-L", "-R", "-D", "-W", "-b", "-c", "-E", "-e", "-m", "-O", "-Q", "-S", "-w", "-B"]);
  let i = 1;
  while (i < w.length && w[i].startsWith("-")) i += VALUE.has(w[i]) ? 2 : 1;
  if (w.slice(1, i).some((x) => /^-[a-zA-Z]*[LRDWJ]/.test(x))) return "ssh tunnels and jumps are not allowed";
  const host = (w[i] ?? "").replace(/^[^@]*@/, "");
  if (!ctx.policy.network.readOnlySsh.includes(host)) return `ssh to ${host || "?"}: the host is not in guard.network.readOnlySsh`;
  return evaluateRemote(w.slice(i + 1).join(" "));
}

const SECRET_VAR = /\$\{?[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\}?/;
const SECRET_SAFE = new Set(["ls", "stat", "test", "[", "wc", "file", "source", "."]);

function secretRule(seg, all, cmd, a, ctx) {
  if (all.length === 1 && ["env", "printenv", "export", "set", "declare"].includes(all[0])) return "printing the environment puts secrets in the round's transcript: ask for one variable by name";
  if ((cmd === "export" && a.includes("-p")) || (cmd === "declare" && a.some((x) => /^-[a-z]*[px]/.test(x)))) return "printing the environment puts secrets in the round's transcript";
  if (cmd === "printenv" && a.some((x) => /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(x))) return "printing a secret variable";
  if (SECRET_VAR.test(seg)) return "the command expands a variable that looks like a secret (KEY, TOKEN, SECRET, PASSWORD): it would end up in the transcript";
  if (ctx.policy.secrets.allowRead) return null;
  const quietGrep = (cmd === "grep" || cmd === "egrep" || cmd === "rg") && a.some((x) => /^-[a-zA-Z]*[cqlL][a-zA-Z]*$/.test(x) || ["--count", "--quiet", "--silent", "--files-with-matches", "--files-without-match"].includes(x));
  if (SECRET_SAFE.has(cmd) || quietGrep) return null;
  const candidates = [...a.filter((x) => !x.startsWith("-") || x.includes("=")).map((x) => (x.startsWith("-") ? x.split("=").slice(1).join("=") : x)), ...redirectTargets(seg, { input: true })];
  for (const c of candidates) {
    if (!c || c.includes("://")) continue;
    if (isSecretPath(full(c, ctx), ctx)) {
      const hint = basename(c).startsWith(".env") ? ` (to check that a key exists: grep -c '^NAME=' ${basename(c)})` : "";
      return `${cmd} on ${c}: reading secret files puts them in the transcript${hint}`;
    }
  }
  return null;
}

function pathArgsRule(cmd, a, ctx) {
  let targets = [];
  const ops = operands(a);
  if (["cp", "ln", "install"].includes(cmd)) targets = ops.slice(-1);
  else if (cmd === "mv") targets = ops;
  else if (["tee", "truncate", "touch", "mkdir", "rmdir", "unlink"].includes(cmd)) targets = ops;
  else if (cmd === "chmod") targets = ops.slice(1);
  else if ((cmd === "sed" || cmd === "perl") && a.some((x) => /^-[a-zA-Z]*i/.test(x) || x === "--in-place")) targets = ops.slice(1);
  else if (cmd === "dd") targets = a.filter((x) => x.startsWith("of=")).map((x) => x.slice(3));
  else if (cmd === "rsync" && !a.some((x) => /^[^/]*:/.test(x))) targets = ops.slice(-1);
  for (const t of targets) {
    const why = writeProblem(t, ctx);
    if (why) return `${cmd} ${t}: ${why}`;
  }
  return null;
}

function segmentRule(seg, ctx, depth) {
  const all = words(seg);
  const w = withoutRedirections(programWords(all));
  const p = ctx.policy;

  for (const t of redirectTargets(seg)) {
    const why = writeProblem(t, ctx);
    if (why) return `redirect to ${t}: ${why}`;
  }
  if (!w.length) return secretRule(seg, all, "", [], ctx);
  const cmd = basename(w[0]);
  const a = w.slice(1);

  if (p.deniedCommands.includes(cmd)) return `${cmd} is in guard.deniedCommands`;
  if (cmd === "sudo" || cmd === "doas" || cmd === "su" || cmd === "pkexec" || all.includes("sudo")) return `${cmd === "sudo" || all.includes("sudo") ? "sudo" : cmd}: the loop does not change the system`;

  const secret = secretRule(seg, all, cmd, a, ctx);
  if (secret) return secret;

  if (["bash", "sh", "zsh", "dash", "ksh"].includes(cmd) && a.includes("-c")) {
    if (depth >= 3) return "shell commands nested too deeply for the guard to read";
    return evaluateCommand(a[a.indexOf("-c") + 1] ?? "", ctx, depth + 1);
  }
  if (cmd === "eval") {
    if (depth >= 3) return "eval nested too deeply for the guard to read";
    return evaluateCommand(a.join(" "), ctx, depth + 1);
  }
  if (cmd === "xargs") {
    const i = a.findIndex((x, k) => !x.startsWith("-") && !["-I", "-n", "-P", "-L", "-d", "-E", "-s"].includes(a[k - 1]));
    const sub = i >= 0 ? a.slice(i) : [];
    if (["rm", "shred", "unlink", "mv"].includes(basename(sub[0] ?? ""))) return `xargs ${sub[0]}: destructive command with targets the guard cannot see`;
    return sub.length ? segmentRule(sub.join(" "), ctx, depth + 1) : null;
  }

  if (cmd === "git") {
    let k = 0;
    while (k < a.length && a[k].startsWith("-")) k += ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(a[k]) ? 2 : 1;
    return gitRule(a.slice(k), ctx);
  }
  if (cmd === "gh") return p.publish ? ghRule(a) : null;
  const cloud = cloudRule(cmd, ctx);
  if (cloud && p.publish) return cloud;
  const pkg = packageRule(cmd, a, ctx);
  if (pkg) return pkg;
  if ((cmd === "python" || cmd === "python3") && a[0] === "-m" && ["pip", "twine"].includes(a[1])) return packageRule(a[1], a.slice(2), ctx);
  if (cmd === "docker" || cmd === "podman") {
    const r = dockerRule(cmd, a, ctx);
    if (r) return r;
  }

  if (NET_TOOLS_URL.includes(cmd)) {
    const r = curlLikeRule(cmd, a, ctx);
    if (r) return r;
  }
  if (NET_TOOLS_HOST.includes(cmd)) {
    const host = operands(a)[0];
    if (!host || !hostAllowed(host, ctx)) return `${cmd} to ${host ?? "?"}: the host is not in guard.network.allowHosts`;
  }
  if (cmd === "socat") return "socat: arbitrary network relays are not allowed";
  if (cmd === "ssh") return sshRule(w, ctx);
  if (cmd === "scp" || cmd === "sftp" || (cmd === "rsync" && a.some((x) => /^[^/]*:/.test(x) && !/^[A-Za-z]:\\/.test(x)))) return `${cmd}: no file transfers to or from remote hosts`;

  if (p.destructive) {
    if (cmd === "rm") return rmRule(a, ctx);
    if (cmd === "find") {
      const r = findRule(a, ctx);
      if (r) return r;
    }
    if (cmd === "shred" || cmd === "wipe" || cmd === "srm") return `${cmd} destroys files irrecoverably`;
    if (SYSTEM_CMDS.includes(cmd)) return `${cmd}: system configuration or state, outside the loop`;
    if (/^mkfs/.test(cmd)) return "mkfs formats a disk";
    if (cmd === "brew" && !["list", "info", "--version", "search", "outdated", "config", "doctor", "deps", "leaves"].includes(a[0])) return `brew ${a[0] ?? ""}: the loop does not install system software`.trim();
    if (SYSTEM_PKG.includes(cmd)) return `${cmd}: the loop does not install system software`;
    if ((cmd === "pkill" || cmd === "kill") && /claude|defectloop/i.test(seg)) return "the supervisor manages sessions: do not kill the agent or the loop";
    if (cmd === "pkill" && operands(a).some((x) => x === "node")) return "pkill node would kill the supervisor";
  }
  return pathArgsRule(cmd, a, ctx);
}

/** Evaluates a whole command line (Bash tool). */
export function evaluateCommand(command, ctx, depth = 0) {
  if (typeof command !== "string") return "no command";
  if (ctx.policy.destructive && /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(command)) return "downloading and executing a script from the network";
  let c = ctx;
  for (const seg of splitSegments(command)) {
    const w = words(seg);
    // `cd x && … > ../file`: relative paths after a cd are read from there, not from the root
    if ((w[0] === "cd" || w[0] === "pushd") && w[1] && !w[1].startsWith("-")) {
      c = { ...c, cwd: resolve(c.cwd ?? c.root, expandHome(w[1], c.home)) };
      continue;
    }
    const r = segmentRule(seg, c, depth);
    if (r) return r;
  }
  return null;
}

// ── read-only ssh ─────────────────────────────────────────────────────────────────────────────

const REMOTE_READ = new Set(["cat", "tail", "head", "grep", "egrep", "zgrep", "zcat", "awk", "sed", "sort", "uniq", "wc", "cut", "tr", "ls", "du", "df", "free", "uptime", "date", "echo", "printf", "ps", "top", "journalctl", "stat", "find", "test", "true", "hostname", "whoami", "id", "cd", "pwd", "jq", "docker", "git", "curl", "column", "nproc", "vmstat", "iostat", "ss", "netstat", "file", "md5sum", "sha256sum", "basename", "dirname", "realpath", "lscpu", "dmesg", "sleep"]);
const SQL_WRITE = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|vacuum|reindex|cluster|refresh|copy|comment|lock|call|do|merge|set\s+role|select\s+[^;]*\binto\b|pg_terminate_backend|pg_cancel_backend|nextval|setval)\b/i;
const REDIS_READ = new Set(["info", "xlen", "xinfo", "xrange", "xrevrange", "xpending", "llen", "lrange", "scard", "smembers", "zcard", "zrange", "get", "mget", "ttl", "pttl", "type", "exists", "dbsize", "scan", "hgetall", "hget", "hlen", "memory", "ping", "slowlog", "client", "strlen", "config"]);

/** A command passed to `ssh <read-only host>`: allowed only if it reads. */
export function evaluateRemote(remote) {
  if (!String(remote).trim()) return "ssh without a command would open an interactive shell: pass the read command";
  if (/(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)/.test(stripQuoted(remote).replace(/[12]?>&[12]/g, ""))) return "redirect to a file on the remote host: the loop does not write there";
  for (const seg of splitSegments(remote)) {
    let w = programWords(words(seg).filter((x) => !/^[0-9]*[<>]{1,2}(&[0-9-]|\/dev\/null)?$/.test(x)));
    if (["for", "case", "select"].includes(w[0])) continue;
    while (["do", "then", "else", "elif", "if", "while", "until", "{", "}", "!", "done", "fi", "esac"].includes(w[0])) w = w.slice(1);
    if (!w.length) continue;
    const cmd = basename(w[0]);
    if (!REMOTE_READ.has(cmd)) return `on the remote host "${cmd}" is not a read-only command`;
    if (cmd === "sed" && w.some((x) => /^-[a-z]*i/.test(x) || x === "--in-place")) return "sed -i modifies files on the remote host";
    if (cmd === "find" && w.some((x) => ["-delete", "-exec", "-execdir", "-ok", "-fprint"].includes(x))) return "find with -delete/-exec on the remote host";
    if (cmd === "dmesg" && w.some((x) => /^-[a-z]*[cC]/.test(x))) return "dmesg -c clears the buffer";
    if (cmd === "curl" && w.some((x) => /^(-X|--request|-d|--data.*|-F|--form|-T|--upload-file|-o|--output)$/.test(x))) return "curl in write mode on the remote host";
    if (cmd === "git" && !["status", "log", "diff", "show", "rev-parse", "branch", "describe"].includes(w[1])) return `git ${w[1] ?? ""} on the remote host: read only (status, log, diff, show)`;
    if (cmd === "docker") {
      const r = remoteDocker(w.slice(1), seg);
      if (r) return r;
    }
  }
  return null;
}

function remoteDocker(a, seg) {
  const s = a[0];
  if (["ps", "logs", "inspect", "images", "top", "version", "info", "stats"].includes(s)) {
    if (s === "stats" && !a.includes("--no-stream")) return "docker stats without --no-stream does not terminate";
    return null;
  }
  if (s === "compose") {
    const k = a.findIndex((x, i) => i > 0 && !x.startsWith("-") && !/\.(ya?ml|env)$/.test(x) && !["-f", "--file", "--env-file", "-p", "--project-name"].includes(a[i - 1]));
    const sub = a[k];
    if (["ps", "logs", "images", "top", "ls"].includes(sub)) return null;
    if (sub === "exec") return remoteDocker(a.slice(k), seg);
    return `docker compose ${sub ?? ""} on the remote host: only ps/logs/exec in read mode (config would print secrets)`;
  }
  if (s === "exec") {
    const i = a.findIndex((x, k) => k > 0 && !x.startsWith("-") && !["-e", "-u", "-w", "--env", "--user", "--workdir"].includes(a[k - 1]));
    if (a.slice(1, i).some((x) => /^-[a-z]*[it]/.test(x) && x !== "-e" && x !== "-T")) return "interactive docker exec on the remote host";
    const prog = basename(a[i + 1] ?? "");
    const rest = a.slice(i + 2);
    if (prog === "psql") {
      const k = rest.findIndex((x) => /^-[a-zA-Z]*c$/.test(x));
      const sql = k >= 0 ? (rest[k + 1] ?? "") : (rest.find((x) => x.startsWith("--command=")) ?? "").slice(10);
      if (!sql) return 'psql on the remote host only with -c "SELECT …" (no interactive session or files)';
      if (SQL_WRITE.test(sql)) return "write SQL on a remote database: only SELECT/WITH/EXPLAIN";
      return null;
    }
    if (prog === "redis-cli") {
      const c = rest.filter((x, k) => !x.startsWith("-") && !["-h", "-p", "-a", "-n", "--user", "--pass"].includes(rest[k - 1]))[0]?.toLowerCase();
      if (!c || !REDIS_READ.has(c)) return `redis-cli ${c ?? "interactive"} on the remote host: read commands only`;
      if (c === "config" && !/config\s+get/i.test(seg)) return "redis-cli config: get only";
      if (c === "client" && !/client\s+(list|info)/i.test(seg)) return "redis-cli client: list/info only";
      return null;
    }
    if (prog === "env") return "env inside a container would print its secrets";
    if (["cat", "ls", "tail", "head", "df", "du", "ps"].includes(prog)) return null;
    return `docker exec ${prog} on the remote host: allowed are psql -c SELECT, redis-cli reads, cat/ls/tail/head`;
  }
  return `docker ${s ?? ""} on the remote host: only ps, logs, inspect, stats --no-stream, exec in read mode`;
}

// ── tools ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates a PreToolUse payload. Returns the reason to block, or null to allow.
 * @param {object} payload `{ tool_name, tool_input, cwd? }` as Claude Code sends it
 * @param {{ root: string, home: string, policy: object, stateDir?: string, protectedFiles?: string[], tmpDirs?: string[], round?: string|null, recentFiles?: () => string[], cwd?: string, globalDir?: string }} ctx
 */
export function evaluate(payload, ctx) {
  if (!payload || typeof payload !== "object" || typeof payload.tool_name !== "string" || !payload.tool_name) return "unrecognized hook payload: blocked by default";
  const name = payload.tool_name;
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (typeof payload.cwd === "string" && payload.cwd && !ctx.cwd) ctx = { ...ctx, cwd: payload.cwd };
  const t = ctx.policy.tools;

  if (t.deny.includes(name)) return `${name}: nobody answers and the loop does not schedule work on its own; put questions for a human in the outcome as "proposed" findings`;
  if (name === "Bash") return typeof input.command === "string" ? evaluateCommand(input.command, ctx) : "Bash call without a command string";
  if (WRITE_TOOLS.has(name)) {
    const p = input.file_path ?? input.notebook_path;
    return typeof p === "string" && p ? writeProblem(p, ctx) : `${name} call without a file path`;
  }
  if (name === "Read" || name === "Grep" || name === "NotebookRead") {
    const p = input.file_path ?? input.path ?? input.notebook_path;
    if (!ctx.policy.secrets.allowRead && typeof p === "string" && p && isSecretPath(full(p, ctx), ctx)) return `${name} on ${p}: secret files stay out of the transcript (guard.secrets.allowRead)`;
    return null;
  }
  if (name === "WebFetch") {
    const host = typeof input.url === "string" && /^https?:\/\//i.test(input.url) ? urlHost(input.url) : null;
    if (!host) return "WebFetch without a valid http(s) URL";
    return hostAllowed(host, ctx) ? null : `WebFetch to ${host}: the host is not in guard.network.allowHosts`;
  }
  if (name === "WebSearch") return ctx.policy.network.allowWebSearch ? null : "WebSearch sends queries to a search provider (guard.network.allowWebSearch is false)";
  if (name === "Skill") {
    const s = String(input.skill ?? "").replace(/^\//, "").split(/\s/)[0];
    return t.skillDeny.includes(s) ? `the skill "${s}" is in guard.tools.skillDeny` : null;
  }
  if (name.startsWith("mcp__")) {
    const server = name.slice(5).split("__")[0];
    return t.mcpAllow.includes(server) ? null : `${name}: MCP server "${server}" is not in guard.tools.mcpAllow`;
  }
  if (READ_TOOLS.has(name) || t.allow.includes(name)) return null;
  return `${name}: tool unknown to the guard, blocked by default (guard.tools.allow to allow it)`;
}

/** Files under `root` modified in the last `windowMs`, for the blind-commit rule. Bounded scan. */
export function recentlyModified(root, { windowMs, now = Date.now(), skip = [], limit = 8, maxEntries = 20000 }) {
  const out = [];
  const skipNames = new Set([".git", "node_modules", ...skip.map((s) => basename(s))]);
  const skipAbs = skip.filter((s) => isAbsolute(s));
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 12 || out.length >= limit || seen > maxEntries) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit || ++seen > maxEntries) return;
      const p = join(dir, e.name);
      if (skipNames.has(e.name) || skipAbs.some((s) => inside(p, s))) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) {
        try {
          if (now - statSync(p).mtimeMs < windowMs) out.push(p);
        } catch {
          /* file vanished: it was moving */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}
