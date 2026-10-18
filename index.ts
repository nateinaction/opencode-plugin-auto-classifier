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

import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, realpath, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { promisify } from "node:util"

import type { Plugin } from "@opencode/plugin"
// The promise host does not re-export its `ToolHooks` interface; the effect
// host declares the same payloads, so it is the named type for both.
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"

import { buildAutoQuestions, createClassifier, parseAutoAnswers } from "./jev.ts"
import { JevClassifierRpc } from "./rpc.ts"
import { buildLabel, commitFromLock } from "./build.ts"
import { buildAutoPrompt, buildVerdictPrompt, parseAutoVerdict, parseVerdict } from "./verdict.ts"
import { resolvePath, resolveTrust } from "./trust.ts"
import { deletesOnlySessionWrites, shellWrites } from "./provenance.ts"
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
import { buildState, contextSpans } from "./context.ts"
import { compact, type Entry } from "./format.ts"
import {
  autoAuthority,
  belowConfidence,
  coverageFor,
  permissionPolicy,
  reachedPause,
  reconcileFallback,
  rememberSessionDecision,
  sessionDecisionKey,
  UNKNOWN_PERMISSION_POLICY,
  type ActionFacts,
  type AutoDecision,
  type AutoVerdict,
  type UserPermissionPolicy,
} from "./auto.ts"

