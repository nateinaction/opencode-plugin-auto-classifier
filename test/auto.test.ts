import { test } from "node:test"
import assert from "node:assert/strict"
import { normalize, type Options } from "../decide.ts"
import {
  autoAuthority,
  belowConfidence,
  coverageFor,
  decideAuto,
  reachedPause,
  type AutoVerdict,
} from "../auto.ts"

const opts = (over: Options = {}) => normalize({ mode: "auto-mode", ...over })

function verdict(over: Partial<AutoVerdict> = {}): AutoVerdict {
  return {
    risk: 0,
    destructive: 0,
    secretExposure: 0,
    trustExternal: 0,
    userAuthorizes: 0,
    userForbids: 0,
    scopeEscalation: 0,
    confidence: 0.9,
    ...over,
  }
}

test("a clean verdict auto-approves", () => {
  const d = decideAuto(verdict(), opts())
  assert.equal(d.effect, "allow")
})

test("a hard-deny match denies and names the rule", () => {
  const d = decideAuto(verdict({ hardDenyRule: "Data Exfiltration" }), opts())
  assert.equal(d.effect, "deny")
  assert.equal(d.rule, "Data Exfiltration")
  assert.match(d.reason, /Data Exfiltration/)
})

test("a stated user boundary denies", () => {
  const d = decideAuto(verdict({ userForbids: 0.9 }), opts())
  assert.equal(d.effect, "deny")
  assert.equal(d.rule, "User Boundary")
})

test("a soft-deny match denies unless an allow exception matches", () => {
  assert.equal(decideAuto(verdict({ softDenyRule: "Git Destructive" }), opts()).effect, "deny")
  assert.equal(
    decideAuto(verdict({ softDenyRule: "Git Destructive", allowRule: "Local Operations" }), opts()).effect,
    "allow",
  )
})

test("explicit user intent clears a soft block", () => {
  assert.equal(decideAuto(verdict({ softDenyRule: "Git Destructive", userAuthorizes: 0.8 }), opts()).effect, "allow")
})

test("scope escalation denies an action with a sensitive effect", () => {
  const d = decideAuto(verdict({ scopeEscalation: 0.7, destructive: 0.6 }), opts())
  assert.equal(d.effect, "deny")
  assert.equal(d.rule, "Scope Escalation")
  assert.equal(decideAuto(verdict({ scopeEscalation: 0.7, secretExposure: 0.6 }), opts()).rule, "Scope Escalation")
})

test("scope escalation alone does not deny a harmless action", () => {
  // A terse request ("@wayfinder 125") never names each read an agent runs.
  assert.equal(decideAuto(verdict({ scopeEscalation: 0.9, risk: 0.2 }), opts()).effect, "allow")
})

test("the severity backstop denies even with no rule match", () => {
  assert.equal(decideAuto(verdict({ destructive: 0.98 }), opts()).effect, "deny")
  assert.equal(decideAuto(verdict({ secretExposure: 1 }), opts({ denySecret: 0.9 })).effect, "deny")
  assert.equal(decideAuto(verdict({ risk: 1 }), opts({ denyRisk: 0.99 }), "shell").effect, "deny")
  // risk is only meaningful for shell commands, like the classic path.
  assert.equal(decideAuto(verdict({ risk: 1 }), opts(), "webfetch").effect, "allow")
})

test("reaching outside the trust boundary denies only when it also carries risk", () => {
  assert.equal(decideAuto(verdict({ trustExternal: 0.9 }), opts()).effect, "allow")
  assert.equal(decideAuto(verdict({ trustExternal: 0.9, destructive: 0.6 }), opts()).effect, "deny")
})

test("the reason records the source", () => {
  assert.match(decideAuto(verdict({ destructive: 0.98, source: "fallback" }), opts()).reason, /via=fallback/)
})

