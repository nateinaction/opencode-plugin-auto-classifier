// TUI plugin: renders the last few classifications from the server plugin in
// the right sidebar, colour-coded by effect:
//   allow -> green, deny -> red, ask -> orange.
//
// Data comes over the JevClassifierRpc defined in rpc.ts: one `recent` call for
// the history, then live `classified` events.

import { Plugin } from "@opencode/plugin/tui"
import { For, createSignal, onCleanup } from "solid-js"
import { JevClassifierRpc } from "./rpc.ts"

type Entry = { at: number; action: string; resource: string; effect: string; reason: string; via: string }

const LIMIT = 10
const RESOURCE_MAX = 44

// Fallbacks in case a theme token is missing; these match typical OpenTUI palettes.
const GREEN = "#50fa7b"
const RED = "#ff5555"
const ORANGE = "#ffb86c"

function mark(effect: string): string {
  if (effect === "deny") return "x"
  if (effect === "ask") return "?"
  return "."
}

function trim(text: string): string {
  const oneLine = (text ?? "").replace(/\s+/g, " ").trim()
  return oneLine.length > RESOURCE_MAX ? oneLine.slice(0, RESOURCE_MAX - 1) + "\u2026" : oneLine
}

function line(entry: Entry): string {
  const suffix = entry.via && entry.via !== "jev" ? ` (${entry.via})` : ""
  return `${mark(entry.effect)} ${entry.action} ${trim(entry.resource)}${suffix}`
}

export default Plugin.define({
  id: "jev-classifier.tui",
  async setup(context: any) {
    const rpc = context.client.rpc(JevClassifierRpc)
    const [entries, setEntries] = createSignal<Entry[]>([])

    // Prefer semantic theme tokens; fall back to explicit colours.
    const feedback = context.theme?.text?.feedback ?? {}
    const colorFor = (effect: string): string => {
      if (effect === "deny") return feedback?.error?.base ?? RED
      if (effect === "ask") return feedback?.warning?.base ?? ORANGE
      return feedback?.success?.base ?? GREEN
    }

    const refresh = async () => {
      try {
        const result = await rpc.recent({})
        setEntries((result?.entries ?? []).slice(0, LIMIT))
      } catch {
        // server plugin may not be loaded yet; keep whatever we have
      }
    }
    await refresh()

    const stop = rpc.events.on("classified", (event: { data: Entry }) => {
      setEntries((prev) => [event.data, ...prev].slice(0, LIMIT))
    })
    onCleanup(() => stop())

    context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box flexDirection="column">
          <text>Jev classifications</text>
          <For each={entries()}>{(entry: Entry) => <text fg={colorFor(entry.effect)}>{line(entry)}</text>}</For>
        </box>
      ),
    })
  },
})
