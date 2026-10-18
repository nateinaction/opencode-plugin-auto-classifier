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

/**
 * Drop fields that are present but `undefined` (e.g. `rule` on an allow).
 * OpenCode validates RPC payloads against rpc.ts, where an optional field may
 * be absent but never `undefined`; one such entry fails the whole `recent`
 * call and every `classified` event.
 */
export function compact(entry: Entry): Entry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as Entry
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

/**
 * Truncate long text to at most `limit` characters, keeping its head and tail
 * and naming how much was dropped. A classified state ends with the
 * ENVIRONMENT and ACTION sections, so keeping only a prefix would log the
 * instructions and lose the action a reviewer is looking for.
 */
export function clip(text: string, limit: number): string {
  const value = text ?? ""
  if (limit <= 0 || value.length <= limit) return value
  // The marker itself has to fit inside the limit. The elided count is never
  // larger than the text, so its longest spelling bounds the marker's width.
  const marker = (elided: number): string => `\u2026 [${elided} chars elided] \u2026`
  const room = limit - marker(value.length).length
  if (room <= 1) return value.slice(0, limit)
  // The head carries the request and the instructions; the tail carries the
  // environment and the action under classification.
  const head = Math.ceil(room * 0.4)
  const tail = room - head
  return value.slice(0, head) + marker(value.length - room) + value.slice(value.length - tail)
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
