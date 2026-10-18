// Pure decision logic for auto-classifier.
//
// Everything in this module is side-effect free and depends only on its
// arguments, so it can be unit-tested without the OpenCode plugin runtime. The
// server plugin (index.ts) imports these to turn a classifier classification into an
// OpenCode permission decision.

import type { RuleLists } from "./rules.ts"

export type FailMode = "open" | "closed"
export const UNCERTAIN_POLICIES = ["tiered", "fallback", "accept", "deny"] as const
export type UncertainPolicy = (typeof UNCERTAIN_POLICIES)[number]

/** Where the classifier is served: OpenCode Zen ("jev") or OpenRouter ("openrouter"). */
export type Provider = "jev" | "openrouter"

export type ActionThresholds = { risk?: number; destructive?: number; secret?: number }

export type Options = {
  /**
   * "classic" (default) keeps the tiered escalator: a triggered threshold
   * becomes `ask` or `deny`, and the plugin never lowers a decision.
   * "auto-mode" emulates Claude Code's auto classifier: rules + intent produce
   * a binary allow/deny, and the classifier may auto-approve.
   */
  mode?: "classic" | "auto-mode"
  /** Rule lists for auto-mode (see rules.ts). "classic" ignores this. */
  rules?: RuleLists
  /** How much conversation context auto-mode sends to the classifier. */
  conversationContext?: "none" | "prompt" | "session"
  /** auto-mode: a decision-relevant answer below this is uncertain (see `onUncertain`). */
  confidenceFloor?: number
  /**
   * auto-mode: what an uncertain the classifier verdict becomes. "tiered" (the auto-mode
   * default) lets the deterministic facts decide: local work allows, while a
   * destructive, credential-bearing, privileged, or outbound action does not.
   * "fallback" asks the LLM fallback, "accept" acts on the classifier's own answers, and
   * "deny" blocks the action. The classifier failing outright is governed by `fallback`
   * and `failMode` instead.
   */
  onUncertain?: UncertainPolicy
  /** auto-mode: stop classifying and resume prompting after this many blocks. */
  repeatBlocks?: { consecutive?: number; total?: number }
  /** Where the classifier is served. Defaults to "jev" (OpenCode Zen). */
  provider?: Provider
  model?: string
  endpoint?: string
  apiKey?: string
  timeoutMs?: number
  askRisk?: number
  askDestructive?: number
  askSecret?: number
  denySecret?: number
  denyDestructive?: number
  denyRisk?: number
  privilegedAsk?: boolean
  escalateTo?: "ask" | "deny"
  /** Per-action overrides for the escalation thresholds above. */
  escalate?: Partial<Record<"shell" | "read" | "edit", ActionThresholds>>
  fallback?: boolean
  fallbackModel?: string
  failMode?: FailMode
  cacheTtlMs?: number
  debug?: boolean
  /** Where `debug` lines are appended. Empty uses OpenCode's log directory. */
  debugLog?: string
}

export type Decision = {
  effect: "ask" | "deny" | undefined
  reason: string
}

