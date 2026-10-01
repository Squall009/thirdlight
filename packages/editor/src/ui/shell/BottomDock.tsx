/**
 * The bottom dock: the project window (AssetsTab.tsx), the Console and
 * Problems, wired to the editor's state and commands. Every other kind of
 * item is found, made and opened in the project window.
 */
import type { JSX, Dispatch } from 'react';
import type { ClientUiState } from '../../session/client';
import type { WorkspaceAction } from '../../session/editor-window';
import { ProblemsPanel } from '../ProblemsPanel';
import { ConsolePanel } from '../ConsolePanel';
import type { SourceIssue } from '../../session/asset-sources';
import { useAssetFileCheck } from '../useAssetFileCheck';
import type { ClientRef } from './commands';
import type { DocumentState } from '../workspace/useDocumentState';
import type { DocumentCommands } from '../workspace/useDocumentCommands';
import type { Scripting } from './useScripting';
import type { PlaySession } from './usePlaySession';
import type { EditorProblems } from './useEditorProblems';
import { BOTTOM_TABS, type BottomTab } from './dock-tabs';
import { AssetsTab, type AssetsTabProps } from './AssetsTab';

export interface BottomDockProps {
  tab: BottomTab;
  onTab: (tab: BottomTab) => void;
  height: number;
  clientRef: ClientRef;
  docState: DocumentState;
  docCmds: DocumentCommands;
  scripting: Scripting;
  play: PlaySession;
  problems: EditorProblems;
  /** The client's problem log (the Problems tab). */
  problemLog: ClientUiState['problems'];
  viewFailures: { id: string; name: string; code: string; message: string }[];
  fileCheck: ReturnType<typeof useAssetFileCheck>;
  reimportIssue: (issue: SourceIssue) => Promise<void>;
  assetsTab: AssetsTabProps;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  openDocument: (kind: string, id: string) => void;
}

export function BottomDock(props: BottomDockProps): JSX.Element {
  const { tab: bottomTab, onTab: setBottomTab, height, clientRef, problemLog, viewFailures, fileCheck, reimportIssue, workspaceDispatch, openDocument } = props;
  const { setMaterialFocus, setVisualFocus } = props.docState;
  const { showGraph } = props.docCmds;
  const { openSource } = props.scripting;
  const { playInfo, playing } = props.play;
  const { graphIssues, scriptIssues, materialIssues } = props.problems;
  return (
    <div className="tl-dock tl-dock--bottom" style={{ height: height }}>
      <div className="tl-tabs" role="tablist">
        {BOTTOM_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={bottomTab === t.id} className={`tl-tab${bottomTab === t.id ? ' is-active' : ''}`} onClick={() => setBottomTab(t.id)}>
            {t.label}
            {t.id === 'problems' && problemLog.length + fileCheck.count + viewFailures.length + graphIssues.length + scriptIssues.length + materialIssues.length > 0 ? <span className="tl-tab__count">{problemLog.length + fileCheck.count + viewFailures.length + graphIssues.length + scriptIssues.length + materialIssues.length}</span> : null}
          </button>
        ))}
      </div>
    {bottomTab === 'console' && (
      <ConsolePanel
        playSessionId={playing && playInfo !== null ? playInfo.playSessionId : null}
        fetchDiagnostics={async (psid) => clientRef.current?.playDiagnostics(psid) ?? { ok: false, message: 'not connected' }}
        onOpenSource={openSource}
      />
    )}
    {bottomTab === 'problems' && (
      <ProblemsPanel
        graphIssues={[...graphIssues, ...scriptIssues, ...materialIssues]}
        onGraphIssue={(i) => {
          if (i.materialId !== undefined) {
            // A graph material's problem opens its Material tab at the node.
            if (i.nodeId !== undefined) setMaterialFocus({ id: i.nodeId, nonce: Date.now(), materialId: i.materialId });
            openDocument('material', i.materialId);
          } else if (i.behaviorId !== undefined) {
            // A visual script's problem opens its Graph tab at the node (its function's tab inside a function).
            workspaceDispatch({ type: 'open', doc: { kind: 'visual-script', id: i.behaviorId } });
            if (i.nodeId !== undefined) setVisualFocus({ behaviorId: i.behaviorId, id: i.nodeId, nonce: Date.now() });
          } else showGraph(i.graphId, i.nodeId);
        }}
        problems={problemLog}
        viewFailures={viewFailures}
        fileCheck={fileCheck.checkable ? fileCheck : null}
        onReimport={(i) => void reimportIssue(i)}
      />
    )}
    {bottomTab === 'assets' && <AssetsTab {...props.assetsTab} />}
    </div>
  );
}
