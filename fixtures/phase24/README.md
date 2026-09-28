# Phase 24.8 legacy project fixtures

Minimal storage v4 projects written by hand in the format before phase 24.8
(`project.json` schemaVersion 2, `content.game: null`, the removed genre
components). Neutral: they are not copied from any game repo.

- `legacy-v2-upgradable/` — only data the loader upgrades: two pickups (a
  coin, a custom counter), a spawn facing right, a health component with the
  session player's fields. Opening it gives collectibles adding to `coins`
  and `stars`, a spawn yaw of 90 and a health of `{max, start}`, written back
  as schemaVersion 3.
- `legacy-v2-refused/` — game data the loader refuses by name: a game block,
  an enemy, a game zone, a camera follow and a heart pickup.

Used by `packages/backend/src/format-upgrade.test.ts` (copied into a test
backend's data root and opened over HTTP).
