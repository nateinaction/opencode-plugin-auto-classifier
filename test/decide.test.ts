import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULTS,
  decide,
  describe as describeAction,
  normalize,
  normalize01,
  parseModelRef,
  pct,
  rank,
  type Options,
} from "../decide.ts"

const opts = (over: Options = {}) => normalize(over)

function classify(over: Record<string, unknown> = {}) {
  return {
    category: "other",
    risk: 0,
    destructive: 0,
    secretExposure: 0,
    source: "jev",
    ...over,
  }
}

test("pct rounds to whole percentages", () => {
  assert.equal(pct(0), "0%")
  assert.equal(pct(0.014), "1%")
  assert.equal(pct(0.615), "62%")
  assert.equal(pct(1), "100%")
})

test("normalize01 clamps and coerces", () => {
  assert.equal(normalize01(0.5), 0.5)
  assert.equal(normalize01(-1), 0)
  assert.equal(normalize01(2), 1)
  assert.equal(normalize01("0.25"), 0.25)
  assert.equal(normalize01(undefined), 0)
  assert.equal(normalize01(NaN), 0)
  assert.equal(normalize01("nope"), 0)
})

test("parseModelRef splits provider/model and defaults the provider", () => {
  assert.deepEqual(parseModelRef("opencode-go/deepseek-v4.1-flash"), {
    providerID: "opencode-go",
    id: "deepseek-v4.1-flash",
  })
  assert.deepEqual(parseModelRef("jev-1.13"), { providerID: "opencode-go", id: "jev-1.13" })
  // Only the first slash is the separator; model ids may contain slashes.
  assert.deepEqual(parseModelRef("a/b/c"), { providerID: "a", id: "b/c" })
})

test("rank orders allow < ask < deny", () => {
  assert.ok(rank("allow") < rank("ask"))
  assert.ok(rank("ask") < rank("deny"))
})

test("describe maps actions to Jev state text", () => {
  assert.equal(describeAction("shell", "rm -rf /"), "rm -rf /")
  assert.equal(describeAction("read", "/etc/passwd"), "Read the contents of the file at: /etc/passwd")
  assert.equal(describeAction("edit", "index.ts"), "Write to or modify the file at: index.ts")
  assert.equal(describeAction("webfetch", "https://x"), undefined)
})

test("normalize merges defaults and ignores explicit undefined", () => {
  const merged = normalize({ askRisk: 0.9, debug: undefined })
  assert.equal(merged.askRisk, 0.9)
  assert.equal(merged.model, DEFAULTS.model)
  assert.equal(merged.debug, DEFAULTS.debug)
  assert.equal(merged.fallbackModel, DEFAULTS.fallbackModel)
})

test("normalize with no options returns the defaults", () => {
  assert.deepEqual(normalize({}), { ...DEFAULTS })
})

test("normalize defaults to the OpenCode Zen provider", () => {
  const defaults = normalize({})
  assert.equal(defaults.provider, "jev")
  assert.equal(defaults.model, "jev-1.13")
  assert.equal(defaults.endpoint, "https://opencode.ai/zen/v1/systemone")
})

test("normalize resolves model and endpoint from the selected provider", () => {
  const openrouter = normalize({ provider: "openrouter" })
  assert.equal(openrouter.model, "typesafe/jev-1.14")
  assert.equal(openrouter.endpoint, "https://openrouter.ai/api/alpha/decisions")

  // An explicit model/endpoint wins over the provider default.
  assert.equal(normalize({ provider: "openrouter", model: "~typesafe/jev-latest" }).model, "~typesafe/jev-latest")
  assert.equal(normalize({ provider: "openrouter", endpoint: "https://example.test" }).endpoint, "https://example.test")
})

test("denies when destructive reaches denyDestructive", () => {
  const d = decide(classify({ destructive: 0.97 }), opts())
  assert.equal(d.effect, "deny")
  assert.match(d.reason, /destructive/)
})

test("denies when secret exposure reaches denySecret", () => {
  const d = decide(classify({ secretExposure: 1 }), opts({ denySecret: 0.95 }))
  assert.equal(d.effect, "deny")
  assert.match(d.reason, /secret exposure/)
})

