// SPDX-License-Identifier: Apache-2.0
//
// The file a round reads first: its campaign, the environment, the budget, what not to touch, and what
// previous rounds already found. Pure: returns Markdown.

const money = (x) => `$${Number(x ?? 0).toFixed(2)}`;

export function composeContext({ round, when, campaign, capabilities = [], allCapabilities = [], budget, leftovers = [], foreign = [], findings = [], queue = [], referenceSha = null, trailer }) {
  const t = campaign.technique;
  const out = [];
  out.push(`# Round ${round} — ${when}`, "");
  out.push("## Campaign", "");
  out.push(`**${t.id} · ${t.name}**${campaign.area ? ` · area: \`${campaign.area.key}\`` : ""} · chosen because: ${campaign.reason}`, "");
  out.push(t.instructions, "");
  if (campaign.queueItem?.brief) out.push(`**Brief from the queue:** ${campaign.queueItem.brief}`, "");
  if (referenceSha) out.push(`**Reference:** commit \`${referenceSha}\` (last round of this technique): look at what landed after it.`, "");

  out.push("## Environment", "");
  const missing = allCapabilities.filter((c) => !capabilities.includes(c));
  out.push(`- Capabilities available: ${capabilities.length ? capabilities.map((c) => `\`${c}\``).join(", ") : "none declared"}${missing.length ? ` · unavailable now: ${missing.map((c) => `\`${c}\``).join(", ")}` : ""}`);
  if (budget) out.push(`- Spend (estimated by the agent): today ${money(budget.today)}${budget.dailyUsd !== undefined ? ` of ${money(budget.dailyUsd)}` : ""}, this month ${money(budget.month)}${budget.monthlyUsd !== undefined ? ` of ${money(budget.monthlyUsd)}` : ""}; this round may spend up to ${money(budget.perRoundUsd)}.`);
  out.push(`- Commits of this round must carry the trailer \`${trailer}\`.`);
  out.push("");

  if (leftovers.length) {
    out.push("## ⚠️ Uncommitted changes left by an interrupted round", "");
    out.push("They belong to the loop. First of all: finish and verify them, or set them aside with `git stash push -m defectloop-leftovers -- <file>`.", "");
    for (const f of leftovers.slice(0, 40)) out.push(`- \`${f}\``);
    out.push("");
  }
  if (foreign.length) {
    out.push("## Foreign files — do not touch, commit or stash them", "");
    out.push("They were already modified when the loop started: they are someone else's work in progress.", "");
    for (const f of foreign.slice(0, 40)) out.push(`- \`${f}\``);
    out.push("");
  }

  const open = findings.filter((r) => r.status === "proposed" || r.status === "unverified");
  out.push(`## Already recorded (${findings.length} findings; last 40, most recent first)`, "");
  out.push("Before investigating a suspicion, search the record: `defectloop search \"key words\"` (exit 0 = already seen).", "");
  for (const r of findings.slice(-40).reverse()) out.push(`- [${r.status}] ${r.title}${r.location ? ` — \`${r.location}\`` : ""} (${r.round}${r.commit ? `, ${r.commit}` : ""})`);
  if (open.length) {
    out.push("", `### Open (${open.length}): proposed or unverified`, "");
    for (const r of open.slice(-25).reverse()) out.push(`- [${r.status}] ${r.title} (${r.round})`);
  }
  if (queue.length) {
    out.push("", "### Queued for later rounds", "");
    for (const v of queue.slice(0, 10)) out.push(`- ${v.technique}${v.area ? ` · ${v.area}` : ""}: ${v.brief ?? ""}`);
  }
  out.push("");
  return out.join("\n");
}

/** Fills the prompt template placeholders. Unknown placeholders are left as they are. */
export function renderPrompt(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
}
