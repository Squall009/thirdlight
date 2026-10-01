/**
 * The Assets tab's import flow: a file dropped or picked (uploaded, or a file
 * of the game folder imported where it is), its inspection, the role mapping
 * a reimport may need, and the one `publishAsset` that commits it. Uploaded
 * bytes are filed into the folder the tab names (`uploadFolder`, default
 * `assets`).
 */
import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import { makeAssetId, type SessionClient } from '../session/client';
import { importFailed, initialImportState, publishArgsFromProposal, utcSecondTimestamp, type AssetImportState, type ImportTarget } from '../session/asset-browser';
import { type SourceIssue } from '../session/asset-sources';
import { validateMediaDrop, type AnimationRoleKey } from '../session/media';
import { DEFAULT_UPLOAD_FOLDER } from '../session/folder-upload';

type MediaKind = 'model' | 'audio' | 'texture' | 'font';

/** The Assets panel's import settings for new files (editor preferences, not project data). */
export interface ImportSettings {
  /** How a PNG/JPEG texture is imported: as is, or encoded to KTX2. */
  textureEncoding: 'none' | 'color' | 'normal' | 'data';
  setTextureEncoding: (v: 'none' | 'color' | 'normal' | 'data') => void;
  /** Whether a new model's images become texture assets. */
  extractTextures: boolean;
  setExtractTextures: (v: boolean) => void;
}

export interface AssetImportDeps {
  clientRef: MutableRefObject<SessionClient | null>;
  pendingProposalRef: MutableRefObject<{ proposal: Parameters<typeof publishArgsFromProposal>[0]; target: ImportTarget } | null>;
  mediaPendingRef: MutableRefObject<{ kind: MediaKind; clipNames: string[] | null; referencingEntityIds: string[] } | null>;
  importStateRef: MutableRefObject<AssetImportState>;
  selectedAssetIdRef: MutableRefObject<string | null>;
  setImportState: Dispatch<SetStateAction<AssetImportState>>;
  setSelectedAssetId: (id: string | null) => void;
  reimportRoles: Record<AnimationRoleKey, string>;
  setReimportRoles: Dispatch<SetStateAction<Record<AnimationRoleKey, string>>>;
  reimportEntity: string;
  setReimportEntity: Dispatch<SetStateAction<string>>;
  refreshEntities: () => void;
  checkFiles: () => Promise<unknown>;
  showAssets: () => void;
}

