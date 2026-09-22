# Thirdlight — Agent Instructions

Thirdlight is a self-hosted browser game editor built on three.js. The goal
and scope are in `docs/architecture/charter.md`. Current work and its status
are in `docs/STATUS.md`; known defects are in `docs/audit-2026-09-22.md`.

## Architecture rules

- The backend owns project state. The browser and MCP use the same editing
  commands; there is no second mutation path.
- Exported games run without the editor backend, MCP, or model service. The
  runtime never imports editor/server/MCP code.
- Packages talk through their public exports only. `npm run build` enforces
  boundaries, dependency pins, and strict TypeScript; keep it green.
- Use the lockfile and pinned versions. Check official docs for
  version-sensitive APIs.

## How to work

- Work on the current phase item in `docs/STATUS.md`. Keep changes small and
  complete; no placeholder code that pretends to meet a goal.
- Test observable behavior at real boundaries (HTTP/WS, filesystem, browser).
  Editor/UI changes need a Playwright test that drives the real page against
  a real backend. Mocks alone do not prove integration.
- "Done" means it works for a user in a real browser. Never mark visual,
  audio, or input behavior verified without actually observing it; say
  "unverified" instead. Never invent results.
- When an item is done, update its row in `docs/STATUS.md` in one or two
  lines. Do not write handoff files, gate reviews, or evidence dumps.
- Commit to `main` with a clear message when a coherent change is green.
  Do not push or publish.
- Preserve unrelated user changes. Never expose credentials in code, logs,
  bundles, fixtures, or docs.

`archive/` is historical record only. It is not authoritative; do not read it
unless you need a specific past detail.
