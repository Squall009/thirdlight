/**
 * Phase 15.4: a private declared property always reads its declared default
 * (a stored value left from when it was public is inert); a public one reads
 * the stored value, or its default when absent.
 */
import { describe, expect, it } from 'vitest';

import { materializeBehaviorValues } from './behavior';

describe('phase 15.4: materialized values and visibility', () => {
  const declaration = {
    properties: [
      { key: 'speed', label: 'Speed', type: 'number' as const, default: 3 },
      { key: 'secret', label: 'Secret', type: 'number' as const, default: 1, visibility: 'private' as const },
      { key: 'jump', label: 'Jump', type: 'number' as const, default: 2 },
    ],
  };

  it('private reads the default even with a stored value; absent public keys read theirs', () => {
    const r = materializeBehaviorValues(declaration, { speed: 5, secret: 9 });
    if (!r.ok) throw r.error;
    expect(r.values).toEqual({ speed: 5, secret: 1, jump: 2 });
  });
});
