import { test } from "node:test"
import assert from "node:assert/strict"
import { createClassifier, DEFAULT_ENDPOINT, DEFAULT_MODEL } from "../jev.ts"

type Call = { url: string; init: RequestInit }

function classifierReturning(body: unknown, init: { status?: number } = {}) {
  let seen: Call | undefined
  const cls = createClassifier({
    apiKey: "test-key",
    fetch: (async (url: any, options: any) => {
      seen = { url: String(url), init: options }
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch,
  })
  return { cls, lastCall: () => seen! }
}

const ANSWER_BODY = {
  model: "jev-1.13",
  usage: { total_tokens: 12 },
  answers: {
    category: { choice: "vcs", confidence: 0.93, probabilities: { vcs: 0.93, other: 0.07 } },
    risk: { score: 0.91, confidence: 0.8, legend: { "0": "Safe", "4": "Critical" } },
    destructive: { noul: 0.92 },
    secret_exposure: { noul: 0.23 },
  },
}

test("sends model, state and typed questions to the default endpoint", async () => {
  const c = classifierReturning(ANSWER_BODY)
  await c.cls.classify("git push --force")

  const call = c.lastCall()
  assert.equal(call.url, DEFAULT_ENDPOINT)
  const body = JSON.parse(String(call.init.body))
  assert.equal(body.model, DEFAULT_MODEL)
  assert.equal(body.state, "git push --force")
  assert.deepEqual(Object.keys(body.questions).sort(), ["category", "destructive", "risk", "secret_exposure"])
  assert.equal(body.questions.category.type, "choice")
  assert.equal(body.questions.risk.type, "score")
  assert.equal(body.questions.destructive.type, "noul")
})

test("authenticates with a bearer token", async () => {
  const c = classifierReturning(ANSWER_BODY)
  await c.cls.classify("ls")
  const headers = c.lastCall().init.headers as Record<string, string>
  assert.equal(headers.Authorization, "Bearer test-key")
  assert.equal(headers["Content-Type"], "application/json")
})

test("omits the Authorization header without a key", async () => {
  const previous = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  try {
    let headers: Record<string, string> = {}
    const cls = createClassifier({
      fetch: (async (_url: any, options: any) => {
        headers = options.headers
        return new Response(JSON.stringify(ANSWER_BODY), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await cls.classify("ls")
    assert.equal(headers.Authorization, undefined)
  } finally {
    if (previous !== undefined) process.env.OPENCODE_API_KEY = previous
  }
})

test("reads the key from OPENCODE_API_KEY", async () => {
  const previous = process.env.OPENCODE_API_KEY
  process.env.OPENCODE_API_KEY = "env-key"
  try {
    let headers: Record<string, string> = {}
    const cls = createClassifier({
      fetch: (async (_url: any, options: any) => {
        headers = options.headers
        return new Response(JSON.stringify(ANSWER_BODY), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await cls.classify("ls")
    assert.equal(headers.Authorization, "Bearer env-key")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previous
  }
})

test("parses a well-formed response into a Classification", async () => {
  const c = classifierReturning(ANSWER_BODY)
  const result = await c.cls.classify("git push --force")

  assert.equal(result.category, "vcs")
  assert.equal(result.categoryConfidence, 0.93)
  assert.equal(result.risk, 0.91)
  assert.equal(result.destructive, 0.92)
  assert.equal(result.secretExposure, 0.23)
  assert.equal(result.model, "jev-1.13")
  assert.equal(result.command, "git push --force")
  assert.deepEqual(result.usage, { total_tokens: 12 })
})

test("maps the risk score onto the legend band", async () => {
  const c = classifierReturning(ANSWER_BODY)
  // 0.91 * 4 rounds to 4 -> "Critical".
  assert.equal((await c.cls.classify("x")).riskLegend, "Critical")

  const low = classifierReturning({
    ...ANSWER_BODY,
    answers: { ...ANSWER_BODY.answers, risk: { score: 0.1, legend: { "0": "Safe", "4": "Critical" } } },
  })
  assert.equal((await low.cls.classify("x")).riskLegend, "Safe")
})

test("clamps out-of-range scores", async () => {
  const c = classifierReturning({
    ...ANSWER_BODY,
    answers: {
      ...ANSWER_BODY.answers,
      risk: { score: 5, confidence: 0.8 },
      category: { choice: "vcs", confidence: 2, probabilities: {} },
    },
  })
  const result = await c.cls.classify("x")
  assert.equal(result.risk, 1)
  assert.equal(result.categoryConfidence, 1)
})

test("throws on an empty state", async () => {
  const c = classifierReturning(ANSWER_BODY)
  await assert.rejects(() => c.cls.classify("   "), /empty state/)
})

test("throws on a non-OK HTTP response", async () => {
  const c = classifierReturning("nope", { status: 403 })
  await assert.rejects(() => c.cls.classify("ls"), /HTTP 403/)
})

test("throws on invalid JSON", async () => {
  const c = classifierReturning("{not json")
  await assert.rejects(() => c.cls.classify("ls"), /invalid JSON response/)
})

test("throws when the response is missing typed answers", async () => {
  const c = classifierReturning({ model: "jev-1.13" })
  await assert.rejects(() => c.cls.classify("ls"), /unexpected response shape/)
})

test("aborts and rejects when the caller's signal is aborted", async () => {
  const cls = createClassifier({
    fetch: (async (_url: any, options: any) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")))
      })) as unknown as typeof fetch,
  })
  const controller = new AbortController()
  const promise = cls.classify("sleep 100", controller.signal)
  controller.abort()
  await assert.rejects(() => promise, /aborted/)
})

test("aborts on the configured timeout", async () => {
  const cls = createClassifier({
    timeoutMs: 5,
    fetch: (async (_url: any, options: any) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("timeout")))
      })) as unknown as typeof fetch,
  })
  await assert.rejects(() => cls.classify("slow"), /timeout/)
})

test("exposes the resolved model and endpoint", () => {
  const cls = createClassifier({ model: "custom", endpoint: "https://example.test" })
  assert.equal(cls.model, "custom")
  assert.equal(cls.endpoint, "https://example.test")
})
