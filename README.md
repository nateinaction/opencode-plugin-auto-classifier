# auto-classifier

An OpenCode plugin that wraps every shell command, file read, and file edit in a
classifier powered by [TypeSafe Jev](https://typesafe.ai) ("System One"), served
through OpenCode Zen or, with `"provider": "openrouter"`, through
[OpenRouter](https://openrouter.ai)'s Decisions API. Both serve the same model
API, so the plugin behaves the same either way.

Before a shell command runs — or a file is read or edited — the plugin sends the
resource to Jev, which answers typed questions about it:

| Question         | Type     | Meaning                                             |
| ---------------- | -------- | --------------------------------------------------- |
| `category`       | `choice` | read / write / vcs / build / network / process / privileged / other |
| `risk`           | `score`  | 0..1 overall risk (legend runs Safe -> Critical)    |
| `destructive`    | `noul`   | probability of irreversible data/system damage      |
| `secret_exposure`| `noul`   | probability of leaking secrets or credentials       |

The verdict is folded into OpenCode's permission evaluation, so an action that
would otherwise auto-run can be escalated to a prompt or blocked. Escalations
are labelled `[auto-classifier] ...` in the permission prompt so their origin is
unambiguous.

## Installation

The plugin is a normal OpenCode plugin package: the server half is exported at
`.` and the TUI sidebar half at `./tui`. Install it straight from Git — no npm
publish required.

```sh
opencode plugin add github:schemaitat/opencode-plugin-auto-classifier
```

That clones the repo, installs it, and registers it. Verify and update it with:

```sh
opencode plugin list
opencode plugin check
opencode plugin update opencode-plugin-auto-classifier
```

To pin a revision, append a branch, tag, or full commit hash:

```sh
opencode plugin add github:schemaitat/opencode-plugin-auto-classifier#v0.1.0
opencode plugin add git+ssh://git@github.com/schemaitat/opencode-plugin-auto-classifier.git#main
```

Or add it to `opencode.json(c)` by hand. Relative, absolute, and `file://`
paths work too, which is handy for local development:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:schemaitat/opencode-plugin-auto-classifier"
  ]
}
```

### Requirements

- A paid Jev (System One) key for the selected provider, or the LLM fallback
  (see [Configuration](#configuration)): an inference-scoped OpenCode Console
  key in `OPENCODE_API_KEY` (default `jev` provider), or an OpenRouter key in
  `OPENROUTER_API_KEY` (`openrouter` provider). Without a key the plugin fails
  open by default.
- The TUI sidebar half imports OpenCode's bundled OpenTUI/`solid-js` host
  modules through their runtime ids (`opentui:runtime-module:*`), so it works
  from a `node_modules` install without shipping its own copies. It is optional;
  the server half works alone.

## What it covers

| Permission action | Resource          | State sent to Jev                                |
| ----------------- | ----------------- | ------------------------------------------------ |
| `shell`           | command string    | the command text itself                          |
| `read`            | file path         | `Read the contents of the file at: <path>`       |
| `edit`            | file path         | `Write to or modify the file at: <path>` (edit/write/patch) |

Other actions are ignored.

## Behaviour

- **Escalate, never de-escalate.** The plugin only raises severity
  (`allow` -> `ask` -> `deny`). An explicit `deny` in your config never reaches
  the hook, so it stays final.
- **Action-aware rules.** `shell` uses the general risk score, plus destructive
  and secret signals. `read` only escalates on secret exposure, and `edit` only
  on destruction/secrets — because "risk" is ~100% for *any* write and would
  otherwise prompt on every source edit.
- **Configurable target.** `escalateTo` picks what a triggered threshold becomes:
  `"ask"` (prompt, default) or `"deny"` (allow-or-deny, no prompts).
- **Fail open by default.** If Jev is unreachable the decision is left
  unchanged. Set `"failMode": "closed"` to escalate to `ask` instead.
- **LLM fallback.** When Jev fails (rate limit, timeout, network), the plugin
  re-classifies through `ctx.generate.text` using a normal model
  (`opencode-go/deepseek-v4.1-flash` by default), asking it for the same JSON
  verdict. This runs over OpenCode's own provider transport, so it needs no
  extra key. Disable with `"fallback": false`. If both fail, `failMode` decides.
- **Cache.** Classifications are cached per state string for 5 minutes, so
  repeated commands/paths cost one request.

## Files

- `index.ts` — server plugin: permission hook + `jev_classify_command` tool.
- `jev.ts` — Jev client (System One request/response, timeouts, abort).
- `verdict.ts` — LLM fallback prompt and verdict parser, unit-tested.
- `decide.ts` — pure decision logic (thresholds, escalation, `describe`), unit-tested.
- `format.ts` — pure sidebar formatting helpers, unit-tested.
- `rpc.ts` — RPC shared with the TUI plugin (`recent` method, `classified` event).
- `tui.ts` — TUI plugin: renders the last classifications in the sidebar.
- `virtual-modules.d.ts` — ambient types for the `opentui:runtime-module:*` host ids.
- `package.json` — `exports` map: `.` → `index.ts`, `./tui` → `tui.ts`.

## Sidebar

The TUI plugin (`tui.ts`) appends a list of the most recent classifications to
the right sidebar (`sidebar.content`). Each line is colour-coded by effect:

| Effect | Colour | Mark |
| ------ | ------ | ---- |
| allow  | green  | `.`  |
| ask    | orange | `?`  |
| deny   | red    | `x`  |

Colours come from the theme's feedback tokens
(`text.feedback.success/error/warning.base`) with explicit hex fallbacks. Lines
read `mark action resource`, with `(fallback)` appended when the DeepSeek
fallback produced the verdict.

Data flows over `rpc.ts`: the server plugin keeps the last 25 entries and emits
a `classified` event per decision; the TUI calls `recent` once, then subscribes
for live updates.


## Configuration

The package name (or a local path) goes in the `plugins` array. Options are
passed through the object form:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:schemaitat/opencode-plugin-auto-classifier",
      "options": {
        "model": "jev-1.13",
        "apiKey": "oc_sk_...",
        "escalateTo": "deny",
        "askRisk": 1.01,
        "askDestructive": 0.85,
        "askSecret": 0.8,
        "escalate": { "edit": { "destructive": 0.5 } },
        "failMode": "open",
        "debug": false
      }
    }
  ]
}
```

