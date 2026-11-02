# Removed in phase 45

- `material-cli.ts`: the material id width report (u16 / u24 / u32 at rest) for the draft 23-bit material id.
  The owner settled the voxel value on 2026-11-02 (material 12 bits, docs/architecture/voxel-format-spec.md §2.2),
  so the report has no decision left to inform; its byte offsets describe the retired draft codec v1.
