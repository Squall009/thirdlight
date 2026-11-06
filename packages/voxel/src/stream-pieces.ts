/**
 * The kit piece table a streamer's derives choose detail pieces from
 * (piece-table.ts), and what a change of it derives again.
 *
 * A cell's piece reads the material of its own cell or of one beside it
 * (the case comes from roles and fills; where roles meet, the dressing
 * cell's kit draws it), so when the table changes, only what holds a
 * material whose pieces changed is derived again: every derive section of
 * each resident chunk holding one, the sections of its neighbours with
 * construction within the edge pass's reach, and every node of the levels that draw pieces holding one;
 * nothing within the rules' wider reach.
 *
 * The same holds for an edit (the feeds mask: material and wetness are
 * shader data). Wetness never changes a piece. A material paint changes
 * pieces only where a cell moves to another kit's (the material it left
 * and the one it took bound to different kits): then the sections within
 * the edge pass's reach of the painted cells derive whole, and nothing past
 * them. A paint within one
 * kit keeps every piece and variant, so it stays shader data. The one
 * exception is a case catalogue whose rules read the same-material bit:
 * there materials decide cases, so a material paint feeds geometry.
 */
import type { AssemblyRuleSet } from './assembly';
import { payloadHolds, type ChunkPayload } from './chunk-wire';
import type { ChunkCoord } from './coords';
import { catalogueReadsMaterial } from './kit-cases';
import { pieceTableBindsKits, pieceTableChanges, pieceTableKitChanges, type PieceTable } from './piece-table';
import { ALL_DERIVED_PARTS, DERIVED_PART, isConstructionRole, MATERIAL_ID_MAX, ROLE_MASK, ROLE_SHIFT } from './record';
import { geometryParts, PIECES_AT_CELLS, type SectionDerives } from './stream-sections';
import type { StreamMips } from './stream-mips';

/** What the pieces need from the streamer that owns the chunks. */
export interface PiecesHost {
  readonly rules: AssemblyRuleSet | undefined;
  readonly derives: SectionDerives | null;
  readonly mips: StreamMips | null;
  /** Every resident chunk with its content as the game sees it. */
  resident(): Iterable<ChunkCoord & { payload(): ChunkPayload }>;
  /** Main-thread ms an update may spend building derive jobs. */
  readonly deriveMs: number;
}

/** Throws unless a piece table numbers the cases of `rules`. */
function checkRules(t: PieceTable, rules: AssemblyRuleSet | undefined): void {
  if (rules === undefined || t.rules.id !== rules.id || t.rules.version !== rules.version) throw new RangeError(`a piece table of rules ${t.rules.id} v${t.rules.version} for a streamer deriving with ${rules === undefined ? 'no rules' : `${rules.id} v${rules.version}`}`);
}

export class StreamPieces {
  private current: PieceTable | null;
  /** The rules' cases read materials: a material paint feeds geometry. */
  private readonly casesReadMaterial: boolean;
  /** The page's GPU bytes of the kit meshes and textures the pieces draw from (reported with its draws), counted in the stream budget. */
  gpuBytes = 0;

  constructor(
    private readonly host: PiecesHost,
    table: PieceTable | null,
  ) {
    if (table !== null) checkRules(table, host.rules);
    this.current = table;
    const cat = host.rules?.catalogue;
    this.casesReadMaterial = cat !== undefined && catalogueReadsMaterial(cat);
  }

  /** The table the derives choose pieces from (null: no kit, no pieces). */
  get table(): PieceTable | null {
    return this.current;
  }

  /**
   * What a change feeding `parts` (`fieldsFeed` of its fields) makes stale
   * while this table holds: `parts`, with {@link PIECES_AT_CELLS} when a
   * shader-only change moves cells to another kit's pieces. `swaps` are the
   * change's material changes (`EditOutcome.materialSwaps`; empty: wetness
   * alone). Without them (a refresh whose caller does not know) a
   * shader-only change counts as a material paint that may change kits.
   */
  feeds(parts: number, swaps?: readonly number[]): number {
    if ((parts & DERIVED_PART.shader) === 0 || geometryParts(parts)) return parts;
    if (swaps !== undefined && swaps.length === 0) return parts;
    if (this.casesReadMaterial) return ALL_DERIVED_PARTS;
    const moved = swaps === undefined ? pieceTableBindsKits(this.current) : pieceTableKitChanges(this.current, swaps);
    return moved ? parts | PIECES_AT_CELLS : parts;
  }

  /**
   * Sets the table (a kit was added, changed or removed). What it derives
   * again swaps in together (the `swap` event naming the returned group; 0
   * when nothing changed or the streamer derives nothing). Returns the group
   * and the storage chunks derived again whole (those holding a changed
   * material; their neighbours' sections beside them follow in the group).
   */
  set(table: PieceTable | null): { group: number; chunks: ChunkCoord[] } {
    if (table !== null) checkRules(table, this.host.rules);
    const changed = pieceTableChanges(this.current, table);
    this.current = table;
    const { derives: d, mips } = this.host;
    if (d === null || (changed !== null && changed.size === 0)) return { group: 0, chunks: [] };
    const holds = (p: ChunkPayload): boolean => payloadHolds(p, (v) => changed === null || changed.has(v & MATERIAL_ID_MAX));
    const group = d.newGroup();
    const chunks: ChunkCoord[] = [];
    const built = new Set<string>();
    for (const c of this.host.resident()) {
      const p = c.payload();
      if (payloadHolds(p, (v) => isConstructionRole((v >>> ROLE_SHIFT) & ROLE_MASK))) built.add(`${c.cx},${c.cy},${c.cz}`);
      if (!holds(p)) continue;
      chunks.push({ cx: c.cx, cy: c.cy, cz: c.cz });
      d.rederiveChunk(c.cx, c.cy, c.cz, group);
    }
    // A piece takes its kit from a cell beside its own where roles meet: neighbours with construction (a piece's own cell is one) follow.
    const taken = new Set(chunks.map((c) => `${c.cx},${c.cy},${c.cz}`));
    for (const c of chunks) d.rederiveBeside(c.cx, c.cy, c.cz, group, (x, y, z) => !taken.has(`${x},${y},${z}`) && built.has(`${x},${y},${z}`));
    mips?.piecesChanged(holds, group);
    d.request(this.host.deriveMs, true);
    mips?.advanceEdits();
    d.settleGroup(group);
    return { group, chunks };
  }
}
