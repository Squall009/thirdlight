/**
 * The role spec draft (docs/architecture/voxel-role-spec.md) against the
 * case catalogue it is written from, so the document the owner approves
 * and the cases the engine resolves cannot drift apart: the document has a
 * heading for exactly the catalogue's cases, each marked required or
 * optional (and fallback) as the catalogue marks it, and each heading opens
 * with the facts and rule diagrams rendered from the catalogue itself.
 * Prose after that block is the document's own.
 *
 * To regenerate the blocks after a catalogue change, run this file with
 * ROLE_SPEC_PRINT=1: every case's expected block is printed between
 * `--- <case id>` markers, to paste over the old one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASE_REACH, CASE_WINDOW, CASE_WINDOW_CELLS, CELL, DEFAULT_KIT_PIECES, DRAFT_CASE_CATALOGUE, notCell, VOXEL_ROLE, type CaseDef, type CaseRule } from '@thirdlight/voxel';

const DOC = join(import.meta.dirname, '..', '..', 'docs', 'architecture', 'voxel-role-spec.md');
const cat = DRAFT_CASE_CATALOGUE;

const ROLE_NAME = new Map<number, string>(Object.entries(VOXEL_ROLE).map(([k, v]) => [v, k]));

/** The one-letter symbol a rule cell's accepted set is drawn with; the document's legend explains each. */
const SYMBOL = new Map<number, string>([
  [CELL.open, 'o'],
  [CELL.air, 'a'],
  [CELL.opening, 'D'],
  [CELL.ground, 'g'],
  [CELL.built, '#'],
  [CELL.solid, 'S'],
  [CELL.wall, 'W'],
  [CELL.floor, 'F'],
  [CELL.roof, 'R'],
  [CELL.foundation, 'N'],
  [CELL.stair, 'T'],
  [CELL.pillar, 'P'],
  [CELL.floor | CELL.roof, 'c'],
  [CELL.ground | CELL.foundation | CELL.floor, 'b'],
  [CELL.ground | CELL.floor | CELL.foundation | CELL.stair, 't'],
  [notCell(CELL.roof), 'r'],
  [notCell(CELL.pillar), 'p'],
]);

const inWindow = new Set(CASE_WINDOW.map((o) => o.join(',')));

function symbolOf(mask: number, where: string): string {
  const s = SYMBOL.get(mask);
  if (s === undefined) throw new Error(`${where}: no diagram symbol for the cell set ${mask.toString(2)}; add one here and to the document's legend`);
  return s;
}

/** A 5 × 5 grid of the window: rows then columns, each cell a symbol, `·` any, blank outside the window. */
function grid(cells: Map<string, string>, at: (row: number, col: number) => [number, number, number]): string[] {
  const out: string[] = [];
  for (let r = 0; r < 5; r++) {
    let line = '';
    for (let c = 0; c < 5; c++) {
      const o = at(r - 2, c - 2);
      const k = o.join(',');
      line += (k === '0,0,0' ? '@' : cells.get(k) ?? (inWindow.has(k) ? '·' : ' ')) + (c < 4 ? ' ' : '');
    }
    out.push(line);
  }
  return out;
}

/**
 * A rule drawn as a cut through the centre (x = 0: back −z left, front +z
 * right, up +y on top) and plans of the layers (x right, front +z down):
 * the level of the centre always, other layers only when they hold a rule
 * cell off the cut.
 */
function ruleDiagram(rule: CaseRule): string {
  const cells = new Map<string, string>();
  for (const [dx, dy, dz, mask] of rule.cells) cells.set(`${dx},${dy},${dz}`, symbolOf(mask, `rule for ${rule.case}`));
  const views: { title: [string, string]; lines: string[] }[] = [];
  const cut = grid(cells, (row, col) => [0, -row, col]);
  views.push({ title: ['   cut x=0', '   back→front'], lines: cut.map((l, i) => `${['+2', '+1', ' 0', '-1', '-2'][i]} ${l}`) });
  for (const y of [2, 1, 0, -1, -2]) {
    const off = rule.cells.some(([dx, dy]) => dy === y && dx !== 0);
    if (y !== 0 && !off) continue;
    views.push({ title: [`plan y${y > 0 ? '+' : y < 0 ? '-' : ' '}${Math.abs(y)}`, 'x→ front↓'], lines: grid(cells, (row, col) => [col, y, row]) });
  }
  const width = (v: (typeof views)[number]): number => Math.max(...v.title.map((t) => t.length), ...v.lines.map((l) => l.length));
  const rows: string[] = [];
  for (let i = 0; i < 7; i++) {
    rows.push(
      views
        .map((v) => (i < 2 ? v.title[i]! : v.lines[i - 2]!).padEnd(width(v)))
        .join('   ')
        .trimEnd(),
    );
  }
  return rows.join('\n');
}

const SECTIONS: Record<'x' | 'y' | 'none', string> = {
  x: 'along its own x → single, start, body, end, corner, junction',
  y: 'up its own y → single, start, body, end',
  none: 'none → single only',
};

function fallbackRoles(id: string): string[] {
  return Object.entries(cat.fallback)
    .filter(([, c]) => c === id)
    .map(([r]) => ROLE_NAME.get(Number(r))!);
}

