#!/usr/bin/env python3
"""
Independent reference implementation + fixture generator for packet 17.

This script is a SECOND implementation of the proposed packet-17 contracts
(docs/planning/m2-contracts/{input,physics,platformer}.md). It is deliberately
written in a different language from the JS checker
(fixtures/m2/contracts/tools/check-fixtures.mjs) so that the committed
expectation tables in fixtures/m2/contracts/{input,physics,platformer,runtime}/
are produced by one implementation and re-verified by another.

It contains no Thirdlight production logic and no contract state. It is
sanitized: numbers, ids and local file paths only.

Usage:
  python3 independent-recompute.py --write     # (re)generate the fixture JSON
  python3 independent-recompute.py --verify    # recompute and compare (no writes)
"""

from __future__ import annotations

import json
import math
import os
import sys

# ---------------------------------------------------------------------------
# contract constants (docs/planning/m2-contracts/platformer.md 7 / physics.md 7)
# ---------------------------------------------------------------------------

DT = 1.0 / 120.0
G = -19.62
RUN = 4.0
JUMP_V = 7.0
MAX_FALL = -30.0
ACCEL = 40.0
DECEL = 60.0
COYOTE = 6
BUFFER = 8
RELEASE = 0.5
HALF_X = 0.31          # capsule radius 0.3 + controller offset (skin) 0.01
HALF_Y = 0.91          # capsule half-height 0.6 + radius 0.3 + skin 0.01
SNAP = 0.1
REST_Y = 0.91
SETTLE_STEPS = 12
REPLAY_TOL = 1e-9

FLOOR = {"id": "floor", "x": 0.0, "y": -0.25, "hw": 200.0, "hh": 0.25}   # top y = 0


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def approach(v, target, up, down):
    if abs(target - v) <= 1e-9:
        return target
    if v < target:
        return min(target, v + up)
    if v > target:
        return max(target, v - down)
    return v


# ---------------------------------------------------------------------------
# scripted analytic port (axis-aligned statics; see platformer.md 11 fixtures)
# ---------------------------------------------------------------------------

def port_step(pos, req, statics, grounded_prev, ground_until_step=None, step_index=None):
    x, y = pos
    blocked_ground = ground_until_step is not None and step_index is not None and step_index > ground_until_step
    active = [] if blocked_ground else statics

    nx = x + req["x"]
    wall = False
    for b in active:
        if abs(y - b["y"]) < HALF_Y + b["hh"]:
            left = b["x"] - b["hw"] - HALF_X
            right = b["x"] + b["hw"] + HALF_X
            if req["x"] > 0 and x + HALF_X <= b["x"] - b["hw"] and nx + HALF_X > b["x"] - b["hw"]:
                nx = left
                wall = True
            elif req["x"] < 0 and x - HALF_X >= b["x"] + b["hw"] and nx - HALF_X < b["x"] + b["hw"]:
                nx = right
                wall = True

    ny = y + req["y"]
    ground = False
    head = False
    for b in active:
        if abs(nx - b["x"]) < HALF_X + b["hw"]:
            top = b["y"] + b["hh"]
            bottom = b["y"] - b["hh"]
            if req["y"] <= 0 and y - HALF_Y >= top - 1e-9 and ny - HALF_Y < top:
                ny = top + HALF_Y
                ground = True
            elif req["y"] > 0 and y + HALF_Y <= bottom + 1e-9 and ny + HALF_Y > bottom:
                ny = bottom - HALF_Y
                head = True

    snapped = False
    if not ground and grounded_prev and req["y"] <= 0:
        best = None
        for b in active:
            if abs(nx - b["x"]) < HALF_X + b["hw"]:
                top = b["y"] + b["hh"]
                gap = (y - HALF_Y) - top
                if -1e-9 <= gap <= SNAP + 1e-9 and (best is None or top > best):
                    best = top
        if best is not None:
            ny = best + HALF_Y
            ground = True
            snapped = True

    result = {
        "requested": {"x": req["x"], "y": req["y"]},
        "applied": {"x": nx - x, "y": ny - y},
        "position": {"x": nx, "y": ny},
        "grounded": ground,
        "supportNormal": {"x": 0, "y": 1} if ground else {"x": 0, "y": 0},
        "contacts": {"ground": ground, "wall": wall, "head": head, "steepSlope": False},
        "snapped": snapped,
    }
    return {"x": nx, "y": ny}, result


# ---------------------------------------------------------------------------
# controller step (platformer.md 7, exact order A..K)
# ---------------------------------------------------------------------------

def controller_step(st, frame, prev_result):
    grounded_prev = bool(prev_result["grounded"])
    jump_phase = frame["jump"]

    # A
    if jump_phase == "pressed":
        st["buffer"] = BUFFER
    # B
    if grounded_prev:
        st["coyote"] = COYOTE
    # C
    started = False
    if st["buffer"] > 0 and (grounded_prev or st["coyote"] > 0) and not st["airborne"]:
        st["vy"] = JUMP_V
        st["airborne"] = True
        st["buffer"] = 0
        st["coyote"] = 0
        started = True
    # D
    if grounded_prev and not st["airborne"]:
        st["vy"] = 0.0
    else:
        st["vy"] = max(st["vy"] + G * DT, MAX_FALL)
    # E
    if prev_result["contacts"]["head"] and st["vy"] > 0:
        st["vy"] = 0.0
    # F
    if jump_phase == "released" and st["airborne"]:
        if st["vy"] > 0:
            st["vy"] = st["vy"] * RELEASE
        st["airborne"] = False
    # G
    if st["airborne"] and grounded_prev and st["vy"] <= 0:
        st["airborne"] = False
    # H
    target = frame["moveX"] * RUN
    st["vx"] = approach(st["vx"], target, ACCEL * DT, DECEL * DT)
    # J / K bookkeeping happens after the move is staged (I) in the contract;
    # the staged request is recorded here and the port is applied by the caller.
    st["_started"] = started
    st["_grounded_prev"] = grounded_prev
    return {"x": st["vx"] * DT, "y": st["vy"] * DT}


def controller_bookkeeping(st, frame):
    # J
    if not st["_grounded_prev"]:
        st["coyote"] = max(0, st["coyote"] - 1)
    # K
    if not st["_started"]:
        st["buffer"] = max(0, st["buffer"] - 1)


def neutral(step_index):
    return {"stepIndex": step_index, "moveX": 0, "jump": "none"}


def run_trace(trace):
    st = {
        "stepIndex": trace["start"]["stepIndex"],
        "x": trace["start"]["x"],
        "y": trace["start"]["y"],
        "vx": trace["start"]["vx"],
        "vy": trace["start"]["vy"],
        "airborne": trace["start"]["airborne"],
        "coyote": trace["start"]["coyote"],
        "buffer": trace["start"]["buffer"],
    }
    prev_result = {
        "grounded": trace["start"]["grounded"],
        "contacts": {"ground": trace["start"]["grounded"], "wall": False, "head": False, "steepSlope": False},
    }
    statics = [dict(FLOOR)] + [dict(b) for b in trace["port"].get("statics", [])]
    if trace["port"].get("includeFloor") is False:
        statics = [dict(b) for b in trace["port"].get("statics", [])]
    frames = {f["stepIndex"]: f for f in trace["frames"]}
    ground_until = trace["port"].get("groundUntilStep")
    steps = []
    for n in range(trace["start"]["stepIndex"], trace["untilStep"]):
        frame = frames.get(n, neutral(n))
        req = controller_step(st, frame, prev_result)
        pos, result = port_step(
            (st["x"], st["y"]), req, statics, st["_grounded_prev"], ground_until, n
        )
        st["x"], st["y"] = pos["x"], pos["y"]
        controller_bookkeeping(st, frame)
        prev_result = result
        steps.append(
            {
                "stepIndex": n,
                "frame": frame,
                "x": st["x"],
                "y": st["y"],
                "vx": st["vx"],
                "vy": st["vy"],
                "grounded": result["grounded"],
                "airborne": st["airborne"],
                "coyote": st["coyote"],
                "buffer": st["buffer"],
                "contacts": result["contacts"],
                "snapped": result["snapped"],
            }
        )
    return st, steps


def sample(steps, wanted):
    by_index = {s["stepIndex"]: s for s in steps}
    missing = [i for i in wanted if i not in by_index]
    if missing:
        raise SystemExit(f"sample indices not simulated: {missing}")
    return by_index


# ---------------------------------------------------------------------------
# input mapping reference (input.md 4)
# ---------------------------------------------------------------------------

DEAD_ZONE = 0.2
QUANT = 1e-4


def quantize_move(v):
    v = clamp(v, -1.0, 1.0)
    q = math.floor(abs(v) * 1e4 + 0.5) / 1e4
    q = q if v >= 0 else -q
    return 0.0 if q == 0 else q


def rescaled_stick(axis):
    a = abs(axis)
    if a <= DEAD_ZONE:
        return 0.0
    return math.copysign((a - DEAD_ZONE) / (1.0 - DEAD_ZONE), axis)


def map_raw(raw, step_index, prev_down, verified=True):
    """raw: { keyboardLeft, keyboardRight, dpad, stickX, jumpDown }"""
    digital = 0
    if raw.get("keyboardLeft") and not raw.get("keyboardRight"):
        digital = -1
    elif raw.get("keyboardRight") and not raw.get("keyboardLeft"):
        digital = 1
    elif raw.get("dpad") is not None and raw["dpad"] != 0:
        digital = 1 if raw["dpad"] > 0 else -1
    stick = rescaled_stick(raw.get("stickX", 0.0))
    move = quantize_move(float(digital) if digital != 0 else stick)

    down_now = bool(raw.get("jumpDown", False))
    if not verified:
        if down_now:
            jump = "held"
        else:
            jump = "none"
            verified = True
    else:
        down = down_now or bool(raw.get("jumpLatch", False))
        if down and not prev_down:
            jump = "pressed"
        elif down and prev_down:
            jump = "held"
        elif not down and prev_down:
            jump = "released"
        else:
            jump = "none"
        down_now = down
    return {"stepIndex": step_index, "moveX": move, "jump": jump}, {"down": down_now, "verified": verified}


# ---------------------------------------------------------------------------
# fixture builders
# ---------------------------------------------------------------------------

