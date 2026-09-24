#!/usr/bin/env node
// Thirdlight — fixture construction tool for fixtures/commands/** (storage v4)
//
// Purpose:
//   Generate the command/workspace contract corpus (project-file fixtures,
//   crash/ownership/external-change scenarios, command examples, and the
//   expected.json index) as byte-exact files with REAL SHA-256 digests, in
//   the storage-v4 layout (phase 12 c; packages/workspace/src/store-v4.ts):
//
//     project.json            manifest schemaVersion 2
//     content.json            { storageVersion 4, type "project-content",
//                               projectId, revision, content, retry }
//     scenes/<sceneId>.json   { storageVersion 4, type "scene", projectId,
//                               scene (schemaVersion 4), retry }
//
//   The v1 corpus this replaces is kept under
//   archive/removed-v1-v2/fixtures-commands-v1/ (phase 9.3).
//
// IMPORTANT:
//   This tool is FIXTURE TOOLING, not an implementation of the contracts.
//   It contains a minimal project/history model used only to build
//   consistent fixture bytes. The workspace and commands packages are
//   checked against these bytes by replaying the scenarios through the real
//   service (packages/workspace/tests/scenarios.test.ts and friends); where
//   the tool and the contracts ever disagree, the contracts win and this
//   tool (and its output) is a bug.
//
// Usage:
//   node tools/generate-fixtures.mjs            write all fixtures
//   node tools/generate-fixtures.mjs --check    verify committed fixtures
//                                               byte-for-byte (no writes)
"use strict";

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIX_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// canonical JSON
// ---------------------------------------------------------------------------

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Digest canonical form (commands.md §6.6): keys sorted in codepoint order
// at every level, no insignificant whitespace, JSON.stringify number rules.
function sortedDeep(v) {
  if (Array.isArray(v)) return v.map(sortedDeep);
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortedDeep(v[k]);
    return out;
  }
  return v;
}
const digestOf = (obj) => sha256(JSON.stringify(sortedDeep(obj)));

// File canonical form (store-v4.ts `jsonBytes`): objects are pre-built in
// fixed key order; 2-space indent, LF, one trailing newline.
const canonJson = (obj) => JSON.stringify(obj, null, 2) + "\n";

const deepCopy = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// the v4 project a new project starts as (createProject, then the automatic
// v3 → v4 upgrade on open): the M1 default camera plus the two starter
// lights (workspace migration.ts `initialEnvelopeBytesV3`), one scene
// "scene-main" named "Main", an empty content catalog.
// ---------------------------------------------------------------------------

const SCENE_ID = "scene-main";
const SCENE_REL = `scenes/${SCENE_ID}.json`;
const IDENTITY = () => ({ rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

function defaultEntities() {
  return [
    {
      id: "cam-main",
      name: "Main Camera",
      components: {
        transform: { position: [0, 0.5, 4], ...IDENTITY() },
        camera: { type: "perspective", fovY: 60, near: 0.1, far: 100 },
      },
    },
    {
      id: "light-0001",
      name: "Sun",
      components: {
        transform: { position: [0, 10, 0], ...IDENTITY() },
        light: { type: "directional", color: "#ffffff", intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: true },
      },
    },
    {
      id: "light-0002",
      name: "Ambient",
      components: {
        transform: { position: [0, 0, 0], ...IDENTITY() },
        light: { type: "ambient", color: "#8090a8", intensity: 0.6 },
      },
    },
  ];
}

function defaultScene() {
  return { schemaVersion: 4, sceneId: SCENE_ID, revision: 0, entities: defaultEntities() };
}

function defaultContent() {
  return {
    assets: [],
    prefabs: [],
    behaviors: [],
    settings: {},
    behaviorTrust: { entries: [] },
    game: null,
    scenes: [{ sceneId: SCENE_ID, name: "Main" }],
    startScenes: [SCENE_ID],
  };
}

function manifestObj(id, name, createdAt) {
  return { schemaVersion: 2, engineVersion: "0.1.0", id, name, createdAt };
}

const RETENTION = 128;

function contentFileObj(projectId, revision, content, records) {
  return { storageVersion: 4, type: "project-content", projectId, revision, content, retry: { retention: RETENTION, records } };
}

function sceneFileObj(projectId, scene, records) {
  return { storageVersion: 4, type: "scene", projectId, scene, retry: { retention: RETENTION, records } };
}

// ---------------------------------------------------------------------------
// minimal scene model (fixture construction only)
// ---------------------------------------------------------------------------

function fullTransform(partial = {}, base = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }) {
  const t = {};
  t.position = partial.position ? [...partial.position] : [...base.position];
  t.rotation = partial.rotation ? [...partial.rotation] : [...base.rotation];
  t.scale = partial.scale ? [...partial.scale] : [...base.scale];
  return t;
}

function makeEntity({ id, name, parentId, kind, transform, box }) {
  const e = { id };
  if (name !== undefined) e.name = name;
  if (parentId !== null && parentId !== undefined) e.parentId = parentId;
  e.components = { transform: fullTransform(transform) };
  if (kind === "box") {
    e.components.box = {
      size: box?.size ? [...box.size] : [1, 1, 1],
      material: { color: box?.material?.color ?? "#b0b0b0" },
    };
  }
  return e;
}

function entityById(scene, id) {
  const i = scene.entities.findIndex((e) => e.id === id);
  if (i < 0) throw new Error(`fixture-tool: entity not found: ${id}`);
  return { index: i, entity: scene.entities[i] };
}

function childrenOf(scene, id) {
  return scene.entities.filter((e) => e.parentId === id).map((e) => e.id);
}

function closureIds(scene, rootId) {
  const out = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const c = childrenOf(scene, queue.shift());
    for (const x of c) {
      out.push(x);
      queue.push(x);
    }
  }
  return out;
}

function nextEntityId(scene, kind) {
  const used = new Set(scene.entities.map((e) => e.id));
  for (let n = 1; n <= 9999; n++) {
    const cand = `${kind}-${String(n).padStart(4, "0")}`;
    if (!used.has(cand)) return cand;
  }
  throw new Error(`fixture-tool: id exhaustion for ${kind}`);
}

function applyCreate(scene, { kind, parentId = null, name, transform, box }) {
  const id = nextEntityId(scene, kind);
  const entity = makeEntity({ id, name, parentId, kind, transform, box });
  return { scene: { ...scene, entities: [...scene.entities, entity] }, entity, id };
}

function applySetTransform(scene, entityId, partial) {
  const { index, entity } = entityById(scene, entityId);
  const prev = entity.components.transform;
  const next = fullTransform(partial, prev);
  const updated = { ...entity, components: { ...entity.components, transform: next } };
  const entities = scene.entities.slice();
  entities[index] = updated;
  const changedFields = ["position", "rotation", "scale"].filter((f) => partial[f] !== undefined);
  return { scene: { ...scene, entities }, previous: prev, next, changedFields };
}

function applyDelete(scene, rootId) {
  const closure = new Set(closureIds(scene, rootId));
  const root = entityById(scene, rootId);
  const restoredParentId = root.entity.parentId ?? null;
  const entries = [];
  scene.entities.forEach((e, i) => {
    if (closure.has(e.id)) entries.push({ index: i, entity: e });
  });
  const entities = scene.entities.filter((e) => !closure.has(e.id));
  return { scene: { ...scene, entities }, deletedIds: entries.map((e) => e.entity.id), entries, restoredParentId };
}

