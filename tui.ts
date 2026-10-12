// TUI plugin: renders the last few classifications from the server plugin in
// the right sidebar, colour-coded by effect:
//   allow -> green, deny -> red, ask -> orange.
//
// Data comes over the JevClassifierRpc defined in rpc.ts: one `recent` call for
// the history, then live `classified` events.
//
// This file is deliberately `.ts`, not `.tsx`, and imports host modules through
// OpenCode's `opentui:runtime-module:*` virtual ids instead of bare specifiers
// plus JSX. TUI plugins are installed under `node_modules`, where OpenTUI's
// Solid JSX transform is skipped, so bare JSX would be compiled with Bun's
// default React runtime and fail with `Cannot find package 'react'`. The
// virtual ids resolve to the host's singleton modules (solid-js,
// @opencode/plugin/tui, @opentui/solid/jsx-runtime) from any install location,
// and calling jsx()/jsxs() directly avoids emitting a bare jsx-runtime import.

import { Plugin } from "opentui:runtime-module:%40opencode%2Fplugin%2Ftui"
import { For, createSignal, onCleanup } from "opentui:runtime-module:solid-js"
import { jsx, jsxs } from "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime"
import { JevClassifierRpc } from "./rpc.ts"
import { colorFor, line, LIMIT, type Entry } from "./format.ts"

export default Plugin.define({
  id: "auto-classifier.tui",
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
      render: () =>
        jsxs("box", {
          flexDirection: "column",
          get children() {
            return [
              jsx("text", { get children() { return "Jev classifications" } }),
              jsx(For, {
                get each() {
                  return entries()
                },
                get children() {
                  return (entry: Entry) =>
                    jsx("text", {
                      get fg() {
                        return color(entry.effect)
                      },
                      get children() {
                        return line(entry)
                      },
                    })
                },
              }),
            ]
          },
        }),
    })
  },
})
