/**
 * Test seeding helper (phase 9.3 step B): the workspace opens only storage v4
 * projects, upgrades a storage v3 project in place on open, and refuses a
 * storage v1/v2 project (`storage_version_unsupported`).
 *
 * Several integration suites seed committed storage v2 fixtures
 * (`fixtures/m2/storage/project`, `fixtures/m3/storage/project-v2-demo-0002`).
 * `upgradeSeededEnvelopeToV3` rewrites such a seeded copy's `scenes/main.json`
 * into the equivalent storage v3 envelope — the pure v2→v3 logical conversion
 * the removed migration used (`storageVersion: 3`, `scene.schemaVersion: 3`,
 * every entity verbatim, the content block unchanged plus `game: null`) — so
 * the real workspace upgrades it to v4 when it first opens the project. The
 * committed fixtures themselves are never modified.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function upgradeSeededEnvelopeToV3(projectDir: string): void {
  const envPath = join(projectDir, 'scenes', 'main.json');
  const env = JSON.parse(readFileSync(envPath, 'utf8')) as {
    storageVersion: number;
    scene: Record<string, unknown>;
    content: Record<string, unknown>;
  };
  if (env.storageVersion !== 2) throw new Error(`expected a storage v2 envelope at ${envPath}, got ${String(env.storageVersion)}`);
  const v3 = {
    ...env,
    storageVersion: 3,
    scene: { ...env.scene, schemaVersion: 3 },
    content: { ...env.content, game: null },
  };
  writeFileSync(envPath, `${JSON.stringify(v3, null, 2)}\n`);
}
