// Pure decision logic for the `auto-mode` profile.
//
// Mirrors Claude Code's auto-mode classifier: enumerated rules and a stated
// user intent produce an allow/deny (usually binary; a sensitive read outside
// the trusted roots asks), with precedence applied here rather than by the
// classifier. It also owns the two policy questions that sit around the
// classifier: which actions are reviewed at all (`coverageFor`), and how the
// verdict becomes an OpenCode effect (`autoAuthority`).
//
// Side-effect free, so it is unit-testable without the OpenCode runtime.

import { pct, REPEAT_DEFAULTS, type Options } from "./decide.ts"
import { NONE } from "./rules.ts"
import type { TrustFacts } from "./trust.ts"

export type AutoVerdict = {
  category?: string
  /** 0..1 overall risk (shell commands only). */
  risk: number
  /** 0..1 probability of irreversible data/system damage. */
  destructive: number
  /** 0..1 probability the action reveals a live credential (key, token, password, .env). */
  revealsCredentials: number
  /** 0..1 probability the action surfaces sensitive data the session did not already have. */
  newSensitiveData: number
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
  /** Each choice question's confidence, for debug logging. */
  choiceConfidence?: Record<string, number>
  /** Too uncertain to act on, and `onUncertain` is "deny". */
  uncertain?: boolean
  /** The verbatim user words a fallback cited for `userForbids`, when it did. */
  boundaryQuote?: string
  source?: string
}

export type AutoDecision = { effect: "allow" | "ask" | "deny"; rule?: string; reason: string }

/** A yes/no answer at or above this probability counts as "yes". */
export const INTENT_THRESHOLD = 0.5

/** A yes/no answer within this band of the threshold is too close to call. */
export const AMBIGUOUS_BAND = 0.1

/** Categories an uncertain, in-root action may hold and still be allowed. */
const TIERED_CATEGORIES = new Set(["read", "build", "write", "vcs", "other"])

/** `git status` is a read; these rewrite state and are not settled by location. */
const GIT_MUTATION =
  /\bgit\s+(?:-C\s+\S+\s+)?(?:push|commit|reset|clean|rebase|merge|tag|cherry-pick|revert|am|apply|stash|worktree\s+(?:add|remove|prune)|branch\s+-[dD])\b/

/** A push leaves the machine, so scope still applies however local the repo is. */
const GIT_PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b/

/**
 * True when the action cannot change state. Category alone is not enough (a
 * `git commit` is `vcs` too), so the path actions are listed by name and shell
 * commands have to be classified as a read by the model.
 */
export function readOnly(action: string, verdict: AutoVerdict): boolean {
  if (action === "read" || action === "glob" || action === "grep" || action === "external_directory") return true
  return action === "shell" && (verdict.category === "read" || verdict.category === "vcs")
}

function ruleName(value: string | undefined): string | undefined {
  const name = (value ?? "").trim()
  return !name || name.toLowerCase() === "none" ? undefined : name
}

const yes = (value: number): boolean => value >= INTENT_THRESHOLD