function applyRestore(scene, entries, restoredParentId) {
  const ordered = [...entries].sort((a, b) => a.index - b.index);
  const out = scene.entities.slice();
  ordered.forEach((en, k) => {
    const ent = deepCopy(en.entity);
    if (k === 0) {
      if (restoredParentId === null) delete ent.parentId;
      else ent.parentId = restoredParentId;
      // rebuild canonical key order: id, name?, parentId?, components
      const rebuilt = { id: ent.id };
      if (ent.name !== undefined) rebuilt.name = ent.name;
      if (ent.parentId !== undefined) rebuilt.parentId = ent.parentId;
      rebuilt.components = ent.components;
      out.splice(en.index, 0, rebuilt);
    } else {
      out.splice(en.index, 0, ent);
    }
  });
  return { scene: { ...scene, entities: out }, restoredIds: ordered.map((e) => e.entity.id) };
}

function parentChain(scene, id) {
  const chain = [];
  let cur = entityById(scene, id).entity;
  while (cur.parentId !== undefined) {
    chain.unshift(cur.parentId);
    cur = entityById(scene, cur.parentId).entity;
  }
  return chain;
}

function cameraIdOf(scene) {
  const c = scene.entities.find((e) => e.components.camera);
  if (!c) throw new Error("fixture-tool: no camera");
  return c.id;
}

