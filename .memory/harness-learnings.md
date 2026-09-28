# Harness Learnings

> Accumulated patterns and pitfalls specific to this codebase.
> Agents consult this file at the start of each phase.
> Managed by the `harness-learnings` skill.

<!-- Learnings are appended below. Do not edit the header. -->

## L-001: Standard builds must preserve the EvenHub frontend

- Phase: implement
- Dimension: behaviour
- Scope: package.json, scripts/clean*.mjs, public/**
- Pattern: A shared clean script removed both `dist/` and `public/`, causing normal builds, tests, and package preparation to delete an existing EvenHub frontend.
- Guidance: Keep `npm run clean` limited to `dist/`. Remove `public/` only in the `build:evenhub` flow before `copy-frontend`.
- Confidence: low
- Occurrences: 1
- First seen: 2026-09-28
- Last seen: 2026-09-28

## L-002: Routes must await asynchronous integration methods

- Phase: implement
- Dimension: behaviour
- Scope: src/integrations/contracts.ts, src/routes/core.js, test/runtime.test.js
- Pattern: The integration contract allowed `interrupt()` to return a promise, but the HTTP route returned success without awaiting it, allowing rejected cancellation to become an unhandled rejection.
- Guidance: When a `CliIntegration` method returns `MaybePromise`, await it in the route and convert failures into the existing JSON error response. Include an HTTP-level test with a rejecting asynchronous adapter.
- Confidence: low
- Occurrences: 1
- First seen: 2026-09-28
- Last seen: 2026-09-28
