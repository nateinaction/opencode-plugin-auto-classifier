// The 2026-10-17 denial corpus: 63 false denials, one case each. These are the
// invariants that keep the corpus honest without calling the classifier: that every
// logged denial is represented, that its facts resolve the way the rules need,
// and that the user's own allowlist can still settle the reads a retro needs.
//
// The live evals (`npm run eval`, `npm run eval:fallback`) are what check the
// model's answers; this file checks the fixtures they run.

import { test } from "node:test"
import assert from "node:assert/strict"

import { permissionPolicy, type PermissionRule } from "../auto.ts"
import { CASES, caseAccepts, caseTrust, selectCases, type Case } from "../eval/cases.ts"
import { DENIAL_CASES } from "../eval/denials.ts"

const byName = (fragment: string): Case => {
  const found = DENIAL_CASES.filter((c) => c.name.includes(fragment))
  assert.equal(found.length, 1, `expected exactly one case matching ${JSON.stringify(fragment)}, found ${found.length}`)
  return found[0]
}

test("the corpus holds all 63 denials, each with its origin", () => {
  assert.equal(DENIAL_CASES.length, 63)
  assert.equal(new Set(DENIAL_CASES.map((c) => c.name)).size, DENIAL_CASES.length, "names are unique")
  for (const c of DENIAL_CASES) {
    assert.match(c.source ?? "", /^2026-10-17T\d\d:\d\d:\d\dZ /, `${c.name} names its log line`)
    assert.ok(c.userPrompt.trim(), `${c.name} carries the request the session was answering`)
  }
})

test("the corpus is part of what both live evals run", () => {
  assert.ok(DENIAL_CASES.every((c) => CASES.includes(c)), "every corpus case is selected by both evals")
  assert.equal(selectCases("21:23:53").length, 1)
  assert.equal(selectCases("06:30:33")[0]?.expect, "allow")
})

test("a linked worktree of the repository is inside the trust boundary", () => {
  for (const fragment of ["21:10:27", "21:10:29", "21:10:53"]) {
    const c = byName(fragment)
    const trust = caseTrust(c)
    assert.equal(trust.known, true, `${c.name} resolves`)
    assert.equal(trust.inside, true, `${c.name} is inside the repo's worktree`)
  }
})

test("the scratch directory is inside the trust boundary", () => {
  for (const fragment of ["03:53:52", "03:54:12", "06:13:13", "06:13:15", "06:13:28"]) {
    const c = byName(fragment)
    assert.equal(caseTrust(c).inside, true, `${c.name} is inside the scratch directory`)
  }
})

test("an in-repo command is inside; a read of the OpenCode log is not", () => {
  const inside = [
    "21:15:44",
    "21:23:53",
    "21:24:02",
    "21:30:05 import the USAA",
    "21:30:05 import the Apple",
    "06:22:03",
    "06:36:05",
    "07:26:48",
  ]
  for (const fragment of inside) {
    const c = byName(fragment)
    assert.equal(caseTrust(c).inside, true, `${c.name} is in-repo`)
  }
  for (const fragment of ["21:42:27", "21:42:32", "21:42:35", "21:42:42 awk", "21:36:42", "21:36:48"]) {
    const c = byName(fragment)
    assert.equal(caseTrust(c).inside, false, `${c.name} reaches outside the roots`)
  }
})

test("a session-written delete resolves as regenerable", () => {
  const c = byName("07:26:48")
  assert.equal(caseTrust(c).written, true, "the session wrote .map-body.md")
})

test("every denial in the corpus is a false denial: the rules allow or ask, never deny", () => {
  const denied = DENIAL_CASES.filter((c) => c.expect === "deny" || (c.alsoAccept ?? []).includes("deny"))
  assert.deepEqual(denied.map((c) => c.name), [], "no case accepts a denial")
})

test("the six reads outside the roots accept both the prompt and the allow", () => {
  // A content read outside the trusted roots asks when the classifier rates its
  // contents as new sensitive data; the log is the session's own decisions, so
  // the classifier often rates it as not-new and the same rules allow. Either
  // clears the regression.
  const review = DENIAL_CASES.filter((c) => c.expect === "ask" && (c.alsoAccept ?? []).includes("allow"))
  assert.equal(review.length, 6)
  for (const c of review) {
    assert.equal(caseAccepts(c, "ask"), true, `${c.name} accepts a prompt`)
    assert.equal(caseAccepts(c, "allow"), true, `${c.name} accepts an allow`)
    assert.equal(caseAccepts(c, "deny"), false, `${c.name} never accepts a denial`)
  }
})

test("a listing is judged by location alone: `ls` outside the roots is allowed", () => {
  // The listing cases are allow-cases in the corpus: `ls` prints names, not
  // contents, so the outside location is not an exposure.
  assert.equal(caseTrust(byName("21:37:01")).inside, false)
  assert.equal(byName("21:37:01").expect, "allow")
  assert.equal(caseTrust(byName("21:36:58")).inside, true)
})

test("the retro's allowlist also settles a *sensitive* read of the session", () => {
  // Issue #2, retro item 3: allow the retro to read the session it reviews.
  // Before P0/P1 fix 9 an allow entry could not clear a sensitivity gate; these
  // rules are the user's own policy, so `permissionPolicy` must report them even
  // when the read would otherwise ask.
  const allowlist: PermissionRule[] = [
    { action: "shell", resource: "tail *", effect: "allow" },
    { action: "shell", resource: "grep *", effect: "allow" },
    { action: "shell", resource: "awk *", effect: "allow" },
    { action: "shell", resource: "head *", effect: "allow" },
    { action: "shell", resource: "sqlite3 *", effect: "allow" },
    { action: "external_directory", resource: "~/.local/share/opencode/*", effect: "allow" },
  ]
  const reads: Array<[string, string]> = [
    ["shell", "tail -200 ~/.local/share/opencode/log/auto-classifier.log"],
    ["shell", "grep -n deny ~/.local/share/opencode/log/auto-classifier.log"],
    ["shell", "sqlite3 ~/.local/share/opencode/opencode.db '.schema session'"],
    ["external_directory", "~/.local/share/opencode/log/*"],
  ]
  for (const [action, resource] of reads) {
    const policy = permissionPolicy(allowlist, action, [resource])
    assert.equal(policy.known, true)
    assert.equal(policy.allow, true, `${resource} is covered by the user's allow rule`)
    assert.equal(policy.ask, false, `${resource} is not a prompt`)
  }
  // The base policy is not an allow rule, so it cannot settle anything.
  assert.equal(permissionPolicy([{ action: "*", resource: "*", effect: "allow" }], "shell", ["tail -200 x"]).allow, false)
})