/** Fold an auto-mode verdict into a decision, applying rule precedence. */
export function decideAuto(
  verdict: AutoVerdict,
  opts: Required<Options>,
  action = "shell",
  facts?: TrustFacts,
  resource = "",
): AutoDecision {
  const { category, risk, destructive, revealsCredentials, newSensitiveData } = verdict
  const bits = `risk=${pct(risk)} destructive=${pct(destructive)} credentials=${pct(revealsCredentials)} new-data=${pct(newSensitiveData)} via=${verdict.source ?? "jev"}`
  const deny = (rule: string | undefined, reason: string): AutoDecision => ({ effect: "deny", rule, reason: `${reason} ${bits}` })
  const allow = (rule: string | undefined, reason: string): AutoDecision => ({ effect: "allow", rule, reason: `${reason} ${bits}` })

  const hard = ruleName(verdict.hardDenyRule)
  if (hard) return deny(hard, `Matched hard rule [${hard}].`)

  // The plugin resolves local paths itself; the model's trust answer only
  // decides what leaves the machine (`webfetch`/`websearch`, or a network
  // command). Inside the working directory, scratch directory, or a repo
  // worktree, an external claim cannot stand.
  const outbound = action === "webfetch" || action === "websearch" || category === "network"
  const located = facts?.known === true
  const external = outbound || !located ? yes(verdict.trustExternal) : facts?.inside !== true
  // A credential is an exposure wherever it goes. Sensitive data the session
  // did not already have is an exposure only once the action carries it out of
  // the environment; Jev's old scalar called ordinary local `pytest` and
  // `tail` runs 50-70% risky, and every one of them became a false denial.
  const credentials = yes(revealsCredentials)
  // A push carries the data off the machine even to a trusted remote, so it
  // counts as leaving for the purpose of new data.
  const leaving = outbound || external || GIT_PUSH.test(resource)
  const exposed = credentials || (yes(newSensitiveData) && leaving)
  // A local action that neither leaves the machine nor destroys data cannot
  // cross a task boundary in a way worth denying: an unrequested `pytest` or
  // `tail` is not a safety event. Scope stays meaningful for pushes, network
  // sends, destructive actions, and credentials.
  const localSafe =
    located &&
    facts?.inside === true &&
    !outbound &&
    destructive < INTENT_THRESHOLD &&
    !credentials &&
    !GIT_PUSH.test(resource)

  if (verdict.uncertain) return uncertain(verdict, opts, action, facts, bits, resource)

  if (yes(verdict.userForbids)) return deny("User Boundary", "The user stated a boundary this action crosses.")

  const soft = ruleName(verdict.softDenyRule)
  if (soft) {
    // A generic allow entry cannot clear a block on a credential-shaped action;
    // the credential answer keeps `.env` from riding `Local Operations` through.
    const clears = Boolean(ruleName(verdict.allowRule)) && !credentials
    if (!clears && !yes(verdict.userAuthorizes)) return deny(soft, `Matched soft rule [${soft}].`)
  }

  // A matched allow exception is the user's own rule list saying this action is
  // permitted. It outranks scope and trust, which are advisory guesses about
  // intent; before this, 37 of 57 denials matched an allow rule and were denied
  // anyway by the sensitivity gate. Credentials stay a block of their own.
  const allowed = ruleName(verdict.allowRule)
  if (allowed && !credentials) return allow(allowed, `Matched allow rule [${allowed}].`)

  // Scope and trust only block an action that also carries an exposure. The
  // user's request clears soft blocks; on its own it is no reason to deny. A
  // terse request ("@skill 125") never names the many harmless commands an
  // agent runs to fulfil it, and local work does not cross a trust boundary.
  const sensitive = destructive >= INTENT_THRESHOLD || exposed
  // A read outside the roots is a trust question, not a scope one: let the
  // external branch below turn it into a prompt.
  const outsideRead = located && facts?.inside === false && readOnly(action, verdict)
  if (sensitive && yes(verdict.scopeEscalation) && !localSafe && !outsideRead) {
    return deny("Scope Escalation", "The action escalates beyond what the user asked with sensitive effect.")
  }
  if (sensitive && external) {
    // A read outside the trusted roots is reviewable, not forbidden: the user
    // can approve a log or a sibling checkout without loosening everything.
    if (readOnly(action, verdict) && !outbound) {
      return { effect: "ask", rule: "External", reason: `The action reads outside the trusted environment. ${bits}` }
    }
    return deny("External", "The action reaches outside the trusted environment with sensitive effect.")
  }

  if (destructive >= opts.denyDestructive) return deny("Destructive", "The action may irreversibly destroy data.")
  if (revealsCredentials >= opts.denySecret) return deny("Secret Exposure", "The action may reveal credentials.")
  if (action === "shell" && risk >= opts.denyRisk) return deny("Critical", "The command is rated critical risk.")

  return { effect: "allow", reason: bits }
}

