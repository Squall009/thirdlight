# Thirdlight — Agent Instructions

Persistent harness instruction for all Thirdlight work. Supplied by the
implementation prompts pack (docs/planning/implementation-prompts.md, v0.1)
and recorded during packet 00 (docs/handoffs/00.md). Merge any
harness-specific additions with this text; never delete it.

You are implementing Thirdlight, a self-hosted browser game editor built on
three.js. Work on exactly the assigned packet, not the entire product.

The backend owns project state. The browser and MCP use the same editing
commands. The coding harness shares the backend's filesystem workspace.
Exported games must run without the editor backend, MCP, or model service.

Read docs/STATUS.md, the assigned packet, and only the listed contracts and
relevant source/tests. Search selectively. Do not ingest the entire repository.
If you need more context, inspect public interfaces before implementations.

Respect module ownership and public exports. No cross-package internal imports,
hidden global services, or duplicate scene mutation paths. No runtime dependency
on editor/server/MCP code. Use strict TypeScript under the adopted stack decision.

Implement the smallest complete behavior that meets the packet. Do not add
unrequested frameworks, future game systems, or placeholder implementations
that pretend to satisfy acceptance criteria.

An accepted contract is binding. If it cannot satisfy the task, document the
specific issue and proposed contract diff; do not silently change it or build
a workaround that changes its meaning. Complete independent safe work first.

Preserve unrelated and uncommitted user changes. Do not reset the repository,
delete projects, push, publish, or install services outside the task scope.
Do not expose credentials in logs, browser bundles, fixtures, or handoffs.

Use the lockfile and recorded toolchain. Consult official documentation for
version-sensitive APIs. Record unavailable tools/network access; do not invent
versions, test results, screenshots, performance figures, or review approvals.

Test observable failure modes and module boundaries. For visual behavior,
verify in a browser when available; otherwise explicitly mark visual checks
unverified. Mocks alone do not establish integration success.

Finish with docs/handoffs/<packet-id>.md containing: outcome, changed files,
commands run and results, acceptance criteria passed/failed/unverified,
limitations, contract-change requests, and exact next packet. Update only
the relevant progress row in docs/STATUS.md. Do not automatically start it.

Keep the handoff concise, preferably under 1,000 words. Include a commit ID
if a commit was actually made, otherwise a scoped diff summary. Never claim
that another reviewer approved the work.
