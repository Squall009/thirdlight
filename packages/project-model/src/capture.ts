/**
 * Captured immutable content view — project-model.md §19.
 *
 * `captureContent(scene, content, { projectId, revision })` is the single pure
 * derivation of the view (sessions.md §17.1; workspace.md §16.6 item 4) over
 * a v3 scene/content pair (the v2 pair was removed in phase 9.3): the v3
 * closure adds `components.modelAnimation` references (pinning the binding's recorded
 * version explicitly) and the non-null `content.game` cue / checkpoint
 * `activation.cueAssetId` references; the view shape and `contentVersion` stay
 * unchanged (§19.1/§16.6).
 *
 * A reference that does not resolve is `asset_reference_missing`, reported
 * before any capture. Pure: no I/O, no filesystem, no three.js.
 */

import { canonicalJsonText, sha256HexOfText } from './sha256';
import { fail, fieldValue, isPlainObject, withFound } from './validate';
import { ID_RE_V2 } from './components';
import { validateContentV3 } from './content';
import { validateSceneV3 } from './scene-v3';
import { flowAssetRefs, type GameFlow } from './flow';
import type { ModelErrorV2, ModelResultV2 } from './errors';
import type { CapturedAsset, CapturedContent, ContentCatalog, ImportRecipe, PropertyValue } from './types-v2';
import type { ContentCatalogV3, SceneV3 } from './types-v3';

function tag(errors: readonly ModelErrorV2[], document: 'scene' | 'content'): ModelErrorV2[] {
  return errors.map((e) => ({ ...e, document }));
}

function checkCtx(ctx: { projectId: string; revision: number }): ModelErrorV2[] {
  const errors: ModelErrorV2[] = [];
  if (!isPlainObject(ctx) || typeof ctx.projectId !== 'string' || !ID_RE_V2.test(ctx.projectId)) {
    errors.push(fieldValue('/projectId', isPlainObject(ctx) ? ctx['projectId'] : ctx, 'a project ID string', 'captureContent requires a valid projectId'));
  }
  if (!isPlainObject(ctx) || typeof ctx.revision !== 'number' || !Number.isInteger(ctx.revision) || ctx.revision < 0) {
    errors.push(fieldValue('/revision', isPlainObject(ctx) ? ctx['revision'] : ctx, 'a non-negative integer revision', 'captureContent requires a valid revision'));
  }
  return errors;
}

function view(
  assets: CapturedAsset[],
  ctx: { projectId: string; revision: number },
): CapturedContent {
  const withoutDigest = {
    contentVersion: 1 as const,
    projectId: ctx.projectId,
    revision: ctx.revision,
    assets,
  };
  const digest = sha256HexOfText(canonicalJsonText(withoutDigest));
  return { ...withoutDigest, contentDigest: digest };
}

// ---- closure helpers (§19.2 steps 1–2) ----------------------------------------

function declaredAssetRefKeys(content: ContentCatalog): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const b of content.behaviors) {
    out.set(b.behaviorId, new Set(b.declaration.properties.filter((p) => p.type === 'assetRef').map((p) => p.key)));
  }
  return out;
}

// ---- v3 closure (§19.2 step 1 v3 additions; workspace.md §16.6 item 4) -------

/** A reachable asset with either an explicit pinned version or `null` (current). */
export type AssetRefV3 = { assetId: string; version: number | null };

