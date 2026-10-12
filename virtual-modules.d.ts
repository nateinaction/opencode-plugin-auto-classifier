// Ambient declarations for OpenCode's TUI host runtime modules.
//
// TUI plugins are installed under `node_modules`, where OpenTUI's Solid JSX
// transform is deliberately skipped. Importing these host singletons through
// the virtual `opentui:runtime-module:*` ids (see tui.ts) keeps the plugin on
// the host's module instances from any install location. The ids only exist
// inside the OpenCode TUI process, so declare them for type-checking without
// pulling in the peer packages.

declare module "opentui:runtime-module:solid-js"
declare module "opentui:runtime-module:%40opencode%2Fplugin%2Ftui"
declare module "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime"
