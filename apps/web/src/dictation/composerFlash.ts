import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useCallback, useRef } from "react";

import {
  flatToMarkdown,
  flatToPm,
  serializeEditorDoc,
  type RichDocMap,
} from "../composer-rich-text-doc";

const FlashPluginKey = new PluginKey<DecorationSet>("composer-flash");
/** Matches the `composer-flash` keyframes in dictation.css. */
const FLASH_DURATION_MS = 900;

/** Holds one short-lived highlight, set and cleared through transaction meta. */
export const ComposerFlashPlugin = new Plugin<DecorationSet>({
  key: FlashPluginKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, old) => {
      const meta = tr.getMeta(FlashPluginKey) as { from: number; to: number } | null | undefined;
      if (meta === null) return DecorationSet.empty;
      if (meta) {
        return DecorationSet.create(tr.doc, [
          Decoration.inline(meta.from, meta.to, { class: "composer-flash" }),
        ]);
      }
      return old.map(tr.mapping, tr.doc);
    },
  },
  props: {
    decorations: (state) => FlashPluginKey.getState(state),
  },
});

/** Smallest document offset whose Markdown offset reaches `mdOffset`; the inverse of `flatToMarkdown`. */
function markdownToFlat(map: RichDocMap, mdOffset: number): number {
  let low = 0;
  let high = map.docLength;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (flatToMarkdown(map, middle) < mdOffset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Returns the editor handle's `flashRange`: briefly highlights a range of the
 * prompt, in the same Markdown offsets as `readSelectionRange`, so inserted
 * text such as a dictation is easy to spot.
 */
export function useFlashRange(editor: Editor | null) {
  const flashTimerRef = useRef<number | null>(null);
  return useCallback(
    ({ start, end }: { start: number; end: number }) => {
      if (!editor || end <= start) return;
      const map = serializeEditorDoc(editor.state.doc);
      const from = flatToPm(map, markdownToFlat(map, start));
      const to = flatToPm(map, markdownToFlat(map, end));
      if (to <= from) return;
      editor.view.dispatch(editor.state.tr.setMeta(FlashPluginKey, { from, to }));
      // A newer flash replaces the old one, so its timer must not clear the newer one early.
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => {
        flashTimerRef.current = null;
        if (!editor.isDestroyed) {
          editor.view.dispatch(editor.state.tr.setMeta(FlashPluginKey, null));
        }
      }, FLASH_DURATION_MS);
    },
    [editor],
  );
}
