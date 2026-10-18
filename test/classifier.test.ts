import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildAutoQuestions,
  createClassifier,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  parseAutoAnswers,
} from "../classifier.ts"
import { mergeRules } from "../rules.ts"

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
    // Score is on the 0..4 risk-level scale; 3.64 / 4 = 0.91.
    risk: { score: 3.64, confidence: 0.8, legend: { "0": "Safe", "4": "Critical" } },
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
  // Level 3.64 rounds to 4 -> "Critical".
  assert.equal((await c.cls.classify("x")).riskLegend, "Critical")

  const low = classifierReturning({
    ...ANSWER_BODY,
    answers: { ...ANSWER_BODY.answers, risk: { score: 0.4, legend: { "0": "Safe", "4": "Critical" } } },
  })
  assert.equal((await low.cls.classify("x")).riskLegend, "Safe")
})

test("normalizes the risk level to 0..1 rather than clamping it", async () => {
  // Model 1.14 answered 1.84 ("Moderate") for a source-file edit; clamping read
  // that as maximum risk.
  const c = classifierReturning({
    ...ANSWER_BODY,
    answers: { ...ANSWER_BODY.answers, risk: { score: 1.84, legend: { "0": "Safe", "2": "Moderate", "4": "Critical" } } },
  })
  const result = await c.cls.classify("x")
  assert.equal(result.risk, 0.46)
  assert.equal(result.riskLegend, "Moderate")
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

test("throws when a score is missing instead of treating it as safe", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["risk", { risk: { confidence: 0.8 } }],
    ["destructive", { destructive: undefined }],
    ["destructive", { destructive: {} }],
    ["secret_exposure", { secret_exposure: undefined }],
    ["secret_exposure", { secret_exposure: { noul: "0.1" } }],
  ]
  for (const [name, override] of cases) {
    const c = classifierReturning({ ...ANSWER_BODY, answers: { ...ANSWER_BODY.answers, ...override } })
    await assert.rejects(() => c.cls.classify("ls"), new RegExp(`classifier: answer has no numeric ${name}`))
  }
})

