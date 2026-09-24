/**
 * ARCHIVED (phase 9.3): the `migrateSceneV3` (v2 → v3 scene) cases removed
 * from packages/project-model/src/v3-model.test.ts when the v2 scene model
 * and `migrateSceneV3` were removed. Historical record only — not built or
 * tested. The destination-fixture load checks were kept in v3-model.test.ts.
 */

describe('packet 44 — migration fixtures: pure v2→v3 scene conversion', () => {
  const srcEnvelope = JSON.parse(m3ContractFixtureText('migration/v2-source/envelope.json')) as Record<string, unknown>;
  const dstEnvelope = JSON.parse(m3ContractFixtureText('migration/expected-v3-destination/envelope.json')) as Record<string, unknown>;
  const dstProject = JSON.parse(m3ContractFixtureText('migration/expected-v3-destination/project.json')) as unknown;

  it('migrateSceneV3 carries every entity verbatim and sets schemaVersion 3', () => {
    const srcScene = srcEnvelope['scene'] as Record<string, unknown>;
    const dstScene = dstEnvelope['scene'] as Record<string, unknown>;
    const before = JSON.stringify(srcScene);
    const migrated = migrateSceneV3(srcScene);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.normalized.schemaVersion).toBe(3);
    expect(migrated.normalized.sceneId).toBe(srcScene['sceneId']);
    // §23.11: entity values/order/IDs verbatim — the destination entity array
    // is byte-identical to the pure conversion result.
    expect(migrated.normalized.entities).toEqual(dstScene['entities']);
    expect(JSON.stringify(migrated.normalized.entities)).toBe(JSON.stringify(dstScene['entities']));
    // §23.11 is a scene-level operator: it does not reset the revision. The
    // destination revision 0 is the workspace copy operator's reset
    // (workspace.md §16.5, packet 46).
    expect(srcScene['revision']).toBe(6);
    expect(dstScene['revision']).toBe(0);
    expect(migrated.normalized.revision).toBe(6);
    // The caller's input is never mutated (non-destructive).
    expect(JSON.stringify(srcScene)).toBe(before);
    // The expected destination scene is accepted verbatim by the v3 validator.
    expect(validateSceneV3(dstScene).ok).toBe(true);
    expect(validateContentV3(dstEnvelope['content']).ok).toBe(true);
    // CC-44-4 resolved by the bounded contract repair
    // (docs/handoffs/repair-cc44-3-4.md): `workspace.md` §16.5.2 now resets the
    // derived revision metadata on copy (`publishedRevision`,
    // `source.publishedRevision`, `behaviorTrust[].acknowledgedRevision` → 0),
    // so the committed destination is loadable as a whole and satisfies the
    // accepted §18.9.2 rule 4 (`publishedRevision <= scene.revision`).
    const projectResult = validateProjectV3(dstProject, dstScene, dstEnvelope['content']);
    expect(projectResult.ok, JSON.stringify(projectResult)).toBe(true);
    const asset = (dstEnvelope['content'] as { assets: { versions: { publishedRevision: number }[] }[] }).assets[0];
    expect(asset?.versions[0]?.publishedRevision).toBe(0);
  });

  it('migrateSceneV3 is identity on a v3 scene and canonical/digest stable', () => {
    const dstScene = dstEnvelope['scene'] as unknown;
    const first = migrateSceneV3(dstScene);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = migrateSceneV3(first.normalized);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.normalized).toEqual(first.normalized);
    const a = serializeCanonical(first.normalized);
    const b = serializeCanonical(second.normalized);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
      expect(sha256Hex(a.bytes)).toBe(sha256Hex(b.bytes));
    }
  });

  it('refuses a v1 source non-destructively with no_migration_path', () => {
    const v1 = { schemaVersion: 1, sceneId: 'scene-main', revision: 0, entities: [] };
    const before = JSON.stringify(v1);
    const refused = migrateSceneV3(v1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors[0]!.code).toBe('no_migration_path');
      expect(refused.errors[0]!.path).toBe('/schemaVersion');
    }
    expect(JSON.stringify(v1)).toBe(before);
  });

  it('reads the interrupted-copy case (workspace-owned resume/suppression)', () => {
    const marker = JSON.parse(m3ContractFixtureText('migration/interrupted-copy/marker.json')) as Record<string, unknown>;
    const copyCase = JSON.parse(m3ContractFixtureText('migration/interrupted-copy/case.json')) as Record<string, unknown>;
    expect(marker['sourceVersion']).toBe(2);
    expect(marker['newVersion']).toBe(3);
    expect(marker['type']).toBe('migration-copy');
    const expectBlock = copyCase['expect'] as Record<string, unknown>;
    // `migration_resume_required`, marker phases and default-envelope
    // suppression are the workspace copy operator's (workspace.md §16.5/§16.6,
    // packet 46); the model layer contributes only migrateSceneV3.
    expect(expectBlock['startupScan']).toBe('migration_resume_required');
    expect(expectBlock['defaultEnvelopeSuppressed']).toBe(true);
    expect(migrationFiles.length).toBe(6);
  });
});

