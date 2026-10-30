/**
 * Authored documents: graphs, effects, kits, UI documents and themes,
 * dialogue, timelines and shared script libraries. Each op's step and the
 * undo and redo of what it records.
 */

import type { OpFamily } from './op-table-types';
import type { EffectDef, GraphDocument, GraphOp, KitDef } from '@thirdlight/project-model';
import { contentOf } from './content-ops';
import { historyInvalid } from './errors';
import { applyDeleteGraph, applyGraphEdit, applySetGraph, editOwnerGraph, withGraphDocument } from './graph-ops';
import { applyDeleteEffect, applyRenameEffect, applySetEffect, effectsOf, withEffect } from './effect-ops';
import { applyDeleteKit, applySetKit, kitsOf, withKit } from './kit-ops';
import { applyDeleteUi, applySetUiDocument, applySetUiTheme, uiOf, withUi } from './ui-ops';
import { applyDeleteDialogueValue, applySetDialogue, applySetDialogueSettings, applySetSpeaker, dialogueValueOf, withDialogueValue } from './dialogue-ops';
import { applyDeleteTimeline, applySetTimeline, timelineOf, withTimeline } from './timeline-ops';
import { applyCommitScriptLibraryStage, applyDeleteScriptLibrary, applySetScriptLibrary, scriptLibrariesOf, withBehaviorRecords, withScriptLibrary } from './script-library-ops';
import { bumped, finish } from './history-steps';
import { deepClone } from './ops';
import type { ChangeData, SetDialogueArgs } from './types';

