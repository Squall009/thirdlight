/**
 * Gate B re-review repair (round 1, 2026-09-18) — project-model scope:
 *
 * G1/G2 (P1, project-model.md §12.1 "never throws on malformed data"):
 * `boundedFound`'s per-level width caps are NOT a recursion bound — a
 * 4000-level length-1 array chain used as `found` recursed one stack frame
 * per level and overflowed (RangeError) through the public
 * `validateScene`/`validateManifest` entry points. The bound applied here:
 * depth ≤ 64 AND nodes ≤ 4096 per `found` mapping (fresh budget per error;
 * the commands-O1 discipline, packages/commands/src/errors.ts, 69b1a17),
 * degrading the whole `found` to the bounded marker when the bound is hit.
 *
 * G3 (P2, project-model.md §12.5: `path` is a JSON Pointer, RFC 6901):
 * dynamic keys (unknown fields) were interpolated into `path` unescaped —
 * an `a/b` key yielded the invalid pointer `/…/a/b` (must be `a~1b`).
 *
 * RED evidence (pre-fix, this file, vitest 5.0.1 / node v22.22.1):
 * - T1–T6, T6b: `RangeError: Maximum call stack size exceeded` at
 *   `boundedFound` (validate.ts:109, the `v.map(boundedFound)` recursion).
 * - T6c passed pre-fix (the 05-N3 length summary never recurses — the
 *   guard the re-review §5.1 item 5 noted); it pins that behavior.
 * - T7 pre-fix: the error path was `/entities/0/components/transform/a/b`
 *   (unescaped — invalid RFC 6901).
 */

import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  validateScene,
  type ModelError,
  type ModelResult,
  type Scene,
} from '@thirdlight/project-model';

// The marker the fix emits where the traversal bound is hit (the commands
// O1 marker text verbatim).
const MARKER = '[truncated: exceeds bounded diagnostic traversal (depth <= 64, nodes <= 4096)]';

/** A length-1 array chain `levels` deep (built in-memory, never serialized). */
function deepChain(levels: number): unknown {
  let v: unknown = 0;
  for (let i = 0; i < levels; i++) v = [v];
  return v;
}

function firstError(r: { ok: false; errors: readonly ModelError[] }): ModelError {
  expect(r.errors.length).toBeGreaterThan(0);
  return r.errors[0]!;
}

/** RFC 6901 pointer tokenizer (null when the string is not a valid pointer). */
function tokenizePointer(p: string): string[] | null {
  if (p === '') return [];
  if (!p.startsWith('/')) return null;
  const out: string[] = [];
  for (const part of p.slice(1).split('/')) {
    let seg = '';
    let i = 0;
    while (i < part.length) {
      const c = part[i];
      if (c === '~') {
        if (i + 1 >= part.length) return null;
        const n = part[i + 1];
        if (n !== '0' && n !== '1') return null;
        seg += n === '0' ? '~' : '/';
        i += 2;
      } else {
        seg += c;
        i += 1;
      }
    }
    out.push(seg);
  }
  return out;
}

