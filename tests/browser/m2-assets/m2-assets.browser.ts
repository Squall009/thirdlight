/**
 * Packet 27 — browser-only manual procedure (NOT run by vitest; this file has
 * no `*.test.ts` suffix on purpose and is never imported by a bundle).
 *
 * There is no browser and no WebGL context in this container, so every claim
 * below is **UNVERIFIED**. It is the packet-37/owner procedure for closing the
 * browser-only acceptance items (A02/A03/A08 pixels and network recording).
 *
 *  1. Serve the editor bundle (`npm run build`, then the local deployment from
 *     packet 13/37) on the authoring origin with a disposable `m2-course`
 *     project, and open the editor in a named desktop browser. Record OS,
 *     browser name/version, WebGL backend/renderer, window size, and the
 *     authoring + preview origins.
 *  2. Import: in the Assets panel choose `import…` and pick the fixture
 *     `tiny-v1.glb`. Observe the bounded job status advance
 *     staging → uploading → inspecting → proposed, then press `publish`.
 *     Record the browser network panel: exactly the stage POST, the 1 MiB
 *     frame PUT(s), the inspect POST and one `publishAsset` POST /commands.
 *  3. Preview: select the asset and press `load preview`; press `play`, wait,
 *     press `pause`, then scrub the range input. Capture a real PNG (not a
 *     stub) per state and confirm the clip pose visibly changes.
 *  4. Placement: place the imported asset directly twice (the Place control
 *     issues one `createEntity kind:"model"` per press — C27-1 repaired);
 *     also place two prefab copies. Confirm distinct entity IDs in the
 *     Hierarchy, move one with the gizmo and confirm the others do not move.
 *  5. Reimport: press `reimport…` with `tiny-v2.glb`. Before/after: the asset
 *     `currentVersion` moves, both placements keep their IDs and transforms,
 *     and both visibly render the new geometry. Press undo once and confirm the
 *     previous version is rendered again, with entity IDs/transforms unchanged.
 *  6. Snapping: with `snap: on` drag a translate gizmo; confirm the preview
 *     lands on 0.25 m world-axis steps; repeat for rotate (15°) and scale
 *     (uniform 0.25 factor, clamped to [0.01, 100]). Record the network panel
 *     across a whole drag: **zero** requests until release, then exactly one
 *     `setTransform`, then one undo. Repeat with Shift held: the preview is raw
 *     (unsnapped) for that gesture only. Press Esc mid-drag: no request at all.
 *  7. Failures: attempt an invalid drop (a `.obj`/truncated `.glb`) and confirm
 *     a structured `import_rejected`/`limits_exceeded` message, no stage bytes
 *     committed and the previous catalog/rendered placements unchanged. Start an
 *     import and cancel it; confirm the stage is discarded and nothing is sent.
 */
export const PACKET_27_BROWSER_PROCEDURE = 'docs/acceptance/evidence-m2/27/manifest.md §Browser procedure (UNVERIFIED)';
