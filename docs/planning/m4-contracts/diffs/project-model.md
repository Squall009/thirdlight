# Owned diff rows — `project-model.md` (packet 65)

Proposal: `../templates.md` §6 (the named schema bump). Gate Q.
**PROPOSED — not accepted.** Every row below is the exact old/new text for
the promotion handoff. Single owner: the rows below are the only packet-65
changes to `project-model.md`; packet 64 owns no `project-model.md` rows.

## C65-1 — manifest `schemaVersion 2` + the `template` block

### Row 1: `project-model.md` §6 (version taxonomy — the manifest row)

OLD (the manifest entry of the version-taxonomy table; the accepted text
records the manifest as `schemaVersion 1`, known `[1]` — the exact row as
accepted):

```text
the project manifest (`project.json`) | `schemaVersion` (known `[1]`) |
```

NEW:

```text
the project manifest (`project.json`) | `schemaVersion` (known `[1, 2]`;
`2` adds the required `template` block — §7.1 C65-1; the accepted rule
"the authoring manifest is never re-versioned" is unchanged: migration
never re-versions a manifest; only the template-creation path writes a v2
manifest) |
```

### Row 2: `project-model.md` §7 (Top-level shape — add the v2 block)

OLD (the §7 opening: "Document type: `project-manifest`. Top-level shape
(schemaVersion 1):" + the six-field JSON example ending in the `scenes`
array; the §7.1 field table whose last row is `scenes[i].path`, followed by
the sentence "There are **no other top-level or nested fields** in
schemaVersion 1; unknown fields → `field_unexpected` (§12.6)."):

NEW (append after the v1 field table — the v1 text is kept verbatim; a v2
manifest is the v1 shape plus exactly one field):

```text
**schemaVersion 2 (M4, C65-1):** the v1 field set plus one **required**
field, `template`:

{
  "schemaVersion": 2,
  "engineVersion": "0.1.0",
  "id": "starter-0001",
  "name": "My Platformer",
  "createdAt": "2026-09-22T00:00:00Z",
  "scenes": [ { "id": "scene-main", "path": "scenes/main.json" } ],
  "template": {
    "templateId": "platformer-starter",
    "version": 1,
    "contentDigest": "<64 lowercase hex>",
    "engineVersion": "0.1.0"
  }
}

| Field | Type | Required | Constraint |
|---|---|---|---|
| `template` | object | yes **in `schemaVersion 2` only** (absent in v1) | exactly the four keys below; canonical key order `templateId`, `version`, `contentDigest`, `engineVersion` |
| `template.templateId` | string | yes | ID syntax (§5.1) |
| `template.version` | integer | yes | ≥ 1 (the template descriptor's `version`) |
| `template.contentDigest` | string | yes | 64 lowercase hex (the template descriptor's `contentDigest`) |
| `template.engineVersion` | string | yes | semver (§6); the template's declared engine version (provenance — distinct from the manifest's own `engineVersion`, which is the creating backend's) |

- `schemaVersion 2` is written **only** by the template-creation path
  (workspace.md §8.4 C65-3); plain `createProject` still writes a
  `schemaVersion 1` manifest, and the v2→v3 migration copy still keeps the
  destination manifest at `schemaVersion 1` (the accepted "never
  re-versioned" rule, workspace.md §16.5.2 — unchanged).
- The manifest remains **immutable after creation** in both schema
  versions (the accepted §7 rule); the `template` block is written once at
  creation and never edited. Project title/objective edits are
  `setGameConfig` edits of the envelope content, never manifest writes.
- Named combinations (C65-2): `(manifest 2, storage 3, scene 3)` is valid
  (the only new row); `(manifest 2, storage ≤ 2)` is
  `version_combination_unsupported` with reason
  `manifest_storage_mismatch`; `(manifest 1, storage 3)` stays valid
  (migrated projects). A pre-M4 engine meeting a v2 manifest reports the
  accepted unknown-field/`manifest_invalid` refusal (the standard schema
  bump consequence).
- `queryProject` (commands.md §5.6) carries the full normalized manifest —
  the v2 manifest (incl. `template`) flows through with **no query-shape
  change** (commands.md C65-9 adjudication).
```

## C65-2 — the `manifest_storage_mismatch` reason

### Row 3: `project-model.md` §12.6 (error codes) — cross-reference

OLD (the `version_combination_unsupported` row of §12.6 — a v3 envelope
whose scene version is wrong; the accepted row):

NEW (the row gains the manifest dimension — the exact added sentence):

```text
| `version_combination_unsupported` | a `storageVersion` 2 envelope whose
`scene.schemaVersion` is not 2 (**or a manifest `schemaVersion 2` paired
with `storageVersion ≤ 2`** — C65-2, reason `manifest_storage_mismatch`);
single error, deeper checks stop |
```

**No other `project-model.md` change.** The v1/v2/v3 scene and content
schemas, the component registry, the §15 default scene (v1) and the §23
v3 rules are untouched; the template base scene is template data
(templates.md §3), not a project-model default.