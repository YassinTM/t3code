import { describe, expect, it } from "vite-plus/test";

import { pcm16Base64ToFloat32 } from "./speechPlayer";

/** Encodes little-endian int16 samples the way the environment's `pcm16` field is built. */
function encode(samples: ReadonlyArray<number>): string {
  let binary = "";
  for (const sample of samples) {
    const value = sample & 0xffff;
    binary += String.fromCharCode(value & 0xff, value >> 8);
  }
  return btoa(binary);
}

describe("pcm16Base64ToFloat32", () => {
  it("decodes little-endian int16 samples into floats scaled by 1/32768", () => {
    const samples = pcm16Base64ToFloat32(encode([0, 0x0100, -1, 0x7fff, -0x8000, 0x00ff]));
    expect([...samples]).toEqual([0, 256 / 32768, -1 / 32768, 32767 / 32768, -1, 255 / 32768]);
  });

  it("reads each sample little-endian", () => {
    // 0x0100 is stored as [0x00, 0x01]; reading it big-endian would give 1 instead of 256.
    expect([...pcm16Base64ToFloat32(encode([0x0100]))]).toEqual([256 / 32768]);
  });

  it("returns nothing for an empty payload", () => {
    expect(pcm16Base64ToFloat32("")).toHaveLength(0);
  });

  it("ignores a trailing odd byte instead of reading past the buffer", () => {
    expect(pcm16Base64ToFloat32(btoa("\u0001"))).toHaveLength(0);
  });
});
