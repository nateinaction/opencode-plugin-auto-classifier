import { test } from "node:test"
import assert from "node:assert/strict"
import { deletesOnlySessionWrites, deleteTargets, shellWrites, tokenize } from "../provenance.ts"

const BASE = "/home/u/finances"

test("delete targets are the literal paths an rm names", () => {
  assert.deepEqual(deleteTargets("shell", "rm .map-body.md"), [".map-body.md"])
  assert.deepEqual(deleteTargets("shell", "rm -f 'notes copy.md' ledger/old.beancount"), ["notes copy.md", "ledger/old.beancount"])
  assert.deepEqual(deleteTargets("shell", "/bin/rm -rf dist"), ["dist"])
  // A `cd` moves the base a relative target is resolved against, so the
  // command is not provable.
  assert.deepEqual(deleteTargets("shell", "cd /tmp && rm build.log"), [])
  assert.deepEqual(deleteTargets("shell", "cd /tmp && rm /tmp/build.log"), [])
  // Redirection targets are written to, not deleted.
  assert.deepEqual(deleteTargets("shell", "rm out.log > /tmp/rm.log"), ["out.log"])
})

test("delete targets are unknown unless every command is a literal delete", () => {
  for (const command of [
    "git clean -fdx",
    "rm -rf $BUILD_DIR",
    'rm "$TMPDIR/map.md"',
    "rm `git ls-files -o`",
    "rm x && echo cleaned",
    "rm x; python3 cleanup.py",
    "rm x | tee log",
    "sudo rm x",
    "find . -name '*.pyc' -delete",
    "",
  ]) {
    assert.deepEqual(deleteTargets("shell", command), [], command)
  }
  // Only a shell command deletes anything.
  assert.deepEqual(deleteTargets("read", "rm -rf x"), [])
})

test("a delete is session-written only when every target was written", () => {
  const written = new Set([`${BASE}/.map-body.md`, `${BASE}/ledger/scratch.beancount`])
  assert.equal(deletesOnlySessionWrites("shell", "rm .map-body.md", written, BASE), true)
  assert.equal(
    deletesOnlySessionWrites("shell", "rm .map-body.md ledger/scratch.beancount", written, BASE),
    true,
  )
  // One pre-existing file keeps the rule: the session did not write it.
  assert.equal(deletesOnlySessionWrites("shell", "rm .map-body.md ledger/main.beancount", written, BASE), false)
  // An unknown target proves nothing.
  assert.equal(deletesOnlySessionWrites("shell", "rm $F", written, BASE), false)
  assert.equal(deletesOnlySessionWrites("shell", "git clean -fdx", written, BASE), false)
  // A file written in another session is not this session's.
  assert.equal(deletesOnlySessionWrites("shell", "rm .map-body.md", new Set(), BASE), false)
})

test("shell writes are redirection targets, tee outputs, and cp/mv destinations", () => {
  assert.deepEqual(shellWrites("echo hi > notes.md"), ["notes.md"])
  assert.deepEqual(shellWrites("echo hi >> notes.md"), ["notes.md"])
  assert.deepEqual(shellWrites("ls 2>/dev/null > out.txt"), ["out.txt"])
  assert.deepEqual(shellWrites("printf x | tee -a log.txt"), ["log.txt"])
  assert.deepEqual(shellWrites("cp notes.md copy.md"), ["copy.md"])
  assert.deepEqual(shellWrites("mv notes.md archive/notes.md"), ["archive/notes.md"])
  assert.deepEqual(shellWrites("cat ledger/main.beancount"), [])
  // Input redirection reads; its target is not a write.
  assert.deepEqual(shellWrites("python3 - <<'PY'\nprint(1)\nPY"), [])
})

test("tokenize keeps operators, strips quotes, and marks dynamic words", () => {
  const tokens = tokenize(`rm "a b" 'c d' $HOME/x && tail -1 < in.txt`)
  assert.deepEqual(
    tokens.map((token) => (token.kind === "op" ? token.value : `${token.value}${token.dynamic ? "*" : ""}`)),
    ["rm", "a b", "c d", "$HOME/x*", "&&", "tail", "-1", "<", "in.txt"],
  )
  // Long input is bounded rather than parsed forever.
  assert.ok(tokenize("echo " + "x ".repeat(10_000)).length <= 4096)
})
