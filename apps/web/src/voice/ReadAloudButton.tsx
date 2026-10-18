import { SquareIcon, Volume2Icon } from "lucide-react";
import { memo, useRef } from "react";

import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { useSpeechEnvironmentId } from "./speechState";
import { useReadAloud } from "./useReadAloud";

/**
 * Speaks one assistant reply with the environment's local speech model. Hidden until a machine
 * on this connection can speak, so it never offers an action that would fail. While the reply
 * streams, the button stays available and speaks the part that is already finished.
 */
export const ReadAloudButton = memo(function ReadAloudButton({
  messageId,
  text,
  streaming,
  environmentId,
}: {
  readonly messageId: string;
  /** The reply's Markdown; empty text hides the button. */
  readonly text: string;
  /** True while the reply is still arriving, so chunks are released as they complete. */
  readonly streaming: boolean;
  /** The environment that owns the thread, preferred when several can speak. */
  readonly environmentId: EnvironmentId | null;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const speechEnvironmentId = useSpeechEnvironmentId(environmentId);
  const { status, toggle } = useReadAloud({
    messageId,
    text,
    streaming,
    environmentId: speechEnvironmentId,
    buttonRef: ref,
  });

  if (speechEnvironmentId === null || text.trim().length === 0) return null;

  const reading = status !== "idle";
  const label = reading ? "Stop reading" : "Read aloud";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={toggle}
            ref={ref}
            size="xs"
            type="button"
            variant="ghost"
          />
        }
      >
        {status === "starting" ? (
          <Spinner />
        ) : reading ? (
          <SquareIcon className="size-3" />
        ) : (
          <Volume2Icon className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
});
