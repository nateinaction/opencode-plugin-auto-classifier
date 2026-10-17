import { test } from "node:test"
import assert from "node:assert/strict"
import { buildLabel, commitFromLock } from "../build.ts"

const NAME = "opencode-plugin-auto-classifier"
const SHA = "631a3b9c30b95b508ba1a78a8d7a317ff4e001ad"

function lock(resolved: unknown) {
  return { packages: { [`node_modules/${NAME}`]: { version: "0.1.1", resolved } } }
}

test("commitFromLock reads the short commit npm resolved the plugin to", () => {
  assert.equal(commitFromLock(lock(`git+ssh://git@github.com/nateinaction/${NAME}.git#${SHA}`), NAME), "631a3b9")
})

test("commitFromLock returns undefined without a commit-pinned entry", () => {
  assert.equal(commitFromLock(lock("https://registry.npmjs.org/x/-/x-0.1.1.tgz"), NAME), undefined)
  assert.equal(commitFromLock(lock(42), NAME), undefined)
  assert.equal(commitFromLock({ packages: {} }, NAME), undefined)
  assert.equal(commitFromLock(undefined, NAME), undefined)
  assert.equal(commitFromLock(null, NAME), undefined)
})

test("buildLabel prefers the commit, then the version", () => {
  assert.equal(buildLabel("631a3b9", "0.1.1"), "631a3b9")
  assert.equal(buildLabel(undefined, "0.1.1"), "v0.1.1")
  assert.equal(buildLabel(undefined, undefined), "unknown")
  assert.equal(buildLabel(undefined, ""), "unknown")
})
