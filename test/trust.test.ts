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

test("the executable is not a data target", () => {
  // A Nix dev shell runs `node` from an absolute store path; the script it
  // runs is still the data path and is inside the repo.
  assert.deepEqual(extractPaths("/nix/store/0n6wnabi4grafrkvnla0ip529rqp6yxp-nodejs-24.19.0/bin/node eval/auto.eval.ts"), [
    "eval/auto.eval.ts",
  ])
  assert.deepEqual(resolveTrust("shell", "node eval/auto.eval.ts", ROOTS, BASE), { inside: true, known: true })
  assert.deepEqual(
    resolveTrust("shell", "/nix/store/0n6wnabi4grafrkvnla0ip529rqp6yxp-nodejs-24.19.0/bin/node eval/auto.eval.ts", ROOTS, BASE),
    { inside: true, known: true },
  )
  // A script argument outside the roots is still outside.
  assert.deepEqual(
    resolveTrust("shell", "/nix/store/0n6wnabi4grafrkvnla0ip529rqp6yxp-nodejs-24.19.0/bin/node /etc/foo.js", ROOTS, BASE),
    { inside: false, known: true },
  )
})

test("wrappers leave the following executable out of the data paths", () => {
  const node = "/nix/store/hash-nodejs/bin/node"
  assert.deepEqual(resolveTrust("shell", `sudo ${node} eval/run.ts`, ROOTS, BASE), { inside: true, known: true })
  assert.deepEqual(resolveTrust("shell", `time ${node} eval/run.ts`, ROOTS, BASE), { inside: true, known: true })
  assert.deepEqual(resolveTrust("shell", `env FOO=1 ${node} eval/run.ts`, ROOTS, BASE), { inside: true, known: true })
  // A wrapper still does not hide an outside data argument.
  assert.deepEqual(resolveTrust("shell", `sudo ${node} /etc/run.ts`, ROOTS, BASE), { inside: false, known: true })
})

test("options and assignments do not hide a data path", () => {
  assert.deepEqual(resolveTrust("shell", "git -C /tmp status", ROOTS, BASE), { inside: false, known: true })
  assert.deepEqual(resolveTrust("shell", "ls --color=auto /etc", ROOTS, BASE), { inside: false, known: true })
  // An assignment is a data path, and `=` inside a plain path does not hide it.
  assert.deepEqual(resolveTrust("shell", "DEST=/etc/x cp a b", ROOTS, BASE), { inside: false, known: true })
  assert.deepEqual(resolveTrust("shell", `cat ${BASE}/a=b.md`, ROOTS, BASE), { inside: true, known: true })
})

test("a directory listing names the directory as a data path", () => {
  // `ls` and `find` print names, not contents, but the directory they name is
  // still a path outside the roots; whether that is sensitive is decided by
  // the verdict, not by trust.
  assert.deepEqual(resolveTrust("shell", "ls ~/.local/share/opencode", ROOTS, BASE), { inside: false, known: true })
  assert.deepEqual(resolveTrust("shell", "find ~/.local/share/opencode -maxdepth 3 -type d", ROOTS, BASE), {
    inside: false,
    known: true,
  })
})
