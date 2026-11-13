// SPDX-License-Identifier: Apache-2.0
//
// A small shell tokenizer: enough to recognise which programs a command line runs and with which
// arguments. It is not a shell parser and does not try to be one: anything it cannot follow
// (deep nesting, here-docs with commands inside, aliases, functions) is the guard's blind spot, not
// a guarantee. See docs/security.md.

/** Splits a command line into segments at ; && || | & newlines ( ) and backticks, honouring quotes. */
export function splitSegments(command) {
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') {
        cur += command[i + 1] ?? "";
        i++;
      } else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === "\\") {
      cur += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    // `2>&1`, `>&2`, `&>file` are redirections, not separators
    if (c === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) {
      cur += c;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      // command substitution: its content is a segment of its own
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The words of a segment with quotes removed (enough to recognise a program and its arguments). */
export function words(seg) {
  const out = [];
  let cur = "";
  let q = null;
  let quoted = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      // inside double quotes `\"` is a quote character, not the end of the string
      if (c === "\\" && q === '"' && '"\\$`'.includes(seg[i + 1] ?? "")) cur += seg[++i];
      else if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      quoted = true;
      continue;
    }
    if (c === "\\") {
      cur += seg[++i] ?? "";
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || quoted) out.push(cur);
      cur = "";
      quoted = false;
      continue;
    }
    cur += c;
  }
  if (cur || quoted) out.push(cur);
  return out;
}

/** The segment with the content of quoted strings blanked out: to find real redirections, not a `>`
 *  inside a regex or a sed script. */
export function stripQuoted(s) {
  let out = "";
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') {
        out += "  ";
        i++;
      } else if (c === q) {
        q = null;
        out += c;
      } else out += " ";
      continue;
    }
    if (c === "'" || c === '"') q = c;
    if (c === "\\") {
      out += `${c}${s[i + 1] ?? ""}`;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

const PREFIXES = new Set(["command", "exec", "nohup", "time", "nice", "env", "builtin", "caffeinate", "stdbuf", "ionice", "timeout"]);

/** The words from the real program on: skips `VAR=x` assignments and wrappers like `nohup`/`env`. */
export function programWords(w) {
  let i = 0;
  while (i < w.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
    else if (PREFIXES.has(w[i])) {
      i++;
      // wrapper options (`nice -n 5`, `timeout 30`) are skipped until the next word that is not one
      while (i < w.length && (/^-/.test(w[i]) || (w[i - 1] === "-n" || /^\d+[smhd]?$/.test(w[i])))) i++;
    } else break;
  }
  return w.slice(i);
}

/** Real redirection targets of a segment (`> f`, `>> f`, `&> f`, `1> f`; `< f` with `input`), quotes
 *  honoured: the operator is found in the quote-stripped text, the target is read from the original
 *  (both have the same length), so `> ".env"` is seen as `.env`. */
export function redirectTargets(seg, { input = false } = {}) {
  const out = [];
  const stripped = stripQuoted(seg);
  const re = input ? /(?:^|[^<])<(?![<(])\s*/g : /(?:^|[^0-9<>&])(?:[0-9]|&)?>{1,2}\|?\s*/g;
  for (const m of stripped.matchAll(re)) {
    const at = m.index + m[0].length;
    if (at >= seg.length || seg[at] === "&") continue;
    const w = words(seg.slice(at).replace(/^([^\s;&|<>]*).*$/s, "$1"))[0];
    if (w) out.push(w);
  }
  return out;
}
