# Auto-classifier

Dev shell: `direnv allow` loads `flake.nix` (Node 24). Check: `npm run check` (typecheck + tests).

Architecture, configuration, and the auto-mode decision flow: `README.md`. Pure logic is unit-tested in `test/`; `index.ts` is the OpenCode runtime shell.

Changing an auto-mode question or precedence rule touches:
`classifier.ts` (classifier questions + `parseAutoAnswers`), `verdict.ts` (fallback prompt + `parseAutoVerdict`),
`auto.ts` (`AutoVerdict` + `decideAuto`), `index.ts` (types/logging), `README.md` (question table +
decision flow), and `eval/auto.eval.ts`.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `nateinaction/opencode-plugin-auto-classifier`; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
