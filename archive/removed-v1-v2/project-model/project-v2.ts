/**
 * Three-block v2 composition — project-model.md §13.1 (`validateProjectV2`)
 * and §13.2 (behavior/trust/linked-output composition). The captured content
 * view (§19) lives in `capture.ts` and accepts both the v2 and v3 pairs.
 *
 * Pure: no I/O, no filesystem, no three.js. Cross-block checks run only when
 * all three blocks pass (§13.1).
 */

import { fail, fieldValue, isPlainObject, withFound } from './validate';
import { validateContent } from './content';
import { ID_RE_V2, validateSceneV2 } from './scene-v2';
import { validateManifest } from './validate';
import type { ModelErrorV2, ModelResultV2 } from './errors';
import type {
  BehaviorComponent,
  ContentCatalog,
  DeclaredProperty,
  EntityV2,
  ModelComponent,
  PrefabProvenanceComponent,
  PropertyValue,
  SceneV2,
} from './types-v2';
import type { Manifest as M1Manifest } from './types';

function tag(errors: readonly ModelErrorV2[], document: 'manifest' | 'scene' | 'content'): ModelErrorV2[] {
  return errors.map((e) => ({ ...e, document }));
}

function checkDeclaredValue(
  prop: DeclaredProperty,
  value: unknown,
  path: string,
  errors: ModelErrorV2[],
  resolveEntityRef: (id: string) => boolean,
  resolveAssetRef: (id: string) => boolean,
  document: 'scene' | 'content',
): void {
  const expectType = (expected: string): void => {
    errors.push(withFound({ code: 'property_type', path, message: `value must match declared type ${prop.type}`, expected, document }, value));
  };
  const expectValue = (expected: string): void => {
    errors.push(withFound({ code: 'property_value', path, message: `value violates the declared constraints of ${prop.type}`, expected, document }, value));
  };
  switch (prop.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return expectType('finite number');
      if ((prop.min !== undefined && value < prop.min) || (prop.max !== undefined && value > prop.max)) return expectValue('within [min, max]');
      return;
    case 'boolean':
      if (typeof value !== 'boolean') expectType('boolean');
      return;
    case 'string': {
      if (typeof value !== 'string') return expectType('string');
      const maxLength = prop.maxLength ?? 256;
      if ([...value].length > maxLength) return expectValue(`length <= ${maxLength}`);
      return;
    }
    case 'enum':
      if (typeof value !== 'string') return expectType('string enum member');
      if (!(prop.values ?? []).includes(value)) return expectValue('one of the declared enum values');
      return;
    case 'vec3':
      if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return expectType('[number, number, number]');
      }
      if (prop.bounds) {
        for (let i = 0; i < 3; i++) {
          const n = value[i] as number;
          if (n < prop.bounds.min[i]! || n > prop.bounds.max[i]!) return expectValue('component-wise within bounds');
        }
      }
      return;
    case 'entityRef':
      if (value === null) return;
      if (typeof value !== 'string' || !ID_RE_V2.test(value)) return expectType('an entity ID string or null');
      if (!resolveEntityRef(value)) {
        errors.push(withFound({ code: 'reference_missing', path, message: 'entityRef does not resolve in this document', expected: 'an existing scene entity id (or a definition localId)', document }, value));
      }
      return;
    case 'assetRef':
      if (value === null) return;
      if (typeof value !== 'string' || !ID_RE_V2.test(value)) return expectType('an assetId string or null');
      if (!resolveAssetRef(value)) {
        errors.push(withFound({ code: 'asset_reference_missing', path, message: 'assetRef does not resolve in content.assets', expected: 'an existing assetId', document }, value));
      }
      return;
    default:
      expectType('a known property type');
  }
}

interface BehaviorCheckContext {
  behaviors: Map<string, DeclaredProperty[]>;
  assetIds: Set<string>;
  entityIds: Set<string>;
  localIds?: Set<string>;
}