test("denies shell when risk reaches denyRisk (off by default)", () => {
  // With denyRisk off, a maxed-out risk still only escalates to ask.
  assert.equal(decide(classify({ risk: 1 }), opts()).effect, "ask")
  const d = decide(classify({ risk: 1 }), opts({ denyRisk: 0.99 }))
  assert.equal(d.effect, "deny")
  assert.match(d.reason, /critical/)
})

test("escalates destructive actions to ask by default", () => {
  const d = decide(classify({ destructive: 0.5 }), opts())
  assert.equal(d.effect, "ask")
  assert.match(d.reason, /data loss/)
})

test("escalates secret exposure to ask by default", () => {
  const d = decide(classify({ secretExposure: 0.85 }), opts())
  assert.equal(d.effect, "ask")
  assert.match(d.reason, /secret exposure/)
})

test("escalates risky shell commands to ask", () => {
  const d = decide(classify({ risk: 0.8 }), opts())
  assert.equal(d.effect, "ask")
  assert.match(d.reason, /risky/)
})

test("escalateTo deny turns escalations into denials", () => {
  const d = decide(classify({ risk: 0.8 }), opts({ escalateTo: "deny" }))
  assert.equal(d.effect, "deny")
})

test("read and edit ignore the generic risk score", () => {
  const high = classify({ risk: 1 })
  assert.equal(decide(high, opts({ askRisk: 0.1 }), "read").effect, undefined)
  assert.equal(decide(high, opts({ askRisk: 0.1 }), "edit").effect, undefined)
  // ...but still react to destructive/secrets.
  assert.equal(decide(classify({ destructive: 0.5 }), opts(), "edit").effect, "ask")
  assert.equal(decide(classify({ secretExposure: 0.9 }), opts(), "read").effect, "ask")
})

test("privileged shell commands escalate when privilegedAsk is set", () => {
  const d = decide(classify({ category: "privileged" }), opts())
  assert.equal(d.effect, "ask")
  assert.match(d.reason, /Privileged/)
  assert.equal(decide(classify({ category: "privileged" }), opts({ privilegedAsk: false })).effect, undefined)
  // Only shell is treated this way.
  assert.equal(decide(classify({ category: "privileged" }), opts(), "read").effect, undefined)
})

test("escalate overrides thresholds per action", () => {
  const o = opts({ escalate: { edit: { destructive: 0.5 } } })
  // An edit at 0.6 destructive crosses the lower edit threshold...
  assert.equal(decide(classify({ destructive: 0.6 }), o, "edit").effect, "ask")
  // ...while other actions still use the global 0.4 threshold.
  assert.equal(decide(classify({ destructive: 0.45 }), o, "shell").effect, "ask")
  assert.equal(decide(classify({ destructive: 0.3 }), o, "edit").effect, undefined)
})

test("escalate overrides fall back to the global ask values", () => {
  const o = opts({ askDestructive: 0.9, escalate: { shell: { secret: 0.1 } } })
  assert.equal(decide(classify({ destructive: 0.5 }), o, "shell").effect, undefined)
  assert.equal(decide(classify({ secretExposure: 0.2 }), o, "shell").effect, "ask")
})

test("a clean action yields no effect but still describes itself", () => {
  const d = decide(classify({ category: "vcs", risk: 0.01 }), opts())
  assert.equal(d.effect, undefined)
  assert.match(d.reason, /category=vcs/)
})

test("the reason records the classification source", () => {
  assert.match(decide(classify({ destructive: 0.5 }), opts()).reason, /via=jev/)
  assert.match(decide(classify({ destructive: 0.5, source: "fallback" }), opts()).reason, /via=fallback/)
})

test("auto-mode defaults to fail-closed and merges repeatBlocks over the defaults", () => {
  assert.equal(normalize({ mode: "auto-mode" }).failMode, "closed")
  assert.equal(normalize({}).failMode, "open")
  // An explicit choice wins over the auto-mode default.
  assert.equal(normalize({ mode: "auto-mode", failMode: "open" }).failMode, "open")
  assert.deepEqual(normalize({ repeatBlocks: { consecutive: 5 } }).repeatBlocks, { consecutive: 5, total: 20 })
})
