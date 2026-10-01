/**
 * The Animator's wiring: saving and deleting controllers, a controller's
 * live preview, a model's clips, skeleton and node names, "clips for" a
 * rig and the bones a rig is missing.
 */
import * as THREE from 'three';
import { useCallback, useRef, useState } from 'react';
import { AnimatorMachine, type AnimatorControllerLike } from '@thirdlight/runtime';
import { createAnimatorPlayer } from '@thirdlight/three-adapter';
import type { AnimatorController } from '@thirdlight/project-model';
import type { AnimatorControllersProps, AnimatorPreview } from '../animator/parts';
import type { GraphOp } from '../../graph/model';
import { refusal, type ClientRef, type ModelsRef, type ReportFailure } from './commands';

export interface AnimatorToolsDeps {
  clientRef: ClientRef;
  modelInstancesRef: ModelsRef;
  reportFailure: ReportFailure;
  animators: AnimatorController[];
  openDocument: (kind: string, id: string) => void;
  sendGraphEdit: (owner: { kind: string; id: string }, ops: GraphOp[]) => Promise<string | null>;
}

export function useAnimatorTools(deps: AnimatorToolsDeps) {
  const { clientRef, modelInstancesRef, reportFailure, animators, openDocument, sendGraphEdit } = deps;
  const [animatorError, setAnimatorError] = useState<string | null>(null);
  // The Animator's live preview — the controller's model realized under the
  // preview pane's stage, posed every pane frame by the runtime's state machine.
  const previewAnimator = useCallback(async (controller: AnimatorController, parent: THREE.Object3D): Promise<AnimatorPreview | string> => {
    const c = clientRef.current;
    const m = modelInstancesRef.current;
    if (!c || !m) return 'the editor is not ready';
    // The model the clips are for: the first clip's asset, or the rig of an animation-only asset.
    const clipAssets = new Set<string>();
    for (const g of [controller, ...(controller.layers ?? [])]) {
      for (const x of g.states) {
        if (x.motion.kind === 'clip') clipAssets.add(x.motion.clip.assetId);
        else if (x.motion.kind === 'blend1d') for (const k of x.motion.children) clipAssets.add(k.clip.assetId);
      }
    }
    const first = [...clipAssets][0];
    if (first === undefined) return 'give a state a clip first';
    const assetId = c.content.getAsset(first)?.clipsFor ?? first;
    // Clips of animation-only assets marked "clips for" this model, loaded before the preview starts.
    const foreign = new Map<string, readonly THREE.AnimationClip[]>();
    for (const id of clipAssets) {
      if (id === assetId || c.content.getAsset(id)?.clipsFor !== assetId) continue;
      const r = await m.prepared(id);
      if (r !== null) foreign.set(id, r.animationClips());
    }
    const v = c.content.resolveVersion(assetId);
    if (!v || !/^[0-9a-f]{64}$/.test(v.sourceDigest)) return 'the model has no published version';
    const res = await m.previewAsset({ assetId, version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength }, parent);
    if (!res.ok) return res.message;
    const machine = new AnimatorMachine(controller as unknown as AnimatorControllerLike);
    const player = createAnimatorPlayer(res.session.root, res.session.animationClips, assetId, { clipsOf: (id) => foreign.get(id) ?? null });
    let elapsed = 0;
    let done = false;
    return {
      root: res.session.root,
      step: (dt) => {
        if (done) return;
        elapsed += dt;
        machine.step(dt);
        player.apply(machine.pose());
      },
      set: (name, value) => void machine.set(name, value),
      trigger: (name) => void machine.trigger(name),
      state: () => machine.stateName(),
      layerStates: () => Array.from({ length: machine.layerCount() }, (_, i) => machine.stateName(i)),
      // The preview plays at the speed a script would set (the same machine the game steps).
      setSpeed: (speed) => void machine.setSpeed(speed),
      elapsed: () => elapsed,
      clipTime: () => {
        const clips = machine.pose().clips;
        let best = clips[0];
        for (const c of clips) if (best === undefined || c.weight > best.weight) best = c;
        return best?.time ?? 0;
      },
      dispose: () => {
        if (done) return;
        done = true;
        player.dispose();
        // A later preview (the asset preview) already released this session when it replaced it.
        if (m.previewSession() === res.session) m.clearPreview();
      },
    };
  }, [clientRef, modelInstancesRef]);
  const saveAnimator = useCallback(async (controller: AnimatorController) => {
    const c = clientRef.current;
    if (!c) return;
    setAnimatorError(refusal(await c.command('setAnimator', { controller }, c.projection.revision)));
  }, [clientRef]);
  const deleteAnimator = useCallback(async (controllerId: string) => {
    const c = clientRef.current;
    if (!c) return;
    setAnimatorError(refusal(await c.command('deleteAnimator', { controllerId }, c.projection.revision)));
  }, [clientRef]);
  const clipsOf = useCallback(async (assetId: string) => {
    const r = await modelInstancesRef.current?.prepared(assetId);
    return (r?.clips ?? []).map((x) => ({ name: x.name, duration: x.durationSeconds }));
  }, [modelInstancesRef]);
  // A model's skeleton (the Animator's bone mask picker).
  // The node names of the models socket targets carry (the Inspector's node list), read once per version.
  const [modelNodeNames, setModelNodeNames] = useState<Readonly<Record<string, readonly string[] | 'failed'>>>({});
  const modelNodeLoads = useRef(new Set<string>());
  const modelNodesOf = useCallback(
    (assetId: string): readonly string[] | null | undefined => {
      const version = clientRef.current?.content.resolveVersion(assetId)?.version;
      if (version === undefined) return undefined;
      const key = `${assetId}@${version}`;
      const have = modelNodeNames[key];
      if (have === 'failed') return undefined;
      if (have !== undefined) return have;
      if (!modelNodeLoads.current.has(key)) {
        modelNodeLoads.current.add(key);
        void (modelInstancesRef.current?.nodeNames(assetId) ?? Promise.resolve(null)).then((names) => setModelNodeNames((m) => ({ ...m, [key]: names ?? 'failed' })));
      }
      return null;
    },
    [clientRef, modelInstancesRef, modelNodeNames],
  );
  const skeletonOf = useCallback(async (assetId: string) => {
    const r = await modelInstancesRef.current?.prepared(assetId);
    return r === null || r === undefined ? [] : r.skeleton().map((b) => ({ name: b.name, parent: b.parent, depth: b.depth }));
  }, [modelInstancesRef]);
  // Mark an animation-only file as clips for another model's rig (null clears it).
  const setAssetClipsFor = useCallback(async (assetId: string, rig: string | null) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Clips for rig', await c.command('setAssetOptions', { assetId, clipsFor: rig }, c.projection.revision));
  }, [clientRef, reportFailure]);
  /** The animated bones of `clipAssetId`'s clips that the rig `rigAssetId` does not have. */
  const missingBones = useCallback(async (clipAssetId: string, rigAssetId: string): Promise<string[] | null> => {
    const m = modelInstancesRef.current;
    if (!m) return null;
    const [clipsRes, rigRes] = await Promise.all([m.prepared(clipAssetId), m.prepared(rigAssetId)]);
    if (clipsRes === null || rigRes === null) return null;
    const have = new Set(rigRes.skeleton().map((b) => b.name));
    const wanted = new Set<string>();
    for (const clip of clipsRes.animationClips()) {
      for (const t of clip.tracks) {
        try {
          wanted.add(THREE.PropertyBinding.parseTrackName(t.name).nodeName);
        } catch {
          /* an unparsable track binds nothing */
        }
      }
    }
    return [...wanted].filter((n) => n !== '' && !have.has(n)).sort();
  }, [modelInstancesRef]);
  const animatorProps: AnimatorControllersProps = {
    controllers: animators,
    clipsOf,
    skeletonOf,
    onSave: (controller) => void saveAnimator(controller),
    onDelete: (id) => void deleteAnimator(id),
    onOpen: (id) => openDocument('animator', id),
    error: animatorError,
  };
  const animatorGraphEdit = (ownerId: string, ops: GraphOp[]): Promise<string | null> => sendGraphEdit({ kind: 'animator', id: ownerId }, ops);

  return { animatorError, previewAnimator, saveAnimator, deleteAnimator, clipsOf, modelNodesOf, skeletonOf, setAssetClipsFor, missingBones, animatorProps, animatorGraphEdit };
}

export type AnimatorTools = ReturnType<typeof useAnimatorTools>;
