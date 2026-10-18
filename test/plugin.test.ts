// Wiring tests for the auto-mode permission hook: a fake `ctx` captures the
// handler `setup` registers, and fake `session.get` supplies the ruleset the
// hook reads. No Jev request is made: every case here settles on the user's own
// rules before classification runs.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../index.ts"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }
type Evaluate = (event: PermissionEvaluation) => Promise<void>

/** A session id with the brand the permission hook's payload carries. */
const SESSION = "ses_test" as PermissionEvaluation["sessionID"]

interface Harness {
  evaluate: Evaluate
  /** The inputs `session.get` received, in order. */
  gets: Array<{ sessionID: string }>
  /** Prompts sent to the LLM fallback. */
  prompts: string[]
  /** The debug log's contents, once an append matching `until` has landed. */
  log: (until?: RegExp) => Promise<string>
  dispose: () => Promise<void>
}

async function harness(ruleset: (input: { sessionID: string }) => Promise<unknown>): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "auto-classifier-test-"))
  const debugLog = join(dir, "debug.log")
  const gets: Harness["gets"] = []
  const prompts: string[] = []
  let evaluate: Evaluate | undefined

  const ctx = {
    options: { mode: "auto-mode", debug: true, debugLog },
    location: { directory: process.cwd() },
    generate: {
      text: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt)
        return { text: "" }
      },
    },
    session: {
      get: async (input: { sessionID: string }) => {
        gets.push(input)
        return ruleset(input)
      },
      context: async () => [],
    },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async () => ({ dispose: async () => {} }),
    },
    permission: {
      hook: async (_name: string, callback: Evaluate) => {
        evaluate = callback
        return { dispose: async () => {} }
      },
    },
  }

  await plugin.setup(ctx as never)
  if (!evaluate) throw new Error("setup did not register the permission handler")

  return {
    evaluate,
    gets,
    prompts,
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
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const ruleset = (...rules: Rule[]) => async () => ({ permissions: rules })

test("a repo permissions allow rule auto-approves an incoming prompt", async (t) => {
  const h = await harness(ruleset({ action: "shell", resource: "pytest *", effect: "allow" }))
  t.after(h.dispose)
  const event: PermissionEvaluation = {
    sessionID: SESSION,
    action: "shell",
    resources: ["pytest -q"],
    effect: "ask",
  }

  await h.evaluate(event)

  assert.equal(event.effect, "allow")
  // The ruleset comes from the session, with the input the host requires.
  assert.deepEqual(h.gets, [{ sessionID: SESSION }])
  // The user's policy settles it without paying for a classification.
  assert.equal(h.prompts.length, 0)
})

test("a user ask rule keeps its prompt for an auto-allowed read", async (t) => {
  const h = await harness(ruleset({ action: "read", resource: "/etc/*", effect: "ask" }))
  t.after(h.dispose)
  const event: PermissionEvaluation = {
    sessionID: SESSION,
    action: "read",
    resources: ["/etc/hosts"],
    effect: "ask",
  }

  await h.evaluate(event)

  assert.equal(event.effect, "ask")
})

test("a failed ruleset lookup keeps the prompt and logs a distinct message", async (t) => {
  const h = await harness(async () => {
    throw new Error("session unavailable")
  })
  t.after(h.dispose)
  const event: PermissionEvaluation = {
    sessionID: SESSION,
    action: "read",
    resources: ["/etc/hosts"],
    effect: "ask",
  }

  await h.evaluate(event)

  // An unreadable ruleset must not read as "the user has no ask rule".
  assert.equal(event.effect, "ask")
  const log = await h.log(/session permission rules unavailable/)
  assert.match(log, /session permission rules unavailable/)
  assert.doesNotMatch(log, /permission\.list failed/)
})