function checkBehaviorValues(
  component: { behaviorId: string; values: Record<string, PropertyValue> } | undefined,
  path: string,
  errors: ModelErrorV2[],
  ctx: BehaviorCheckContext,
  document: 'scene' | 'content',
): void {
  if (!component) return;
  const declaration = ctx.behaviors.get(component.behaviorId);
  if (!declaration) {
    errors.push(
      withFound(
        { code: 'behavior_reference_missing', path: `${path}/behaviorId`, message: 'behaviorId does not resolve in content.behaviors', expected: 'a behavior record in content.behaviors', document },
        component.behaviorId,
      ),
    );
    return;
  }
  const declared = new Map(declaration.map((p) => [p.key, p]));
  for (const key of Object.keys(component.values)) {
    if (!declared.has(key)) {
      errors.push(
        withFound(
          { code: 'property_unknown', path: `${path}/values/${key}`, message: 'value key is not declared by the resolved behavior declaration (never dropped)', expected: 'a declared property key', document },
          key,
        ),
      );
    }
  }
  for (const prop of declaration) {
    if (!Object.prototype.hasOwnProperty.call(component.values, prop.key)) {
      errors.push(
        withFound(
          { code: 'property_value', path: `${path}/values/${prop.key}`, message: 'every declared property key must have a stored value (defaults are filled)', expected: 'a stored value for every declared key', document },
          undefined,
        ),
      );
      continue;
    }
    checkDeclaredValue(
      prop,
      component.values[prop.key],
      `${path}/values/${prop.key}`,
      errors,
      (id) => (ctx.localIds ? ctx.localIds.has(id) : ctx.entityIds.has(id)),
      (id) => ctx.assetIds.has(id),
      document,
    );
  }
}

/**
 * §13.1 `validateProjectV2`: validate manifest (v1), the embedded v2 scene and
 * the content block; when all three pass, run the cross-block checks.
 */
export function validateProjectV2(
  manifest: unknown,
  scene: unknown,
  content: unknown,
): ModelResultV2<{ manifest: M1Manifest; scene: SceneV2; content: ContentCatalog }> {
  const m = validateManifest(manifest);
  const s = validateSceneV2(scene);
  const c = validateContent(content);
  const errors: ModelErrorV2[] = [];
  if (!m.ok) errors.push(...tag(m.errors, 'manifest'));
  if (!s.ok) errors.push(...tag(s.errors, 'scene'));
  if (!c.ok) errors.push(...tag(c.errors, 'content'));
  if (!m.ok || !s.ok || !c.ok) return fail(errors);

  const mm = m.normalized as M1Manifest;
  const ss = s.normalized as SceneV2;
  const cc = c.normalized as ContentCatalog;

  // §13 check 1: manifest/scene id equality.
  if (mm.scenes[0]!.id !== ss.sceneId) {
    errors.push(
      withFound(
        {
          code: 'manifest_scene_mismatch',
          path: '/scenes/0/id',
          document: 'manifest',
          message: 'manifest scenes[0].id does not equal the scene document sceneId',
          expected: 'scene document sceneId',
        },
        mm.scenes[0]!.id,
      ),
    );
  }

  const assetIds = new Set(cc.assets.map((a) => a.assetId));
  const entityIds = new Set(ss.entities.map((e) => e.id));
  const behaviors = new Map(cc.behaviors.map((b) => [b.behaviorId, b.declaration.properties]));
  const ctx: BehaviorCheckContext = { behaviors, assetIds, entityIds };

  crossBlockV2(ss, cc, errors, ctx);

  if (errors.length > 0) {
    // Cross-block errors are already tagged where relevant; ensure document tags.
    return fail(errors.map((e) => (e.document ? e : { ...e, document: 'scene' as const })));
  }
  return { ok: true, normalized: { manifest: mm, scene: ss, content: cc } };
}

/** The scene/content shape the accepted v2 cross-block checks read. */
export interface CrossBlockScene {
  revision: number;
  entities: readonly {
    id: string;
    components: {
      model?: ModelComponent;
      behavior?: BehaviorComponent;
      prefab?: PrefabProvenanceComponent;
    };
  }[];
}

