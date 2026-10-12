import { test } from "node:test"
import assert from "node:assert/strict"
import { colorFor, GREEN, line, mark, ORANGE, RED, RESOURCE_MAX, trim, type Entry } from "../format.ts"

function entry(over: Partial<Entry> = {}): Entry {
  return { at: 0, action: "shell", resource: "ls", effect: "allow", reason: "", via: "jev", ...over }
}

test("mark maps effects to single characters", () => {
  assert.equal(mark("allow"), ".")
  assert.equal(mark("ask"), "?")
  assert.equal(mark("deny"), "x")
  assert.equal(mark("anything-else"), ".")
})

test("trim collapses whitespace", () => {
  assert.equal(trim("a\n  b\tc"), "a b c")
  assert.equal(trim("  padded  "), "padded")
})

test("trim truncates to RESOURCE_MAX with an ellipsis", () => {
  const long = "x".repeat(RESOURCE_MAX + 10)
  const result = trim(long)
  assert.equal(result.length, RESOURCE_MAX)
  assert.ok(result.endsWith("\u2026"))
})

test("trim leaves short text untouched", () => {
  const short = "x".repeat(RESOURCE_MAX)
  assert.equal(trim(short), short)
})

test("line renders mark, action and resource", () => {
  assert.equal(line(entry({ action: "shell", resource: "git status", effect: "allow" })), ". shell git status")
  assert.equal(line(entry({ action: "read", resource: ".env", effect: "ask" })), "? read .env")
  assert.equal(line(entry({ action: "edit", resource: "/etc/passwd", effect: "deny" })), "x edit /etc/passwd")
})

test("line appends the fallback source but not jev", () => {
  assert.equal(line(entry({ via: "fallback" })), ". shell ls (fallback)")
  assert.equal(line(entry({ via: "jev" })), ". shell ls")
  assert.equal(line(entry({ via: "" })), ". shell ls")
})

test("colorFor prefers semantic theme tokens", () => {
  const feedback = { success: { base: "#0f0" }, warning: { base: "#fa0" }, error: { base: "#f00" } }
  assert.equal(colorFor("allow", feedback), "#0f0")
  assert.equal(colorFor("ask", feedback), "#fa0")
  assert.equal(colorFor("deny", feedback), "#f00")
})

test("colorFor falls back to explicit colours", () => {
  assert.equal(colorFor("allow", {}), GREEN)
  assert.equal(colorFor("ask", {}), ORANGE)
  assert.equal(colorFor("deny", {}), RED)
  assert.equal(colorFor("allow"), GREEN)
})
