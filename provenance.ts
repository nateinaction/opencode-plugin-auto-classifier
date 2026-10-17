// File provenance for auto-mode.
//
// `Irreversible Local Destruction` is defined as deleting files that existed
// before this session, so deleting a file the session itself created or
// modified is regenerable and the rule cannot apply to it. The plugin records
// the paths its tools wrote once they complete; this module reads that record
// and resolves an action's delete targets against it.
//
// Parsing is deliberately conservative: a command is only provably a delete of
// session-written files when every simple command in it is a delete of a
// literal path. A variable, a glob, a pipe into another writer, or any other
// command leaves the answer unknown, and an unknown answer keeps the rule.
// Side-effect free, so it is unit-testable.

import { basename } from "node:path"

import { resolvePath } from "./trust.ts"

/** Commands whose arguments are files to remove. */
const DELETE_COMMANDS = new Set(["rm", "unlink", "shred", "rmdir"])

/** Operators that end one simple command and start the next. */
const CONTROL_OPERATORS = new Set([";", "&&", "||", "|", "&", "\n"])

/** Bound on tokens examined, so a huge command cannot make parsing quadratic. */
const TOKEN_LIMIT = 4096

export type Token =
  | { kind: "word"; value: string; dynamic: boolean }
  | { kind: "op"; value: string }

/** A redirection with an optional fd number, kept as a single operator token. */
const REDIRECTION_PREFIX = /^(?:[12]|&)?(>>|>|<)/

/** Whitespace and operators that end a word. */
const OPERATOR_START = /[;&|()<>\\\n]/

/**
 * Split a shell command into words and operators. Quotes group a word and are
 * dropped. A word is `dynamic` when it holds a variable or substitution that
 * is not single-quoted, because its value is unknown before the command runs.
 *
 * This is not a shell parser: it is enough to find delete targets and writes,
 * and anything it cannot read stays dynamic (and so provable-free).
 */
export function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  const text = String(command ?? "")
  let word = ""
  let started = false
  let dynamic = false

  const flush = (): void => {
    if (!started) return
    tokens.push({ kind: "word", value: word, dynamic })
    word = ""
    started = false
    dynamic = false
  }

  for (let i = 0; i < text.length && tokens.length < TOKEN_LIMIT; i++) {
    const c = text[i]
    if (c === " " || c === "\t" || c === "\r") {
      flush()
      continue
    }
    if (c === "'" || c === '"') {
      // Scan to the matching quote. An unterminated quote runs to the end.
      const end = text.indexOf(c, i + 1)
      const body = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end)
      word += body
      started = true
      if (c === '"' && (body.includes("$") || body.includes("`"))) dynamic = true
      i = end === -1 ? text.length : end
      continue
    }
    if (c === "\\" && i + 1 < text.length) {
      word += text[i + 1]
      started = true
      i++
      continue
    }
    if (OPERATOR_START.test(c)) {
      flush()
      const rest = text.slice(i)
      const redirection = rest.match(REDIRECTION_PREFIX)?.[1]
      if (redirection) {
        tokens.push({ kind: "op", value: redirection })
        i += rest.indexOf(redirection) + redirection.length - 1
        continue
      }
      const two = rest.slice(0, 2)
      const op = two === "&&" || two === "||" ? two : c
      tokens.push({ kind: "op", value: op })
      if (two === "&&" || two === "||") i++
      continue
    }
    if (c === "$" || c === "`") dynamic = true
    word += c
    started = true
  }
  flush()
  return tokens
}

/** Split tokens into simple commands at the control operators. */
function simpleCommands(tokens: readonly Token[]): Token[][] {
  const commands: Token[][] = []
  let current: Token[] = []
  for (const token of tokens) {
    if (token.kind === "op" && CONTROL_OPERATORS.has(token.value)) {
      if (current.length) commands.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length) commands.push(current)
  return commands
}

type Args = { words: string[]; targets: string[] }

/**
 * Read a simple command's words, separating redirection targets (which are
 * written to, not passed to the command) from its arguments. `unknown` is set
 * when the command carries a dynamic word, so no path in it can be proved.
 */
function readCommand(tokens: readonly Token[]): Args & { unknown: boolean } {
  const words: string[] = []
  const targets: string[] = []
  let unknown = false
  let redirecting: "write" | "read" | undefined
  for (const token of tokens) {
    if (token.kind === "op") {
      if (token.value === ">" || token.value === ">>") redirecting = "write"
      else if (token.value === "<") redirecting = "read"
      continue
    }
    const word = token
    if (word.dynamic) unknown = true
    if (redirecting) {
      if (redirecting === "write") targets.push(word.value)
      redirecting = undefined
      continue
    }
    words.push(word.value)
  }
  return { words, targets, unknown }
}

/**
 * The literal paths a shell action deletes, as written. Empty when the command
 * is not a series of deletes of literal paths: `rm x && echo ok` yields
 * nothing, so a caller never reads a partial answer as proof.
 */
export function deleteTargets(action: string, resource: string): string[] {
  if (action !== "shell") return []
  const tokens = tokenize(resource)
  // A command past the token bound may hold a delete the parser never saw.
  if (tokens.length >= TOKEN_LIMIT) return []
  const commands = simpleCommands(tokens)
  if (commands.length === 0) return []
  const targets: string[] = []
  for (const command of commands) {
    const { words, unknown } = readCommand(command)
    const head = words[0] ? basename(words[0]) : ""
    if (!DELETE_COMMANDS.has(head) || unknown) return []
    for (const word of words.slice(1)) {
      if (word.startsWith("-") || word === "") continue
      targets.push(word)
    }
  }
  return targets
}

/**
 * True when the action deletes files, and every file it deletes is one this
 * session created or modified. Any unresolvable or unknown target is false.
 */
export function deletesOnlySessionWrites(
  action: string,
  resource: string,
  written: ReadonlySet<string>,
  base: string,
): boolean {
  const targets = deleteTargets(action, resource)
  if (targets.length === 0) return false
  return targets.every((target) => written.has(resolvePath(target, base)))
}

/**
 * The literal paths a shell command writes: redirection targets, `tee`
 * outputs, and `cp`/`mv` destinations. A dynamic word is skipped, since its
 * value cannot be resolved to the spelling a later delete uses.
 */
export function shellWrites(command: string): string[] {
  const written: string[] = []
  for (const tokens of simpleCommands(tokenize(command))) {
    const { words, targets } = readCommand(tokens)
    for (const target of targets) written.push(target)
    const head = words[0] ? basename(words[0]) : ""
    const args = words.slice(1).filter((word) => !word.startsWith("-") && word !== "")
    if (head === "tee") written.push(...args)
    if (head === "cp" || head === "mv" || head === "install") {
      if (args.length >= 2) written.push(args[args.length - 1])
    }
  }
  return written.filter((path) => path && !path.startsWith("/dev/"))
}
