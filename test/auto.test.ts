import { test } from "node:test"
import assert from "node:assert/strict"
import { normalize, type Options } from "../decide.ts"
import {
  autoAuthority,
  belowConfidence,
  coverageFor,
  decideAuto,
  describeAnswers,
  matchPermissionRule,
  permissionPolicy,
  reachedPause,
  reconcileFallback,
  rememberSessionDecision,
  sessionDecisionKey,
  SESSION_DECISION_LIMIT,
  type AutoVerdict,
} from "../auto.ts"

const opts = (over: Options = {}) => normalize({ mode: "auto-mode", ...over })

function verdict(over: Partial<AutoVerdict> = {}): AutoVerdict {
  return {
    risk: 0,
    destructive: 0,
    revealsCredentials: 0,
    newSensitiveData: 0,
    // A manually built verdict names content reads unless a case says otherwise:
    // the metadata gate must be opted into, so older tests keep their meaning.
    readsContents: 1,
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

test("a verdict marked uncertain denies, though its answers would allow", () => {
  const d = decideAuto(verdict({ uncertain: true }), opts())
  assert.equal(d.effect, "deny")
  assert.equal(d.rule, "Uncertain")
  // A confident hard rule keeps its own label.
  assert.equal(decideAuto(verdict({ uncertain: true, hardDenyRule: "Data Exfiltration" }), opts()).rule, "Data Exfiltration")
  // A matched allow rule settles the uncertainty, like it does in decideAuto.
  assert.equal(decideAuto(verdict({ uncertain: true, allowRule: "Local Operations" }), opts()).effect, "allow")
  // But not a credential.
  assert.equal(
    decideAuto(verdict({ uncertain: true, allowRule: "Local Operations", revealsCredentials: 0.9 }), opts()).rule,
    "Uncertain",
  )
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
  assert.equal(decideAuto(verdict({ scopeEscalation: 0.7, revealsCredentials: 0.6 }), opts()).rule, "Scope Escalation")
})

test("scope escalation alone does not deny a harmless action", () => {
  // A terse request ("@wayfinder 125") never names each read an agent runs.
  assert.equal(decideAuto(verdict({ scopeEscalation: 0.9, risk: 0.2 }), opts()).effect, "allow")
})

test("the severity backstop is off by default in auto-mode", () => {
  // Rules and stated intent decide deletion; an explicit request must not be overridden.
  assert.equal(decideAuto(verdict({ destructive: 0.98 }), opts()).effect, "allow")
  assert.equal(opts().denyDestructive, 1.01)
  assert.equal(normalize({}).denyDestructive, 0.97)
})

test("the severity backstop denies even with no rule match when configured", () => {
  assert.equal(decideAuto(verdict({ destructive: 0.98 }), opts({ denyDestructive: 0.97 })).effect, "deny")
  assert.equal(decideAuto(verdict({ revealsCredentials: 1 }), opts({ denySecret: 0.9 })).effect, "deny")
  assert.equal(decideAuto(verdict({ risk: 1 }), opts({ denyRisk: 0.99 }), "shell").effect, "deny")
  // risk is only meaningful for shell commands, like the classic path.
  assert.equal(decideAuto(verdict({ risk: 1 }), opts(), "webfetch").effect, "allow")
})

test("reaching outside the trust boundary denies only when it also carries risk", () => {
  assert.equal(decideAuto(verdict({ trustExternal: 0.9 }), opts()).effect, "allow")
  assert.equal(decideAuto(verdict({ trustExternal: 0.9, destructive: 0.6 }), opts()).effect, "deny")
})

test("a matched allow rule outranks scope and trust", () => {
  // `pytest -q scripts/tests/test_migrate_usaa.py` in the 2026-10-17 log:
  // allow=Local Operations, new data=60%, scope=65% — denied anyway.
  const d = decideAuto(
    verdict({ allowRule: "Local Operations", newSensitiveData: 0.6, scopeEscalation: 0.65, trustExternal: 0.27 }),
    opts(),
  )
  assert.equal(d.effect, "allow")
  assert.equal(d.rule, "Local Operations")
  // Read-Only HTTP on an in-repo `gh issue view`: same.
  assert.equal(
    decideAuto(verdict({ allowRule: "Read-Only HTTP", newSensitiveData: 0.55, scopeEscalation: 0.6 }), opts()).effect,
    "allow",
  )
})

test("precedence: the first matching step decides", () => {
  // The table is the contract; `decideAuto` implements it in this order. Each
  // row carries the answers that would flip the later steps, so a row only
  // passes while the earlier step still wins.
  const inside = { inside: true, known: true, written: false }
  const outside = { inside: false, known: true, written: false }
  const rows: Array<{
    step: string
    verdict: Partial<AutoVerdict>
    facts?: typeof inside
    action?: string
    options?: Options
    effect: "allow" | "ask" | "deny"
    rule?: string
  }> = [
    {
      step: "hard deny, over a boundary and an allow rule",
      verdict: { hardDenyRule: "Data Exfiltration", userForbids: 1, allowRule: "Local Operations", destructive: 1 },
      effect: "deny",
      rule: "Data Exfiltration",
    },
    {
      step: "a stated boundary, over an allow rule and destruction",
      verdict: { userForbids: 0.9, allowRule: "Local Operations", destructive: 0.9 },
      effect: "deny",
      rule: "User Boundary",
    },
    {
      step: "a soft rule, over scope and an allow rule it cannot clear",
      verdict: { softDenyRule: "Credential Printing", allowRule: "Local Operations", revealsCredentials: 0.9, scopeEscalation: 1 },
      effect: "deny",
      rule: "Credential Printing",
    },
    {
      step: "a soft rule cleared by an allow rule",
      verdict: { softDenyRule: "Git Destructive", allowRule: "Local Operations", destructive: 0.9 },
      effect: "allow",
      rule: "Local Operations",
    },
    {
      step: "a soft rule cleared by the user's quoted intent",
      verdict: { softDenyRule: "Git Destructive", userAuthorizes: 0.9 },
      effect: "allow",
    },
    {
      step: "an allow rule, over destruction, scope, and trust",
      verdict: { allowRule: "Local Operations", destructive: 0.9, scopeEscalation: 1, trustExternal: 1 },
      effect: "allow",
      rule: "Local Operations",
    },
    {
      step: "a credential, over an allow rule and scope",
      verdict: { allowRule: "Local Operations", revealsCredentials: 0.9, scopeEscalation: 0.9 },
      effect: "deny",
      rule: "Scope Escalation",
    },
    {
      step: "scope escalation, on a sensitive action",
      verdict: { scopeEscalation: 0.9, destructive: 0.9 },
      effect: "deny",
      rule: "Scope Escalation",
    },
    {
      step: "scope escalation, with nothing sensitive",
      verdict: { scopeEscalation: 0.9 },
      effect: "allow",
    },
    {
      step: "an outside read that carries new data: ask",
      verdict: { newSensitiveData: 0.9, readsContents: 1, category: "read" },
      facts: outside,
      effect: "ask",
      rule: "External",
    },
    {
      step: "an outside write that carries new data: deny",
      verdict: { newSensitiveData: 0.9, readsContents: 1, category: "write" },
      facts: outside,
      effect: "deny",
      rule: "External",
    },
    {
      step: "an outside action with nothing sensitive",
      verdict: { category: "read" },
      facts: outside,
      effect: "allow",
    },
    {
      step: "the severity backstop, when configured",
      verdict: { destructive: 0.98 },
      options: { denyDestructive: 0.97 },
      effect: "deny",
      rule: "Destructive",
    },
    {
      step: "nothing matches: allow",
      verdict: {},
      effect: "allow",
    },
  ]

  for (const row of rows) {
    const d = decideAuto(verdict(row.verdict), opts(row.options), row.action ?? "shell", row.facts)
    assert.equal(d.effect, row.effect, `${row.step}: ${d.reason}`)
    assert.equal(d.rule, row.rule, `${row.step}: rule`)
  }
})

test("describeAnswers names every answer, its rule labels, and any quoted intent", () => {
  const text = describeAnswers(
    verdict({
      category: "read",
      risk: 0.01,
      destructive: 0.02,
      revealsCredentials: 0.5,
      newSensitiveData: 0.4,
      readsContents: 1,
      hardDenyRule: "none",
      softDenyRule: "none",
      allowRule: "Local Operations",
      trustExternal: 0.1,
      userForbids: 0.2,
      userAuthorizes: 0.3,
      confidence: 0.9,
      boundaryQuote: "don't push",
      source: "openrouter",
    }),
  )

  assert.equal(
    text,
    'category=read risk=1% destructive=2% credentials=50% new-data=40% contents=100% scope=0% external=10% forbids=20% authorizes=30% confidence=90% hard=- soft=- allow=Local Operations via=openrouter boundary="don\'t push"',
  )
})

test("a generic allow rule does not clear a credential block", () => {
  // `cat .env` with both `Local Operations` and `Credential Printing` matched:
  // the credential answer keeps the allow entry from clearing the block.
  const d = decideAuto(
    verdict({ softDenyRule: "Credential Printing", allowRule: "Local Operations", revealsCredentials: 0.9 }),
    opts(),
  )
  assert.equal(d.effect, "deny")
  assert.equal(d.rule, "Credential Printing")
})

test("a hard rule is not cleared by an allow rule", () => {
  const d = decideAuto(verdict({ hardDenyRule: "Data Exfiltration", allowRule: "Local Operations" }), opts())
  assert.equal(d.effect, "deny")
  assert.equal(d.rule, "Data Exfiltration")
})

test("resolved trust overrides an external claim for local work", () => {
  // The model said external, but every path is inside the repo or scratch dir.
  const local = decideAuto(verdict({ trustExternal: 0.9, newSensitiveData: 0.7 }), opts(), "shell", {
    inside: true,
    known: true,
  })
  assert.equal(local.effect, "allow")
  // A network command is still judged by the model.
  assert.equal(
    decideAuto(verdict({ category: "network", trustExternal: 0.9, newSensitiveData: 0.7 }), opts(), "shell", {
      inside: true,
      known: true,
    }).rule,
    "External",
  )
})

test("an in-root read is not denied for escaping the task's scope", () => {
  // `head -30 /…/T/opencode/ting-research/...`: inside the scratch directory,
  // scope 73%, new data 59%, no allow rule.
  const d = decideAuto(verdict({ category: "read", scopeEscalation: 0.73, newSensitiveData: 0.59 }), opts(), "shell", {
    inside: true,
    known: true,
  })
  assert.equal(d.effect, "allow")
})

test("local work is not scope-checked even with no allow rule", () => {
  const inside = { inside: true, known: true }
  // `pytest -q scripts/tests/test_migrate_usaa.py`: allow=none, scope=65%, new data=60%.
  assert.equal(
    decideAuto(verdict({ category: "build", scopeEscalation: 0.65, newSensitiveData: 0.6 }), opts(), "shell", inside, "pytest -q scripts/tests/test_migrate_usaa.py").effect,
    "allow",
  )
  // A push still escalates: it leaves the machine.
  assert.equal(
    decideAuto(verdict({ category: "vcs", scopeEscalation: 0.7, newSensitiveData: 0.6 }), opts(), "shell", inside, "git push origin main").rule,
    "Scope Escalation",
  )
  // A destructive action still escalates.
  assert.equal(
    decideAuto(verdict({ category: "write", scopeEscalation: 0.7, destructive: 0.6 }), opts(), "shell", inside, "rm -rf build").rule,
    "Scope Escalation",
  )
  // So does a credential-shaped read: `cat .env` is not saved by location.
  assert.equal(
    decideAuto(verdict({ category: "read", scopeEscalation: 0.7, revealsCredentials: 0.9 }), opts(), "shell", inside, "cat .env").rule,
    "Scope Escalation",
  )
})

test("new sensitive data is an exposure only when it leaves the environment", () => {
  const inside = { inside: true, known: true }
  // `pytest` or `tail` over the ledger prints figures, but they stay local.
  assert.equal(
    decideAuto(verdict({ category: "build", scopeEscalation: 0.8, newSensitiveData: 0.95 }), opts(), "shell", inside).effect,
    "allow",
  )
  // The same data sent out is an exposure.
  assert.equal(
    decideAuto(verdict({ category: "network", scopeEscalation: 0.8, newSensitiveData: 0.95 }), opts(), "shell", inside).rule,
    "Scope Escalation",
  )
  // So is a push that carries it; a push of ordinary code is not.
  assert.equal(
    decideAuto(verdict({ category: "vcs", scopeEscalation: 0.8, newSensitiveData: 0.95 }), opts(), "shell", inside, "git push origin main").rule,
    "Scope Escalation",
  )
  assert.equal(
    decideAuto(verdict({ category: "vcs", scopeEscalation: 0.8, newSensitiveData: 0.1 }), opts(), "shell", inside, "git push origin feature").effect,
    "allow",
  )
})

test("a sensitive read outside the trusted roots asks instead of denying", () => {
  const outside = { inside: false, known: true }
  assert.equal(
    decideAuto(verdict({ category: "read", trustExternal: 0.85, newSensitiveData: 0.71 }), opts(), "shell", outside).effect,
    "ask",
  )
  // Scope escalation does not pre-empt the prompt for an outside read.
  assert.equal(
    decideAuto(verdict({ category: "read", trustExternal: 0.85, scopeEscalation: 0.8, newSensitiveData: 0.71 }), opts(), "shell", outside).effect,
    "ask",
  )
  // A write outside is still a deny.
  assert.equal(
    decideAuto(verdict({ category: "write", trustExternal: 0.85, newSensitiveData: 0.71 }), opts(), "shell", outside).rule,
    "External",
  )
})

test("a listing outside the roots that prints no contents is allowed", () => {
  const outside = { inside: false, known: true }
  // `ls ~/.local/share/opencode`: names only, new-data 53%, external 79%,
  // scope 87%. The plugin saw this as a sensitive outside read and asked.
  const listing = verdict({
    category: "read",
    trustExternal: 0.79,
    scopeEscalation: 0.87,
    newSensitiveData: 0.53,
    readsContents: 0.1,
  })
  assert.equal(decideAuto(listing, opts(), "shell", outside, "ls ~/.local/share/opencode").effect, "allow")
  // `ls -la ... | head; ls .../log | head`: new-data 61%, external 77%.
  assert.equal(
    decideAuto(
      verdict({ category: "read", trustExternal: 0.77, scopeEscalation: 0.85, newSensitiveData: 0.61, readsContents: 0.2 }),
      opts(),
      "shell",
      outside,
      "ls -la ~/.local/share/opencode | head -20; ls ~/.local/share/opencode/log | head",
    ).effect,
    "allow",
  )
  // Reading the contents of a database outside still asks (and #13 turns the
  // ask into a denial); the metadata gate must not clear a content read.
  const content = verdict({
    category: "read",
    trustExternal: 0.72,
    newSensitiveData: 0.73,
    readsContents: 0.9,
  })
  const read = decideAuto(content, opts(), "shell", outside, "sqlite3 -readonly ~/.local/share/opencode/opencode.db '.tables'")
  assert.equal(read.effect, "ask")
  assert.equal(read.rule, "External")
})

test("a tiered uncertain verdict allows local work and stops at the dangerous cases", () => {
  const inside = { inside: true, known: true }
  // `pytest`, `tail`, `echo` with new data 50-70%: the dominant false denial.
  assert.equal(decideAuto(verdict({ uncertain: true, category: "build", newSensitiveData: 0.6 }), opts(), "shell", inside).effect, "allow")
  assert.equal(decideAuto(verdict({ uncertain: true, category: "read", newSensitiveData: 0.7 }), opts(), "shell", inside).effect, "allow")
  // Destructive, credential-shaped, or privileged answers are not settled by location.
  assert.equal(decideAuto(verdict({ uncertain: true, category: "write", destructive: 0.6 }), opts(), "shell", inside).rule, "Uncertain")
  assert.equal(decideAuto(verdict({ uncertain: true, category: "read", revealsCredentials: 0.9 }), opts(), "shell", inside).rule, "Uncertain")
  assert.equal(decideAuto(verdict({ uncertain: true, category: "privileged" }), opts(), "shell", inside).rule, "Uncertain")
  // A network command with no read-only allow match stays denied; the repo's
  // own read-only API call is allowed.
  assert.equal(decideAuto(verdict({ uncertain: true, category: "network", newSensitiveData: 0.1 }), opts(), "shell", inside).rule, "Uncertain")
  assert.equal(
    decideAuto(verdict({ uncertain: true, category: "network", allowRule: "Read-Only HTTP" }), opts(), "shell", inside).effect,
    "allow",
  )
  // Outside the roots the facts cannot rescue it.
  assert.equal(decideAuto(verdict({ uncertain: true, category: "build", newSensitiveData: 0.6 }), opts(), "shell", { inside: false, known: true }).rule, "Uncertain")
  // A git command that rewrites state is not settled by location; a read is.
  assert.equal(decideAuto(verdict({ uncertain: true, category: "vcs" }), opts(), "shell", inside, "git status --short").effect, "allow")
  assert.equal(decideAuto(verdict({ uncertain: true, category: "vcs" }), opts(), "shell", inside, "git push origin main").rule, "Uncertain")
  // A process install can run arbitrary code, so it is not tiered-allow.
  assert.equal(decideAuto(verdict({ uncertain: true, category: "process" }), opts(), "shell", inside).rule, "Uncertain")
})

test("a tiered uncertain verdict asks when failMode is open", () => {
  const d = decideAuto(verdict({ uncertain: true, category: "build" }), opts({ failMode: "open" }), "shell", {
    inside: false,
    known: true,
  })
  assert.equal(d.effect, "ask")
  assert.equal(d.rule, "Uncertain")
})

test("an uncertain read outside the roots asks, never denies", () => {
  const outside = { inside: false, known: true }
  const d = decideAuto(verdict({ uncertain: true, category: "read" }), opts(), "shell", outside)
  assert.equal(d.effect, "ask")
  assert.equal(d.rule, "Uncertain")
})

test("a fallback may turn a Jev allow into a prompt, not a denial", () => {
  const jev = verdict({ confidence: 0.9 })
  const fallback = verdict({ softDenyRule: "Irreversible Local Destruction", confidence: 0.5, source: "fallback" })
  // Pinned to Jev's answers the fallback would deny `git status --short`.
  assert.equal(decideAuto(fallback, opts()).effect, "deny")
  assert.equal(reconcileFallback(fallback, jev, opts()).effect, "ask")
  // A verdict Jev itself denied is never lowered.
  const denied = verdict({ softDenyRule: "Git Destructive", confidence: 0.9 })
  assert.equal(reconcileFallback(fallback, denied, opts()).effect, "deny")
  // With no Jev answer to compare, the fallback stands.
  assert.equal(reconcileFallback(fallback, undefined, opts()).effect, "deny")
})

test("tiered is the auto-mode default and accept remains available", () => {
  assert.equal(opts().onUncertain, "tiered")
  assert.equal(normalize({}).onUncertain, "fallback")
  assert.equal(opts({ onUncertain: "accept" }).onUncertain, "accept")
})

test("the reason records the source", () => {
  assert.match(decideAuto(verdict({ destructive: 0.98, source: "fallback" }), opts()).reason, /via=fallback/)
})

test("authority raises a would-be allow to a prompt for an ask", () => {
  const out = autoAuthority("allow", { effect: "ask", rule: "External", reason: "read outside" }, { userAskRule: false, pausePrompts: false })
  assert.equal(out.effect, "ask")
  assert.match(out.message ?? "", /\[External\] read outside/)
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
  // Whether the action reads contents decides new-data exposure outside.
  assert.equal(
    belowConfidence(verdict({ trustExternal: 0.9, newSensitiveData: 0.9, readsContents: 0.5 }), 0.6, opts()),
    true,
  )
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

test("belowConfidence ignores an unsure hard rule when a confident soft rule already denies", () => {
  // `cat ~/.aws/credentials`: Credential Printing is certain, Data Exfiltration is not.
  const v = verdict({
    softDenyRule: "Credential Printing",
    confidence: 0.38,
    choiceConfidence: { hard_deny_rule: 0.38, soft_deny_rule: 0.99, allow_rule: 0.97 },
  })
  assert.equal(decideAuto(v, opts()).effect, "deny")
  assert.equal(belowConfidence(v, 0.6, opts()), false)
})

test("belowConfidence keeps an unsure rule choice that could flip the decision", () => {
  // An unsure hard rule on an otherwise clean action decides allow vs deny.
  const hard = { hard_deny_rule: 0.4, soft_deny_rule: 0.99, allow_rule: 0.99 }
  assert.equal(belowConfidence(verdict({ confidence: 0.4, choiceConfidence: hard }), 0.6, opts()), true)
  // An unsure soft rule matters when no exception would clear it.
  const soft = { hard_deny_rule: 0.99, soft_deny_rule: 0.4, allow_rule: 0.99 }
  assert.equal(belowConfidence(verdict({ softDenyRule: "Git Destructive", confidence: 0.4, choiceConfidence: soft }), 0.6, opts()), true)
  // An unsure allow exception matters once a soft rule matched.
  const allow = { hard_deny_rule: 0.99, soft_deny_rule: 0.99, allow_rule: 0.4 }
  assert.equal(belowConfidence(verdict({ softDenyRule: "Git Destructive", allowRule: "Local Operations", confidence: 0.4, choiceConfidence: allow }), 0.6, opts()), true)
  // A missing choice confidence is unsure, not certain.
  assert.equal(belowConfidence(verdict({ confidence: 0.99, choiceConfidence: {} }), 0.6, opts()), true)
})

test("belowConfidence judges a verdict without per-choice confidences by its overall confidence", () => {
  assert.equal(belowConfidence(verdict({ softDenyRule: "Credential Printing", confidence: 0.4 }), 0.6, opts()), true)
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

test("deleting a file the session wrote is not irreversible destruction", () => {
  // `rm .map-body.md`, written by the agent ~16s earlier: the rule is about
  // files that existed before the session, so it cannot apply.
  const inside = { inside: true, known: true }
  const writes = { ...inside, written: true }
  const destruction = verdict({ softDenyRule: "Irreversible Local Destruction", destructive: 0.9 })
  assert.equal(decideAuto(destruction, opts(), "shell", writes, "rm .map-body.md").effect, "allow")
  // Without the provenance fact the same verdict denies.
  assert.equal(decideAuto(destruction, opts(), "shell", inside, "rm .map-body.md").rule, "Irreversible Local Destruction")
  // And a pre-existing file stays denied.
  assert.equal(
    decideAuto(destruction, opts(), "shell", { ...inside, written: false }, "rm ledger/main.beancount").rule,
    "Irreversible Local Destruction",
  )
  // A user's renamed deletion rule keeps its own meaning.
  assert.equal(decideAuto(verdict({ softDenyRule: "Team Cleanup" }), opts(), "shell", writes, "rm x").rule, "Team Cleanup")
  // Provenance never clears a credential block.
  assert.equal(
    decideAuto(verdict({ softDenyRule: "Credential Printing", revealsCredentials: 0.9 }), opts(), "shell", writes, "rm .env").rule,
    "Credential Printing",
  )
})

test("a session-written delete is not stopped by an uncertain destructive answer", () => {
  const writes = { inside: true, known: true, written: true }
  const uncertain = verdict({ uncertain: true, category: "write", destructive: 0.9 })
  assert.equal(decideAuto(uncertain, opts(), "shell", writes, "rm .map-body.md").effect, "allow")
  // The same uncertain verdict on a pre-existing file stays blocked.
  assert.equal(
    decideAuto(uncertain, opts(), "shell", { inside: true, known: true }, "rm ledger/main.beancount").rule,
    "Uncertain",
  )
})

test("a boundary the user's words state denies even when the verdict is uncertain", () => {
  const inside = { inside: true, known: true }
  // A local `pdftotext` read is otherwise settled by location; the quoted
  // boundary is not the model's guess about intent.
  const quoted = verdict({
    uncertain: true,
    category: "read",
    userForbids: 0.9,
    boundaryQuote: "don't open the statement PDFs",
  })
  assert.equal(decideAuto(quoted, opts(), "shell", inside, "pdftotext statement.pdf -").rule, "User Boundary")
  // Without a quote the answer is a guess, and tiered lets the facts decide.
  assert.equal(
    decideAuto(verdict({ uncertain: true, category: "read", userForbids: 0.9 }), opts(), "shell", inside).effect,
    "allow",
  )
})

test("a session decision key separates sessions, states, and provenance", () => {
  assert.notEqual(sessionDecisionKey("s1", "state"), sessionDecisionKey("s2", "state"))
  assert.notEqual(sessionDecisionKey("s1", "state"), sessionDecisionKey("s1", "other"))
  // The same command is a different question once the session has written the file.
  assert.notEqual(sessionDecisionKey("s1", "state"), sessionDecisionKey("s1", "state", true))
  assert.equal(sessionDecisionKey("s1", "state", true), sessionDecisionKey("s1", "state", true))
})

test("the session memo is bounded and evicts the oldest decision first", () => {
  const decision = { effect: "allow" as const, reason: "ok" }
  const memo = new Map<string, typeof decision>()
  for (let i = 0; i < SESSION_DECISION_LIMIT; i++) rememberSessionDecision(memo, `k${i}`, decision)
  assert.equal(memo.size, SESSION_DECISION_LIMIT)
  // Re-remembering moves a key to the most recent end.
  rememberSessionDecision(memo, "k1", decision)
  rememberSessionDecision(memo, "new", decision)
  assert.equal(memo.size, SESSION_DECISION_LIMIT)
  assert.equal(memo.has("k0"), false)
  assert.equal(memo.has("k1"), true)
  assert.equal(memo.get("new"), decision)
})

test("matchPermissionRule honors wildcards and exact patterns", () => {
  assert.equal(matchPermissionRule("*", "anything"), true)
  assert.equal(matchPermissionRule("pytest *", "pytest -q"), true)
  assert.equal(matchPermissionRule("pytest *", "pytest"), false)
  assert.equal(matchPermissionRule("git status", "git status --short"), false)
  assert.equal(matchPermissionRule("git status*", "git status --short"), true)
})

test("a non-wildcard allow rule is the user's policy", () => {
  const rules = [
    { action: "*", resource: "*", effect: "allow" as const },
    { action: "shell", resource: "pytest *", effect: "allow" as const },
  ]
  assert.deepEqual(permissionPolicy(rules, "shell", ["pytest -q"]), { ask: false, allow: true, known: true })
})

test("the shipped wildcard base policy is not an allow rule", () => {
  const rules = [{ action: "*", resource: "*", effect: "allow" as const }]
  assert.deepEqual(permissionPolicy(rules, "shell", ["pytest -q"]), { ask: false, allow: false, known: true })
})

test("an ask rule is reported even when an allow rule also matches", () => {
  const rules = [
    { action: "shell", resource: "git push*", effect: "allow" as const },
    { action: "shell", resource: "git push*", effect: "ask" as const },
  ]
  assert.equal(permissionPolicy(rules, "shell", ["git push origin main"]).ask, true)
  assert.equal(permissionPolicy(rules, "shell", ["git push origin main"]).allow, true)
})

test("permission rules are matched per action and resource", () => {
  const rules = [{ action: "shell", resource: "pytest *", effect: "allow" as const }]
  assert.equal(permissionPolicy(rules, "read", ["pytest -q"]).allow, false)
  assert.equal(permissionPolicy(rules, "shell", ["npm test"]).allow, false)
  assert.equal(permissionPolicy(undefined, "shell", ["pytest -q"]).known, true)
})

test("a wildcard action rule applies to every action", () => {
  const rules = [{ action: "*", resource: "/etc/*", effect: "ask" as const }]
  assert.equal(permissionPolicy(rules, "read", ["/etc/hosts"]).ask, true)
  assert.equal(permissionPolicy(rules, "edit", ["/home/dev/notes.md"]).ask, false)
})

test("permissionPolicy tolerates a malformed ruleset", () => {
  assert.deepEqual(permissionPolicy({} as never, "shell", ["pytest -q"]), { ask: false, allow: false, known: true })
})
