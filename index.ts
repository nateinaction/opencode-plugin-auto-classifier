// jev-classifier - classify shell commands with TypeSafe Jev via OpenCode Zen.
//
// What it does
//   Every shell command the agent tries to run, plus every file read and edit,
//   is sent to Jev (a "System One" decision model) which returns a category, a
//   risk score, and probabilities that the action is destructive or exposes
//   secrets. The plugin then folds that decision into OpenCode's permission
//   evaluation: actions that would otherwise auto-run are escalated to `ask`,
//   and clearly destructive ones are `deny`ed. It also registers a
//   `jev_classify_command` tool so the model (or a human) can classify any
//   shell command on demand.
//
//   Covered permission actions this way:
//     shell -> the command text
//     read  -> "Read the contents of the file at: <path>"
//     edit  -> "Write to or modify the file at: <path>"  (edit/write/patch)
//
// Why Jev and not an LLM
//   Jev does not generate text. It answers typed questions about the command,
//   so the result is directly usable and fast (a few hundred milliseconds).
//
// Configuration (all optional)
//   { "plugins": [{ "package": "./opencode-auto-classifier", "options": {
//       "model": "jev-1.13",          // paid Jev (needs an inference key)
//       "askRisk": 0.7,                // risk >= this         -> ask
//       "askDestructive": 0.4,         // destructive >= this  -> ask
//       "askSecret": 0.8,              // secret exposure >= this -> ask
//       "denySecret": 1.01,            // secret exposure >= this -> deny (off by default)
//       "denyDestructive": 0.97,       // destructive >= this  -> deny
//       "denyRisk": 1.01,              // risk >= this         -> deny (off by default)
//       "fallbackModel": "opencode-go/deepseek-v4.1-flash", // used when Jev fails
//       "failMode": "open"             // "open" leaves the decision unchanged on error
//   } }] }
//
// Calls are either the paid Jev model or, on failure, the LLM fallback; the
// paid model reads its key from OPENCODE_API_KEY when no explicit one is set.

import { createClassifier } from "./jev.ts"
import { JevClassifierRpc } from "./rpc.ts"

type FailMode = "open" | "closed"

type ActionThresholds = { risk?: number; destructive?: number; secret?: number }

type Options = {
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
}

type Decision = {
  effect: "ask" | "deny" | undefined
  reason: string
}

const DEFAULTS = {
  model: "jev-1.13",
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
  fallback: true,
  fallbackModel: "opencode-go/deepseek-v4.1-flash",
  failMode: "open" as FailMode,
  cacheTtlMs: 5 * 60_000,
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function normalize01(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function parseModelRef(ref: string): { providerID: string; id: string } {
  const slash = ref.indexOf("/")
  if (slash === -1) return { providerID: "opencode-go", id: ref }
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) }
}

function decide(classification: any, opts: Required<Options>, action = "shell"): Decision {
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
    return { effect: "deny", reason: `Jev flagged this as destructive. ${bits}` }
  }
  if (secretExposure >= opts.denySecret) {
    return { effect: "deny", reason: `Jev flagged certain secret exposure. ${bits}` }
  }
  if (shell && risk >= opts.denyRisk) {
    return { effect: "deny", reason: `Jev rated this action critical. ${bits}` }
  }
  if (destructive >= escDestructive) {
    return escalate(`Jev flagged possible data loss. ${bits}`)
  }
  if (secretExposure >= escSecret) {
    return escalate(`Jev flagged possible secret exposure. ${bits}`)
  }
  if (shell && risk >= escRisk) {
    return escalate(`Jev rated this action risky. ${bits}`)
  }
  if (shell && opts.privilegedAsk && category === "privileged") {
    return escalate(`Privileged action. ${bits}`)
  }
  return { effect: undefined, reason: bits }
}

function normalize(options: Options): Required<Options> {
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as Required<Options>
}

function rank(effect: "allow" | "ask" | "deny"): number {
  return effect === "deny" ? 2 : effect === "ask" ? 1 : 0
}

