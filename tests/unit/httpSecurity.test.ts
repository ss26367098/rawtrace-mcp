import { describe, expect, it } from "vitest";
import { RawTraceError } from "../../src/errors.js";
import { isLoopbackHost, validateHttpSecurity } from "../../src/server/http.js";

describe("HTTP security defaults", () => {
  it("allows loopback hosts without a token", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(() => validateHttpSecurity({ host: "127.0.0.1" })).not.toThrow();
  });

  it("rejects non-loopback hosts without explicit unsafe remote", () => {
    expect(() => validateHttpSecurity({ host: "0.0.0.0" })).toThrow(RawTraceError);
  });

  it("requires a token for unsafe non-loopback hosts", () => {
    expect(() => validateHttpSecurity({ host: "0.0.0.0", unsafeRemote: true })).toThrow(/auth-token/i);
    expect(() => validateHttpSecurity({ host: "0.0.0.0", unsafeRemote: true, authToken: "secret" })).not.toThrow();
  });
});
