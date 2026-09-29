/**
 * Captured immutable content view.
 *
 * `captureContent(scene, content, { projectId, revision })` is the single pure
 * derivation of the view over a v3 scene/content pair: the v3 closure adds
 * `components.modelAnimation` references (pinning the binding's recorded
 * version explicitly); the view shape and `contentVersion` stay unchanged.
 *
 * A reference that does not resolve is `asset_reference_missing`, reported
 * before any capture. Pure: no I/O, no filesystem, no three.js.
 */

import { timelineRefs, type TimelineAsset } from './timelines';
import { uiAssetRefs, type UiDocument, type UiTheme } from './ui-documents';
import { dialogueAssetRefs, type DialogueDocument, type DialogueSpeaker } from './dialogue';
import { canonicalJsonText, sha256HexOfText } from './sha256';
import { fail, fieldValue, isPlainObject, withFound } from './validate';
import { ID_RE_V2 } from './components';
import { validateContentV3 } from './content';
import { validateSceneV3 } from './scene-v3';
import { environmentPresetTextureRefs, type EnvironmentPreset } from './environment-presets';
import { animatorAssetIds, type AnimatorController } from './animator';
import { graphAssetRefs, type GraphDocument } from './graph';
import { MATERIAL_FUNCTION_GRAPH_KIND } from './material-graph-kinds';
import { materialFunctionsForRuntime, materialTextureRefs, resolveMaterialInstances, type MaterialDef } from './materials';
import { effectAssetRefs, type EffectDef } from './effects';
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

// ---- closure helpers ----------------------------------------

function declaredAssetRefKeys(content: ContentCatalog): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const b of content.behaviors) {
    out.set(b.behaviorId, new Set(b.declaration.properties.filter((p) => p.type === 'assetRef').map((p) => p.key)));
  }
  return out;
}

// ---- v3 closure -------

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
  // An object may override a graph material's public texture parameter with another texture.
  // Material instances as they draw (their root's parameters, their own values).
  const materialDefs = resolveMaterialInstances((content as { materials?: MaterialDef[] }).materials ?? []);
  const textureKeys = new Map(materialDefs.map((m) => [m.materialId, new Set((m.parameters ?? []).filter((p) => p.type === 'texture').map((p) => p.key))]));
  const addEntity = (e: SceneV3['entities'][number]): void => {
    const overrides = (e.components as { materialParams?: Record<string, Record<string, unknown>> }).materialParams;
    for (const [materialId, values] of Object.entries(overrides ?? {})) {
      for (const [key, v] of Object.entries(values)) if (textureKeys.get(materialId)?.has(key) === true && typeof v === 'string' && v !== '') setRef(v);
    }
    const model = e.components.model;
    if (model) setRef(model.asset.assetId);
    if (e.components.behavior) addBehavior(e.components.behavior.behaviorId, e.components.behavior.values);
    const animation = e.components.modelAnimation;
    if (animation) setRef(animation.assetId, animation.version);
    // An instance set places one model.
    const instances = (e.components as { instances?: { asset: { assetId: string } } }).instances;
    if (instances) setRef(instances.asset.assetId);
    // An audio source's sound.
    const source = (e.components as { audioSource?: { assetId: string } }).audioSource;
    if (source) setRef(source.assetId);
    // A spot light's cookie texture.
    const cookie = (e.components as { light?: { cookie?: string } }).light?.cookie;
    if (cookie !== undefined) setRef(cookie);
  };
  for (const e of scene.entities) addEntity(e);
  for (const d of content.prefabs) for (const e of d.entities) addEntity(e as unknown as SceneV3['entities'][number]);
  // Every texture a project material uses travels with the game.
  // A graph material's texture fields and parameters too, and those of the functions it calls.
  for (const m of materialDefs) for (const id of materialTextureRefs(m)) setRef(id);
  for (const g of materialFunctionsForRuntime(materialDefs, (content as { graphs?: GraphDocument[] }).graphs ?? [])) {
    for (const r of graphAssetRefs(MATERIAL_FUNCTION_GRAPH_KIND, g.graph)) if (r.asset === 'texture') setRef(r.id);
  }
  // The models block types show (prefab looks are captured with the prefabs above).
  for (const t of (content as { blockTypes?: { variants: { model?: { assetId: string } }[] }[] }).blockTypes ?? []) for (const v of t.variants) if (v.model !== undefined) setRef(v.model.assetId);
  // The textures and models the project's effects draw and sample travel with the game.
  for (const fx of (content as { effects?: EffectDef[] }).effects ?? []) for (const r of effectAssetRefs(fx)) setRef(r.id);
  // The project's glyph images (input.glyphs).
  for (const id of Object.values((content as { input?: { glyphs?: Record<string, string> } }).input?.glyphs ?? {})) setRef(id);
  // The textures (images, 9-slices, icons) and fonts the UI documents and themes use.
  const ui = uiAssetRefs((content as { uiDocuments?: UiDocument[] }).uiDocuments, (content as { uiThemes?: UiTheme[] }).uiThemes);
  for (const id of [...ui.textures, ...ui.fonts]) setRef(id);
  // Voice clips, speaker portraits and text blips.
  for (const id of dialogueAssetRefs(content as { dialogues?: DialogueDocument[]; speakers?: DialogueSpeaker[] })) setRef(id);
  // The sounds the timelines play.
  for (const id of timelineRefs((content as { timelines?: TimelineAsset[] }).timelines).assets) setRef(id);
  // The sounds of the event → cue table.
  for (const c of (content as { eventCues?: { assetId: string }[] }).eventCues ?? []) setRef(c.assetId);
  // The sky images and the grading LUT.
  const env = (content as { environment?: { sky?: { texture?: string; cube?: string[] }; post?: { grading?: { lut?: string } } } }).environment;
  if (env?.sky?.texture !== undefined) setRef(env.sky.texture);
  for (const id of env?.sky?.cube ?? []) setRef(id);
  if (env?.post?.grading?.lut !== undefined) setRef(env.post.grading.lut);
  // The environment presets' sky images and LUTs.
  for (const id of environmentPresetTextureRefs((content as { environment?: { presets?: EnvironmentPreset[] } }).environment?.presets)) setRef(id);
  // The models an animator controller takes clips from.
  // The override layers' clips too.
  for (const c of (content as { animators?: AnimatorController[] }).animators ?? []) for (const id of animatorAssetIds(c)) setRef(id);
  // The lightmap atlases of every scene's bake.
  for (const bake of Object.values((content as { lighting?: Record<string, { atlases: string[] }> }).lighting ?? {})) for (const id of bake.atlases) setRef(id);
  return [...refs.entries()].map(([assetId, version]) => ({ assetId, version })).sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
}

// ---- public entry point ------------------------------------------------------

/**
 * `captureContent(scene, content, { projectId, revision })`: the pure
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
