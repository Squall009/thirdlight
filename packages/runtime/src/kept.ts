/**
 * Kept objects (`keepLoaded`): an object, its children and its scripts
 * survive scene loads, unloads and reloads and a save's scene changes (Unity's
 * DontDestroyOnLoad). The runtime asks this table which objects of a leaving
 * scene stay, which objects of an arriving scene are already alive (a scene
 * loaded again does not bring a second copy), and what a kept object still
 * names in a scene that went (it reads as empty; the game is told once).
 *
 * An object is kept when it carries the flag (the scene document's effective
 * flag: on a root or folder-filed object, or under a kept one) or its parent
 * object is kept. A kept object whose scene went has no scene: it is listed
 * with the spawned copies (the renderer and the audio follow it there).
 */
import type { EntityV3 } from '@thirdlight/project-model';

export class KeptObjects {
  /** The live kept objects (effective). */
  private readonly kept = new Set<string>();
  /** The kept objects whose scene is gone, in the order they left. */
  private readonly orphans = new Map<string, EntityV3>();

  /** Objects came in (a start scene, a loaded scene, a spawned copy), parents before children. */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      const own = (e as { keepLoaded?: boolean }).keepLoaded === true;
      if (own || (e.parentId !== undefined && this.kept.has(e.parentId))) this.kept.add(e.id);
    }
  }

  has(id: string): boolean {
    return this.kept.has(id);
  }

  /** A scene leaves: the ids that go with it (its kept objects stay, scene-less). */
  leave(entities: readonly EntityV3[]): Set<string> {
    const going = new Set<string>();
    for (const e of entities) {
      if (this.kept.has(e.id)) this.orphans.set(e.id, e);
      else going.add(e.id);
    }
    return going;
  }

  /** An arriving scene without the objects already alive as kept ones (and what is under them in that scene). */
  arriving(entities: readonly EntityV3[], alive: (id: string) => boolean): { entities: EntityV3[]; skipped: string[] } {
    const skip = new Set<string>();
    for (const e of entities) {
      if ((this.kept.has(e.id) && alive(e.id)) || (e.parentId !== undefined && skip.has(e.parentId))) skip.add(e.id);
    }
    if (skip.size === 0) return { entities: [...entities], skipped: [] };
    return { entities: entities.filter((e) => !skip.has(e.id)), skipped: [...skip] };
  }

  /**
   * Their scene arrived again: the scene-less kept objects among `ids` belong
   * to it once more (a run restart that keeps the scene keeps them too).
   * Returns their documents.
   */
  adopt(ids: readonly string[]): EntityV3[] {
    const out: EntityV3[] = [];
    for (const id of ids) {
      const e = this.orphans.get(id);
      if (e === undefined) continue;
      this.orphans.delete(id);
      out.push(e);
    }
    return out;
  }

  /** The kept objects whose scene is gone. */
  orphanList(): EntityV3[] {
    return [...this.orphans.values()];
  }

  orphan(id: string): EntityV3 | undefined {
    return this.orphans.get(id);
  }

  /** Objects left the game (detached): they are no longer kept. */
  removed(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.kept.delete(id);
      this.orphans.delete(id);
    }
  }

  /** A new run: the scene-less kept objects go (their scenes bring them back). */
  takeOrphans(): Set<string> {
    const ids = new Set(this.orphans.keys());
    this.orphans.clear();
    return ids;
  }

  /** A script switched the flag (`set('object', {keepLoaded})`) on these objects (the object and its subtree). */
  set(ids: readonly string[], keep: boolean): void {
    for (const id of ids) {
      if (keep) this.kept.add(id);
      else this.kept.delete(id);
    }
  }

  /**
   * What the live kept objects still name among `gone` (a reference to an
   * object of a scene that went: it now reads as empty), as `kept → named`.
   */
  referencesTo(gone: ReadonlySet<string>, docOf: (id: string) => EntityV3 | undefined): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    if (gone.size === 0) return out;
    for (const id of this.kept) {
      const doc = docOf(id);
      if (doc === undefined) continue;
      for (const to of namedIn(doc.components, gone)) out.push({ from: id, to });
    }
    return out;
  }
}

/** The ids of `gone` a component value names (any string field). */
function namedIn(value: unknown, gone: ReadonlySet<string>, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > 16) return found;
  if (typeof value === 'string') {
    if (gone.has(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) namedIn(v, gone, found, depth + 1);
  } else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) namedIn(v, gone, found, depth + 1);
  }
  return found;
}