export function useAssetImport(deps: AssetImportDeps) {
  const { clientRef, pendingProposalRef, mediaPendingRef, importStateRef, selectedAssetIdRef, setImportState, setSelectedAssetId, reimportRoles, setReimportRoles, reimportEntity, setReimportEntity, refreshEntities, checkFiles, showAssets } = deps;
  // Where uploaded files go in the game folder (an editor preference, not project data).
  const [uploadFolder, setUploadFolder] = useState(DEFAULT_UPLOAD_FOLDER);
  const uploadFolderRef = useRef(uploadFolder);
  uploadFolderRef.current = uploadFolder;

  /** After an inspect: remember the proposal and the role-mapping obligation.
   * Returns whether the publish needs no role mapping. */
  const acceptProposal = useCallback((proposal: Parameters<typeof publishArgsFromProposal>[0], target: ImportTarget, kind: 'model' | 'audio' | 'texture' | 'font'): boolean => {
    const c = clientRef.current;
    if (!c) return false;
    pendingProposalRef.current = { proposal, target };
    const inspection = (proposal.proposal as { inspection?: { clipNames?: unknown } } | null)?.inspection;
    const clipNames = Array.isArray(inspection?.clipNames) ? (inspection.clipNames as unknown[]).filter((x): x is string => typeof x === 'string') : null;
    // A model reimport whose asset is referenced by modelAnimation
    // components MUST carry the atomic `animation` — the panel collects the
    // new version's role bindings before the publish is enabled.
    const referencingEntityIds =
      kind === 'model' && target.mode === 'reimport'
        ? c.projection.listEntities().filter((e) => e.modelAnimation !== undefined && e.modelAnimation.assetId === target.assetId).map((e) => e.id)
        : [];
    mediaPendingRef.current = { kind, clipNames, referencingEntityIds };
    if (target.mode === 'reimport') {
      setReimportRoles({ idle: '', run: '', airborne: '' });
      setReimportEntity(referencingEntityIds[0] ?? '');
    }
    setSelectedAssetId(target.assetId);
    return referencingEntityIds.length === 0;
  }, [clientRef, mediaPendingRef, pendingProposalRef, setReimportEntity, setReimportRoles, setSelectedAssetId]);

  // How PNG/JPEG textures are imported (as is, or encoded to KTX2); an editor preference, not project data.
  const [textureEncoding, setTextureEncoding] = useState<'none' | 'color' | 'normal' | 'data'>('none');
  const textureEncodingRef = useRef(textureEncoding);
  textureEncodingRef.current = textureEncoding;
  // Whether a new model's images become texture assets (the model import setting "extract textures"; Godot's default).
  const [extractTextures, setExtractTextures] = useState(true);
  const extractTexturesRef = useRef(extractTextures);
  extractTexturesRef.current = extractTextures;
  /** A re-import from the asset's inspector carries the setting chosen there (else a re-import keeps the model's own). */
  const reimportExtractRef = useRef<boolean | null>(null);

  const importFile = useCallback(async (file: File, mode: 'create' | 'reimport') => {
    const c = clientRef.current;
    if (!c) return;
    // The extension decides the kind (`.glb` model / `.wav`
    // audio); an invalid drop creates no stage and no job.
    const candidate = validateMediaDrop(file.name, file.size);
    if (!candidate.ok) {
      setImportState(importFailed(initialImportState, candidate.error));
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const target: ImportTarget =
      mode === 'reimport'
        ? { mode: 'reimport', assetId: selectedAssetIdRef.current, displayName: null }
        : { mode: 'create', assetId: makeAssetId(), displayName: candidate.displayName };
    // A PNG/JPEG texture encoded to KTX2 when the Assets panel says so (a KTX2 or WebP is imported as is).
    const ktx2 = candidate.kind === 'texture' && textureEncodingRef.current !== 'none' && /\.(png|jpe?g)$/i.test(file.name) ? textureEncodingRef.current : undefined;
    const res = await c.uploadAsset(bytes, { target, displayName: candidate.displayName, kind: candidate.kind, ...(ktx2 !== undefined ? { ktx2 } : {}), onState: setImportState });
    if (res.ok) {
      acceptProposal(res.proposal, target, candidate.kind);
    } else {
      pendingProposalRef.current = null;
      mediaPendingRef.current = null;
    }
  }, [acceptProposal, clientRef, mediaPendingRef, pendingProposalRef, selectedAssetIdRef, setImportState]);

  /** Import from the project folder: the file is inspected in place, never copied.
   * Returns whether the proposal can be published without a role mapping. */
  const importFromFolder = useCallback(async (path: string, mode: 'create' | 'reimport', assetId: string | null): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const candidate = validateMediaDrop(path.slice(path.lastIndexOf('/') + 1), 1);
    if (!candidate.ok) {
      setImportState(importFailed(initialImportState, candidate.error));
      return false;
    }
    const target: ImportTarget =
      mode === 'reimport' ? { mode: 'reimport', assetId, displayName: null } : { mode: 'create', assetId: makeAssetId(), displayName: candidate.displayName };
    const ktx2 = candidate.kind === 'texture' && textureEncodingRef.current !== 'none' && /\.(png|jpe?g)$/i.test(path) ? textureEncodingRef.current : undefined;
    const res = await c.importProjectFile(path, {
      target,
      kind: candidate.kind,
      ...(ktx2 !== undefined ? { ktx2 } : {}),
      displayName: candidate.displayName,
      onState: (st) => {
        importStateRef.current = st;
        setImportState(st);
      },
    });
    if (!res.ok) {
      pendingProposalRef.current = null;
      mediaPendingRef.current = null;
      return false;
    }
    return acceptProposal(res.proposal, target, candidate.kind);
  }, [acceptProposal, clientRef, importStateRef, mediaPendingRef, pendingProposalRef, setImportState]);

  /** The `animation` args for the pending reimport, or
   * `null` (a create / an audio reimport / a model reimport with no referencing
   * entities). `complete` reports whether the role draft is ready (all three
   * bindings named) — the publish is disabled until it is. */
  const animatedReimportArgs = useCallback((): { animation: { entityId: string; roles: unknown } | null; complete: boolean } => {
    const pending = pendingProposalRef.current;
    const media = mediaPendingRef.current;
    if (pending === null || media === null) return { animation: null, complete: true };
    if (pending.target.mode !== 'reimport' || media.kind !== 'model' || media.referencingEntityIds.length === 0) return { animation: null, complete: true };
    const clipNames = media.clipNames ?? [];
    const roles = {} as Record<string, { clipIndex: number; clipName: string } >;
    for (const k of ['idle', 'run', 'airborne'] as AnimationRoleKey[]) {
      const name = reimportRoles[k].trim();
      const idx = clipNames.indexOf(name);
      roles[k] = { clipIndex: idx >= 0 ? idx : 0, clipName: name };
    }
    const complete = (['idle', 'run', 'airborne'] as AnimationRoleKey[]).every((k) => reimportRoles[k].trim() !== '') && reimportEntity !== '' && media.referencingEntityIds.includes(reimportEntity);
    return { animation: complete ? { entityId: reimportEntity, roles } : null, complete };
  }, [reimportRoles, reimportEntity, mediaPendingRef, pendingProposalRef]);

  const publish = useCallback(async () => {
    const c = clientRef.current;
    const pending = pendingProposalRef.current;
    const media = mediaPendingRef.current;
    if (!c || !pending || !media) return;
    const animated = animatedReimportArgs();
    if (!animated.complete) return; // the panel keeps the publish disabled
    const made = publishArgsFromProposal(pending.proposal, pending.target, utcSecondTimestamp(), media.kind, animated.animation ?? undefined);
    const extract = media.kind !== 'model' ? null : pending.target.mode === 'create' ? extractTexturesRef.current : reimportExtractRef.current;
    reimportExtractRef.current = null;
    const args = made.ok && extract !== null ? { ok: true as const, args: { ...made.args, extractTextures: extract } } : made;
    if (!args.ok) {
      setImportState(importFailed(importStateRef.current, args.error));
      return;
    }
    let s = c.markPublishing(importStateRef.current);
    setImportState(s);
    // Exactly one publishAsset command; the catalog advances only through the
    // applied `mutation.applied` change (never a local write). A rejected
    // reimport (stale job, limits, role range/mismatch) preserves the old
    // version AND the old animation component (the command is all-or-nothing).
    // Uploaded bytes of a new asset go into the folder the tab names (a file of the game folder stays where it is).
    const uploaded = args.args.sourcePath === undefined && (args.args.convertedFrom as { sourcePath?: string } | undefined)?.sourcePath === undefined;
    const res = await c.command('publishAsset', uploaded && args.args.mode === 'create' ? { ...args.args, folder: uploadFolderRef.current } : args.args, c.projection.revision);
    if (res.ok) {
      s = c.markCommitted(s);
      setImportState(s);
      pendingProposalRef.current = null;
      mediaPendingRef.current = null;
      await c.fullResync();
      refreshEntities();
      if (args.args.sourcePath !== undefined || args.args.convertedFrom !== undefined) void checkFiles();
    } else {
      const response = res.response;
      setImportState(importFailed(s, response.ok === false ? { code: response.code, message: response.message ?? response.code } : { code: 'network', message: 'the command response was lost' }));
    }
  }, [refreshEntities, animatedReimportArgs, checkFiles, clientRef, importStateRef, mediaPendingRef, pendingProposalRef, setImportState]);

  /** Problems → Re-import: a new version from the same file, published at once
   * unless the asset's animation needs a role mapping (then the Assets tab asks). */
  const reimportIssue = useCallback(
    async (issue: SourceIssue) => {
      const ready = await importFromFolder(issue.sourcePath, 'reimport', issue.assetId);
      if (ready) await publish();
      else showAssets();
    },
    [importFromFolder, publish, showAssets],
  );

  /**
   * A model's inspector: import its file again with "extract textures" on or
   * off (Unity's Apply, Godot's Reimport after changing an import setting).
   */
  const reimportWithExtract = useCallback(
    async (assetId: string, path: string, extract: boolean) => {
      reimportExtractRef.current = extract;
      const ready = await importFromFolder(path, 'reimport', assetId);
      if (ready) await publish();
      else showAssets();
    },
    [importFromFolder, publish, showAssets],
  );

  const cancelImportFlow = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const s = c.cancelImport(importStateRef.current);
    setImportState(s);
    pendingProposalRef.current = null;
    mediaPendingRef.current = null;
    if (s.stageId) {
      try {
        await c.discardStage(s.stageId);
      } catch {
        /* the stage TTL bounds an abandoned stage */
      }
    }
  }, [clientRef, importStateRef, mediaPendingRef, pendingProposalRef, setImportState]);

  const discardImportFlow = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const stageId = importStateRef.current.stageId;
    setImportState(c.resetImport(importStateRef.current));
    pendingProposalRef.current = null;
    mediaPendingRef.current = null;
    if (stageId) {
      try {
        await c.discardStage(stageId);
      } catch {
        /* already discarded / expired */
      }
    }
  }, [clientRef, importStateRef, mediaPendingRef, pendingProposalRef, setImportState]);

  const importSettings: ImportSettings = { textureEncoding, setTextureEncoding, extractTextures, setExtractTextures };
  return { acceptProposal, importSettings, textureEncoding, reimportWithExtract, uploadFolder, setUploadFolder, importFile, importFromFolder, animatedReimportArgs, publish, reimportIssue, cancelImportFlow, discardImportFlow };
}
