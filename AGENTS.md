# Auto-classifier

Dev shell: `direnv allow` loads `flake.nix` (Node 24). Check: `npm run check` (typecheck + tests).

Architecture, configuration, and the auto-mode decision flow: `README.md`. Pure logic is unit-tested in `test/`; `index.ts` is the OpenCode runtime shell.

Changing an auto-mode question or precedence rule touches:
`jev.ts` (Jev questions + `parseAutoAnswers`), `verdict.ts` (fallback prompt + `parseAutoVerdict`),
`auto.ts` (`AutoVerdict` + `decideAuto`), `index.ts` (types/logging), `README.md` (question table +
decision flow), and `eval/auto.eval.ts`.
