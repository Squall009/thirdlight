/**
 * Gate B re-review repair (round 1, 2026-09-18) — workspace scope:
 *
 * G1 (P1, R12 acceptance property): one corrupted *envelope* (valid JSON
 * with `scene.entities` replaced by a 4000-level nested array) made
 * `openWorkspaceService` throw `RangeError: Maximum call stack size
 * exceeded` during the startup scan (the model's `boundedFound` overflow,
 * reached via `validateScene` from `validateEnvelope` with no try/catch at
 * the scan's envelope-load site) — aborting service startup for EVERY
 * project in the root, healthy ones included (workspace.md §7.5/§10;
 * project-model.md §12.1).
 *
 * G2 (P1, workspace.md §7.5 block semantics): on-demand open on a
 * corrupted *manifest* (`scenes[0].path` a 4000-level chain, valid JSON)
 * threw `RangeError` from the public API instead of returning the
 * structured `project_unavailable { reason: 'manifest_invalid' }`
 * (workspace.md §7.5: "the project is blocked: commands return
 * project_unavailable … queries fail the same way"; §4.3 step 8: failure ⇒
 * `manifest_invalid`; §11: `manifest_invalid` is a permitted
 * `project_unavailable.reason` — "a project that exists on disk but cannot
 * load is exactly what project_unavailable reports").
 *
 * The model half of the fix (bounded `found`, depth ≤ 64 AND nodes ≤ 4096)
 * is pinned by packages/project-model/src/repair-2026-09-18-gateb.test.ts;
 * these tests pin the workspace surface (public APIs only).
 *
 * RED evidence (pre-fix, this file, vitest 5.0.1 / node v22.22.1):
 * - G1: `openWorkspaceService` THREW `RangeError: Maximum call stack size
 *   exceeded` (startup scan; origin: boundedFound validate.ts:109).
 * - G2: `openWorkspaceService` succeeded (the scan's manifest load is
 *   try/catch-guarded) but `query` THREW `RangeError: Maximum call stack
 *   exceeded` (on-demand open; same origin).
 *
 * The projects are seeded by RAW FILE WRITES (no service-created project:
 * `dispose()` leaves an ownership record that would complicate the probe).
 * The on-disk shapes are the canonical fixture bytes
 * (fixtures/commands/envelope/valid/demo-0001-manifest.json +
 * demo-0001-rev0.json — the §4.4 byte-exact envelope fixtures), with the
 * project id substituted; the corruption is written as JSON text, mirroring
 * the reviewer's repro (4000-level nested array as JSON text, persisted).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService } from '@thirdlight/workspace';

// Self-contained (the src test plane is typechecked against the package's
// ambient node declarations — packages/workspace/tests/ is excluded from
// the tsc program, so the shared tests/helpers.ts cannot be imported from
// here; the same convention the other repair-2026-09-18-*.test.ts files
// follow).
const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'fixtures', 'commands');

/** Disposable data root (tmpdir, like the other src repair tests). */
function mkRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `tl07-gateb-${tag}-`));
}

/** A 4000-level length-1 nested array, as JSON TEXT (never parsed here —
 * only the service's strict byte parser materializes it). */
const DEEP = '['.repeat(4000) + '0' + ']'.repeat(4000);

/** Seed a project by raw file writes: fixture manifest + fixture envelope
 * (byte-exact shapes, project id substituted), no `.thirdlight` directory. */
function seedProjectRaw(root: string, projectId: string): { dir: string; envText: string; manText: string } {
  const dir = join(root, 'projects', projectId);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  const manText = readFileSync(join(FIXTURES, 'envelope', 'valid', 'demo-0001-manifest.json'), 'utf8').replace(
    /"demo-0001"/g,
    `"${projectId}"`,
  );
  const envText = readFileSync(join(FIXTURES, 'envelope', 'valid', 'demo-0001-rev0.json'), 'utf8').replace(
    /"demo-0001"/g,
    `"${projectId}"`,
  );
  writeFileSync(join(dir, 'project.json'), manText);
  writeFileSync(join(dir, 'scenes', 'main.json'), envText);
  return { dir, envText, manText };
}

/** The same valid envelope, but `scene.entities` is the 4000-level chain
 * (written as JSON text; the envelope is otherwise valid). */
function corruptEnvelopeEntities(root: string, projectId: string): string {
  const dir = join(root, 'projects', projectId);
  const text = [
    '{',
    '  "storageVersion": 1,',
    '  "type": "authoring-state",',
    `  "projectId": "${projectId}",`,
    '  "scene": {',
    '    "schemaVersion": 1,',
    '    "sceneId": "scene-main",',
    '    "revision": 0,',
    `    "entities": ${DEEP}`,
    '  },',
    '  "retry": { "retention": 128, "records": [] }',
    '}',
  ].join('\n') + '\n';
  writeFileSync(join(dir, 'scenes', 'main.json'), text);
  return text;
}

/** The same valid manifest, but `scenes[0].path` is the 4000-level chain
 * (written as JSON text; the envelope stays healthy). */
function corruptManifestPath(root: string, projectId: string): string {
  const dir = join(root, 'projects', projectId);
  const text = [
    '{',
    '  "schemaVersion": 1,',
    '  "engineVersion": "0.1.0",',
    `  "id": "${projectId}",`,
    '  "name": "Demo Project",',
    '  "createdAt": "2026-09-16T23:40:00Z",',
    '  "scenes": [',
    '    {',
    '      "id": "scene-main",',
    `      "path": ${DEEP}`,
    '    }',
    '  ]',
    '}',
  ].join('\n') + '\n';
  writeFileSync(join(dir, 'project.json'), text);
  return text;
}

