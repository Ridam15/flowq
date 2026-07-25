<!--
Thanks for contributing to FlowQ!

Before opening, please confirm:
- An issue exists for non-trivial changes (bug fixes < 20 LOC are fine without).
- You ran `pnpm typecheck && pnpm lint && pnpm test` locally and it passed.
- You added or updated tests for behaviour changes.
-->

## Summary

<!-- One paragraph: what does this PR do, and why? -->

Closes #

## Changes

- <!-- bulleted list of behaviour-visible changes -->
-

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds capability)
- [ ] Breaking change (fix or feature that would require migration)
- [ ] Documentation only
- [ ] Build / CI / tooling

## Affected packages

- [ ] `@flowq/api`
- [ ] `@flowq/worker`
- [ ] `@flowq/sdk`
- [ ] `@flowq/dashboard`
- [ ] `@flowq/loadtest`
- [ ] `infra/k8s` / `infra/helm` / Dockerfiles
- [ ] Top-level docs

## Test plan

<!-- How did you verify this works? Be specific. -->

```bash
# Commands you ran and their relevant output.
```

- [ ] Unit tests pass (`pnpm test`)
- [ ] Lint + typecheck pass (`pnpm lint && pnpm typecheck`)
- [ ] (If touching infra) `helm lint ./infra/helm/flowq` passes
- [ ] (If user-visible) manually validated against `docker compose up -d`
- [ ] (If perf-sensitive) re-ran the relevant scenario from `packages/loadtest/`

## Migration / rollout notes

<!--
Required if this is a breaking change.
- Are there config / env / schema migrations?
- Is this safe to deploy in a rolling restart, or does it require downtime?
- Anything else operators should know?
-->

## Screenshots / logs

<!-- For UI changes, include before/after screenshots. For perf changes, include the relevant load-test diff. -->
