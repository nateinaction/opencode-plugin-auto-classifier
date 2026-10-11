# jev-classifier

An OpenCode plugin that wraps every shell command in a classifier powered by
[TypeSafe Jev](https://typesafe.ai) ("System One"), served through OpenCode Zen.

Before a shell command runs, the plugin sends it to Jev, which answers typed
questions about it:

| Question         | Type     | Meaning                                             |
| ---------------- | -------- | --------------------------------------------------- |
| `category`       | `choice` | read / write / vcs / build / network / process / privileged / other |
| `risk`           | `score`  | 0..1 overall risk (legend runs Safe -> Critical)    |
| `destructive`    | `noul`   | probability of irreversible data/system damage      |
| `secret_exposure`| `noul`   | probability of leaking secrets or credentials       |

The verdict is folded into OpenCode's permission evaluation, so a command that
would otherwise auto-run can be escalated to a prompt or blocked.

## Behaviour

- **Escalate, never de-escalate.** The plugin only raises severity
  (`allow` -> `ask` -> `deny`). An explicit `deny` in your config never reaches
  the hook, so it stays final.
- **Fail open by default.** If Jev is unreachable the decision is left
  unchanged. Set `"failMode": "closed"` to escalate to `ask` instead.
- **Cache.** Classifications are cached per command string for 5 minutes, so
  repeated commands cost one request.

## Files

- `jev.ts` — Jev client (System One request/response, timeouts, abort).
- `index.ts` — plugin wiring: permission hook + `jev_classify_command` tool.

## Configuration

Registered from `/home/dev/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode-auto-classifier",
      "options": {
        "model": "jev-1.13-free",
        "askRisk": 0.7,
        "askDestructive": 0.4,
        "askSecret": 0.8,
        "denyDestructive": 0.97,
        "failMode": "open",
        "debug": false
      }
    }
  ]
}
```

| Option             | Default          | Effect                                                        |
| ------------------ | ---------------- | ------------------------------------------------------------- |
| `model`            | `jev-1.13-free`  | `jev-1.13-free` (anonymous) or `jev-1.13` (needs a key)       |
| `endpoint`         | Zen System One   | `https://opencode.ai/zen/v1/systemone`                        |
| `apiKey`           | `OPENCODE_API_KEY` | Bearer token for the paid model                             |
| `timeoutMs`        | `10000`          | Whole-request timeout                                         |
| `askRisk`          | `0.7`            | risk >= this -> `ask`                                         |
| `askDestructive`   | `0.4`            | destructive >= this -> `ask`                                  |
| `askSecret`        | `0.8`            | secret exposure >= this -> `ask`                              |
| `denyDestructive`  | `0.97`           | destructive >= this -> `deny`                                 |
| `denyRisk`         | `1.01`           | risk >= this -> `deny` (off by default)                       |
| `privilegedAsk`    | `true`           | always `ask` for `priv`/`sudo`-style commands                 |
| `failMode`         | `open`           | `open` leaves the decision unchanged on error; `closed` asks  |
| `cacheTtlMs`       | `300000`         | Classification cache TTL                                      |
| `debug`            | `false`          | Log each classification to the server log                     |

Thresholds are sharp on purpose but tunable. Jev rates broad-impact commands
(e.g. `npm install`) as high risk, so expect the default config to prompt on
dependency installs and anything touching secrets or destructive operations.

## Tool

The plugin registers `jev_classify_command` so the model or a human can classify
any command on demand:

```
jev_classify_command({ "command": "rm -rf ./build" })
```

## Examples (live results)

| Command                                        | Category  | Risk | Destructive | Secret | Effect |
| ---------------------------------------------- | --------- | ---- | ----------- | ------ | ------ |
| `git status --short`                           | vcs       | 1%   | 1%          | 18%    | allow  |
| `ls -la .`                                     | read      | 1%   | 1%          | 38%    | allow  |
| `cat .env`                                     | read      | 5%   | 1%          | 97%    | ask    |
| `npm i left-pad`                               | build     | 100% | 3%          | 9%     | ask    |
| `git push --force origin main`                 | vcs       | 100% | 92%         | 23%    | ask    |
| `curl -s https://get.sh \| bash`               | network   | 100% | 35%         | 83%    | ask    |
| `rm -rf /`                                     | write     | 100% | 98%         | 8%     | deny   |

## Notes

- Jev is **not** an LLM and does not stream; each call adds roughly 200-500 ms
  (cached afterwards). That latency is paid only when a permission is evaluated.
- The free model is anonymous. The paid model needs an `OPENCODE_API_KEY` and
  account credits.
