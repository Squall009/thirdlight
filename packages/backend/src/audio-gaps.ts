/**
 * Audio a browser does not play is imported, not refused: the Problems list
 * says which files and which browsers, once per command (a folder of a
 * thousand Ogg voice lines is one Problem, not a thousand).
 */
import type { AudioMetrics } from '@thirdlight/project-model';
import { audioPlaybackGaps } from '@thirdlight/project-model/limits';

type RecordLike = { assetId?: unknown; kind?: unknown; currentVersion?: unknown; versions?: readonly { version?: unknown; metrics?: unknown }[] };

/** The audio records a change added or re-imported. */
function importedAudio(change: unknown): RecordLike[] {
  if (typeof change !== 'object' || change === null) return [];
  const c = change as { type?: unknown; next?: unknown; added?: unknown };
  const records = c.type === 'publishAsset' ? [c.next] : c.type === 'importAssets' && Array.isArray(c.added) ? c.added : [];
  return (records as RecordLike[]).filter((r) => typeof r === 'object' && r !== null && r.kind === 'audio');
}

/** One Problem line per kind of gap a change's audio files have (none: every browser plays them). */
export function audioPlaybackProblems(change: unknown): string[] {
  const byGap = new Map<string, string[]>();
  for (const r of importedAudio(change)) {
    const m = r.versions?.find((v) => v.version === r.currentVersion)?.metrics as AudioMetrics | undefined;
    if (m === undefined) continue;
    for (const gap of audioPlaybackGaps(m)) {
      const ids = byGap.get(gap) ?? [];
      ids.push(String(r.assetId));
      byGap.set(gap, ids);
    }
  }
  return [...byGap].map(([gap, ids]) => `${ids.length === 1 ? `Audio "${ids[0]}"` : `${ids.length} audio files (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''})`}: ${gap}. It is imported and plays everywhere else.`);
}
