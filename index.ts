// jev-classifier - classify shell commands with TypeSafe Jev via OpenCode Zen.
//
// What it does
//   Every shell command the agent tries to run is sent to Jev (a "System One"
//   decision model) which returns a category, a risk score, and probabilities
//   that the command is destructive or exposes secrets. The plugin then folds
//   that decision into OpenCode's permission evaluation: risky commands that
//   would otherwise auto-run are escalated to `ask`, and clearly destructive
//   ones are `deny`ed. It also registers a `jev_classify_command` tool so the
//   model (or a human) can classify any command on demand.
//
// Why Jev and not an LLM
//   Jev does not generate text. It answers typed questions about the command,
//   so the result is directly usable and fast (a few hundred milliseconds).
//
// Configuration (all optional)
//   { "plugins": [{ "package": "./opencode-auto-classifier", "options": {
//       "model": "jev-1.13-free",     // jev-1.13-free needs no key
//       "askRisk": 0.7,                // risk >= this         -> ask
//       "askDestructive": 0.4,         // destructive >= this  -> ask
//       "askSecret": 0.8,              // secret exposure >= this -> ask
//       "denyDestructive": 0.97,       // destructive >= this  -> deny
//       "denyRisk": 1.01,              // risk >= this         -> deny (off by default)
//       "failMode": "open"             // "open" leaves the decision unchanged on error
//   } }] }
//
// The free model works anonymously; the paid one reads OPENCODE_API_KEY.

import { createClassifier } from "./jev.ts"

type FailMode = "open" | "closed"

type Options = {
  model?: string
  endpoint?: string
  apiKey?: string
  timeoutMs?: number
  askRisk?: number
  askDestructive?: number
  askSecret?: number
  denyDestructive?: number
  denyRisk?: number
  privilegedAsk?: boolean
  failMode?: FailMode
  cacheTtlMs?: number
  debug?: boolean
}

type Decision = {
  effect: "ask" | "deny" | undefined
  reason: string
}

const DEFAULTS = {
  model: "jev-1.13-free",
  timeoutMs: 10_000,
  askRisk: 0.7,
  askDestructive: 0.4,
  askSecret: 0.8,
  denyDestructive: 0.97,
  denyRisk: 1.01,
  privilegedAsk: true,
  failMode: "open" as FailMode,
  cacheTtlMs: 5 * 60_000,
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function decide(classification: any, opts: Required<Options>): Decision {
  const { category, risk, destructive, secretExposure } = classification
  const bits = `category=${category} risk=${pct(risk)} destructive=${pct(destructive)} secret=${pct(secretExposure)}`

  if (destructive >= opts.denyDestructive) {
    return { effect: "deny", reason: `Jev flagged this as destructive. ${bits}` }
  }
  if (risk >= opts.denyRisk) {
    return { effect: "deny", reason: `Jev rated this command critical. ${bits}` }
  }
  if (destructive >= opts.askDestructive) {
    return { effect: "ask", reason: `Jev flagged possible data loss. ${bits}` }
  }
  if (secretExposure >= opts.askSecret) {
    return { effect: "ask", reason: `Jev flagged possible secret exposure. ${bits}` }
  }
  if (risk >= opts.askRisk) {
    return { effect: "ask", reason: `Jev rated this command risky. ${bits}` }
  }
  if (opts.privilegedAsk && category === "privileged") {
    return { effect: "ask", reason: `Privileged command. ${bits}` }
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

    const cache = new Map<string, { at: number; value: any }>()
    async function classify(command: string, signal?: AbortSignal) {
      const hit = cache.get(command)
      const now = Date.now()
      if (hit && now - hit.at < opts.cacheTtlMs) return hit.value
      const value = await classifier.classify(command, signal)
      if (cache.size > 500) cache.clear()
      cache.set(command, { at: now, value })
      return value
    }

    // Turn a set of shell resources into a single decision by taking the most
    // severe classification across them.
    async function classifyAll(resources: readonly string[], signal?: AbortSignal): Promise<Decision> {
      let worst: Decision = { effect: undefined, reason: "" }
      for (const resource of resources) {
        if (!resource || !resource.trim()) continue
        const classification = await classify(resource, signal)
        const decision = decide(classification, opts)
        log("classified", JSON.stringify({ resource, ...decision }))
        if (rank(decision.effect ?? "allow") > rank(worst.effect ?? "allow")) worst = decision
      }
      return worst
    }

    // Core wrapper: intercept shell permission evaluations and fold in Jev's
    // verdict. Hooks run for both `allow` and `ask` decisions, so a command the
    // user configured to auto-run can still be escalated. We never lower a
    // decision; an explicit `deny` does not reach the hook at all.
    await ctx.permission.hook("evaluate", async (event: any) => {
      if (event.action !== "shell") return
      const resources: string[] = Array.isArray(event.resources) ? event.resources : []
      if (resources.length === 0) return

      let decision: Decision
      try {
        decision = await classifyAll(resources)
      } catch (error) {
        log("classification failed", String(error))
        if (opts.failMode === "closed" && event.effect === "allow") {
          event.effect = "ask"
          event.message = `Jev classifier unavailable; confirming manually. (${String(error).slice(0, 120)})`
        }
        return
      }

      if (!decision.effect) return
      if (rank(decision.effect) <= rank(event.effect ?? "allow")) {
        // Only annotate an already-escalated request.
        if (decision.effect === "ask" && event.effect === "ask" && !event.message) event.message = decision.reason
        return
      }

      event.effect = decision.effect
      event.message = decision.reason
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
