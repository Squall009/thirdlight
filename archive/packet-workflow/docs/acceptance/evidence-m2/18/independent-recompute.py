#!/usr/bin/env python3
"""Independent recomputation for packet 18 (M2 behaviors contract).

Second implementation (python3, no JS) of the rules proposed in
docs/planning/m2-contracts/behaviors.md, run against the committed packet-18
fixtures. It exists to show that the expected codes/limits/digests in
fixtures/m2/contracts/behaviors/* are not a restatement of the Node checker:
this file shares no code with tools/check-fixtures.mjs.

Usage (repository root):
  python3 docs/acceptance/evidence-m2/18/independent-recompute.py

Exit 0 = every re-derived verdict matches the fixture; 1 = at least one mismatch.
Read-only: it writes nothing.
"""

import hashlib
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
FIX = ROOT / "fixtures/m2/contracts"
BEH = FIX / "behaviors"

PINNED = ["@thirdlight/runtime"]
NODE_BUILTINS = {
    "assert", "buffer", "child_process", "crypto", "dns", "events", "fs", "http",
    "https", "module", "net", "os", "path", "process", "stream", "tls", "url",
    "util", "vm", "worker_threads", "zlib",
}
PATH_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$")
LIMITS = {
    "files": 16, "file_bytes": 65536, "graph_bytes": 262144, "import_depth": 8,
    "imports": 16, "owned_transforms": 16, "diagnostics": 32, "timeout_ms": 2000,
    "output_bytes": 131072, "intents_per_step": 64, "intents_per_instance_step": 5,
    "logs_per_step": 16, "logs_per_instance": 32,
}

problems = []
checks = []


def fail(where, msg):
    problems.append(f"{where}: {msg}")


