/**
 * Bounded glTF 2.0 GLB inspection — the GLB import profile of
 * project-model.md.
 *
 * `inspectGlb(bytes, options)` runs the normative validation order and
 * stops at the first failing step, returning an `ImportProposal` with
 * `status: "rejected"` and that step's diagnostics (earlier steps' diagnostics
 * are never re-reported). A step may report several independent diagnostics;
 * at most `M2_GLTF_MAX_DIAGNOSTICS` are returned plus the true count.
 *
 * Purity: bytes in, proposal out. No I/O, no
 * Node built-ins, no `three`/GLTFLoader (the profile *is* the inspector), no
 * cache writes, no asset-ID decisions, no plugin registry, no URL fetch —
 * external/`data:` URIs are rejected, never resolved. The result is
 * deep-frozen validated data.
 *
 * Determinism: for fixed `(bytes, profile, recipeVersion,
 * toolchain, job values)` the result is byte-identical. The only clock reads
 * are the injected job port's `now()` calls for the bounded timeout, and no
 * wall-clock value is ever persisted in the proposal.
 */

import { canonicalJsonText, deepFreezeAll, sha256Hex, sha256HexOfText } from '@thirdlight/shared';
import type { AssetMetrics, ImportRecipe } from '@thirdlight/project-model';
import type { AudioImportProposal, AudioRecipe } from './inspect-audio';
import {
  ANIMATION_ROLE_KEYS,
  ANIMATION_ROLE_NAME_CHARS,
  M2_GLTF_EXTENSION_ALLOWLIST,
  M2_GLTF_IMAGE_BYTES,
  M2_GLTF_INSPECTION_ENTRIES,
  M2_GLTF_INSPECTION_NAME_CHARS,
  M2_GLTF_INSPECTION_TIMEOUT_MS,
  M2_GLTF_JSON_CHUNK_BYTES,
  M2_GLTF_MAX_DIAGNOSTICS,
  M2_GLTF_PROFILE_LIMITS,
  M2_GLTF_SOURCE_BYTES,
  M2_GLTF_TOOLCHAIN,
} from './limits';
import type { ImportDiagnostic, ImportInspection, ImportJobPort, ImportLimits, ImportMetadataFacts, ImportOptions, ImportProposal, PrepareImportOptions } from './types';
import { isPlainObject, diag, ptr, GlbState, type ResolvedAnimation, type ResolvedJob } from './inspect-glb-state';
import { checkContainer, checkChunks, checkJson, checkVersionAndExtensions } from './inspect-glb-container';
import { checkBuffers, checkBufferViews, checkAccessors } from './inspect-glb-buffers';
import { checkMeshes, checkRigCaps } from './inspect-glb-meshes';
import { checkMaterials, checkImages, checkTextures } from './inspect-glb-materials';
import { checkAnimations, checkAnimationProfile } from './inspect-glb-animation';
import { checkNodesAndScenes, computeMetrics, checkMetricCaps } from './inspect-glb-scene';

/** `suggestedDisplayName`: 1–128 chars, no control characters, never an id. */
export function sanitizeDisplayName(input: unknown): string {
  if (typeof input !== 'string') return '';
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += ch;
    if (out.length >= M2_GLTF_INSPECTION_NAME_CHARS) break;
  }
  return out.trim();
}

// --- injected job port -------------------------------------------------------

export type { ResolvedJob };

const RE_PROPOSAL_ID = /^p-[0-9a-f]{32}$/;

