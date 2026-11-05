/**
 * The role spec draft (docs/architecture/voxel-role-spec.md) against the
 * edge catalogue it is written from, so the document the owner approves and
 * the cases the engine places cannot drift apart: the document has a
 * heading for exactly the catalogue's cases, each marked required or
 * optional as the catalogue marks it, and each heading opens with the facts
 * rendered from the catalogue, the passes and the engine's default kit.
 * Diagrams and prose after that block are the document's own.
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
  DEFAULT_KIT_PIECES,
  EDGE_CASE_CATALOGUE,
  EDGE_CASE_IDS,
  PIECE_STAGGER,
  ROOF_EDGE_CASE_IDS,
  VOXEL_ROLE,
  WORLD_RULES,
  type CaseDef,
} from '@thirdlight/voxel';

const DOC = join(import.meta.dirname, '..', '..', 'docs', 'architecture', 'voxel-role-spec.md');
const cat = EDGE_CASE_CATALOGUE;

const ROLE_NAME = new Map<number, string>(Object.entries(VOXEL_ROLE).map(([k, v]) => [v, k]));
const ROTATION_NAME = new Map<number, string>([
  [CUBE_ROTATION_X90, 'X90, a quarter turn about +x'],
  [CUBE_ROTATION_ZM90, 'ZM90, a quarter turn about −z'],
]);

const SECTIONS: Record<'x' | 'y' | 'none', string> = {
  x: 'a run along its own x: single, start, body, end, corner, junction',
  y: 'a run up its own y: single, start, body, end',
  none: 'none: one piece a place (the kit names it `body` or `single`)',
};

/** Which pass places a case. */
function placedBy(c: CaseDef): string {
  if ((EDGE_CASE_IDS as readonly string[]).includes(c.id)) return c.id.startsWith('corner-') ? 'the edge pass, one piece a lattice corner, yaw 0–3' : 'the edge pass, one piece a 0.5 m lattice edge, yaw 0–3';
  if ((ROOF_EDGE_CASE_IDS as readonly string[]).includes(c.id)) return 'the roof mesher, on roof plane cells';
  if (c.id === 'debris' || c.id === 'debris-heavy') return 'the debris rule, on an exposed damaged construction cell, in place of its faces';
  if (c.id === 'debris-face') return 'the debris rule, on an intact face opening toward a damaged cell';
  const n = cat.rules.filter((r) => r.case === c.id).length;
  return `the case window's rules (${n}), read from the arrangement`;
}

function roles(c: CaseDef): string {
  if (c.roles.length === CONSTRUCTION_ROLES.length && CONSTRUCTION_ROLES.every((r) => c.roles.includes(r))) return 'every construction role';
  return c.roles.map((r) => ROLE_NAME.get(r)!).join(', ');
}

function engineDefault(c: CaseDef): string {
  const p = DEFAULT_KIT_PIECES[c.id];
  if (p === undefined) throw new Error(`default kit lacks ${c.id}`);
  if (p === null) return c.base === 'suppress' ? `none: the engine's stand-in ${c.shape}${c.run !== null ? ' with its run sections' : ''} (every kit's last fallback)` : 'none: nothing is added (the faces show as they are)';
  if (p.alias !== undefined) return `alias of \`${p.alias.case}\`, rotation ${p.alias.rotation} (${ROTATION_NAME.get(p.alias.rotation) ?? 'a cube rotation'}): ${p.note}`;
  return `own mesh: ${p.note}`;
}

/** The block a case's heading opens with: heading and facts. */
function expectedBlock(c: CaseDef): string {
  const lines = [`#### \`${c.id}\` · ${c.required ? 'REQUIRED' : 'OPTIONAL'}`, ''];
  lines.push(`- **Placed by:** ${placedBy(c)}`);
  lines.push(`- **Roles:** ${roles(c)}${c.feature !== undefined ? ` · **Inferred feature:** ${c.feature}` : ''}`);
  lines.push(`- **Sections:** ${SECTIONS[c.run ?? 'none']}`);
  lines.push(`- **Base:** ${c.base} · **Coarse shape** (collision, navigation, light): ${c.shape}${c.standIn !== undefined ? ` · **Stand-in:** \`${c.standIn}\`` : ''}`);
  lines.push(`- **Engine default kit:** ${engineDefault(c)}`);
  lines.push(`- **Catalogue note:** ${c.note}`);
  return lines.join('\n');
}

const doc = readFileSync(DOC, 'utf8');
const HEADING_RE = /^#### `([a-z0-9_-]+)` · (REQUIRED|OPTIONAL)$/;

/** Case id → its section of the document (heading to the next heading of any level). */
function caseSections(): Map<string, { marks: string; text: string; count: number }> {
  const lines = doc.split('\n');
  const out = new Map<string, { marks: string; text: string; count: number }>();
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
    out.set(m[1]!, { marks: m[2]!, text: lines.slice(i, j).join('\n'), count: (prev?.count ?? 0) + 1 });
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
  });

  it('has a heading for exactly the catalogue case ids, each once', () => {
    const sections = caseSections();
    const ids = cat.cases.map((c) => c.id);
    expect([...sections.keys()].filter((k) => !ids.includes(k)), 'in the document, not the catalogue').toEqual([]);
    expect(ids.filter((k) => !sections.has(k)), 'in the catalogue, not the document').toEqual([]);
    expect([...sections].filter(([, s]) => s.count > 1).map(([k]) => k), 'listed twice').toEqual([]);
  });

  it('marks every case required / optional as the catalogue does', () => {
    const sections = caseSections();
    const wrong = cat.cases.filter((c) => sections.get(c.id)?.marks !== (c.required ? 'REQUIRED' : 'OPTIONAL')).map((c) => c.id);
    expect(wrong).toEqual([]);
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