def ok(name, detail=""):
    checks.append(f"{name}{': ' + detail if detail else ''}")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canon(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def resolve(from_path: str, spec: str) -> str:
    parts = from_path.split("/")[:-1]
    up = 0
    for seg in spec.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
            else:
                up += 1
        else:
            parts.append(seg)
    return "../" * up + "/".join(parts)


DYNAMIC = [
    (re.compile(r"\bimport\s*\("), "dynamic_import"),
    (re.compile(r"\beval\s*\("), "eval"),
    (re.compile(r"\bnew\s+Function\s*\("), "function_constructor"),
    (re.compile(r"\bFunction\s*\("), "function_constructor"),
    (re.compile(r"\brequire\s*\("), "require"),
]
IMPORT_FROM = re.compile(r"\b(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['\"]([^'\"]+)['\"]")
SIDE_EFFECT = re.compile(r"\bimport\s*['\"]([^'\"]+)['\"]")


def scan_text(text):
    """Return constructs ordered by offset: (index, kind, payload)."""
    hits = []
    for rex, reason in DYNAMIC:
        for m in rex.finditer(text):
            hits.append((m.start(), "dynamic", reason))
    for m in IMPORT_FROM.finditer(text):
        hits.append((m.start(), "specifier", (bool(m.group(1)), m.group(3))))
    for m in SIDE_EFFECT.finditer(text):
        hits.append((m.start(), "specifier", (False, m.group(1))))
    hits.sort(key=lambda h: h[0])
    return hits


def classify(spec, type_only):
    if re.match(r"^[a-z][a-z0-9+.-]*:", spec):
        if spec.startswith("node:"):
            return {"code": "behavior_import_forbidden", "reason": "node_builtin", "specifier": spec}
        return {"code": "behavior_import_forbidden", "reason": "network", "specifier": spec}
    if spec.startswith("/") or spec.startswith("#"):
        return {"code": "behavior_import_forbidden", "reason": "absolute", "specifier": spec}
    if spec.startswith("./") or spec.startswith("../"):
        return {"relative": True}
    if spec.split("/")[0] in NODE_BUILTINS:
        return {"code": "behavior_import_forbidden", "reason": "node_builtin", "specifier": spec}
    if spec in PINNED:
        if type_only:
            return {"type_only_engine": True}
        return {"code": "behavior_import_forbidden", "reason": "engine_value_import", "specifier": spec}
    return {"code": "behavior_import_forbidden", "reason": "bare", "specifier": spec}


def analyze_container(container_bytes):
    """behaviors.md §4.3 order; returns the derived verdict."""
    container = json.loads(container_bytes.decode("utf-8"))
    if container.get("graphVersion") != 1:
        return {"ok": False, "code": "behavior_source_invalid", "reason": "graph_version"}
    files = container.get("files", [])
    if not any(f["path"] == container["entryPath"] for f in files):
        return {"ok": False, "code": "behavior_source_invalid", "reason": "entry_missing"}
    for f in files:
        if not PATH_RE.match(f["path"]):
            return {"ok": False, "code": "behavior_source_invalid", "reason": "path", "path": f["path"]}
        if not f["path"].endswith(".ts"):
            return {"ok": False, "code": "behavior_source_invalid", "reason": "extension", "path": f["path"]}
    groups = [f["path"] for f in files], container.get("requiredModules", []), container.get("ownedTransforms", [])
    for g in groups:
        if g != sorted(g):
            return {"ok": False, "code": "behavior_source_invalid", "reason": "file_order"}
    paths = [f["path"] for f in files]
    if len(set(paths)) != len(paths):
        return {"ok": False, "code": "behavior_source_duplicate"}
    for g in groups[1:]:
        if len(set(g)) != len(g):
            return {"ok": False, "code": "behavior_source_invalid", "reason": "duplicate"}
    if len(files) > LIMITS["files"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "files", "current": len(files), "max": LIMITS["files"]}
    for f in files:
        n = len(f["text"].encode("utf-8"))
        if n > LIMITS["file_bytes"]:
            return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "file_bytes", "current": n, "max": LIMITS["file_bytes"]}
    graph_bytes = len(canon(container).encode("utf-8"))
    if graph_bytes > LIMITS["graph_bytes"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "graph_bytes", "current": graph_bytes, "max": LIMITS["graph_bytes"]}
    if len(container.get("ownedTransforms", [])) > LIMITS["owned_transforms"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "owned_transforms"}
    for mod in container.get("requiredModules", []):
        if mod not in PINNED:
            return {"ok": False, "code": "behavior_import_unpinned", "moduleId": mod}
    edges, type_only_imports, accepted_imports = [], 0, 0
    for f in files:
        hits = scan_text(f["text"])
        if sum(1 for h in hits if h[1] == "specifier") > LIMITS["imports"]:
            return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "imports"}
        for _, kind, payload in hits:
            if kind == "dynamic":
                return {"ok": False, "code": "behavior_dynamic_code", "reason": payload, "path": f["path"]}
            type_only, spec = payload
            c = classify(spec, type_only)
            if c.get("type_only_engine"):
                type_only_imports += 1
                continue
            if c.get("relative"):
                accepted_imports += 1
                edges.append((f["path"], spec))
                continue
            return {"ok": False, "code": c["code"], "reason": c["reason"], "specifier": c["specifier"], "path": f["path"]}
    rel = []
    for src, spec in edges:
        target = resolve(src, spec)
        if not target.endswith(".ts"):
            target += ".ts"
        if target.startswith(".."):
            return {"ok": False, "code": "behavior_source_escape", "resolved": target, "path": src}
        if target not in paths:
            return {"ok": False, "code": "behavior_source_missing", "resolved": target, "path": src}
        rel.append((src, target))
    adj = {}
    for a, b in rel:
        adj.setdefault(a, []).append(b)
    state, stack, found = {}, [], []

    def visit(node):
        if found:
            return
        state[node] = 1
        stack.append(node)
        for nxt in adj.get(node, []):
            if state.get(nxt) == 1:
                found.extend(stack[stack.index(nxt):] + [nxt])
                return
            if nxt not in state:
                visit(nxt)
        stack.pop()
        state[node] = 2

    visit(container["entryPath"])
    if found:
        return {"ok": False, "code": "behavior_source_cycle", "cycle": found}

    def depth(node):
        return max([1 + depth(n) for n in adj.get(node, [])], default=0)

    d = depth(container["entryPath"])
    if d > LIMITS["import_depth"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "import_depth", "current": d, "max": LIMITS["import_depth"]}
    return {"ok": True, "fileCount": len(files), "requiredModules": container.get("requiredModules", []),
            "ownedTransforms": container.get("ownedTransforms", []), "entryPath": container["entryPath"],
            "importDepth": d, "typeOnlyImports": type_only_imports, "acceptedImports": accepted_imports,
            "relativeEdges": rel}


