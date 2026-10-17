/** Audio conversion for synthesized speech. */

/**
 * Convert Float32 samples in [-1, 1] into base64 little-endian int16 mono PCM. Values
 * outside the range are clamped, so a model that overshoots still returns playable audio.
 */
export function encodePcm16(samples: Float32Array): string {
  const bytes = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    bytes.writeInt16LE(Math.round(clamped * 32767), index * 2);
  }
  return bytes.toString("base64");
}
