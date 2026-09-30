/**
 * The host's side of scripts' asset handles: a load is carried out by the
 * page's loader under the handle's holder and answered; a release lets the
 * holder go (a handle released while it loads is let go once the load is
 * done, and not answered); a handle a run ended with is reported; what is
 * open is observed and returned at the end.
 */
import { describe, expect, it } from 'vitest';

import { createResourceManager, type AssetHandleAnswer } from '@thirdlight/runtime';

import { createHostAssets } from './host-assets';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup() {
  const resources = createResourceManager();
  const gates = new Map<string, () => void>();
  const assets = createHostAssets(
    {
      readArtifact: () => Promise.reject(new Error('no reads here')),
      resources,
      // Holds one 100-byte resource per key for the holder, when the test lets the key's load finish.
      loadAssets: (key, holder) =>
        new Promise((resolve, reject) => {
          gates.set(key, () => {
            if (key === 'nothing') return reject(new Error(`nothing in this build is named "${key}"`));
            void resources.acquire('bytes', `${key}@1`, holder, async () => ({ value: new ArrayBuffer(100), bytes: 100 })).then(() => resolve([`${key}-a`, `${key}-b`]));
          });
        }),
    },
    () => true,
  );
  const answers: AssetHandleAnswer[] = [];
  const answer = (a: AssetHandleAnswer): void => void answers.push(a);
  return { resources, assets, gates, answers, answer };
}

describe('host asset handles', () => {
  it('a load is held for its handle and answered; a release frees it after the frame', async () => {
    const s = setup();
    s.assets.serviceHandles([{ op: 'load', handle: 1, key: 'batch' }], s.answer);
    expect(s.assets.observe().open).toEqual([{ handle: 1, key: 'batch', state: 'loading', assets: 0 }]);
    s.gates.get('batch')!();
    await flush();
    expect(s.answers).toEqual([{ handle: 1, ok: true, assets: ['batch-a', 'batch-b'] }]);
    expect(s.resources.holders('bytes', 'batch@1')).toEqual(['handle:1']);
    expect(s.assets.observe()).toMatchObject({ handles: 1, resident: { bytes: { count: 1, bytes: 100 } }, open: [{ handle: 1, state: 'ready', assets: 2 }] });
    s.assets.serviceHandles([{ op: 'release', handle: 1 }], s.answer);
    s.assets.frameDone();
    expect(s.assets.observe()).toMatchObject({ handles: 0, resident: {} });
    expect(s.assets.observe().open).toBeUndefined();
  });

  it('a handle released while it loads is let go when the load is done, and not answered; a failed load is answered failed', async () => {
    const s = setup();
    s.assets.serviceHandles([{ op: 'load', handle: 1, key: 'batch' }, { op: 'load', handle: 2, key: 'nothing' }], s.answer);
    s.assets.serviceHandles([{ op: 'release', handle: 1 }], s.answer);
    s.gates.get('batch')!();
    s.gates.get('nothing')!();
    await flush();
    s.assets.frameDone();
    expect(s.answers).toEqual([{ handle: 2, ok: false, message: 'nothing in this build is named "nothing"' }]);
    expect(s.resources.has('bytes', 'batch@1')).toBe(false);
    expect(s.assets.observe().open).toEqual([{ handle: 2, key: 'nothing', state: 'failed', assets: 0, error: 'nothing in this build is named "nothing"' }]);
  });

  it('a handle a run ended with is reported; what is open at the end is returned', async () => {
    const s = setup();
    s.assets.serviceHandles([{ op: 'load', handle: 1, key: 'batch' }, { op: 'load', handle: 2, key: 'more' }], s.answer);
    s.gates.get('batch')!();
    s.gates.get('more')!();
    await flush();
    s.assets.serviceHandles([{ op: 'release', handle: 1, runEnded: true }], s.answer);
    expect(s.assets.observe()).toMatchObject({ handles: 1, notReleasedCount: 1, notReleased: [{ handle: 1, key: 'batch', state: 'ready', assets: 2 }] });
    const open = s.assets.dispose();
    expect(open).toEqual([{ handle: 2, key: 'more', state: 'ready', assets: 2 }]);
    // Let go: the page settles (or closes) its manager next.
    s.resources.settle();
    expect(s.resources.observe().resident).toEqual({});
  });
});