describe('Gate B repair: bounded `found` (G1/G2 model half, project-model.md §12.1)', () => {
  // The five shapes the Gate B re-review probed on the live tree (all threw
  // RangeError pre-fix through the public entry points) + the 12,000-level
  // construction the acceptance requires.
  it('T1: a 4000-level chain at entities[0] ⇒ structured error, bounded found, no throw', () => {
    const r = validateScene({
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: deepChain(4000),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = firstError(r);
    expect(e.code).toBe('field_type');
    expect(e.path).toBe('/entities/0');
    expect(e.found).toBe(MARKER);
    // The payload is JSON-safe and serializable.
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it('T2: a 4000-level chain at parentId ⇒ structured error, bounded found, no throw', () => {
    const r = validateScene({
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: [
        {
          id: 'cam-main',
          parentId: deepChain(4000),
          components: {
            transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
          },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.path === '/entities/0/parentId');
    expect(e?.code).toBe('field_type');
    expect(e?.found).toBe(MARKER);
  });

  it('T3: position = [deep, deep, deep] ⇒ per-element errors with bounded found, no throw', () => {
    const deep = () => deepChain(4000);
    const r = validateScene({
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: [
        {
          id: 'cam-main',
          components: {
            transform: { position: [deep(), deep(), deep()], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            camera: { type: 'perspective' },
          },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const j of [0, 1, 2]) {
      const e = r.errors.find((x) => x.path === `/entities/0/components/transform/position/${j}`);
      expect(e?.code).toBe('field_type');
      expect(e?.found, `element ${j} found must be the bounded marker`).toBe(MARKER);
    }
  });

  it('T4: manifest scenes[0].path = 4000-level chain ⇒ structured error, bounded found, no throw', () => {
    const r = validateManifest({
      schemaVersion: 1,
      engineVersion: '0.1.0',
      id: 'demo-0001',
      name: 'Demo',
      createdAt: '2026-09-16T23:40:00Z',
      scenes: [{ id: 'scene-main', path: deepChain(4000) }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.path === '/scenes/0/path');
    expect(e?.code).toBe('field_type');
    expect(e?.found).toBe(MARKER);
  });

  it('T5: manifest scenes[0].id = 4000-level chain ⇒ structured error, bounded found, no throw', () => {
    const r = validateManifest({
      schemaVersion: 1,
      engineVersion: '0.1.0',
      id: 'demo-0001',
      name: 'Demo',
      createdAt: '2026-09-16T23:40:00Z',
      scenes: [{ id: deepChain(4000), path: 'scenes/main.json' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.path === '/scenes/0/id');
    expect(e?.code).toBe('field_type');
    expect(e?.found).toBe(MARKER);
  });

  it('T6: a 12,000-level in-memory chain ⇒ no throw, structured error (the §12.1 totality bound)', () => {
    const r = validateScene({
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: deepChain(12000),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = firstError(r);
    expect(e.code).toBe('field_type');
    expect(e.found).toBe(MARKER);
  });

  it('T6b: a 4000-level chain at a string field site ⇒ field_type with bounded found', () => {
    const r = validateScene({
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: [
        {
          id: 'cam-main',
          name: deepChain(4000),
          components: {
            transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            camera: { type: 'perspective' },
          },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.path === '/entities/0/name');
    expect(e?.code).toBe('field_type');
    expect(e?.found).toBe(MARKER);
  });

  it('T6c: a 4000-level chain as a whole array field ⇒ field_value with the length (05-N3), no throw', () => {
    const r = validateScene({
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: [
        {
          id: 'cam-main',
          components: {
            transform: { position: deepChain(4000), rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            camera: { type: 'perspective' },
          },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.path === '/entities/0/components/transform/position');
    expect(e?.code).toBe('field_value');
    expect(e?.found).toBe(1); // the length — the documented 05-N3 summary
  });
});

describe('Gate B repair: RFC 6901-escaped dynamic-key pointers (G3, project-model.md §12.5)', () => {
  function sceneWithTransformKey(key: string): ModelResult<Scene> {
    return validateScene({
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: [
        {
          id: 'cam-main',
          components: {
            transform: {
              position: [0, 0.5, 4],
              rotation: [0, 0, 0, 1],
              scale: [1, 1, 1],
              [key]: 1,
            },
            camera: { type: 'perspective' },
          },
        },
      ],
    });
  }

  it('T7: an `a/b` key ⇒ path segment `a~1b` (pre-fix: the invalid pointer `…/a/b`)', () => {
    const r = sceneWithTransformKey('a/b');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.code === 'field_unexpected');
    expect(e?.path).toBe('/entities/0/components/transform/a~1b');
  });

  it('T8: an `a~b` key ⇒ `a~0b`; a `~/x` key ⇒ `~0~1x`', () => {
    const r1 = sceneWithTransformKey('a~b');
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.errors.find((x) => x.code === 'field_unexpected')?.path).toBe(
        '/entities/0/components/transform/a~0b',
      );
    }
    const r2 = sceneWithTransformKey('~/x');
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.errors.find((x) => x.code === 'field_unexpected')?.path).toBe(
        '/entities/0/components/transform/~0~1x',
      );
    }
  });

  it('T9: sweep — every dynamic-key site yields a valid RFC 6901 pointer that unescapes to the key', () => {
    const KEY = '~/a/b~c'; // worst case: both escapes needed, both characters present
    const esc = KEY.replace(/~/g, '~0').replace(/\//g, '~1'); // ~0~1a~1b~0c

    const scene = validateScene({
      [`${KEY}-root`]: 1,
      schemaVersion: 1,
      sceneId: 'scene-main',
      revision: 0,
      entities: [
        {
          id: 'cam-main',
          [`${KEY}-ent`]: 1,
          components: {
            [`${KEY}-comp`]: { type: 'x' },
            transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1], [`${KEY}-tr`]: 1 },
            box: { size: [1, 1, 1], material: { color: '#ffffff', [`${KEY}-mat`]: 1 }, [`${KEY}-box`]: 1 },
            camera: { type: 'perspective', [`${KEY}-cam`]: 1 },
          },
        },
      ],
    });
    expect(scene.ok).toBe(false);
    if (!scene.ok) {
      // Every error path is a valid RFC 6901 pointer.
      for (const e of scene.errors) {
        const segs = tokenizePointer(e.path);
        expect(segs, `pointer must be valid RFC 6901: ${e.path}`).not.toBeNull();
      }
      // Each dynamic site: the last segment unescapes to the exact key.
      const bySuffix: Record<string, string> = {
        root: `/${esc}-root`,
        ent: `/entities/0/${esc}-ent`,
        comp: `/entities/0/components/${esc}-comp`,
        tr: `/entities/0/components/transform/${esc}-tr`,
        box: `/entities/0/components/box/${esc}-box`,
        mat: `/entities/0/components/box/material/${esc}-mat`,
        cam: `/entities/0/components/camera/${esc}-cam`,
      };
      for (const [site, expected] of Object.entries(bySuffix)) {
        const e = scene.errors.find((x) => x.path === expected);
        expect(e, `site ${site}: expected escaped path ${expected}`).toBeDefined();
        const segs = tokenizePointer(expected)!;
        expect(segs[segs.length - 1]).toBe(`${KEY}-${site}`);
      }
    }

    const manifest = validateManifest({
      schemaVersion: 1,
      engineVersion: '0.1.0',
      id: 'demo-0001',
      name: 'Demo',
      createdAt: '2026-09-16T23:40:00Z',
      scenes: [{ id: 'scene-main', path: 'scenes/main.json', [`${KEY}-ref`]: 1 }],
      [`${KEY}-man`]: 1,
    });
    expect(manifest.ok).toBe(false);
    if (!manifest.ok) {
      for (const e of manifest.errors) {
        expect(tokenizePointer(e.path), `pointer must be valid RFC 6901: ${e.path}`).not.toBeNull();
      }
      const ref = manifest.errors.find((x) => x.path === `/scenes/0/${esc}-ref`);
      expect(ref?.code).toBe('field_unexpected');
      const man = manifest.errors.find((x) => x.path === `/${esc}-man`);
      expect(man?.code).toBe('field_unexpected');
    }
  });
});