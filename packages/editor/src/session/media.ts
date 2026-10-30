/**
 * Media drop checks: what a dropped or picked file imports as, decided
 * before any network call (the backend checks the bytes at import).
 *
 * Pure: no DOM, no I/O, no Node builtins.
 */
import { CONTENT_STAGE_MAX } from '@thirdlight/protocol';
import { ASSET_KINDS, IMPORT_EXTENSIONS, importKindOf } from '@thirdlight/project-model/limits';
import type { DescriptorAssetKind } from '@thirdlight/project-model';

// ---------------------------------------------------------------------------
// Drop validation (the extension decides the kind; the bytes are checked at import)
// ---------------------------------------------------------------------------

export type AssetKind = DescriptorAssetKind;

export interface MediaDropVerdict {
  ok: true;
  kind: AssetKind;
  displayName: string;
}

/** The extensions an import takes, by kind, for the refusal message. */
const IMPORT_ACCEPTED = ASSET_KINDS.map((k) => `${Object.keys(IMPORT_EXTENSIONS).filter((e) => IMPORT_EXTENSIONS[e] === k).join('/')} (${k === 'model' ? 'a glTF binary, or FBX converted to glTF' : k})`).join(', ');

/**
 * Validate a dropped/selected media file BEFORE any network call (the
 * "invalid drop" failure mode): the extension decides the kind,
 * 1 … 32 MiB (the stage bound). An invalid drop creates no stage and no job.
 */
export function validateMediaDrop(name: string, byteLength: number): MediaDropVerdict | { ok: false; error: { code: string; message: string } } {
  const trimmed = name.trim();
  const kind = importKindOf(trimmed);
  if (kind === null) {
    return { ok: false, error: { code: 'import_rejected', message: `only ${IMPORT_ACCEPTED} files can be imported` } };
  }
  const ext = trimmed.slice(trimmed.lastIndexOf('.'));
  if (!Number.isInteger(byteLength) || byteLength < 1) {
    return { ok: false, error: { code: 'import_rejected', message: 'the dropped file is empty' } };
  }
  if (byteLength > CONTENT_STAGE_MAX) {
    return {
      ok: false,
      error: { code: 'stage_limits_exceeded', message: `the file is ${byteLength} bytes; the stage bound is ${CONTENT_STAGE_MAX}` },
    };
  }
  const displayName = trimmed.slice(0, trimmed.length - ext.length).slice(0, 128) || trimmed.slice(0, 128);
  return { ok: true, kind, displayName };
}
