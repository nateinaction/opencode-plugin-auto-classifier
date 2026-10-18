// Deterministic trust resolution for auto-mode.
//
// The trust boundary is a fact, not a probability: a path is either inside the
// working directory, the agent scratch directory, or a worktree of the same
// repository, or it is not. The classifier is still asked `trust_external` because a
// command can reach the network, but where the plugin can resolve the paths
// itself, it overrides the model rather than asking it to guess.
//
// Side-effect free except for the home directory lookup, so it is unit-testable.

import { homedir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"

export type TrustFacts = {
  /** True when every path the action names is inside a trusted root. */
  inside: boolean
  /** False when a path could not be resolved (a variable, a substitution). */
  known: boolean
}

/** Actions whose resource is a single path rather than a command line. */
const PATH_ACTIONS = new Set(["read", "edit", "write", "external_directory", "glob"])

/** Actions that reach the network by definition, whatever the path says. */
const OUTBOUND_ACTIONS = new Set(["webfetch", "websearch"])

/**
 * True when `path` is `root` or below it. Both must be absolute and resolved;
 * `..` is rejected as a prefix, while a name such as `..foo` is not.
 */
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Device files are not a trust boundary: `2>/dev/null` is not "outside". */
const DEVICE_PREFIX = "/dev/"

/** Words that name another command word rather than a data target. */
const WRAPPERS = new Set(["command", "env", "exec", "nohup", "sudo", "time"])

/** Shell operators that start the next command. */
const COMMAND_OPERATORS = new Set([";", "|", "&", "(", ")"])

/** Shell operators whose following word is a redirection target. */
const REDIRECT_OPERATORS = new Set(["<", ">"])

/** A word that sets an environment variable for the command after it. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

type ShellToken = { kind: "word" | "operator"; text: string }

/**
 * Split a shell command into words and operators. Quotes are boundaries (the
 * trust resolver only needs path-like words, not exact quoting); `=` stays
 * inside a word so `FOO=1` is one assignment and `--flag=/etc/x` can still be
 * read for its path.
 */
function tokenize(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let word = ""
  const flush = (): void => {
    if (word) tokens.push({ kind: "word", text: word })
    word = ""
  }
  for (const char of command) {
    if (/\s/.test(char) || char === '"' || char === "'" || char === "`") {
      flush()
    } else if (COMMAND_OPERATORS.has(char) || REDIRECT_OPERATORS.has(char)) {
      flush()
      tokens.push({ kind: "operator", text: char })
    } else {
      word += char
    }
  }
  flush()
  return tokens
}

/** The last path component, so `/usr/bin/sudo` is also a wrapper. */
function commandName(word: string): string {
  const slash = word.lastIndexOf("/")
  return slash === -1 ? word : word.slice(slash + 1)
}

/** True when `word` names a path rather than a bare word, flag, or URL. */
function pathLike(word: string): boolean {
  if (!word || word.startsWith(DEVICE_PREFIX)) return false
  // `~` alone is the home directory; other bare words are arguments.
  if (!word.includes("/") && word !== "~") return false
  if (word.includes("://")) return false
  return !word.startsWith("-")
}

/** The path a word names, looking past a `--flag=` or `VAR=` prefix. */
function pathOf(word: string): string | undefined {
  const equals = word.indexOf("=")
  const prefixed = equals !== -1 && (word.startsWith("-") || ASSIGNMENT.test(word))
  const path = prefixed ? word.slice(equals + 1) : word
  return pathLike(path) ? path : undefined
}

/**
 * Pull the data paths out of a shell command. The executable is a tool, not a
 * data target: `/nix/store/<hash>/bin/node eval/run.ts` runs inside the
 * working directory, while its script argument must still count. So the first
 * word of each simple command is skipped, along with the word after `env`,
 * `sudo`, `command`, and the like, and assignment words stay in command
 * position. Redirection targets are data, so they count.
 *
 * A bare word is not a path; a URL is not a local path. A token holding a
 * variable or a substitution cannot be resolved before running, so the caller
 * treats the whole action as unknown before calling this.
 */
export function extractPaths(command: string): string[] {
  const paths: string[] = []
  let expectCommand = true
  for (const token of tokenize(command)) {
    if (token.kind === "operator") {
      // A redirection names a data target, so its word is not a command word.
      expectCommand = COMMAND_OPERATORS.has(token.text)
      continue
    }
    const word = token.text
    if (expectCommand) {
      // An assignment is data, but the command after it is still the command.
      if (ASSIGNMENT.test(word)) {
        const assigned = pathOf(word)
        if (assigned) paths.push(assigned)
        continue
      }
      // A wrapper's own options are flags; the executable comes after them.
      if (word.startsWith("-")) continue
      if (WRAPPERS.has(commandName(word))) continue
      expectCommand = false
      continue
    }
    const path = pathOf(word)
    if (path) paths.push(path)
  }
  return paths
}

/** Expand a leading `~` and resolve a path against the working directory. */
export function resolvePath(path: string, base: string): string {
  if (path === "~") return resolve(homedir())
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? resolve(path) : resolve(base, path)
}

/**
 * Resolve the trust facts for an action. `roots` are absolute, already
 * canonicalised (the caller adds the scratch directory and repo worktrees).
 *
 * A shell command naming no path runs in the working directory, so it is
 * inside — unless it carries a variable or substitution, which could name any
 * path at run time. A URL is outside.
 *
 * Containment is lexical: a symlink inside a root that points outside it is
 * still treated as inside. The rules and the secret-exposure answer remain the
 * backstop for that case.
 */
export function resolveTrust(
  action: string,
  resource: string,
  roots: readonly string[],
  base: string,
): TrustFacts {
  const text = String(resource ?? "")
  if (OUTBOUND_ACTIONS.has(action)) return { inside: false, known: true }
  // A variable or substitution could name any path at run time, so the
  // command's location cannot be proved before it runs.
  if (text.includes("$") || text.includes("`")) return { inside: false, known: false }

  const paths = PATH_ACTIONS.has(action) ? (text.trim() ? [text.trim()] : []) : extractPaths(text)
  if (paths.length === 0) return { inside: true, known: true }

  const canonical = roots.map((root) => resolve(root))
  let inside = true
  for (const path of paths) {
    const abs = resolvePath(path, base)
    if (!canonical.some((root) => within(root, abs))) inside = false
  }
  return { inside, known: true }
}
