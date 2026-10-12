// TUI plugin: renders the last few classifications from the server plugin in
// the right sidebar, colour-coded by effect:
//   allow -> green, deny -> red, ask -> orange.
//
// Data comes over the JevClassifierRpc defined in rpc.ts: one `recent` call for
// the history, then live `classified` events.

import { Plugin } from "@opencode/plugin/tui"
import { For, createSignal, onCleanup } from "solid-js"
import { JevClassifierRpc } from "./rpc.ts"
import { colorFor, line, LIMIT, type Entry } from "./format.ts"

export default Plugin.define({
  id: "jev-classifier.tui",
  async setup(context: any) {
    const rpc = context.client.rpc(JevClassifierRpc)
    const [entries, setEntries] = createSignal<Entry[]>([])

    // Prefer semantic theme tokens; fall back to explicit colours.
    const feedback = context.theme?.text?.feedback ?? {}
    const color = (effect: string): string => colorFor(effect, feedback)

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
          <For each={entries()}>{(entry: Entry) => <text fg={color(entry.effect)}>{line(entry)}</text>}</For>
        </box>
      ),
    })
  },
})
