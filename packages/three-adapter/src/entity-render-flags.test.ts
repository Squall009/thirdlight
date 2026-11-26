/**
 * Which drawables cast and receive the key light's shadow: a box or model
 * casts unless it says not to; an instance set (foliage, scatter) casts only
 * when its `castShadow` is set; both receive unless they say not to.
 */
import { describe, expect, it } from 'vitest';

import { shadowFlagsOf } from './entity-render-flags';

describe('shadowFlagsOf', () => {
  it('a box or model casts by default; an instance set casts only when it says so; all receive unless turned off', () => {
    expect(shadowFlagsOf({ box: { size: [1, 1, 1] } })).toEqual({ cast: true, receive: true });
    expect(shadowFlagsOf({ model: { asset: { assetId: 'm' }, castShadow: false } })).toEqual({ cast: false, receive: true });
    expect(shadowFlagsOf({ instances: { buffer: 'a'.repeat(64), count: 2 } })).toEqual({ cast: false, receive: true });
    expect(shadowFlagsOf({ instances: { castShadow: true, receiveShadow: false } })).toEqual({ cast: true, receive: false });
    expect(shadowFlagsOf({})).toEqual({ cast: true, receive: true });
  });
});
