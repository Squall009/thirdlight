/**
 * Packet 28 — Node-runnable prefab/property authoring integration of the
 * editor's PURE modules (vitest; no browser, no backend).
 *
 * This suite replays the **accepted** packet-16/22 fixtures through the exact
 * modules the React app uses and asserts the packet-28 acceptance properties at
 * the pure layer:
 *
 *  - capture preflight + `createPrefab` request construction;
 *  - two copies with distinct IDs/transforms (the accepted independence
 *    scenario), one legal initial declared-property override;
 *  - editing ONE copy is an ordinary typed command and leaves the other copy
 *    (and the definition's recorded values) untouched — copies are not links;
 *  - one-undo subtree removal and exact-ID redo, and reopening rebuilt from
 *    queries rather than in-memory assumptions;
 *  - an MCP-origin `mutation.applied` converges the projection without a
 *    reload (dedup + the gap rule are the M1 rules, unchanged);
 *  - the declaration/definition projection never rewrites a copy's values;
 *  - no script evaluation anywhere in the authoring modules/panels and no
 *    apply/revert/variant/link affordance in the UI.
 *
 * The transport is in-memory: this proves the pure decision logic and the
 * change-application rules, not browser/WebGL behavior (see
 * `m2-prefabs.browser.ts` for the browser procedure and the UNVERIFIED list).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PrefabProjection } from '../../../packages/editor/src/session/prefab-projection';
import { Projection } from '../../../packages/editor/src/session/projection';
import {
  collectOverrides,
  overrideDraftKey,
  planCreatePrefab,
  planInstantiatePrefab,
  preflightCreatePrefab,
  type CaptureEntityView,
} from '../../../packages/editor/src/session/prefab-authoring';
import {
  deriveOverrideTargets,
  derivePropertyControls,
  planSetBehaviorProperties,
} from '../../../packages/editor/src/session/property-controls';
import type { ChangeData } from '@thirdlight/commands';
import type { BehaviorRecord, Entity, PrefabDefinition } from '@thirdlight/project-model';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AFTER = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures/m2/contracts/commands/prefab-scenario.after.json'), 'utf8'),
) as {
  scene: { revision: number; entities: Entity[] };
  content: { prefabs: PrefabDefinition[]; behaviors: BehaviorRecord[]; assets: { assetId: string }[]; settings: Record<string, unknown> };
};
const INDEPENDENCE = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures/m2/prefabs/independence.messages.json'), 'utf8'),
) as {
  steps: {
    stepId: string;
    in: { op: string; requestId: string; origin?: { kind: string; clientId: string }; args: Record<string, unknown> };
    out: { ok: boolean; revision: number; change: ChangeData };
  }[];
};

const DEFINITION = AFTER.content.prefabs[0]!;
const DECLARATIONS = new Map(AFTER.content.behaviors.map((b) => [b.behaviorId, b.declaration]));
const ASSET_IDS = AFTER.content.assets.map((a) => a.assetId);
const step = (id: string) => INDEPENDENCE.steps.find((s) => s.stepId === id)!;

/** The projection inputs the React app derives from its own projection. */
function instantiateInput(definition: PrefabDefinition | null) {
  const entities = AFTER.scene.entities;
  return {
    prefabId: 'prefab-0001',
    definition,
    declarations: DECLARATIONS,
    parentId: null as string | null,
    sceneEntityIds: entities.map((e) => e.id),
    assetIds: ASSET_IDS,
    sceneEntityCount: entities.length,
    parentDepth: 0,
  };
}

