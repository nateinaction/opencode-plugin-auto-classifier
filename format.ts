// Pure formatting helpers for the TUI plugin.
//
// Kept separate from tui.ts so they can be unit-tested without importing the
// OpenCode/OpenTUI runtime (solid-js, JSX, @opencode/plugin/tui).

export type Entry = {
  at: number
  action: string
  resource: string
  effect: string
  reason: string
  via: string
  rule?: string
  /** The plugin mode that produced the entry ("classic" or "auto-mode"). */
  mode?: string
  /** The plugin build that produced the entry (short commit or version). */
  build?: string
}

export const LIMIT = 10
export const RESOURCE_MAX = 44

// Fallbacks in case a theme token is missing; these match typical OpenTUI palettes.
export const GREEN = "#50fa7b"
export const RED = "#ff5555"
export const ORANGE = "#ffb86c"

export type Feedback = {
  success?: { base?: string }
  error?: { base?: string }
  warning?: { base?: string }
}

/** Single-character marker for an effect: allow ".", ask "?", deny "x". */
export function mark(effect: string): string {
  if (effect === "deny") return "x"
  if (effect === "ask") return "?"
  return "."
}

/** Collapse whitespace and truncate to RESOURCE_MAX, appending an ellipsis. */
export function trim(text: string): string {
  const oneLine = (text ?? "").replace(/\s+/g, " ").trim()
  return oneLine.length > RESOURCE_MAX ? oneLine.slice(0, RESOURCE_MAX - 1) + "\u2026" : oneLine
}

/** `mode@build`, or whichever half is known; empty for entries from an unstamped build. */
export function stamp(entry: Entry): string {
  return [entry.mode, entry.build].filter(Boolean).join("@")
}

/**
 * Render one sidebar line: `mark action resource [rule] (fallback) {mode@build}`.
 * The stamp shows which plugin generation decided, since a long-lived server
 * can hold several.
 */
export function line(entry: Entry): string {
  // Only the fallback is flagged: the configured provider is the normal path,
  // whichever one it is.
  const suffix = entry.via === "fallback" ? " (fallback)" : ""
  const rule = entry.rule ? ` [${entry.rule}]` : ""
  const origin = stamp(entry)
  const tag = origin ? ` {${origin}}` : ""
  return `${mark(entry.effect)} ${entry.action} ${trim(entry.resource)}${rule}${suffix}${tag}`
}

/** Pick a colour for an effect, preferring semantic theme tokens. */
export function colorFor(effect: string, feedback: Feedback = {}): string {
  if (effect === "deny") return feedback?.error?.base ?? RED
  if (effect === "ask") return feedback?.warning?.base ?? ORANGE
  return feedback?.success?.base ?? GREEN
}
