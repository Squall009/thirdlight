/**
 * Waiting for Play's texture streamer to come to rest: no level load in
 * flight and the same resident level for every texture in two reads in a row.
 * Under a budget the streamer stops where the budget lets it, so this is the
 * condition a test checks the budget's outcome after (not a fixed wait).
 */
import { expect } from '@playwright/test';

export interface StreamerReading {
  readonly loading?: number;
  readonly textures: readonly { readonly id: string; readonly resident: number }[];
}

export async function textureStreamerSettled(read: () => Promise<StreamerReading | null | undefined>, timeout = 60_000): Promise<void> {
  let last = '';
  await expect
    .poll(
      async () => {
        const r = await read();
        if (r === null || r === undefined || (r.loading ?? 0) > 0) {
          last = '';
          return false;
        }
        const levels = r.textures.map((t) => `${t.id}:${t.resident}`).join(',');
        const same = levels === last;
        last = levels;
        return same;
      },
      { timeout, intervals: [250, 500] },
    )
    .toBe(true);
}
