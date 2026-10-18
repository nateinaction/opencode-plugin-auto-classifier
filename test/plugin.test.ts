// Wiring tests for the auto-mode permission hook: a fake `ctx` captures the
// handlers `setup` registers, a fake `session.get` supplies the ruleset, and a
// fake `fetch` answers Jev, so nothing here touches the network or needs a key.
//
// These cover the wiring that has no pure module of its own: user-rule
// precedence, the session memo, repeated-block accounting, file provenance, and
// fail-closed behavior.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../index.ts"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
type Evaluate = (event: PermissionEvaluation) => Promise<void>
type ToolHandler = (event: unknown) => unknown

/** A session id with the brand the permission hook's payload carries. */
const SESSION = "ses_test" as PermissionEvaluation["sessionID"]

interface HarnessInput {
  /** The session's `permissions` rules; defaults to none. */
  ruleset?: (input: { sessionID: string }) => Promise<unknown>
  /** Extra plugin options, merged over the auto-mode defaults. */
  options?: Record<string, unknown>
  /** The answers the fake Jev returns for a state; throw to simulate a failure. */
  reply?: (state: string) => unknown
}

interface Harness {
  evaluate: Evaluate
  /** The registered `execute.before`/`execute.after` handler. */
  tool: (name: string) => ToolHandler | undefined
  /** The inputs `session.get` received, in order. */
  gets: Array<{ sessionID: string }>
  /** Prompts sent to the LLM fallback. */
  prompts: string[]
  /** The states the plugin sent to Jev, in order. */
  requests: string[]
  /** The debug log's contents, once an append matching `until` has landed. */
  log: (until?: RegExp) => Promise<string>
  dispose: () => Promise<void>
}

/** A Jev answer set that matches no rule and rates the action harmless. */
function clean() {
  return {
    category: { choice: "read", confidence: 0.95 },
    risk: { score: 0, confidence: 0.95 },
    destructive: { noul: 0 },
    reveals_credentials: { noul: 0 },
    new_sensitive_data: { noul: 0 },
    hard_deny_rule: { choice: "none", confidence: 0.95 },
    soft_deny_rule: { choice: "none", confidence: 0.95 },
    allow_rule: { choice: "none", confidence: 0.95 },
    trust_external: { noul: 0 },
    user_authorizes: { noul: 0 },
    user_forbids: { noul: 0 },
    scope_escalation: { noul: 0 },
  }
}

/** A Jev answer set that trips a hard rule. */
function denied() {
  return { ...clean(), hard_deny_rule: { choice: "Data Exfiltration", confidence: 0.95 } }
}