describe('packet 28 — capture planning from a real projected subtree', () => {
  it('preflights a capture of the accepted Station subtree', () => {
    const scene = AFTER.scene.entities.map(
      (e): CaptureEntityView => ({
        id: e.id,
        parentId: e.parentId ?? null,
        camera: (e.components as Record<string, unknown>)['camera'] !== undefined,
        prefab: ((e.components as Record<string, unknown>)['prefab'] as CaptureEntityView['prefab']) ?? null,
        behavior: (() => {
          const b = (e.components as Record<string, unknown>)['behavior'] as { behaviorId: string; values: Record<string, unknown> } | undefined;
          return b ? { behaviorId: b.behaviorId, values: b.values } : null;
        })(),
      }),
    );
    const plan = planCreatePrefab({
      prefabId: 'prefab-0002',
      displayName: 'Station Kit Copy',
      sourceEntityId: 'group-0001',
      scene,
      existingPrefabIds: ['prefab-0001'],
      declarations: DECLARATIONS,
      cameraId: 'cam-main',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.command.args).toEqual({ prefabId: 'prefab-0002', displayName: 'Station Kit Copy', sourceEntityId: 'group-0001' });

    // The scene camera cannot be captured.
    expect(preflightCreatePrefab({ prefabId: 'prefab-0002', displayName: 'x', sourceEntityId: 'cam-main', scene, existingPrefabIds: [], declarations: DECLARATIONS })).toMatchObject({
      ok: false,
      error: { code: 'prefab_camera_capture_forbidden' },
    });
    // A materialized copy is itself a copy: nested capture is forbidden.
    expect(preflightCreatePrefab({ prefabId: 'prefab-0002', displayName: 'x', sourceEntityId: 'group-0003', scene, existingPrefabIds: [], declarations: DECLARATIONS })).toMatchObject({
      ok: false,
      error: { code: 'prefab_nested_forbidden' },
    });
  });
});

describe('packet 28 — two independent copies, one override, ordinary edits', () => {
  it('plans the accepted I1/I4 commands from the definition + declarations', () => {
    const i1 = planInstantiatePrefab({ ...instantiateInput(DEFINITION), transform: { position: [12, 0, 0] }, overrides: [{ localId: 'model-0001', key: 'speed', value: 9.75 }] });
    expect(i1.ok).toBe(true);
    if (!i1.ok) return;
    expect(i1.command.args).toEqual(step('I1').in.args);
    const i4 = planInstantiatePrefab({ ...instantiateInput(DEFINITION), transform: { position: [-12, 0, 0] } });
    expect(i4.ok).toBe(true);
    if (!i4.ok) return;
    expect(i4.command.args).toEqual(step('I4').in.args);
  });

  it('materializes two copies with distinct IDs and independent values', () => {
    const scene = new Projection();
    scene.hydrate({ revision: AFTER.scene.revision, entities: AFTER.scene.entities });
    const prefabs = new PrefabProjection();
    prefabs.hydrate(AFTER.content.prefabs, AFTER.content.behaviors);

    for (const s of INDEPENDENCE.steps) {
      const res = scene.applyMutationApplied({ requestId: s.in.requestId, revision: s.out.revision, change: s.out.change });
      expect(res).toMatchObject({ gap: false, applied: true });
      prefabs.applyChange(s.out.change);
    }
    // I2 edited copy A's lantern only; copy B still carries the definition's
    // recorded value (4.5). The two copies share no entity and no value store.
    expect(scene.getEntity('model-0003')?.behaviorValues).toMatchObject({ speed: 1.25 });
    expect(scene.getEntity('model-0007')?.behaviorValues).toMatchObject({ speed: 4.5 });
    expect(scene.getEntity('model-0003')?.prefab).toEqual({ prefabId: 'prefab-0001', localId: 'model-0001' });
    expect(scene.getEntity('model-0007')?.prefab).toEqual({ prefabId: 'prefab-0001', localId: 'model-0001' });
    expect(scene.getEntity('group-0002')?.position).toEqual([12, 0, 0]);
    expect(scene.getEntity('group-0004')?.position).toEqual([-12, 0, 0]);
  });

  it('one undo removes the whole second subtree and redo restores the exact IDs', () => {
    const scene = new Projection();
    scene.hydrate({ revision: AFTER.scene.revision, entities: AFTER.scene.entities });
    for (const s of INDEPENDENCE.steps.slice(0, 4)) {
      scene.applyMutationApplied({ requestId: s.in.requestId, revision: s.out.revision, change: s.out.change });
    }
    expect(scene.entityOrder).toContain('group-0004');
    const undo = step('I5');
    scene.applyMutationApplied({ requestId: undo.in.requestId, revision: undo.out.revision, change: undo.out.change });
    for (const id of ['group-0004', 'box-0004', 'model-0007', 'model-0008']) expect(scene.getEntity(id)).toBeUndefined();
    const redo = step('I6');
    scene.applyMutationApplied({ requestId: redo.in.requestId, revision: redo.out.revision, change: redo.out.change });
    expect(scene.getEntity('group-0004')?.prefab).toEqual({ prefabId: 'prefab-0001', localId: 'group-0001' });
    expect(scene.getEntity('model-0007')?.behaviorValues).toMatchObject({ speed: 4.5 });
  });
});

describe('packet 28 — a definition/declaration change never rewrites a copy', () => {
  it('applies a declaration update while the instance values stay byte-identical', () => {
    const scene = new Projection();
    scene.hydrate({ revision: 15, entities: AFTER.scene.entities });
    scene.applyMutationApplied({ requestId: step('I1').in.requestId, revision: 12, change: step('I1').out.change });
    const before = JSON.stringify(scene.getEntity('model-0003')?.behaviorValues);

    const prefabs = new PrefabProjection();
    prefabs.hydrate([DEFINITION], AFTER.content.behaviors);
    const updated: BehaviorRecord = {
      ...AFTER.content.behaviors[0]!,
      declaration: { properties: AFTER.content.behaviors[0]!.declaration.properties.map((p) => (p.key === 'speed' ? { ...p, default: 99 } : p)) },
      publishedRevision: 16,
    };
    prefabs.applyChange({ type: 'publishBehavior', behaviorId: updated.behaviorId, previous: AFTER.content.behaviors[0]!, next: updated });
    // Declarations converge (new default), copies do not (stored values win).
    expect(prefabs.getDeclaration('behavior-0001')?.properties.find((p) => p.key === 'speed')?.default).toBe(99);
    expect(JSON.stringify(scene.getEntity('model-0003')?.behaviorValues)).toBe(before);

    // Undo of the capture removes only the definition; the copy remains.
    prefabs.applyChange({ type: 'removePrefab', prefabId: 'prefab-0001' });
    expect(prefabs.getDefinition('prefab-0001')).toBeUndefined();
    expect(scene.getEntity('model-0003')).toBeDefined();
  });
});

describe('packet 28 — editing one copy and MCP-origin convergence', () => {
  it('builds the full values map for an edit and applies it as an ordinary change', () => {
    const scene = new Projection();
    scene.hydrate({ revision: AFTER.scene.revision, entities: AFTER.scene.entities });
    const declaration = DECLARATIONS.get('behavior-0001')!;
    const current = scene.getEntity('model-0001')?.behaviorValues ?? {};
    const plan = planSetBehaviorProperties('model-0001', 'behavior-0001', declaration, current, 'speed', 8.5);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // Applying the change (as the backend would publish its result) converges
    // the projection: the WS event is origin-independent.
    const res = scene.applyMutationApplied({
      requestId: 'req-60600000000000000000000000000009',
      revision: AFTER.scene.revision + 1,
      change: {
        type: 'setBehaviorProperties',
        id: 'model-0001',
        previous: { behaviorId: 'behavior-0001', values: { ...current } } as never,
        next: { behaviorId: 'behavior-0001', values: plan.args.values! },
        changedKeys: ['speed'],
      } as ChangeData,
    });
    expect(res.applied).toBe(true);
    expect(scene.getEntity('model-0001')?.behaviorValues).toMatchObject({ speed: 8.5, target: 'group-0001' });
  });

  it('dedups an MCP-origin replay and resyncs on a gap (the M1 rules, unchanged)', () => {
    const scene = new Projection();
    scene.hydrate({ revision: AFTER.scene.revision, entities: AFTER.scene.entities });
    const mcp = step('I1');
    expect(mcp.in.origin?.kind).toBe('mcp');
    expect(scene.applyMutationApplied({ requestId: mcp.in.requestId, revision: mcp.out.revision, change: mcp.out.change }).applied).toBe(true);
    expect(scene.getEntity('model-0003')?.behaviorValues).toMatchObject({ speed: 9.75 });
    // A replayed event with the same requestId is deduped, never double-applied.
    expect(scene.applyMutationApplied({ requestId: mcp.in.requestId, revision: mcp.out.revision, change: mcp.out.change }).deduped).toBe(true);
    // A missed event (revision jump) marks the projection stale for a resync.
    const gap = scene.applyMutationApplied({ requestId: 'req-x', revision: mcp.out.revision + 5, change: mcp.out.change });
    expect(gap.gap).toBe(true);
    expect(scene.stale).toBe(true);
  });
});

describe('packet 28 — reopening rebuilds from queries, not memory', () => {
  it('rehydrates identical scene, definitions and declarations from the query state', () => {
    const original = new Projection();
    original.hydrate({ revision: AFTER.scene.revision, entities: AFTER.scene.entities });
    const originalPrefabs = new PrefabProjection();
    originalPrefabs.hydrate(AFTER.content.prefabs, AFTER.content.behaviors);

    // Reopen = a fresh projection hydrated from the same query results.
    const reopened = new Projection();
    reopened.hydrate({ revision: original.revision, entities: AFTER.scene.entities });
    const reopenedPrefabs = new PrefabProjection();
    reopenedPrefabs.hydrate(AFTER.content.prefabs, AFTER.content.behaviors);

    expect(JSON.stringify(reopened.listEntities())).toBe(JSON.stringify(original.listEntities()));
    expect(JSON.stringify(reopenedPrefabs.listDefinitions())).toBe(JSON.stringify(originalPrefabs.listDefinitions()));
    expect(JSON.stringify(reopenedPrefabs.listDeclarations())).toBe(JSON.stringify(originalPrefabs.listDeclarations()));
  });
});

describe('packet 28 — override editor derivation from the accepted declaration', () => {
  it('derives controls with defaults/types/constraints and collects typed overrides', () => {
    const targets = deriveOverrideTargets(DEFINITION, DECLARATIONS);
    expect(targets.map((t) => t.localId)).toEqual(['model-0001']);
    const controls = targets[0]!.controls;
    expect(controls.map((c) => c.key)).toEqual(['speed', 'label', 'visible', 'offset', 'target', 'material']);
    expect(controls.find((c) => c.key === 'speed')).toMatchObject({ type: 'number', default: 3.5, current: 4.5 });
    expect(controls.find((c) => c.key === 'speed')?.constraintText).toContain('[-1000, 1000]');

    const drafts = new Map([[overrideDraftKey('model-0001', 'speed'), '7.25']]);
    const collected = collectOverrides(targets, drafts, { entityIds: AFTER.scene.entities.map((e) => e.id), assetIds: ASSET_IDS });
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(collected.overrides).toEqual([{ localId: 'model-0001', key: 'speed', value: 7.25 }]);

    // An invalid numeric input is rejected before any command exists.
    const bad = collectOverrides(targets, new Map([[overrideDraftKey('model-0001', 'speed'), 'nope']]), {});
    expect(bad).toMatchObject({ ok: false, error: { code: 'property_type' } });
  });

  it('derives the same controls from declaration data alone (no code evaluation)', () => {
    const declaration = DECLARATIONS.get('behavior-0001')!;
    const controls = derivePropertyControls(declaration, { speed: 4.5 });
    expect(controls).toHaveLength(declaration.properties.length);
    for (const [i, c] of controls.entries()) {
      expect(c.key).toBe(declaration.properties[i]!.key);
      expect(c.label).toBe(declaration.properties[i]!.label);
      expect(c.type).toBe(declaration.properties[i]!.type);
    }
  });
});

describe('packet 28 — no script evaluation and no apply/revert/variant/link affordance', () => {
  const authoringFiles = [
    'packages/editor/src/session/property-controls.ts',
    'packages/editor/src/session/prefab-authoring.ts',
    'packages/editor/src/session/prefab-projection.ts',
    'packages/editor/src/ui/PrefabPanel.tsx',
    'packages/editor/src/ui/Inspector.tsx',
    'packages/editor/src/ui/PropertyControls.tsx',
  ];

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  }

  it('never evaluates code or imports behavior/script code', () => {
    for (const rel of authoringFiles) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(src, rel).not.toMatch(/\beval\s*\(/);
      expect(src, rel).not.toMatch(/new\s+Function\s*\(/);
      expect(src, rel).not.toMatch(/\bimport\s*\(/);
      expect(src, rel).not.toMatch(/behavior-build|behaviors\/|\.js['"]/);
    }
  });

  it('offers no apply/revert/variant/link control', () => {
    for (const rel of authoringFiles) {
      const src = stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'));
      expect(src.toLowerCase(), rel).not.toMatch(/\b(apply|revert|variant|unlink)\b/);
    }
  });
});
