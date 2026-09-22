#!/usr/bin/env node
// Thirdlight packet 02 — fixture construction tool for fixtures/commands/**
//
// Purpose:
//   Generate the packet 02 fixtures (envelope documents, crash/ownership/
//   external-change scenarios, command examples, and the expected.json
//   index) as byte-exact files with REAL SHA-256 digests, per:
//     docs/contracts/commands.md   (v0.1)
//     docs/contracts/workspace.md  (v0.1)
//     docs/contracts/project-model.md (v0.2)
//
// IMPORTANT:
//   This tool is FIXTURE TOOLING, not an implementation of the contracts.
//   It contains a minimal scene/history model used only to build consistent
//   fixture bytes. The packet 06/07 implementations must be written against
//   the contract documents; where this tool and the contracts ever disagree,
//   the contracts win and this tool (and its output) is a bug.
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

// File canonical form (workspace.md §4.4 / project-model §12.2): objects are
// pre-built in fixed key order; 2-space indent, LF, one trailing newline.
const canonJson = (obj) => JSON.stringify(obj, null, 2) + "\n";

// ---------------------------------------------------------------------------
// minimal scene model (fixture construction only)
// ---------------------------------------------------------------------------

const IDENT_ROT = [0, 0, 0, 1];
const camMain = () => ({
  id: "cam-main",
  name: "Main Camera",
  components: {
    transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    camera: { type: "perspective", fovY: 60, near: 0.1, far: 100 },
  },
});

function defaultScene(sceneId = "scene-main") {
  return { schemaVersion: 1, sceneId, revision: 0, entities: [camMain()] };
}

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
  const updated = {
    ...entity,
    components: { ...entity.components, transform: next },
  };
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
  return {
    scene: { ...scene, entities },
    deletedIds: entries.map((e) => e.entity.id),
    entries,
    restoredParentId,
  };
}

