/**
 * Saving a bake's files and record through the commands, in the order that
 * keeps the project's record whole whatever fails: every file is published
 * as a new asset, `setLighting` then names them, and only once it is taken
 * are the previous bake's files let go (`deleteAsset`). A failure before
 * that removes what this save published and leaves the previous record and
 * its files as they were; undoing a bake (the deletes, then `setLighting`)
 * brings back the previous record with its own files, never files a later
 * bake wrote over them.
 *
 * No browser or viewport: the editor's bake and the tests at the backend's
 * boundary run the same steps.
 */
import type { LightingBake } from '@thirdlight/project-model';

/** The commands a save sends (the editor's session client, or a test's over HTTP). */
export interface BakeSaveCommands {
  /** Publish one file as a new texture asset: its asset id, or why not. */
  publish(bytes: Uint8Array, displayName: string): Promise<string | { message: string }>;
  /** Record the scene's bake (`setLighting`): null when taken, else why not. */
  setLighting(bake: LightingBake): Promise<null | { message: string }>;
  /** Let an asset go (`deleteAsset`); a refusal (still referenced elsewhere) keeps it. */
  remove(assetId: string): Promise<void>;
}

export interface BakeSaveInput {
  readonly files: readonly Uint8Array[];
  /** The files' display name (numbered when there are several). */
  readonly name: string;
  /** The previous bake's files (let go once the new record is taken). */
  readonly previous: readonly string[];
  /** The record naming the published files. */
  record(files: string[], bytes: number): LightingBake;
  onProgress?(i: number, n: number): void;
}

export async function saveLightingBakeFiles(c: BakeSaveCommands, s: BakeSaveInput): Promise<{ ok: true; bake: LightingBake } | { ok: false; message: string }> {
  const ids: string[] = [];
  const undo = async (): Promise<void> => {
    for (const id of ids) await c.remove(id);
  };
  let bytes = 0;
  for (let i = 0; i < s.files.length; i++) {
    s.onProgress?.(i, s.files.length);
    const id = await c.publish(s.files[i]!, `${s.name}${s.files.length > 1 ? ` ${i + 1}` : ''}`);
    if (typeof id !== 'string') {
      await undo();
      return { ok: false, message: id.message };
    }
    ids.push(id);
    bytes += s.files[i]!.byteLength;
  }
  const bake = s.record(ids, bytes);
  const refused = await c.setLighting(bake);
  if (refused !== null) {
    await undo();
    return { ok: false, message: `the bake was refused: ${refused.message}` };
  }
  for (const id of s.previous) if (!ids.includes(id)) await c.remove(id);
  return { ok: true, bake };
}
