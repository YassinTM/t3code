import * as Layer from "effect/Layer";

import * as SpeechArtifacts from "../speech/SpeechArtifacts.ts";
import * as SpeechSynthesis from "../speech/SpeechSynthesis.ts";
import * as SpeechWorker from "../speech/SpeechWorker.ts";
import * as Dictation from "./Dictation.ts";
import * as DictationArtifacts from "./DictationArtifacts.ts";
import * as DictationRecognizer from "./DictationRecognizer.ts";

const layerDictationArtifacts = DictationArtifacts.layer;
const layerSpeechWorker = SpeechWorker.layer;

const layerDictationRecognizer = DictationRecognizer.layer.pipe(
  Layer.provide(layerDictationArtifacts),
  Layer.provide(layerSpeechWorker),
);

const layerSpeech = SpeechSynthesis.layer.pipe(
  Layer.provide(SpeechArtifacts.layer.pipe(Layer.provide(layerDictationArtifacts))),
  Layer.provide(layerSpeechWorker),
);

/** Dictation and speech service wiring; the caller provides `ServerSettingsService`. */
export const layerDictation = Layer.merge(
  Dictation.layer.pipe(
    Layer.provide(layerDictationRecognizer),
    Layer.provide(layerDictationArtifacts),
  ),
  layerSpeech,
);
