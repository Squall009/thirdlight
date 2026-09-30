/**
 * The voices a conversation may say next: every path from where it is now
 * (each option of a choice, both ways of a branch, into a jumped-to
 * conversation), up to a number of lines deep. The page reads these files
 * ahead so a voiced line starts without waiting for its file; which path is
 * taken is the simulation's business, so all of them are read.
 */
import type { RuntimeDialogue, RuntimeDialogueData } from '@thirdlight/project-model';

/** Lines read ahead on every path: the next line and the ones after it, so a reply to a choice is ready too. */
export const DIALOGUE_VOICE_LOOKAHEAD_LINES = 3;

/** Nodes one look-ahead walks at most (a conversation of many small nodes between lines stays cheap). */
const WALK_LIMIT = 512;

/** One voice ahead: its clip and how many lines come before it (0: a line that may come next). */
export interface DialogueVoiceAhead {
  readonly voice: string;
  readonly depth: number;
}

/**
 * The voice clips of the lines after `node` in `dialogueId`, up to `lines`
 * lines deep on every path, nearest first, each once. The line at `node`
 * itself is not included (it is already playing).
 */
export function dialogueVoicesAhead(data: RuntimeDialogueData, dialogueId: string, node: string, lines = DIALOGUE_VOICE_LOOKAHEAD_LINES): DialogueVoiceAhead[] {
  const byId = new Map<string, RuntimeDialogue>(data.dialogues.map((d) => [d.dialogueId, d]));
  const out: DialogueVoiceAhead[] = [];
  const seenVoice = new Set<string>();
  const visited = new Set<string>();
  // Nearer lines first (read first): one list of nodes per number of lines passed, each walked in order
  // (a node that is not a line leads on at the same depth, a line one deeper).
  const buckets: { d: RuntimeDialogue; id: string }[][] = Array.from({ length: Math.max(0, lines) }, () => []);
  const start = byId.get(dialogueId);
  if (start === undefined) return out;
  const push = (d: RuntimeDialogue, id: string | null, depth: number): void => {
    if (id !== null && depth < lines) buckets[depth]!.push({ d, id });
  };
  const after = (d: RuntimeDialogue, id: string, depth: number): void => {
    const n = d.nodes[id];
    if (n === undefined) return;
    switch (n.t) {
      case 'line':
      case 'set':
      case 'signal':
      case 'wait':
      case 'goto':
        push(d, n.next, depth);
        return;
      case 'choice':
        for (const o of n.options) push(d, o.next, depth);
        push(d, n.none, depth);
        return;
      case 'branch':
        push(d, n.then, depth);
        push(d, n.else, depth);
        return;
      case 'jump': {
        const to = byId.get(n.dialogue);
        if (to !== undefined) push(to, n.entry !== '' ? (to.entries[n.entry] ?? null) : to.start, depth);
        return;
      }
      case 'end':
        return;
    }
  };
  after(start, node, 0);
  let walked = 0;
  for (let depth = 0; depth < buckets.length; depth += 1) {
    const bucket = buckets[depth]!;
    for (let i = 0; i < bucket.length && walked < WALK_LIMIT; i += 1) {
      const { d, id } = bucket[i]!;
      const key = `${d.dialogueId}/${id}`;
      if (visited.has(key)) continue;
      visited.add(key);
      walked += 1;
      const n = d.nodes[id];
      if (n === undefined) continue;
      if (n.t !== 'line') {
        after(d, id, depth);
        continue;
      }
      if (n.voice !== '' && !n.voice.startsWith('$') && !seenVoice.has(n.voice)) {
        seenVoice.add(n.voice);
        out.push({ voice: n.voice, depth });
      }
      after(d, id, depth + 1);
    }
  }
  return out;
}