async function harness(input: HarnessInput = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "auto-classifier-test-"))
  const debugLog = join(dir, "debug.log")
  const gets: Harness["gets"] = []
  const prompts: string[] = []
  const requests: string[] = []
  const tools = new Map<string, ToolHandler>()
  let evaluate: Evaluate | undefined

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL | Request, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}"))
    requests.push(body.state)
    const answers = await (input.reply ?? clean)(body.state)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: "jev-test", answers }),
    }
  }) as unknown as typeof fetch

  const ctx = {
    options: { mode: "auto-mode", debug: true, debugLog, ...input.options },
    location: { directory: process.cwd() },
    generate: {
      text: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt)
        return { text: "" }
      },
    },
    session: {
      get: async (session: { sessionID: string }) => {
        gets.push(session)
        return (input.ruleset ?? (async () => ({ permissions: [] })))(session)
      },
      context: async () => [],
    },
    tool: {
      hook: async (name: string, callback: ToolHandler) => {
        tools.set(name, callback)
        return { dispose: async () => {} }
      },
      transform: async () => ({ dispose: async () => {} }),
    },
    permission: {
      hook: async (_name: string, callback: Evaluate) => {
        evaluate = callback
        return { dispose: async () => {} }
      },
    },
  }

  try {
    await plugin.setup(ctx as never)
  } catch (error) {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  if (!evaluate) throw new Error("setup did not register the permission handler")

  return {
    evaluate,
    tool: (name) => tools.get(name),
    gets,
    prompts,
    requests,
    log: async (until?: RegExp) => {
      // The debug writer appends without blocking setup or the handler, so wait
      // for the line in question rather than the file's first appearance.
      let text = ""
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          text = await readFile(debugLog, "utf8")
        } catch {
          // Not created yet.
        }
        if (!until || until.test(text)) return text
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return text
    },
    dispose: async () => {
      globalThis.fetch = originalFetch
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const ruleset = (...rules: Rule[]) => async () => ({ permissions: rules })

const event = (action: string, resource: string, effect: "allow" | "ask" | "deny" = "ask"): PermissionEvaluation => ({
  sessionID: SESSION,
  action,
  resources: [resource],
  effect,
})

test("a repo permissions allow rule auto-approves an incoming prompt", async (t) => {
  const h = await harness({ ruleset: ruleset({ action: "shell", resource: "pytest *", effect: "allow" }) })
  t.after(h.dispose)
  const e = event("shell", "pytest -q")

  await h.evaluate(e)

  assert.equal(e.effect, "allow")
  // The ruleset comes from the session, with the input the host requires.
  assert.deepEqual(h.gets, [{ sessionID: SESSION }])
  // The user's policy settles it without paying for a classification.
  assert.equal(h.requests.length, 0)
  assert.equal(h.prompts.length, 0)
})

test("a user ask rule keeps its prompt for an auto-allowed read", async (t) => {
  const h = await harness({ ruleset: ruleset({ action: "read", resource: "/etc/*", effect: "ask" }) })
  t.after(h.dispose)
  const e = event("read", "/etc/hosts")

  await h.evaluate(e)

  assert.equal(e.effect, "ask")
})

test("a failed ruleset lookup keeps the prompt and logs a distinct message", async (t) => {
  const h = await harness({
    ruleset: async () => {
      throw new Error("session unavailable")
    },
  })
  t.after(h.dispose)
  const e = event("read", "/etc/hosts")

  await h.evaluate(e)

  // An unreadable ruleset must not read as "the user has no ask rule".
  assert.equal(e.effect, "ask")
  const log = await h.log(/session permission rules unavailable/)
  assert.match(log, /session permission rules unavailable/)
  assert.doesNotMatch(log, /permission\.list failed/)
})

test("the same state evaluated twice reuses the session memo", async (t) => {
  // A zero TTL disables the request cache, so a second Jev call can only be
  // avoided by the session memo itself.
  const h = await harness({ options: { cacheTtlMs: 0 } })
  t.after(h.dispose)

  await h.evaluate(event("shell", "pytest -q"))
  await h.evaluate(event("shell", "pytest -q"))

  assert.equal(h.requests.length, 1)
  const log = await h.log(/decision remembered/)
  assert.match(log, /decision remembered/)
})

test("execute.after records a completed write and ignores a failed one", async (t) => {
  const h = await harness()
  t.after(h.dispose)
  const dir = await mkdtemp(join(tmpdir(), "auto-classifier-writes-"))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const completed = join(dir, "completed.txt")
  const failed = join(dir, "failed.txt")
  await writeFile(completed, "written this session\n")
  await writeFile(failed, "never written\n")

  const after = h.tool("execute.after")
  if (!after) throw new Error("setup did not register execute.after")
  const call = (filePath: string, status: "completed" | "error") => ({
    sessionID: SESSION,
    tool: "edit",
    input: { filePath },
    id: "call_1",
    agent: "agent",
    messageID: "message",
    ...(status === "completed" ? { status, result: {} } : { status, error: {} }),
  })
  await after(call(completed, "completed"))
  await after(call(failed, "error"))

  await h.evaluate(event("shell", `rm ${completed}`))

  // The state lists the session's writes so the model can apply the rule as
  // written; a failed tool call did not create anything.
  assert.equal(h.requests.length, 1)
  const state = h.requests[0]
  assert.match(state, /Files this session created or modified/)
  assert.ok(state.includes(completed), `state should name ${completed}`)
  assert.ok(!state.includes(failed), `state should not name ${failed}`)
})

test("an allow resets the deny streak", async (t) => {
  const h = await harness({
    options: { repeatBlocks: { consecutive: 3, total: 100 } },
    reply: (state) => (state.includes('"rm -rf') ? denied() : clean()),
  })
  t.after(h.dispose)

  await h.evaluate(event("shell", "rm -rf build"))
  await h.evaluate(event("shell", "rm -rf dist"))
  await h.evaluate(event("shell", "ls"))
  await h.evaluate(event("shell", "rm -rf tmp"))
  // The allow broke a two-deny streak, so the next deny is only one: had the
  // allow kept the streak, this read would be paused and stay a prompt.
  const read = event("read", "/etc/hosts")
  await h.evaluate(read)

  assert.equal(read.effect, "allow")
})

test("an allow keeps the total, so repeated denials still pause auto-approval", async (t) => {
  const h = await harness({
    options: { repeatBlocks: { consecutive: 100, total: 3 } },
    reply: (state) => (state.includes('"rm -rf') ? denied() : clean()),
  })
  t.after(h.dispose)

  await h.evaluate(event("shell", "rm -rf build"))
  await h.evaluate(event("shell", "rm -rf dist"))
  await h.evaluate(event("shell", "ls"))
  await h.evaluate(event("shell", "rm -rf tmp"))
  // Three denies total even though they are not consecutive: the allow resets
  // only the streak, and the total has reached its ceiling.
  const read = event("read", "/etc/hosts")
  await h.evaluate(read)

  assert.equal(read.effect, "ask")
})

test("a classifier error fails closed and names the cause", async (t) => {
  const h = await harness({
    options: { fallback: false },
    reply: () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:443")
    },
  })
  t.after(h.dispose)
  const e = event("shell", "pytest -q")

  await h.evaluate(e)

  assert.equal(e.effect, "deny")
  assert.match(e.message ?? "", /classifier unavailable/)
  assert.match(e.message ?? "", /ECONNREFUSED/)
  const log = await h.log(/auto classification failed/)
  assert.match(log, /auto classification failed/)
})
