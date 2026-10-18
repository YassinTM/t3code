import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  /** What `useSpeechEnvironmentId` resolves to; null means no machine can speak. */
  speechEnvironmentId: null as EnvironmentId | null,
}));

vi.mock(import("./speechState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useSpeechEnvironmentId: () => mocks.speechEnvironmentId,
}));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: () => vi.fn(),
}));

import { ReadAloudButton } from "./ReadAloudButton";

const SPEAKING = EnvironmentId.make("speaking-environment");
const THREAD_ENVIRONMENT = EnvironmentId.make("thread-environment");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  mocks.speechEnvironmentId = null;
});

async function render(props: {
  readonly text?: string;
  readonly streaming?: boolean;
  readonly environmentId?: EnvironmentId | null;
}): Promise<void> {
  await act(async () => {
    root.render(
      <ReadAloudButton
        messageId="message"
        text={props.text ?? "A spoken reply."}
        streaming={props.streaming ?? false}
        environmentId={props.environmentId === undefined ? THREAD_ENVIRONMENT : props.environmentId}
      />,
    );
  });
}

const readAloudButton = () => document.querySelector<HTMLButtonElement>("button");

describe("ReadAloudButton", () => {
  it("offers read aloud on an assistant reply while a machine can speak", async () => {
    mocks.speechEnvironmentId = SPEAKING;
    await render({});

    const button = readAloudButton();
    expect(button?.getAttribute("aria-label")).toBe("Read aloud");
    expect(button?.querySelector("svg")).not.toBeNull();
  });

  it("stays available while the reply is still arriving", async () => {
    mocks.speechEnvironmentId = SPEAKING;
    await render({ streaming: true });

    expect(readAloudButton()?.getAttribute("aria-label")).toBe("Read aloud");
  });

  it("stays hidden when no machine can speak", async () => {
    mocks.speechEnvironmentId = null;
    await render({});

    expect(readAloudButton()).toBeNull();
  });

  it("stays hidden for a reply with no text", async () => {
    mocks.speechEnvironmentId = SPEAKING;
    await render({ text: "   " });

    expect(readAloudButton()).toBeNull();
  });
});
