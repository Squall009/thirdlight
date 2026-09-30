/**
 * The conversations a preview needs: the one played and every one it may
 * jump to, read by id from the project index (the editor reads a
 * conversation when it is opened or played, not the project's every one).
 */
import type { DialogueDocument } from '@thirdlight/project-model';

import type { Catalog } from './catalog';

/** The conversations a conversation's jump nodes name. */
export function jumpTargets(d: DialogueDocument): string[] {
  const out: string[] = [];
  for (const n of d.graph.nodes) {
    const to = n.type === 'jump' ? n.data?.['dialogue'] : undefined;
    if (typeof to === 'string' && to !== '') out.push(to);
  }
  return out;
}

/** `dialogueId` and the conversations reachable from it by jumps, read (those that exist). */
export async function conversationsFrom(client: { readonly catalog: Catalog; getDialogues(): readonly DialogueDocument[] } | null, dialogueId: string): Promise<readonly DialogueDocument[]> {
  if (client === null) return [];
  const wanted = new Set([dialogueId]);
  let frontier = [dialogueId];
  while (frontier.length > 0) {
    await client.catalog.ensureResources('dialogue', frontier);
    const held = new Map(client.getDialogues().map((d) => [d.dialogueId, d] as const));
    const next: string[] = [];
    for (const id of frontier) {
      const d = held.get(id);
      if (d === undefined) continue;
      for (const to of jumpTargets(d)) {
        if (wanted.has(to)) continue;
        wanted.add(to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return client.getDialogues().filter((d) => wanted.has(d.dialogueId));
}
