/**
 * Test double for the speech worker protocol (see ../../../speech/worker/speechWorkerMain.ts)
 * with no native addon. `recognizer.create` takes a `config.mode` that decides how
 * `recognizer.decode` behaves, and the same `mode` drives `tts.generate`, so every op is
 * driven through the real client service.
 *
 * Args: [logFile?, signalFile?]. The fixture appends its pid on startup and the received
 * signal on SIGTERM, which lets tests observe respawns and shutdown.
 */
import * as NodeFS from "node:fs";

const [logFile, signalFile] = process.argv.slice(2);

if (logFile !== undefined) NodeFS.appendFileSync(logFile, `${process.pid}\n`);
if (signalFile !== undefined) {
  process.on("SIGTERM", () => {
    NodeFS.appendFileSync(signalFile, "SIGTERM\n");
    process.exit(0);
  });
}

let nextHandleId = 1;
const handles = new Map();

const reply = (message) => {
  process.send(message);
};

process.on("message", (request) => {
  const { id, op } = request;
  switch (op) {
    case "recognizer.create": {
      const handleId = nextHandleId++;
      handles.set(handleId, request.config);
      reply({ id, ok: true, value: handleId });
      return;
    }
    case "recognizer.setConfig": {
      handles.set(request.handleId, request.config);
      reply({ id, ok: true, value: undefined });
      return;
    }
    case "recognizer.release": {
      handles.delete(request.handleId);
      reply({ id, ok: true, value: undefined });
      return;
    }
    case "recognizer.decode": {
      const config = handles.get(request.handleId) ?? {};
      if (config.mode === "crash") process.exit(7);
      if (config.mode === "exit") process.exit(0);
      if (config.mode === "hang") return;
      if (config.mode === "fail") {
        reply({ id, ok: false, error: { message: "fixture decode failed" } });
        return;
      }
      const samples = request.samples;
      reply({
        id,
        ok: true,
        value: JSON.stringify({
          text: `${config.text ?? "fixture"} ${samples.length} ${[...samples].join(",")}`,
          lang: config.lang ?? "en",
        }),
      });
      return;
    }
    case "tts.create": {
      const handleId = nextHandleId++;
      handles.set(handleId, request.config);
      reply({ id, ok: true, value: handleId });
      return;
    }
    case "tts.generate": {
      const config = handles.get(request.handleId) ?? {};
      if (config.mode === "crash") process.exit(7);
      if (config.mode === "hang") return;
      if (config.mode === "fail") {
        reply({ id, ok: false, error: { message: "fixture synthesis failed" } });
        return;
      }
      // Echo the request so the client sees exactly what crossed the channel.
      reply({
        id,
        ok: true,
        value: {
          samples: new Float32Array([request.sid, request.speed, request.text.length]),
          sampleRate: 24_000,
        },
      });
      return;
    }
    case "tts.release": {
      handles.delete(request.handleId);
      reply({ id, ok: true, value: undefined });
      return;
    }
    default: {
      reply({ id, ok: false, error: { message: `unknown op ${String(op)}` } });
    }
  }
});