export const documentFamily = {
  ops: {
    setGraph: { apply: (input, args) => applySetGraph(input, args as { graph: GraphDocument }), records: [['setGraph', 'setGraph']] },
    deleteGraph: { apply: (input, args) => applyDeleteGraph(input, args), records: [['setGraph', 'setGraph']] },
    graphEdit: { apply: (input, args) => applyGraphEdit(input, args as { owner: { kind: string; id: string }; ops: GraphOp[] }), records: [['graphEdit', 'graphEdit'], ['setAnimator', 'setAnimator']] },
    setEffect: { apply: (input, args) => applySetEffect(input, args as { effect: EffectDef }), records: [['setEffect', 'setEffect']] },
    deleteEffect: { apply: (input, args) => applyDeleteEffect(input, args), records: [['setEffect', 'setEffect']] },
    renameEffect: { apply: (input, args) => applyRenameEffect(input, args), records: [['setEffect', 'setEffect']] },
    setKit: { apply: (input, args) => applySetKit(input, args as { kit: KitDef }), records: [['setKit', 'setKit']] },
    deleteKit: { apply: (input, args) => applyDeleteKit(input, args), records: [['setKit', 'setKit']] },
    setUiDocument: { apply: (input, args) => applySetUiDocument(input, args), records: [['setUi', 'setUi']] },
    deleteUiDocument: { apply: (input, args) => applyDeleteUi(input, 'document', String(args.uiDocumentId)), records: [['setUi', 'setUi']] },
    setUiTheme: { apply: (input, args) => applySetUiTheme(input, args), records: [['setUi', 'setUi']] },
    deleteUiTheme: { apply: (input, args) => applyDeleteUi(input, 'theme', String(args.uiThemeId)), records: [['setUi', 'setUi']] },
    setDialogue: { apply: (input, args) => applySetDialogue(input, args as unknown as SetDialogueArgs), records: [['setDialogue', 'setDialogue']] },
    deleteDialogue: { apply: (input, args) => applyDeleteDialogueValue(input, 'dialogue', String(args.dialogueId)), records: [['setDialogue', 'setDialogue']] },
    setSpeaker: { apply: (input, args) => applySetSpeaker(input, args), records: [['setDialogue', 'setDialogue']] },
    deleteSpeaker: { apply: (input, args) => applyDeleteDialogueValue(input, 'speaker', String(args.speakerId)), records: [['setDialogue', 'setDialogue']] },
    setDialogueSettings: { apply: (input, args) => applySetDialogueSettings(input, args), records: [['setDialogue', 'setDialogue']] },
    setTimeline: { apply: (input, args) => applySetTimeline(input, args), records: [['setTimeline', 'setTimeline']] },
    deleteTimeline: { apply: (input, args) => applyDeleteTimeline(input, String(args.timelineId)), records: [['setTimeline', 'setTimeline']] },
    // Shared script libraries (a change republishes the dependents from prepared facts).
    setScriptLibrary: { apply: (input, args) => applySetScriptLibrary(input, args), records: [['setScriptLibrary', 'setScriptLibrary']] },
    deleteScriptLibrary: { apply: (input, args) => applyDeleteScriptLibrary(input, args), records: [['setScriptLibrary', 'setScriptLibrary']] },
    // A staged set of library edits, one change (the dependents from facts prepared once).
    commitScriptLibraryStage: { apply: (input, args) => applyCommitScriptLibraryStage(input, args), records: [['setScriptLibraries', 'setScriptLibraries']] },
  },
  undo: {
    graphEdit: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const r = editOwnerGraph(content, inv.owner, inv.ops);
      if (!r.ok) return { ok: false, error: historyInvalid(entry.requestId) };
      const change: ChangeData = { type: 'graphEdit', owner: { ...inv.owner }, ops: deepClone(inv.ops) };
      return finish(state, bumped(scene), r.content, change, entry.requestId);
    },
    setGraph: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = ((content as { graphs?: GraphDocument[] }).graphs ?? []).find((g) => g.graphId === inv.graphId) ?? null;
      const change: ChangeData = { type: 'setGraph', graphId: inv.graphId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withGraphDocument(content, inv.graphId, inv.restore), change, entry.requestId);
    },
    setScriptLibrary: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // The library and the dependents recompiled with it move back together.
      const before = scriptLibrariesOf(content).find((l) => l.libraryId === inv.libraryId) ?? null;
      const behaviors = inv.behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(content.behaviors.find((x) => x.behaviorId === b.behaviorId) ?? b.restore), next: deepClone(b.restore) }));
      const change: ChangeData = { type: 'setScriptLibrary', libraryId: inv.libraryId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore), behaviors };
      return finish(state, bumped(scene), withBehaviorRecords(withScriptLibrary(content, inv.libraryId, inv.restore), inv.behaviors.map((b) => b.restore)), change, entry.requestId);
    },
    setScriptLibraries: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // Every library of a staged commit and the dependents recompiled with them move back together.
      let next = content;
      const libraries = inv.libraries.map((l) => {
        const before = scriptLibrariesOf(content).find((x) => x.libraryId === l.libraryId) ?? null;
        next = withScriptLibrary(next, l.libraryId, l.restore);
        return { libraryId: l.libraryId, previous: before === null ? null : deepClone(before), next: l.restore === null ? null : deepClone(l.restore) };
      });
      const behaviors = inv.behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(content.behaviors.find((x) => x.behaviorId === b.behaviorId) ?? b.restore), next: deepClone(b.restore) }));
      const change: ChangeData = { type: 'setScriptLibraries', libraries, behaviors };
      return finish(state, bumped(scene), withBehaviorRecords(next, inv.behaviors.map((b) => b.restore)), change, entry.requestId);
    },
    setTimeline: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // One timeline back to what it was.
      const before = timelineOf(content, inv.timelineId);
      const change: ChangeData = { type: 'setTimeline', timelineId: inv.timelineId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withTimeline(content, inv.timelineId, inv.restore), change, entry.requestId);
    },
    setUi: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // One UI document or theme back to what it was.
      const before = uiOf(content, inv.uiKind, inv.id);
      const change: ChangeData = { type: 'setUi', uiKind: inv.uiKind, id: inv.id, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withUi(content, inv.uiKind, inv.id, inv.restore), change, entry.requestId);
    },
    setDialogue: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // One conversation, speaker or the settings back to what it was.
      const before = dialogueValueOf(content, inv.dialogueKind, inv.id);
      const change: ChangeData = { type: 'setDialogue', dialogueKind: inv.dialogueKind, id: inv.id, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withDialogueValue(content, inv.dialogueKind, inv.id, inv.restore), change, entry.requestId);
    },
    setEffect: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = effectsOf(content).find((e) => e.effectId === inv.effectId) ?? null;
      const change: ChangeData = { type: 'setEffect', effectId: inv.effectId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withEffect(content, inv.effectId, inv.restore), change, entry.requestId);
    },
    setKit: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = kitsOf(content).find((k) => k.kitId === inv.kitId) ?? null;
      const change: ChangeData = { type: 'setKit', kitId: inv.kitId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withKit(content, inv.kitId, inv.restore), change, entry.requestId);
    },
  },
  redo: {
    graphEdit: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const r = editOwnerGraph(content, f.owner, f.ops);
      if (!r.ok) return { ok: false, error: historyInvalid(entry.requestId) };
      const change: ChangeData = { type: 'graphEdit', owner: { ...f.owner }, ops: deepClone(f.ops) };
      return finish(state, bumped(scene), r.content, change, entry.requestId);
    },
    setGraph: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = ((content as { graphs?: GraphDocument[] }).graphs ?? []).find((g) => g.graphId === f.graphId) ?? null;
      const change: ChangeData = { type: 'setGraph', graphId: f.graphId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withGraphDocument(content, f.graphId, f.next), change, entry.requestId);
    },
    setScriptLibrary: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = scriptLibrariesOf(content).find((l) => l.libraryId === f.libraryId) ?? null;
      const behaviors = f.behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(content.behaviors.find((x) => x.behaviorId === b.behaviorId) ?? b.previous), next: deepClone(b.next) }));
      const change: ChangeData = { type: 'setScriptLibrary', libraryId: f.libraryId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next), behaviors };
      return finish(state, bumped(scene), withBehaviorRecords(withScriptLibrary(content, f.libraryId, f.next), f.behaviors.map((b) => b.next)), change, entry.requestId);
    },
    setScriptLibraries: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      let next = content;
      const libraries = f.libraries.map((l) => {
        const before = scriptLibrariesOf(content).find((x) => x.libraryId === l.libraryId) ?? null;
        next = withScriptLibrary(next, l.libraryId, l.next);
        return { libraryId: l.libraryId, previous: before === null ? null : deepClone(before), next: l.next === null ? null : deepClone(l.next) };
      });
      const behaviors = f.behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(content.behaviors.find((x) => x.behaviorId === b.behaviorId) ?? b.previous), next: deepClone(b.next) }));
      const change: ChangeData = { type: 'setScriptLibraries', libraries, behaviors };
      return finish(state, bumped(scene), withBehaviorRecords(next, f.behaviors.map((b) => b.next)), change, entry.requestId);
    },
    setTimeline: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = timelineOf(content, f.timelineId);
      const change: ChangeData = { type: 'setTimeline', timelineId: f.timelineId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withTimeline(content, f.timelineId, f.next), change, entry.requestId);
    },
    setUi: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = uiOf(content, f.uiKind, f.id);
      const change: ChangeData = { type: 'setUi', uiKind: f.uiKind, id: f.id, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withUi(content, f.uiKind, f.id, f.next), change, entry.requestId);
    },
    setDialogue: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = dialogueValueOf(content, f.dialogueKind, f.id);
      const change: ChangeData = { type: 'setDialogue', dialogueKind: f.dialogueKind, id: f.id, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withDialogueValue(content, f.dialogueKind, f.id, f.next), change, entry.requestId);
    },
    setEffect: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = effectsOf(content).find((e) => e.effectId === f.effectId) ?? null;
      const change: ChangeData = { type: 'setEffect', effectId: f.effectId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withEffect(content, f.effectId, f.next), change, entry.requestId);
    },
    setKit: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = kitsOf(content).find((k) => k.kitId === f.kitId) ?? null;
      const change: ChangeData = { type: 'setKit', kitId: f.kitId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withKit(content, f.kitId, f.next), change, entry.requestId);
    },
  },
} satisfies OpFamily;
