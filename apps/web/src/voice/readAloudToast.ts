import type { RefObject } from "react";

import { anchoredToastManager } from "~/components/ui/toast";

const READ_ALOUD_TOAST_TIMEOUT_MS = 3000;

/** Reports a read-aloud failure next to the button, like the copy button's anchored toast. */
export function showReadAloudErrorToast(
  ref: RefObject<HTMLButtonElement | null>,
  error: Error,
): void {
  if (!ref.current) return;
  anchoredToastManager.add({
    data: {
      tooltipStyle: true,
    },
    positionerProps: {
      anchor: ref.current,
    },
    timeout: READ_ALOUD_TOAST_TIMEOUT_MS,
    title: "Could not read aloud",
    description: error.message,
  });
}
