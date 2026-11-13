// SPDX-License-Identifier: Apache-2.0
//
// Turns stream-json events into short human-readable journal lines (`defectloop status`, journal.log).

function short(s, n) {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Zero or more journal lines for one event. Unknown events produce no line. */
export function journalLines(e) {
  if (e?.type === "assistant") {
    const out = [];
    for (const b of e.message?.content ?? []) {
      if (b?.type === "text" && b.text?.trim()) out.push(`» ${short(b.text, 220)}`);
      if (b?.type === "tool_use") {
        const i = b.input ?? {};
        const name = String(b.name ?? "");
        if (name === "Bash") out.push(`$ ${short(i.command, 180)}`);
        else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) out.push(`✎ ${i.file_path ?? i.notebook_path ?? ""}`);
        else if (name === "Agent" || name === "Task") out.push(`⇢ subagent ${i.subagent_type ?? ""}: ${short(i.description, 80)}`);
        else if (name === "Skill") out.push(`◆ skill ${i.skill ?? ""}`);
        else if (name.startsWith("mcp__")) out.push(`◇ ${name.slice(5)}`);
      }
    }
    return out;
  }
  if (e?.type === "result") {
    const min = Math.round((e.duration_ms ?? 0) / 60000);
    const cost = typeof e.total_cost_usd === "number" ? ` · $${e.total_cost_usd.toFixed(2)}` : "";
    return [`■ session end: ${e.is_error ? "ERROR" : "ok"} · ${e.num_turns ?? "?"} turns · ${min} min${cost}${e.is_error ? ` · ${short(e.result, 200)}` : ""}`];
  }
  if (e?.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") return ["⏸ rate limited"];
  return [];
}
