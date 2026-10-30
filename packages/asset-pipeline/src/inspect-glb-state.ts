/**
 * The state the GLB inspection steps share (the source bytes, the job, and what
 * each step has validated for the later ones) and their small value and
 * diagnostic helpers.
 */

import type { ImportRecipe } from '@thirdlight/project-model';
import { escapePointer } from './json';
import type { ImportDiagnostic, ImportDiagnosticCode, ImportLimitName } from './types';
export { isPlainObject } from '@thirdlight/shared';

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function asIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// --- diagnostics -------------------------------------------------------------

export interface DiagExtra {
  readonly found?: unknown;
  readonly expected?: string;
  readonly limit?: ImportLimitName;
  readonly role?: string;
  readonly clipIndex?: number;
  readonly clips?: number;
  readonly roles?: readonly string[];
  readonly matches?: number;
  readonly nodeIndex?: number;
  readonly nodeName?: string;
}

export function diag(
  code: ImportDiagnosticCode,
  path: string,
  message: string,
  extra: DiagExtra = {},
): ImportDiagnostic {
  const out: {
    code: ImportDiagnosticCode;
    path: string;
    message: string;
    found?: unknown;
    expected?: string;
    limit?: ImportLimitName;
    role?: string;
    clipIndex?: number;
    clips?: number;
    roles?: readonly string[];
    matches?: number;
    nodeIndex?: number;
    nodeName?: string;
  } = {
    code,
    path,
    message,
  };
  if (extra.found !== undefined) out.found = extra.found;
  if (extra.expected !== undefined) out.expected = extra.expected;
  if (extra.limit !== undefined) out.limit = extra.limit;
  if (extra.role !== undefined) out.role = extra.role;
  if (extra.clipIndex !== undefined) out.clipIndex = extra.clipIndex;
  if (extra.clips !== undefined) out.clips = extra.clips;
  if (extra.roles !== undefined) out.roles = extra.roles;
  if (extra.matches !== undefined) out.matches = extra.matches;
  if (extra.nodeIndex !== undefined) out.nodeIndex = extra.nodeIndex;
  if (extra.nodeName !== undefined) out.nodeName = extra.nodeName;
  return out;
}

/** JSON-Pointer path helper (`/meshes/0/primitives/1/attributes/POSITION`). */
export function ptr(...tokens: (string | number)[]): string {
  let out = '';
  for (const t of tokens) out += `/${escapePointer(String(t))}`;
  return out;
}

/** The resolved job identity shared by the GLB and WAV inspectors. */
export interface ResolvedJob {
  readonly now: () => number;
  readonly isCancelled: () => boolean;
  readonly proposalId: string;
  readonly stageId: string;
  readonly expiresAt: string;
  readonly timeoutMs: number;
  readonly suggestedDisplayName: string;
}

/** The caller-validated role mapping the proposal is checked against. */
export interface ResolvedAnimation {
  readonly entityId: string;
  readonly roles: Readonly<Record<'idle' | 'run' | 'airborne', { readonly clipIndex: number; readonly clipName: string }>>;
}

export interface PrimitiveRef {
  readonly path: string;
  readonly attributes: ReadonlyMap<string, number>;
  readonly indices: number | null;
  readonly material: number | null;
}

export interface AccessorInfo {
  readonly count: number;
  readonly type: string;
  readonly componentType: number;
  readonly byteLength: number;
}

/** What the inspection steps share: the source, the job and what the earlier steps found. */
export class GlbState {
  json: Record<string, unknown> = {};
  jsonChunk: Uint8Array = new Uint8Array(0);
  bin: Uint8Array = new Uint8Array(0);
  bufferByteLength = 0;
  /** Validated bufferViews; `data` is the view's bytes (decoded when meshopt-compressed). */
  bufferViews: { byteOffset: number; byteLength: number; buffer: number; compressed: boolean; data: Uint8Array }[] = [];
  /** Declared byteLength of each EXT_meshopt_compression fallback buffer (index > 0). */
  fallbackBuffers = new Map<number, number>();
  accessors: AccessorInfo[] = [];
  primitives: PrimitiveRef[] = [];
  imageDecodedBytes = 0;
  /** The detected container of each image (`null` = invalid), by index. */
  imageMimes: (string | null)[] = [];
  /** `extensionsUsed` as declared (every extension object must be declared). */
  declaredExtensions = new Set<string>();
  clipDurationMs = 0;
  /** Decoded bytes of all meshopt views so far (bounded by the decoded-geometry cap). */
  meshoptDecodedBytes = 0;

  constructor(
    readonly bytes: Uint8Array,
    readonly sourceDigest: string,
    readonly recipe: ImportRecipe,
    readonly job: ResolvedJob,
    readonly animation: ResolvedAnimation | null,
  ) {}

  /** `json[key]` as an array (absent/other types give `[]`). */
  collection(key: string): unknown[] {
    const value = this.json[key];
    return Array.isArray(value) ? value : [];
  }

  /**
   * An animation-only file — no meshes (the key absent or an
   * empty list) but at least one animation. It is imported as a model asset
   * whose clips play on another model's rig (`clipsFor`).
   */
  animationOnly(): boolean {
    const meshes = this.json['meshes'];
    const animations = this.json['animations'];
    const nodes = this.json['nodes'];
    // No node may point at a mesh (a file with a broken mesh list is not animation-only).
    const meshless = !Array.isArray(nodes) || nodes.every((n) => typeof n !== 'object' || n === null || (n as Record<string, unknown>)['mesh'] === undefined);
    return (meshes === undefined || (Array.isArray(meshes) && meshes.length === 0)) && meshless && Array.isArray(animations) && animations.length > 0;
  }
}
