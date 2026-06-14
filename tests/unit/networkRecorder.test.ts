import { describe, expect, it } from "vitest";
import { networkBufferOptions } from "../../src/recorders/networkRecorder.js";

describe("NetworkRecorder", () => {
  it("sizes CDP body buffers from maxBodyBytes", () => {
    expect(networkBufferOptions(42)).toEqual({
      maxTotalBufferSize: 100_000_000,
      maxResourceBufferSize: 42
    });

    expect(networkBufferOptions(50_000_000)).toEqual({
      maxTotalBufferSize: 250_000_000,
      maxResourceBufferSize: 50_000_000
    });
  });
});
