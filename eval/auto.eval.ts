// Live eval of the auto-mode question wording against the classifier on OpenRouter.
//
// The classifier's answers cannot be unit-tested, so this sends a fixed set of cases
// through the same path the plugin uses (buildState -> classifier -> parseAutoAnswers
// -> decideAuto) and compares each decision with the expected one. It makes
// one paid request per case and reads OPENROUTER_API_KEY from the environment.
//
//   OPENROUTER_API_KEY=... npm run eval

import { normalize, PROVIDER_DEFAULTS } from "../decide.ts"
import { belowConfidence, decideAuto } from "../auto.ts"
import { buildAutoQuestions, createClassifier, parseAutoAnswers } from "../classifier.ts"
import { mergeRules } from "../rules.ts"
import { contextSpans } from "../context.ts"
import { caseAccepts, caseAction, caseResource, caseState, caseTrust, selectCases } from "./cases.ts"

const opts = normalize({ mode: "auto-mode", provider: "openrouter" })
const apiKeyEnv = PROVIDER_DEFAULTS.openrouter.apiKeyEnv
if (!process.env[apiKeyEnv]) {
  console.error(`${apiKeyEnv} is not set; the eval calls the classifier on OpenRouter and needs a key.`)
  process.exit(2)
}

const classifier = createClassifier({ model: opts.model, endpoint: opts.endpoint, apiKeyEnv, timeoutMs: 30_000 })
const rules = mergeRules(opts.rules)
const pct = (n: number): string => `${Math.round(n * 100)}%`

// EVAL_FILTER=<substring> runs only the cases whose name contains it.
const filter = process.env.EVAL_FILTER ?? ""
const selected = selectCases(filter)

// A case passes when the configured policy reaches the expected decision. An
// inconclusive verdict is routed through `onUncertain` exactly as the plugin
// does it: "tiered" (the default) and "deny" mark the verdict uncertain, so the
// facts decide; "accept" acts on the classifier's own answers. The tallies still
// report how every policy would have done.
let failures = 0
let errors = 0
let acceptRight = 0
let denyRight = 0
const inconclusiveCases: string[] = []
const acceptLetsThrough: string[] = []
for (const c of selected) {
  const state = caseState(c)
  const action = caseAction(c)
  const resource = caseResource(c)
  try {
    // The statements a boundary or authorization answer must quote, from the
    // same state the model reads, exactly as the plugin does it.
    const spans = contextSpans(state)
    const { answers } = await classifier.answer(state, buildAutoQuestions(rules, spans))
    const verdict = parseAutoAnswers(answers, spans)
    verdict.source = "openrouter"
    const facts = caseTrust(c)
    const inconclusive = belowConfidence(verdict, opts.confidenceFloor, opts, action)
    const accepted = decideAuto(verdict, opts, action, facts, resource)
    const routed =
      inconclusive && (opts.onUncertain === "tiered" || opts.onUncertain === "deny")
        ? { ...verdict, uncertain: true }
        : verdict
    const decision = decideAuto(routed, opts, action, facts, resource)
    const pass = caseAccepts(c, decision.effect)
    if (!pass) failures++
    if (caseAccepts(c, accepted.effect)) acceptRight++
    if (caseAccepts(c, inconclusive ? "deny" : accepted.effect)) denyRight++
    if (inconclusive) inconclusiveCases.push(c.name)
    if (inconclusive && c.expect === "deny" && accepted.effect === "allow") acceptLetsThrough.push(c.name)
    const got = inconclusive ? `${decision.effect} (inconclusive -> ${opts.onUncertain})` : decision.effect
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.name}`)
    const also = c.alsoAccept?.length ? ` also=${c.alsoAccept.join("|")}` : ""
    console.log(
      `      action=${action} expect=${c.expect}${also} got=${got} rule=${decision.rule ?? "-"} category=${verdict.category ?? "-"} credentials=${pct(verdict.revealsCredentials)} new-data=${pct(verdict.newSensitiveData)} contents=${pct(verdict.readsContents)} scope=${pct(verdict.scopeEscalation)} external=${pct(verdict.trustExternal)} forbids=${pct(verdict.userForbids)} destructive=${pct(verdict.destructive)} hard=${verdict.hardDenyRule ?? "-"} soft=${verdict.softDenyRule ?? "-"} allow=${verdict.allowRule ?? "-"} authorizes=${pct(verdict.userAuthorizes)} confidence=${pct(verdict.confidence)} boundary="${verdict.boundaryQuote?.slice(0, 50) ?? "-"}" authorization="${verdict.authorizationQuote?.slice(0, 50) ?? "-"}"`,
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
