import { test } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"

import { extractPaths, resolvePath, resolveTrust } from "../trust.ts"

const BASE = "/home/u/finances"
const ROOTS = [BASE, "/var/folders/bg/x/T/opencode", "/home/u/finances-ting-rebook"]

test("a shell command that names no path is inside with no variable", () => {
  assert.deepEqual(resolveTrust("shell", "git status --short", ROOTS, BASE), { inside: true, known: true })
  assert.deepEqual(resolveTrust("shell", "echo ---", ROOTS, BASE), { inside: true, known: true })
  assert.deepEqual(resolveTrust("shell", "pytest -q scripts/tests/test_migrate_usaa.py", ROOTS, BASE), {
    inside: true,
    known: true,
  })
})

test("a relative path resolves against the working directory", () => {
  assert.deepEqual(resolveTrust("shell", "cat ledger/main.beancount", ROOTS, BASE), { inside: true, known: true })
  assert.deepEqual(resolveTrust("read", "src/x.ts", ROOTS, BASE), { inside: true, known: true })
})

test("an absolute path inside a trusted root is inside", () => {
  assert.deepEqual(resolveTrust("shell", `cat ${BASE}/ledger/main.beancount`, ROOTS, BASE), { inside: true, known: true })
  assert.deepEqual(resolveTrust("shell", "cat /var/folders/bg/x/T/opencode/ting-bills.md", ROOTS, BASE), {
    inside: true,
    known: true,
  })
  // A linked worktree of the same repository is trusted like the repo.
  assert.deepEqual(resolveTrust("read", "/home/u/finances-ting-rebook/scripts/*", ROOTS, BASE), {
    inside: true,
    known: true,
  })
})

test("a path outside every root is outside", () => {
  assert.deepEqual(resolveTrust("shell", "cat /etc/passwd", ROOTS, BASE), { inside: false, known: true })
  assert.deepEqual(resolveTrust("read", "../other-repo/notes.md", ROOTS, BASE), { inside: false, known: true })
  assert.deepEqual(resolveTrust("external_directory", "/Users/u/.local/share/opencode/log/*", ROOTS, BASE), {
    inside: false,
    known: true,
  })
})

test("one outside path makes the whole command outside", () => {
  assert.deepEqual(resolveTrust("shell", `cat ${BASE}/x && cat /etc/hosts`, ROOTS, BASE), { inside: false, known: true })
})

test("an unresolved variable or substitution is unknown, not inside", () => {
  assert.deepEqual(resolveTrust("shell", `python3 - "$TMPDIR/map125.md"`, ROOTS, BASE), { inside: false, known: false })
  assert.deepEqual(resolveTrust("shell", "cat $(pwd)/x", ROOTS, BASE), { inside: false, known: false })
  assert.deepEqual(resolveTrust("shell", "cat `pwd`/x", ROOTS, BASE), { inside: false, known: false })
})

test("a URL is outside by definition", () => {
  assert.deepEqual(resolveTrust("webfetch", "https://example.com/x", ROOTS, BASE), { inside: false, known: true })
  assert.deepEqual(resolveTrust("shell", "curl https://example.com/x", ROOTS, BASE), { inside: true, known: true })
})

test("a tilde expands to the home directory", () => {
  assert.deepEqual(resolveTrust("read", "~/.aws/credentials", ROOTS, BASE), { inside: false, known: true })
  assert.equal(resolvePath("~/x", BASE), `${homedir()}/x`)
})

test("device files do not make a command external", () => {
  assert.deepEqual(resolveTrust("shell", `cat ${BASE}/x 2>/dev/null`, ROOTS, BASE), { inside: true, known: true })
})

test("a bare tilde is the home directory", () => {
  assert.deepEqual(extractPaths("rm -rf ~"), ["~"])
  assert.deepEqual(resolveTrust("shell", "rm -rf ~", ROOTS, BASE), { inside: false, known: true })
})

test("extractPaths ignores URLs, flags, and bare words", () => {
  assert.deepEqual(extractPaths("gh issue view https://github.com/u/r/issues/1 --comments"), [])
  assert.deepEqual(extractPaths("cat docs/a.md"), ["docs/a.md"])
  assert.deepEqual(extractPaths("grep -rn pulls ledger/"), ["ledger/"])
})
