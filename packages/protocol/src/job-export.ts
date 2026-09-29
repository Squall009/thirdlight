/**
 * Phase 25.22: importing an asset-generation job's export.
 *
 * A job export is what an external asset tool (an art pipeline, a generator,
 * a hand-made delivery) hands over: a folder, or a zip of one, holding a GLB
 * and a small JSON manifest named `manifest.json` at its root (a zip may wrap
 * the folder in one top folder). The engine reads only this neutral shape,
 * never the tool that wrote it:
 *
 *   {
 *     "name": "Crate",                                    // 1–128 characters
 *     "files": [                                          // 1–64 files
 *       { "path": "crate.glb", "role": "model", "digest": "<sha256 hex>" },
 *       { "path": "preview.png", "role": "preview", "digest": "sha256:<hex>" }
 *     ],
 *     "triangles": 1180,                                  // optional: the model's triangles
 *     "lods": [1180, 560, 210]                            // optional: triangles per level, LOD0 first
 *   }
 *
 * Exactly one file has the role `model` and is a `.glb`; it becomes the
 * asset through the ordinary import (inspection, then `publishAsset`).
 * Every listed file must exist in the export with its digest; other roles
 * are checked and reported, not imported. Other manifest keys are ignored
 * (listed back as `ignoredKeys`), so a tool may carry its own data.
 *
 * Pure: the backend parses the request and the manifest here.
 */
import { parseStageId } from './content';
import { sessionError, type SessionError } from './errors';
import { isPlainObject, isStringNoControl } from './strict';

/** The manifest's file name at the export's root. */
export const JOB_EXPORT_MANIFEST = 'manifest.json';
export const JOB_EXPORT_LIMITS = Object.freeze({
  /** Bytes of the manifest. */
  manifestBytes: 65_536,
  files: 64,
  pathChars: 256,
  lods: 8,
});

export interface JobExportFile {
  /** Relative to the export's root, forward slashes. */
  readonly path: string;
  /** What the file is to the producer (`model` is imported; e.g. preview, texture, collision, source). */
  readonly role: string;
  /** 64 lowercase hex SHA-256 of the file's bytes. */
  readonly digest: string;
}

export interface JobExportManifest {
  readonly name: string;
  readonly files: readonly JobExportFile[];
  readonly triangles?: number;
  readonly lods?: readonly number[];
  /** Keys the engine does not read. */
  readonly ignoredKeys: readonly string[];
}

/** The route body: exactly one of `path` (a folder or a `.zip` in the game folder) or `stageId` (an uploaded zip). */
export interface JobExportRequest {
  readonly path?: string;
  readonly stageId?: string;
  readonly displayName?: string;
}

const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** A relative path inside an export: forward slashes, no empty, "." or ".." parts, no backslash, colon or control characters. */
export function isJobExportPath(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 1 || s.length > JOB_EXPORT_LIMITS.pathChars) return false;
  if (/[\u0000-\u001f\u007f\\:]/.test(s)) return false;
  return s.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const invalid = (path: string, message: string, found?: unknown): { ok: false; error: SessionError } => ({
  ok: false,
  error: sessionError('content_invalid', 'validation', `job export manifest: ${message}`, { path, ...(found !== undefined ? { found: String(found).slice(0, 256) } : {}) }),
});