/**
 * Decide an inconclusive verdict from the facts, not from the model's guesses.
 *
 * The dominant false denial in the debug logs was a local `pytest`, `grep`, or
 * `tail` run whose old `secret_exposure` sat at 0.6 and whose fallback model did
 * not exist, so it failed closed. Local work is safe to allow when nothing names
 * credentials, an unrecoverable delete, privilege, or an outbound destination.
 * An LLM fallback's answer carries no calibrated confidence, so it arrives here
 * marked uncertain too: its rule labels can still deny a dangerous action, but
 * not override what the facts prove.
 */
function uncertain(
  verdict: AutoVerdict,
  opts: Required<Options>,
  action: string,
  facts: TrustFacts | undefined,
  bits: string,
  resource: string,
): AutoDecision {
  const stop = (reason: string): AutoDecision => ({ effect: "deny", rule: "Uncertain", reason: `${reason} ${bits}` })
  const credentials = yes(verdict.revealsCredentials)
  if (verdict.destructive >= INTENT_THRESHOLD) return stop("The action may destroy data and the verdict was uncertain.")
  if (credentials) return stop("The action may reveal credentials and the verdict was uncertain.")
  if (verdict.category === "privileged") return stop("The action is privileged and the verdict was uncertain.")
  if (action === "shell" && GIT_MUTATION.test(resource)) return stop("The git command rewrites state and the verdict was uncertain.")

  // A matched allow exception is the user's own rule list, so it settles the
  // uncertainty the same way it outranks scope and trust in `decideAuto`.
  const allowed = ruleName(verdict.allowRule)
  if (allowed) return { effect: "allow", rule: allowed, reason: `Uncertain, but a matched allow rule [${allowed}] covers the action. ${bits}` }

  const located = facts?.known === true && facts?.inside === true
  const categoryOk = verdict.category === undefined || TIERED_CATEGORIES.has(verdict.category)
  // A network command still needs an allow match (handled above) to clear; a
  // local one does not.
  if (located && verdict.category !== "network" && categoryOk) {
    return { effect: "allow", reason: `Uncertain, but the action stays inside the trusted environment. ${bits}` }
  }
  // A read-only action outside what the plugin can prove is reviewable, not
  // forbidden; an outside read is never a reason to deny on its own.
  if (readOnly(action, verdict)) {
    return { effect: "ask", rule: "Uncertain", reason: `The action is read-only but outside what the plugin can prove. ${bits}` }
  }
  if (opts.failMode !== "closed") {
    return { effect: "ask", rule: "Uncertain", reason: `The classifier was too uncertain to allow this action. ${bits}` }
  }
  return stop("The classifier was too uncertain to allow this action.")
}

/**
 * Decide a fallback's verdict against the Jev verdict it replaced.
 *
 * A fallback is an ordinary LLM's guess, marked at 0.5 confidence and given no
 * per-choice confidence, so it cannot override a Jev verdict that allowed the
 * action: the most it can do is turn that allow into a prompt. A dangerous
 * verdict from Jev itself is never lowered here.
 */
export function reconcileFallback(
  verdict: AutoVerdict,
  jev: AutoVerdict | undefined,
  opts: Required<Options>,
  action = "shell",
  facts?: TrustFacts,
  resource = "",
): AutoDecision {
  const decision = decideAuto(verdict, opts, action, facts, resource)
  if (!jev || decision.effect !== "deny") return decision
  if (decideAuto(jev, opts, action, facts, resource).effect !== "allow") return decision
  return { effect: "ask", rule: decision.rule, reason: `The LLM fallback would deny what Jev allowed. ${decision.reason}` }
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
  // An ask is a review request, not a block: raise a would-be auto-approval to
  // a prompt rather than denying it.
  if (decision.effect === "ask") return { effect: "ask", message: decision.rule ? denyMessage(decision) : undefined }
  if (ctx.pausePrompts) return { effect: incoming }
  return { effect: "allow" }
}

