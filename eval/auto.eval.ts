// Live eval of the auto-mode question wording against Jev on OpenRouter.
//
// Jev's answers cannot be unit-tested, so this sends a fixed set of cases
// through the same path the plugin uses (buildState -> Jev -> parseAutoAnswers
// -> decideAuto) and compares each decision with the expected one. It makes
// one paid request per case and reads OPENROUTER_API_KEY from the environment.
//
//   OPENROUTER_API_KEY=... npm run eval

import { normalize, PROVIDER_DEFAULTS } from "../decide.ts"
import { belowConfidence, decideAuto } from "../auto.ts"
import { buildAutoQuestions, createClassifier, parseAutoAnswers } from "../jev.ts"
import { mergeRules } from "../rules.ts"
import { caseState, caseTrust, selectCases } from "./cases.ts"

const opts = normalize({ mode: "auto-mode", provider: "openrouter" })
const apiKeyEnv = PROVIDER_DEFAULTS.openrouter.apiKeyEnv
if (!process.env[apiKeyEnv]) {
  console.error(`${apiKeyEnv} is not set; the eval calls Jev on OpenRouter and needs a key.`)
  process.exit(2)
}

const classifier = createClassifier({ model: opts.model, endpoint: opts.endpoint, apiKeyEnv, timeoutMs: 30_000 })
const questions = buildAutoQuestions(mergeRules(opts.rules))
const pct = (n: number): string => `${Math.round(n * 100)}%`

// EVAL_FILTER=<substring> runs only the cases whose name contains it.
const filter = process.env.EVAL_FILTER ?? ""
const selected = selectCases(filter)

// A case passes when the configured policy reaches the expected decision. An
// inconclusive verdict is routed through `onUncertain` exactly as the plugin
// does it: "tiered" (the default) and "deny" mark the verdict uncertain, so the
// facts decide; "accept" acts on Jev's own answers. The tallies still report how
// every policy would have done.
let failures = 0
let errors = 0
let acceptRight = 0
let denyRight = 0
const inconclusiveCases: string[] = []
const acceptLetsThrough: string[] = []
for (const c of selected) {
  const state = caseState(c)
  try {
    const { answers } = await classifier.answer(state, questions)
    const verdict = parseAutoAnswers(answers)
    verdict.source = "openrouter"
    const facts = caseTrust(c)
    const inconclusive = belowConfidence(verdict, opts.confidenceFloor, opts, "shell")
    const accepted = decideAuto(verdict, opts, "shell", facts, c.resource)
    const routed =
      inconclusive && (opts.onUncertain === "tiered" || opts.onUncertain === "deny")
        ? { ...verdict, uncertain: true }
        : verdict
    const decision = decideAuto(routed, opts, "shell", facts, c.resource)
    const pass = decision.effect === c.expect
    if (!pass) failures++
    if (accepted.effect === c.expect) acceptRight++
    if ((inconclusive ? "deny" : accepted.effect) === c.expect) denyRight++
    if (inconclusive) inconclusiveCases.push(c.name)
    if (inconclusive && c.expect === "deny" && accepted.effect === "allow") acceptLetsThrough.push(c.name)
    const got = inconclusive ? `${decision.effect} (inconclusive -> ${opts.onUncertain})` : decision.effect
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.name}`)
    console.log(
      `      expect=${c.expect} got=${got} rule=${decision.rule ?? "-"} secret=${pct(verdict.secretExposure)} scope=${pct(verdict.scopeEscalation)} external=${pct(verdict.trustExternal)} forbids=${pct(verdict.userForbids)} destructive=${pct(verdict.destructive)} hard=${verdict.hardDenyRule ?? "-"} soft=${verdict.softDenyRule ?? "-"} allow=${verdict.allowRule ?? "-"} authorizes=${pct(verdict.userAuthorizes)} confidence=${pct(verdict.confidence)}`,
    )
  } catch (error) {
    failures++
    errors++
    console.log(`ERROR ${c.name}: ${String(error).slice(0, 200)}`)
  }
}

const answered = selected.length - errors
console.log(`\n${selected.length - failures}/${selected.length} passed with onUncertain "${opts.onUncertain}"`)
console.log(`inconclusive: ${inconclusiveCases.length}${inconclusiveCases.length ? ` (${inconclusiveCases.join("; ")})` : ""}`)
console.log(`onUncertain "accept": ${acceptRight}/${answered} right`)
console.log(`onUncertain "deny":   ${denyRight}/${answered} right`)
console.log(`deny cases "accept" would allow: ${acceptLetsThrough.length ? acceptLetsThrough.join("; ") : "none"}`)
process.exit(failures === 0 ? 0 : 1)