// light structural validation (tool self-check; NOT the contract validator)
function validateSceneLight(scene) {
  const ids = scene.entities.map((e) => e.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate id");
  for (const e of scene.entities) {
    if (e.parentId !== undefined && !ids.includes(e.parentId)) throw new Error(`dangling parent ${e.parentId}`);
  }
  const seen = new Set();
  for (const e of scene.entities) {
    if (e.parentId !== undefined && !seen.has(e.parentId)) throw new Error(`parent-before-child violated for ${e.id}`);
    seen.add(e.id);
  }
  const cams = scene.entities.filter((e) => e.components.camera);
  if (cams.length !== 1) throw new Error(`camera count ${cams.length}`);
}

const maskRevision = (scene) => ({ ...scene, revision: 0 });
const noChange = (a, b) => canonJson(maskRevision(a)) === canonJson(maskRevision(b));

// ---------------------------------------------------------------------------
// protocol builders (commands.md shapes, canonical key order)
// ---------------------------------------------------------------------------

function req(op, projectId, expectedRevision, requestId, origin, args) {
  const o = { op, projectId, expectedRevision, requestId };
  if (origin) o.origin = origin;
  o.args = args;
  return o;
}

const browserOrigin = { kind: "browser", clientId: "browser-demo" };
const mcpOrigin = { kind: "mcp", clientId: "pi-harness" };

const changeCreate = (id, entity) => ({ type: "createEntity", id, entity });
const changeSetTransform = (id, previous, next, changedFields) => ({ type: "setTransform", id, previous, next, changedFields });
const changeDelete = (rootId, deletedIds) => ({ type: "deleteEntity", rootId, deletedIds });
const changeRestore = (rootId, entities) => ({ type: "restoreSubtree", rootId, entities });

// The recorded §5.1 success payload (what a retry record carries).
function mutationSuccess({ op, projectId, requestId, revision, duplicated, createdId, change, appliedOf, originOfApplied, history }) {
  const o = { ok: true, op, projectId, requestId, revision, duplicated };
  if (createdId !== undefined) o.createdId = createdId;
  o.change = change;
  if (appliedOf !== undefined) o.appliedOf = appliedOf;
  if (originOfApplied !== undefined) o.originOfApplied = originOfApplied;
  o.history = { undoDepth: history.undoDepth, redoDepth: history.redoDepth };
  return o;
}

// The live acknowledgement of a v4 project additionally names the scene the
// command edited (`sceneId`, appended last). The retry record keeps the
// §5.1 payload without it, so an identical retry replays the record
// (`duplicated: true`) without `sceneId` (see scenarios/01 scenario.md).
const liveAck = (recorded) => ({ ...recorded, sceneId: SCENE_ID });
const replayOf = (recorded) => ({ ...deepCopy(recorded), duplicated: true });

function mutationError({ op, projectId, requestId, error }) {
  const o = { ok: false };
  if (op !== undefined) o.op = op;
  if (projectId !== undefined) o.projectId = projectId;
  if (requestId !== undefined) o.requestId = requestId;
  o.error = error;
  return o;
}

function errObj(code, cls, fields, message, hint) {
  const e = { code, cls, ...fields };
  e.message = message;
  if (hint !== undefined) e.hint = hint;
  return e;
}

const HINT_STALE = "re-read the project (queryProject) and re-issue the command with a fresh requestId and the current revision";
const HINT_PAUSED = "an operator must resolve the pending change (acceptExternalState or discardExternalState); dedup replays and queries remain available";

const revisionConflictError = (expectedRevision, currentRevision) =>
  errObj("revision_conflict", "conflict", { expectedRevision, currentRevision },
    "expected revision does not match the current project revision", HINT_STALE);
const requestIdReusedError = (currentRevision) =>
  errObj("request_id_reused", "conflict", { currentRevision },
    "requestId was already used with different content", HINT_STALE);

const recordObj = (requestId, digest, appliedRevision, result) => ({ requestId, digest, appliedRevision, result });

function ownershipObj({ state, backendId, pid, openedAt, lockEpoch }) {
  return { storageVersion: 1, state, backendId, pid, openedAt, lockEpoch };
}

// Exclusive claim file (workspace.md §6.3): the token an ACTIVE owner holds
// for the life of the session (key order: backendId, pid, openedAt).
const claimObj = ({ backendId, pid, openedAt }) => ({ backendId, pid, openedAt });

// ---------------------------------------------------------------------------
// fixture project (minimal v4 history/dedup model, commands.md §6/§7/§9)
// ---------------------------------------------------------------------------

class FixtureProject {
  constructor(projectId, manifest, files) {
    this.projectId = projectId;
    this.manifest = manifest;
    this.content = deepCopy(files.content);
    this.contentRevision = files.contentRevision;
    this.contentRecords = deepCopy(files.contentRecords);
    this.scene = deepCopy(files.scene);
    this.sceneRecords = deepCopy(files.sceneRecords);
    this.history = [];
    this.cursor = 0;
    this.snapshots = new Map();
  }

  static fresh(projectId, manifest) {
    return new FixtureProject(projectId, manifest, { content: defaultContent(), contentRevision: 0, contentRecords: [], scene: defaultScene(), sceneRecords: [] });
  }

  /** A fresh process on the files of a snapshot (empty history). */
  static fromSnapshot(projectId, manifest, snap) {
    return new FixtureProject(projectId, manifest, snap);
  }

  // The project revision is the highest revision of its files.
  get revision() {
    return Math.max(this.contentRevision, this.scene.revision);
  }

  /** The retry records of the project (the union over its files). */
  get records() {
    return [...this.contentRecords, ...this.sceneRecords].sort((a, b) => a.appliedRevision - b.appliedRevision);
  }

  files() {
    return {
      content: deepCopy(this.content),
      contentRevision: this.contentRevision,
      contentRecords: deepCopy(this.contentRecords),
      scene: deepCopy(this.scene),
      sceneRecords: deepCopy(this.sceneRecords),
    };
  }

  snapshot(tag) {
    this.snapshots.set(tag, this.files());
  }

  depths() {
    return { undoDepth: this.cursor, redoDepth: this.history.length - this.cursor };
  }

  apply(op, args) {
    if (op === "createEntity") return applyCreate(this.scene, args);
    if (op === "setTransform") return applySetTransform(this.scene, args.entityId, args.transform);
    if (op === "deleteEntity") return applyDelete(this.scene, args.entityId);
    throw new Error(`fixture-tool: unknown forward op ${op}`);
  }

  inverse(entry) {
    const inv = entry.inverse;
    if (inv.kind === "delete") {
      const r = applyDelete(this.scene, inv.rootId);
      return { scene: r.scene, change: changeDelete(inv.rootId, r.deletedIds) };
    }
    if (inv.kind === "setTransform") {
      const r = applySetTransform(this.scene, inv.id, { position: inv.restore.position, rotation: inv.restore.rotation, scale: inv.restore.scale });
      return { scene: r.scene, change: changeSetTransform(inv.id, r.previous, r.next, r.changedFields) };
    }
    if (inv.kind === "restoreSubtree") {
      const r = applyRestore(this.scene, inv.entries, inv.restoredParentId);
      return { scene: r.scene, change: changeRestore(inv.rootId, r.restoredIds.map((id) => r.scene.entities.find((e) => e.id === id))) };
    }
    throw new Error("fixture-tool: unknown inverse");
  }

  forward(entry) {
    const ch = entry.change;
    if (ch.type === "createEntity") {
      return { scene: { ...this.scene, entities: [...this.scene.entities, deepCopy(ch.entity)] }, change: ch };
    }
    if (ch.type === "setTransform") {
      const r = applySetTransform(this.scene, ch.id, { position: ch.next.position, rotation: ch.next.rotation, scale: ch.next.scale });
      return { scene: r.scene, change: changeSetTransform(ch.id, r.previous, r.next, r.changedFields) };
    }
    if (ch.type === "deleteEntity") {
      const r = applyDelete(this.scene, ch.rootId);
      return { scene: r.scene, change: changeDelete(ch.rootId, r.deletedIds) };
    }
    throw new Error("fixture-tool: unknown forward");
  }

  // Every op of this corpus edits the one scene: the transaction writes the
  // scene file only (stamped with the new project revision, the record
  // appended there); content.json keeps its revision and records.
  commit(scene) {
    const revision = this.revision + 1;
    validateSceneLight(scene);
    this.scene = { ...scene, revision };
    return revision;
  }

  /** Run one mutation; returns the recorded result (the live ack adds `sceneId`). */
  mutation(request, { op, undo, redo }) {
    const digest = digestOf(request);
    let result;
    if (undo || redo) {
      if (undo && this.cursor === 0) throw new Error("fixture-tool: undo on empty stack");
      if (redo && this.cursor === this.history.length) throw new Error("fixture-tool: redo on empty tail");
      const entry = undo ? this.history[this.cursor - 1] : this.history[this.cursor];
      const r = undo ? this.inverse(entry) : this.forward(entry);
      const revision = this.commit(r.scene);
      this.cursor += undo ? -1 : 1;
      result = mutationSuccess({
        op: undo ? "undo" : "redo", projectId: this.projectId, requestId: request.requestId,
        revision, duplicated: false, change: r.change,
        appliedOf: entry.requestId, originOfApplied: entry.origin, history: this.depths(),
      });
    } else {
      const args = request.args;
      const r = this.apply(op, args);
      let change;
      let createdId;
      if (op === "createEntity") {
        change = changeCreate(r.id, r.entity);
        createdId = r.id;
      } else if (op === "setTransform") {
        change = changeSetTransform(args.entityId, r.previous, r.next, r.changedFields);
      } else {
        change = changeDelete(args.entityId, r.deletedIds);
      }
      const revision = this.commit(r.scene);
      this.history = this.history.slice(0, this.cursor);
      this.history.push({
        requestId: request.requestId,
        origin: request.origin ?? null,
        change: deepCopy(change),
        inverse:
          op === "createEntity"
            ? { kind: "delete", rootId: r.id }
            : op === "setTransform"
              ? { kind: "setTransform", id: args.entityId, restore: deepCopy(r.previous) }
              : { kind: "restoreSubtree", rootId: args.entityId, entries: deepCopy(r.entries), restoredParentId: r.restoredParentId },
      });
      this.cursor += 1;
      result = mutationSuccess({
        op, projectId: this.projectId, requestId: request.requestId,
        revision, duplicated: false, createdId, change, history: this.depths(),
      });
    }
    this.sceneRecords.push(recordObj(request.requestId, digest, this.revision, result));
    if (this.sceneRecords.length > RETENTION) this.sceneRecords.shift();
    return result;
  }
}

/** The files of a project state: relative path → canonical bytes. */
function projectFiles(projectId, manifest, snap) {
  return {
    "project.json": canonJson(manifest),
    "content.json": canonJson(contentFileObj(projectId, snap.contentRevision, snap.content, snap.contentRecords)),
    [SCENE_REL]: canonJson(sceneFileObj(projectId, snap.scene, snap.sceneRecords)),
  };
}

const revisionOf = (snap) => Math.max(snap.contentRevision, snap.scene.revision);
const recordsOf = (snap) => [...snap.contentRecords, ...snap.sceneRecords];

// ---------------------------------------------------------------------------
// query results (the v4 shapes of workspace session-v4.ts `serveQueryV4`)
// ---------------------------------------------------------------------------

function queryProjectResult({ projectId, manifest, snap, history, workspace }) {
  const scene = snap.scene;
  return {
    ok: true,
    projectId,
    revision: revisionOf(snap),
    manifest,
    scene: { sceneId: scene.sceneId, schemaVersion: 4, entityCount: scene.entities.length, cameraId: cameraIdOf(scene) },
    scenes: snap.content.scenes.map((e) => ({ sceneId: e.sceneId, name: e.name, entityCount: scene.entities.length })),
    startScenes: [...snap.content.startScenes],
    history,
    workspace,
    tags: [],
  };
}

function queryEntityResult({ projectId, snap, entityId, includeSubtree }) {
  const scene = snap.scene;
  const { entity } = entityById(scene, entityId);
  const o = {
    ok: true,
    projectId,
    revision: revisionOf(snap),
    sceneId: scene.sceneId,
    entity,
    parentChain: parentChain(scene, entityId),
    childIds: childrenOf(scene, entityId),
    tagNames: { own: [], effective: [] },
  };
  if (includeSubtree) {
    const subtreeIds = closureIds(scene, entityId);
    o.subtree = { count: subtreeIds.length, entities: scene.entities.filter((e) => subtreeIds.includes(e.id)) };
  }
  return o;
}

function queryEntitiesResult({ projectId, snap, limit, offset }) {
  const page = snap.scene.entities.slice(offset, offset + limit);
  return {
    ok: true,
    projectId,
    revision: revisionOf(snap),
    total: snap.scene.entities.length,
    offset,
    limit,
    entities: page,
    entitySceneIds: page.map(() => snap.scene.sceneId),
  };
}

// ---------------------------------------------------------------------------
// the mainline timeline (demo-0001)
// ---------------------------------------------------------------------------

const P = "demo-0001";
const MAIN = manifestObj(P, "Demo Project", "2026-09-16T23:40:00Z");
const mainline = FixtureProject.fresh(P, MAIN);
mainline.snapshot("T0");

const A = (i) => `req-1${String(i).padStart(31, "0")}`; // req-1...01 .. req-1...07 (32 hex)

const mainlineRequests = {
  A1: req("createEntity", P, 0, A(1), browserOrigin, { kind: "box" }),
  A2: req("createEntity", P, 1, A(2), browserOrigin, { kind: "box" }),
  A3: req("setTransform", P, 2, A(3), mcpOrigin, { entityId: "box-0001", transform: { position: [1.5, 0.25, 0] } }),
  A4: req("createEntity", P, 3, A(4), browserOrigin, { kind: "group", name: "Walls" }),
  A5: req("setTransform", P, 4, A(5), mcpOrigin, { entityId: "box-0002", transform: { rotation: [0.7071067811865476, 0, 0, 0.7071067811865476] } }),
  A6: req("createEntity", P, 5, A(6), browserOrigin, { kind: "box" }),
  A7: req("createEntity", P, 6, A(7), mcpOrigin, { kind: "box" }),
};
const mainlineResults = {};
for (let i = 1; i <= 7; i++) {
  const r = mainlineRequests[`A${i}`];
  mainlineResults[`A${i}`] = mainline.mutation(deepCopy(r), { op: r.op });
  mainline.snapshot(`T${i}`);
}
// sanity: A7 must be box-0004 (after the camera, the two lights, box-0001..3, group-0001)
if (mainline.scene.entities.at(-1).id !== "box-0004") throw new Error("fixture-tool: A7 != box-0004");
if (mainline.revision !== 7 || mainline.contentRevision !== 0) throw new Error("fixture-tool: mainline revisions wrong");

const snapT = (i) => mainline.snapshots.get(`T${i}`);

// ---------------------------------------------------------------------------
// scenario 05 timeline (undo/redo, mixed origins) — demo-0001 from revision 0
// ---------------------------------------------------------------------------

const S5P = FixtureProject.fresh(P, MAIN);
const B = (i) => `req-2${String(i).padStart(31, "0")}`;

const s5 = [];
function s5m(request, mutate) {
  const recorded = S5P.mutation(request, mutate);
  s5.push({ in: request, out: liveAck(recorded) });
}
s5m(req("createEntity", P, 0, B(1), browserOrigin, { kind: "box", name: "Ground" }), { op: "createEntity" });
s5m(req("setTransform", P, 1, B(2), mcpOrigin, { entityId: "box-0001", transform: { position: [0, 0, -0.5] } }), { op: "setTransform" });
s5m(req("createEntity", P, 2, B(3), browserOrigin, { kind: "box", name: "Crate" }), { op: "createEntity" });
s5m(req("deleteEntity", P, 3, B(4), mcpOrigin, { entityId: "box-0002" }), { op: "deleteEntity" });
s5m(req("undo", P, 4, B(5), browserOrigin, {}), { undo: true });
s5m(req("undo", P, 5, B(6), browserOrigin, {}), { undo: true });
s5m(req("redo", P, 6, B(7), mcpOrigin, {}), { redo: true });
s5m(req("setTransform", P, 7, B(8), mcpOrigin, { entityId: "box-0001", transform: { position: [0, 0.25, -0.5] } }), { op: "setTransform" });
s5m(req("undo", P, 8, B(9), browserOrigin, {}), { undo: true });

(function verifyS5() {
  if (S5P.scene.entities.map((e) => e.id).join(",") !== "cam-main,light-0001,light-0002,box-0001,box-0002") {
    throw new Error("fixture-tool: S5 final entities wrong");
  }
  if (S5P.revision !== 9) throw new Error("fixture-tool: S5 final revision wrong");
  const box1 = entityById(S5P.scene, "box-0001").entity;
  if (JSON.stringify(box1.components.transform.position) !== JSON.stringify([0, 0, -0.5])) {
    throw new Error("fixture-tool: S5 box-0001 position wrong after undo");
  }
  const expected = [[1, 0], [2, 0], [3, 0], [4, 0], [3, 1], [2, 2], [3, 1], [4, 0], [3, 1]];
  s5.forEach((m, i) => {
    if (m.out.history.undoDepth !== expected[i][0] || m.out.history.redoDepth !== expected[i][1]) {
      throw new Error(`fixture-tool: S5 depth progression wrong at step ${i + 1}`);
    }
  });
})();

// ---------------------------------------------------------------------------
// scenario 03 (stale revision + recovery re-issue) — branches from T5
// ---------------------------------------------------------------------------

const C = (i) => `req-3${String(i).padStart(31, "0")}`;
const s3proj = FixtureProject.fromSnapshot(P, MAIN, snapT(5));
const s3StaleReq = req("setTransform", P, 4, C(1), browserOrigin, { entityId: "box-0001", transform: { position: [0.75, 0, 0] } });
const s3ReissueReq = req("setTransform", P, 5, C(2), browserOrigin, { entityId: "box-0001", transform: { position: [0.75, 0, 0] } });
const s3Result = s3proj.mutation(s3ReissueReq, { op: "setTransform" });

// ---------------------------------------------------------------------------
// scenario 04 (invalid transactions, no partial changes) — at T5
// ---------------------------------------------------------------------------

const D = (i) => `req-5${String(i).padStart(31, "0")}`;
const d4reqs = {
  zeroQuat: req("setTransform", P, 5, D(1), mcpOrigin, { entityId: "box-0001", transform: { rotation: [0, 0, 0, 0] } }),
  ghostDelete: req("deleteEntity", P, 5, D(2), mcpOrigin, { entityId: "ghost-0001" }),
  ghostParent: req("createEntity", P, 5, D(3), browserOrigin, { kind: "box", parentId: "ghost-0001" }),
  noChange: req("setTransform", P, 5, D(4), browserOrigin, { entityId: "box-0001", transform: { position: [1.5, 0.25, 0] } }),
};
// sanity: the no_change request must equal the current state
if (!noChange(snapT(5).scene, applySetTransform(snapT(5).scene, "box-0001", { position: [1.5, 0.25, 0] }).scene)) {
  throw new Error("fixture-tool: S4 no_change case is not actually a no-op");
}
const box1IndexT5 = entityById(snapT(5).scene, "box-0001").index;

// The detail object is the project-model's own error (commands.md §5.2
// passes it through verbatim); its text is the model's wording.
const zeroQuatModelError = {
  code: "quaternion_invalid",
  path: `/entities/${box1IndexT5}/components/transform/rotation`,
  message: "rotation quaternion must have unit length within 1e-4",
  found: [0, 0, 0, 0],
  expected: "finite [x,y,z,w] with |norm - 1| <= 1e-4",
  hint: "normalize to unit length; e.g. 45-degree yaw about Y is [0, 0.3826834323650898, 0, 0.9238795325112867]",
};
const d4errs = {
  zeroQuat: errObj("quaternion_invalid", "validation",
    { detailDocument: "result-scene", details: [zeroQuatModelError], detailCount: 1 },
    "resulting scene failed validation; state unchanged",
    "fix the request arguments and re-issue with a new requestId"),
  ghostDelete: errObj("entity_not_found", "validation", { entityId: "ghost-0001" },
    "entity 'ghost-0001' does not exist in the current scene",
    "query the scene (queryEntities) for current IDs, then re-issue with a fresh requestId"),
  ghostParent: errObj("reference_missing", "validation",
    { found: "ghost-0001", expected: "existing entity ID or null" },
    "parentId does not resolve to an existing entity"),
  // A project with a content catalog (every v4 project) compares scene AND
  // content (commands errors.ts `noChangeContent`; no hint).
  noChange: errObj("no_change", "validation", {},
    "the resulting scene and content are byte-identical to the current state"),
};

// ---------------------------------------------------------------------------
// scenario 08 (external modification) — continues the mainline at T7
// ---------------------------------------------------------------------------

const E = (i) => `req-6${String(i).padStart(31, "0")}`;
const T7 = snapT(7);
const t7Files = projectFiles(P, MAIN, T7);

// external edit of the scene file: box-0001 color -> #ff8800, everything
// else identical (revision 7, retry block copied)
const extScene = deepCopy(T7.scene);
entityById(extScene, "box-0001").entity.components.box.material.color = "#ff8800";
const extSceneBytes = canonJson(sceneFileObj(P, extScene, deepCopy(T7.sceneRecords)));
const extHash = sha256(extSceneBytes);
const extHash8 = extHash.slice(0, 8);

// acceptExternalState (session-v4.ts `acceptExternalV4`): every file is
// rewritten canonically with its retry records cleared; content.json is
// stamped with the project revision (7). Then the post-accept command.
const s8proj = FixtureProject.fromSnapshot(P, MAIN, { ...deepCopy(T7), scene: deepCopy(extScene), contentRevision: 7, contentRecords: [], sceneRecords: [] });
const acceptedFiles = projectFiles(P, MAIN, s8proj.files());
const e8req = req("setTransform", P, 7, E(2), mcpOrigin, { entityId: "box-0004", transform: { position: [0, 1, 0] } });
const e8result = s8proj.mutation(e8req, { op: "setTransform" });
const e8pauseReq = req("setTransform", P, 7, E(1), mcpOrigin, { entityId: "box-0004", transform: { position: [0, 1, 0] } });
const pendingChange = { snapshotState: "ok", externalHash: extHash, externalValid: true, externalErrorCount: 0 };

const ownerA = { backendId: "tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", pid: 5000, openedAt: "2026-09-17T09:00:00Z", lockEpoch: 0 };
const ownerB = { backendId: "tb-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", pid: 5150, openedAt: "2026-09-17T10:30:00Z", lockEpoch: 1 };
const ownerCrash = { backendId: "tb-42424242424242424242424242424242", pid: 4242, openedAt: "2026-09-17T08:30:00Z", lockEpoch: 0 };
const ownerC = { backendId: "tb-cccccccccccccccccccccccccccccccc", pid: 4300, openedAt: "2026-09-17T09:45:00Z", lockEpoch: 1 };

// ---------------------------------------------------------------------------
// retention boundary fixture (demo-0002): 129 commands, 128 records retained
// ---------------------------------------------------------------------------

const RET = "demo-0002";
const RETMAN = manifestObj(RET, "Retention Fixture", "2026-09-17T08:00:00Z");
const ret = FixtureProject.fresh(RET, RETMAN);
const F = (i) => `req-4${String(i).padStart(31, "0")}`;
const retRequest = (i) => (i === 1
  ? req("createEntity", RET, 0, F(1), browserOrigin, { kind: "box" })
  : req("setTransform", RET, i - 1, F(i), mcpOrigin, { entityId: "box-0001", transform: { position: [(i - 1) / 100, 0, 0] } }));
for (let i = 1; i <= 129; i++) ret.mutation(retRequest(i), { op: retRequest(i).op });
if (ret.revision !== 129) throw new Error("fixture-tool: retention revision wrong");
if (ret.sceneRecords.length !== 128) throw new Error("fixture-tool: retention record count wrong");
if (ret.sceneRecords[0].requestId !== F(2)) throw new Error("fixture-tool: eviction dropped the wrong record");
if (JSON.stringify(entityById(ret.scene, "box-0001").entity.components.transform.position) !== JSON.stringify([1.28, 0, 0])) {
  throw new Error("fixture-tool: retention final position wrong");
}

// ---------------------------------------------------------------------------
// file plan: relpath -> bytes (string)
// ---------------------------------------------------------------------------

const files = new Map();
const put = (rel, bytes) => {
  if (files.has(rel)) throw new Error(`fixture-tool: duplicate file ${rel}`);
  files.set(rel, bytes);
};
const putProject = (prefix, projectFileMap) => {
  for (const [rel, bytes] of Object.entries(projectFileMap)) put(path.posix.join(prefix, rel), bytes);
};

// --- valid project-file fixtures (each a whole v4 project directory)
const validDirs = {
  "demo-0001-rev0": projectFiles(P, MAIN, snapT(0)),
  "demo-0001-rev5": projectFiles(P, MAIN, snapT(5)),
  "demo-0001-rev6": projectFiles(P, MAIN, snapT(6)),
  "demo-0001-rev7": t7Files,
  "demo-0002-revision-129": projectFiles(RET, RETMAN, ret.files()),
};
for (const [name, fm] of Object.entries(validDirs)) putProject(`envelope/valid/${name}`, fm);

// --- invalid project-file fixtures: a whole project directory each, with
//     exactly one defect (loadV4 must block it with the pinned reason).
const rev0 = validDirs["demo-0001-rev0"];
const rev5 = validDirs["demo-0001-rev5"];
const invalid = {};
{
  // storageVersion 3 in a v4 scene file
  const o = JSON.parse(rev0[SCENE_REL]);
  invalid["storage-version-unsupported"] = { ...rev0, [SCENE_REL]: canonJson({ ...o, storageVersion: 3 }) };
}
{
  // content.json without its "type" key
  const lines = rev0["content.json"].trimEnd().split("\n").filter((l) => !l.startsWith('  "type"'));
  invalid["type-missing"] = { ...rev0, "content.json": lines.join("\n") + "\n" };
}
{
  // the scene file names another project
  const o = JSON.parse(rev0[SCENE_REL]);
  invalid["project-mismatch"] = { ...rev0, [SCENE_REL]: canonJson({ ...o, projectId: "demo-0002" }) };
}
{
  // the camera's rotation is not a unit quaternion
  const o = JSON.parse(rev0[SCENE_REL]);
  o.scene.entities[0].components.transform.rotation = [0, 0, 0, 0];
  invalid["embedded-scene-invalid"] = { ...rev0, [SCENE_REL]: canonJson(o) };
}
{
  // two records with the same appliedRevision (not strictly ascending)
  const o = JSON.parse(rev5[SCENE_REL]);
  o.retry.records[1].appliedRevision = o.retry.records[0].appliedRevision;
  invalid["retry-records-non-ascending"] = { ...rev5, [SCENE_REL]: canonJson(o) };
}
{
  // a duplicated "projectId" key in content.json
  const b = rev0["content.json"];
  const idx = b.indexOf('  "projectId"');
  const lineEnd = b.indexOf("\n", idx);
  invalid["duplicate-key"] = { ...rev0, "content.json": b.slice(0, lineEnd + 1) + b.slice(idx, lineEnd + 1) + b.slice(lineEnd + 1) };
}
{
  // the content index names a scene whose file is missing
  const { [SCENE_REL]: _gone, ...rest } = rev0;
  invalid["scene-file-missing"] = rest;
}
{
  // the scene file holds a different scene id than its file name
  const o = JSON.parse(rev0[SCENE_REL]);
  o.scene.sceneId = "scene-other";
  invalid["scene-id-mismatch"] = { ...rev0, [SCENE_REL]: canonJson(o) };
}
for (const [name, fm] of Object.entries(invalid)) putProject(`envelope/invalid/${name}`, fm);

// --- scenarios
const sc = (dir, ...parts) => path.posix.join("scenarios", dir, ...parts);
const putDisk = (dir, which, fm) => putProject(sc(dir, which), fm);

// 01 — retry after lost acknowledgement (replay of A5 at T5)
putDisk("01-retry-lost-ack", "disk-before", rev5);
put(sc("01-retry-lost-ack", "messages.json"), canonJson([{ in: deepCopy(mainlineRequests.A5), out: replayOf(mainlineResults.A5) }]));

// 02 — requestId reuse with different content
putDisk("02-request-id-reused", "disk-before", rev5);
put(sc("02-request-id-reused", "messages.json"), canonJson([
  {
    in: req("deleteEntity", P, 5, A(5), mcpOrigin, { entityId: "box-0002" }),
    out: mutationError({ op: "deleteEntity", projectId: P, requestId: A(5), error: requestIdReusedError(5) }),
  },
]));

// 03 — stale revision + recovery re-issue
putDisk("03-stale-revision", "disk-before", rev5);
put(sc("03-stale-revision", "messages.json"), canonJson([
  { in: s3StaleReq, out: mutationError({ op: "setTransform", projectId: P, requestId: C(1), error: revisionConflictError(4, 5) }) },
  { in: s3ReissueReq, out: liveAck(s3Result) },
]));
putDisk("03-stale-revision", "disk-after", projectFiles(P, MAIN, s3proj.files()));

// 04 — invalid transactions, no partial changes
putDisk("04-invalid-no-partial", "disk-before", rev5);
put(sc("04-invalid-no-partial", "messages.json"), canonJson([
  { in: d4reqs.zeroQuat, out: mutationError({ op: "setTransform", projectId: P, requestId: D(1), error: d4errs.zeroQuat }) },
  { in: d4reqs.ghostDelete, out: mutationError({ op: "deleteEntity", projectId: P, requestId: D(2), error: d4errs.ghostDelete }) },
  { in: d4reqs.ghostParent, out: mutationError({ op: "createEntity", projectId: P, requestId: D(3), error: d4errs.ghostParent }) },
  { in: d4reqs.noChange, out: mutationError({ op: "setTransform", projectId: P, requestId: D(4), error: d4errs.noChange }) },
]));

// 05 — undo/redo with mixed human/agent edits
putDisk("05-undo-redo-mixed", "disk-before", rev0);
put(sc("05-undo-redo-mixed", "messages.json"), canonJson(s5));
putDisk("05-undo-redo-mixed", "disk-after", projectFiles(P, MAIN, S5P.files()));

// disk-after for 01, 02 and 04: byte-identical copies of disk-before (replay / rejections)
for (const dir of ["01-retry-lost-ack", "02-request-id-reused", "04-invalid-no-partial"]) putDisk(dir, "disk-after", rev5);

// 06 — crash before the atomic replacement of the scene file
const t6Files = validDirs["demo-0001-rev6"];
putDisk("06-crash-before-replace", "disk-before", t6Files);
put(sc("06-crash-before-replace", "disk-before/scenes/.scene-main.json.tmp-4242-7"), t7Files[SCENE_REL]);
put(sc("06-crash-before-replace", "disk-before/.thirdlight/ownership.json"), canonJson(ownershipObj({ state: "owned", ...ownerCrash })));
put(sc("06-crash-before-replace", "messages.json"), canonJson([
  {
    in: { op: "queryProject", projectId: P },
    out: queryProjectResult({ projectId: P, manifest: MAIN, snap: snapT(6), history: { undoDepth: 0, redoDepth: 0 }, workspace: { writePaused: false } }),
  },
  // No record exists (the rename never happened): the retry re-executes fresh.
  // A fresh process has an empty history, so the ack's depths are (1, 0).
  { in: deepCopy(mainlineRequests.A7), out: liveAck({ ...deepCopy(mainlineResults.A7), history: { undoDepth: 1, redoDepth: 0 } }) },
]));
// The record written by the fresh re-execution carries the fresh depths too,
// so the rev-7 scene file differs from the mainline's only in that record's
// history block.
const s6After = (() => {
  const f = deepCopy(T7);
  f.sceneRecords.at(-1).result.history = { undoDepth: 1, redoDepth: 0 };
  return f;
})();
putDisk("06-crash-before-replace", "disk-after", projectFiles(P, MAIN, s6After));
put(sc("06-crash-before-replace", "disk-after/.thirdlight/ownership.json"), canonJson(ownershipObj({ state: "owned", ...ownerC })));

// 07 — crash after the atomic replacement of the scene file
putDisk("07-crash-after-replace", "disk-before", t7Files);
put(sc("07-crash-after-replace", "disk-before/.thirdlight/ownership.json"), canonJson(ownershipObj({ state: "owned", ...ownerCrash })));
put(sc("07-crash-after-replace", "messages.json"), canonJson([
  {
    in: { op: "queryProject", projectId: P },
    out: queryProjectResult({ projectId: P, manifest: MAIN, snap: T7, history: { undoDepth: 0, redoDepth: 0 }, workspace: { writePaused: false } }),
  },
  { in: deepCopy(mainlineRequests.A7), out: replayOf(mainlineResults.A7) },
]));
putDisk("07-crash-after-replace", "disk-after", t7Files);
put(sc("07-crash-after-replace", "disk-after/.thirdlight/ownership.json"), canonJson(ownershipObj({ state: "owned", ...ownerC })));

// 08 — unexpected external modification of the scene file
putDisk("08-external-modification", "disk-before", t7Files);
put(sc("08-external-modification", "disk-before/.thirdlight/ownership.json"), canonJson(ownershipObj({ state: "owned", ...ownerA })));
put(sc("08-external-modification", "disk-before/.thirdlight/claim-0"), canonJson(claimObj(ownerA)));
put(sc("08-external-modification", `disk-external/${SCENE_REL}`), extSceneBytes);
put(sc("08-external-modification", "messages.json"), canonJson([
  {
    in: e8pauseReq,
    out: mutationError({
      op: "setTransform", projectId: P, requestId: E(1),
      error: errObj("external_change_unresolved", "unavailable", { pendingChange },
        "an unexpected external modification is pending resolution; writes are paused", HINT_PAUSED),
    }),
  },
  {
    in: { op: "queryProject", projectId: P },
    out: queryProjectResult({
      projectId: P, manifest: MAIN, snap: T7, history: { undoDepth: 0, redoDepth: 0 },
      workspace: { writePaused: true, pauseReason: "external_change", pendingChange: { ...pendingChange, externalErrors: [] } },
    }),
  },
  { in: { op: "acceptExternalState", projectId: P }, out: { ok: true, revision: 7, historyReset: true, retryCleared: true } },
  { in: e8req, out: liveAck(e8result) },
]));
putDisk("08-external-modification", "disk-after", projectFiles(P, MAIN, s8proj.files()));
put(sc("08-external-modification", "disk-after/.thirdlight/ownership.json"), canonJson(ownershipObj({ state: "owned", ...ownerA })));
put(sc("08-external-modification", `disk-after/.thirdlight/recovery/scene-20260917T101500Z-${extHash8}.json`), extSceneBytes);

// 09 — second-backend ownership rejection, then the automatic reclaim
putDisk("09-second-backend-ownership", "disk-before", t7Files);
put(sc("09-second-backend-ownership", "disk-before/.thirdlight/ownership.json"), canonJson(ownershipObj({ state: "owned", ...ownerA })));
put(sc("09-second-backend-ownership", "disk-before/.thirdlight/claim-0"), canonJson(claimObj(ownerA)));
{
  const holderA = { backendId: ownerA.backendId, pid: ownerA.pid, openedAt: ownerA.openedAt, lockEpoch: ownerA.lockEpoch, state: "owned" };
  put(sc("09-second-backend-ownership", "messages.json"), canonJson([
    {
      in: { op: "queryProject", projectId: P },
      out: mutationError({
        op: "queryProject", projectId: P,
        error: errObj("project_unavailable", "unavailable", { reason: "ownership_conflict", holder: holderA },
          "project cannot be used right now: ownership_conflict",
          "another live backend owns this project; stop it or wait for an operator takeover"),
      }),
    },
    {
      in: { op: "queryProject", projectId: P },
      out: queryProjectResult({ projectId: P, manifest: MAIN, snap: T7, history: { undoDepth: 0, redoDepth: 0 }, workspace: { writePaused: false } }),
    },
  ]));
}
putDisk("09-second-backend-ownership", "disk-after", t7Files);
put(sc("09-second-backend-ownership", "disk-after/.thirdlight/ownership.json"), canonJson(ownershipObj({ state: "owned", ...ownerB })));

// --- examples/commands.json (live acknowledgements, v4 query shapes)
{
  const t5 = snapT(5);
  const examples = {
    createEntity: { request: mainlineRequests.A1, result: liveAck(mainlineResults.A1) },
    setTransform: { request: mainlineRequests.A3, result: liveAck(mainlineResults.A3) },
    deleteEntity: { request: s5[3].in, result: s5[3].out },
    undo: { request: s5[4].in, result: s5[4].out },
    redo: { request: s5[6].in, result: s5[6].out },
    retryReplay: { request: mainlineRequests.A5, result: replayOf(mainlineResults.A5) },
    queries: {
      queryProject: {
        request: { op: "queryProject", projectId: P },
        result: queryProjectResult({ projectId: P, manifest: MAIN, snap: t5, history: { undoDepth: 0, redoDepth: 0 }, workspace: { writePaused: false } }),
      },
      queryEntity: {
        request: { op: "queryEntity", projectId: P, args: { entityId: "box-0002", includeSubtree: true } },
        result: queryEntityResult({ projectId: P, snap: t5, entityId: "box-0002", includeSubtree: true }),
      },
      queryEntities: {
        request: { op: "queryEntities", projectId: P, args: { limit: 2, offset: 0 } },
        result: queryEntitiesResult({ projectId: P, snap: t5, limit: 2, offset: 0 }),
      },
    },
  };
  put("examples/commands.json", canonJson(examples));
}

// --- expected.json (machine-readable index)
{
  const outcome = (m) => (m.out.ok
    ? { kind: "success", revision: m.out.revision, duplicated: m.out.duplicated }
    : { kind: "error", code: m.out.error.code, cls: m.out.error.cls });
  const validEntry = (name, project, snap, note) => ({ dir: `envelope/valid/${name}`, project, revision: revisionOf(snap), records: recordsOf(snap).length, note });
  const idx = {
    indexVersion: 2,
    storage: "v4: project.json (manifest schemaVersion 2), content.json (storageVersion 4, type project-content), scenes/<sceneId>.json (storageVersion 4, type scene, scene schemaVersion 4)",
    contracts: {
      commands: "docs/contracts/commands.md",
      workspace: "docs/contracts/workspace.md (storage v4: packages/workspace/src/store-v4.ts)",
      projectModel: "docs/contracts/project-model.md (v4: packages/project-model/src/project-v4.ts)",
    },
    notes: [
      "Each scenario is self-contained: disk-before pins the exact on-disk project (all files), messages.json the ordered request/result pairs, disk-after the exact resulting files. Scenarios 01-04/06-09 share the demo-0001 mainline timeline (T0..T7, commands A1..A7, requestId prefix req-1...); scenario 05 is a separate demo-0001 timeline from revision 0 (prefix req-2...); the retention fixture uses demo-0002 (prefix req-4...).",
      "Every command of the corpus edits the one scene: it writes scenes/scene-main.json only (stamped with the new project revision, the retry record appended there); content.json keeps revision 0 and no records, except after acceptExternalState (scenario 08), which rewrites every file with its records cleared and stamps content.json with the project revision.",
      "A live acknowledgement of a v4 project names the edited scene (sceneId, last key); the retry record stores the commands.md §5.1 payload without it, so a replay (duplicated: true) has no sceneId.",
      "File bytes are canonical (2-space indent, LF, one trailing newline, fixed key order). Record digests are real SHA-256 over the digest-canonical request bytes (commands.md §6.6) — recompute with tools/generate-fixtures.mjs --check.",
    ],
    envelopeFixtures: [
      validEntry("demo-0001-rev0", P, snapT(0), "a new project (camera + two starter lights); empty retry blocks"),
      validEntry("demo-0001-rev5", P, snapT(5), "mainline T5; used by scenarios 01-04"),
      validEntry("demo-0001-rev6", P, snapT(6), "mainline T6; used by scenario 06"),
      validEntry("demo-0001-rev7", P, T7, "mainline T7; used by scenarios 07-09; its scene file is also the crash-window temp content in 06"),
      validEntry("demo-0002-revision-129", RET, ret.files(), "retention boundary: 129 commands applied, oldest record evicted (first retained record is req-40000000000000000000000000000002)"),
      { dir: "envelope/invalid/storage-version-unsupported", reason: "storage_version_unsupported", code: "storage_version_unsupported", file: SCENE_REL },
      { dir: "envelope/invalid/type-missing", reason: "envelope_invalid", code: "envelope_invalid", file: "content.json", detail: "required key 'type' is missing" },
      { dir: "envelope/invalid/project-mismatch", reason: "envelope_invalid", code: "envelope_invalid", file: SCENE_REL, detail: "projectId must equal the project directory name" },
      { dir: "envelope/invalid/embedded-scene-invalid", reason: "scene_invalid", code: "quaternion_invalid", file: SCENE_REL, detail: "cam-main rotation [0,0,0,0]" },
      { dir: "envelope/invalid/retry-records-non-ascending", reason: "retry_records_invalid", code: "retry_records_invalid", file: SCENE_REL },
      { dir: "envelope/invalid/duplicate-key", reason: "envelope_invalid", code: "duplicate_key", file: "content.json" },
      { dir: "envelope/invalid/scene-file-missing", reason: "envelope_invalid", code: "envelope_invalid", file: SCENE_REL },
      { dir: "envelope/invalid/scene-id-mismatch", reason: "manifest_scene_mismatch", code: "manifest_scene_mismatch", file: SCENE_REL },
    ],
    scenarios: [
      { dir: "scenarios/01-retry-lost-ack", name: "retry after lost acknowledgement", outcomes: [{ kind: "success", revision: 5, duplicated: true }], finalRevision: 5, invariants: ["disk-after bytes identical to disk-before (replay changes nothing)", "record R5 present in the scene file with appliedRevision 5", "the replay is the recorded payload (no sceneId)"] },
      { dir: "scenarios/02-request-id-reused", name: "requestId reuse with different content", outcomes: [{ kind: "error", code: "request_id_reused", cls: "conflict" }], finalRevision: 5, invariants: ["disk-after bytes identical to disk-before"] },
      { dir: "scenarios/03-stale-revision", name: "stale revision + recovery re-issue", outcomes: [{ kind: "error", code: "revision_conflict", cls: "conflict" }, { kind: "success", revision: 6, duplicated: false }], finalRevision: 6, invariants: ["recovery re-issue uses a fresh requestId (req-3...02) and the current revision", "only the scene file changes"] },
      { dir: "scenarios/04-invalid-no-partial", name: "invalid transactions leave no partial changes", outcomes: [{ kind: "error", code: "quaternion_invalid", cls: "validation" }, { kind: "error", code: "entity_not_found", cls: "validation" }, { kind: "error", code: "reference_missing", cls: "validation" }, { kind: "error", code: "no_change", cls: "validation" }], finalRevision: 5, invariants: ["disk-after bytes identical to disk-before (four rejected commands, zero state change)"] },
      { dir: "scenarios/05-undo-redo-mixed", name: "undo/redo with mixed human/agent edits", outcomes: s5.map((m) => outcome(m)), finalRevision: 9, invariants: ["depth progression after each step: [1,0] [2,0] [3,0] [4,0] [3,1] [2,2] [3,1] [4,0] [3,1]", "undo of the mcp delete restores box-0002 (originOfApplied kind mcp)", "fresh mcp edit at step 8 invalidates redo (redoDepth 0)", "final entities: cam-main, light-0001, light-0002, box-0001 (position [0,0,-0.5]), box-0002", "9 records retained in the scene file (undo/redo are recorded mutations)"] },
      { dir: "scenarios/06-crash-before-replace", name: "crash before atomic replacement", outcomes: [{ kind: "query", op: "queryProject", revision: 6, writePaused: false }, { kind: "success", revision: 7, duplicated: false }], finalRevision: 7, invariants: ["load after restart reports revision 6 (the temp is ignored and cleaned)", "leftover temp scenes/.scene-main.json.tmp-4242-7 removed on open", "retry of A7 re-executes fresh (no record): createdId box-0004, duplicated false, history (1, 0) in a fresh process", "final scene file equals envelope/valid/demo-0001-rev7 except the fresh record's history depths"] },
      { dir: "scenarios/07-crash-after-replace", name: "crash after atomic replacement", outcomes: [{ kind: "query", op: "queryProject", revision: 7, writePaused: false }, { kind: "success", revision: 7, duplicated: true }], finalRevision: 7, invariants: ["load reports revision 7 (the rename landed)", "retry of A7 replays the recorded result (duplicated true)", "no double-apply: 8 entities, project files identical to disk-before"] },
      { dir: "scenarios/08-external-modification", name: "unexpected external modification", outcomes: [{ kind: "error", code: "external_change_unresolved", cls: "unavailable" }, { kind: "query", op: "queryProject", revision: 7, writePaused: true }, { kind: "admin", op: "acceptExternalState", revision: 7 }, { kind: "success", revision: 8, duplicated: false }], finalRevision: 8, invariants: ["recovery snapshot disk-after/.thirdlight/recovery/scene-*.json is byte-identical to disk-external/scenes/scene-main.json", "accept rewrites every file with cleared records; content.json is stamped revision 7", "final scene file carries the accepted color #ff8800, box-0004 position [0,1,0], and exactly 1 retry record"] },
      { dir: "scenarios/09-second-backend-ownership", name: "second-backend ownership rejection", outcomes: [{ kind: "error", code: "project_unavailable", cls: "unavailable", reason: "ownership_conflict" }, { kind: "query", op: "queryProject", revision: 7, writePaused: false }], finalRevision: 7, invariants: ["outcome 1 reason ownership_conflict (live owner pid 5000)", "outcome 2: the owner is dead, so backend B reclaims automatically (lockEpoch 1) and serves the project", "project files unchanged throughout"] },
    ],
    examples: "examples/commands.json (one request/live-ack pair per mutation op plus a retry replay, drawn from the mainline and scenario 05; query examples on the T5 state)",
  };
  put("expected.json", canonJson(idx));
}

// ---------------------------------------------------------------------------
// self-verification (always run)
// ---------------------------------------------------------------------------

const problems = [];

// 1. digest verification against the known requests
{
  const reqById = new Map();
  for (const r of Object.values(mainlineRequests)) reqById.set(r.requestId, r);
  for (const m of s5) reqById.set(m.in.requestId, m.in);
  reqById.set(s3ReissueReq.requestId, s3ReissueReq);
  reqById.set(e8req.requestId, e8req);
  for (let i = 1; i <= 129; i++) reqById.set(F(i), retRequest(i));
  const checkRecords = (label, records) => {
    for (const rec of records) {
      const r = reqById.get(rec.requestId);
      if (!r) { problems.push(`${label}: request not found for record ${rec.requestId}`); continue; }
      if (digestOf(r) !== rec.digest) problems.push(`${label}: digest mismatch for ${rec.requestId}`);
    }
  };
  checkRecords("mainline-T5", recordsOf(snapT(5)));
  checkRecords("mainline-T7", recordsOf(T7));
  checkRecords("S5", S5P.records);
  checkRecords("S3", s3proj.records);
  checkRecords("S8", s8proj.records);
  checkRecords("RET", ret.records);
}

// 2. canonical serialization stability for every planned file
for (const [rel, bytes] of files) {
  if (rel.includes("/duplicate-key/")) continue; // deliberately not re-serializable
  try {
    if (canonJson(JSON.parse(bytes)) !== bytes) problems.push(`canonical stability: ${rel}`);
  } catch (e) {
    problems.push(`parse: ${rel}: ${e.message}`);
  }
}

// 3. scenario 05 history round-trip: replay forward+inverse independently
{
  let s = defaultScene();
  s = applyCreate(s, { kind: "box", name: "Ground" }).scene;
  s = applySetTransform(s, "box-0001", { position: [0, 0, -0.5] }).scene;
  s = applyCreate(s, { kind: "box", name: "Crate" }).scene;
  const del = applyDelete(s, "box-0002");
  s = del.scene;
  s = applyRestore(s, del.entries, del.restoredParentId).scene; // undo delete
  s = applyDelete(s, "box-0002").scene; // undo create
  s = { ...s, entities: [...s.entities, deepCopy(entityById(S5P.scene, "box-0002").entity)] }; // redo create
  s = applySetTransform(s, "box-0001", { position: [0, 0.25, -0.5] }).scene;
  s = applySetTransform(s, "box-0001", { position: [0, 0, -0.5] }).scene; // undo setTransform
  if (canonJson({ ...s, revision: 9 }) !== canonJson(S5P.scene)) problems.push("S5 independent round-trip mismatch");
}

// 3b. multi-entity subtree restore (contract §9.1): the index formula must
//     reconstruct the pre-deletion array exactly for subtrees with > 1 entity.
{
  const mk = (id, parentId) => (parentId === null ? { id } : { id, parentId });
  const pre = { entities: [mk("A", null), mk("B", null), mk("C", "B"), mk("D", null), mk("E", "D")] };
  const del = applyDelete(pre, "B");
  const got = applyRestore(del.scene, del.entries, del.restoredParentId).scene.entities.map((e) => e.id).join(",");
  if (got !== "A,B,C,D,E") problems.push(`multi-entity restore: expected A,B,C,D,E but got ${got}`);
}

// 4. the crash-window temp of scenario 06 is exactly the rev-7 scene file,
//    and the scene-08 snapshot is exactly the external writer's bytes
if (files.get(sc("06-crash-before-replace", "disk-before/scenes/.scene-main.json.tmp-4242-7")) !== t7Files[SCENE_REL]) problems.push("06 temp != rev-7 scene file");
if (acceptedFiles["content.json"] !== files.get(sc("08-external-modification", "disk-after/content.json"))) problems.push("08 content.json after accept drifted");

// ---------------------------------------------------------------------------
// write or check
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p).map((x) => path.posix.join(name, x)));
    else out.push(name);
  }
  return out;
}

