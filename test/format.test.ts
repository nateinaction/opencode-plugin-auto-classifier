import { test } from "node:test"
import assert from "node:assert/strict"
import { clip, colorFor, compact, GREEN, line, mark, ORANGE, RED, RESOURCE_MAX, stamp, trim, type Entry } from "../format.ts"

function entry(over: Partial<Entry> = {}): Entry {
  return { at: 0, action: "shell", resource: "ls", effect: "allow", reason: "", via: "jev", ...over }
}

test("compact drops undefined fields so the RPC schema accepts the entry", () => {
  const out = compact(entry({ rule: undefined, mode: "auto-mode", build: "f20b22d" }))
  assert.equal(Object.hasOwn(out, "rule"), false)
  assert.deepEqual(out, entry({ mode: "auto-mode", build: "f20b22d" }))
  assert.equal(compact(entry({ rule: "Git Destructive" })).rule, "Git Destructive")
})

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

test("clip keeps both ends of a long state and names what it dropped", () => {
  const state = `HEAD ${"a".repeat(4000)} TAIL`
  const out = clip(state, 1000)
  assert.ok(out.length <= 1000, `clipped to ${out.length} chars`)
  assert.ok(out.startsWith("HEAD "), "the request at the head survives")
  assert.ok(out.endsWith(" TAIL"), "the action at the tail survives")
  const reported = Number(out.match(/\[(\d+) chars elided\]/)?.[1])
  const kept = out.replace(/\u2026 \[\d+ chars elided\] \u2026/, "")
  assert.equal(reported, state.length - kept.length, "the marker reports the characters it dropped")
  for (const limit of [60, 101, 999]) assert.ok(clip(state, limit).length <= limit, `limit ${limit} is honored`)
})

test("clip leaves short text and a zero limit alone", () => {
  assert.equal(clip("short state", 100), "short state")
  assert.equal(clip("anything", 0), "anything")
})

test("line renders mark, action and resource", () => {
  assert.equal(line(entry({ action: "shell", resource: "git status", effect: "allow" })), ". shell git status")
  assert.equal(line(entry({ action: "read", resource: ".env", effect: "ask" })), "? read .env")
  assert.equal(line(entry({ action: "edit", resource: "/etc/passwd", effect: "deny" })), "x edit /etc/passwd")
})

test("line appends the fallback source but not the configured provider", () => {
  assert.equal(line(entry({ via: "fallback" })), ". shell ls (fallback)")
  assert.equal(line(entry({ via: "jev" })), ". shell ls")
  assert.equal(line(entry({ via: "openrouter" })), ". shell ls")
  assert.equal(line(entry({ via: "" })), ". shell ls")
})

test("line appends the matched rule when present", () => {
  assert.equal(line(entry({ resource: "git push --force", effect: "deny", rule: "Git Destructive" })), "x shell git push --force [Git Destructive]")
  assert.equal(line(entry({ via: "fallback", rule: "Data Exfiltration" })), ". shell ls [Data Exfiltration] (fallback)")
})

test("stamp joins mode and build, or keeps whichever is known", () => {
  assert.equal(stamp(entry({ mode: "auto-mode", build: "631a3b9" })), "auto-mode@631a3b9")
  assert.equal(stamp(entry({ mode: "classic" })), "classic")
  assert.equal(stamp(entry({ build: "v0.1.1" })), "v0.1.1")
  assert.equal(stamp(entry()), "")
})

test("line ends with the mode@build stamp when present", () => {
  assert.equal(line(entry({ mode: "classic", build: "5d24e63", effect: "ask" })), "? shell ls {classic@5d24e63}")
  assert.equal(
    line(entry({ via: "fallback", rule: "Git Destructive", effect: "deny", mode: "auto-mode", build: "631a3b9" })),
    "x shell ls [Git Destructive] (fallback) {auto-mode@631a3b9}",
  )
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
