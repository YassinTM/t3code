import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "./settingsSearch";

/**
 * Read aloud's rows are registered inside the dictation group the settings catalog already spreads,
 * so these assertions cover that they are actually reachable from search.
 */
describe("read aloud settings search", () => {
  it("finds the Read aloud rows on the Integrations page", () => {
    expect(searchSettings("read aloud").map((item) => item.id)).toContain("read-aloud-enabled");

    expect(searchSettings("narrator").find((item) => item.id === "read-aloud-voice")).toMatchObject(
      {
        id: "read-aloud-voice",
        to: "/settings/integrations",
        targetId: "read-aloud-enabled",
      },
    );
    expect(searchSettings("pace").map((item) => item.id)).toContain("read-aloud-speed");
  });

  it("sends the voice and speed rows to the section's toggle", () => {
    expect(searchSettings("aloud voice")[0]).toMatchObject({
      id: "read-aloud-voice",
      targetId: "read-aloud-enabled",
    });
    expect(searchSettings("aloud speed")[0]).toMatchObject({
      id: "read-aloud-speed",
      targetId: "read-aloud-enabled",
    });
  });
});
