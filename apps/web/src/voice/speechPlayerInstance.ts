import { createSpeechPlayer } from "./speechPlayer";

/** One audio context for the whole app, so read-aloud and the settings preview stay in order. */
export const speechPlayer = createSpeechPlayer();