function unavailableOf(r: { ok: false; error: { code: string; reason?: string; details?: readonly unknown[] } }): void {
  expect(r.error.code).toBe('project_unavailable');
}

describe('Gate B repair G1: one corrupt envelope must not abort startup (workspace.md §7.5/§10)', () => {
  it('startup scan survives a 4000-level deep entities; the healthy project is served and mutated; the corrupt project is blocked, reported, retained', () => {
    const root = mkRoot('g1');
    try {
      // Both projects seeded by raw file writes BEFORE any service open;
      // the corrupt one starts from the same valid shape, then its
      // envelope is overwritten with the deep-chain corruption.
      seedProjectRaw(root, 'healthy-1');
      seedProjectRaw(root, 'corrupt-1');
      const corruptText = corruptEnvelopeEntities(root, 'corrupt-1');

      // The public entry must not throw (pre-fix: RangeError from the
      // startup scan, every project unserved until the file is repaired).
      const svc = openWorkspaceService({ root });
      try {
        // The scan report marks the corrupt project per the scan contract
        // (workspace.md §10: "corrupt manifest/envelope | reported with the
        // §4.3 codes, retained, blocked until operator repair" — the §4.3
        // code for a scene-validation failure is `scene_invalid`, step 6).
        const entry = svc.lastScan.entries.find((e) => e.projectId === 'corrupt-1');
        expect(entry?.kind).toBe('project');
        expect(entry?.loadable).toBe(false);
        expect(entry?.code).toBe('scene_invalid');
        expect(entry?.note).toContain('retained until operator repair');
        const healthy = svc.lastScan.entries.find((e) => e.projectId === 'healthy-1');
        expect(healthy?.kind).toBe('project');
        expect(healthy?.loadable).toBe(true);

        // The healthy project remains queryable …
        const q = svc.query({ op: 'queryProject', projectId: 'healthy-1' });
        expect(q.ok).toBe(true);
        if (q.ok) expect(q.revision).toBe(0);
        // … and mutable (the revision advances).
        const m = svc.runCommand({
          op: 'createEntity',
          projectId: 'healthy-1',
          expectedRevision: 0,
          requestId: 'req-30000000000000000000000000000001',
          origin: { kind: 'mcp', clientId: 'pi-harness' },
          args: { kind: 'box', name: 'Ground' },
        });
        expect(m.ok, JSON.stringify(m)).toBe(true);
        if (m.ok) expect(m.revision).toBe(1);

        // On-demand open/query/mutation on the corrupt project returns the
        // structured §4.3 block — never a throw from the public API.
        const qc = svc.query({ op: 'queryProject', projectId: 'corrupt-1' });
        expect(qc.ok).toBe(false);
        if (!qc.ok) {
          unavailableOf(qc);
          expect(qc.error.reason).toBe('scene_invalid');
          expect((qc.error.details?.length ?? 0)).toBeGreaterThan(0);
        }
        const mc = svc.runCommand({
          op: 'createEntity',
          projectId: 'corrupt-1',
          expectedRevision: 0,
          requestId: 'req-30000000000000000000000000000002',
          origin: { kind: 'mcp', clientId: 'pi-harness' },
          args: { kind: 'box', name: 'Nope' },
        });
        expect(mc.ok).toBe(false);
        if (!mc.ok) {
          unavailableOf(mc);
          expect(mc.error.reason).toBe('scene_invalid');
        }

        // The corrupt bytes are retained byte-identically (no auto-repair —
        // workspace.md §7.5: "never auto-repairs, auto-reverts, or
        // auto-deletes").
        expect(readFileSync(join(root, 'projects', 'corrupt-1', 'scenes', 'main.json'), 'utf8')).toBe(corruptText);
      } finally {
        svc.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Gate B repair G2: on-demand open on a corrupt manifest blocks, never throws (workspace.md §7.5/§4.3 step 8/§11)', () => {
  it('a 4000-level deep scenes[0].path ⇒ project_unavailable { reason: "manifest_invalid" } on query AND command; bytes retained', () => {
    const root = mkRoot('g2');
    try {
      seedProjectRaw(root, 'corrupt-2');
      const manText = corruptManifestPath(root, 'corrupt-2');

      // The startup scan is guarded (reported, not abortive — §10).
      const svc = openWorkspaceService({ root });
      try {
        const entry = svc.lastScan.entries.find((e) => e.projectId === 'corrupt-2');
        expect(entry?.kind).toBe('project');
        expect(entry?.loadable).toBe(false);
        expect(entry?.code).toBe('manifest_invalid');

        // The on-demand open (query) returns the structured block.
        const q = svc.query({ op: 'queryProject', projectId: 'corrupt-2' });
        expect(q.ok).toBe(false);
        if (!q.ok) {
          unavailableOf(q);
          expect(q.error.reason).toBe('manifest_invalid');
          // The load details carry the model error at the corrupt field.
          expect(q.error.details?.some((d) => (d as { path?: string }).path === '/scenes/0/path')).toBe(true);
        }
        // Commands fail the same way (§7.5).
        const m = svc.runCommand({
          op: 'createEntity',
          projectId: 'corrupt-2',
          expectedRevision: 0,
          requestId: 'req-40000000000000000000000000000001',
          origin: { kind: 'mcp', clientId: 'pi-harness' },
          args: { kind: 'box', name: 'Nope' },
        });
        expect(m.ok).toBe(false);
        if (!m.ok) {
          unavailableOf(m);
          expect(m.error.reason).toBe('manifest_invalid');
        }

        // Retained byte-identically (no auto-repair).
        expect(readFileSync(join(root, 'projects', 'corrupt-2', 'project.json'), 'utf8')).toBe(manText);
      } finally {
        svc.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});