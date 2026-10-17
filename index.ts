// auto-classifier - classify actions with TypeSafe Jev via OpenCode Zen or
// OpenRouter, and fold the verdict into OpenCode's permission decisions.
//
// Two modes, selected by the `mode` option:
//
//   "classic" (default)
//     A risk-score escalator. Every shell command, file read, and edit is sent
//     to Jev for a category, a risk score, and destructive/secret
//     probabilities; a triggered threshold is escalated to `ask` (or `deny`).
//     The plugin only ever raises severity.
//
//   "auto-mode"
//     Behaves like Claude Code's auto classifier. Jev answers a parallel set of
//     typed questions over an assembled state (project instructions + the
//     user's request + the action), covering enumerated rule lists, the trust
//     boundary, and the user's intent. Precedence is applied in code to produce
//     a *binary* allow/deny: the classifier auto-approves actions that match no
//     block rule, and denies the rest. A user-configured `ask` rule stays a
//     prompt, and repeated blocks pause auto-approval so prompts resume. When a
//     decision-relevant answer is uncertain (or Jev fails) the LLM fallback
//     (ctx.generate.text) decides instead.
//
// Covered permission actions: shell, read, edit, webfetch, websearch,
// external_directory. Auto-mode auto-allows read/glob/grep and in-project
// edits, and passes other actions through unchanged.
//
// Providers: `provider` selects where Jev is served; both speak the same API.
//   "jev" (default) -> https://opencode.ai/zen/v1/systemone (key: OPENCODE_API_KEY)
//   "openrouter"    -> https://openrouter.ai/api/alpha/decisions (key: OPENROUTER_API_KEY)

import { appendFile, mkdir, readFile, realpath } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

import { buildAutoQuestions, createClassifier, parseAutoAnswers } from "./jev.ts"
import { JevClassifierRpc } from "./rpc.ts"
import { buildLabel, commitFromLock } from "./build.ts"
import { buildAutoPrompt, buildVerdictPrompt, parseAutoVerdict, parseVerdict } from "./verdict.ts"
import {
  decide,
  describe,
  normalize,
  parseModelRef,
  pct,
  rank,
  PROVIDER_DEFAULTS,
  type Decision,
  type Options,
} from "./decide.ts"
import { mergeRules } from "./rules.ts"
import { buildState } from "./context.ts"
import { compact, type Entry } from "./format.ts"
import {
  autoAuthority,
  belowConfidence,
  coverageFor,
  isStdinFilter,
  decideAuto,
  reachedPause,
  type AutoDecision,
  type AutoVerdict,
} from "./auto.ts"

