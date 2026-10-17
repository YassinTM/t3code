/** Pinned speech artifacts and the native config that loads them. */

export interface SpeechModelArtifact {
  /** The single root directory inside the release archive. */
  readonly directory: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Entries the extracted model needs before the runtime can load it. */
  readonly requiredEntries: readonly string[];
}

/**
 * Kokoro English v0.19, 82M parameters, 11 voices. sherpa-onnx ships it as a bzip2 tar
 * because Node has no bzip2 decoder; SpeechArtifacts verifies the pinned hash and then
 * extracts it with the system `tar`.
 */
export const kokoroEnV019: SpeechModelArtifact = {
  directory: "kokoro-en-v0_19",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2",
  bytes: 319_625_534,
  sha256: "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7",
  requiredEntries: ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
};

/** The offline TTS config sherpa-onnx's `createOfflineTtsAsync` expects. */
export const kokoroConfig = (resolve: (name: string) => string, numThreads: number) => ({
  model: {
    kokoro: {
      model: resolve("model.onnx"),
      voices: resolve("voices.bin"),
      tokens: resolve("tokens.txt"),
      dataDir: resolve("espeak-ng-data"),
    },
    // Leave CPU for the agents sharing the host; synthesis is interactive but short.
    numThreads,
    provider: "cpu",
    debug: 0,
  },
  maxNumSentences: 1,
});
