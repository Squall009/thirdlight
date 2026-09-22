# M4 planning handoff

## Outcome

Planning-only response to the owner's request: M3 is complete; write M4 packets
and the final owner review checklist. Produced 20 bounded packets (63–82), Gates
Q–U, 16 acceptance rows and 11 owner checklist sections. **Architectural plan
review remains pending; no execution authorization, contract promotion or owner
approval is claimed.** All implementation packets remain pending.

The plan covers a versioned platformer template, layout/module separation, a
pinned local engine kit and independent game, consistent backup/recovery,
diagnostics, measured desktop budgets and standalone export validation. It also
owns the recorded M3 delivery gaps (missing model attachment, unproved rendered
motion/preview, settings-query hydration, sample prefab copies), rather than
asking the owner to certify nonexistent behavior. Packet 63 reconciles conflicting
CC-55-3 descriptions and stale debt records against source/evidence.

## Changed files (this task only)

New:
- `docs/planning/m4-plan.md`
- `docs/planning/m4-packets.md`
- `docs/planning/m4-acceptance.md`
- `docs/acceptance/m4-owner-checklist.md`
- `docs/handoffs/m4-planning.md`

Targeted additions:
- `docs/STATUS.md`: M4 planning section/row only; historical M3/M2 text retained.
- `docs/planning/implementation-prompts.md`: links under the existing M4 prompt.

No commit. No product source, accepted contract, dependency, lockfile, fixture,
service or user project was changed. Pre-existing uncommitted M2/M3 work remains.
The repository-wide git diff includes that prior work; it is not this task's diff.

## Inspection and validation

Read the charter/M4 prompt, relevant STATUS/M3 planning/acceptance and Gates O/P,
workspace backup/dependency/export/presentation contracts, deployment/environment
records, and selected public package APIs/manifests. Selective `rg`/`find`/`ls`
located scope; `git status --short` established the dirty baseline.

- Python structural check: PASS — packets 63–82 sequential, every packet has
  read/write/boundary/failure/evidence/next fields; C01–C16 and O01–O11 present.
- Markdown relative-link check: PASS after all planning files were created.
- `git diff --check`: exit 0.
- Product tests/build/browser/performance: **not run** (documentation-only task).
  Historical M3 test totals are cited as records, not new results.

## Draft consistency check

One read-only model subsession identified four planning gaps; coordinator repairs
assigned capture-time module validation to 73-B, viewport integration to 70-B,
a hardware-only partial gate route with representative-scene target ratification,
and candidate kit regeneration/re-pinning after 78/80 changes. Two additional
clarifications require recoverable kit bytes in backups and template-replacement
independence tests. This was a draft check, **not architectural acceptance, owner
approval or independent human review**; the amended plan still needs review.

## Acceptance and limitations

Planning scope PASS: bounded packet dependencies/ownership, gate/promotion rules,
negative/integration/browser evidence, final desktop checklist and explicit stop.
M4 C01–C16: **UNVERIFIED**; no M4 implementation or performance claim exists.
Hardware/device selection, numeric budgets, final kit identity/licensing and
behavior-support disposition are explicit future decisions, not invented facts.
The checklist's tested launch sheet is a required packet-82 output; commands are
not fabricated before the template/distribution interfaces exist.

## Contract-change requests

No accepted contract changed. Future packets 64–68 must propose/review precise
render attachment, read-query, template initialization/module/layout, distribution,
backup/diagnostic and budget contracts, including version/graph effects. The
built-in-only template proposal does not silently waive existing behavior-delivery
promises; Gate Q must decide the reconciled scope explicitly.

## Exact next step

**Architectural review of the M4 planning set.** Record owner execution
authorization separately before packet 63. Do not start implementation, promote
contracts, run a live recovery drill, deploy or begin a later milestone.