def numerics_fixture():
    climb = math.radians(45.0)
    threshold = math.cos(climb)
    tol = 1e-6
    rows = []
    for deg, expected in [
        (29.9, "grounded-not-idle-sliding"),
        (30.0, "grounded-idle-sliding"),
        (30.1, "grounded-idle-sliding"),
        (43.0, "grounded-idle-sliding"),
        (44.9, "grounded-idle-sliding"),
        (45.0, "grounded-idle-sliding"),
        (45.1, "refused"),
        (47.0, "refused"),
    ]:
        n_y = math.cos(math.radians(deg))
        rows.append(
            {
                "angleDeg": deg,
                "supportNormalY": n_y,
                "grounded": n_y >= threshold - tol,
                "climbAllowed": n_y >= threshold - tol,
                "slidesWhenIdle": deg >= 30.0,
                "expected": expected,
            }
        )
    return {
        "kind": "physics-numerics",
        "setVersion": 1,
        "id": "physics-numerics",
        "pins": [
            {"file": "docs/planning/m2-contracts/physics.md", "section": "## 3. Supported collision features (M2, exhaustive)"},
            {"file": "docs/planning/m2-contracts/physics.md", "section": "## 7. Numeric constants, defaults and tolerances"},
            {"file": "docs/planning/m2-contracts/physics.md", "section": "## 8. Grounding rule (normative)"},
        ],
        "constants": [
            {"name": "fixedStepHz", "value": 120, "unit": "Hz", "source": "packet-14-measured"},
            {"name": "dt", "value": DT, "unit": "s", "source": "packet-14-measured"},
            {"name": "gravityY", "value": G, "unit": "m/s2", "source": "packet-14-measured", "setting": "gravity_y"},
            {"name": "runSpeed", "value": RUN, "unit": "m/s", "source": "packet-14-measured", "setting": "run_speed"},
            {"name": "jumpVelocity", "value": JUMP_V, "unit": "m/s", "source": "packet-14-measured", "setting": "jump_velocity"},
            {"name": "maxFallSpeed", "value": MAX_FALL, "unit": "m/s", "source": "packet-14-measured", "setting": "max_fall_speed"},
            {"name": "capsuleRadius", "value": 0.3, "unit": "m", "source": "packet-14-measured"},
            {"name": "capsuleHalfHeight", "value": 0.6, "unit": "m", "source": "packet-14-measured"},
            {"name": "reach", "value": 0.9, "unit": "m", "source": "packet-14-measured"},
            {"name": "offsetSkin", "value": 0.01, "unit": "m", "source": "packet-14-measured"},
            {"name": "groundSnap", "value": 0.1, "unit": "m", "source": "packet-14-measured"},
            {"name": "maxSlopeClimbDeg", "value": 45.0, "unit": "deg", "source": "packet-14-measured", "setting": "max_slope_climb_deg"},
            {"name": "minSlopeSlideDeg", "value": 30.0, "unit": "deg", "source": "packet-14-measured", "setting": "min_slope_slide_deg"},
            {"name": "autostep", "value": False, "unit": "flag", "source": "packet-14-measured"},
            {"name": "settledRestCenterY", "value": REST_Y, "unit": "m", "source": "packet-14-measured (0.9099987 measured; 0.910 contract)"},
            {"name": "settlePreRollSteps", "value": SETTLE_STEPS, "unit": "steps", "source": "packet-14-measured (1.36 mm first-step dip)"},
            {"name": "moveAccel", "value": ACCEL, "unit": "m/s2", "source": "contract-selected (not packet-14 measured)"},
            {"name": "moveDecel", "value": DECEL, "unit": "m/s2", "source": "contract-selected (not packet-14 measured)"},
            {"name": "jumpReleaseFactor", "value": RELEASE, "unit": "factor", "source": "contract-selected (not packet-14 measured)"},
            {"name": "coyoteSteps", "value": COYOTE, "unit": "steps", "source": "contract-selected (not packet-14 measured)"},
            {"name": "jumpBufferSteps", "value": BUFFER, "unit": "steps", "source": "contract-selected (not packet-14 measured)"},
            {"name": "staticPenetrationMax", "value": 0.005, "unit": "m", "source": "packet-14-measured tolerance"},
            {"name": "wallStopBand", "value": 0.05, "unit": "m", "source": "packet-14-measured tolerance"},
            {"name": "headContactMaxRisePerStep", "value": 0.0005, "unit": "m/step", "source": "packet-14-measured tolerance"},
            {"name": "ledgeBlockMaxDxPerStep", "value": 0.02, "unit": "m/step", "source": "packet-14-measured tolerance"},
            {"name": "seamMaxUngroundedSteps", "value": 2, "unit": "steps", "source": "packet-14-measured tolerance"},
            {"name": "apexTheoretical", "value": 1.249, "unit": "m", "source": "packet-14-measured (v^2/2g)"},
            {"name": "apexTolerance", "value": 0.05, "unit": "m", "source": "packet-14-measured tolerance"},
            {"name": "replayToleranceSameEngine", "value": 1e-06, "unit": "m", "source": "contract-selected"},
            {"name": "replayToleranceCrossEngine", "value": 0.001, "unit": "m", "source": "contract-selected"},
            {"name": "containerStepP99Ms", "value": 0.031, "unit": "ms", "source": "packet-14-directional (BR-2, not a reference-desktop claim)"},
            {"name": "coldInitMsMin", "value": 73.125, "unit": "ms", "source": "packet-14-directional (BR-2, not a reference-desktop claim)"},
            {"name": "coldInitMsMax", "value": 76.72, "unit": "ms", "source": "packet-14-directional (BR-2, not a reference-desktop claim)"},
            {"name": "tickBudgetMs", "value": 8.333, "unit": "ms", "source": "whole 120 Hz tick budget, not physics-only"},
        ],
        "derived": {
            "cosMaxSlopeClimb": threshold,
            "groundingThreshold": threshold - tol,
            "accelStepsToRunSpeed": 12,
            "decelStepsToZero": 8,
            "coyoteWindowSteps": COYOTE,
            "jumpBufferWindowSteps": BUFFER,
            "jumpApexGainDiscrete": None,
        },
        "slopeClassification": rows,
        "settingsRegistry": [
            {"key": "gravity_y", "type": "number", "default": -19.62, "min": -100.0, "max": -1.0, "exclusiveMax": False, "unit": "m/s2"},
            {"key": "run_speed", "type": "number", "default": 4.0, "min": 0.0, "max": 50.0, "exclusiveMin": True, "unit": "m/s"},
            {"key": "jump_velocity", "type": "number", "default": 7.0, "min": 0.0, "max": 50.0, "unit": "m/s"},
            {"key": "max_fall_speed", "type": "number", "default": -30.0, "min": -100.0, "max": 0.0, "exclusiveMax": True, "unit": "m/s"},
            {"key": "max_slope_climb_deg", "type": "number", "default": 45.0, "min": 0.0, "max": 89.9, "unit": "deg"},
            {"key": "min_slope_slide_deg", "type": "number", "default": 30.0, "min": 0.0, "max": 89.9, "unit": "deg"},
        ],
        "settingsCases": [
            {"caseId": "S1-empty", "input": {}, "outcome": "ok", "settings": {"gravity_y": -19.62, "run_speed": 4.0, "jump_velocity": 7.0, "max_fall_speed": -30.0, "max_slope_climb_deg": 45.0, "min_slope_slide_deg": 30.0}},
            {"caseId": "S2-partial-override", "input": {"jump_velocity": 8.25}, "outcome": "ok", "settings": {"gravity_y": -19.62, "run_speed": 4.0, "jump_velocity": 8.25, "max_fall_speed": -30.0, "max_slope_climb_deg": 45.0, "min_slope_slide_deg": 30.0}},
            {"caseId": "S3-unknown-key", "input": {"double_jump": True}, "outcome": "setting_unknown", "code": "setting_unknown", "key": "double_jump"},
            {"caseId": "S4-wrong-type", "input": {"run_speed": "fast"}, "outcome": "field_value", "code": "field_value", "key": "run_speed"},
            {"caseId": "S5-out-of-range-high", "input": {"run_speed": 50.5}, "outcome": "field_value", "code": "field_value", "key": "run_speed"},
            {"caseId": "S6-out-of-range-low", "input": {"gravity_y": -101}, "outcome": "field_value", "code": "field_value", "key": "gravity_y"},
            {"caseId": "S7-zero-run-speed", "input": {"run_speed": 0}, "outcome": "field_value", "code": "field_value", "key": "run_speed"},
            {"caseId": "S8-zero-max-fall", "input": {"max_fall_speed": 0}, "outcome": "field_value", "code": "field_value", "key": "max_fall_speed"},
            {"caseId": "S9-cross-key", "input": {"max_slope_climb_deg": 25, "min_slope_slide_deg": 30}, "outcome": "field_value", "code": "field_value", "key": "min_slope_slide_deg"},
            {"caseId": "S10-cross-key-equal", "input": {"max_slope_climb_deg": 30, "min_slope_slide_deg": 30}, "outcome": "ok", "settings": {"gravity_y": -19.62, "run_speed": 4.0, "jump_velocity": 7.0, "max_fall_speed": -30.0, "max_slope_climb_deg": 30.0, "min_slope_slide_deg": 30.0}},
        ],
        "validationCases": [
            {"caseId": "V1-box-valid", "component": {"shape": {"type": "box", "hx": 2.0, "hy": 0.25}}, "outcome": "ok"},
            {"caseId": "V2-box-zero-extent", "component": {"shape": {"type": "box", "hx": 0, "hy": 0.25}}, "code": "collider_shape_invalid"},
            {"caseId": "V3-polygon-valid-ramp", "component": {"shape": {"type": "polygon", "vertices": [[0, 0], [3, 0], [3, 2.8]]}}, "outcome": "ok"},
            {"caseId": "V4-polygon-two-vertices", "component": {"shape": {"type": "polygon", "vertices": [[0, 0], [1, 1]]}}, "code": "collider_shape_invalid"},
            {"caseId": "V5-polygon-nine-vertices", "component": {"shape": {"type": "polygon", "vertices": [[0, 0], [1, 0], [2, 0.4], [3, 1], [3, 2], [2, 3], [1, 3.2], [0.5, 3], [0, 2]]}}, "code": "limits_exceeded", "limit": "collider_vertices"},
            {"caseId": "V6-polygon-concave", "component": {"shape": {"type": "polygon", "vertices": [[0, 0], [2, 0], [1, 1], [2, 2], [0, 2]]}}, "code": "collider_shape_invalid"},
            {"caseId": "V7-polygon-degenerate-area", "component": {"shape": {"type": "polygon", "vertices": [[0, 0], [1, 0], [2, 0]]}}, "code": "collider_shape_invalid"},
            {"caseId": "V8-polygon-duplicate-vertex", "component": {"shape": {"type": "polygon", "vertices": [[0, 0], [1, 0], [1, 0], [1, 1]]}}, "code": "collider_shape_invalid"},
            {"caseId": "V9-polygon-non-finite", "component": {"shape": {"type": "polygon", "vertices": [[0, 0], [1, 0], [1, 1e308]]}}, "code": "number_out_of_range"},
            {"caseId": "V10-controller-marker", "component": {}, "outcome": "ok"},
            {"caseId": "V11-controller-unknown-field", "component": {"speed": 4}, "code": "field_unexpected"},
            {"caseId": "V12-collider-and-controller", "entity": {"components": {"transform": {}, "collider": {"shape": {"type": "box", "hx": 1, "hy": 1}}, "controller": {}}}, "code": "component_conflict"},
            {"caseId": "V13-parented-collider", "entity": {"parentId": "group-0001", "components": {"transform": {}, "collider": {"shape": {"type": "box", "hx": 1, "hy": 1}}}}, "code": "physics_transform_unsupported", "reason": "parented"},
            {"caseId": "V14-scaled-collider", "entity": {"components": {"transform": {"scale": [2, 1, 1]}, "collider": {"shape": {"type": "box", "hx": 1, "hy": 1}}}}, "code": "physics_transform_unsupported", "reason": "scale"},
            {"caseId": "V15-tilted-collider", "entity": {"components": {"transform": {"rotation": [0.383, 0, 0, 0.924]}, "collider": {"shape": {"type": "box", "hx": 1, "hy": 1}}}}, "code": "physics_transform_unsupported", "reason": "rotation"},
            {"caseId": "V16-z-rotated-box-valid", "entity": {"components": {"transform": {"rotation": [0, 0, 0.3826834323650898, 0.9238795325112867]}, "collider": {"shape": {"type": "box", "hx": 1.5, "hy": 0.1}}}}, "outcome": "ok"},
            {"caseId": "V17-rotated-controller", "entity": {"components": {"transform": {"rotation": [0, 0, 0.3826834323650898, 0.9238795325112867]}, "controller": {}}}, "code": "physics_transform_unsupported", "reason": "upright"},
            {"caseId": "V18-two-controllers", "scene": {"controllerCount": 2}, "code": "controller_count_invalid"},
            {"caseId": "V19-zero-controllers-with-controller-module", "scene": {"controllerCount": 0}, "code": "config_invalid", "reason": "controller_target"},
            {"caseId": "V20-collider-count-overflow", "scene": {"colliderCount": 257}, "code": "limits_exceeded", "limit": "colliders"},
        ],
    }