export default {
  id: "auto-classifier",

  async setup(ctx: any) {
    const opts = normalize((ctx.options ?? {}) as Options)
    const auto = opts.mode === "auto-mode"
    const rules = mergeRules(opts.rules)
    const rulesKey = JSON.stringify(rules)
    const classifier = createClassifier({
      model: opts.model,
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      apiKeyEnv: PROVIDER_DEFAULTS[opts.provider].apiKeyEnv,
      timeoutMs: opts.timeoutMs,
    })

    // Debug lines go to a file: a plugin's stderr is not captured when OpenCode
    // runs as a background service, and the plugin API offers no logger. The
    // default sits beside OpenCode's own log.
    const debugLog =
      opts.debugLog || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "log", "auto-classifier.log")
    const log = (...args: unknown[]) => {
      if (!opts.debug) return
      const text = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")
      const entry = `${new Date().toISOString()} ${text}\n`
      mkdir(dirname(debugLog), { recursive: true })
        .then(() => appendFile(debugLog, entry))
        .catch((error) => console.error("[auto-classifier] debug log write failed:", String(error), entry))
    }

    // Rolling record of recent classifications, exposed to the TUI plugin over
    // RPC so it can render them in the sidebar. The shape is shared with the
    // TUI's formatter (format.ts) and the RPC schema (rpc.ts).
    const recent: Entry[] = []
    const RECENT_LIMIT = 25

    let emitClassified: ((entry: Entry) => void) | undefined
    if (typeof ctx.rpc?.register === "function") {
      try {
        const registration = await ctx.rpc.register(JevClassifierRpc, {
          recent: async () => ({ entries: recent }),
        })
        emitClassified = (entry: Entry) => {
          // emit may throw synchronously or reject (e.g. a schema mismatch);
          // log either way rather than drop the failure.
          try {
            Promise.resolve(registration.events.emit("classified", entry)).catch((error: unknown) =>
              log("emit failed", String(error)),
            )
          } catch (error) {
            log("emit failed", String(error))
          }
        }
      } catch (error) {
        log("rpc registration failed", String(error))
      }
    }

    const build = await readBuild()
    function recordEntry(entry: Entry) {
      const stamped = compact({ ...entry, mode: opts.mode, build })
      recent.unshift(stamped)
      if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT
      emitClassified?.(stamped)
    }

    // Which install is running: the commit npm resolved (from the installer's
    // lockfile beside this package), else the package version.
    async function readBuild(): Promise<string> {
      const json = async (relative: string): Promise<unknown> => {
        try {
          return JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"))
        } catch (error) {
          // Expected for a local checkout, which has no installer lockfile.
          log("build metadata unavailable", relative, String(error))
          return undefined
        }
      }
      const pkg = (await json("./package.json")) as { name?: unknown; version?: unknown } | undefined
      const name = typeof pkg?.name === "string" ? pkg.name : "opencode-plugin-auto-classifier"
      return buildLabel(commitFromLock(await json("../.package-lock.json"), name), pkg?.version)
    }

    const cache = new Map<string, { at: number; value: any }>()
    const autoCache = new Map<string, { at: number; value: AutoVerdict }>()

    // --- fallbacks (shared) --------------------------------------------------

    async function generate(modelRef: string, prompt: string): Promise<string> {
      const model = parseModelRef(modelRef)
      const result = await ctx.generate.text({ model, prompt })
      return result?.text ?? result?.data?.text ?? ""
    }

    const canFallback = () => opts.fallback && typeof ctx.generate?.text === "function"

    // --- classic classification ---------------------------------------------

    async function classify(state: string, signal?: AbortSignal) {
      const hit = cache.get(state)
      const now = Date.now()
      if (hit && now - hit.at < opts.cacheTtlMs) return hit.value

      let value: any
      try {
        value = await classifier.classify(state, signal)
        if (value && value.source === undefined) value.source = opts.provider
      } catch (error) {
        if (!canFallback()) throw error
        log("jev failed; using fallback", opts.fallbackModel, String(error).slice(0, 140))
        const text = await generate(opts.fallbackModel, buildVerdictPrompt(state))
        value = {
          command: state,
          model: opts.fallbackModel,
          source: "fallback",
          ...parseVerdict(text, "fallback"),
          categoryConfidence: 0,
        }
      }

      if (cache.size > 500) cache.clear()
      cache.set(state, { at: now, value })
      return value
    }

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

    // --- auto-mode classification --------------------------------------------

    const autoQuestions = buildAutoQuestions(rules)

    // Per-session context, cached briefly. The user prompts are the intent
    // signal and do not change within a turn.
    const promptCache = new Map<string, { at: number; prompts: string[] }>()
    const instructionsCache = new Map<string, { at: number; text: string }>()
    const PROMPT_TTL = 30_000
    const INSTRUCTIONS_TTL = 5 * 60_000

    function baseDir(): string {
      const loc = ctx.location
      const dir = loc?.directory ?? loc?.worktree ?? loc?.path
      return typeof dir === "string" && dir ? dir : process.cwd()
    }

    // OpenCode's scratch directory under the system temp dir, by each name the
    // agent may use: macOS reaches it through both /var and /private/var.
    const scratch = join(tmpdir(), "opencode")
    const scratchDirs = await realpath(scratch).then(
      (real) => [...new Set([scratch, real])],
      // Not created yet: the unresolved path is the only name to match.
      () => [scratch],
    )

    // The latest user message plus the ones before it, so a terse reply
    // ("continue") carries the request it answers. Only the user's own words:
    // assistant text would let the agent argue for its own actions.
    const PROMPT_COUNT = 3
    const EARLIER_PROMPT_CHARS = 1000

    /** The session's last PROMPT_COUNT user messages, oldest first; empty when unavailable. */
    async function userPrompts(sessionID: string): Promise<string[]> {
      if (!sessionID) return []
      const hit = promptCache.get(sessionID)
      const now = Date.now()
      if (hit && now - hit.at < PROMPT_TTL) return hit.prompts
      try {
        const messages = await ctx.session.context({ sessionID })
        const prompts: string[] = []
        for (let i = messages.length - 1; i >= 0 && prompts.length < PROMPT_COUNT; i--) {
          const message = messages[i]
          if (message?.type === "user" && typeof message.text === "string" && message.text.trim()) {
            prompts.unshift(message.text)
          }
        }
        promptCache.set(sessionID, { at: now, prompts })
        return prompts
      } catch (error) {
        log("session.context failed", String(error))
        return []
      }
    }

    async function instructions(): Promise<string | undefined> {
      const dir = baseDir()
      const hit = instructionsCache.get(dir)
      const now = Date.now()
      if (hit && now - hit.at < INSTRUCTIONS_TTL) return hit.text || undefined
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        try {
          const text = await readFile(join(dir, name), "utf8")
          instructionsCache.set(dir, { at: now, text })
          return text
        } catch {
          // no such file; try the next candidate
        }
      }
      instructionsCache.set(dir, { at: now, text: "" })
      return undefined
    }

    // Wider transcript for `conversationContext: "session"`. Only user and
    // assistant text is included; tool results are never sent.
    async function sessionTranscript(sessionID: string): Promise<string | undefined> {
      if (!sessionID) return undefined
      try {
        const messages = await ctx.session.context({ sessionID })
        const lines: string[] = []
        for (const message of messages.slice(-20)) {
          const text = messageText(message)
          if (text) lines.push(`${message?.type ?? "message"}: ${text}`)
        }
        return lines.join("\n") || undefined
      } catch (error) {
        log("session.context failed", String(error))
        return undefined
      }
    }

    function messageText(message: any): string {
      if (typeof message?.text === "string") return message.text
      if (Array.isArray(message?.content)) {
        return message.content
          .filter((part: any) => part?.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text)
          .join(" ")
      }
      return ""
    }

    function isExternalPath(resource: string): boolean {
      const base = baseDir()
      try {
        const abs = isAbsolute(resource) ? resolve(resource) : resolve(base, resource)
        return abs !== base && !abs.startsWith(base.endsWith(sep) ? base : base + sep)
      } catch {
        return true
      }
    }

    async function autoFallback(state: string): Promise<AutoVerdict> {
      const text = await generate(opts.fallbackModel, buildAutoPrompt(state, rules))
      return parseAutoVerdict(text, "fallback")
    }

    async function classifyAuto(state: string, action: string, signal?: AbortSignal): Promise<AutoVerdict> {
      const key = `${rulesKey}\n${state}`
      const hit = autoCache.get(key)
      const now = Date.now()
      if (hit && now - hit.at < opts.cacheTtlMs) return hit.value

      let verdict: AutoVerdict
      try {
        const { answers } = await classifier.answer(state, autoQuestions, signal)
        verdict = parseAutoAnswers(answers)
        verdict.source = opts.provider
      } catch (error) {
        if (!canFallback()) throw error
        log("jev failed; using fallback", opts.fallbackModel, String(error).slice(0, 140))
        verdict = await autoFallback(state)
      }

      // Confidence-gated routing: an inconclusive answer asks the LLM instead.
      if (belowConfidence(verdict, opts.confidenceFloor, opts, action)) {
        if (canFallback()) {
          try {
            verdict = await autoFallback(state)
          } catch (error) {
            log("low-confidence fallback failed", String(error))
          }
        }
        // Still inconclusive: with fail-closed, an unusable verdict is denied
        // rather than allowed (mirrors Claude Code's "no verdict" behavior).
        if (belowConfidence(verdict, opts.confidenceFloor, opts, action) && opts.failMode === "closed") {
          log("inconclusive verdict", JSON.stringify({ action, verdict }))
          throw new Error("auto-classifier: inconclusive verdict; failing closed")
        }
      }

      if (autoCache.size > 500) autoCache.clear()
      autoCache.set(key, { at: now, value: verdict })
      return verdict
    }

    async function classifyAutoAll(
      items: Array<{ label: string; state: string; action: string }>,
      signal?: AbortSignal,
    ): Promise<AutoDecision> {
      let worst: AutoDecision = { effect: "allow", reason: "" }
      for (const item of items) {
        const verdict = await classifyAuto(item.state, item.action, signal)
        const decision = decideAuto(verdict, opts, item.action)
        log(
          "classified",
          JSON.stringify({ mode: "auto", resource: item.label, effect: decision.effect, rule: decision.rule, verdict }),
        )
        recordEntry({
          at: Date.now(),
          action: item.action,
          resource: item.label,
          effect: decision.effect,
          reason: decision.reason,
          via: verdict.source ?? "jev",
          rule: decision.rule,
        })
        if (decision.effect === "deny") return decision
        worst = decision
      }
      return worst
    }

    // Does OpenCode have a user-configured `ask` rule for this action? If so, an
    // explicit ask is final and the classifier must not auto-approve or deny it.
    function matchRule(pattern: unknown, resource: string): boolean {
      if (pattern === "*") return true
      if (typeof pattern !== "string") return false
      if (pattern === resource) return true
      if (pattern.endsWith("*")) return resource.startsWith(pattern.slice(0, -1))
      return false
    }

    async function hasUserAskRule(action: string, resources: string[]): Promise<boolean> {
      if (typeof ctx.permission?.list !== "function") return false
      try {
        const listed = await ctx.permission.list()
        const rules: any[] = Array.isArray(listed) ? listed : Array.isArray(listed?.rules) ? listed.rules : []
        return rules.some(
          (rule) =>
            rule?.effect === "ask" &&
            rule?.action === action &&
            resources.some((resource) => matchRule(rule?.resource, resource)),
        )
      } catch (error) {
        log("permission.list failed", String(error))
        return false
      }
    }

    // Whole shell commands by tool-call ID. OpenCode asks permission for each
    // part of a compound command separately and can drop a heredoc from its
    // part (`python3 - "$f" <<'PY'` arrives as `python3 - "$f"`), so the
    // classifier would judge a script it cannot see. `execute.before` runs
    // before the tool asks, and the permission event's `source.id` names the
    // same call. Bounded because a call that never completes is never removed.
    const shellCommands = new Map<string, string>()
    const SHELL_COMMAND_LIMIT = 64
    await ctx.tool.hook("execute.before", (event: any) => {
      const command = event?.input?.command
      if (event?.tool !== "shell" || typeof event.id !== "string" || typeof command !== "string") return
      shellCommands.delete(event.id)
      shellCommands.set(event.id, command)
      if (shellCommands.size > SHELL_COMMAND_LIMIT) shellCommands.delete(shellCommands.keys().next().value!)
    })
    await ctx.tool.hook("execute.after", (event: any) => {
      if (typeof event?.id === "string") shellCommands.delete(event.id)
    })

    // Repeated-block accounting: after too many denials, stop auto-approving so
    // the user is prompted again (mirrors Claude Code's 3-consecutive/20-total).
    const blocks = new Map<string, { consecutive: number; total: number }>()
    function blockState(sessionID: string) {
      return blocks.get(sessionID) ?? { consecutive: 0, total: 0 }
    }

    // Core wrapper: intercept permission evaluations and fold in the decision.
    // In classic mode this never lowers a decision; in auto-mode it may
    // auto-approve, because that is the point of the profile.
    await ctx.permission.hook("evaluate", async (event: any) => {
      const resources: string[] = Array.isArray(event.resources) ? event.resources : []
      if (resources.length === 0) return
      const action = event.action as string

      if (!auto) {
        const items = resources
          .map((resource) => ({ label: resource, action, state: describe(action, resource) }))
          .filter((item): item is { label: string; state: string; action: string } => Boolean(item.state && item.state.trim()))
        if (items.length === 0) return

        let decision: Decision
        try {
          decision = await classifyAll(items)
        } catch (error) {
          log("classification failed", String(error))
          if (opts.failMode === "closed" && event.effect === "allow") {
            event.effect = opts.escalateTo
            event.message = `[auto-classifier] Jev unavailable; failing ${opts.escalateTo}. (${String(error).slice(0, 120)})`
          }
          return
        }

        if (!decision.effect) return
        if (rank(decision.effect) <= rank(event.effect ?? "allow")) {
          if (decision.effect === "ask" && event.effect === "ask" && !event.message) {
            event.message = `[auto-classifier] ${decision.reason}`
          }
          return
        }
        event.effect = decision.effect
        event.message = `[auto-classifier] ${decision.reason}`
        return
      }

      // --- auto-mode ---
      const incoming = (event.effect ?? "ask") as "allow" | "ask" | "deny"
      const external = action === "external_directory" ? true : action === "edit" ? isExternalPath(resources[0]) : false
      const coverage = coverageFor(action, external)
      if (coverage === "passthrough") return

      const session = blockState(event.sessionID)
      const pause = reachedPause(session.consecutive, session.total, opts)
      // A user ask rule only matters when OpenCode is already prompting.
      const userAsk = incoming === "ask" ? await hasUserAskRule(action, resources) : false

      if (coverage === "allow") {
        // Auto-allow read-only tools, but honor a user's ask rule and stop once
        // repeated blocks have paused auto-approval.
        if (!userAsk && !pause) event.effect = "allow"
        return
      }

      // Bare stream filters (`| tail -40`) are judged by the part feeding them.
      const toClassify = action === "shell" ? resources.filter((resource) => !isStdinFilter(resource)) : resources
      if (toClassify.length === 0) {
        if (!userAsk && !pause) event.effect = "allow"
        return
      }

      const instructionText = opts.conversationContext === "none" ? undefined : await instructions()
      const prompts = opts.conversationContext === "none" ? [] : await userPrompts(event.sessionID)
      const promptText = prompts.at(-1)
      const earlierPrompts = prompts.slice(0, -1).map((text) => text.slice(0, EARLIER_PROMPT_CHARS))
      const transcriptText = opts.conversationContext === "session" ? await sessionTranscript(event.sessionID) : undefined
      const command = action === "shell" && event.source?.type === "tool" ? shellCommands.get(event.source.id) : undefined
      const items = toClassify.map((resource) => ({
        label: resource,
        action,
        state: buildState({
          mode: opts.conversationContext,
          instructions: instructionText,
          userPrompt: promptText,
          earlierPrompts,
          transcript: transcriptText,
          action,
          resource,
          command,
          directory: baseDir(),
          scratch: scratchDirs,
        }),
      }))

      let decision: AutoDecision
      try {
        decision = await classifyAutoAll(items, event.signal)
      } catch (error) {
        log("auto classification failed", String(error))
        if (opts.failMode === "closed" && incoming !== "deny") {
          event.effect = "deny"
          event.message = `[auto-classifier] classifier unavailable; failing closed. (${String(error).slice(0, 120)})`
        }
        return
      }

      const out = autoAuthority(incoming, decision, { userAskRule: userAsk, pausePrompts: pause })

      if (out.effect === "deny") {
        blocks.set(event.sessionID, { consecutive: session.consecutive + 1, total: session.total + 1 })
      } else {
        blocks.set(event.sessionID, { consecutive: 0, total: session.total })
      }

      event.effect = out.effect
      if (out.message) event.message = out.message
    })

    // On-demand classification tool (classic verdict). Useful for a human
    // asking why something was escalated, or for the agent to pre-check.
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

    // In auto-mode, expose the effective rule set (parity with
    // `claude auto-mode defaults`) so a human can see what the classifier uses.
    if (auto) {
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "auto_classifier_rules",
          description:
            "Print the effective auto-mode rule lists (hard_deny, soft_deny, allow, environment) the classifier is using, with $defaults already merged in.",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            const body = JSON.stringify(rules, null, 2)
            return { content: body, metadata: rules }
          },
        })
      })
    }

    log("ready", JSON.stringify({ mode: opts.mode, provider: opts.provider, model: opts.model, failMode: opts.failMode }))
  },
}
