import type { SettingsSearchItem } from "./settingsSearch";

export const DICTATION_INTEGRATIONS_SEARCH_ITEMS = [
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

export const DICTATION_CONNECTIONS_SEARCH_ITEMS = [
  {
    id: "dictation-environment",
    title: "Dictation machine",
    to: "/settings/connections",
    searchTerms: ["speech to text voice transcribe environment automatic"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
