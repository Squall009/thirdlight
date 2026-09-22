/**
 * Packet 28 — browser-only manual procedure (NOT run by vitest; this file has
 * no `*.test.ts` suffix on purpose and is never imported by a bundle).
 *
 * There is no browser and no WebGL context in this container, so every claim
 * below is **UNVERIFIED**. It is the packet-37/owner procedure for closing the
 * browser-only acceptance items (A05 capture/two instances/edit one/undo/redo/
 * reopen, A07 inspector + MCP convergence, and the panel pixels).
 *
 *  1. Serve the editor bundle (`npm run build`, then the packet-13/37 local
 *     deployment) on the authoring origin with a disposable `m2-course`
 *     project, and open the editor in a named desktop browser. Record OS,
 *     browser name/version, WebGL backend/renderer, window size, and the
 *     authoring + preview origins.
 *  2. Prepare a definition source: capture (or load) a small group subtree
 *     with one `box` and one `model` entity. Then press `create definition` in
 *     the Prefabs panel and confirm the definition appears with its entity
 *     count/depth (one `createPrefab` POST /commands; the scene revision
 *     advances by 1 while the Hierarchy is unchanged).
 *  3. Place Copy twice (press `place copy` twice). Confirm two distinct root
 *     IDs in the Hierarchy and that both copies render; each press is exactly
 *     one `instantiatePrefab` POST /commands. Confirm the panel/inspector say
 *     "Copy of <name> — copies are independent" and that no Link/Apply/Revert/
 *     variant control exists anywhere. Capture a real PNG per copy.
 *  4. Initial override: select the definition, edit one declared property
 *     (e.g. Speed 4.5 → 9.75) in the initial-override row, press `place copy`,
 *     and confirm the new copy's inspector shows 9.75 while the earlier copies
 *     still show their previous values. Confirm the request body carries the
 *     whole values map (every declared key) plus the one `{localId, key,
 *     value}` override.
 *  5. Edit one copy: select a copy's child entity with a behavior component,
 *     change one property in the Inspector's declared-property control and
 *     confirm exactly one `setBehaviorProperties` POST /commands, the other
 *     copy's values unchanged, and `undo`/`redo` restoring/forwarding the exact
 *     value. Record the before/after revision numbers.
 *  6. Reopen: reload the editor page (fresh session/attach) and confirm both
 *     copies, the definition and the modified values are rebuilt from the
 *     bounded `queryPrefabs`/`queryBehaviors`/`queryEntities` reads (no
 *     in-memory assumption) and render identically.
 *  7. MCP convergence without reload: from the external harness, issue one
 *     `setBehaviorProperties` (or `setTransform`) on a copy's entity and
 *     confirm the Inspector value and the viewport update from the
 *     `mutation.applied` event with **no page reload** and no polling.
 *  8. Failures: (a) type an out-of-range number / an unknown `entityId`
 *     reference / a too-long string into a control and confirm the bounded
 *     `property_value`/`reference_missing`/`property_type` error is shown and
 *     no command is sent; (b) attempt to capture the scene camera and confirm
 *     `prefab_camera_capture_forbidden`; (c) attempt to capture an existing
 *     copy and confirm `prefab_nested_forbidden`; (d) force a stale revision
 *     (edit from MCP between selecting and releasing) and confirm exactly one
 *     re-read + re-issue with a fresh `requestId` and then a surfaced
 *     `revision_conflict`; (e) drive the scene to the 1024-entity bound and
 *     confirm the backend-rejected `limits_exceeded` (`entities`) is shown with
 *     its current/max.
 *  9. Screenshot the Prefabs panel and the Inspector property/component
 *     controls, including the now-editable collider/controller controls (add
 *     collider/controller, edit a box collider's hx/hy, remove either) and
 *     confirm the resulting `setComponent` commands round-trip. Confirm no
 *     decorative/graph UI was added.
 */
export const PACKET_28_BROWSER_PROCEDURE = 'docs/acceptance/evidence-m2/28/manifest.md §Browser procedure (UNVERIFIED)';