test("coverage routes each action to classify, allow, or passthrough", () => {
  assert.equal(coverageFor("read", false), "allow")
  assert.equal(coverageFor("glob", false), "allow")
  assert.equal(coverageFor("grep", false), "allow")
  assert.equal(coverageFor("shell", false), "classify")
  assert.equal(coverageFor("webfetch", false), "classify")
  assert.equal(coverageFor("websearch", false), "classify")
  assert.equal(coverageFor("external_directory", false), "classify")
  assert.equal(coverageFor("edit", true), "classify") // outside the project
  assert.equal(coverageFor("edit", false), "allow") // inside the project
  assert.equal(coverageFor("question", false), "passthrough")
  assert.equal(coverageFor("subagent", false), "passthrough")
})

test("authority lets the classifier auto-approve an otherwise-prompted action", () => {
  const allow = autoAuthority("ask", { effect: "allow", reason: "ok" }, { userAskRule: false, pausePrompts: false })
  assert.equal(allow.effect, "allow")
  const deny = autoAuthority(
    "ask",
    { effect: "deny", rule: "Git Destructive", reason: "x" },
    { userAskRule: false, pausePrompts: false },
  )
  assert.equal(deny.effect, "deny")
  assert.match(deny.message ?? "", /\[Git Destructive\]/)
})

test("authority leaves a user-configured ask rule as a prompt", () => {
  const out = autoAuthority(
    "ask",
    { effect: "deny", rule: "Git Destructive", reason: "x" },
    { userAskRule: true, pausePrompts: false },
  )
  assert.equal(out.effect, "ask")
})

test("authority stops auto-approving once prompting is resumed", () => {
  const out = autoAuthority("ask", { effect: "allow", reason: "x" }, { userAskRule: false, pausePrompts: true })
  assert.equal(out.effect, "ask")
})

test("belowConfidence treats a missing confidence as inconclusive", () => {
  assert.equal(belowConfidence(verdict({ confidence: 0.5 }), 0.6, opts()), true)
  assert.equal(belowConfidence(verdict({ confidence: 0.9 }), 0.6, opts()), false)
  assert.equal(belowConfidence(verdict({ confidence: Number.NaN }), 0.6, opts()), true)
})

test("belowConfidence treats a near-threshold signal that flips the decision as inconclusive", () => {
  // A boundary answer to "did the user forbid this?" decides allow vs deny.
  assert.equal(belowConfidence(verdict({ userForbids: 0.5 }), 0.6, opts()), true)
  assert.equal(belowConfidence(verdict({ scopeEscalation: 0.45, destructive: 0.6 }), 0.6, opts()), true)
  // Authorization matters once a soft rule matched.
  assert.equal(belowConfidence(verdict({ softDenyRule: "Git Destructive", userAuthorizes: 0.5 }), 0.6, opts()), true)
  // Trust only matters with a sensitive effect.
  assert.equal(belowConfidence(verdict({ trustExternal: 0.5, destructive: 0.6 }), 0.6, opts()), true)
  assert.equal(belowConfidence(verdict({ userForbids: 0.05 }), 0.6, opts()), false)
})

test("belowConfidence ignores near-threshold signals that cannot change the decision", () => {
  // No soft rule matched, so authorization is moot.
  assert.equal(belowConfidence(verdict({ userAuthorizes: 0.5 }), 0.6, opts()), false)
  // No sensitive effect, so an uncertain trust boundary or scope is moot.
  assert.equal(belowConfidence(verdict({ trustExternal: 0.45 }), 0.6, opts()), false)
  assert.equal(belowConfidence(verdict({ scopeEscalation: 0.5 }), 0.6, opts()), false)
  // A hard rule denies whatever the intent signals say.
  assert.equal(belowConfidence(verdict({ hardDenyRule: "Data Exfiltration", userForbids: 0.5, userAuthorizes: 0.5 }), 0.6, opts()), false)
})

test("authority never lowers an explicit deny", () => {
  const out = autoAuthority("deny", { effect: "allow", reason: "x" }, { userAskRule: false, pausePrompts: false })
  assert.equal(out.effect, "deny")
})

test("reachedPause fires on either the consecutive or total threshold", () => {
  const o = opts()
  assert.equal(reachedPause(3, 3, o), true)
  assert.equal(reachedPause(0, 20, o), true)
  assert.equal(reachedPause(2, 19, o), false)
})