export default {
  id: "jev-classifier",

  async setup(ctx: any) {
    const opts = normalize((ctx.options ?? {}) as Options)
    const classifier = createClassifier({
      model: opts.model,
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
    })

    const log = (...args: unknown[]) => {
      if (opts.debug) console.error("[jev-classifier]", ...args)
    }

    // Rolling record of recent classifications, exposed to the TUI plugin over
    // RPC so it can render them in the sidebar.
    type RecentEntry = { at: number; action: string; resource: string; effect: string; reason: string; via: string }
    const recent: RecentEntry[] = []
    const RECENT_LIMIT = 25

    let emitClassified: ((entry: RecentEntry) => void) | undefined
    if (typeof ctx.rpc?.register === "function") {
      try {
        const registration = await ctx.rpc.register(JevClassifierRpc, {
          recent: async () => ({ entries: recent }),
        })
        emitClassified = (entry: RecentEntry) => {
          try {
            void registration.events.emit("classified", entry)
          } catch (error) {
            log("emit failed", String(error))
          }
        }
      } catch (error) {
        log("rpc registration failed", String(error))
      }
    }

    function recordEntry(entry: RecentEntry) {
      recent.unshift(entry)
      if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT
      emitClassified?.(entry)
    }

    const cache = new Map<string, { at: number; value: any }>()

    // Fallback classifier: when Jev is unavailable (rate limit, timeout, ...),
    // ask a normal LLM for the same structured verdict as JSON. It runs through
    // OpenCode's own provider transport (ctx.generate), so it uses whatever
    // connection/model OpenCode already has instead of needing another key.
    async function classifyFallback(state: string): Promise<any> {
      const model = parseModelRef(opts.fallbackModel)
      const prompt = [
        "You are a security classifier for a coding agent. Classify the action below.",
        "Reply with ONLY minified JSON and no prose, exactly:",
        '{"category":"read|write|vcs|build|network|process|privileged|other","risk":<0..1>,"destructive":<0..1>,"secret_exposure":<0..1>}',
        "risk: overall risk (data loss, irreversibility, blast radius, privilege use).",
        "destructive: probability it irreversibly destroys data or system state.",
        "secret_exposure: probability it exposes secrets or credentials.",
        "",
        `Action: ${state}`,
      ].join("\n")

      const result = await ctx.generate.text({ model, prompt })
      const text: string = result?.text ?? result?.data?.text ?? ""
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) throw new Error(`fallback: no JSON in response: ${text.slice(0, 160)}`)
      const parsed = JSON.parse(match[0])

      return {
        command: state,
        model: opts.fallbackModel,
        source: "fallback",
        category: String(parsed.category ?? "other"),
        categoryConfidence: 0,
        risk: normalize01(parsed.risk),
        destructive: normalize01(parsed.destructive),
        secretExposure: normalize01(parsed.secret_exposure ?? parsed.secretExposure),
      }
    }

    async function classify(state: string, signal?: AbortSignal) {
      const hit = cache.get(state)
      const now = Date.now()
      if (hit && now - hit.at < opts.cacheTtlMs) return hit.value

      let value: any
      try {
        value = await classifier.classify(state, signal)
        if (value && value.source === undefined) value.source = "jev"
      } catch (error) {
        if (!opts.fallback || typeof ctx.generate?.text !== "function") throw error
        log("jev failed; using fallback", opts.fallbackModel, String(error).slice(0, 140))
        value = await classifyFallback(state)
        value.fallbackReason = String(error).slice(0, 160)
      }

      if (cache.size > 500) cache.clear()
      cache.set(state, { at: now, value })
      return value
    }

    // Map a permission action + resource to a state Jev can reason about.
    // Shell resources are command strings; read/edit resources are file paths,
    // which we describe in words because a bare path carries little signal.
    function describe(action: string, resource: string): string | undefined {
      if (action === "shell") return resource
      if (action === "read") return `Read the contents of the file at: ${resource}`
      if (action === "edit") return `Write to or modify the file at: ${resource}`
      return undefined
    }

    // Turn a set of resources into a single decision by taking the most severe
    // classification across them. `label` is what the model/permission banner
    // sees; `state` is the text sent to Jev.
    async function classifyAll(
      items: Array<{ label: string; state: string; action: string }>,
      signal?: AbortSignal,
    ): Promise<Decision> {
      let worst: Decision = { effect: undefined, reason: "" }
      for (const item of items) {
        const classification = await classify(item.state, signal)
        const decision = decide(classification, opts, item.action)
        log("classified", JSON.stringify({ resource: item.label, effect: decision.effect, reason: decision.reason }))
        recordEntry({
          at: Date.now(),
          action: item.action,
          resource: item.label,
          effect: decision.effect ?? "allow",
          reason: decision.reason,
          via: classification.source ?? "jev",
        })
        if (!decision.effect) continue
        const labelled: Decision = { effect: decision.effect, reason: `${decision.reason} [${item.label}]` }
        if (rank(labelled.effect ?? "allow") > rank(worst.effect ?? "allow")) worst = labelled
      }
      return worst
    }

    // Core wrapper: intercept shell, read, and edit permission evaluations and
    // fold in Jev's verdict. Hooks run for both `allow` and `ask` decisions, so
    // an action the user configured to auto-run can still be escalated. We never
    // lower a decision; an explicit `deny` does not reach the hook at all.
    await ctx.permission.hook("evaluate", async (event: any) => {
      const resources: string[] = Array.isArray(event.resources) ? event.resources : []
      const items = resources
        .map((resource) => ({ label: resource, action: event.action as string, state: describe(event.action, resource) }))
        .filter((item): item is { label: string; state: string; action: string } => Boolean(item.state && item.state.trim()))
      if (items.length === 0) return

      let decision: Decision
      try {
        decision = await classifyAll(items)
      } catch (error) {
        log("classification failed", String(error))
        if (opts.failMode === "closed" && event.effect === "allow") {
          event.effect = opts.escalateTo
          event.message = `[jev-classifier] Jev unavailable; failing ${opts.escalateTo}. (${String(error).slice(0, 120)})`
        }
        return
      }

      if (!decision.effect) return
      if (rank(decision.effect) <= rank(event.effect ?? "allow")) {
        // Only annotate an already-escalated request.
        if (decision.effect === "ask" && event.effect === "ask" && !event.message) {
          event.message = `[jev-classifier] ${decision.reason}`
        }
        return
      }

      event.effect = decision.effect
      event.message = `[jev-classifier] ${decision.reason}`
    })

    // On-demand classification tool. Useful when the agent wants to reason
    // about a command before running it, or when a human asks why something
    // was escalated.
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "jev_classify_command",
        description:
          "Classify a shell command before running it. Returns the command category, a 0-1 risk score, and probabilities that it is destructive or exposes secrets. Backed by TypeSafe Jev (a fast decision model), not an LLM.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to classify." },
          },
          required: ["command"],
          additionalProperties: false,
        },
        execute: async (input: { command: string }, context: { signal?: AbortSignal }) => {
          const classification = await classify(input.command, context?.signal)
          const decision = decide(classification, opts)
          const lines = [
            `command: ${input.command}`,
            `category: ${classification.category} (${pct(classification.categoryConfidence)} confidence)`,
            `risk: ${pct(classification.risk)}${classification.riskLegend ? ` — ${classification.riskLegend}` : ""}`,
            `destructive: ${pct(classification.destructive)}`,
            `secret_exposure: ${pct(classification.secretExposure)}`,
            `recommended_effect: ${decision.effect ?? "allow"}`,
          ]
          return {
            content: lines.join("\n"),
            metadata: {
              category: classification.category,
              risk: classification.risk,
              destructive: classification.destructive,
              secretExposure: classification.secretExposure,
              effect: decision.effect ?? "allow",
              model: classification.model,
            },
          }
        },
      })
    })

    log("ready", JSON.stringify({ model: opts.model, failMode: opts.failMode }))
  },
}