| Option             | Default          | Effect                                                        |
| ------------------ | ---------------- | ------------------------------------------------------------- |
| `provider`         | `jev`            | where Jev is served: `jev` (OpenCode Zen) or `openrouter`     |
| `model`            | per provider     | `jev-1.13` (jev) / `typesafe/jev-1.14` (openrouter)           |
| `endpoint`         | per provider     | Zen System One / OpenRouter Decisions (`/api/alpha/decisions`) |
| `apiKey`           | per provider     | `OPENCODE_API_KEY` (`oc_sk_...`) / `OPENROUTER_API_KEY`       |
| `timeoutMs`        | `10000`          | Whole-request timeout                                         |
| `askRisk`          | `0.7`            | risk >= this -> escalate (`shell` only)                       |
| `askDestructive`   | `0.4`            | destructive >= this -> escalate                               |
| `askSecret`        | `0.8`            | secret exposure >= this -> escalate                           |
| `escalateTo`       | `ask`            | what escalation resolves to: `ask` or `deny`                  |
| `escalate`         | `{}`             | per-action threshold overrides, e.g. `{"edit":{"destructive":0.5}}` |
| `denyDestructive`  | `0.97`           | destructive >= this -> `deny`                                 |
| `denySecret`       | `1.01`           | secret exposure >= this -> `deny` (off by default)            |
| `denyRisk`         | `1.01`           | risk >= this -> `deny` (off by default, `shell` only)         |
| `privilegedAsk`    | `true`           | always escalate `priv`/`sudo`-style commands                  |
| `fallback`         | `true`           | use `ctx.generate.text` when Jev fails                        |
| `fallbackModel`    | `opencode-go/deepseek-v4.1-flash` | `provider/model` used for the fallback       |
| `failMode`         | `open`           | `open` leaves the decision unchanged on error; `closed` escalates |
| `cacheTtlMs`       | `300000`         | Classification cache TTL                                      |
| `debug`            | `false`          | Log each classification to the server log                     |

