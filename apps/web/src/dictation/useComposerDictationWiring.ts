import type {
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { closeSkillTokenAtCursor, replaceSpokenSkills } from "@t3tools/shared/spokenSkills";
import { useEffect, useRef, type RefObject } from "react";

import type { ComposerPromptEditorHandle } from "../components/ComposerPromptEditor";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { isProviderSkillUserInvocable } from "@t3tools/client-runtime/providerSkills";
import { useComposerDictation } from "./useComposerDictation";
import { useDictationHoldShortcut } from "./useDictationHoldShortcut";

/**
 * Everything dictation needs from the chat composer, in one call. Callbacks
 * run after recording, once the composer's handlers (declared further down
 * the component) exist, so they may close over later declarations.
 */
export function useComposerDictationWiring(input: {
  readonly composerDraftTargetKey: string;
  readonly activeQuestionId: string | null | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly promptRef: RefObject<string>;
  readonly getEditor: () => ComposerPromptEditorHandle | null;
  readonly getComposerCursor: () => number;
  readonly getSkills: () => readonly ServerProviderSkill[];
  readonly applyPromptReplacement: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options: { expandedCursorAfterReplace: number; focusEditorAfterReplace: boolean },
  ) => void;
  /** True while the editor refuses text; dictation also freezes it while active. */
  readonly textUnavailable: boolean;
  readonly isComposerFocused: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly terminalOpen: boolean;
  readonly isModelPickerOpen: () => boolean;
}) {
  const insertedRangeRef = useRef<{ start: number; end: number } | null>(null);
  const skills = () => input.getSkills().filter(isProviderSkillUserInvocable);
  const dictation = useComposerDictation({
    ownerKey: `${input.composerDraftTargetKey}:${input.activeQuestionId ?? "prompt"}`,
    draftEnvironmentId: input.environmentId,
    // Spoken "review skill" becomes a $review chip, matching what typing would insert.
    rewriteTranscript: (text) => replaceSpokenSkills(text, skills()),
    readDraft: () => {
      const text = input.promptRef.current;
      return {
        text,
        selection: input.getEditor()?.readSelectionRange() ?? {
          start: text.length,
          end: text.length,
        },
      };
    },
    commitDraft: (text, selection, inserted) => {
      const closed = closeSkillTokenAtCursor(text, selection.start, skills());
      // A space added after a trailing skill token belongs to the inserted range.
      insertedRangeRef.current = {
        start: inserted.start,
        end: inserted.end + (closed.cursor - selection.start),
      };
      const previous = input.promptRef.current;
      input.applyPromptReplacement(0, previous.length, closed.text, {
        expandedCursorAfterReplace: closed.cursor,
        focusEditorAfterReplace: false,
      });
    },
    onCommitted: () => {
      input.getEditor()?.focusAt(input.getComposerCursor());
      const inserted = insertedRangeRef.current;
      insertedRangeRef.current = null;
      if (inserted) input.getEditor()?.flashRange(inserted);
    },
  });

  // Focusing the composer usually comes right before dictating; load the speech model early.
  const warmDictation = dictation.warm;
  useEffect(() => {
    if (input.isComposerFocused) warmDictation();
  }, [input.isComposerFocused, warmDictation]);

  useDictationHoldShortcut({
    dictation,
    enabled: !input.textUnavailable,
    isDictateShortcut: (event) =>
      !isCommandPaletteOpen() &&
      resolveShortcutCommand(event, input.keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen: input.terminalOpen,
          modelPickerOpen: input.isModelPickerOpen(),
        },
      }) === "composer.dictate",
  });

  return {
    /** True while dictation can still change the draft. */
    active: dictation.active,
    /** Props for `ComposerDictationControl`. */
    controlProps: {
      dictation,
      disabled: input.textUnavailable,
      shortcutLabel: shortcutLabelForCommand(input.keybindings, "composer.dictate"),
    },
  };
}