export function resolveImportJob(
  job: ImportJobPort | undefined,
  options: { readonly displayName?: string },
  sourceDigest: string,
): ResolvedJob {
  if (job === undefined) {
    // Pure inspection mode: no clock, no cancellation, deterministic identity
    // derived from the source digest (the proposal is non-authoritative and is
    // never persisted).
    return {
      now: () => 0,
      isCancelled: () => false,
      proposalId: `p-${sha256HexOfText(`thirdlight.import-proposal|${sourceDigest}`).slice(0, 32)}`,
      stageId: '',
      expiresAt: '',
      timeoutMs: M2_GLTF_INSPECTION_TIMEOUT_MS,
      suggestedDisplayName: sanitizeDisplayName(options.displayName),
    };
  }
  if (typeof job !== 'object' || job === null) {
    throw new TypeError('inspectGlb: job must be an object implementing ImportJobPort');
  }
  const proposalId = job.proposalId();
  if (typeof proposalId !== 'string' || !RE_PROPOSAL_ID.test(proposalId)) {
    throw new TypeError("inspectGlb: job.proposalId() must be 'p-' + 32 lowercase hex");
  }
  const stageId = job.stageId();
  if (typeof stageId !== 'string' || stageId.length === 0) {
    throw new TypeError('inspectGlb: job.stageId() must be a non-empty string');
  }
  const expiresAt = job.expiresAt();
  if (typeof expiresAt !== 'string' || expiresAt.length === 0) {
    throw new TypeError('inspectGlb: job.expiresAt() must be a non-empty timestamp string');
  }
  const timeoutMs = job.timeoutMs ?? M2_GLTF_INSPECTION_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('inspectGlb: job.timeoutMs must be a positive finite number');
  }
  const name = job.suggestedDisplayName ?? options.displayName;
  return {
    now: () => job.now(),
    isCancelled: () => job.isCancelled(),
    proposalId,
    stageId,
    expiresAt,
    timeoutMs,
    suggestedDisplayName: sanitizeDisplayName(name),
  };
}

// --- options -----------------------------------------------------------------

function resolveToolchain(options: ImportOptions): Readonly<Record<string, string>> {
  const tc = options.toolchain;
  if (!isPlainObject(tc)) throw new TypeError('inspectGlb: toolchain must be an object');
  const names = Object.keys(tc).sort();
  if (names.length !== 1 || names[0] !== 'three') {
    throw new TypeError(
      "inspectGlb: the M2 toolchain must name exactly the pinned loader line ('three')",
    );
  }
  if (tc['three'] !== M2_GLTF_TOOLCHAIN.three) {
    throw new TypeError(
      `inspectGlb: toolchain.three must be the pinned value '${M2_GLTF_TOOLCHAIN.three}'`,
    );
  }
  return { three: M2_GLTF_TOOLCHAIN.three };
}

// --- role-aware animation profile ---------------------

const RE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validate the supplied animated-profile request. Malformed *options* are a
 * caller programming error (stage 1–2 binding-field validation is the
 * model's), so they throw `TypeError` like every other option here; the
 * stages the pipeline does own (3–6 and A1–A6) report diagnostics.
 */
function resolveAnimation(options: ImportOptions): ResolvedAnimation | null {
  const animation = options.animation;
  if (animation === undefined) return null;
  if (!isPlainObject(animation)) throw new TypeError('inspectGlb: options.animation must be an object');
  if (animation['entityId'] !== undefined && typeof animation['entityId'] !== 'string') {
    throw new TypeError('inspectGlb: options.animation.entityId must be a string');
  }
  const roles = animation['roles'];
  if (!isPlainObject(roles)) throw new TypeError('inspectGlb: options.animation.roles must be an object');
  const keys = Object.keys(roles);
  for (const role of ANIMATION_ROLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(roles, role)) {
      throw new TypeError(`inspectGlb: options.animation.roles.${role} is required`);
    }
  }
  for (const k of keys) {
    if (!(ANIMATION_ROLE_KEYS as readonly string[]).includes(k)) {
      throw new TypeError(`inspectGlb: options.animation.roles.${k} is not a role key`);
    }
  }
  const resolved: Record<string, { clipIndex: number; clipName: string }> = {};
  for (const role of ANIMATION_ROLE_KEYS) {
    const binding = roles[role];
    if (!isPlainObject(binding)) {
      throw new TypeError(`inspectGlb: options.animation.roles.${role} must be an object`);
    }
    const clipIndex = binding['clipIndex'];
    if (typeof clipIndex !== 'number' || !Number.isSafeInteger(clipIndex) || clipIndex < 0) {
      throw new TypeError(`inspectGlb: options.animation.roles.${role}.clipIndex must be a non-negative integer`);
    }
    const clipName = binding['clipName'];
    if (
      typeof clipName !== 'string' ||
      clipName.length === 0 ||
      clipName.length > ANIMATION_ROLE_NAME_CHARS ||
      RE_CONTROL_CHARS.test(clipName)
    ) {
      throw new TypeError(
        `inspectGlb: options.animation.roles.${role}.clipName must be 1-${ANIMATION_ROLE_NAME_CHARS} characters without control characters`,
      );
    }
    resolved[role] = { clipIndex, clipName };
  }
  return {
    entityId: typeof animation['entityId'] === 'string' ? animation['entityId'] : '',
    roles: resolved as ResolvedAnimation['roles'],
  };
}

