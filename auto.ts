// Pure decision logic for the `auto-mode` profile.
//
// Mirrors Claude Code's auto-mode classifier: enumerated rules and a stated
// user intent produce a *binary* allow/deny (the classifier never asks), with
// precedence applied here rather than by the classifier. It also owns the two
// policy questions that sit around the classifier: which actions are reviewed
// at all (`coverageFor`), and how the verdict becomes an OpenCode effect
// (`autoAuthority`).
//
// Side-effect free, so it is unit-testable without the OpenCode runtime.

import { pct, REPEAT_DEFAULTS, type Options } from "./decide.ts"

export type AutoVerdict = {
  category?: string
  /** 0..1 overall risk (shell commands only). */
  risk: number
  /** 0..1 probability of irreversible data/system damage. */
  destructive: number
  /** 0..1 probability of leaking secrets or credentials. */
  secretExposure: number
  /** Matched hard-deny rule label, or undefined/"none". */
  hardDenyRule?: string
  /** Matched soft-deny rule label, or undefined/"none". */
  softDenyRule?: string
  /** Matching allow exception label, or undefined/"none". */
  allowRule?: string
  /** Probability the action reaches outside the trust boundary. */
  trustExternal: number
  /** Probability the user's message explicitly names and authorizes this action. */
  userAuthorizes: number
  /** Probability the action crosses a boundary the user stated. */
  userForbids: number
  /** Probability the action escalates beyond what the user asked. */
  scopeEscalation: number
  /** Lowest confidence among the decision-relevant answers. */
  confidence: number
  source?: string
}

export type AutoDecision = { effect: "allow" | "deny"; rule?: string; reason: string }

/** A yes/no answer at or above this probability counts as "yes". */
export const INTENT_THRESHOLD = 0.5

/** A yes/no answer within this band of the threshold is too close to call. */
export const AMBIGUOUS_BAND = 0.1

function ruleName(value: string | undefined): string | undefined {
  const name = (value ?? "").trim()
  return !name || name.toLowerCase() === "none" ? undefined : name
}

const yes = (value: number): boolean => value >= INTENT_THRESHOLD

/** Fold an auto-mode verdict into a binary decision, applying rule precedence. */
export function decideAuto(verdict: AutoVerdict, opts: Required<Options>, action = "shell"): AutoDecision {
  const { category, risk, destructive, secretExposure } = verdict
  const bits = `risk=${pct(risk)} destructive=${pct(destructive)} secret=${pct(secretExposure)} via=${verdict.source ?? "jev"}`
  const deny = (rule: string | undefined, reason: string): AutoDecision => ({ effect: "deny", rule, reason: `${reason} ${bits}` })

  const hard = ruleName(verdict.hardDenyRule)
  if (hard) return deny(hard, `Matched hard rule [${hard}].`)

  if (yes(verdict.userForbids)) return deny("User Boundary", "The user stated a boundary this action crosses.")

  const soft = ruleName(verdict.softDenyRule)
  if (soft) {
    const cleared = ruleName(verdict.allowRule) || yes(verdict.userAuthorizes)
    if (!cleared) return deny(soft, `Matched soft rule [${soft}].`)
  }

  if (yes(verdict.scopeEscalation)) return deny("Scope Escalation", "The action escalates beyond what the user asked.")

  // Reaching outside the trust boundary. "Where a rule requires it" means the
  // action also carries a sensitive effect; a bare external read-only fetch is
  // left to the rules rather than denied outright.
  if (yes(verdict.trustExternal) && (destructive >= INTENT_THRESHOLD || secretExposure >= INTENT_THRESHOLD)) {
    return deny("External", "The action reaches outside the trusted environment with sensitive effect.")
  }

  if (destructive >= opts.denyDestructive) return deny("Destructive", "The action may irreversibly destroy data.")
  if (secretExposure >= opts.denySecret) return deny("Secret Exposure", "The action may expose secrets.")
  if (action === "shell" && risk >= opts.denyRisk) return deny("Critical", "The command is rated critical risk.")

  return { effect: "allow", reason: bits }
}

export type Coverage = "classify" | "allow" | "passthrough"

/**
 * Which actions auto-mode reviews. Read-only tools are auto-allowed (Claude
 * Code skips them); edits are classified only when outside the project;
 * everything else (subagent, MCP, skills, questions) passes through unchanged.
 */
export function coverageFor(action: string, external: boolean): Coverage {
  if (action === "read" || action === "glob" || action === "grep") return "allow"
  if (action === "shell" || action === "webfetch" || action === "websearch" || action === "external_directory") {
    return "classify"
  }
  if (action === "edit") return external ? "classify" : "allow"
  return "passthrough"
}

export type AuthorityContext = {
  /** OpenCode has a user-configured `ask` rule for this action/resource. */
  userAskRule: boolean
  /** Repeated blocks have paused auto-approval; prompts resume. */
  pausePrompts: boolean
}

export type Authority = { effect: "allow" | "ask" | "deny"; message?: string }

/**
 * Turn a classifier decision into the effect written back to OpenCode. Unlike
 * the classic path this may *lower* a decision: an otherwise-prompted action is
 * auto-approved when the classifier allows it. A user ask rule stays a prompt.
 */
export function autoAuthority(incoming: "allow" | "ask" | "deny", decision: AutoDecision, ctx: AuthorityContext): Authority {
  // An explicit deny never reaches the hook, but guard anyway: never lower one.
  if (incoming === "deny") return { effect: "deny" }
  // A user ask rule is their stated intent to be prompted; leave the prompt.
  if (ctx.userAskRule && incoming === "ask") return { effect: "ask" }
  if (decision.effect === "deny") return { effect: "deny", message: denyMessage(decision) }
  if (ctx.pausePrompts) return { effect: incoming }
  return { effect: "allow" }
}

/** Format a denial the way auto-mode reports it: `[auto-classifier] [Rule] reason`. */
export function denyMessage(decision: AutoDecision): string {
  const tag = decision.rule ? `[${decision.rule}] ` : ""
  return `[auto-classifier] ${tag}${decision.reason}`
}

/**
 * True when a decision-relevant answer is too uncertain to act on: either the
 * choice confidence is below `floor`, or an intent/trust signal sits within the
 * ambiguous band around its threshold (Jev's yes/no answers carry no confidence
 * of their own).
 */
export function belowConfidence(verdict: AutoVerdict, floor: number): boolean {
  if (!(verdict.confidence >= floor)) return true
  for (const prob of [verdict.trustExternal, verdict.userAuthorizes, verdict.userForbids, verdict.scopeEscalation]) {
    if (Math.abs(prob - INTENT_THRESHOLD) < AMBIGUOUS_BAND) return true
  }
  return false
}

/** True when repeated blocks have reached either configured threshold. */
export function reachedPause(consecutive: number, total: number, opts: Required<Options>): boolean {
  const { consecutive: maxConsecutive, total: maxTotal } = { ...REPEAT_DEFAULTS, ...(opts.repeatBlocks ?? {}) }
  return consecutive >= maxConsecutive || total >= maxTotal
}
