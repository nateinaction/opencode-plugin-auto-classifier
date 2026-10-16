import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_RULES, choiceCriteria, mergeRules, ruleKey } from "../rules.ts"

test("ruleKey takes the label before the first colon", () => {
  assert.equal(ruleKey("Git Destructive: Force pushing rewrites remote history."), "Git Destructive")
  assert.equal(ruleKey("  Spaced Label  : something"), "Spaced Label")
})

test("ruleKey falls back to a trimmed, bounded form when there is no colon", () => {
  assert.equal(ruleKey("just a bare rule"), "just a bare rule")
  assert.ok(ruleKey("x".repeat(120)).length <= 64)
})

test("choiceCriteria maps labels to full text and always offers none", () => {
  const rules = ["Git Destructive: force push", "IaC Destroy: terraform destroy"]
  const criteria = choiceCriteria(rules)
  assert.deepEqual(Object.keys(criteria), ["Git Destructive", "IaC Destroy", "none"])
  assert.equal(criteria["Git Destructive"], "Git Destructive: force push")
  assert.match(criteria.none, /no rule/i)
})

test("choiceCriteria disambiguates duplicate labels", () => {
  const criteria = choiceCriteria(["Dup: one", "Dup: two"])
  const keys = Object.keys(criteria).filter((k) => k !== "none")
  assert.equal(keys.length, 2)
  assert.notEqual(keys[0], keys[1])
})

test("mergeRules with no user rules returns the built-in defaults", () => {
  assert.deepEqual(mergeRules(undefined), DEFAULT_RULES)
  assert.deepEqual(mergeRules({}), DEFAULT_RULES)
})

test("mergeRules splices $defaults in place", () => {
  const merged = mergeRules({ soft_deny: ["Team rule: never touch prod", "$defaults"] })
  assert.equal(merged.soft_deny[0], "Team rule: never touch prod")
  assert.ok(merged.soft_deny.includes(DEFAULT_RULES.soft_deny[0]))
})

test("mergeRules replaces a list that omits $defaults, leaving other lists default", () => {
  const merged = mergeRules({ hard_deny: ["Only Rule: custom"] })
  assert.deepEqual(merged.hard_deny, ["Only Rule: custom"])
  assert.deepEqual(merged.soft_deny, DEFAULT_RULES.soft_deny)
  assert.deepEqual(merged.environment, DEFAULT_RULES.environment)
})
