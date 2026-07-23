import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../src/cli.js";

describe("CLI options", () => {
  it("defaults to the full tool profile", () => {
    expect(parseCliArgs(["node", "rawtrace-mcp"])).toMatchObject({
      transport: "stdio",
      toolProfile: "full"
    });
  });

  it("accepts the agent tool profile", () => {
    expect(parseCliArgs(["node", "rawtrace-mcp", "--tool-profile", "agent"]).toolProfile).toBe("agent");
  });

  it("rejects unknown tool profiles with a clear error", () => {
    expect(() => parseCliArgs(["node", "rawtrace-mcp", "--tool-profile", "minimal"])).toThrow(
      'Unsupported tool profile: minimal. Expected "full" or "agent".'
    );
  });
});
