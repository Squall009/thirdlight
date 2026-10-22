# Thirdlight → art-factory: recommendations for review (2026-10-22)

These come from the Thirdlight engine team, for the art-factory (Studio /
Texture Designer) team. Thirdlight never edits the art-factory repo. Each
item says what the engine does today, what we'd like the art-factory to do,
and why. Please accept, change or decline each one. The engine side already
works without them; they remove waste or ambiguity.

The engine's written trim-sheet spec is
`docs/manual/guides/trim-sheet-spec.md` (in the Thirdlight repo). Items 3–5
refer to it.

## 1. KTX2 exports record their lossless source

**Engine today.** When a texture arrives as KTX2, the engine needs the lossless
original to re-encode it well, for example when it joins textures into an
array for a layered material. It treats a PNG as that original only if:
- the KTX2 records the PNG's digest, in the key/value entry
  `thirdlight.sourceSha256` (64 lowercase hex characters, NUL-terminated); or
- the import itself recorded the PNG (`convertedFrom`).

Otherwise the KTX2 is the only source. It is decoded and re-encoded, losing
quality, and the layer is flagged "re-encoded".

**Request.** When the Studio exports a KTX2 together with its PNG, write the
PNG's SHA-256 into the KTX2 as `thirdlight.sourceSha256`.

**Why.** Without it, every exported KTX2 the engine joins is encoded twice.
That loses quality and costs encode time on every import.

## 2. Opacity in trim-sheet decal cells

**Engine today.** Trim sheets put **height in the albedo's alpha** (spec,
"maps"). Decal cells on the same sheet need **opacity**. Until this is
settled, the engine reads a decal cell's albedo alpha as its opacity, or 1
if there is no alpha. That only works because a decal cell doesn't need
height.

**Request.** Pick one convention and write it into the spec. The engine
suggests:
- **inside cells marked as decal cells, albedo A = opacity;**
- everywhere else, albedo A = height.

The Texture Designer would then write opacity, not height, into those
cells.

**Alternative.** A separate opacity mask per sheet. That's one more texture
the engine would read only for decals.

## 3. The trim-sheet spec's defaults in the Texture Designer

**Engine spec** (`trim-sheet-spec.md`):
- sheets are 2048² at 512 px/m (a 4 m repeat across);
- gutters are 8 px and rows are aligned to 16 px;
- sides are a power of two;
- albedo is sRGB with height in A; normals are OpenGL-style (green up, the
  glTF reading).

**Request.** Make these the Texture Designer's defaults for new trim sheets:
- the service's default row alignment set to 16;
- the sheet size, pixels per metre and gutter as above.

**Why.** Sheets made with the defaults then pass the engine's kit check
without changes. Rows that start 8 px into 16-aligned bands keep mip levels
from bleeding between rows.

## 4. A neutral starter trim sheet and packing preset

**Request:**
- A starter trim sheet laid out with the spec's rows: the engine's Basic Kit
  sheet, `thirdlight/basic_kit_trim@4`, is one example.
- The **albedo + height packing** used by default for trim sheets.
- The preset that packs albedo + height renamed to a neutral name. It is
  currently named after a game; the engine docs call it "a packing preset that
  puts the height in A".

**Why.** New users get a sheet that works with the engine's kits out of the
box, and engine docs never name a game.

## 5. Real-height trims and the safe mip level

**Engine today.**
- A sheet that sets `trim.realHeight` repeats each trim at its true height on
  walls, instead of stretching one row per cell.
- The engine clamps mip levels to a row-safe level computed from the row
  table.

**Request:**
- New sheets set `trim.realHeight`.
- The Texture Designer records the row-safe mip level in the sheet's
  metadata, so both sides use the same number.

## Contact

Questions go through the owner. The engine reads the art-factory's answer
from the owner, or from a reply file the art-factory team puts in its own
repo.
