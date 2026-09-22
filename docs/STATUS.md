# Thirdlight — Status

Updated 2026-09-22. Goal and scope: `docs/architecture/charter.md`.
Defect list: `docs/audit-2026-09-22.md` (D-numbers below).

Rule: a phase item is **done** only when it works in a real browser, has an
automated test at the boundary it fixes (Playwright for UI), and the owner
has looked at it where it is visual/audible.

## Phases

| Phase | Goal | Fixes | Status |
|---|---|---|---|
| 0 | Commit the work, archive the packet process, reset docs | — | done |
| 1 | The M1 authoring loop works in a real browser | D1, D4–D8, D14, undo UI | done 2026-09-22 — `npm run test:e2e` covers open/create/undo/redo/gizmo/reload/restart/MCP/token; owner look pending |
| 2 | One current schema; every feature reachable through the product | D2, D3, D9 | not started |
| 3 | Charter first-release editor features | D15, D16 | not started |
| 4 | Beacon Reach is honestly playable in editor and export | D10–D13, D20 | not started |
| 5 | MCP parity with charter §7 | D18 | not started |
| 6 | Real M4: templates, independent project, one-command start, backup | D17, D19 | not started |
| — | Debt, only when touching the files anyway | D21 | ongoing |

## Notes

- Tests: `npm test` (unit/integration), `npm run build && npm run test:e2e`
  (Playwright, real backend + Chromium).
- Dead-owner reclaim is automatic now; the admin `takeover` route remains for
  the rare case where the reclaim fails.

- Deployment is process-level inside the Proxmox LXC; no containers (owner
  ruling, `docs/environment.md`). Project data: `/home/dadmin/thirdlight/projects/`.
- No existing project data needs to be preserved (owner, 2026-09-22).