// --- the pipeline ------------------------------------------------------------

class Inspector extends GlbState {
  private startedAt = 0;

  private limits(): ImportLimits {
    return {
      profile: 'gltf-glb',
      recipeVersion: 1,
      sourceBytes: M2_GLTF_SOURCE_BYTES,
      jsonChunkBytes: M2_GLTF_JSON_CHUNK_BYTES,
      imageBytes: M2_GLTF_IMAGE_BYTES,
      timeoutMs: this.job.timeoutMs,
      caps: M2_GLTF_PROFILE_LIMITS,
    };
  }

  private inspection(): ImportInspection {
    const names = (values: unknown): { list: string[]; truncated: boolean } => {
      const list: string[] = [];
      let truncated = false;
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value !== 'string') continue;
          if (list.length >= M2_GLTF_INSPECTION_ENTRIES) {
            truncated = true;
            break;
          }
          if (value.length > M2_GLTF_INSPECTION_NAME_CHARS) {
            list.push(value.slice(0, M2_GLTF_INSPECTION_NAME_CHARS));
            truncated = true;
          } else {
            list.push(value);
          }
        }
      }
      return { list, truncated };
    };
    const nodeNames = names(this.collection('nodes').map((n) => (isPlainObject(n) ? n['name'] : undefined)));
    const materialNames = names(
      this.collection('materials').map((m) => (isPlainObject(m) ? m['name'] : undefined)),
    );
    const clipNames = names(
      this.collection('animations').map((a) => (isPlainObject(a) ? a['name'] : undefined)),
    );
    const scenes = this.json['scenes'];
    return {
      nodeNames: nodeNames.list,
      materialNames: materialNames.list,
      clipNames: clipNames.list,
      sceneCount: Array.isArray(scenes) ? scenes.length : 0,
      truncated: nodeNames.truncated || materialNames.truncated || clipNames.truncated,
    };
  }

  /** The used, allowlisted extensions of this source (sorted). */
  private usedExtensions(): string[] {
    const used = this.json['extensionsUsed'];
    if (!Array.isArray(used)) return [];
    const out = new Set<string>();
    for (const e of used) {
      if (typeof e === 'string' && M2_GLTF_EXTENSION_ALLOWLIST.includes(e)) out.add(e);
    }
    return [...out].sort();
  }

  private proposal(
    status: 'ok' | 'rejected',
    diagnostics: ImportDiagnostic[],
    metrics: AssetMetrics | null,
  ): ImportProposal {
    const base = {
      proposalId: this.job.proposalId,
      stageId: this.job.stageId,
      sourceDigest: this.sourceDigest,
      sourceByteLength: this.bytes.length,
      status,
      importRecipe: { ...this.recipe, extensions: this.usedExtensions() },
      suggestedDisplayName: this.job.suggestedDisplayName,
      inspection: this.inspection(),
      diagnostics: diagnostics.slice(0, M2_GLTF_MAX_DIAGNOSTICS),
      diagnosticCount: diagnostics.length,
      expiresAt: this.job.expiresAt,
      limits: this.limits(),
    };
    if (status === 'ok' && metrics !== null) {
      return deepFreezeAll({ ...base, kind: 'model' as const, metrics });
    }
    return deepFreezeAll(base);
  }

  private reject(diagnostics: ImportDiagnostic[]): ImportProposal {
    return this.proposal('rejected', diagnostics, null);
  }

  /** `null` = proceed; otherwise the timeout/cancellation rejection. */
  private guard(): ImportProposal | null {
    if (this.job.isCancelled()) {
      return this.reject([
        diag('asset_timeout', '', 'inspection cancelled by the caller', {
          expected: 'inspection to finish within the job budget',
        }),
      ]);
    }
    if (this.job.now() - this.startedAt > this.job.timeoutMs) {
      return this.reject([
        diag('asset_timeout', '', `inspection exceeded the ${this.job.timeoutMs} ms job limit`, {
          expected: 'inspection to finish within the job budget',
        }),
      ]);
    }
    return null;
  }

  run(): ImportProposal {
    this.startedAt = this.job.now();

    // 0 — injected job cancellation/deadline.
    let g = this.guard();
    if (g !== null) return g;

    // 1 — size.
    if (this.bytes.length < 1 || this.bytes.length > M2_GLTF_SOURCE_BYTES) {
      return this.reject([
        diag('asset_size_exceeded', '', `source must be 1-${M2_GLTF_SOURCE_BYTES} bytes`, {
          found: this.bytes.length,
          expected: `1 .. ${M2_GLTF_SOURCE_BYTES}`,
          limit: 'source_bytes',
        }),
      ]);
    }

    // 2 — container.
    g = this.guard();
    if (g !== null) return g;
    const container = checkContainer(this);
    if (container !== null) return this.reject(container);

    // 3 — chunk framing (also fills this.bin).
    g = this.guard();
    if (g !== null) return g;
    const framing = checkChunks(this);
    if (framing !== null) return this.reject(framing);

    // 4 — strict JSON.
    g = this.guard();
    if (g !== null) return g;
    const json = checkJson(this);
    if (json !== null) return this.reject(json);

    // 5 — glTF version and extensions.
    g = this.guard();
    if (g !== null) return g;
    const version = checkVersionAndExtensions(this);
    if (version !== null) return this.reject(version);

    // 6 — buffers.
    g = this.guard();
    if (g !== null) return g;
    const buffers = checkBuffers(this);
    if (buffers !== null) return this.reject(buffers);

    // 7 — bufferViews.
    g = this.guard();
    if (g !== null) return g;
    const bufferViews = checkBufferViews(this);
    if (bufferViews !== null) return this.reject(bufferViews);

    // 8 — accessors.
    g = this.guard();
    if (g !== null) return g;
    const accessors = checkAccessors(this);
    if (accessors !== null) return this.reject(accessors);

    // 9 — meshes and primitives.
    g = this.guard();
    if (g !== null) return g;
    const meshes = checkMeshes(this);
    if (meshes !== null) return this.reject(meshes);

    // 10 — materials.
    g = this.guard();
    if (g !== null) return g;
    const materials = checkMaterials(this);
    if (materials !== null) return this.reject(materials);

    // 11 — images.
    g = this.guard();
    if (g !== null) return g;
    const images = checkImages(this);
    if (images !== null) return this.reject(images);

    // 12 — textures and samplers.
    g = this.guard();
    if (g !== null) return g;
    const textures = checkTextures(this);
    if (textures !== null) return this.reject(textures);

    // 13 — animations.
    g = this.guard();
    if (g !== null) return g;
    const animations = checkAnimations(this);
    if (animations !== null) return this.reject(animations);

    // 14 — nodes and scenes.
    g = this.guard();
    if (g !== null) return g;
    const nodes = checkNodesAndScenes(this);
    if (nodes !== null) return this.reject(nodes);

    // 14b — skin and morph target caps (≤ 4 influences: only JOINTS_0/WEIGHTS_0 are allowed attributes).
    const rig = checkRigCaps(this);
    if (rig !== null) return this.reject(rig);

    // 15 — decoded limits.
    g = this.guard();
    if (g !== null) return g;
    const metrics = computeMetrics(this);
    const limits = checkMetricCaps(metrics, this.imageDecodedBytes);
    if (limits.length > 0) return this.reject(limits);

    // 16 — non-empty.
    g = this.guard();
    if (g !== null) return g;
    if ((metrics.meshes === 0 || metrics.vertices === 0) && !(metrics.meshes === 0 && this.animationOnly())) {
      return this.reject([
        diag('asset_empty_model', ptr('meshes'), 'a model must carry geometry', {
          found: { meshes: metrics.meshes, vertices: metrics.vertices },
          expected: 'meshes >= 1 and vertices >= 1',
        }),
      ]);
    }

    // 16b — animated-model profile (stages 3–6 and checks A1–A6), only when
    // the caller requested it. The proposal above is unchanged for every
    // other caller.
    if (this.animation !== null) {
      g = this.guard();
      if (g !== null) return g;
      const profile = checkAnimationProfile(this, metrics);
      if (profile !== null) return this.reject(profile);
    }

    // 17 — accept.
    g = this.guard();
    if (g !== null) return g;
    return this.proposal('ok', [], metrics);
  }
}

