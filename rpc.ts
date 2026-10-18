// RPC shared between the server plugin (index.ts) and the TUI plugin (tui.ts).
//
// The server records every classification it makes and emits a `classified`
// event; the TUI reads `recent` once and then subscribes to live events to
// render a rolling list in the sidebar.

import { Rpc } from "@opencode/plugin/rpc"

const entrySchema = {
  type: "object",
  properties: {
    at: { type: "number" },
    action: { type: "string" },
    resource: { type: "string" },
    effect: { type: "string" },
    reason: { type: "string" },
    via: { type: "string" },
    rule: { type: "string" },
    mode: { type: "string" },
    build: { type: "string" },
  },
  required: ["at", "action", "resource", "effect", "reason", "via"],
  additionalProperties: false,
} as const

export const ClassifierRpc = Rpc.define({
  id: "auto-classifier",
  methods: {
    recent: {
      // No meaningful arguments; an empty object keeps the call shape uniform.
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { entries: { type: "array", items: entrySchema } },
        required: ["entries"],
        additionalProperties: false,
      },
    },
  },
  events: {
    classified: { schema: entrySchema },
  },
})