export default {
  id: "auto-classifier",

  async setup(ctx: Plugin.Context) {
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
    // A verdict plus the Jev verdict it replaced, when a fallback supplied it.
    type AutoClassification = { verdict: AutoVerdict; prior?: AutoVerdict }
    const autoCache = new Map<string, { at: number; value: AutoClassification }>()
    // Decisions remembered for the session, keyed by the session and the state
    // classified. Bounded by `SESSION_DECISION_LIMIT` (see auto.ts).
    const sessionDecisions = new Map<string, AutoDecision>()

    // --- fallbacks (shared) --------------------------------------------------

    async function generate(modelRef: string, prompt: string): Promise<string> {
      // `parseModelRef` returns the two plain ids; the API brands them.
      const model = parseModelRef(modelRef) as Parameters<Plugin.Context["generate"]["text"]>[0]["model"]
      const result = await ctx.generate.text({ model, prompt })
      return result?.text ?? ""
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

    // Per-session context, cached briefly. The user prompts are the intent
    // signal and do not change within a turn.
    const promptCache = new Map<string, { at: number; prompts: string[] }>()
    const instructionsCache = new Map<string, { at: number; text: string }>()
    const PROMPT_TTL = 30_000
    const INSTRUCTIONS_TTL = 5 * 60_000

    function baseDir(): string {
      const dir = ctx.location?.directory
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

    // Everything the plugin can prove is inside the trust boundary: the working
    // directory, the scratch directory, and every worktree of the repository.
    // Shared with `git worktree list`'s output, which a session may not own but
    // the same repository does. Each path is added under its literal and
    // canonical spelling, because macOS reaches the temp dir through both.
    const execFileAsync = promisify(execFile)
    async function canonicalRoots(paths: string[]): Promise<string[]> {
      const out = new Set<string>()
      for (const path of paths) {
        if (!path) continue
        out.add(resolve(path))
        try {
          out.add(await realpath(path))
        } catch {
          // Not created yet (or not a directory): the literal name still matches.
        }
      }
      return [...out]
    }

    // Bounded: a repository can carry many worktrees, and a session needs the
    // ones it might touch, not an unbounded list from a hostile checkout.
    const WORKTREE_LIMIT = 32
    async function worktreeRoots(dir: string): Promise<string[]> {
      try {
        const { stdout } = await execFileAsync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
          timeout: 2000,
          maxBuffer: 64 * 1024,
        })
        return stdout
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length).trim())
          .filter(Boolean)
          .slice(0, WORKTREE_LIMIT)
      } catch (error) {
        // Not a git repository, or git is unavailable: the working directory
        // and scratch directory are still trusted roots.
        log("git worktree list failed", String(error).slice(0, 120))
        return []
      }
    }

    const trustedRoots = await canonicalRoots([baseDir(), ...scratchDirs, ...(await worktreeRoots(baseDir()))])

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

    async function autoFallback(state: string, spans: readonly string[]): Promise<AutoVerdict> {
      const text = await generate(opts.fallbackModel, buildAutoPrompt(state, rules))
      return parseAutoVerdict(text, "fallback", spans)
    }

    async function classifyAuto(state: string, action: string, signal?: AbortSignal): Promise<AutoClassification> {
      const key = `${rulesKey}\n${state}`
      const hit = autoCache.get(key)
      const now = Date.now()
      if (hit && now - hit.at < opts.cacheTtlMs) return hit.value

      // The statements a boundary or authorization answer may quote: the
      // user's own words, from the same state the model reads.
      const spans = contextSpans(state)
      let verdict: AutoVerdict
      let prior: AutoVerdict | undefined
      try {
        const { answers } = await classifier.answer(state, buildAutoQuestions(rules, spans), signal)
        verdict = parseAutoAnswers(answers, spans)
        verdict.source = opts.provider
      } catch (error) {
        if (!canFallback()) throw error
        log("jev failed; using fallback", opts.fallbackModel, String(error).slice(0, 140))
        try {
          verdict = await autoFallback(state, spans)
        } catch (fallbackError) {
          // Name both causes: the permission prompt is the only place a human
          // sees why the classifier was unavailable.
          log("fallback failed", String(fallbackError))
          throw new Error(`Jev failed (${brief(error)}) and fallback ${opts.fallbackModel} failed (${brief(fallbackError)})`)
        }
      }

      // Confidence-gated routing: `onUncertain` decides what an inconclusive
      // verdict becomes. "accept" leaves Jev's own answers to decide; "tiered"
      // lets the deterministic facts decide, so a missing fallback model cannot
      // deny a local test run. A fallback verdict is already the last resort:
      // it is at 0.5 confidence, so the policy questions it rather than sending
      // it to the fallback again, and Jev's own verdict is kept to reconcile it.
      const fromFallback = verdict.source === "fallback"
      if (belowConfidence(verdict, opts.confidenceFloor, opts, action)) {
        log("inconclusive", JSON.stringify({ action, onUncertain: opts.onUncertain, verdict }))
        if (opts.onUncertain === "deny" || opts.onUncertain === "tiered") {
          verdict = { ...verdict, uncertain: true }
        } else if (opts.onUncertain === "fallback" && !fromFallback) {
          prior = verdict
          verdict = await fallbackForUncertain(verdict, state, spans, action)
        }
      }

      const value = { verdict, prior }
      if (autoCache.size > 500) autoCache.clear()
      autoCache.set(key, { at: now, value })
      return value
    }

    /** Short, single-line error text for a permission message. */
    function brief(error: unknown): string {
      return String(error).replace(/\s+/g, " ").slice(0, 140)
    }

    /**
     * The LLM fallback's verdict for an uncertain one. An unavailable fallback
     * under fail-closed keeps its denial, but the error names the model so the
     * prompt can say why.
     */
    async function fallbackForUncertain(
      uncertain: AutoVerdict,
      state: string,
      spans: readonly string[],
      action: string,
    ): Promise<AutoVerdict> {
      if (!canFallback()) {
        if (opts.failMode !== "closed") return uncertain
        log("inconclusive verdict", JSON.stringify({ action, verdict: uncertain, fallback: "disabled" }))
        throw new Error("inconclusive verdict and the LLM fallback is disabled; failing closed")
      }
      try {
        return await autoFallback(state, spans)
      } catch (error) {
        log("low-confidence fallback failed", String(error))
        if (opts.failMode !== "closed") return uncertain
        throw new Error(`inconclusive verdict and fallback ${opts.fallbackModel} failed (${brief(error)}); failing closed`)
      }
    }

    async function classifyAutoAll(
      items: Array<{ label: string; state: string; action: string; trust: ActionFacts }>,
      signal?: AbortSignal,
    ): Promise<AutoDecision> {
      let worst: AutoDecision = { effect: "allow", reason: "" }
      for (const item of items) {
        const { verdict, prior } = await classifyAuto(item.state, item.action, signal)
        const decision = reconcileFallback(verdict, prior, opts, item.action, item.trust, item.label)
        log(
          "classified",
          JSON.stringify({ mode: "auto", resource: item.label, effect: decision.effect, rule: decision.rule, trust: item.trust, verdict }),
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
        // The first deny settles every part of the command; otherwise keep the
        // most severe outcome, so an ask is not overwritten by a later allow.
        if (decision.effect === "deny") return decision
        if (rank(decision.effect) > rank(worst.effect)) worst = decision
      }
      return worst
    }

    // The session's effective ruleset: `Session.Info.permissions`, the rules
    // OpenCode evaluates after the agent's own. A user's `ask` rule is final and
    // the classifier must not auto-approve or deny it; a non-wildcard `allow`
    // rule is their stated intent, and auto-mode must not deny over it.
    //
    // `permission.list` is not this source: it takes a required `{ sessionID }`
    // and returns pending permission *requests*, not rules. A failed lookup is
    // reported as `known: false`, so the caller keeps OpenCode's prompt instead
    // of reading the failure as "the user has no policy".
    async function userRules(sessionID: string, action: string, resources: string[]): Promise<UserPermissionPolicy> {
      if (!sessionID || typeof ctx.session?.get !== "function") {
        log("session permission rules unavailable", JSON.stringify({ action, reason: "session.get is not available" }))
        return UNKNOWN_PERMISSION_POLICY
      }
      try {
        const session = await ctx.session.get({ sessionID })
        return permissionPolicy(session?.permissions, action, resources)
      } catch (error) {
        log("session permission rules unavailable", JSON.stringify({ action, error: brief(error) }))
        return UNKNOWN_PERMISSION_POLICY
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
    const COMMAND_DECISION_LIMIT = 64
    // One decision per whole command, by the same tool-call ID. Judging each
    // part separately gave `echo ---` and `head -3` the verdict of the file
    // read they were piped from. The command is now classified once and every
    // part inherits that decision: a dangerous part still denies the whole
    // command, and the safe wrappers follow it instead of flapping.
    const commandDecisions = new Map<string, AutoDecision>()
    function rememberCommand(id: string, command: string) {
      shellCommands.delete(id)
      shellCommands.set(id, command)
      if (shellCommands.size > SHELL_COMMAND_LIMIT) shellCommands.delete(shellCommands.keys().next().value!)
    }
    function rememberDecision(id: string, decision: AutoDecision) {
      commandDecisions.delete(id)
      commandDecisions.set(id, decision)
      if (commandDecisions.size > COMMAND_DECISION_LIMIT) commandDecisions.delete(commandDecisions.keys().next().value!)
    }

    // --- file provenance -----------------------------------------------------
    // The paths each session created or modified, so `Irreversible Local
    // Destruction` ("files that existed before this session") cannot fire on a
    // file the session wrote itself. Recorded from a completed tool call only,
    // so a failed or denied edit does not make a pre-existing file look
    // regenerable. Bounded per session and across sessions.
    const sessionWrites = new Map<string, Set<string>>()
    const SESSION_WRITE_LIMIT = 32
    const WRITE_PATH_LIMIT = 256
    const WRITES_IN_STATE = 10
    const WRITE_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])

    function writtenIn(sessionID: unknown): Set<string> {
      const id = typeof sessionID === "string" ? sessionID : ""
      const hit = sessionWrites.get(id)
      if (hit) return hit
      const fresh = new Set<string>()
      sessionWrites.set(id, fresh)
      if (sessionWrites.size > SESSION_WRITE_LIMIT) sessionWrites.delete(sessionWrites.keys().next().value!)
      return fresh
    }

    /** The paths a completed tool call wrote, as its input names them. */
    function writePaths(tool: unknown, input: any): string[] {
      if (WRITE_TOOLS.has(String(tool))) {
        const path = input?.filePath ?? input?.path ?? input?.file
        return typeof path === "string" ? [path] : []
      }
      if (tool === "shell" && typeof input?.command === "string") return shellWrites(input.command)
      return []
    }

    async function recordWrites(sessionID: unknown, tool: unknown, input: any): Promise<void> {
      for (const path of writePaths(tool, input)) {
        const absolute = resolvePath(path.trim(), baseDir())
        // A directory (a `cp` destination, say) is not a file the session
        // regenerated; only an existing regular file counts.
        const kind = await stat(absolute).catch(() => undefined)
        if (!kind?.isFile()) continue
        const written = writtenIn(sessionID)
        for (const spelling of await canonicalRoots([absolute])) {
          written.delete(spelling)
          written.add(spelling)
        }
        while (written.size > WRITE_PATH_LIMIT) written.delete(written.keys().next().value!)
      }
    }

    await ctx.tool.hook("execute.before", (event: ToolHooks["execute.before"]) => {
      const input = event.input as { command?: unknown } | undefined
      const command = input?.command
      if (event.tool !== "shell" || typeof command !== "string") return
      rememberCommand(event.id, command)
    })
    await ctx.tool.hook("execute.after", async (event: ToolHooks["execute.after"]) => {
      shellCommands.delete(event.id)
      commandDecisions.delete(event.id)
      if (event.status !== "completed") return
      await recordWrites(event.sessionID, event.tool, event.input)
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
    await ctx.permission.hook("evaluate", async (event: PermissionEvaluation) => {
      const resources = [...event.resources]
      if (resources.length === 0) return
      const action = event.action

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
      // A user ask rule only matters when OpenCode is already prompting. If the
      // ruleset could not be read, an incoming prompt is kept: the lookup
      // failure must not read as "the user has no ask rule".
      const user = await userRules(event.sessionID, action, resources)
      const userAsk = incoming === "ask" ? user.ask || !user.known : false

      // An explicit user allow rule is their policy; the classifier does not
      // second-guess it. Without this, a repo `permissions` allowlist changed
      // nothing in auto-mode. Never lower an explicit deny or a user ask rule.
      if (user.allow && incoming !== "deny" && !userAsk) {
        log("user allow rule", JSON.stringify({ action, resources: resources.slice(0, 4) }))
        event.effect = "allow"
        return
      }

      if (coverage === "allow") {
        // Auto-allow read-only tools, but honor a user's ask rule and stop once
        // repeated blocks have paused auto-approval.
        if (!userAsk && !pause) event.effect = "allow"
        return
      }

      // The whole shell command, when `execute.before` recorded this call.
      // OpenCode splits a compound command and asks permission for each part;
      // one classification per call ID decides every part alike.
      const commandKey =
        action === "shell" && event.source?.type === "tool" && typeof event.source.id === "string" ? event.source.id : undefined
      const command = commandKey ? shellCommands.get(commandKey) : undefined
      const settled = commandKey ? commandDecisions.get(commandKey) : undefined

      let decision: AutoDecision
      if (settled) {
        log("decision reused", JSON.stringify({ action, commandKey, effect: settled.effect, rule: settled.rule }))
        decision = settled
      } else {
        const instructionText = opts.conversationContext === "none" ? undefined : await instructions()
        const prompts = opts.conversationContext === "none" ? [] : await userPrompts(event.sessionID)
        const promptText = prompts.at(-1)
        const earlierPrompts = prompts.slice(0, -1).map((text) => text.slice(0, EARLIER_PROMPT_CHARS))
        const transcriptText = opts.conversationContext === "session" ? await sessionTranscript(event.sessionID) : undefined
        // Classify the whole command once. Its parts are only the resources to
        // judge when the whole command is unavailable.
        const targets = command ? [command] : resources
        // The files this session wrote, so the model can apply `Irreversible
        // Local Destruction` as written instead of guessing provenance.
        const written = writtenIn(event.sessionID)
        const recentWrites = [...written].slice(-WRITES_IN_STATE)
        const items = targets.map((resource) => {
          const trust = resolveTrust(action, resource, trustedRoots, baseDir())
          const facts: ActionFacts = {
            ...trust,
            written: deletesOnlySessionWrites(action, resource, written, baseDir()),
          }
          return {
            label: resource,
            action,
            trust: facts,
            state: buildState({
              mode: opts.conversationContext,
              instructions: instructionText,
              userPrompt: promptText,
              earlierPrompts,
              transcript: transcriptText,
              action,
              resource,
              // The target is the whole command, so it already carries it.
              command: resource === command ? undefined : command,
              directory: baseDir(),
              scratch: scratchDirs,
              writes: recentWrites,
            }),
          }
        })

        // A session remembers its decisions, so a repeated check (a hook, a
        // retried command, the same part asked twice) costs no request for the
        // rest of the session, not just the classification cache's TTL.
        const memoKey =
          items.length === 1 ? sessionDecisionKey(event.sessionID, items[0].state, items[0].trust.written === true) : undefined
        const remembered = memoKey ? sessionDecisions.get(memoKey) : undefined
        if (remembered) {
          log("decision remembered", JSON.stringify({ action, effect: remembered.effect, rule: remembered.rule }))
          decision = remembered
        } else {
          try {
            decision = await classifyAutoAll(items)
          } catch (error) {
            log("auto classification failed", String(error))
            if (opts.failMode === "closed" && incoming !== "deny") {
              event.effect = "deny"
              event.message = `[auto-classifier] classifier unavailable; ${brief(error)}`
            }
            return
          }
          if (memoKey) rememberSessionDecision(sessionDecisions, memoKey, decision)
        }
        if (commandKey) rememberDecision(commandKey, decision)
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
