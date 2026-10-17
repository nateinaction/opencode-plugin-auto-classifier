// Deterministic trust resolution for auto-mode.
//
// The trust boundary is a fact, not a probability: a path is either inside the
// working directory, the agent scratch directory, or a worktree of the same
// repository, or it is not. Jev is still asked `trust_external` because a
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

/**
 * Pull path-like tokens out of a shell command. A bare word is not a path; a
 * URL is not a local path. A token holding a variable or a substitution cannot
 * be resolved before running, so the caller treats the whole action as unknown.
 */
export function extractPaths(command: string): string[] {
  const paths: string[] = []
  for (const raw of command.split(/[\s;|&()<>"'`=,]+/)) {
    const token = raw.trim()
    if (!token) continue
    if (token.startsWith(DEVICE_PREFIX)) continue
    // `~` alone is the home directory; other bare words are arguments.
    if (!token.includes("/") && token !== "~") continue
    if (token.includes("://")) continue
    if (token.startsWith("-")) continue
    paths.push(token)
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