function applyRestore(scene, entries, restoredParentId) {
  const ordered = [...entries].sort((a, b) => a.index - b.index);
  const out = scene.entities.slice();
  ordered.forEach((en, k) => {
    const ent = JSON.parse(JSON.stringify(en.entity));
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
  if (scene.entities.length > 1024) throw new Error("entity limit");
}

const deepCopy = (v) => JSON.parse(JSON.stringify(v));
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

function changeCreate(id, entity) {
  return { type: "createEntity", id, entity };
}
function changeSetTransform(id, previous, next, changedFields) {
  return { type: "setTransform", id, previous, next, changedFields };
}
function changeDelete(rootId, deletedIds) {
  return { type: "deleteEntity", rootId, deletedIds };
}
function changeRestore(rootId, entities) {
  return { type: "restoreSubtree", rootId, entities };
}

function mutationSuccess({ op, projectId, requestId, revision, duplicated, createdId, change, appliedOf, originOfApplied, history }) {
  const o = { ok: true, op, projectId, requestId, revision, duplicated };
  if (createdId !== undefined) o.createdId = createdId;
  o.change = change;
  if (appliedOf !== undefined) o.appliedOf = appliedOf;
  if (originOfApplied !== undefined) o.originOfApplied = originOfApplied;
  o.history = { undoDepth: history.undoDepth, redoDepth: history.redoDepth };
  return o;
}

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

function revisionConflictError(expectedRevision, currentRevision) {
  return errObj(
    "revision_conflict", "conflict",
    { expectedRevision, currentRevision },
    "expected revision does not match the current project revision",
    HINT_STALE,
  );
}
function requestIdReusedError(currentRevision) {
  return errObj(
    "request_id_reused", "conflict",
    { currentRevision },
    "requestId was already used with different content",
    HINT_STALE,
  );
}

function envelopeObj({ projectId, scene, records }) {
  return {
    storageVersion: 1,
    type: "authoring-state",
    projectId,
    scene,
    retry: { retention: 128, records },
  };
}
const recordObj = (requestId, digest, appliedRevision, result) => ({
  requestId, digest, appliedRevision, result,
});

function manifestObj(id, name, createdAt) {
  return {
    schemaVersion: 1,
    engineVersion: "0.1.0",
    id,
    name,
    createdAt,
    scenes: [{ id: "scene-main", path: "scenes/main.json" }],
  };
}

function ownershipObj({ state, backendId, pid, openedAt, lockEpoch }) {
  return { storageVersion: 1, state, backendId, pid, openedAt, lockEpoch };
}

// Exclusive claim file (workspace.md §6.3, 2026-09-18 amended): the token an
// ACTIVE owner holds for the life of the session. Key order matches the
// canonical stamp bytes the workspace package writes (backendId, pid,
// openedAt).
function claimObj({ backendId, pid, openedAt }) {
  return { backendId, pid, openedAt };
}

function queryProjectResult({ projectId, manifest, scene, revision, history, workspace }) {
  return {
    ok: true,
    projectId,
    revision,
    manifest,
    // C35-5 / CC-48-3 (promoted at Gate L): the scene summary reports the
    // SCENE document's schemaVersion (never the manifest's).
    scene: { sceneId: scene.sceneId, schemaVersion: scene.schemaVersion, entityCount: scene.entities.length, cameraId: cameraIdOf(scene) },
    history,
    workspace,
  };
}

function queryEntityResult({ projectId, revision, scene, entityId, includeSubtree }) {
  const { entity } = entityById(scene, entityId);
  const subtreeIds = closureIds(scene, entityId);
  const o = {
    ok: true,
    projectId,
    revision,
    entity,
    parentChain: parentChain(scene, entityId),
    childIds: childrenOf(scene, entityId),
  };
  if (includeSubtree) {
    o.subtree = { count: subtreeIds.length, entities: scene.entities.filter((e) => subtreeIds.includes(e.id)) };
  }
  return o;
}

function queryEntitiesResult({ projectId, revision, scene, limit, offset }) {
  return {
    ok: true,
    projectId,
    revision,
    total: scene.entities.length,
    offset,
    limit,
    entities: scene.entities.slice(offset, offset + limit),
  };
}

// ---------------------------------------------------------------------------
// fixture project (minimal history/dedup model, commands.md §6/§7/§9)
// ---------------------------------------------------------------------------

class FixtureProject {
  constructor(projectId, manifest, scene, records = []) {
    this.projectId = projectId;
    this.manifest = manifest;
    this.scene = scene;
    this.revision = scene.revision;
    this.records = records; // [{requestId, digest, appliedRevision, result}]
    this.history = [];
    this.cursor = 0;
    this.snapshots = new Map(); // tag -> {scene, revision, records, result}
  }

  snapshot(tag) {
    this.snapshots.set(tag, {
      scene: deepCopy(this.scene),
      revision: this.revision,
      records: deepCopy(this.records),
    });
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
      const scene = { ...this.scene, entities: [...this.scene.entities, deepCopy(ch.entity)] };
      return { scene, change: ch };
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

  mutation(request, { op, undo, redo, historyEntry }) {
    const digest = digestOf(request);
    const history = this.depths();

    if (undo) {
      if (this.cursor === 0) throw new Error("fixture-tool: undo on empty stack");
      const entry = this.history[this.cursor - 1];
      const r = this.inverse(entry);
      this.revision += 1;
      this.scene = { ...r.scene, revision: this.revision };
      this.cursor -= 1;
      validateSceneLight(this.scene);
      const result = mutationSuccess({
        op: "undo", projectId: this.projectId, requestId: request.requestId,
        revision: this.revision, duplicated: false, change: r.change,
        appliedOf: entry.requestId, originOfApplied: entry.origin,
        history: this.depths(),
      });
      this.pushRecord(request.requestId, digest, result);
      return result;
    }

    if (redo) {
      if (this.cursor === this.history.length) throw new Error("fixture-tool: redo on empty tail");
      const entry = this.history[this.cursor];
      const r = this.forward(entry);
      this.revision += 1;
      this.scene = { ...r.scene, revision: this.revision };
      this.cursor += 1;
      validateSceneLight(this.scene);
      const result = mutationSuccess({
        op: "redo", projectId: this.projectId, requestId: request.requestId,
        revision: this.revision, duplicated: false, change: r.change,
        appliedOf: entry.requestId, originOfApplied: entry.origin,
        history: this.depths(),
      });
      this.pushRecord(request.requestId, digest, result);
      return result;
    }

    // forward mutation
    const r = this.apply(op, historyEntry.args);
    validateSceneLight(r.scene);

    let change;
    let createdId;
    if (op === "createEntity") {
      change = changeCreate(r.id, r.entity);
      createdId = r.id;
    } else if (op === "setTransform") {
      change = changeSetTransform(historyEntry.args.entityId, r.previous, r.next, r.changedFields);
    } else if (op === "deleteEntity") {
      change = changeDelete(historyEntry.args.entityId, r.deletedIds);
    }

    this.revision += 1;
    this.scene = { ...r.scene, revision: this.revision };
    this.history = this.history.slice(0, this.cursor);
    this.history.push({
      seq: this.history.length + 1,
      requestId: request.requestId,
      op,
      origin: request.origin ?? null,
      appliedRevision: this.revision,
      change: deepCopy(change),
      inverse:
        op === "createEntity"
          ? { kind: "delete", rootId: r.id }
          : op === "setTransform"
            ? { kind: "setTransform", id: historyEntry.args.entityId, restore: deepCopy(r.previous) }
            : { kind: "restoreSubtree", rootId: historyEntry.args.entityId, entries: deepCopy(r.entries), restoredParentId: r.restoredParentId, rootId: r.rootId ?? historyEntry.args.entityId },
    });
    this.cursor += 1;

    const result = mutationSuccess({
      op, projectId: this.projectId, requestId: request.requestId,
      revision: this.revision, duplicated: false, createdId, change,
      history: this.depths(),
    });
    this.pushRecord(request.requestId, digest, result);
    return result;
  }

  pushRecord(requestId, digest, result) {
    this.records.push(recordObj(requestId, digest, this.revision, result));
    if (this.records.length > 128) this.records.shift();
  }
}

// ---------------------------------------------------------------------------
// the mainline timeline (demo-0001)
// ---------------------------------------------------------------------------

const P = "demo-0001";
const MAIN = manifestObj(P, "Demo Project", "2026-09-16T23:40:00Z");
const mainline = new FixtureProject(P, MAIN, defaultScene());

const A = (i) => `req-1${String(i).padStart(31, "0")}`; // req-1...01 .. req-1...07 (32 hex)

// A1 create box-0001
mainline.mutation(
  req("createEntity", P, 0, A(1), browserOrigin, { kind: "box" }),
  { op: "createEntity", historyEntry: { args: { kind: "box" } } },
);
mainline.snapshot("T1");
// A2 create box-0002
mainline.mutation(
  req("createEntity", P, 1, A(2), browserOrigin, { kind: "box" }),
  { op: "createEntity", historyEntry: { args: { kind: "box" } } },
);
mainline.snapshot("T2");
// A3 setTransform box-0001 position
mainline.mutation(
  req("setTransform", P, 2, A(3), mcpOrigin, { entityId: "box-0001", transform: { position: [1.5, 0.25, 0] } }),
  { op: "setTransform", historyEntry: { args: { entityId: "box-0001", transform: { position: [1.5, 0.25, 0] } } } },
);
mainline.snapshot("T3");
// A4 create group-0001
mainline.mutation(
  req("createEntity", P, 3, A(4), browserOrigin, { kind: "group", name: "Walls" }),
  { op: "createEntity", historyEntry: { args: { kind: "group", name: "Walls" } } },
);
mainline.snapshot("T4");
// A5 setTransform box-0002 rotation (the lost-ack command in scenario 01)
mainline.mutation(
  req("setTransform", P, 4, A(5), mcpOrigin, { entityId: "box-0002", transform: { rotation: [0.7071067811865476, 0, 0, 0.7071067811865476] } }),
  { op: "setTransform", historyEntry: { args: { entityId: "box-0002", transform: { rotation: [0.7071067811865476, 0, 0, 0.7071067811865476] } } } },
);
mainline.snapshot("T5");
// A6 create box-0003
mainline.mutation(
  req("createEntity", P, 5, A(6), browserOrigin, { kind: "box" }),
  { op: "createEntity", historyEntry: { args: { kind: "box" } } },
);
mainline.snapshot("T6");
// A7 create box-0004 (the crash-window command in scenarios 06/07)
mainline.mutation(
  req("createEntity", P, 6, A(7), mcpOrigin, { kind: "box" }),
  { op: "createEntity", historyEntry: { args: { kind: "box" } } },
);
mainline.snapshot("T7");

// sanity: A7 must be box-0004
if (mainline.scene.entities[5].id !== "box-0004") throw new Error("fixture-tool: A7 != box-0004");

const mainlineRequests = {
  A1: req("createEntity", P, 0, A(1), browserOrigin, { kind: "box" }),
  A2: req("createEntity", P, 1, A(2), browserOrigin, { kind: "box" }),
  A3: req("setTransform", P, 2, A(3), mcpOrigin, { entityId: "box-0001", transform: { position: [1.5, 0.25, 0] } }),
  A4: req("createEntity", P, 3, A(4), browserOrigin, { kind: "group", name: "Walls" }),
  A5: req("setTransform", P, 4, A(5), mcpOrigin, { entityId: "box-0002", transform: { rotation: [0.7071067811865476, 0, 0, 0.7071067811865476] } }),
  A6: req("createEntity", P, 5, A(6), browserOrigin, { kind: "box" }),
  A7: req("createEntity", P, 6, A(7), mcpOrigin, { kind: "box" }),
};
// snapshots carry {scene, revision, records}; per-command recorded results are
// looked up by requestId within the snapshot's records
const recordResult = (snapTag, requestId) => {
  const rec = mainline.snapshots.get(snapTag).records.find((r) => r.requestId === requestId);
  if (!rec) throw new Error(`fixture-tool: no record for ${requestId}`);
  return rec.result;
};

// ---------------------------------------------------------------------------
// scenario 05 timeline (undo/redo, mixed origins) — demo-0001 from revision 0
// ---------------------------------------------------------------------------

const S5P = new FixtureProject(P, MAIN, defaultScene());
const B = (i) => `req-2${String(i).padStart(31, "0")}`;

const s5 = [];
function s5m(tag, request, mutate) {
  const result = S5P.mutation(request, mutate);
  s5.push({ in: request, out: result });
  S5P.snapshot(tag);
  return result;
}
s5m("S1", req("createEntity", P, 0, B(1), browserOrigin, { kind: "box", name: "Ground" }),
  { op: "createEntity", historyEntry: { args: { kind: "box", name: "Ground" } } });
s5m("S2", req("setTransform", P, 1, B(2), mcpOrigin, { entityId: "box-0001", transform: { position: [0, 0, -0.5] } }),
  { op: "setTransform", historyEntry: { args: { entityId: "box-0001", transform: { position: [0, 0, -0.5] } } } });
s5m("S3", req("createEntity", P, 2, B(3), browserOrigin, { kind: "box", name: "Crate" }),
  { op: "createEntity", historyEntry: { args: { kind: "box", name: "Crate" } } });
s5m("S4", req("deleteEntity", P, 3, B(4), mcpOrigin, { entityId: "box-0002" }),
  { op: "deleteEntity", historyEntry: { args: { entityId: "box-0002" } } });
s5m("S5", req("undo", P, 4, B(5), browserOrigin, {}), { undo: true });
s5m("S6", req("undo", P, 5, B(6), browserOrigin, {}), { undo: true });
s5m("S7", req("redo", P, 6, B(7), mcpOrigin, {}), { redo: true });
s5m("S8", req("setTransform", P, 7, B(8), mcpOrigin, { entityId: "box-0001", transform: { position: [0, 0.25, -0.5] } }),
  { op: "setTransform", historyEntry: { args: { entityId: "box-0001", transform: { position: [0, 0.25, -0.5] } } } });
s5m("S9", req("undo", P, 8, B(9), browserOrigin, {}), { undo: true });

(function verifyS5() {
  if (S5P.scene.entities.map((e) => e.id).join(",") !== "cam-main,box-0001,box-0002") {
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

const s5Requests = s5.map((m) => m.in);
const s5Results = s5.map((m) => m.out);

// ---------------------------------------------------------------------------
// scenario 03 (stale revision + recovery re-issue) — branches from T5
// ---------------------------------------------------------------------------

const C = (i) => `req-3${String(i).padStart(31, "0")}`;
const s3proj = new FixtureProject(P, MAIN, deepCopy(mainline.snapshots.get("T5").scene), deepCopy(mainline.snapshots.get("T5").records));
const s3ReissueReq = req("setTransform", P, 5, C(2), browserOrigin, { entityId: "box-0001", transform: { position: [0.75, 0, 0] } });
const s3Result = s3proj.mutation(s3ReissueReq, { op: "setTransform", historyEntry: { args: { entityId: "box-0001", transform: { position: [0.75, 0, 0] } } } });
s3proj.snapshot("S3AFTER");

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
// sanity: no_change request must equal current state
if (!noChange(
  { ...mainline.snapshots.get("T5").scene, revision: 0 },
  applySetTransform(mainline.snapshots.get("T5").scene, "box-0001", { position: [1.5, 0.25, 0] }).scene,
)) throw new Error("fixture-tool: S4 no_change case is not actually a no-op");

const zeroQuatModelError = {
  code: "quaternion_invalid",
  path: "/entities/1/components/transform/rotation",
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
  noChange: errObj("no_change", "validation", {},
    "request would not change the scene",
    "the scene already matches the requested values; nothing was recorded"),
};

// ---------------------------------------------------------------------------
// scenario 08 (external modification) — continues the mainline at T7
// ---------------------------------------------------------------------------

const E = (i) => `req-6${String(i).padStart(31, "0")}`;
const T7 = mainline.snapshots.get("T7");
const t7Envelope = envelopeObj({ projectId: P, scene: T7.scene, records: T7.records });
const t7EnvelopeBytes = canonJson(t7Envelope);
const t7Hash = sha256(t7EnvelopeBytes);

// external edit: box-0001 color -> #ff8800, everything else identical
const extScene = deepCopy(T7.scene);
const extBox1 = entityById(extScene, "box-0001").entity;
extBox1.components.box.material.color = "#ff8800";
const extEnvelope = envelopeObj({ projectId: P, scene: extScene, records: deepCopy(T7.records) });
const extEnvelopeBytes = canonJson(extEnvelope);
const extHash = sha256(extEnvelopeBytes);
const extHash8 = extHash.slice(0, 8);

// accepted+continued envelope: external scene, retry cleared, then A8' at rev 8
const s8proj = new FixtureProject(P, MAIN, deepCopy(extScene), []);
const e8req = req("setTransform", P, 7, E(2), mcpOrigin, { entityId: "box-0004", transform: { position: [0, 1, 0] } });
const e8result = s8proj.mutation(e8req, { op: "setTransform", historyEntry: { args: { entityId: "box-0004", transform: { position: [0, 1, 0] } } } });
s8proj.snapshot("S8AFTER");
const s8FinalEnvelope = envelopeObj({ projectId: P, scene: s8proj.scene, records: s8proj.records });

// The error payload's pendingChange carries the §7.2 step-2 snapshot
// state (snapshotState: "ok" — the scenario-08 snapshot is durable),
// matching the service's emitted key order (workspace.md §7.2/§11).
const pendingChange = { snapshotState: "ok", externalHash: extHash, externalValid: true, externalErrorCount: 0 };
const e8pauseReq = req("setTransform", P, 7, E(1), mcpOrigin, { entityId: "box-0004", transform: { position: [0, 1, 0] } });

const ownerA = { backendId: "tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", pid: 5000, openedAt: "2026-09-17T09:00:00Z", lockEpoch: 0 };
const ownerB = { backendId: "tb-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", pid: 5150, openedAt: "2026-09-17T10:30:00Z", lockEpoch: 1 };
const ownerCrash = { backendId: "tb-42424242424242424242424242424242", pid: 4242, openedAt: "2026-09-17T08:30:00Z", lockEpoch: 0 };
const ownerC = { backendId: "tb-cccccccccccccccccccccccccccccccc", pid: 4300, openedAt: "2026-09-17T09:45:00Z", lockEpoch: 1 };

// ---------------------------------------------------------------------------
// retention boundary fixture (demo-0002): 129 commands, 128 records retained
// ---------------------------------------------------------------------------

const RET = "demo-0002";
const RETMAN = manifestObj(RET, "Retention Fixture", "2026-09-17T08:00:00Z");
const ret = new FixtureProject(RET, RETMAN, defaultScene());
const F = (i) => `req-4${String(i).padStart(31, "0")}`;
ret.mutation(req("createEntity", RET, 0, F(1), browserOrigin, { kind: "box" }),
  { op: "createEntity", historyEntry: { args: { kind: "box" } } });
for (let i = 2; i <= 129; i++) {
  const x = i - 1; // 1..128
  ret.mutation(
    req("setTransform", RET, i - 1, F(i), mcpOrigin, { entityId: "box-0001", transform: { position: [x / 100, 0, 0] } }),
    { op: "setTransform", historyEntry: { args: { entityId: "box-0001", transform: { position: [x / 100, 0, 0] } } } },
  );
}
if (ret.revision !== 129) throw new Error("fixture-tool: retention revision wrong");
if (ret.records.length !== 128) throw new Error("fixture-tool: retention record count wrong");
if (ret.records[0].requestId !== F(2)) throw new Error("fixture-tool: eviction dropped the wrong record");
const retBox = entityById(ret.scene, "box-0001").entity;
if (JSON.stringify(retBox.components.transform.position) !== JSON.stringify([1.28, 0, 0])) {
  throw new Error("fixture-tool: retention final position wrong");
}
const retEnvelope = envelopeObj({ projectId: RET, scene: ret.scene, records: ret.records });

// ---------------------------------------------------------------------------
// invalid envelope fixtures
// ---------------------------------------------------------------------------

const rev0Scene = defaultScene();
const rev0Envelope = envelopeObj({ projectId: P, scene: rev0Scene, records: [] });
const rev0Bytes = canonJson(rev0Envelope);

const invStorageVersion = (() => {
  const o = JSON.parse(rev0Bytes);
  o.storageVersion = 2;
  // rebuild in canonical order with storageVersion first
  return canonJson({ storageVersion: 2, type: "authoring-state", projectId: o.projectId, scene: o.scene, retry: o.retry });
})();
const invTypeMissing = (() => {
  const lines = rev0Bytes.trimEnd().split("\n").filter((l) => !l.trim().startsWith('"type"'));
  return lines.join("\n") + "\n";
})();
const invProjectMismatch = canonJson({
  storageVersion: 1, type: "authoring-state", projectId: "demo-0002",
  scene: rev0Scene, retry: { retention: 128, records: [] },
});
const invSceneInvalid = (() => {
  const scene = deepCopy(rev0Scene);
  scene.entities[0].components.transform.rotation = [0, 0, 0, 0];
  return canonJson({ storageVersion: 1, type: "authoring-state", projectId: P, scene, retry: { retention: 128, records: [] } });
})();
const invRetryNonAscending = (() => {
  const env = deepCopy(envelopeObj({ projectId: P, scene: mainline.snapshots.get("T5").scene, records: mainline.snapshots.get("T5").records }));
  env.retry.records[0].appliedRevision = 99; // breaks strict ascending order
  return canonJson(env);
})();
const invDuplicateKey = (() => {
  const idx = rev0Bytes.indexOf('"projectId"');
  if (idx < 0) throw new Error("fixture-tool: projectId line not found");
  const lineEnd = rev0Bytes.indexOf("\n", idx);
  return rev0Bytes.slice(0, lineEnd + 1) + rev0Bytes.slice(idx, lineEnd + 1) + rev0Bytes.slice(lineEnd + 1);
})();

// ---------------------------------------------------------------------------
// file plan: relpath -> bytes (string)
// ---------------------------------------------------------------------------

const files = new Map();
const put = (rel, bytes) => {
  if (files.has(rel)) throw new Error(`fixture-tool: duplicate file ${rel}`);
  files.set(rel, bytes);
};

// --- envelope fixtures
put("envelope/valid/demo-0001-manifest.json", canonJson(MAIN));
put("envelope/valid/demo-0001-rev0.json", rev0Bytes);
put("envelope/valid/demo-0001-rev5.json", canonJson(envelopeObj({ projectId: P, scene: mainline.snapshots.get("T5").scene, records: mainline.snapshots.get("T5").records })));
put("envelope/valid/demo-0001-rev6.json", canonJson(envelopeObj({ projectId: P, scene: mainline.snapshots.get("T6").scene, records: mainline.snapshots.get("T6").records })));
put("envelope/valid/demo-0001-rev7.json", t7EnvelopeBytes);
put("envelope/valid/demo-0002-manifest.json", canonJson(RETMAN));
put("envelope/valid/demo-0002-revision-129.json", canonJson(retEnvelope));
put("envelope/invalid/storage-version-unsupported.json", invStorageVersion);
put("envelope/invalid/type-missing.json", invTypeMissing);
put("envelope/invalid/project-mismatch.json", invProjectMismatch);
put("envelope/invalid/embedded-scene-invalid.json", invSceneInvalid);
put("envelope/invalid/retry-records-non-ascending.json", invRetryNonAscending);
put("envelope/invalid/duplicate-key.json", invDuplicateKey);

// --- scenarios
const sc = (dir, ...parts) => path.posix.join("scenarios", dir, ...parts);

// 01 — retry after lost acknowledgement (replay of A5 at T5)
put(sc("01-retry-lost-ack", "disk-before/project.json"), canonJson(MAIN));
put(sc("01-retry-lost-ack", "disk-before/scenes/main.json"), files.get("envelope/valid/demo-0001-rev5.json"));
{
  const replay = deepCopy(recordResult("T5", A(5)));
  replay.duplicated = true;
  const messages = [{ in: deepCopy(mainlineRequests.A5), out: replay }];
  put(sc("01-retry-lost-ack", "messages.json"), canonJson(messages));
}

// 02 — requestId reuse with different content
put(sc("02-request-id-reused", "disk-before/project.json"), canonJson(MAIN));
put(sc("02-request-id-reused", "disk-before/scenes/main.json"), files.get("envelope/valid/demo-0001-rev5.json"));
{
  const messages = [
    {
      in: req("deleteEntity", P, 5, A(5), mcpOrigin, { entityId: "box-0002" }),
      out: mutationError({ op: "deleteEntity", projectId: P, requestId: A(5), error: requestIdReusedError(5) }),
    },
  ];
  put(sc("02-request-id-reused", "messages.json"), canonJson(messages));
}

// 03 — stale revision + recovery re-issue
put(sc("03-stale-revision", "disk-before/project.json"), canonJson(MAIN));
put(sc("03-stale-revision", "disk-before/scenes/main.json"), files.get("envelope/valid/demo-0001-rev5.json"));
{
  const messages = [
    {
      in: req("setTransform", P, 4, C(1), browserOrigin, { entityId: "box-0001", transform: { position: [0.75, 0, 0] } }),
      out: mutationError({ op: "setTransform", projectId: P, requestId: C(1), error: revisionConflictError(4, 5) }),
    },
    { in: s3ReissueReq, out: s3Result },
  ];
  put(sc("03-stale-revision", "messages.json"), canonJson(messages));
  put(sc("03-stale-revision", "disk-after/project.json"), canonJson(MAIN));
  put(sc("03-stale-revision", "disk-after/scenes/main.json"),
    canonJson(envelopeObj({ projectId: P, scene: s3proj.snapshots.get("S3AFTER").scene, records: s3proj.snapshots.get("S3AFTER").records })));
}

// 04 — invalid transactions, no partial changes
put(sc("04-invalid-no-partial", "disk-before/project.json"), canonJson(MAIN));
put(sc("04-invalid-no-partial", "disk-before/scenes/main.json"), files.get("envelope/valid/demo-0001-rev5.json"));
{
  const messages = [
    { in: d4reqs.zeroQuat, out: mutationError({ op: "setTransform", projectId: P, requestId: D(1), error: d4errs.zeroQuat }) },
    { in: d4reqs.ghostDelete, out: mutationError({ op: "deleteEntity", projectId: P, requestId: D(2), error: d4errs.ghostDelete }) },
    { in: d4reqs.ghostParent, out: mutationError({ op: "createEntity", projectId: P, requestId: D(3), error: d4errs.ghostParent }) },
    { in: d4reqs.noChange, out: mutationError({ op: "setTransform", projectId: P, requestId: D(4), error: d4errs.noChange }) },
  ];
  put(sc("04-invalid-no-partial", "messages.json"), canonJson(messages));
}

// 05 — undo/redo with mixed human/agent edits
put(sc("05-undo-redo-mixed", "disk-before/project.json"), canonJson(MAIN));
put(sc("05-undo-redo-mixed", "disk-before/scenes/main.json"), rev0Bytes);
put(sc("05-undo-redo-mixed", "messages.json"), canonJson(s5));
put(sc("05-undo-redo-mixed", "disk-after/project.json"), canonJson(MAIN));
put(sc("05-undo-redo-mixed", "disk-after/scenes/main.json"),
  canonJson(envelopeObj({ projectId: P, scene: S5P.scene, records: S5P.records })));

// 06 — crash before atomic replacement
put(sc("06-crash-before-replace", "disk-before/project.json"), canonJson(MAIN));
put(sc("06-crash-before-replace", "disk-before/scenes/main.json"), files.get("envelope/valid/demo-0001-rev6.json"));
put(sc("06-crash-before-replace", "disk-before/scenes/.main.json.tmp-4242-7"), t7EnvelopeBytes);
put(sc("06-crash-before-replace", "disk-before/.thirdlight/ownership.json"),
  canonJson(ownershipObj({ state: "owned", ...ownerCrash })));
{
  const messages = [
    {
      in: { op: "queryProject", projectId: P },
      out: queryProjectResult({
        projectId: P, manifest: MAIN, scene: mainline.snapshots.get("T6").scene,
        revision: 6, history: { undoDepth: 0, redoDepth: 0 }, workspace: { writePaused: false },
      }),
    },
    { in: deepCopy(mainlineRequests.A7), out: recordResult("T7", A(7)) },
  ];
  put(sc("06-crash-before-replace", "messages.json"), canonJson(messages));
  put(sc("06-crash-before-replace", "disk-after/project.json"), canonJson(MAIN));
  put(sc("06-crash-before-replace", "disk-after/scenes/main.json"), t7EnvelopeBytes);
  put(sc("06-crash-before-replace", "disk-after/.thirdlight/ownership.json"),
    canonJson(ownershipObj({ state: "owned", ...ownerC })));
}

// 07 — crash after atomic replacement
put(sc("07-crash-after-replace", "disk-before/project.json"), canonJson(MAIN));
put(sc("07-crash-after-replace", "disk-before/scenes/main.json"), t7EnvelopeBytes);
put(sc("07-crash-after-replace", "disk-before/.thirdlight/ownership.json"),
  canonJson(ownershipObj({ state: "owned", ...ownerCrash })));
{
  const replay = deepCopy(recordResult("T7", A(7)));
  replay.duplicated = true;
  const messages = [
    {
      in: { op: "queryProject", projectId: P },
      out: queryProjectResult({
        projectId: P, manifest: MAIN, scene: T7.scene,
        revision: 7, history: { undoDepth: 0, redoDepth: 0 }, workspace: { writePaused: false },
      }),
    },
    { in: deepCopy(mainlineRequests.A7), out: replay },
  ];
  put(sc("07-crash-after-replace", "messages.json"), canonJson(messages));
  put(sc("07-crash-after-replace", "disk-after/project.json"), canonJson(MAIN));
  put(sc("07-crash-after-replace", "disk-after/scenes/main.json"), t7EnvelopeBytes);
  put(sc("07-crash-after-replace", "disk-after/.thirdlight/ownership.json"),
    canonJson(ownershipObj({ state: "owned", ...ownerCrash })));
}

// 08 — unexpected external modification
put(sc("08-external-modification", "disk-before/project.json"), canonJson(MAIN));
put(sc("08-external-modification", "disk-before/scenes/main.json"), t7EnvelopeBytes);
put(sc("08-external-modification", "disk-before/.thirdlight/ownership.json"),
  canonJson(ownershipObj({ state: "owned", ...ownerA })));
// Owner A's active session holds its exclusive claim file (the 2026-09-18
// amended §6.2 self-reclaim row re-verifies it before serving).
put(sc("08-external-modification", "disk-before/.thirdlight/claim-0"),
  canonJson(claimObj(ownerA)));
put(sc("08-external-modification", "disk-external/scenes/main.json"), extEnvelopeBytes);
{
  const messages = [
    {
      in: e8pauseReq,
      out: mutationError({
        op: "setTransform", projectId: P, requestId: E(1),
        error: errObj("external_change_unresolved", "unavailable", { pendingChange },
          "an unexpected external modification is pending resolution; writes are paused",
          HINT_PAUSED),
      }),
    },
    {
      in: { op: "queryProject", projectId: P },
      out: queryProjectResult({
        projectId: P, manifest: MAIN, scene: T7.scene, revision: 7,
        history: { undoDepth: 0, redoDepth: 0 },
        workspace: {
          writePaused: true, pauseReason: "external_change",
          pendingChange: { snapshotState: "ok", externalHash: extHash, externalValid: true, externalErrorCount: 0, externalErrors: [] },
        },
      }),
    },
    {
      in: { op: "acceptExternalState", projectId: P },
      out: { ok: true, revision: 7, historyReset: true, retryCleared: true },
    },
    { in: e8req, out: e8result },
  ];
  put(sc("08-external-modification", "messages.json"), canonJson(messages));
  const after = {
    "disk-after/project.json": canonJson(MAIN),
    "disk-after/scenes/main.json": canonJson(s8FinalEnvelope),
    "disk-after/.thirdlight/ownership.json": canonJson(ownershipObj({ state: "owned", ...ownerA })),
    ["disk-after/.thirdlight/recovery/scene-20260917T101500Z-" + extHash8 + ".json"]: extEnvelopeBytes,
  };
  for (const [rel, bytes] of Object.entries(after)) put(path.posix.join(sc("08-external-modification"), rel), bytes);
}

// 09 — second-backend ownership rejection
put(sc("09-second-backend-ownership", "disk-before/project.json"), canonJson(MAIN));
put(sc("09-second-backend-ownership", "disk-before/scenes/main.json"), t7EnvelopeBytes);
put(sc("09-second-backend-ownership", "disk-before/.thirdlight/ownership.json"),
  canonJson(ownershipObj({ state: "owned", ...ownerA })));
// Owner A's active session holds its exclusive claim file (see 08).
put(sc("09-second-backend-ownership", "disk-before/.thirdlight/claim-0"),
  canonJson(claimObj(ownerA)));
{
  const holderA = { backendId: ownerA.backendId, pid: ownerA.pid, openedAt: ownerA.openedAt, lockEpoch: ownerA.lockEpoch, state: "owned" };
  const messages = [
    {
      in: { op: "queryProject", projectId: P },
      out: mutationError({
        op: "queryProject", projectId: P,
        error: errObj("project_unavailable", "unavailable",
          { reason: "ownership_conflict", holder: holderA },
          "project cannot be used right now: ownership_conflict",
          "another live backend owns this project; stop it or wait for an operator takeover"),
      }),
    },
    {
      in: { op: "queryProject", projectId: P },
      out: queryProjectResult({
        projectId: P, manifest: MAIN, scene: T7.scene, revision: 7,
        history: { undoDepth: 0, redoDepth: 0 }, workspace: { writePaused: false },
      }),
    },
  ];
  put(sc("09-second-backend-ownership", "messages.json"), canonJson(messages));
  put(sc("09-second-backend-ownership", "disk-after/project.json"), canonJson(MAIN));
  put(sc("09-second-backend-ownership", "disk-after/scenes/main.json"), t7EnvelopeBytes);
  put(sc("09-second-backend-ownership", "disk-after/.thirdlight/ownership.json"),
    canonJson(ownershipObj({ state: "owned", ...ownerB })));
}

// disk-after for 01 and 02: byte-identical copies of disk-before (replay/no-op)
for (const dir of ["01-retry-lost-ack", "02-request-id-reused", "04-invalid-no-partial"]) {
  put(path.posix.join(sc(dir), "disk-after/project.json"), files.get(path.posix.join(sc(dir), "disk-before/project.json")));
  put(path.posix.join(sc(dir), "disk-after/scenes/main.json"), files.get(path.posix.join(sc(dir), "disk-before/scenes/main.json")));
}

// --- examples/commands.json
{
  const t5 = mainline.snapshots.get("T5");
  const examples = {
    createEntity: { request: mainlineRequests.A1, result: recordResult("T1", A(1)) },
    setTransform: { request: mainlineRequests.A3, result: recordResult("T3", A(3)) },
    deleteEntity: { request: s5Requests[3], result: s5Results[3] },
    undo: { request: s5Requests[4], result: s5Results[4] },
    redo: { request: s5Requests[6], result: s5Results[6] },
    queries: {
      queryProject: {
        request: { op: "queryProject", projectId: P },
        result: queryProjectResult({
          projectId: P, manifest: MAIN, scene: t5.scene, revision: 5,
          history: { undoDepth: 0, redoDepth: 0 }, workspace: { writePaused: false },
        }),
      },
      queryEntity: {
        request: { op: "queryEntity", projectId: P, args: { entityId: "box-0002", includeSubtree: true } },
        result: queryEntityResult({ projectId: P, revision: 5, scene: t5.scene, entityId: "box-0002", includeSubtree: true }),
      },
      queryEntities: {
        request: { op: "queryEntities", projectId: P, args: { limit: 2, offset: 0 } },
        result: queryEntitiesResult({ projectId: P, revision: 5, scene: t5.scene, limit: 2, offset: 0 }),
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
  const idx = {
    indexVersion: 1,
    contracts: {
      commands: "docs/contracts/commands.md v0.1 (packet 02, 2026-09-17)",
      workspace: "docs/contracts/workspace.md v0.1 (packet 02, 2026-09-17)",
      projectModel: "docs/contracts/project-model.md v0.2 (packet 01, 2026-09-17)",
    },
    notes: [
      "Each scenario is self-contained: disk-before pins the exact on-disk state, messages.json the ordered request/result pairs, disk-after the exact resulting state. Scenarios 01-04/06-09 share the demo-0001 mainline timeline (T0..T7, commands A1..A7, requestId prefix req-1...); scenario 05 is a separate demo-0001 timeline from revision 0 (prefix req-2...); the retention fixture uses demo-0002 (prefix req-4...).",
      "Envelope bytes are canonical (workspace.md §4.4). Record digests are real SHA-256 over the digest-canonical request bytes (commands.md §6.6) — recompute with tools/generate-fixtures.mjs --check.",
    ],
    envelopeFixtures: [
      { file: "envelope/valid/demo-0001-rev0.json", project: "demo-0001", revision: 0, records: 0, note: "initial envelope after project creation; empty retry block" },
      { file: "envelope/valid/demo-0001-rev5.json", project: "demo-0001", revision: 5, records: 5, note: "mainline T5; used by scenarios 01-04" },
      { file: "envelope/valid/demo-0001-rev6.json", project: "demo-0001", revision: 6, records: 6, note: "mainline T6; used by scenario 06" },
      { file: "envelope/valid/demo-0001-rev7.json", project: "demo-0001", revision: 7, records: 7, note: "mainline T7; used by scenarios 07-09; also the crash-window temp content in 06" },
      { file: "envelope/valid/demo-0002-revision-129.json", project: "demo-0002", revision: 129, records: 128, note: "retention boundary: 129 commands applied, oldest record evicted (first retained record is req-40000000000000000000000000000002)" },
      { file: "envelope/invalid/storage-version-unsupported.json", code: "storage_version_unsupported" },
      { file: "envelope/invalid/type-missing.json", code: "envelope_invalid" },
      { file: "envelope/invalid/project-mismatch.json", code: "envelope_project_mismatch" },
      { file: "envelope/invalid/embedded-scene-invalid.json", code: "scene_invalid", detail: "quaternion_invalid on cam-main rotation" },
      { file: "envelope/invalid/retry-records-non-ascending.json", code: "retry_records_invalid" },
      { file: "envelope/invalid/duplicate-key.json", code: "duplicate_key" },
    ],
    scenarios: [
      { dir: "scenarios/01-retry-lost-ack", name: "retry after lost acknowledgement", outcomes: [outcome({ out: { ok: true, revision: 5, duplicated: true } })], finalRevision: 5, invariants: ["disk-after bytes identical to disk-before (replay changes nothing)", "record R5 present with appliedRevision 5"] },
      { dir: "scenarios/02-request-id-reused", name: "requestId reuse with different content", outcomes: [{ kind: "error", code: "request_id_reused", cls: "conflict" }], finalRevision: 5, invariants: ["disk-after bytes identical to disk-before"] },
      { dir: "scenarios/03-stale-revision", name: "stale revision + recovery re-issue", outcomes: [{ kind: "error", code: "revision_conflict", cls: "conflict" }, { kind: "success", revision: 6, duplicated: false }], finalRevision: 6, invariants: ["recovery re-issue uses a fresh requestId (req-3...02) and the current revision"] },
      { dir: "scenarios/04-invalid-no-partial", name: "invalid transactions leave no partial changes", outcomes: [{ kind: "error", code: "quaternion_invalid", cls: "validation" }, { kind: "error", code: "entity_not_found", cls: "validation" }, { kind: "error", code: "reference_missing", cls: "validation" }, { kind: "error", code: "no_change", cls: "validation" }], finalRevision: 5, invariants: ["disk-after bytes identical to disk-before (four rejected commands, zero state change)"] },
      { dir: "scenarios/05-undo-redo-mixed", name: "undo/redo with mixed human/agent edits", outcomes: s5.map((m) => outcome(m)), finalRevision: 9, invariants: ["depth progression after each step: [1,0] [2,0] [3,0] [4,0] [3,1] [2,2] [3,1] [4,0] [3,1]", "undo of the mcp delete restores box-0002 (originOfApplied kind mcp)", "fresh mcp edit at step 8 invalidates redo (redoDepth 0)", "final entities: cam-main, box-0001 (position [0,0,-0.5]), box-0002", "9 records retained (undo/redo are recorded mutations)"] },
      { dir: "scenarios/06-crash-before-replace", name: "crash before atomic replacement", outcomes: [{ kind: "query", op: "queryProject", revision: 6, writePaused: false }, { kind: "success", revision: 7, duplicated: false }], finalRevision: 7, invariants: ["load after restart reports revision 6 (the temp is ignored and cleaned)", "leftover temp .main.json.tmp-4242-7 removed on open", "retry of A7 re-executes fresh (no record): createdId box-0004, duplicated false", "final envelope equals envelope/valid/demo-0001-rev7.json"] },
      { dir: "scenarios/07-crash-after-replace", name: "crash after atomic replacement", outcomes: [{ kind: "query", op: "queryProject", revision: 7, writePaused: false }, { kind: "success", revision: 7, duplicated: true }], finalRevision: 7, invariants: ["load reports revision 7 (the rename landed)", "retry of A7 replays the recorded result (duplicated true)", "no double-apply: 6 entities, disk-after identical to disk-before"] },
      { dir: "scenarios/08-external-modification", name: "unexpected external modification", outcomes: [{ kind: "error", code: "external_change_unresolved", cls: "unavailable" }, { kind: "success", revision: 7, duplicated: false }, { kind: "success", revision: 7, duplicated: false }, { kind: "success", revision: 8, duplicated: false }], finalRevision: 8, invariants: ["outcome 2 is a queryProject serving last-known-good with writePaused true and pendingChange", "outcome 3 is the admin acceptExternalState result", "recovery snapshot disk-after/.thirdlight/recovery/scene-*.json is byte-identical to disk-external/scenes/main.json", "final envelope carries the accepted color #ff8800, box-0004 position [0,1,0], and exactly 1 retry record (retry block cleared on accept, then the post-accept command)"] },
      { dir: "scenarios/09-second-backend-ownership", name: "second-backend ownership rejection", outcomes: [{ kind: "error", code: "project_unavailable", cls: "unavailable" }, { kind: "success", revision: 7, duplicated: false }], finalRevision: 7, invariants: ["outcome 1 reason ownership_conflict (live owner pid 5000)", "outcome 2: the owner is dead, so backend B reclaims automatically (lockEpoch 1) and serves the project", "envelope bytes unchanged throughout"] },
    ],
    examples: "examples/commands.json (one request/result pair per mutation op, drawn from the mainline and scenario 05; query examples on the T5 state)",
  };
  idx.scenarios[8].outcomes = [
    { kind: "error", code: "project_unavailable", cls: "unavailable", reason: "ownership_conflict" },
    { kind: "query", op: "queryProject", revision: 7, writePaused: false },
  ];
  idx.scenarios[7].outcomes = [
    { kind: "error", code: "external_change_unresolved", cls: "unavailable" },
    { kind: "query", op: "queryProject", revision: 7, writePaused: true },
    { kind: "admin", op: "acceptExternalState", revision: 7 },
    { kind: "success", revision: 8, duplicated: false },
  ];
  put("expected.json", canonJson(idx));
}

// ---------------------------------------------------------------------------
// self-verification (always run)
// ---------------------------------------------------------------------------

const problems = [];

// 1. digest verification against the known requests (every record's digest
//    must equal the SHA-256 of its request's digest-canonical form)
{
  const reqById = new Map();
  for (const k of Object.keys(mainlineRequests)) reqById.set(mainlineRequests[k].requestId, mainlineRequests[k]);
  for (const m of s5) reqById.set(m.in.requestId, m.in);
  reqById.set(s3ReissueReq.requestId, s3ReissueReq);
  reqById.set(e8req.requestId, e8req);
  for (let i = 1; i <= 129; i++) {
    reqById.set(F(i), i === 1
      ? req("createEntity", RET, 0, F(i), browserOrigin, { kind: "box" })
      : req("setTransform", RET, i - 1, F(i), mcpOrigin, { entityId: "box-0001", transform: { position: [(i - 1) / 100, 0, 0] } }));
  }
  const checkRecords = (label, records) => {
    for (const rec of records) {
      const r = reqById.get(rec.requestId);
      if (!r) { problems.push(`${label}: request not found for record ${rec.requestId}`); continue; }
      const d = digestOf(r);
      if (d !== rec.digest) problems.push(`${label}: digest mismatch for ${rec.requestId}`);
    }
  };
  checkRecords("mainline-T5", mainline.snapshots.get("T5").records);
  checkRecords("mainline-T7", T7.records);
  checkRecords("S5", S5P.records);
  checkRecords("S3", s3proj.snapshots.get("S3AFTER").records);
  checkRecords("S8", s8proj.records);
  checkRecords("RET", ret.records);
}

// 2. canonical serialization stability for every planned file
for (const [rel, bytes] of files) {
  try {
    const parsed = JSON.parse(bytes);
    // re-serialize only where we control key order (skip the duplicate-key fixture)
    if (rel.endsWith("duplicate-key.json")) continue;
    const again = canonJson(parsed);
    if (again !== bytes) problems.push(`canonical stability: ${rel}`);
  } catch (e) {
    problems.push(`parse: ${rel}: ${e.message}`);
  }
}

// 3. scenario 05 history round-trip: replay forward+inverse independently
{
  let s = deepCopy(rev0Scene);
  // apply s1..s4 forward
  s = applyCreate(s, { kind: "box", name: "Ground" }).scene;
  s = applySetTransform(s, "box-0001", { position: [0, 0, -0.5] }).scene;
  s = applyCreate(s, { kind: "box", name: "Crate" }).scene;
  const del = applyDelete(s, "box-0002");
  s = del.scene;
  // undo delete (restore), undo create (delete), redo create (restore), setT, undo setT
  s = applyRestore(s, del.entries, del.restoredParentId).scene;
  s = applyDelete(s, "box-0002").scene;
  s = { ...s, entities: [...s.entities, deepCopy(entityById(S5P.scene, "box-0002").entity)] };
  const st8 = applySetTransform(s, "box-0001", { position: [0, 0.25, -0.5] });
  s = st8.scene;
  const st9 = applySetTransform(s, "box-0001", { position: [0, 0, -0.5] });
  s = st9.scene;
  if (canonJson(st9.previous === undefined ? st8.previous : st8.previous) !== canonJson(st8.previous)) void 0;
  if (canonJson(s) !== canonJson({ ...S5P.scene, revision: s.revision })) problems.push("S5 independent round-trip mismatch");
}

// 3b. multi-entity subtree restore (contract §9.1): the index formula must
//     reconstruct the pre-deletion array exactly for subtrees with > 1 entity.
//     Pre-deletion: [A, B, C, D, E] with C a child of B and E a child of D.
//     Deleting B's subtree {B, C} leaves [A, D, E]; restore must give back
//     exactly [A, B, C, D, E] (parent before child).
{
  const mk = (id, parentId) => (parentId === null ? { id } : { id, parentId });
  const pre = { entities: [mk("A", null), mk("B", null), mk("C", "B"), mk("D", null), mk("E", "D")] };
  const del = applyDelete(pre, "B");
  const restored = applyRestore(del.scene, del.entries, del.restoredParentId).scene;
  const got = restored.entities.map((e) => e.id).join(",");
  if (got !== "A,B,C,D,E") problems.push(`multi-entity restore: expected A,B,C,D,E but got ${got}`);
}

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

let written = 0, checked = 0, failed = 0;
if (CHECK) {
  for (const [rel, bytes] of files) {
    const p = path.join(FIX_ROOT, rel);
    let disk;
    try {
      disk = readFileSync(p, "utf8");
    } catch {
      problems.push(`check: missing file ${rel}`);
      failed++;
      continue;
    }
    if (disk !== bytes) {
      problems.push(`check: content mismatch ${rel}`);
      failed++;
    } else {
      checked++;
    }
  }
  // stray files under the generated roots that the tool does not own
  const known = new Set(files.keys());
  for (const rel of walk(FIX_ROOT)) {
    const base = rel.split("/").pop();
    const generatedRoots = ["scenarios/", "envelope/", "examples/"];
    if (generatedRoots.some((r) => rel.startsWith(r)) && !known.has(rel) && base !== "scenario.md") {
      problems.push(`check: untracked generated file ${rel}`);
      failed++;
    }
  }
} else {
  for (const [rel, bytes] of files) {
    const p = path.join(FIX_ROOT, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, bytes);
    written++;
  }
  // remove previously generated files no longer in the plan (generated roots only;
  // never touch *.md docs, tools/, or anything outside the generated roots)
  let removed = 0;
  for (const rel of walk(FIX_ROOT)) {
    const base = rel.split("/").pop();
    const inGeneratedRoot = ["scenarios/", "envelope/", "examples/"].some((r) => rel.startsWith(r)) || rel === "expected.json";
    if (inGeneratedRoot && !files.has(rel) && !base.endsWith(".md")) {
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