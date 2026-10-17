import * as Layer from "effect/Layer";

import * as Dictation from "./Dictation.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import * as DictationRecognizer from "./DictationRecognizer.ts";

const layerDictationArtifacts = DictationArtifacts.layer;

/** Dictation service wiring; the caller provides `ServerSettingsService`. */
export const layerDictation = Dictation.layer.pipe(
  Layer.provide(DictationRecognizer.layer.pipe(Layer.provide(layerDictationArtifacts))),
  Layer.provide(layerDictationArtifacts),
);