// Per-provider defaults, so selecting a provider picks its model and endpoint
// unless the user overrides them. Both providers serve the classifier with the same
// state + typed-questions API: OpenCode Zen's System One endpoint, or
// OpenRouter's Decisions API (an alpha endpoint, so its path may change).
// `apiKeyEnv` names the environment variable holding that provider's key, so
// one provider's key is never sent to the other.
export const PROVIDER_DEFAULTS: Record<Provider, { model: string; endpoint: string; apiKeyEnv: string }> = {
  jev: { model: "jev-1.13", endpoint: "https://opencode.ai/zen/v1/systemone", apiKeyEnv: "OPENCODE_API_KEY" },
  openrouter: {
    model: "typesafe/jev-1.14",
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
}

/** Default repeated-block thresholds for auto-mode (consecutive and total). */
export const REPEAT_DEFAULTS = { consecutive: 3, total: 20 }

export const DEFAULTS = {
  mode: "classic" as "classic" | "auto-mode",
  rules: {} as RuleLists,
  conversationContext: "prompt" as "none" | "prompt" | "session",
  confidenceFloor: 0.6,
  repeatBlocks: { ...REPEAT_DEFAULTS },
  debug: false,
  debugLog: "",
  provider: "jev" as Provider,
  model: PROVIDER_DEFAULTS.jev.model,
  endpoint: PROVIDER_DEFAULTS.jev.endpoint,
  timeoutMs: 10_000,
  askRisk: 0.7,
  askDestructive: 0.4,
  askSecret: 0.8,
  denySecret: 1.01,
  denyDestructive: 0.97,
  denyRisk: 1.01,
  privilegedAsk: true,
  escalateTo: "ask" as "ask" | "deny",
  escalate: {} as Partial<Record<"shell" | "read" | "edit", ActionThresholds>>,
  onUncertain: "fallback" as UncertainPolicy,
  fallback: true,
  fallbackModel: "opencode-go/deepseek-v4.1-flash",
  failMode: "open" as FailMode,
  cacheTtlMs: 5 * 60_000,
}

/** Format a 0..1 score as a whole-number percentage, e.g. 0.61 -> "61%". */
export function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

/** Coerce any value to a finite number clamped to the 0..1 range. */
export function normalize01(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Split a `provider/model` reference, defaulting the provider. */
export function parseModelRef(ref: string): { providerID: string; id: string } {
  const slash = ref.indexOf("/")
  if (slash === -1) return { providerID: "opencode-go", id: ref }
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
}

export function decide(classification: any, opts: Required<Options>, action = "shell"): Decision {
  const { category, risk, destructive, secretExposure } = classification
  const bits = `category=${category} risk=${pct(risk)} destructive=${pct(destructive)} secret=${pct(secretExposure)} via=${classification.source ?? "jev"}`
  // Shell commands are free-form, so the general risk score is meaningful. A
  // read is only interesting when it can expose secrets, and an edit when it
  // can destroy data — for those, "risk" is ~100% for every write and would
  // otherwise prompt on every source edit.
  const shell = action === "shell"
  // Escalations (the middle tier) resolve to `ask` or `deny` depending on
  // `escalateTo`. With "deny" the plugin is allow-or-deny only, so an agent
  // never waits on a prompt.
  const escalate = (reason: string): Decision => ({ effect: opts.escalateTo, reason })

  // Effective escalation thresholds: per-action overrides fall back to the
  // global ask* values.
  const esc = opts.escalate?.[action as "shell" | "read" | "edit"] ?? {}
  const escDestructive = esc.destructive ?? opts.askDestructive
  const escSecret = esc.secret ?? opts.askSecret
  const escRisk = esc.risk ?? opts.askRisk

  if (destructive >= opts.denyDestructive) {
    return { effect: "deny", reason: `The classifier flagged this as destructive. ${bits}` }
  }
  if (secretExposure >= opts.denySecret) {
    return { effect: "deny", reason: `The classifier flagged certain secret exposure. ${bits}` }
  }
  if (shell && risk >= opts.denyRisk) {
    return { effect: "deny", reason: `The classifier rated this action critical. ${bits}` }
  }
  if (destructive >= escDestructive) {
    return escalate(`The classifier flagged possible data loss. ${bits}`)
  }
  if (secretExposure >= escSecret) {
    return escalate(`The classifier flagged possible secret exposure. ${bits}`)
  }
  if (shell && risk >= escRisk) {
    return escalate(`The classifier rated this action risky. ${bits}`)
  }
  if (shell && opts.privilegedAsk && category === "privileged") {
    return escalate(`Privileged action. ${bits}`)
  }
  return { effect: undefined, reason: bits }
}

/** Merge user options over the defaults, ignoring explicit `undefined`s. */
export function normalize(options: Options): Required<Options> {
  const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined))
  const merged = { ...DEFAULTS, ...defined } as Required<Options>
  // Model and endpoint follow the selected provider unless set explicitly.
  const providerDefaults = PROVIDER_DEFAULTS[merged.provider]
  if (options.model === undefined) merged.model = providerDefaults.model
  if (options.endpoint === undefined) merged.endpoint = providerDefaults.endpoint
  // Nested options merge over their defaults rather than replacing wholesale.
  merged.repeatBlocks = { ...DEFAULTS.repeatBlocks, ...(options.repeatBlocks ?? {}) }
  // auto-mode denies an action it cannot classify unless the user chose otherwise.
  if (merged.mode === "auto-mode" && options.failMode === undefined) merged.failMode = "closed"
  // An uncertain answer is decided by the facts in auto-mode: a broken fallback
  // model must not turn a local `pytest` run into a denial.
  if (merged.mode === "auto-mode" && options.onUncertain === undefined) merged.onUncertain = "tiered"
  // A misspelled policy must not act on uncertain verdicts as "accept" would.
  if (!UNCERTAIN_POLICIES.includes(merged.onUncertain)) merged.onUncertain = "deny"
  // auto-mode leaves deletion to its rules and the user's stated intent. The classifier
  // rates nearly every rm 95-98% destructive, so a 0.97 backstop denies at
  // random and overrides an explicit request; denySecret and denyRisk are
  // already off.
  if (merged.mode === "auto-mode" && options.denyDestructive === undefined) merged.denyDestructive = 1.01
  return merged
}

export function rank(effect: "allow" | "ask" | "deny"): number {
  return effect === "deny" ? 2 : effect === "ask" ? 1 : 0
}

// Map a permission action + resource to a state the classifier can reason about.
// Shell resources are command strings; read/edit resources are file paths,
// which we describe in words because a bare path carries little signal.
export function describe(action: string, resource: string): string | undefined {
  if (action === "shell") return resource
  if (action === "read") return `Read the contents of the file at: ${resource}`
  if (action === "edit") return `Write to or modify the file at: ${resource}`
  return undefined
}