// --- public entry points -----------------------------------------------------

function prepare(bytes: Uint8Array, options: ImportOptions): ImportProposal {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('inspectGlb: bytes must be a Uint8Array');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('inspectGlb: options must be an object');
  }
  if (options.profile !== 'gltf-glb') {
    throw new TypeError("inspectGlb: unsupported profile (expected 'gltf-glb')");
  }
  if (options.recipeVersion !== 1) {
    throw new TypeError('inspectGlb: unsupported recipeVersion (expected 1)');
  }
  const toolchain = resolveToolchain(options);
  const animation = resolveAnimation(options);
  const sourceDigest = sha256Hex(bytes);
  const job = resolveImportJob(options.job, options, sourceDigest);
  const recipe: ImportRecipe = {
    profile: 'gltf-glb',
    recipeVersion: 1,
    toolchain: { three: toolchain['three'] as string },
    extensions: [],
  };
  return new Inspector(bytes, sourceDigest, recipe, job, animation).run();
}

/**
 * Bounded GLB inspection. Deterministic, pure and
 * total over hostile bytes: malformed input yields a `rejected` proposal with
 * ordered diagnostics, never an exception. Invalid *options* (a caller
 * programming error: unknown profile/recipe version, a non-pinned toolchain,
 * a malformed job identity) throw `TypeError`.
 */