There are two tiers: the `deny*` thresholds always deny, and the `ask*`
thresholds escalate. `escalateTo` decides what an escalation becomes, so
`"escalateTo": "deny"` gives an **allow-or-deny** policy with no prompts.

`escalate` overrides thresholds per action. This matters because scores differ
by action: an ordinary `echo > file` and `edit /etc/passwd` both score ~60%
destructive, so the edit tool needs a lower threshold to be caught.

```jsonc
{
  "escalateTo": "deny",
  "askRisk": 1.01,                     // risk alone never denies (writes score ~100%)
  "askDestructive": 0.85,
  "askSecret": 0.8,
  "escalate": { "edit": { "destructive": 0.5 } },
  "privilegedAsk": true
}
```

## Tool

The plugin registers `jev_classify_command` so the model or a human can classify
any command on demand:

```
jev_classify_command({ "command": "rm -rf ./build" })
```

## Examples (live results)

| Action | Resource                         | Category | Risk | Destructive | Secret | Effect |
| ------ | -------------------------------- | -------- | ---- | ----------- | ------ | ------ |
| shell  | `git status --short`             | vcs      | 1%   | 1%          | 18%    | allow  |
| shell  | `cat .env`                       | read     | 5%   | 1%          | 97%    | ask    |
| shell  | `git push --force origin main`   | vcs      | 100% | 92%         | 23%    | ask    |
| shell  | `rm -rf /`                       | write    | 100% | 98%         | 8%     | deny   |
| read   | `~/.secrets.zshrc`               | read     | 13%  | 1%          | 93%    | ask    |
| read   | `/home/dev/.zshrc.secrets`       | read     | 23%  | 1%          | 96%    | ask    |
| read   | `/home/dev/opencode.jsonc`       | read     | 1%   | 1%          | 30%    | allow  |
| edit   | `/etc/passwd`                    | write    | 100% | 61%         | 15%    | ask    |
| edit   | `index.ts` (source)              | write    | 100% | 29%         | 30%    | allow  |

## Notes

- Jev is **not** an LLM and does not stream; each call adds roughly 200-500 ms
  (cached afterwards). That latency is paid only when a permission is evaluated.
- Only two paths exist: **paid Jev** or the **LLM fallback**. There is no free
  model default.
- The paid model needs an inference-scoped Console API key (`oc_sk_...`) passed
  as `apiKey` or `OPENCODE_API_KEY`. A key without model permission returns
  `403 "This API key can't call models"`, and the Console OAuth token is
  rejected by the zen endpoint (`401 "Invalid API key."`).
- With `"provider": "openrouter"`, Jev is called through OpenRouter's Decisions
  API (`https://openrouter.ai/api/alpha/decisions`) with the same typed
  questions, using an OpenRouter key from `apiKey` or `OPENROUTER_API_KEY`. Each
  provider reads only its own key. The Decisions API is an **alpha** endpoint,
  so its path or shape may change. Set `"model": "~typesafe/jev-latest"` to
  follow new Jev releases instead of pinning one.
- The DeepSeek fallback is a normal LLM call, so it is slower and consumes the
  fallback model's quota; it only runs after a Jev failure.

## Development

The pure logic is split out so it can be tested without the OpenCode runtime:
`decide.ts` (thresholds and escalation rules), `format.ts` (sidebar rendering),
`jev.ts` (the System One client, tested with an injected `fetch`), and
`verdict.ts` (the fallback prompt and parser).

```sh
npm test          # node --test, no dependencies
npm run test:watch
```

Tests use Node's built-in test runner and Node's native TypeScript type
stripping, so there is nothing to build and no dev dependencies to install.

## Fallback

```
paid Jev (System One)  --429/timeout/error-->  ctx.generate.text(fallbackModel)
```

The fallback prompt asks for strict JSON
(`{"category":…,"risk":0..1,"destructive":0..1,"secret_exposure":0..1}`), which
is parsed and fed through the same `decide()` rules. A verdict with a missing
or non-numeric score counts as a failure, leaving the decision to `failMode`,
rather than as a score of 0. The action is sent JSON-encoded and marked as
untrusted data, so text inside a command cannot pose as classifier
instructions. The resulting decision is
tagged `via=fallback` so it is visible in debug logs and permission messages.