function engineDefault(c: CaseDef): string {
  const p = DEFAULT_KIT_PIECES[c.id];
  if (p === undefined) throw new Error(`default kit lacks ${c.id}`);
  if (p !== null) return p.note;
  if (c.base === 'suppress') return `none: the engine's stand-in ${c.shape} (every kit's last fallback)`;
  if (c.base === 'reshape') return `none: the base surface draws the ${c.shape}`;
  return c.shape === 'none' ? 'none: nothing is drawn (an open gap)' : 'none: the base surface draws the cell';
}

/** The rules naming a case, in the order the matcher tries them. */
function rulesOf(id: string): CaseRule[] {
  return cat.rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.case === id)
    .sort((a, b) => b.r.priority - a.r.priority || a.i - b.i)
    .map(({ r }) => r);
}

/** The block a case's heading opens with: heading, facts, rules. */
function expectedBlock(c: CaseDef): string {
  const fb = fallbackRoles(c.id);
  const lines = [`#### \`${c.id}\` · ${c.required ? 'REQUIRED' : 'OPTIONAL'}${fb.length > 0 ? ' · FALLBACK' : ''}`, ''];
  const roles = c.roles.map((r) => ROLE_NAME.get(r)!).join(', ');
  lines.push(`- **Roles:** ${roles}${c.feature !== undefined ? ` · **Inferred feature:** ${c.feature}` : ''}${fb.length > 0 ? ` · **Fallback of:** ${fb.join(', ')}` : ''}`);
  lines.push(`- **Run → sections:** ${SECTIONS[c.run ?? 'none']}`);
  lines.push(`- **Base:** ${c.base} · **Coarse shape** (collision, navigation, light): ${c.shape}`);
  lines.push(`- **Engine default kit:** ${engineDefault(c)}`);
  lines.push(`- **Catalogue note:** ${c.note}`);
  const rules = rulesOf(c.id);
  if (rules.length === 0) {
    lines.push(`- **Rules:** none. Every ${roles} cell no other rule takes is this case.`);
    return lines.join('\n');
  }
  lines.push(`- **Rules:** ${rules.length}, tried in this order (an "or": any one matching is enough)`);
  rules.forEach((r, k) => {
    lines.push('', `Rule ${k + 1} · priority ${r.priority}${r.roles !== undefined ? ` · roles ${r.roles.map((x) => ROLE_NAME.get(x)).join(', ')}` : ''}`, '', '```text', ruleDiagram(r), '```');
  });
  return lines.join('\n');
}

const doc = readFileSync(DOC, 'utf8');
const HEADING_RE = /^#### `([a-z0-9_-]+)` · (REQUIRED|OPTIONAL)( · FALLBACK)?$/;

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
    out.set(m[1]!, { marks: `${m[2]}${m[3] ?? ''}`, text: lines.slice(i, j).join('\n'), count: (prev?.count ?? 0) + 1 });
  }
  return out;
}

describe('role spec draft against the case catalogue', () => {
  if (process.env.ROLE_SPEC_PRINT) {
    it('prints every case block', () => {
      for (const c of cat.cases) console.log(`--- ${c.id}\n${expectedBlock(c)}\n--- end`);
    });
  }

  it('names the catalogue, its version and draft state, and the window it reads', () => {
    expect(cat.draft).toBe(true);
    expect(doc).toContain('DRAFT — awaiting owner approval (46c hard stop); nothing builds on it as final');
    expect(doc).toContain(`\`${cat.id}\` v${cat.version}`);
    expect(doc).toContain(`${cat.cases.length} cases`);
    expect(doc).toContain(`reach ${CASE_REACH}`);
    expect(doc).toContain(`${CASE_WINDOW_CELLS} cells`);
  });

  it('has a heading for exactly the catalogue case ids, each once', () => {
    const sections = caseSections();
    const ids = cat.cases.map((c) => c.id);
    expect([...sections.keys()].filter((k) => !ids.includes(k)), 'in the document, not the catalogue').toEqual([]);
    expect(ids.filter((k) => !sections.has(k)), 'in the catalogue, not the document').toEqual([]);
    expect([...sections].filter(([, s]) => s.count > 1).map(([k]) => k), 'listed twice').toEqual([]);
  });

  it('marks every case required / optional / fallback as the catalogue does', () => {
    const sections = caseSections();
    const fallbacks = new Set(Object.values(cat.fallback));
    const wrong = cat.cases.filter((c) => sections.get(c.id)?.marks !== `${c.required ? 'REQUIRED' : 'OPTIONAL'}${fallbacks.has(c.id) ? ' · FALLBACK' : ''}`).map((c) => c.id);
    expect(wrong).toEqual([]);
  });

  it("opens every case with the catalogue's facts and rule diagrams (regenerate with ROLE_SPEC_PRINT=1)", () => {
    const sections = caseSections();
    const stale = cat.cases.filter((c) => !sections.get(c.id)?.text.startsWith(expectedBlock(c))).map((c) => c.id);
    expect(stale).toEqual([]);
  });

  it('explains every symbol the diagrams use in its legend', () => {
    const legend = doc.slice(doc.indexOf('<!-- legend -->'), doc.indexOf('<!-- /legend -->'));
    expect(legend.length).toBeGreaterThan(0);
    const missing = [...SYMBOL.values(), '@', '·'].filter((s) => !legend.includes(`| \`${s}\` |`));
    expect(missing).toEqual([]);
  });
});