export function collectAssetRefsV3(scene: SceneV3, content: ContentCatalogV3): AssetRefV3[] {
  const refs = new Map<string, number | null>();
  const setRef = (assetId: string, explicitVersion?: number): void => {
    const current = refs.get(assetId);
    if (explicitVersion === undefined) {
      if (!refs.has(assetId)) refs.set(assetId, null);
      return;
    }
    // A modelAnimation binding pins its recorded version explicitly; it wins
    // over a plain currentVersion reference. Two different explicit versions
    // for one assetId are not resolved by the contract (handoff 44 CC-44-6):
    // the first recorded binding wins deterministically.
    if (current === undefined || current === null) refs.set(assetId, explicitVersion);
  };
  const declared = declaredAssetRefKeys(content as unknown as ContentCatalog);
  const addBehavior = (behaviorId: string, values: Record<string, PropertyValue>): void => {
    const keys = declared.get(behaviorId);
    if (!keys) return;
    for (const k of keys) {
      const v = values[k];
      if (typeof v === 'string') setRef(v);
    }
  };
  const addEntity = (e: SceneV3['entities'][number]): void => {
    const model = e.components.model;
    if (model) setRef(model.asset.assetId);
    if (e.components.behavior) addBehavior(e.components.behavior.behaviorId, e.components.behavior.values);
    const animation = e.components.modelAnimation;
    if (animation) setRef(animation.assetId, animation.version);
    const activation = e.components.gameZone?.activation;
    if (activation && activation.cueAssetId !== null) setRef(activation.cueAssetId);
    // Phase 12 (c): an instance set places one model.
    const instances = (e.components as { instances?: { asset: { assetId: string } } }).instances;
    if (instances) setRef(instances.asset.assetId);
    // Phase 9.10: an audio source's sound.
    const source = (e.components as { audioSource?: { assetId: string } }).audioSource;
    if (source) setRef(source.assetId);
    // Phase 9.9: a pickup's collect sound.
    const cue = (e.components as { pickup?: { cue?: string } }).pickup?.cue;
    if (cue !== undefined) setRef(cue);
  };
  for (const e of scene.entities) addEntity(e);
  for (const d of content.prefabs) for (const e of d.entities) addEntity(e as unknown as SceneV3['entities'][number]);
  // Phase 9.4: every texture a project material uses travels with the game.
  for (const m of (content as { materials?: { textures: Record<string, string> }[] }).materials ?? []) {
    for (const id of Object.values(m.textures)) setRef(id);
  }
  // Phase 9.10: the flow's music and menu logo.
  const flow = (content as { flow?: GameFlow }).flow;
  if (flow !== undefined) {
    const refs = flowAssetRefs(flow);
    for (const id of [...refs.music, ...refs.textures, ...refs.menuSounds, ...refs.ambience]) setRef(id);
  }
  // Phase 9.5: the sky images and the grading LUT.
  const env = (content as { environment?: { sky?: { texture?: string; cube?: string[] }; post?: { grading?: { lut?: string } } } }).environment;
  if (env?.sky?.texture !== undefined) setRef(env.sky.texture);
  for (const id of env?.sky?.cube ?? []) setRef(id);
  if (env?.post?.grading?.lut !== undefined) setRef(env.post.grading.lut);
  // Phase 9.7: the models an animator controller takes clips from.
  for (const c of (content as { animators?: { states: { motion: { kind: string; clip?: { assetId: string }; children?: { clip: { assetId: string } }[] } }[] }[] }).animators ?? []) {
    for (const s of c.states) {
      if (s.motion.clip !== undefined) setRef(s.motion.clip.assetId);
      for (const k of s.motion.children ?? []) setRef(k.clip.assetId);
    }
  }
  // Phase 9.6: the lightmap atlases of every scene's bake.
  for (const bake of Object.values((content as { lighting?: Record<string, { atlases: string[] }> }).lighting ?? {})) for (const id of bake.atlases) setRef(id);
  const game = content.game;
  if (game !== null) {
    for (const k of ['start', 'jump', 'checkpoint', 'death', 'goal'] as const) {
      const ref = game.cues[k];
      if (ref !== null) setRef(ref);
    }
  }
  return [...refs.entries()].map(([assetId, version]) => ({ assetId, version })).sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
}

// ---- public entry point ------------------------------------------------------

/**
 * §19.2 `captureContent(scene, content, { projectId, revision })`: the pure
 * captured immutable content view for a v3 pair.
 */
export function captureContent(
  scene: unknown,
  content: unknown,
  ctx: { projectId: string; revision: number },
): ModelResultV2<CapturedContent> {
  const ctxErrors = checkCtx(ctx);
  if (ctxErrors.length > 0) return fail(ctxErrors);
  const s = validateSceneV3(scene);
  if (!s.ok) return fail(tag(s.errors, 'scene'));
  const c = validateContentV3(content);
  if (!c.ok) return fail(tag(c.errors, 'content'));
  return captureV3(s.normalized as SceneV3, c.normalized as ContentCatalogV3, ctx);
}

function captureV3(
  scene: SceneV3,
  content: ContentCatalogV3,
  ctx: { projectId: string; revision: number },
): ModelResultV2<CapturedContent> {
  const byId = new Map(content.assets.map((a) => [a.assetId, a]));
  const errors: ModelErrorV2[] = [];
  const assets: CapturedAsset[] = [];
  for (const ref of collectAssetRefsV3(scene, content)) {
    const record = byId.get(ref.assetId);
    if (!record) {
      errors.push(
        withFound({ code: 'asset_reference_missing', path: '', document: 'scene', message: 'a captured scene reference resolves to no catalog record', expected: 'an existing assetId in content.assets' }, ref.assetId),
      );
      continue;
    }
    const wanted = ref.version ?? record.currentVersion;
    const version = record.versions.find((v) => v.version === wanted);
    if (!version) {
      errors.push(
        withFound(
          { code: 'asset_version_invalid', path: '', document: 'scene', message: 'a captured modelAnimation binding names a version the record does not have', expected: `an existing version 1..${record.currentVersion}` },
          wanted,
        ),
      );
      continue;
    }
    assets.push({
      assetId: ref.assetId,
      version: version.version,
      sourceDigest: version.sourceDigest,
      sourceByteLength: version.sourceByteLength,
      importRecipe: version.importRecipe as unknown as ImportRecipe,
    });
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: view(assets, ctx) };
}
