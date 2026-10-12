import { describe, expect, it } from 'vitest';

import { parseRange, rangeText, scatterRuleSummary, surfaceRuleSummary, surfaceRuleTitle } from './rule-text';

const names = ['Meadow grass', 'Forest dirt', 'Basalt'];
const layer = (i: number): string => names[i] ?? `Layer ${i + 1}`;

describe('rules in words', () => {
  it('reads and shows a range the way its field takes it', () => {
    expect(parseRange('35–90')).toEqual({ min: 35, max: 90 });
    expect(parseRange('35 - 90')).toEqual({ min: 35, max: 90 });
    expect(parseRange('-5--2')).toEqual({ min: -5, max: -2 });
    expect(parseRange('90-35')).toEqual({ min: 35, max: 90 });
    expect(parseRange('>62')).toEqual({ min: 62 });
    expect(parseRange('<0.3')).toEqual({ max: 0.3 });
    expect(parseRange('62–')).toEqual({ min: 62 });
    expect(parseRange('any')).toEqual({});
    expect(parseRange('')).toEqual({});
    expect(parseRange('steep')).toBeNull();
    expect(rangeText({ min: 35, max: 90 }, 0)).toBe('35–90');
    expect(rangeText({ min: 0.35 }, 2)).toBe('>0.35');
    expect(rangeText({}, 0)).toBe('any');
  });

  it('sums a rule up in one line and names it', () => {
    expect(surfaceRuleSummary({ layer: 0 }, layer)).toBe('Everywhere');
    expect(surfaceRuleSummary({ layer: 2, slope: { min: 35, max: 90, fade: 6 }, noise: { min: 0.35, scale: 8 } }, layer)).toBe('Slope 35–90° · noise above 0.35');
    expect(surfaceRuleSummary({ layer: 1, cavity: { min: 0.2 }, weight: { layer: 0, max: 0.3 } }, layer)).toBe('In hollows · where Meadow grass is below 0.3');
    expect(surfaceRuleTitle({ layer: 2, slope: { min: 35 } }, layer)).toBe('Basalt, slope above 35°');
    expect(surfaceRuleTitle({ name: 'Rock on steep slopes', layer: 2 }, layer)).toBe('Rock on steep slopes');
    expect(scatterRuleSummary({ id: 'posts', asset: { assetId: 'p' }, density: 1.5, spacing: 0.6, slope: { max: 30 }, layers: [{ layer: 1, min: 0.5 }] }, layer)).toBe('1.5 per m² · 0.6 m apart · slope below 30° · on Forest dirt above 0.5');
  });
});