def constructed(state):
    if state.get("fileCount", 0) > LIMITS["files"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "files"}
    if state.get("fileBytes", 0) > LIMITS["file_bytes"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "file_bytes"}
    if state.get("graphBytes", 0) > LIMITS["graph_bytes"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "graph_bytes"}
    if state.get("ownedTransforms", 0) > LIMITS["owned_transforms"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "owned_transforms"}
    req = state.get("requiredModules")
    if req:
        if len(set(req)) != len(req):
            return {"ok": False, "code": "behavior_source_invalid", "reason": "duplicate"}
        for m in req:
            if m not in PINNED:
                return {"ok": False, "code": "behavior_import_unpinned", "moduleId": m}
    if state.get("importsPerFile", 0) > LIMITS["imports"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "imports"}
    if state.get("importDepth", 0) > LIMITS["import_depth"]:
        return {"ok": False, "code": "behavior_source_limits_exceeded", "limit": "import_depth"}
    if state.get("syntaxError"):
        return {"ok": False, "code": "behavior_source_invalid", "reason": "syntax"}
    if state.get("compileTimeoutMs", 0) > LIMITS["timeout_ms"]:
        return {"ok": False, "code": "behavior_compile_timeout"}
    if state.get("compileFailed"):
        n = state.get("diagnostics", 1)
        return {"ok": False, "code": "behavior_compile_failed", "diagnosticsStored": min(n, 32), "diagnosticsTruncated": n > 32}
    if state.get("outputBytes", 0) > LIMITS["output_bytes"]:
        return {"ok": False, "code": "behavior_output_limits_exceeded", "limit": "output_bytes"}
    if state.get("outputScanPattern"):
        return {"ok": False, "code": "behavior_output_forbidden_content", "reason": state["outputScanPattern"]}
    if state.get("manifestMismatch"):
        return {"ok": False, "code": "behavior_declaration_mismatch", "reason": "manifest"}
    if state.get("trustAcknowledged") is False:
        return {"ok": False, "code": "behavior_trust_unacknowledged", "reason": "digest"}
    return {"ok": True}


def quantize(v):
    q = math.floor(v * 1e4 + 0.5) / 1e4
    return 0 if q == 0 else q