/** Format a decision the way auto-mode reports it: `[auto-classifier] [Rule] reason`. */
export function denyMessage(decision: AutoDecision): string {
  const tag = decision.rule ? `[${decision.rule}] ` : ""
  return `[auto-classifier] ${tag}${decision.reason}`
}

/** Yes/no signals that can only clear an action (permissive) or only block it (restrictive). */
const PERMISSIVE_SIGNALS = ["userAuthorizes"] as const
const RESTRICTIVE_SIGNALS = [
  "trustExternal",
  "userForbids",
  "scopeEscalation",
  "revealsCredentials",
  "newSensitiveData",
] as const

const ambiguous = (prob: number): boolean => Math.abs(prob - INTENT_THRESHOLD) < AMBIGUOUS_BAND

/** Stands in for "some rule matched" when a rule choice is settled at its restrictive end. */
const UNSURE_RULE = "Unsure"

/**
 * The verdict with each ambiguous signal, and each rule choice below `floor`,
 * settled at its most permissive (`lenient`) or most restrictive end. A hard or
 * soft rule is permissive as "none"; an allow exception is permissive as matched.
 */
function settle(verdict: AutoVerdict, lenient: boolean, floor: number): AutoVerdict {
  const settled = { ...verdict }
  for (const key of PERMISSIVE_SIGNALS) if (ambiguous(verdict[key])) settled[key] = lenient ? 1 : 0
  for (const key of RESTRICTIVE_SIGNALS) if (ambiguous(verdict[key])) settled[key] = lenient ? 0 : 1
  const choices = verdict.choiceConfidence
  if (choices) {
    // A missing confidence is unsure, so it is settled both ways like a low one.
    const unsure = (question: string): boolean => !((choices[question] ?? 0) >= floor)
    if (unsure("hard_deny_rule")) settled.hardDenyRule = lenient ? NONE : UNSURE_RULE
    if (unsure("soft_deny_rule")) settled.softDenyRule = lenient ? NONE : UNSURE_RULE
    if (unsure("allow_rule")) settled.allowRule = lenient ? UNSURE_RULE : NONE
  }
  return settled
}

/**
 * True when a decision-relevant answer is too uncertain to act on: a rule
 * choice below `floor`, or an intent/trust signal within the ambiguous band
 * around its threshold (Jev's yes/no answers carry no confidence of their
 * own), that could flip the decision.
 *
 * `decideAuto` is monotone in every answer, so settling all uncertain answers
 * at their most permissive and most restrictive ends bounds every combination:
 * if both ends decide alike, the uncertainty is irrelevant. A model answering
 * 0.5 for "not applicable" (e.g. user_authorizes when no soft rule matched), or
 * hesitating over a hard rule when a confident soft rule already denies, no
 * longer routes the action to the fallback.
 *
 * A verdict without per-choice confidences (the LLM fallback's) is judged by
 * its overall confidence alone.
 */
export function belowConfidence(verdict: AutoVerdict, floor: number, opts: Required<Options>, action = "shell"): boolean {
  if (!verdict.choiceConfidence && !(verdict.confidence >= floor)) return true
  const lenient = decideAuto(settle(verdict, true, floor), opts, action).effect
  const strict = decideAuto(settle(verdict, false, floor), opts, action).effect
  return lenient !== strict
}

/** True when repeated blocks have reached either configured threshold. */
export function reachedPause(consecutive: number, total: number, opts: Required<Options>): boolean {
  const { consecutive: maxConsecutive, total: maxTotal } = { ...REPEAT_DEFAULTS, ...(opts.repeatBlocks ?? {}) }
  return consecutive >= maxConsecutive || total >= maxTotal
}