export function inspectGlb(bytes: Uint8Array, options: ImportOptions): ImportProposal {
  return prepare(bytes, options);
}

/**
 * The job-bound preparation entry (over bytes and an injected job port):
 * identical validation, but the injected job port is required, so the
 * proposal always carries a real job identity, a real bounded deadline and
 * caller cancellation.
 */
export function prepareImport(bytes: Uint8Array, options: PrepareImportOptions): ImportProposal {
  if (!isPlainObject(options) || !isPlainObject(options.job)) {
    throw new TypeError('prepareImport: options.job must be an ImportJobPort');
  }
  return prepare(bytes, options);
}

/** `recipeDigest` = SHA-256 of the canonical JSON of the recipe. */
export function importRecipeDigest(recipe: ImportRecipe | AudioRecipe): string {
  return sha256HexOfText(canonicalJsonText(recipe));
}

/**
 * The proposal's deterministic metadata digest: SHA-256 of the canonical JSON
 * of the proposal's persistable facts (`status`, `kind`, `sourceDigest`,
 * `sourceByteLength`, `importRecipe`, `metrics` when present). Job identity,
 * stage id, expiry, display name and the non-persistent `inspection` display
 * lists are deliberately excluded, so re-inspecting the same bytes yields the
 * same digest regardless of the job that carried them.
 */
export function importMetadataDigest(
  proposal: ImportMetadataFacts | ImportProposal | AudioImportProposal,
): string {
  const metadata: Record<string, unknown> = {
    status: proposal.status,
    sourceDigest: proposal.sourceDigest,
    sourceByteLength: proposal.sourceByteLength,
    importRecipe: proposal.importRecipe,
  };
  if (proposal.kind !== undefined) metadata['kind'] = proposal.kind;
  if (proposal.metrics !== undefined) metadata['metrics'] = proposal.metrics;
  return sha256HexOfText(canonicalJsonText(metadata));
}