/** Parse and check a manifest's JSON value (not its files: the backend checks those against the export). */
export function parseJobExportManifest(value: unknown): { ok: true; manifest: JobExportManifest } | { ok: false; error: SessionError } {
  if (!isPlainObject(value)) return invalid('', 'the manifest is a JSON object { name, files, triangles?, lods? }');
  const { name, files, triangles, lods } = value;
  if (!isStringNoControl(name) || name.length < 1 || name.length > 128) return invalid('/name', 'name is 1–128 characters without control characters', name);
  if (!Array.isArray(files) || files.length < 1 || files.length > JOB_EXPORT_LIMITS.files) return invalid('/files', `files is a list of 1–${JOB_EXPORT_LIMITS.files} { path, role, digest }`);
  const out: JobExportFile[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const at = `/files/${i}`;
    if (!isPlainObject(f)) return invalid(at, 'a file is { path, role, digest }');
    if (!isJobExportPath(f['path'])) return invalid(`${at}/path`, 'path is relative to the export (forward slashes, no "..")', f['path']);
    if (seen.has(f['path'])) return invalid(`${at}/path`, `two files list "${f['path']}"`, f['path']);
    seen.add(f['path']);
    if (typeof f['role'] !== 'string' || !ROLE_RE.test(f['role'])) return invalid(`${at}/role`, 'role is a lowercase word (a letter, then up to 31 letters, digits, _ or -)', f['role']);
    const raw = typeof f['digest'] === 'string' ? f['digest'].replace(/^sha256:/, '').toLowerCase() : '';
    if (!HEX64.test(raw)) return invalid(`${at}/digest`, 'digest is the SHA-256 of the file (64 hex, optionally "sha256:" first)', f['digest']);
    out.push({ path: f['path'], role: f['role'], digest: raw });
  }
  const models = out.filter((f) => f.role === 'model');
  if (models.length !== 1) return invalid('/files', `exactly one file has the role "model" (found ${models.length})`);
  if (!/\.glb$/i.test(models[0]!.path)) return invalid('/files', `the model file is a .glb (found "${models[0]!.path}")`);
  const count = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e9;
  if (triangles !== undefined && !count(triangles)) return invalid('/triangles', 'triangles is a whole number ≥ 0', triangles);
  if (lods !== undefined && (!Array.isArray(lods) || lods.length < 1 || lods.length > JOB_EXPORT_LIMITS.lods || !lods.every(count))) {
    return invalid('/lods', `lods is a list of 1–${JOB_EXPORT_LIMITS.lods} triangle counts (LOD0 first)`);
  }
  const known = new Set(['name', 'files', 'triangles', 'lods']);
  return {
    ok: true,
    manifest: {
      name,
      files: out,
      ...(triangles !== undefined ? { triangles: triangles as number } : {}),
      ...(lods !== undefined ? { lods: [...(lods as number[])] } : {}),
      ignoredKeys: Object.keys(value).filter((k) => !known.has(k)).sort(),
    },
  };
}

/** Parse the job-export inspect route's body. */
export function parseJobExportRequest(value: unknown): { ok: true; request: JobExportRequest } | { ok: false; error: SessionError } {
  if (!isPlainObject(value)) return { ok: false, error: sessionError('field_type', 'validation', 'the body must be an object', { path: '', found: typeof value }) };
  const { path, stageId, displayName, ...rest } = value;
  const extra = Object.keys(rest);
  if (extra.length > 0) return { ok: false, error: sessionError('field_unexpected', 'validation', `unknown field "${extra[0]!}" (allowed: path, stageId, displayName)`, { path: `/${extra[0]!}` }) };
  if ((path === undefined) === (stageId === undefined)) {
    return { ok: false, error: sessionError('field_missing', 'validation', 'give exactly one of path (a folder or .zip in the game folder) or stageId (an uploaded zip)', { path: '/path' }) };
  }
  if (path !== undefined && !isJobExportPath(path)) {
    return { ok: false, error: sessionError('path_rejected', 'validation', 'path must be a folder or .zip relative to the game folder (forward slashes, no "..")', { path: '/path', found: String(path).slice(0, 256) }) };
  }
  if (stageId !== undefined) {
    if (typeof stageId !== 'string') return { ok: false, error: sessionError('field_type', 'validation', 'stageId is an upload stage id', { path: '/stageId' }) };
    const sid = parseStageId(stageId);
    if (!sid.ok) return sid;
  }
  if (displayName !== undefined && (!isStringNoControl(displayName) || displayName.length < 1 || displayName.length > 128)) {
    return { ok: false, error: sessionError('field_value', 'validation', 'displayName must be 1–128 characters without control characters', { path: '/displayName' }) };
  }
  return {
    ok: true,
    request: {
      ...(path !== undefined ? { path: path as string } : {}),
      ...(stageId !== undefined ? { stageId: stageId as string } : {}),
      ...(displayName !== undefined ? { displayName: displayName as string } : {}),
    },
  };
}
