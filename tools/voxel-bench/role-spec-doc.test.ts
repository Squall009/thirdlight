/**
 * The role spec draft (docs/architecture/voxel-role-spec.md) against the
 * edge catalogue it is written from, so the document the owner approves and
 * the cases the engine places cannot drift apart: the document has a
 * heading for exactly the catalogue's cases (every one a kit's optional
 * slot), and each heading opens with the facts rendered from the catalogue
 * and the passes that place it. Diagrams and prose after that block are the
 * document's own.
 *
 * To regenerate the blocks after a catalogue change, run this file with
 * ROLE_SPEC_PRINT=1: every case's expected block is printed between
 * `--- <case id>` markers, to paste over the old one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONSTRUCTION_ROLES,
  CUBE_ROTATION_X90,
  CUBE_ROTATION_ZM90,
  DEBRIS_LIGHT_MIN,
  EDGE_CASE_CATALOGUE,
  EDGE_CASE_IDS,
  PIECE_JITTER_DEFAULT,
  PIECE_JITTER_MAX,
  PIECE_STAGGER,
  PIECE_STAGGER_FRAMES,
  ROOF_EDGE_CASE_IDS,
  VOXEL_ROLE,
  WORLD_RULES,
  type CaseDef,
} from '@thirdlight/voxel';

const DOC = join(import.meta.dirname, '..', '..', 'docs', 'architecture', 'voxel-role-spec.md');
const cat = EDGE_CASE_CATALOGUE;

const ROLE_NAME = new Map<number, string>(Object.entries(VOXEL_ROLE).map(([k, v]) => [v, k]));
/** Which pass places a case. */
function placedBy(c: CaseDef): string {
  if ((EDGE_CASE_IDS as readonly string[]).includes(c.id)) return c.id.startsWith('corner-') ? 'the edge pass, one piece a lattice corner, yaw 0–3' : 'the edge pass, one piece a 0.5 m lattice edge, yaw 0–3';
  if ((ROOF_EDGE_CASE_IDS as readonly string[]).includes(c.id)) return 'the roof mesher, on roof plane cells';
  if (c.id === 'debris' || c.id === 'debris-heavy') return 'the debris rule, on an exposed damaged construction cell, in place of its faces';
  if (c.id === 'debris-face') return 'the debris rule, on an intact face opening toward a damaged cell';
  throw new Error(`no pass places ${c.id}`);
}

function roles(c: CaseDef): string {
  if (c.roles.length === CONSTRUCTION_ROLES.length && CONSTRUCTION_ROLES.every((r) => c.roles.includes(r))) return 'every construction role';
  return c.roles.map((r) => ROLE_NAME.get(r)!).join(', ');
}

/** The block a case's heading opens with: heading and facts. */
function expectedBlock(c: CaseDef): string {
  const lines = [`#### \`${c.id}\` · slot`, ''];
  lines.push(`- **Placed by:** ${placedBy(c)}`);
  lines.push(`- **Roles:** ${roles(c)}`);
  lines.push(`- **Base:** ${c.base} · **Coarse shape** (collision, navigation, light): ${c.shape}`);
  lines.push(`- **Stagger:** ${PIECE_STAGGER_FRAMES[c.id] !== undefined ? 'into the solid, scaled by the kit\'s jitter' : 'none'}`);
  lines.push(`- **Catalogue note:** ${c.note}`);
  return lines.join('\n');
}

const doc = readFileSync(DOC, 'utf8');
const HEADING_RE = /^#### `([a-z0-9_-]+)` · slot$/;

/** Case id → its section of the document (heading to the next heading of any level). */
function caseSections(): Map<string, { text: string; count: number }> {
  const lines = doc.split('\n');
  const out = new Map<string, { text: string; count: number }>();
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]!);
    if (m === null) continue;
    let j = i + 1;
    let fenced = false;
    for (; j < lines.length; j++) {
      if (lines[j]!.startsWith('```')) fenced = !fenced;
      if (!fenced && /^#{1,4} /.test(lines[j]!)) break;
    }
    const prev = out.get(m[1]!);
    out.set(m[1]!, { text: lines.slice(i, j).join('\n'), count: (prev?.count ?? 0) + 1 });
  }
  return out;
}

describe('role spec draft against the edge catalogue', () => {
  if (process.env.ROLE_SPEC_PRINT) {
    it('prints every case block', () => {
      for (const c of cat.cases) console.log(`--- ${c.id}\n${expectedBlock(c)}\n--- end`);
    });
  }

  it("is the world's catalogue, and the page names it, its version, its draft state and the numbers it states", () => {
    expect(WORLD_RULES.catalogue).toBe(cat);
    expect(cat.draft).toBe(true);
    expect(doc).toContain('DRAFT — awaiting owner approval (46c hard stop); nothing builds on it as final');
    expect(doc).toContain(`\`${cat.id}\` v${cat.version}`);
    expect(doc).toContain(`${cat.cases.length} cases`);
    expect(doc).toContain(`integrity ${DEBRIS_LIGHT_MIN}–14`);
    expect(doc).toContain(`1/${1 / PIECE_STAGGER.inwardMin}–1/${1 / PIECE_STAGGER.inwardMax} cell`);
    expect(doc).toContain(`${Math.round((PIECE_STAGGER.twistMax * 180) / Math.PI)}°`);
    expect(doc).toContain(`jitter 0–${PIECE_JITTER_MAX} (default ${PIECE_JITTER_DEFAULT})`);
    expect(doc).toContain(`rotation ${CUBE_ROTATION_X90} (X90`);
    expect(doc).toContain(`rotation ${CUBE_ROTATION_ZM90} (ZM90`);
  });

  it('has a heading for exactly the catalogue case ids, each once', () => {
    const sections = caseSections();
    const ids = cat.cases.map((c) => c.id);
    expect([...sections.keys()].filter((k) => !ids.includes(k)), 'in the document, not the catalogue').toEqual([]);
    expect(ids.filter((k) => !sections.has(k)), 'in the catalogue, not the document').toEqual([]);
    expect([...sections].filter(([, s]) => s.count > 1).map(([k]) => k), 'listed twice').toEqual([]);
  });

  it('has no window rules or fallbacks: every case is a slot a pass places', () => {
    expect(cat.rules).toEqual([]);
    expect(Object.values(cat.fallback).filter((f) => f !== null)).toEqual([]);
  });

  it("opens every case with the catalogue's facts (regenerate with ROLE_SPEC_PRINT=1)", () => {
    const sections = caseSections();
    const stale = cat.cases.filter((c) => !sections.get(c.id)?.text.startsWith(expectedBlock(c))).map((c) => c.id);
    expect(stale).toEqual([]);
  });

  it('draws every case: a diagram follows its facts', () => {
    const sections = caseSections();
    const bare = cat.cases.filter((c) => !sections.get(c.id)?.text.slice(expectedBlock(c).length).includes('```text')).map((c) => c.id);
    expect(bare).toEqual([]);
  });
});