def main():
    containers = json.loads((BEH / "source-preimages/containers.json").read_text())
    ok("p18-container-hash", f"{len(containers['containers'])} committed container(s) re-hashed with hashlib")
    for c in containers["containers"]:
        raw = (BEH / "source-preimages" / c["file"]).read_bytes()
        if sha256(raw) != c["sha256"]:
            fail("container", f"{c['file']}: digest mismatch")
        if len(raw) != c["byteLength"]:
            fail("container", f"{c['file']}: length mismatch")

    graphs = json.loads((BEH / "source-graphs.json").read_text())
    for c in graphs["cases"]:
        raw = (FIX / c["container"]).read_bytes()
        if sha256(raw) != c["containerDigest"]:
            fail("source-graphs", f"{c['caseId']}: containerDigest mismatch")
        derived = json.loads(json.dumps(analyze_container(raw)))
        for k, v in c["expect"].items():
            if derived.get(k) != v:
                fail("source-graphs", f"{c['caseId']}: {k} re-derived {derived.get(k)!r} != expected {v!r}")
    for c in graphs["constructed"]:
        derived = json.loads(json.dumps(constructed(c["state"])))
        for k, v in c["expect"].items():
            if derived.get(k) != v:
                fail("source-graphs", f"{c['caseId']}: {k} re-derived {derived.get(k)!r} != expected {v!r}")
    ok("p18-source-graphs", f"{len(graphs['cases'])} container + {len(graphs['constructed'])} constructed case(s) re-derived in python")

    ex = json.loads((BEH / "compiled-example.json").read_text())
    raw = (FIX / ex["source"]["container"]).read_bytes()
    if sha256(raw) != ex["source"]["sourceDigest"]:
        fail("example", "sourceDigest mismatch")
    if len(raw) != ex["source"]["sourceByteLength"]:
        fail("example", "sourceByteLength mismatch")
    if sha256(canon(ex["manifest"]).encode()) != ex["source"]["manifestDigest"]:
        fail("example", "manifestDigest mismatch")
    out = (FIX / ex["outputArtifact"]["path"]).read_bytes()
    if sha256(out) != ex["outputArtifact"]["digest"] or sha256(out) != ex["source"]["outputDigest"]:
        fail("example", "output digest mismatch")
    for row in ex["intentTrace"]["rows"]:
        expected = quantize(max(-1.0, min(1.0, row["speed"] / 10)))
        if expected != row["expectedMove"]:
            fail("example", f"intent row speed {row['speed']}: {expected} != {row['expectedMove']}")
    for m in ex["intentTrace"]["sequence"]["expectedMoves"]:
        if quantize(max(-1.0, min(1.0, ex["intentTrace"]["sequence"]["usedValues"]["speed"] / 10))) != m:
            fail("example", "sequence move mismatch")
    ef = ex["effectiveFrame"]
    for case, intents in ((ef["emptyIdentity"], {"move": None, "jump": None}), (ef["withIntent"], ef["withIntent"]["intents"])):
        a = case["action"]
        derived = {"stepIndex": a["stepIndex"], "moveX": intents["move"] if intents["move"] is not None else a["moveX"],
                   "jump": intents["jump"] if intents["jump"] is not None else a["jump"]}
        if derived != case["expected"]:
            fail("example", f"effective frame mismatch: {derived} != {case['expected']}")
    ok("p18-example", "manifest/output digests and the declared numeric property trace re-derived in python")

    intents = json.loads((BEH / "intents.json").read_text())
    for row in intents["quantization"]:
        if quantize(row["input"]) != row["expected"]:
            fail("intents", f"quantize({row['input']}) = {quantize(row['input'])} != {row['expected']}")
    for c in intents["steps"]:
        per_instance, channel_writer, committed = {}, {}, 0
        move = jump = move_writer = jump_writer = None
        transform_writes = []
        derived = {"ok": True}
        for phase, key in (("intent", "intentPhase"), ("transform", "transformPhase")):
            for cc in c["step"].get(key, []):
                intent = cc["intent"]
                allowed = ["kind", "entityId", "position"] if intent.get("kind") == "transform" else ["kind", "value"]
                if any(k not in allowed for k in intent):
                    derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_invalid", "detail": "shape"}
                    break
                if intent["kind"] not in ("control_move", "control_jump", "transform"):
                    derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_invalid", "detail": "shape"}
                    break
                want = "transform" if intent["kind"] == "transform" else "intent"
                if want != phase:
                    derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_invalid", "detail": "phase"}
                    break
                if intent["kind"] in ("control_move", "control_jump") and not isinstance(intent.get("value"), (int, float)) and intent["kind"] == "control_move":
                    derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_invalid", "detail": "shape"}
                    break
                if intent["kind"] == "control_move" and not (-1 <= intent["value"] <= 1):
                    derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_invalid", "detail": "value"}
                    break
                if intent["kind"] == "control_jump" and intent["value"] not in ("none", "pressed", "held", "released"):
                    derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_invalid", "detail": "value"}
                    break
                if intent["kind"] == "transform":
                    pos = intent["position"]
                    if not pos or any(k not in "xyz" or abs(v) > 1e6 for k, v in pos.items()):
                        derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_invalid", "detail": "value"}
                        break
                    if intent["entityId"] not in cc.get("ownedTransforms", []):
                        derived = {"ok": False, "code": "module_error", "reason": "behavior_transform_forbidden", "detail": "not_owner"}
                        break
                    key_id = intent["entityId"] + ":" + ",".join(sorted(pos))
                else:
                    key_id = intent["kind"]
                seen = per_instance.setdefault(cc["moduleId"], set())
                if key_id in seen:
                    derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_conflict", "detail": "duplicate_intent"}
                    break
                seen.add(key_id)
                if intent["kind"] != "transform":
                    owner = channel_writer.get(intent["kind"])
                    if owner and owner != cc["moduleId"]:
                        derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_conflict", "detail": "duplicate_writer"}
                        break
                    channel_writer[intent["kind"]] = cc["moduleId"]
                if len(seen) > LIMITS["intents_per_instance_step"]:
                    derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_limit", "detail": "per_instance"}
                    break
                committed += 1
                if committed > LIMITS["intents_per_step"]:
                    derived = {"ok": False, "code": "module_error", "reason": "behavior_intent_limit", "detail": "per_step"}
                    break
                if intent["kind"] == "control_move":
                    move, move_writer = quantize(intent["value"]), cc["moduleId"]
                elif intent["kind"] == "control_jump":
                    jump, jump_writer = intent["value"], cc["moduleId"]
                else:
                    transform_writes.append({"moduleId": cc["moduleId"], "entityId": intent["entityId"], "position": dict(intent["position"])})
            if not derived["ok"]:
                break
        if derived["ok"]:
            derived["committed"] = {"move": move, "jump": jump, "moveWriter": move_writer, "jumpWriter": jump_writer, "transformWrites": transform_writes}
        derived = json.loads(json.dumps(derived))
        for k, v in c["expect"].items():
            if derived.get(k) != v:
                fail("intents", f"{c['caseId']}: {k} re-derived {derived.get(k)!r} != expected {v!r}")
    ok("p18-intents", f"{len(intents['quantization'])} quantization + {len(intents['steps'])} step case(s) re-derived in python")

    rf = json.loads((BEH / "runtime-failures.json").read_text())
    for f in rf["floods"]:
        if "callsPerStep" in f:
            log_count = f["callsPerStep"] * f["steps"]
            accepted = min(f["callsPerStep"], LIMITS["logs_per_step"]) * f["steps"]
            derived = {"logCount": log_count, "accepted": accepted, "stored": accepted,
                       "dropped": log_count - accepted, "ring": min(accepted, LIMITS["logs_per_instance"])}
            for k, v in f["expect"].items():
                if k == "errorCount":
                    continue
                if derived[k] != v:
                    fail("runtime-failures", f"{f['caseId']}: {k} {derived[k]} != {v}")
        else:
            total = f["instances"] * f["intentsPerInstance"]
            accepted = min(f["instances"] * min(f["intentsPerInstance"], LIMITS["intents_per_instance_step"]), LIMITS["intents_per_step"])
            if accepted != f["expect"]["accepted"]:
                fail("runtime-failures", f"{f['caseId']}: accepted {accepted} != {f['expect']['accepted']}")
    ok("p18-runtime-failures", f"{len(rf['floods'])} flood case(s) re-derived in python")

    print("packet-18 independent recompute (python3, second implementation)")
    for c in checks:
        print(f"OK   {c}")
    for p in problems:
        print(f"FAIL {p}")
    print(f"verdict: {'OK' if not problems else 'MISMATCH'} "
          f"({len(checks)} group(s) re-derived, {len(problems)} mismatch(es))")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
