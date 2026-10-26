/**
 * A build's model colliders (`{type: 'model'}`): one model's `_COL` parts
 * per piece a scene or prefab uses, resolved at build time so the runtime
 * never reads a model; a model without readable parts is a warning.
 */
import { modelCollisionParts, readModelGeometry, type PlayCheck } from '@thirdlight/project-model';

/** Add model `assetId`'s parts for each of `pieces` (`''`: shown whole) to `table` (made on the first); the table back. */
export function collidersOfModel(assetId: string, bytes: Uint8Array, pieces: ReadonlySet<string>, table: Record<string, Record<string, number[][][]>> | undefined, checks: PlayCheck[]): Record<string, Record<string, number[][][]>> | undefined {
  let modelColliders = table;
  const geometry = readModelGeometry(bytes);
  for (const piece of [...pieces].sort()) {
    const made = geometry.ok ? modelCollisionParts(geometry.geometry, piece === '' ? null : piece) : null;
    if (made !== null && made.parts.length > 0) {
      modelColliders ??= {};
      (modelColliders[assetId] ??= {})[piece] = made.parts.map((p) => p.points);
    }
    const why = !geometry.ok ? geometry.message : made!.parts.length === 0 ? (made!.skipped[0] ?? 'it has no _COL node') : made!.skipped.length > 0 ? `some parts were left out: ${made!.skipped.slice(0, 2).join('; ')}` : null;
    if (why !== null) checks.push({ code: 'collider_model', refuse: false, message: `the model collider of ${assetId}${piece !== '' ? ` (${piece})` : ''}: ${why}`.slice(0, 256) });
  }
  return modelColliders;
}
