// Live eval of the auto-mode LLM fallback.
//
// The plugin hands an inconclusive Jev verdict to a general model and treats
// its answer as final, so a fallback that answers the same action differently
// on each call turns into flaky denials. This sends every case through the
// fallback path the plugin uses (buildAutoPrompt -> model -> parseAutoVerdict
// -> decideAuto) several times and reports how often each decision matches the
// expected one, and which cases flip between allow and deny.
//
// The model is called through OpenRouter's chat completions API, so any
// OpenRouter model id can stand in for the configured fallback. It makes
// EVAL_SAMPLES paid requests per case and reads OPENROUTER_API_KEY.
//
//   OPENROUTER_API_KEY=... npm run eval:fallback
//   FALLBACK_MODEL=anthropic/claude-haiku-5.5 EVAL_SAMPLES=3 npm run eval:fallback

import { decideAuto } from "../auto.ts"
import { normalize } from "../decide.ts"
import { mergeRules } from "../rules.ts"
import { buildAutoPrompt, parseAutoVerdict } from "../verdict.ts"
import { caseState, caseTrust, selectCases, type Case } from "./cases.ts"

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
const API_KEY_ENV = "OPENROUTER_API_KEY"
// The plugin's default fallback, opencode-go/deepseek-v4.1-flash, as OpenRouter names it.
const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash"
const MAX_SAMPLES = 10
const TIMEOUT_MS = 60_000

const apiKey = process.env[API_KEY_ENV]
if (!apiKey) {
  console.error(`${API_KEY_ENV} is not set; the eval calls the fallback model on OpenRouter and needs a key.`)
  process.exit(2)
}

const model = process.env.FALLBACK_MODEL || DEFAULT_MODEL
const samples = Number(process.env.EVAL_SAMPLES ?? "5")
if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) {
  console.error(`EVAL_SAMPLES must be an integer from 1 to ${MAX_SAMPLES}.`)
  process.exit(2)
}

const opts = normalize({ mode: "auto-mode", provider: "openrouter" })
const rules = mergeRules(opts.rules)

/** One completion of `prompt`; throws on a transport or API error. */
async function complete(prompt: string): Promise<string> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
  const text = body.choices?.[0]?.message?.content
  if (typeof text !== "string") throw new Error(`no completion text: ${JSON.stringify(body).slice(0, 200)}`)
  return text
}

type Sample = { effect: "allow" | "deny"; rule?: string } | { error: string }

/** Classify one case once through the fallback path. */
async function sample(c: Case): Promise<Sample> {
  try {
    const verdict = parseAutoVerdict(await complete(buildAutoPrompt(caseState(c), rules)), "fallback")
    const decision = decideAuto(verdict, opts, "shell", caseTrust(c), c.resource)
    return { effect: decision.effect, rule: decision.rule }
  } catch (error) {
    return { error: String(error).slice(0, 200) }
  }
}

/** "Scope Escalation x2, -" style tally of the rules behind the samples' decisions. */
function tally(results: Sample[]): string {
  const counts = new Map<string, number>()
  for (const r of results) {
    const key = "error" in r ? "error" : (r.rule ?? "-")
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, n]) => `${key} x${n}`).join(", ")
}

type Outcome = { right: number; errors: number; flips: boolean; seconds: number }

/** Sample one case `samples` times concurrently and print its line. */
async function runCase(c: Case): Promise<Outcome> {
  const started = Date.now()
  const results = await Promise.all(Array.from({ length: samples }, () => sample(c)))
  const seconds = (Date.now() - started) / 1000
  const decided = results.filter((r): r is Exclude<Sample, { error: string }> => !("error" in r))
  const right = decided.filter((r) => r.effect === c.expect).length
  const flips = new Set(decided.map((r) => r.effect)).size > 1
  const mark = right === samples ? "PASS " : flips ? "FLIP " : "FAIL "
  const errors = results.filter((r): r is { error: string } => "error" in r)
  const lines = [
    `${mark} ${c.name}`,
    `      expect=${c.expect} right=${right}/${samples} ${seconds.toFixed(0)}s rules: ${tally(results)}`,
    ...errors.map((r) => `      error: ${r.error}`),
  ]
  console.log(lines.join("\n"))
  return { right, errors: errors.length, flips, seconds }
}

const selected = selectCases(process.env.EVAL_FILTER ?? "")
// Cases run in a pool of CASE_CONCURRENCY workers, each case's samples in
// parallel: at most CASE_CONCURRENCY * EVAL_SAMPLES requests in flight. The
// upstream latency varies from seconds to past the timeout, so a sequential
// run waits on the slowest sample of every case in turn.
const CASE_CONCURRENCY = 6
console.log(`fallback model: ${model}, ${samples} samples per case, ${CASE_CONCURRENCY} cases at a time\n`)

const outcomes: Outcome[] = []
let next = 0
async function worker(): Promise<void> {
  // Bounded by the case list: each iteration takes one case and advances.
  while (next < selected.length) {
    const c = selected[next++]
    outcomes.push(await runCase(c))
  }
}
await Promise.all(Array.from({ length: Math.min(CASE_CONCURRENCY, selected.length) }, worker))

const stableCorrect = outcomes.filter((o) => o.right === samples).length
const flipping = outcomes.filter((o) => o.flips).length
const correctSamples = outcomes.reduce((sum, o) => sum + o.right, 0)
const errorSamples = outcomes.reduce((sum, o) => sum + o.errors, 0)
const slowest = Math.max(0, ...outcomes.map((o) => o.seconds))
const total = selected.length * samples
console.log(
  `\n${stableCorrect}/${selected.length} cases right on every sample, ${flipping} flipping; ` +
    `${correctSamples}/${total} samples right, ${errorSamples} errors; slowest case ${slowest.toFixed(0)}s`,
)
process.exit(stableCorrect === selected.length ? 0 : 1)
