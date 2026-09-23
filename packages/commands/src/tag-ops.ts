/**
 * `setTags` (phase 12 b): the project tag registry — up to 32 named tags,
 * each with a fixed bit. The request names the whole registry:
 *
 * - an entry with `bit` keeps that bit (renaming a tag keeps its bit, so
 *   every object carrying it keeps it);
 * - an entry without `bit` gets the lowest bit no other entry uses;
 * - a tag left out frees its bit, which is refused while any entity still
 *   carries that bit (`reference_in_use`, reason `tag`).
 *
 * Content-only: the scene is unchanged; the undo restores the whole previous
 * registry. Pure.
 */

import type { TagDefinition } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { SetTagsArgs, SetTagsChange } from './types';

/** The bits any entity in the scene carries (own masks). */
function usedBits(input: OpInput): number {
  let used = 0;
  for (const e of input.scene.entities) {
    const t = (e as { tags?: number }).tags;
    if (typeof t === 'number') used = (used | t) >>> 0;
  }
  return used;
}

function tagInUse(tag: TagDefinition, count: number): CommandError {
  return {
    code: 'reference_in_use',
    cls: 'validation',
    path: '/args/tags',
    reason: 'tag',
    found: tag.name,
    message: `tag "${tag.name}" (bit ${tag.bit}) is still carried by ${count} entit${count === 1 ? 'y' : 'ies'}; remove it from them first`,
  } as unknown as CommandError;
}

export function applySetTags(input: OpInput, args: SetTagsArgs): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = deepClone(catalog.tags ?? []);
  const taken = new Set<number>();
  for (const t of args.tags) if (t.bit !== undefined) taken.add(t.bit);
  const next: TagDefinition[] = [];
  for (let i = 0; i < args.tags.length; i++) {
    const t = args.tags[i] as { bit?: number; name: string };
    let bit = t.bit;
    if (bit === undefined) {
      bit = 0;
      while (taken.has(bit) && bit < 32) bit++;
      if (bit >= 32) {
        return { ok: false, error: fieldValue(`/args/tags/${i}`, t.name, 'at most 32 tags', 'no free tag bit is left (a project has at most 32 tags)') };
      }
      taken.add(bit);
    }
    next.push({ bit, name: t.name });
  }

  // A dropped bit must be unused.
  const used = usedBits(input);
  const keptBits = new Set(next.map((t) => t.bit));
  for (const t of previous) {
    if (keptBits.has(t.bit) || (used & (1 << t.bit)) === 0) continue;
    const count = input.scene.entities.filter((e) => (((e as { tags?: number }).tags ?? 0) & (1 << t.bit)) !== 0).length;
    return { ok: false, error: tagInUse(t, count) };
  }

  const nextContent = { ...catalog, tags: next.sort((a, b) => a.bit - b.bit) };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, nextContent);
  if (!gate.ok) {
    // The model reports registry problems against /tags; show them at /args/tags.
    const e = gate.error as unknown as { path?: string; details?: { path?: string }[] };
    if (typeof e.path === 'string' && e.path.startsWith('/tags')) e.path = `/args${e.path}`;
    return gate;
  }
  const canonicalNext = deepClone(gate.content?.tags ?? []);
  const change: SetTagsChange = { type: 'setTags', previous, next: canonicalNext };
  return {
    ok: true,
    op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setTags', restore: previous } },
  };
}
