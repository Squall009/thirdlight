/**
 * The scene a spawned copy was spawned in: the scene of the object whose
 * script spawned it (a copy spawned by a copy takes that copy's scene; a
 * kept or scene-less spawner gives none). A scene reload removes the copies
 * spawned in it, as reloading a scene in Godot frees the nodes its scripts
 * added under it. Copies keep no scene of their own otherwise: an unload
 * leaves them, as before.
 */
export class SpawnScenes {
  /** Spawned copy id → the scene it was spawned in. */
  private readonly sceneOfCopy = new Map<string, string>();

  /** A copy came in (`ids`: its entities, root first), spawned in `sceneId` (undefined: none). */
  record(ids: readonly string[], sceneId: string | undefined): void {
    if (sceneId === undefined) return;
    for (const id of ids) this.sceneOfCopy.set(id, sceneId);
  }

  /** The scene a copy was spawned in (undefined: none, or not a copy). */
  sceneOf(id: string): string | undefined {
    return this.sceneOfCopy.get(id);
  }

  /** The copies spawned in a scene, except those `stays` keeps. */
  copiesOf(sceneId: string, stays: (id: string) => boolean): Set<string> {
    const out = new Set<string>();
    for (const [id, s] of this.sceneOfCopy) if (s === sceneId && !stays(id)) out.add(id);
    return out;
  }

  /** Copies left the game. */
  removed(ids: Iterable<string>): void {
    for (const id of ids) this.sceneOfCopy.delete(id);
  }
}