test("reads the key from apiKeyEnv and never sends another provider's key", async () => {
  const previous = { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
  // createClassifier reads the environment when it is built, so set it first.
  const authorizationWith = async (routerKey: string | undefined) => {
    if (routerKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = routerKey
    let headers: Record<string, string> = {}
    const cls = createClassifier({
      apiKeyEnv: "OPENROUTER_API_KEY",
      fetch: (async (_url: any, options: any) => {
        headers = options.headers
        return new Response(JSON.stringify(ANSWER_BODY), { status: 200 })
      }) as unknown as typeof fetch,
    })
    await cls.classify("ls")
    return headers.Authorization
  }

  process.env.OPENCODE_API_KEY = "zen-key"
  try {
    assert.equal(await authorizationWith("router-key"), "Bearer router-key")
    assert.equal(await authorizationWith(undefined), undefined)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

const AUTO_ANSWERS = {
  model: "jev-1.13",
  answers: {
    hard_deny_rule: { choice: "none", confidence: 0.8, probabilities: { none: 0.8 } },
    soft_deny_rule: { choice: "Git Destructive", confidence: 0.7, probabilities: { "Git Destructive": 0.7 } },
    allow_rule: { choice: "none", confidence: 0.9, probabilities: { none: 0.9 } },
    trust_external: { noul: 0.1 },
    user_authorizes: { noul: 0.0 },
    user_forbids: { noul: 0.0 },
    scope_escalation: { noul: 0.0 },
    category: { choice: "vcs", confidence: 0.95, probabilities: { vcs: 0.95 } },
    risk: { score: 3.64, legend: { "0": "Safe", "4": "Critical" } },
    destructive: { noul: 0.92 },
    reveals_credentials: { noul: 0.23 },
    new_sensitive_data: { noul: 0.41 },
    reads_contents: { noul: 0.77 },
  },
}

test("buildAutoQuestions asks the rule, trust and intent questions", () => {
  const questions = buildAutoQuestions(mergeRules({ environment: ["$defaults", "Trusted domain: docs.example.com"] }))
  assert.deepEqual(
    Object.keys(questions).sort(),
    [
      "allow_rule",
      "category",
      "destructive",
      "hard_deny_rule",
      "new_sensitive_data",
      "reads_contents",
      "reveals_credentials",
      "risk",
      "scope_escalation",
      "soft_deny_rule",
      "trust_external",
      "user_authorizes",
      "user_forbids",
    ].sort(),
  )
  assert.equal(questions.hard_deny_rule.type, "choice")
  assert.equal(questions.trust_external.type, "noul")
  // The trust boundary is described to the model in the question itself.
  assert.match(questions.trust_external.instructions, /docs\.example\.com/)
})

test("answer sends the given questions and returns raw answers", async () => {
  const c = classifierReturning(AUTO_ANSWERS)
  const questions = buildAutoQuestions(mergeRules(undefined))
  const result = await c.cls.answer("assembled state", questions)

  const body = JSON.parse(String(c.lastCall().init.body))
  assert.equal(body.state, "assembled state")
  assert.deepEqual(Object.keys(body.questions), Object.keys(questions))
  assert.equal(result.answers.soft_deny_rule.choice, "Git Destructive")
})

test("parseAutoAnswers maps the verdict and takes the lowest choice confidence", () => {
  const verdict = parseAutoAnswers(AUTO_ANSWERS.answers)
  assert.equal(verdict.risk, 0.91)
  assert.equal(verdict.destructive, 0.92)
  assert.equal(verdict.revealsCredentials, 0.23)
  assert.equal(verdict.newSensitiveData, 0.41)
  assert.equal(verdict.readsContents, 0.77)
  assert.equal(verdict.softDenyRule, "Git Destructive")
  // A soft rule matched, so allow_rule counts: min(0.8, 0.7, 0.9) = 0.7
  assert.equal(verdict.confidence, 0.7)
  assert.deepEqual(verdict.choiceConfidence, { hard_deny_rule: 0.8, soft_deny_rule: 0.7, allow_rule: 0.9, category: 0.95 })
})

test("parseAutoAnswers ignores choices that cannot change the decision", () => {
  const answers = {
    ...AUTO_ANSWERS.answers,
    soft_deny_rule: { choice: "none", confidence: 0.9, probabilities: { none: 0.9 } },
    allow_rule: { choice: "Read-Only HTTP", confidence: 0.3, probabilities: { "Read-Only HTTP": 0.3 } },
    category: { choice: "read", confidence: 0.4, probabilities: { read: 0.4 } },
  }
  // No soft rule matched: neither allow_rule nor category can flip the outcome.
  assert.equal(parseAutoAnswers(answers).confidence, 0.8)
})

test("parseAutoAnswers treats a missing rule choice confidence as inconclusive", () => {
  const { hard_deny_rule: _drop, ...rest } = AUTO_ANSWERS.answers
  const verdict = parseAutoAnswers(rest as typeof AUTO_ANSWERS.answers)
  assert.equal(verdict.hardDenyRule, undefined)
  assert.equal(verdict.confidence, 0)
})

const SPANS = ["Fix the failing test, but don't push anything until I've reviewed it.", "Reconcile the ledger."]

test("buildAutoQuestions offers the context statements when the state has them", () => {
  const questions = buildAutoQuestions(mergeRules(undefined), SPANS)
  const criteria = {
    "statement 1": SPANS[0],
    "statement 2": SPANS[1],
    none: "No statement in the context does.",
  }
  assert.equal(questions.boundary_span.type, "choice")
  assert.deepEqual(questions.boundary_span.criteria, criteria)
  assert.deepEqual(questions.authorization_span.criteria, criteria)
  // Without statements there is nothing to quote, so the choice is not asked.
  assert.equal(buildAutoQuestions(mergeRules(undefined)).boundary_span, undefined)
})

test("parseAutoAnswers needs a chosen statement for a boundary or authorization", () => {
  const answers = {
    ...AUTO_ANSWERS.answers,
    user_forbids: { noul: 0.9 },
    user_authorizes: { noul: 0.8 },
    boundary_span: { choice: "statement 1", confidence: 0.9 },
    authorization_span: { choice: "statement 2", confidence: 0.9 },
  }
  const verdict = parseAutoAnswers(answers, SPANS)
  assert.equal(verdict.userForbids, 0.9)
  assert.equal(verdict.boundaryQuote, SPANS[0])
  assert.equal(verdict.userAuthorizes, 0.8)
  assert.equal(verdict.authorizationQuote, SPANS[1])
  // No statement chosen, or one not offered, is no signal at all: the
  // `gh issue comment` denial cited `user_forbids` 0.51 with nothing behind it.
  for (const choice of [undefined, "none", "statement 9", "Statement 1", 1]) {
    const dropped = parseAutoAnswers({ ...answers, boundary_span: { choice }, authorization_span: { choice } }, SPANS)
    assert.equal(dropped.userForbids, 0, String(choice))
    assert.equal(dropped.userAuthorizes, 0, String(choice))
    assert.equal(dropped.boundaryQuote, undefined)
    assert.equal(dropped.authorizationQuote, undefined)
  }
  // No statements offered: nothing to quote.
  const unquoted = parseAutoAnswers(answers)
  assert.equal(unquoted.userForbids, 0)
  assert.equal(unquoted.userAuthorizes, 0)
})

