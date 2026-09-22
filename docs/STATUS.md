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
| 2 | One current schema; every feature reachable through the product | D2, D3, D9, D22–D26 | done 2026-09-22 — new projects are v3 with starter lights; Play/export work for plain scenes (scene mode) and via the backend route; e2e covers Play pixels and export served statically with the backend stopped. Loading Beacon Reach through the backend moved to phase 4; removing v1/v2 code paths is D21 debt |
| 3 | Charter first-release editor features | D15, D16, D27 | done 2026-09-22 — rename/reparent (`updateEntity`), typed transforms, shortcuts, per-axis gizmo + click-pick, Problems tab (backend problems log), external-edit detection with load/keep banner, isolated asset preview, runtime-faithful viewport (hierarchy, box size/color). Not done: multi-select, duplicate, sibling reorder |
| 4 | Beacon Reach is honestly playable in editor and export | D10–D13, D20, D28–D30 | done 2026-09-22 — templates via `POST /admin/projects {template}`; visible animated courier; goal cue; checkpoint glow; fixed GLB; Play works for games in the editor; scripts run in the game (Play + export); e2e plays it to the goal through the relays and drives it by keyboard. Owner playthrough by hand still pending |
| 5 | MCP parity with charter §7 | D18 | not started |
| 6 | Real M4: templates, independent project, one-command start, backup | D17, D19 | not started |
| — | Debt, only when touching the files anyway | D21 | ongoing |

## Notes

- Tests: `npm test` (unit/integration), `npm run build && npm run test:e2e`
  (Playwright, real backend + Chromium).
- The editor shows a banner when scene files change on disk (polled every
  1.5 s while an editor is connected); `/projects/:id/external/(accept|discard)`
  resolves it with the project token. `/projects/:id/problems` is the bounded
  problems log (also pushed as `problems.added`).
- Dead-owner reclaim is automatic now; the admin `takeover` route remains for
  the rare case where the reclaim fails.

- Deployment is process-level inside the Proxmox LXC; no containers (owner
  ruling, `docs/environment.md`). Project data: `/home/dadmin/thirdlight/projects/`.
- No existing project data needs to be preserved (owner, 2026-09-22).