/**
 * The accepted §13.1/§13.2 cross-block checks over already-validated blocks
 * (checks 1–7 plus the publishedRevision ordering). Shared by
 * `validateProjectV2` and the v3 `validateProjectV3` (§13.2: the v2
 * cross-block check is part of the v3 composition).
 */
export function crossBlockV2(
  ss: CrossBlockScene,
  cc: ContentCatalog,
  errors: ModelErrorV2[],
  ctxIn?: BehaviorCheckContext,
): void {
  const assetIds = ctxIn?.assetIds ?? new Set(cc.assets.map((a) => a.assetId));
  const entityIds = ctxIn?.entityIds ?? new Set(ss.entities.map((e) => e.id));
  const behaviors = ctxIn?.behaviors ?? new Map(cc.behaviors.map((b) => [b.behaviorId, b.declaration.properties]));
  const ctx: BehaviorCheckContext = { behaviors, assetIds, entityIds };

  // §13.1 check 1: every scene model reference resolves.
  ss.entities.forEach((e, i) => {
    const model = e.components.model;
    if (model && !assetIds.has(model.asset.assetId)) {
      errors.push(
        withFound(
          {
            code: 'asset_reference_missing',
            path: `/entities/${i}/components/model/asset/assetId`,
            document: 'scene',
            message: 'scene model reference resolves to no catalog record',
            expected: 'an existing assetId in content.assets',
          },
          model.asset.assetId,
        ),
      );
    }
  });

  // §13.1 check 2: behavior ids/values in the scene and inside definitions.
  ss.entities.forEach((e, i) => {
    checkBehaviorValues(e.components.behavior, `/entities/${i}/components/behavior`, errors, ctx, 'scene');
  });
  cc.prefabs.forEach((d, di) => {
    const localIds = new Set(d.entities.map((e) => e.localId));
    const defCtx: BehaviorCheckContext = { behaviors, assetIds, entityIds, localIds };
    d.entities.forEach((e, ei) => {
      checkBehaviorValues(e.components.behavior, `/prefabs/${di}/entities/${ei}/components/behavior`, errors, defCtx, 'content');
    });
  });

  // §13.1 check 3: prefab provenance resolves to a definition + localId.
  ss.entities.forEach((e, i) => {
    const prov = e.components.prefab;
    if (!prov) return;
    const def = cc.prefabs.find((d) => d.prefabId === prov.prefabId);
    if (!def || !def.entities.some((de) => de.localId === prov.localId)) {
      errors.push(
        withFound(
          {
            code: 'prefab_reference_missing',
            path: `/entities/${i}/components/prefab`,
            document: 'scene',
            message: 'prefab provenance does not resolve to a definition/localId',
            expected: 'an existing prefabId and localId in content.prefabs',
          },
          prov,
        ),
      );
    }
  });

  // §13.2 step 5 / §18.9.2 step 4: publication revisions never exceed the revision.
  cc.assets.forEach((a, ai) => {
    a.versions.forEach((v, vi) => {
      if (v.publishedRevision > ss.revision) {
        errors.push(
          {
            ...fieldValue(
              `/assets/${ai}/versions/${vi}/publishedRevision`,
              v.publishedRevision,
              `<= scene.revision (${ss.revision})`,
              'a publishedRevision must not exceed the envelope revision',
            ),
            document: 'content',
          },
        );
      }
    });
  });
  cc.behaviors.forEach((b, bi) => {
    if (b.publishedRevision > ss.revision) {
      errors.push(
        {
          ...fieldValue(`/behaviors/${bi}/publishedRevision`, b.publishedRevision, `<= scene.revision (${ss.revision})`, 'a publishedRevision must not exceed the envelope revision'),
          document: 'content',
        },
      );
    }
    if (b.source && b.source.publishedRevision > ss.revision) {
      errors.push(
        withFound(
          { code: 'number_out_of_range', path: `/behaviors/${bi}/source/publishedRevision`, document: 'content', message: 'source.publishedRevision must not exceed the envelope revision', expected: `<= ${ss.revision}` },
          b.source.publishedRevision,
        ),
      );
    }
  });
}
