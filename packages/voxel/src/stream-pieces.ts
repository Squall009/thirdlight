/**
 * The kit piece table a streamer's derives choose detail pieces from
 * (piece-table.ts), and what a change of it derives again.
 *
 * A cell's piece reads its own material only (the case and run section
 * come from roles and fills), so when the table changes, only what holds a
 * material whose pieces changed is derived again: every derive section of
 * each resident chunk holding one, and every node of the levels that draw
 * pieces holding one; nothing within the rules' reach of them. And while a
 * kit binds a material, a change that feeds only the shader data (a
 * material paint) may move cells to another kit's pieces, so it rebuilds
 * the meshes too.
 */
import type { AssemblyRuleSet } from './assembly';
import { payloadHolds, type ChunkPayload } from './chunk-wire';
import type { ChunkCoord } from './coords';
import { pieceTableBindsKits, pieceTableChanges, type PieceTable } from './piece-table';
import { DERIVED_PART, MATERIAL_ID_MAX } from './record';
import type { SectionDerives } from './stream-sections';
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

  constructor(
    private readonly host: PiecesHost,
    table: PieceTable | null,
  ) {
    if (table !== null) checkRules(table, host.rules);
    this.current = table;
  }

  /** The table the derives choose pieces from (null: no kit, the default pieces). */
  get table(): PieceTable | null {
    return this.current;
  }

  /** The derived parts a change feeding `parts` makes stale while this table holds. */
  feeds(parts: number): number {
    return (parts & DERIVED_PART.shader) !== 0 && pieceTableBindsKits(this.current) ? parts | DERIVED_PART.mesh : parts;
  }

  /**
   * Sets the table (a kit was added, changed or removed). What it derives
   * again swaps in together (the `swap` event naming the returned group; 0
   * when nothing changed or the streamer derives nothing). Returns the group
   * and the storage chunks derived again.
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
    for (const c of this.host.resident()) {
      if (!holds(c.payload())) continue;
      chunks.push({ cx: c.cx, cy: c.cy, cz: c.cz });
      d.rederiveChunk(c.cx, c.cy, c.cz, group);
    }
    mips?.piecesChanged(holds, group);
    d.request(this.host.deriveMs, true);
    mips?.advanceEdits();
    d.settleGroup(group);
    return { group, chunks };
  }
}
