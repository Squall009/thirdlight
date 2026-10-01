/**
 * The Media tab's listening: one audio preview owner per session (unlocked
 * by a gesture, disposed on teardown) that plays committed cues.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPreviewAudioOwner, type PreviewAudioOwner } from '../../session/preview-audio';
import type { ClientRef } from './commands';

export function useCuePreview(clientRef: ClientRef) {
  // The cue PREVIEW owner: one per session,
  // disposed on teardown; the panel renders its status + bounded diagnostics.
  const previewOwnerRef = useRef<PreviewAudioOwner | null>(null);
  if (previewOwnerRef.current === null) previewOwnerRef.current = createPreviewAudioOwner();
  // A state bump after each gesture/preview: the owner's status + diagnostics
  // are read fresh on the re-render it triggers (the value itself is ignored).
  const [, bumpPreview] = useState(0);
  useEffect(() => {
    return () => {
      void previewOwnerRef.current?.dispose();
    };
  }, []);

  const unlockPreview = useCallback(() => {
    void previewOwnerRef.current?.unlock().then(() => bumpPreview((n) => n + 1));
  }, [bumpPreview]);

  /** Register + preview one committed cue (bytes from the editor's content
   * read — the authoring token is that read's credential, never a resource). */
  const previewCue = useCallback(
    async (assetId: string) => {
      const c = clientRef.current;
      const owner = previewOwnerRef.current;
      if (!c || !owner) return;
      const version = c.content.currentVersion(assetId);
      if (version === null) return;
      try {
        const bytes = await c.assetByteResolver()({ assetId, version });
        owner.registerCue(assetId, bytes);
        owner.preview(assetId);
        bumpPreview((n) => n + 1);
      } catch {
        // A failed read is the ordinary network path; the panel stays usable.
      }
    },
    [clientRef],
  );

  return { previewOwnerRef, unlockPreview, previewCue };
}

export type CuePreview = ReturnType<typeof useCuePreview>;