def traces_fixture():
    global RUN
    traces = []

    # 1. flat ground: accelerate, hold, decelerate
    traces.append(
        {
            "traceId": "flat-accel-decel",
            "title": "Flat ground: 12-step acceleration to run_speed, 8-step deceleration to zero, no Y drift",
            "port": {"kind": "scripted-analytic", "statics": []},
            "start": {"stepIndex": 12, "x": 0.0, "y": REST_Y, "vx": 0.0, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [
                *[{"stepIndex": n, "moveX": 1, "jump": "none"} for n in range(12, 30)],
                *[{"stepIndex": n, "moveX": 0, "jump": "none"} for n in range(30, 60)],
                *[{"stepIndex": n, "moveX": -1, "jump": "none"} for n in range(60, 72)],
            ],
            "untilStep": 72,
            "sample": [12, 13, 14, 17, 22, 23, 24, 29, 30, 31, 37, 38, 59, 60, 61, 62, 63, 71],
            "expect": {
                "runSpeedReachedAtStep": 23,
                "zeroSpeedReachedAtStep": 37,
                "groundedEveryStep": True,
                "yEveryStep": REST_Y,
                "maxAbsVx": RUN,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 2. full-height jump (hold)
    traces.append(
        {
            "traceId": "jump-hold-full-height",
            "title": "Held jump: edge at step 12, apex gain vs theory, landing back at rest height",
            "port": {"kind": "scripted-analytic", "statics": []},
            "start": {"stepIndex": 12, "x": 0.0, "y": REST_Y, "vx": 0.0, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [
                {"stepIndex": 12, "moveX": 0, "jump": "pressed"},
                *[{"stepIndex": n, "moveX": 0, "jump": "held"} for n in range(13, 130)],
            ],
            "untilStep": 130,
            "sample": [12, 13, 20, 30, 40, 41, 42, 43, 50, 70, 95, 96, 97, 98, 99, 105, 129],
            "expect": {
                "jumpStartedStep": 12,
                "vyAtJumpStep": JUMP_V,
                "apexToleranceM": 0.05,
                "apexTheoreticalM": 1.249,
                "landedAtRestY": REST_Y,
                "extraAirJump": False,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 3. release cut (variable height)
    traces.append(
        {
            "traceId": "jump-tap-release",
            "title": "Variable height: release at step 14 halves the ascending velocity",
            "port": {"kind": "scripted-analytic", "statics": []},
            "start": {"stepIndex": 12, "x": 0.0, "y": REST_Y, "vx": 0.0, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [
                {"stepIndex": 12, "moveX": 0, "jump": "pressed"},
                {"stepIndex": 13, "moveX": 0, "jump": "held"},
                {"stepIndex": 14, "moveX": 0, "jump": "released"},
            ],
            "untilStep": 70,
            "sample": [12, 13, 14, 15, 20, 25, 30, 40, 69],
            "expect": {
                "releaseStep": 14,
                "releaseFactor": RELEASE,
                "apexBelowHoldJump": True,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 4. jump buffer lands inside the window
    traces.append(
        {
            "traceId": "jump-buffer-lands-in-window",
            "title": "Buffer: press while airborne, land at step 18, the buffered jump fires at step 19 (the last buffered step)",
            "port": {"kind": "scripted-analytic", "statics": []},
            "start": {"stepIndex": 12, "x": 0.0, "y": 1.0, "vx": 0.0, "vy": -1.0, "airborne": False, "coyote": 0, "buffer": 0, "grounded": False},
            "frames": [{"stepIndex": 12, "moveX": 0, "jump": "pressed"}],
            "untilStep": 40,
            "sample": [12, 13, 17, 18, 19, 20, 21, 39],
            "expect": {
                "bufferPressStep": 12,
                "landingStep": 18,
                "jumpStartedStep": 18,
                "bufferWindowSteps": BUFFER,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 5. jump buffer expires
    traces.append(
        {
            "traceId": "jump-buffer-expired",
            "title": "Buffer: press while airborne, land 33 steps later, no buffered jump",
            "port": {"kind": "scripted-analytic", "statics": []},
            "start": {"stepIndex": 12, "x": 0.0, "y": 2.0, "vx": 0.0, "vy": -1.0, "airborne": False, "coyote": 0, "buffer": 0, "grounded": False},
            "frames": [{"stepIndex": 12, "moveX": 0, "jump": "pressed"}],
            "untilStep": 60,
            "sample": [12, 13, 19, 20, 44, 45, 46, 47, 59],
            "expect": {
                "bufferPressStep": 12,
                "landingStep": 45,
                "jumpStartedStep": None,
                "bufferWindowSteps": BUFFER,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 6. coyote: last allowed step
    traces.append(
        {
            "traceId": "jump-coyote-last-step",
            "title": "Coyote: ground removed after step 14, press at the 6th airborne step (21) still jumps",
            "port": {"kind": "scripted-analytic", "statics": [], "groundUntilStep": 14},
            "start": {"stepIndex": 12, "x": 0.0, "y": REST_Y, "vx": 0.0, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [{"stepIndex": 21, "moveX": 0, "jump": "pressed"}],
            "untilStep": 45,
            "sample": [12, 14, 15, 16, 20, 21, 22, 23, 44],
            "expect": {
                "lastGroundedResultStep": 14,
                "coyoteWindowLastStep": 21,
                "jumpStartedStep": 21,
                "coyoteWindowSteps": COYOTE,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 7. coyote: one step late
    traces.append(
        {
            "traceId": "jump-coyote-one-step-late",
            "title": "Coyote: the same press one step later (22) cannot jump",
            "port": {"kind": "scripted-analytic", "statics": [], "groundUntilStep": 14},
            "start": {"stepIndex": 12, "x": 0.0, "y": REST_Y, "vx": 0.0, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [{"stepIndex": 22, "moveX": 0, "jump": "pressed"}],
            "untilStep": 45,
            "sample": [12, 14, 21, 22, 23, 24, 25, 30, 44],
            "expect": {
                "lastGroundedResultStep": 14,
                "coyoteWindowLastStep": 21,
                "jumpStartedStep": None,
                "coyoteWindowSteps": COYOTE,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 8. no air jump
    traces.append(
        {
            "traceId": "no-air-jump",
            "title": "No air jump: a second press while airborne never restores jump velocity",
            "port": {"kind": "scripted-analytic", "statics": []},
            "start": {"stepIndex": 12, "x": 0.0, "y": REST_Y, "vx": 0.0, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [
                {"stepIndex": 12, "moveX": 0, "jump": "pressed"},
                *[{"stepIndex": n, "moveX": 0, "jump": "released" if n == 14 else "none"} for n in range(13, 22)],
                {"stepIndex": 22, "moveX": 0, "jump": "pressed"},
                *[{"stepIndex": n, "moveX": 0, "jump": "held"} for n in range(23, 30)],
            ],
            "untilStep": 60,
            "sample": [12, 14, 20, 22, 23, 24, 30, 40, 59],
            "expect": {
                "jumpStartCount": 1,
                "vyNeverExceedsJumpVelocity": True,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    wall = {"id": "wall", "x": 9.75, "y": 1.5, "hw": 0.25, "hh": 1.5}   # face at x = 9.5

    # 9. wall stop
    traces.append(
        {
            "traceId": "wall-stop",
            "title": "Wall: 4 m/s run stops at face - (radius + skin); intent keeps running, no wall jump",
            "port": {"kind": "scripted-analytic", "statics": [dict(wall)]},
            "start": {"stepIndex": 12, "x": 8.0, "y": REST_Y, "vx": RUN, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [{"stepIndex": n, "moveX": 1, "jump": "none"} for n in range(12, 80)],
            "untilStep": 80,
            "sample": [12, 20, 30, 40, 44, 45, 46, 47, 48, 60, 79],
            "expect": {
                "wallFaceX": 9.5,
                "expectedStopCenterX": 9.5 - HALF_X,
                "stopBandM": 0.05,
                "maxPenetrationM": 0.005,
                "wallJump": False,
                "vxIntentAfterContact": RUN,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 10. head bump
    ceiling = {"id": "ceiling", "x": 0.0, "y": 3.83, "hw": 6.0, "hh": 0.25}   # underside y = 3.58
    platform = {"id": "platform", "x": 0.0, "y": 0.85, "hw": 2.0, "hh": 0.15}  # top y = 1.0
    traces.append(
        {
            "traceId": "head-bump",
            "title": "Head: jump from a 1.0 m platform under a 3.58 m ceiling; upward velocity clamped at contact",
            "port": {"kind": "scripted-analytic", "statics": [dict(ceiling), dict(platform)], "includeFloor": False},
            "start": {"stepIndex": 12, "x": 0.0, "y": 1.0 + HALF_Y, "vx": 0.0, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [
                {"stepIndex": 12, "moveX": 0, "jump": "pressed"},
                *[{"stepIndex": n, "moveX": 0, "jump": "held"} for n in range(13, 40)],
            ],
            "untilStep": 60,
            "sample": [12, 13, 14, 15, 16, 30, 40, 45, 50, 59],
            "expect": {
                "ceilingUndersideY": 3.58,
                "maxCenterY": 3.58 - HALF_Y,
                "headContactClampsVyToZero": True,
                "maxRisePerStepAfterContactM": 0.0005,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    ledge = {"id": "ledge", "x": 16.0, "y": 0.2, "hw": 4.0, "hh": 0.2}   # top 0.4, face x = 12
    floor_to_ledge = {"id": "floor", "x": 0.0, "y": -0.25, "hw": 112.0, "hh": 0.25}  # top 0, x in [-112, 112]
    traces.append(
        {
            "traceId": "ledge-block-and-jump-on",
            "title": "Ledge: 0.4 m step blocks walking (no autostep); a running jump lands on the ledge top",
            "port": {"kind": "scripted-analytic", "statics": [dict(ledge)], "includeFloor": False,
                     "staticsOverride": [dict(floor_to_ledge), dict(ledge)]},
            "start": {"stepIndex": 12, "x": 10.0, "y": REST_Y, "vx": RUN, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [
                *[{"stepIndex": n, "moveX": 1, "jump": "none"} for n in range(12, 70)],
                {"stepIndex": 70, "moveX": 1, "jump": "pressed"},
                *[{"stepIndex": n, "moveX": 1, "jump": "held"} for n in range(71, 210)],
            ],
            "untilStep": 210,
            "sample": [12, 40, 61, 62, 63, 64, 69, 70, 71, 80, 110, 140, 160, 170, 180, 190, 200, 209],
            "expect": {
                "ledgeTopY": 0.4,
                "expectedLandedCenterY": 0.4 + HALF_Y,
                "blockedMaxDxPerStepM": 0.02,
                "blockedFaceCenterX": 12.0 - HALF_X,
                "jumpStartStep": 70,
                "autostep": False,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 11. high speed
    traces.append(
        {
            "traceId": "high-speed-wall-approach",
            "title": "12 m/s approach: the sweep stops the character with no tunnelling",
            "port": {"kind": "scripted-analytic", "statics": [dict(wall)]},
            "start": {"stepIndex": 12, "x": 0.0, "y": REST_Y, "vx": 12.0, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True, "runSpeedOverride": 12.0},
            "frames": [{"stepIndex": n, "moveX": 1, "jump": "none"} for n in range(12, 110)],
            "untilStep": 110,
            "sample": [12, 13, 80, 85, 90, 91, 92, 93, 100, 109],
            "expect": {
                "runSpeedOverrideMps": 12.0,
                "expectedStopCenterX": 9.5 - HALF_X,
                "maxPenetrationM": 0.005,
                "contactWithinSteps": 10,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 12. no Z drift (flat run + jump, sampled with the untouched transform)
    traces.append(
        {
            "traceId": "no-z-drift",
            "title": "2.5D: X/Y move while position.z, rotation and scale stay bit-identical",
            "port": {"kind": "scripted-analytic", "statics": []},
            "start": {"stepIndex": 12, "x": 0.0, "y": REST_Y, "vx": 0.0, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True,
                      "authoredTransform": {"position": [0.0, REST_Y, 0.35], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1]}},
            "frames": [
                *[{"stepIndex": n, "moveX": 1, "jump": "none"} for n in range(12, 20)],
                {"stepIndex": 20, "moveX": 1, "jump": "pressed"},
                *[{"stepIndex": n, "moveX": 1, "jump": "held"} for n in range(21, 60)],
            ],
            "untilStep": 60,
            "sample": [12, 20, 21, 30, 40, 50, 59],
            "expect": {
                "untouchedTransform": ["position.z", "rotation", "scale"],
                "authoredZ": 0.35,
                "authoredRotation": [0, 0, 0, 1],
                "authoredScale": [1, 1, 1],
            },
        }
    )


    # 13. seam: two floor boxes with a 2 cm gap; the capsule crosses without ungrounding
    floor_a = {"id": "floorA", "x": -100.01, "y": -0.25, "hw": 100.0, "hh": 0.25}   # right edge x = -0.01
    floor_b = {"id": "floorB", "x": 100.01, "y": -0.25, "hw": 100.0, "hh": 0.25}    # left edge x = 0.01
    traces.append(
        {
            "traceId": "seam-cross",
            "title": "Seam: crossing a 2 cm floor gap keeps the character grounded (0 ungrounded steps; contract allows <= 2)",
            "port": {"kind": "scripted-analytic", "statics": [dict(floor_a), dict(floor_b)], "includeFloor": False},
            "start": {"stepIndex": 12, "x": -1.0, "y": REST_Y, "vx": RUN, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [{"stepIndex": n, "moveX": 1, "jump": "none"} for n in range(12, 72)],
            "untilStep": 72,
            "sample": [12, 30, 40, 41, 42, 43, 44, 45, 50, 71],
            "expect": {
                "seamX": 0.0,
                "seamHalfWidthM": 0.01,
                "maxUngroundedStepsAllowed": 2,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 14. snap within distance: a 0.06 m step down is absorbed by the 0.1 m ground snap
    upper = {"id": "upper", "x": -100.0, "y": -0.25, "hw": 100.0, "hh": 0.25}      # top y = 0, right edge x = 0
    lower = {"id": "lower", "x": 100.0, "y": -0.31, "hw": 100.0, "hh": 0.25}       # top y = -0.06, left edge x = 0
    traces.append(
        {
            "traceId": "snap-within-distance",
            "title": "Snap: a 0.06 m step down (< 0.1 m snap) is absorbed while walking; the character never goes airborne",
            "port": {"kind": "scripted-analytic", "statics": [dict(upper), dict(lower)], "includeFloor": False},
            "start": {"stepIndex": 12, "x": -1.0, "y": REST_Y, "vx": RUN, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [{"stepIndex": n, "moveX": 1, "jump": "none"} for n in range(12, 72)],
            "untilStep": 72,
            "sample": [12, 30, 38, 39, 40, 41, 42, 43, 44, 50, 71],
            "expect": {
                "stepDownM": 0.06,
                "snapDistanceM": SNAP,
                "expectedCenterY": -0.06 + HALF_Y,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # 15. snap beyond distance: a 0.15 m step down exceeds the snap and the character falls
    lower_far = {"id": "lowerFar", "x": 100.0, "y": -0.4, "hw": 100.0, "hh": 0.25}   # top y = -0.15
    traces.append(
        {
            "traceId": "snap-beyond-distance",
            "title": "Snap limit: a 0.15 m step down (> 0.1 m snap) makes the character fall and land on the lower floor",
            "port": {"kind": "scripted-analytic", "statics": [dict(upper), dict(lower_far)], "includeFloor": False},
            "start": {"stepIndex": 12, "x": -1.0, "y": REST_Y, "vx": RUN, "vy": 0.0, "airborne": False, "coyote": COYOTE, "buffer": 0, "grounded": True},
            "frames": [{"stepIndex": n, "moveX": 1, "jump": "none"} for n in range(12, 72)],
            "untilStep": 72,
            "sample": [12, 30, 38, 39, 40, 41, 42, 43, 44, 45, 46, 50, 71],
            "expect": {
                "stepDownM": 0.15,
                "snapDistanceM": SNAP,
                "expectedLandedCenterY": -0.15 + HALF_Y,
                "untouchedTransform": ["position.z", "rotation", "scale"],
            },
        }
    )

    # compute samples and derived expectations
    out_traces = []
    for trace in traces:
        run = dict(trace)
        run_speed = trace["start"].get("runSpeedOverride")
        # the reference model uses a single RUN constant; a per-trace override is
        # applied by temporarily rebinding the module-level constant.
        saved = RUN
        if run_speed is not None:
            RUN = run_speed
        if "staticsOverride" in trace["port"]:
            run["port"] = dict(trace["port"])
            run["port"]["statics"] = trace["port"]["staticsOverride"]
            del run["port"]["staticsOverride"]
        st, steps = run_trace(run)
        RUN = saved
        by_index = sample(steps, trace["sample"])
        rows = []
        for i in trace["sample"]:
            s = by_index[i]
            rows.append(
                {
                    "stepIndex": i,
                    "frame": s["frame"],
                    "position": {"x": s["x"], "y": s["y"], "z": trace["start"].get("authoredTransform", {}).get("position", [0, 0, 0])[2]},
                    "velocity": {"x": s["vx"], "y": s["vy"]},
                    "grounded": s["grounded"],
                    "airborne": s["airborne"],
                    "coyote": s["coyote"],
                    "buffer": s["buffer"],
                    "contacts": s["contacts"],
                    "snapped": s["snapped"],
                    "rotation": trace["start"].get("authoredTransform", {}).get("rotation", [0, 0, 0, 1]),
                    "scale": trace["start"].get("authoredTransform", {}).get("scale", [1, 1, 1]),
                }
            )
        derived = dict(trace["expect"])
        if trace["traceId"] == "jump-hold-full-height":
            apex = max(steps, key=lambda s: s["y"])
            derived["apexStep"] = apex["stepIndex"]
            derived["apexCenterY"] = apex["y"]
            derived["apexGainM"] = apex["y"] - REST_Y
            landed = next(s for s in steps if s["stepIndex"] > 12 and s["grounded"] and s["vy"] <= 0)
            derived["landedStep"] = landed["stepIndex"]
            derived["landedCenterY"] = landed["y"]
        if trace["traceId"] == "jump-tap-release":
            apex = max(steps, key=lambda s: s["y"])
            derived["apexStep"] = apex["stepIndex"]
            derived["apexGainM"] = apex["y"] - REST_Y
        if trace["traceId"] == "no-air-jump":
            # count jump starts: a step where vy jumps by more than gravity alone
            starts = 0
            prev_air = trace["start"]["airborne"]
            for s in steps:
                if s["airborne"] and not prev_air:
                    starts += 1
                prev_air = s["airborne"]
            derived["jumpStartCount"] = starts
            derived["maxVy"] = max(s["vy"] for s in steps)
            derived["maxVy"] = max(s["vy"] for s in steps)
        if trace["traceId"] == "wall-stop":
            contact = next((s for s in steps if s["contacts"]["wall"]), None)
            derived["contactStep"] = contact["stepIndex"] if contact else None
            derived["finalCenterX"] = steps[-1]["x"]
            derived["maxCenterX"] = max(s["x"] for s in steps)
        if trace["traceId"] == "head-bump":
            derived["maxCenterY"] = max(s["y"] for s in steps)
            contact = next((s for s in steps if s["contacts"]["head"]), None)
            derived["contactStep"] = contact["stepIndex"] if contact else None
            derived["maxVyAfterContact"] = max(
                (s["vy"] for s in steps if contact and s["stepIndex"] > contact["stepIndex"]), default=0.0
            )
            derived["maxAbsRisePerStepAfterContact"] = max(
                (
                    steps[i + 1]["y"] - steps[i]["y"]
                    for i in range(len(steps) - 1)
                    if contact and steps[i]["stepIndex"] >= contact["stepIndex"]
                ),
                default=0.0,
            )
        if trace["traceId"] == "ledge-block-and-jump-on":
            blocked = [s for s in steps if s["contacts"]["wall"]]
            derived["blockedStepCount"] = len(blocked)
            derived["blockedFirstStep"] = blocked[0]["stepIndex"] if blocked else None
            derived["blockedCenterX"] = blocked[-1]["x"] if blocked else None
            landed = next((s for s in steps if s["stepIndex"] >= 70 and s["grounded"] and s["y"] > 1.0), None)
            derived["landedStep"] = landed["stepIndex"] if landed else None
            derived["landedCenterY"] = landed["y"] if landed else None
            derived["maxDxWhileBlocked"] = max(
                (blocked[i + 1]["x"] - blocked[i]["x"] for i in range(len(blocked) - 1)), default=0.0
            )
        if trace["traceId"] == "high-speed-wall-approach":
            contact = next((s for s in steps if s["contacts"]["wall"]), None)
            derived["contactStep"] = contact["stepIndex"] if contact else None
            derived["maxCenterX"] = max(s["x"] for s in steps)
        if trace["traceId"] == "seam-cross":
            ungrounded = [s for s in steps if not s["grounded"]]
            derived["ungroundedSteps"] = len(ungrounded)
            derived["groundedEveryStep"] = len(ungrounded) == 0
            derived["maxDxPerStep"] = max(
                (steps[i + 1]["x"] - steps[i]["x"] for i in range(len(steps) - 1)), default=0.0
            )
            derived["maxYDeviation"] = max(abs(s["y"] - REST_Y) for s in steps)
        if trace["traceId"] == "snap-within-distance":
            ungrounded = [s for s in steps if not s["grounded"]]
            derived["ungroundedSteps"] = len(ungrounded)
            derived["snapAbsorbedStepDown"] = len(ungrounded) == 0
            derived["minCenterY"] = min(s["y"] for s in steps)
            derived["finalCenterY"] = steps[-1]["y"]
        if trace["traceId"] == "snap-beyond-distance":
            ungrounded = [s for s in steps if not s["grounded"]]
            derived["ungroundedSteps"] = len(ungrounded)
            derived["snapAbsorbedStepDown"] = len(ungrounded) == 0
            derived["firstUngroundedStep"] = ungrounded[0]["stepIndex"] if ungrounded else None
            landed = next((s for s in steps if s["stepIndex"] > 45 and s["grounded"] and s["y"] < 0.8), None)
            derived["landedStep"] = landed["stepIndex"] if landed else None
            derived["landedCenterY"] = landed["y"] if landed else None
            derived["minCenterY"] = min(s["y"] for s in steps)
        if trace["traceId"] == "flat-accel-decel":
            vx_at = {s["stepIndex"]: s["vx"] for s in steps}
            derived["vxAtStep23"] = vx_at[23]
            derived["vxAtStep29"] = vx_at[29]
            derived["vxAtStep37"] = vx_at[37]
            derived["vxAtStep38"] = vx_at[38]
        if trace["traceId"] in ("jump-buffer-lands-in-window", "jump-buffer-expired"):
            landed = next((s for s in steps if s["stepIndex"] > 12 and s["grounded"]), None)
            derived["landingStep"] = landed["stepIndex"] if landed else None
            starts = [
                s["stepIndex"]
                for i, s in enumerate(steps)
                if s["airborne"] and not (steps[i - 1]["airborne"] if i else trace["start"]["airborne"])
            ]
            derived["jumpStartedStep"] = starts[0] if starts else None
        if trace["traceId"] in ("jump-coyote-last-step", "jump-coyote-one-step-late"):
            starts = [
                s["stepIndex"]
                for i, s in enumerate(steps)
                if s["airborne"] and not (steps[i - 1]["airborne"] if i else trace["start"]["airborne"])
            ]
            derived["jumpStartedStep"] = starts[0] if starts else None
        run["sample"] = rows
        run["expect"] = derived
        run["replayToleranceM"] = REPLAY_TOL
        out_traces.append(run)

    return {
        "kind": "platformer-traces",
        "setVersion": 1,
        "id": "platformer-traces",
        "model": "scripted-analytic-port + platformer.md 7 controller (independent python3 reference)",
        "pins": [
            {"file": "docs/planning/m2-contracts/platformer.md", "section": "## 7. The step algorithm (normative, exact order)"},
            {"file": "docs/planning/m2-contracts/platformer.md", "section": "### 7.1 Windows (integer steps) and edges"},
            {"file": "docs/planning/m2-contracts/physics.md", "section": "## 2. 2.5D convention (normative)"},
            {"file": "docs/planning/m2-contracts/input.md", "section": "## 2. `ActionFrame` (strict shape)"},
        ],
        "constants": {
            "dt": DT, "gravityY": G, "runSpeed": RUN, "jumpVelocity": JUMP_V, "maxFallSpeed": MAX_FALL,
            "moveAccel": ACCEL, "moveDecel": DECEL, "coyoteSteps": COYOTE, "jumpBufferSteps": BUFFER,
            "jumpReleaseFactor": RELEASE, "capsuleHalfWidthWithSkin": HALF_X, "capsuleHalfHeightWithSkin": HALF_Y,
            "groundSnap": SNAP, "restCenterY": REST_Y,
        },
        "traces": out_traces,
    }


# ---------------------------------------------------------------------------
# scheduler reference (runtime.md 5, platformer.md 6)
# ---------------------------------------------------------------------------

MAX_CATCHUP = 8
SIM_HZ = 120


def scheduler_run(start_step_index, start_sim_time, frames, pre_roll_steps):
    """frames: [{"frameId","elapsed"}]; returns per-frame observations."""
    step_index = start_step_index
    sim_time = start_sim_time
    anchor = {"wallAtFrame": 0.0, "simTimeAtAnchor": sim_time}
    dropped = 0
    clock_warnings = 0
    wall = 0.0
    observations = []
    pre_roll = pre_roll_steps
    sampled = []
    executed = []
    for f in frames:
        wall += f["elapsed"]
        if pre_roll > 0:
            n = pre_roll
            pre_roll = 0
            executed.extend(range(step_index, step_index + n))
            step_index += n
            sim_time = step_index / SIM_HZ
            anchor = {"wallAtFrame": wall, "simTimeAtAnchor": sim_time}
            observations.append({"frameId": f["frameId"], "stepsExecuted": n, "droppedSteps": 0,
                                 "simTimeAfter": sim_time, "preRoll": True, "actionSamples": []})
            continue
        elapsed = wall - anchor["wallAtFrame"]
        if elapsed < 0:
            clock_warnings += 1
            elapsed = 0.0
        target = anchor["simTimeAtAnchor"] + elapsed
        raw = math.floor((target - sim_time) / DT)
        if raw < 0:
            raw = 0
        n = min(raw, MAX_CATCHUP)
        executed.extend(range(step_index, step_index + n))
        sampled.extend(range(step_index, step_index + n))
        step_index += n
        drop_now = 0
        if raw > MAX_CATCHUP:
            drop_now = raw - MAX_CATCHUP
            dropped += drop_now
        sim_time = step_index / SIM_HZ
        if drop_now > 0:
            anchor = {"wallAtFrame": wall, "simTimeAtAnchor": sim_time}
        observations.append({
            "frameId": f["frameId"], "stepsExecuted": n, "droppedSteps": drop_now,
            "simTimeAfter": sim_time, "preRoll": False,
            "actionSamples": list(range(step_index - n, step_index)),
        })
    return {
        "observations": observations,
        "stepIndexEnd": step_index,
        "simTimeEnd": sim_time,
        "droppedSteps": dropped,
        "clockWarningCount": clock_warnings,
        "sampledStepIndices": sampled,
        "executedStepIndices": executed,
    }


def catchup_fixture():
    cases = []

    def case(case_id, title, start_step, start_sim, frames, pre_roll=0, extra=None):
        run = scheduler_run(start_step, start_sim, frames, pre_roll)
        doc = {
            "caseId": case_id,
            "title": title,
            "startStepIndex": start_step,
            "startSimTime": start_sim,
            "preRollSteps": pre_roll,
            "frames": frames,
            "expect": {
                "observations": run["observations"],
                "stepIndexEnd": run["stepIndexEnd"],
                "droppedSteps": run["droppedSteps"],
                "clockWarningCount": run["clockWarningCount"],
                "sampledStepIndices": run["sampledStepIndices"],
                "noPhantomSteps": True,
                "eachExecutedStepSampledOnce": len(run["sampledStepIndices"]) == len(set(run["sampledStepIndices"])),
            },
        }
        if extra:
            doc["expect"].update(extra)
        cases.append(doc)

    case(
        "C1-pre-roll-first-frame",
        "The first frame after start executes 12 neutral pre-roll steps, samples no input and installs the anchor",
        0, 0.0,
        [{"frameId": "F1", "elapsed": 0.0167}, {"frameId": "F2", "elapsed": 0.0167}],
        pre_roll=SETTLE_STEPS,
    )
    case(
        "C2-normal-60hz",
        "A ~60 Hz cadence (0.0167 s frames) executes two fixed steps per frame with no drops",
        12, 0.1,
        [{"frameId": f"F{i}", "elapsed": 0.0167} for i in range(1, 5)],
    )
    case(
        "C3-stall-drop-and-resync",
        "A 1.0 s stall executes the 8-step cap, drops the remainder and resyncs the anchor",
        12, 0.1,
        [{"frameId": "F1", "elapsed": 1.0}, {"frameId": "F2", "elapsed": 0.0167}],
    )
    case(
        "C4-no-step-frame",
        "A sub-step frame executes no step at all; the following frame catches the interval up",
        12, 0.1,
        [{"frameId": "F1", "elapsed": 0.001}, {"frameId": "F2", "elapsed": 0.0167}],
    )
    case(
        "C5-negative-clock",
        "A non-monotonic clock yields zero steps and one clock warning per negative observation, never a negative step count",
        12, 0.1,
        [{"frameId": "F1", "elapsed": -0.5}, {"frameId": "F2", "elapsed": 0.0167}],
    )
    case(
        "C6-jump-edge-not-replayed",
        "A pressed edge at step 12 delivered inside an 8-step catch-up frame is sampled exactly once",
        12, 0.1,
        [{"frameId": "F1", "elapsed": 0.0668}],
        extra={
            "recordedFrames": [{"stepIndex": 12, "moveX": 0, "jump": "pressed"}],
            "pressedCount": 1,
            "pressedAtStepIndex": 12,
        },
    )
    case(
        "C7-drop-does-not-replay-edges",
        "After a dropped interval the next frame resumes at the next contiguous index and samples no dropped index",
        12, 0.1,
        [{"frameId": "F1", "elapsed": 0.5}, {"frameId": "F2", "elapsed": 0.0167}],
        extra={"droppedWindowOmittedFromSamples": True},
    )
    return {
        "kind": "runtime-catchup",
        "setVersion": 1,
        "id": "runtime-catchup",
        "scheduler": {"fixedStepHz": SIM_HZ, "dt": DT, "maxCatchupSteps": MAX_CATCHUP,
                      "settlePreRollSteps": SETTLE_STEPS, "simTimeIsStepIndexOverHz": True},
        "pins": [
            {"file": "docs/planning/m2-contracts/platformer.md", "section": "### 2.1 Fixed-step ordering (normative, replacing nothing in M1's per-step math)"},
            {"file": "docs/planning/m2-contracts/platformer.md", "section": "## 6. Step indexing, settle pre-roll and initialization"},
            {"file": "docs/planning/m2-contracts/platformer.md", "section": "## 9. Fail-stop lifecycle (M2 module sets)"},
            {"file": "docs/planning/m2-contracts/input.md", "section": "### 3.2 Press latch — exactly one edge per executed step"},
            {"file": "docs/planning/m2-contracts/diffs/runtime.md", "section": "### R7 — §5 \"Fixed steps with bounded catch-up\""},
        ],
        "cases": cases,
        "phaseOrder": ["sample", "intent", "controller", "physics", "transform", "render"],
        "ownershipCases": [
            {"caseId": "O1-single-owner", "modules": ["thirdlight.platformer:controller"], "owners": {"thirdlight.platformer:controller": ["char-0001"]}, "outcome": "ok"},
            {"caseId": "O2-duplicate-writer", "modules": ["thirdlight.demo:box-motion", "thirdlight.platformer:controller"], "owners": {"thirdlight.demo:box-motion": ["char-0001"], "thirdlight.platformer:controller": ["char-0001"]}, "code": "transform_owner_conflict", "reason": "char-0001"},
            {"caseId": "O3-missing-entity", "modules": ["thirdlight.platformer:controller"], "owners": {"thirdlight.platformer:controller": ["char-9999"]}, "code": "transform_owner_conflict", "reason": "char-9999"},
            {"caseId": "O4-camera-claim", "modules": ["thirdlight.demo:box-motion"], "owners": {"thirdlight.demo:box-motion": ["camera-0001"]}, "code": "transform_owner_forbidden", "reason": "camera"},
            {"caseId": "O5-physics-entity-claim-by-demo", "modules": ["thirdlight.demo:box-motion"], "owners": {"thirdlight.demo:box-motion": ["char-0001"]}, "code": "transform_owner_forbidden", "reason": "physics_entity"},
            {"caseId": "O6-module-combination", "modules": ["thirdlight.demo:box-motion", "thirdlight.platformer:controller"], "code": "module_combination_unsupported"},
            {"caseId": "O7-controller-count", "modules": ["thirdlight.platformer:controller"], "scene": {"controllerCount": 2}, "code": "config_invalid", "reason": "controller_target"},
            {"caseId": "O8-m2-module-on-v1-scene", "modules": ["thirdlight.platformer:controller"], "scene": {"schemaVersion": 1}, "code": "config_invalid", "reason": "scene_version"},
        ],
    }


def input_fixture():
    mapping = [
        {"caseId": "M1-digital-left", "stepIndex": 12, "prevDown": False, "verified": True,
         "raw": {"keyboardLeft": True, "keyboardRight": False, "stickX": 0.0, "jumpDown": False}, "expectJump": "none", "expectMoveX": -1.0},
        {"caseId": "M2-digital-right", "stepIndex": 12, "prevDown": False, "verified": True,
         "raw": {"keyboardLeft": False, "keyboardRight": True, "stickX": 0.0, "jumpDown": False}, "expectJump": "none", "expectMoveX": 1.0},
        {"caseId": "M3-both-keys-cancel", "stepIndex": 12, "prevDown": False, "verified": True,
         "raw": {"keyboardLeft": True, "keyboardRight": True, "stickX": 0.8, "jumpDown": False}, "expectJump": "none", "expectMoveX": 0.0},
        {"caseId": "M4-stick-inside-dead-zone", "stepIndex": 12, "prevDown": False, "verified": True,
         "raw": {"keyboardLeft": False, "keyboardRight": False, "stickX": 0.2, "jumpDown": False}, "expectJump": "none", "expectMoveX": 0.0},
        {"caseId": "M5-stick-rescaled", "stepIndex": 12, "prevDown": False, "verified": True,
         "raw": {"keyboardLeft": False, "keyboardRight": False, "stickX": 0.6, "jumpDown": False}, "expectJump": "none", "expectMoveX": 0.5},
        {"caseId": "M6-stick-full", "stepIndex": 12, "prevDown": False, "verified": True,
         "raw": {"keyboardLeft": False, "keyboardRight": False, "stickX": 1.0, "jumpDown": False}, "expectJump": "none", "expectMoveX": 1.0},
        {"caseId": "M7-keyboard-beats-stick", "stepIndex": 12, "prevDown": False, "verified": True,
         "raw": {"keyboardLeft": True, "keyboardRight": False, "stickX": -1.0, "jumpDown": False}, "expectJump": "none", "expectMoveX": -1.0},
        {"caseId": "M8-dpad-opposes-stick", "stepIndex": 12, "prevDown": False, "verified": True,
         "raw": {"keyboardLeft": False, "keyboardRight": False, "dpad": -1, "stickX": 0.9, "jumpDown": False}, "expectJump": "none", "expectMoveX": -1.0},
        {"caseId": "M9-jump-pressed", "stepIndex": 12, "prevDown": False, "verified": True,
         "raw": {"stickX": 0.0, "jumpDown": True}, "expectJump": "pressed", "expectMoveX": 0.0},
        {"caseId": "M10-jump-held", "stepIndex": 13, "prevDown": True, "verified": True,
         "raw": {"stickX": 0.0, "jumpDown": True}, "expectJump": "held", "expectMoveX": 0.0},
        {"caseId": "M11-jump-released", "stepIndex": 14, "prevDown": True, "verified": True,
         "raw": {"stickX": 0.0, "jumpDown": False}, "expectJump": "released", "expectMoveX": 0.0},
        {"caseId": "M12-jump-latch-tap", "stepIndex": 14, "prevDown": False, "verified": True,
         "raw": {"stickX": 0.0, "jumpDown": False, "jumpLatch": True}, "expectJump": "pressed", "expectMoveX": 0.0},
        {"caseId": "M13-awaiting-release-held-not-pressed", "stepIndex": 15, "prevDown": False, "verified": False,
         "raw": {"stickX": 0.0, "jumpDown": True}, "expectJump": "held", "expectMoveX": 0.0, "expectVerified": False},
        {"caseId": "M14-awaiting-release-clears-on-up", "stepIndex": 16, "prevDown": True, "verified": False,
         "raw": {"stickX": 0.0, "jumpDown": False}, "expectJump": "none", "expectMoveX": 0.0, "expectVerified": True},
        {"caseId": "M15-fresh-press-after-release", "stepIndex": 17, "prevDown": False, "verified": True,
         "raw": {"stickX": 0.0, "jumpDown": True}, "expectJump": "pressed", "expectMoveX": 0.0},
    ]
    for case in mapping:
        frame, nxt = map_raw(case["raw"], case["stepIndex"], case["prevDown"], case["verified"])
        case["expectFrame"] = frame
        case["expectNext"] = nxt
        case.pop("expectJump", None)
        case.pop("expectMoveX", None)
        case.pop("expectVerified", None)

    def replay(events, sample_steps, start_down=False, start_verified=True, suspend_before_step=None):
        down = start_down
        verified = start_verified
        frames = []
        pressed = 0
        for step in sample_steps:
            held = False
            latch = False
            for ev in events:
                if ev["atStep"] > step:
                    continue
                if ev["atStep"] <= step and ev.get("appliedAtSample", ev["atStep"]) == step:
                    pass
            # events before the sample define the raw state
            prior = [e for e in events if e["atStep"] <= step]
            if prior:
                last = prior[-1]
                held = last["kind"] == "down"
            raw_latch = any(e["kind"] == "down" for e in events if step - 1 < e["atStep"] <= step)
            if suspend_before_step is not None and step == suspend_before_step:
                down = False
                verified = False
            frame, state = map_raw({"stickX": 0.0, "jumpDown": held, "jumpLatch": raw_latch}, step, down, verified)
            down, verified = state["down"], state["verified"]
            if frame["jump"] == "pressed":
                pressed += 1
            frames.append(frame)
        return frames, pressed

    seq_cases = [
        {"caseId": "Q1-tap-between-steps", "title": "a tap that begins and ends between two samples produces exactly one pressed",
         "events": [{"atStep": 13.2, "kind": "down"}, {"atStep": 13.8, "kind": "up"}], "sampleSteps": [12, 13, 14, 15], "expectPressedCount": 1},
        {"caseId": "Q2-hold-and-release", "title": "a held button is pressed once, then held, then released once",
         "events": [{"atStep": 12.0, "kind": "down"}, {"atStep": 16.0, "kind": "up"}], "sampleSteps": [12, 13, 14, 15, 16, 17], "expectPressedCount": 1},
        {"caseId": "Q3-double-tap-coalesced", "title": "two taps inside one fixed step coalesce into one pressed frame (single latch)",
         "events": [{"atStep": 13.1, "kind": "down"}, {"atStep": 13.2, "kind": "up"}, {"atStep": 13.3, "kind": "down"}, {"atStep": 13.4, "kind": "up"}], "sampleSteps": [12, 13, 14], "expectPressedCount": 1},
        {"caseId": "Q4-focus-loss-resume", "title": "after a suspension a still-held jump yields held (never pressed) until it is released",
         "events": [{"atStep": 12.0, "kind": "down"}, {"atStep": 15.0, "kind": "up"}, {"atStep": 16.0, "kind": "down"}], "sampleSteps": [12, 13, 14, 15, 16, 17], "expectPressedCount": 2, "suspendBeforeStep": 13},
        {"caseId": "Q5-hidden-tab-resume", "title": "a hidden tab suspends and clears the latch; the pre-hidden tap is never replayed",
         "events": [{"atStep": 12.5, "kind": "down"}, {"atStep": 13.0, "kind": "up"}], "sampleSteps": [12, 13, 14, 15], "expectPressedCount": 0, "suspendBeforeStep": 13},
    ]
    for case in seq_cases:
        frames, pressed = replay(case["events"], case["sampleSteps"], suspend_before_step=case.get("suspendBeforeStep"))
        case["expectFrames"] = frames
        case["expectPressedCountActual"] = pressed
        case["expectPressedCountMatches"] = pressed == case["expectPressedCount"]
    return {
        "kind": "input-action-sequences",
        "setVersion": 1,
        "id": "input-action-sequences",
        "constants": {"deadZone": DEAD_ZONE, "moveQuantum": QUANT, "neutralFrame": {"stepIndex": None, "moveX": 0.0, "jump": "none"},
                      "jumpPhases": ["none", "pressed", "held", "released"], "settlePreRollSteps": SETTLE_STEPS},
        "pins": [
            {"file": "docs/planning/m2-contracts/input.md", "section": "## 2. `ActionFrame` (strict shape)"},
            {"file": "docs/planning/m2-contracts/input.md", "section": "### 3.2 Press latch — exactly one edge per executed step"},
            {"file": "docs/planning/m2-contracts/input.md", "section": "### 4.2 Gamepad dead zone and rescaling"},
            {"file": "docs/planning/m2-contracts/input.md", "section": "### 4.3 Simultaneous-source arbitration (deterministic, no summation)"},
            {"file": "docs/planning/m2-contracts/input.md", "section": "### 5.3 Suspension: focus loss, hidden tab, page hide"},
            {"file": "docs/planning/m2-contracts/input.md", "section": "### 5.4 Hot disconnect"},
        ],
        "mappingCases": mapping,
        "sequenceCases": seq_cases,
        "invalidFrames": [
            {"caseId": "I1-duplicate-step-index", "frames": [{"stepIndex": 12, "moveX": 0, "jump": "none"}, {"stepIndex": 12, "moveX": 1, "jump": "none"}], "code": "input_frame_invalid", "field": "stepIndex"},
            {"caseId": "I2-decreasing-step-index", "frames": [{"stepIndex": 13, "moveX": 0, "jump": "none"}, {"stepIndex": 12, "moveX": 1, "jump": "none"}], "code": "input_frame_invalid", "field": "stepIndex"},
            {"caseId": "I3-movex-out-of-range", "frames": [{"stepIndex": 12, "moveX": 1.5, "jump": "none"}], "code": "input_frame_invalid", "field": "moveX"},
            {"caseId": "I4-movex-not-quantized", "frames": [{"stepIndex": 12, "moveX": 0.123456, "jump": "none"}], "code": "input_frame_invalid", "field": "moveX"},
            {"caseId": "I5-jump-unknown", "frames": [{"stepIndex": 12, "moveX": 0, "jump": "down"}], "code": "input_frame_invalid", "field": "jump"},
            {"caseId": "I6-step-index-not-integer", "frames": [{"stepIndex": 12.5, "moveX": 0, "jump": "none"}], "code": "input_frame_invalid", "field": "stepIndex"},
            {"caseId": "I7-unknown-field", "frames": [{"stepIndex": 12, "moveX": 0, "jump": "none", "device": "pad"}], "code": "input_frame_invalid", "field": "device"},
            {"caseId": "I8-broken-phase-chain", "frames": [{"stepIndex": 12, "moveX": 0, "jump": "held"}], "code": "input_frame_invalid", "field": "jump"},
        ],
        "tolerances": {
            "sameBuildSameEngine": "exact (bit-identical)",
            "sameBuildRepeatedSessionM": 1e-06,
            "sameSourcesDifferentEngineM": 0.001,
            "crossPlatformBitExact": False,
        },
    }


def failures_fixture():
    return {
        "kind": "platformer-failure-set",
        "setVersion": 1,
        "id": "platformer-failures",
        "pins": [
            {"file": "docs/planning/m2-contracts/platformer.md", "section": "## 9. Fail-stop lifecycle (M2 module sets)"},
            {"file": "docs/planning/m2-contracts/platformer.md", "section": "### 2.2 Write guard and phase violations (normative)"},
            {"file": "docs/planning/m2-contracts/platformer.md", "section": "### 2.3 Unsupported module combinations"},
            {"file": "docs/planning/m2-contracts/physics.md", "section": "## 4. Physics-bearing entities (`components.collider`, `components.controller`)"},
            {"file": "docs/planning/m2-contracts/physics.md", "section": "## 6. Adapter lifecycle: init, cancellation, parentless collider, disposal"},
            {"file": "docs/planning/m2-contracts/physics.md", "section": "## 10. Observable failure outcomes"},
            {"file": "docs/planning/m2-contracts/input.md", "section": "## 7. Observable failure outcomes"},
        ],
        "cases": [
            {"caseId": "F01-focus-loss", "title": "focus loss clears held state, emits a neutral frame and requires fresh activation",
             "trigger": "window blur during gameplay", "codes": [], "diagnostics": ["input_suspend"],
             "runtimeState": "running", "durableEffect": "none; the next step receives moveX 0 / jump none and a later press is a real pressed edge",
             "pins": [{"file": "docs/planning/m2-contracts/input.md", "section": "### 5.3 Suspension: focus loss, hidden tab, page hide"}]},
            {"caseId": "F02-hot-disconnect", "title": "active gamepad disconnect clears its contribution and never emits a phantom pressed",
             "trigger": "gamepaddisconnected while the primary button is down", "codes": [], "diagnostics": ["input_disconnect"],
             "runtimeState": "running", "durableEffect": "none; a takeover pad must observe an up before any pressed",
             "pins": [{"file": "docs/planning/m2-contracts/input.md", "section": "### 5.4 Hot disconnect"}]},
            {"caseId": "F03-hidden-tab", "title": "hidden tab + resume: dropped wall time executes no phantom step and replays no edge",
             "trigger": "visibilitychange hidden for 5 s, then visible",
             "codes": [], "diagnostics": ["input_suspend", "input_activate"],
             "runtimeState": "running", "maxStepsAfterResume": 8, "droppedStepsGreaterThan": 0,
             "durableEffect": "none; stepIndex stays contiguous and every executed step is sampled exactly once",
             "pins": [{"file": "docs/planning/m2-contracts/input.md", "section": "### 5.3 Suspension: focus loss, hidden tab, page hide"},
                      {"file": "docs/planning/m2-contracts/platformer.md", "section": "## 6. Step indexing, settle pre-roll and initialization"}]},
            {"caseId": "F04-parented-collider", "title": "a collider inside a parent group is a validation error, not flattened geometry",
             "trigger": "snapshot with components.collider on a non-root entity", "code": "physics_transform_unsupported", "reason": "parented",
             "innerCodes": ["snapshot_invalid"], "runtimeState": "not instantiated",
             "durableEffect": "none; the snapshot is rejected before any world or module instance exists",
             "pins": [{"file": "docs/planning/m2-contracts/physics.md", "section": "## 4. Physics-bearing entities (`components.collider`, `components.controller`)"}]},
            {"caseId": "F05-non-unit-scale", "title": "a scaled collider is rejected instead of being silently scaled",
             "trigger": "snapshot with transform.scale [2,1,1] on a collider entity", "code": "physics_transform_unsupported", "reason": "scale",
             "innerCodes": ["snapshot_invalid"], "runtimeState": "not instantiated", "durableEffect": "none",
             "pins": [{"file": "docs/planning/m2-contracts/physics.md", "section": "## 4. Physics-bearing entities (`components.collider`, `components.controller`)"}]},
            {"caseId": "F06-tilted-character", "title": "a rotated controller entity is rejected (the capsule is never tilted)",
             "trigger": "snapshot with a non-identity quaternion on the controller entity", "code": "physics_transform_unsupported", "reason": "upright",
             "innerCodes": ["snapshot_invalid"], "runtimeState": "not instantiated", "durableEffect": "none",
             "pins": [{"file": "docs/planning/m2-contracts/physics.md", "section": "## 4. Physics-bearing entities (`components.collider`, `components.controller`)"}]},
            {"caseId": "F07-duplicate-transform-writer", "title": "two modules claiming one entity transform are rejected at instantiate",
             "trigger": "modules demo:box-motion + platformer:controller with overlapping owners", "code": "transform_owner_conflict", "reason": "char-0001",
             "runtimeState": "not instantiated", "durableEffect": "none; no port is stepped and no module create() side effect is retained (modules are created only after validation)",
             "pins": [{"file": "docs/planning/m2-contracts/platformer.md", "section": "## 5. Authoritative transform policy"}]},
            {"caseId": "F08-unsupported-module-combination", "title": "the M1 box-motion demo and the M2 controller cannot be selected together",
             "trigger": "modules [demo:box-motion, platformer:controller]", "code": "module_combination_unsupported",
             "runtimeState": "not instantiated", "durableEffect": "none",
             "pins": [{"file": "docs/planning/m2-contracts/platformer.md", "section": "### 2.3 Unsupported module combinations"}]},
            {"caseId": "F09-module-throw-after-physics-mutation", "title": "a module throw after the physics phase fail-stops the simulation; private state is not rolled back",
             "trigger": "transform-phase module throws after port.step() succeeded at stepIndex 480",
             "code": "module_error", "reason": "module_threw", "phase": "transform",
             "runtimeState": "failed", "stepIndexUnchanged": 480,
             "durableEffect": "none; the last completed step's render state stays readable (alpha 0), start/tick reject with runtime_failed, only dispose+fresh instantiate recovers",
             "innerCodes": ["runtime_failed"],
             "pins": [{"file": "docs/planning/m2-contracts/platformer.md", "section": "## 9. Fail-stop lifecycle (M2 module sets)"}]},
            {"caseId": "F10-init-cancelled", "title": "a cancelled physics initialization releases everything and a later init succeeds",
             "trigger": "AbortSignal aborted during createPhysicsPort", "code": "physics_init_cancelled",
             "runtimeState": "not instantiated", "durableEffect": "none; no PhysicsPort object escapes and a subsequent createPhysicsPort succeeds",
             "pins": [{"file": "docs/planning/m2-contracts/physics.md", "section": "## 6. Adapter lifecycle: init, cancellation, parentless collider, disposal"}]},
            {"caseId": "F11-init-failed", "title": "a WASM/init failure reports an actionable unavailable state with no fallback",
             "trigger": "createPhysicsPort rejects (WASM/CSP failure)", "code": "physics_init_failed",
             "runtimeState": "not instantiated", "durableEffect": "none; play does not silently switch engines or fall back to transform-only motion",
             "pins": [{"file": "docs/planning/m2-contracts/physics.md", "section": "## 6. Adapter lifecycle: init, cancellation, parentless collider, disposal"}]},
            {"caseId": "F12-repeated-jump-edges-during-catch-up", "title": "an 8-step catch-up frame consumes a pressed edge exactly once",
             "trigger": "one frame executes 8 steps with a recorded pressed edge at the first of them",
             "diagnostics": [], "assertion": "runtime/catchup.json C6: pressedCount 1, one sample per executed index",
             "runtimeState": "running",
             "pressedCountExpected": 1, "durableEffect": "none; the same frame index is never sampled twice",
             "innerCodes": [],
             "pins": [{"file": "docs/planning/m2-contracts/input.md", "section": "### 3.2 Press latch — exactly one edge per executed step"},
                      {"file": "docs/planning/m2-contracts/platformer.md", "section": "### 2.1 Fixed-step ordering (normative, replacing nothing in M1's per-step math)"}]},
            {"caseId": "F13-phantom-steps-after-drop", "title": "dropped wall time produces no phantom physics or input steps",
             "trigger": "1.0 s stall",
             "diagnostics": [], "assertion": "runtime/catchup.json C3/C7: 8 steps executed, 112/52 dropped, contiguous indices",
             "runtimeState": "running", "maxStepsInFrame": 8, "droppedStepsGreaterThan": 0,
             "durableEffect": "none; stepIndex advances only for executed steps and the union of executed indices has no gaps",
             "pins": [{"file": "docs/planning/m2-contracts/diffs/runtime.md", "section": "### R7 — §5 \"Fixed steps with bounded catch-up\""}]},
            {"caseId": "F14-camera-claimed-by-module", "title": "a module claiming the camera entity is rejected",
             "trigger": "transformOwners includes the camera entity", "code": "transform_owner_forbidden", "reason": "camera",
             "runtimeState": "not instantiated", "durableEffect": "none",
             "pins": [{"file": "docs/planning/m2-contracts/platformer.md", "section": "## 8. Fixed static camera convention"}]},
            {"caseId": "F15-purpose-violation", "title": "writing curr outside the transform phase fail-stops instead of mutating a half-applied step",
             "trigger": "controller-phase module writes state.curr", "code": "module_error", "reason": "phase_violation", "phase": "controller",
             "runtimeState": "failed", "stepIndexUnchanged": True,
             "durableEffect": "none; prev/curr remain the last completed step values",
             "innerCodes": ["runtime_failed"],
             "pins": [{"file": "docs/planning/m2-contracts/platformer.md", "section": "### 2.2 Write guard and phase violations (normative)"}]},
            {"caseId": "F16-malformed-port-result", "title": "a malformed CharacterMoveResult fail-stops before anything is committed",
             "trigger": "port.step() returns grounded true with a zero support normal", "code": "physics_port_error", "reason": "result",
             "runtimeState": "failed", "durableEffect": "none; the invalid result is never applied",
             "pins": [{"file": "docs/planning/m2-contracts/physics.md", "section": "## 5. The injected port"}]},
            {"caseId": "F17-duplicate-staged-move", "title": "two staged moves for one character in one step are rejected",
             "trigger": "stageCharacterMove called twice for the same entity in one controller phase", "code": "module_error", "reason": "duplicate_move", "phase": "controller",
             "runtimeState": "failed", "durableEffect": "none",
             "pins": [{"file": "docs/planning/m2-contracts/physics.md", "section": "## 5. The injected port"}]},
            {"caseId": "F18-m2-module-on-v1-snapshot", "title": "an M2 module cannot run against a schemaVersion 1 snapshot",
             "trigger": "modules [platformer:controller] with a v1 scene", "code": "config_invalid", "reason": "scene_version",
             "runtimeState": "not instantiated", "durableEffect": "none",
             "pins": [{"file": "docs/planning/m2-contracts/platformer.md", "section": "### 2.3 Unsupported module combinations"}]},
            {"caseId": "F19-controller-target-count", "title": "an M2 controller module requires exactly one controller entity",
             "trigger": "scene with zero or two components.controller entities", "codes": ["config_invalid", "controller_count_invalid"],
             "runtimeState": "not instantiated", "durableEffect": "none",
             "pins": [{"file": "docs/planning/m2-contracts/physics.md", "section": "## 4. Physics-bearing entities (`components.collider`, `components.controller`)"}]},
            {"caseId": "F20-missing-physics-port", "title": "the controller module cannot be instantiated without an injected port",
             "trigger": "modules [platformer:controller] with no physics config", "code": "config_invalid", "reason": "physics_port",
             "runtimeState": "not instantiated", "durableEffect": "none",
             "pins": [{"file": "docs/planning/m2-contracts/physics.md", "section": "## 5. The injected port"}]},
            {"caseId": "F21-input-source-throws", "title": "a throwing action source fail-stops and is not retried",
             "trigger": "actions.sample() throws", "code": "module_error", "reason": "input_source_threw",
             "runtimeState": "failed", "stepIndexUnchanged": True, "durableEffect": "none",
             "pins": [{"file": "docs/planning/m2-contracts/input.md", "section": "## 7. Observable failure outcomes"}]},
        ],
        "stateMachine": {
            "healthy": ["instantiated", "running", "stopped"],
            "failedFrom": ["running", "stopped"],
            "failedTo": ["disposed"],
            "rollbackAttempted": False,
            "recovery": "dispose + fresh instantiateRuntime with fresh module instances and a fresh port",
        },
    }


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    out_root = os.path.abspath(os.path.join(root, "..", "..", "..", "..", "fixtures", "m2", "contracts"))
    numerics = numerics_fixture()
    traces = traces_fixture()
    apex = next(t for t in traces["traces"] if t["traceId"] == "jump-hold-full-height")["expect"]["apexGainM"]
    numerics["derived"]["jumpApexGainDiscrete"] = apex
    numerics["derived"]["jumpApexGainDiscreteNote"] = (
        "contract-order discrete model, gain from the settled rest center 0.910 m; the packet-14 probe "
        "reported 1.2297 from the nominal 0.900 m center over a settled start of 0.9099987 m (same trajectory)"
    )

    writes = {
        os.path.join(out_root, "physics", "numerics.json"): numerics,
        os.path.join(out_root, "platformer", "traces.json"): traces,
        os.path.join(out_root, "platformer", "failures.json"): failures_fixture(),
        os.path.join(out_root, "input", "action-sequences.json"): input_fixture(),
        os.path.join(out_root, "runtime", "catchup.json"): catchup_fixture(),
    }
    if "--write" in sys.argv:
        for path, doc in writes.items():
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, indent=2)
                fh.write("\n")
            print(f"wrote {os.path.relpath(path, out_root)}")
    else:
        def norm(v):
            if isinstance(v, float) and v.is_integer():
                return int(v)
            if isinstance(v, dict):
                return {k: norm(x) for k, x in v.items()}
            if isinstance(v, list):
                return [norm(x) for x in v]
            return v

        for path, doc in writes.items():
            with open(path, encoding="utf-8") as fh:
                on_disk = json.load(fh)
            same = json.dumps(norm(on_disk), sort_keys=True) == json.dumps(norm(doc), sort_keys=True)
            print(f"{'OK  ' if same else 'DIFF'} {os.path.relpath(path, out_root)}")
            if not same:
                sys.exit(1)


if __name__ == "__main__":
    main()
