import type { SettingsSearchItem } from "./settingsSearch";

const DICTATION_SEARCH_ITEMS = [
  {
    id: "dictation-engine",
    title: "Dictation",
    to: "/settings/integrations",
    searchTerms: ["speech to text voice microphone transcribe local model"],
  },
  {
    id: "dictation-model",
    title: "Dictation model",
    to: "/settings/integrations",
    searchTerms: ["download remove parakeet whisper moonshine speech model languages disk"],
  },
  {
    id: "dictation-language",
    title: "Dictation language",
    to: "/settings/integrations",
    // The row sits inside the Dictation section; land on the section heading.
    targetId: "dictation",
    searchTerms: ["speech transcription automatic detect english spoken"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

const READ_ALOUD_SEARCH_ITEMS = [
  {
    id: "read-aloud-enabled",
    title: "Read aloud",
    to: "/settings/integrations",
    searchTerms: ["speak spoken narration listen audio playback tts assistant replies"],
  },
  {
    id: "read-aloud-voice",
    title: "Read aloud voice",
    to: "/settings/integrations",
    targetId: "read-aloud-enabled",
    searchTerms: ["speaker narrator accent tone american british female male"],
  },
  {
    id: "read-aloud-speed",
    title: "Read aloud speed",
    to: "/settings/integrations",
    // The row sits inside the Read aloud section; land on the section's first row.
    targetId: "read-aloud-enabled",
    searchTerms: ["pace faster slower speaking tempo words per minute"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

/**
 * Read aloud lives on the same Integrations page as dictation and shares its machine, so its rows
 * join this group. The group is the one the settings catalog already registers; adding a second
 * group would mean editing that upstream catalog.
 */
export const DICTATION_INTEGRATIONS_SEARCH_ITEMS = [
  ...DICTATION_SEARCH_ITEMS,
  ...READ_ALOUD_SEARCH_ITEMS,
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const DICTATION_CONNECTIONS_SEARCH_ITEMS = [
  {
    id: "dictation-environment",
    title: "Dictation machine",
    to: "/settings/connections",
    searchTerms: ["speech to text voice transcribe environment automatic"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
