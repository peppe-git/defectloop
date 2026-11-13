// SPDX-License-Identifier: Apache-2.0
//
// Public API. The CLI (bin/defectloop.mjs) is the main entry point; these exports are for embedding
// and for writing other adapters.

export { runLoop } from "./supervisor.mjs";
export { pickCampaign, pickArea, scoreTechnique, updateStats, isEligible, DEFAULT_SCORING } from "./scheduler.mjs";
export { createStreamMonitor } from "./stream.mjs";
export { classifyRoundEnd, nextAction, checkAuthSource } from "./limits.mjs";
export { budgetGate, roundCharge, spendSoFar, validateBudget } from "./budget.mjs";
export { normalizeOutcome, fingerprint, FINDING_STATUSES, SEVERITIES, CATEGORIES } from "./outcome.mjs";
export { validateCatalog, loadCatalog } from "./catalog.mjs";
export { resolveConfig, loadConfig } from "./config.mjs";
export { evaluate, evaluateCommand, evaluateRemote, resolvePolicy } from "./guard/rules.mjs";