const GENERATED_ROOTS = ["scenarios/", "envelope/", "examples/"];
const isGenerated = (rel) => GENERATED_ROOTS.some((r) => rel.startsWith(r)) || rel === "expected.json";

let written = 0, checked = 0;
if (CHECK) {
  for (const [rel, bytes] of files) {
    let disk;
    try {
      disk = readFileSync(path.join(FIX_ROOT, rel), "utf8");
    } catch {
      problems.push(`check: missing file ${rel}`);
      continue;
    }
    if (disk !== bytes) problems.push(`check: content mismatch ${rel}`);
    else checked++;
  }
  // stray files under the generated roots that the tool does not own
  for (const rel of walk(FIX_ROOT)) {
    if (isGenerated(rel) && !files.has(rel) && !rel.endsWith(".md")) problems.push(`check: untracked generated file ${rel}`);
  }
} else {
  for (const [rel, bytes] of files) {
    const p = path.join(FIX_ROOT, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, bytes);
    written++;
  }
  // remove previously generated files no longer in the plan (generated roots
  // only; never *.md docs, tools/, or anything outside the generated roots)
  let removed = 0;
  for (const rel of walk(FIX_ROOT)) {
    if (isGenerated(rel) && !files.has(rel) && !rel.endsWith(".md")) {
      rmSync(path.join(FIX_ROOT, rel));
      removed++;
    }
  }
  if (removed) console.log(`removed ${removed} stale generated file(s)`);
}

if (problems.length) {
  console.error("FIXTURE TOOL PROBLEMS:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(CHECK
  ? `check OK: ${checked} files byte-identical, digests + canonical stability verified`
  : `wrote ${written} fixture files (digests + canonical stability verified)`);
