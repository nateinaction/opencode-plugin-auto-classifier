// Pure formatting helpers for the TUI plugin.
//
// Kept separate from tui.tsx so they can be unit-tested without importing the
// OpenCode/OpenTUI runtime (solid-js, JSX, @opencode/plugin/tui).

export type Entry = { at: number; action: string; resource: string; effect: string; reason: string; via: string }

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

/** Render one sidebar line: `mark action resource (via)`. */
export function line(entry: Entry): string {
  const suffix = entry.via && entry.via !== "jev" ? ` (${entry.via})` : ""
  return `${mark(entry.effect)} ${entry.action} ${trim(entry.resource)}${suffix}`
}

/** Pick a colour for an effect, preferring semantic theme tokens. */
export function colorFor(effect: string, feedback: Feedback = {}): string {
  if (effect === "deny") return feedback?.error?.base ?? RED
  if (effect === "ask") return feedback?.warning?.base ?? ORANGE
  return feedback?.success?.base ?? GREEN
}
