import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { RAWTRACE_SERVER_INSTRUCTIONS } from "../../src/server/mcpServer.js";

const execFileAsync = promisify(execFile);

type PackedFile = { path: string };
type PackResult = { filename: string; files: PackedFile[] };

type McpConfig = {
  mcpServers: {
    rawtrace: {
      command: string;
      args: string[];
    };
  };
};

type Marketplace = {
  plugins: Array<{
    source: {
      source: string;
      package: string;
      version: string;
    };
  }>;
};

describe("npm package", () => {
  it("ships a directly runnable agent-profile plugin for both clients", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "rawtrace-package-test-"));
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    let client: Client | undefined;

    try {
      const { stdout } = await execFileAsync(
        npmCommand,
        ["pack", "--ignore-scripts", "--json", "--pack-destination", tempDir],
        { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }
      );
      const [pack] = JSON.parse(stdout) as PackResult[];
      expect(pack).toBeDefined();

      const fileNames = new Set(pack?.files.map((file) => file.path));
      for (const expectedPath of [
        "dist/cli.js",
        ".codex-plugin/plugin.json",
        ".claude-plugin/plugin.json",
        ".claude-plugin/marketplace.json",
        ".agents/plugins/marketplace.json",
        ".mcp.json",
        "skills/rawtrace-debug-browser/SKILL.md",
        "skills/rawtrace-debug-browser/agents/openai.yaml",
        "evals/proactive-invocation.json"
      ]) {
        expect(fileNames.has(expectedPath), `missing ${expectedPath} from npm package`).toBe(true);
      }

      const archivePath = path.join(tempDir, pack?.filename ?? "");
      await execFileAsync("tar", ["-xzf", archivePath, "-C", tempDir]);
      const pluginRoot = path.join(tempDir, "package");
      const packageJson = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8")) as { version: string };
      const codexPlugin = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8")) as {
        version: string;
      };
      const claudePlugin = JSON.parse(await readFile(path.join(pluginRoot, ".claude-plugin/plugin.json"), "utf8")) as {
        version: string;
      };
      const codexMarketplace = JSON.parse(
        await readFile(path.join(pluginRoot, ".agents/plugins/marketplace.json"), "utf8")
      ) as Marketplace;
      const claudeMarketplace = JSON.parse(
        await readFile(path.join(pluginRoot, ".claude-plugin/marketplace.json"), "utf8")
      ) as Marketplace;

      expect([packageJson.version, codexPlugin.version, claudePlugin.version]).toEqual(["0.3.0", "0.3.0", "0.3.0"]);
      for (const marketplace of [codexMarketplace, claudeMarketplace]) {
        expect(marketplace.plugins[0]?.source).toEqual({
          source: "npm",
          package: "rawtrace-mcp",
          version: "0.3.0"
        });
      }

      await execFileAsync(npmCommand, ["install", "--omit=dev", "--ignore-scripts"], {
        cwd: pluginRoot,
        maxBuffer: 10 * 1024 * 1024
      });
      const config = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8")) as McpConfig;
      const rawtrace = config.mcpServers.rawtrace;
      const args = rawtrace.args.map((argument) => argument.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot));

      expect(rawtrace.command).toBe("node");
      expect(args).toEqual([path.join(pluginRoot, "dist/cli.js"), "--tool-profile", "agent"]);

      client = new Client({ name: "rawtrace-package-test-client", version: "0.0.0" });
      await client.connect(
        new StdioClientTransport({
          command: rawtrace.command,
          args
        })
      );
      const tools = await client.listTools();

      expect(client.getInstructions()).toBe(RAWTRACE_SERVER_INSTRUCTIONS);
      expect(tools.tools).toHaveLength(35);
      expect(tools.tools.map((tool) => tool.name)).toContain("browser_observe_action_result");
      expect(tools.tools.map((tool) => tool.name)).not.toContain("browser_eval");
      expect(tools.tools.map((tool) => tool.name)).not.toContain("monitor_read_events");
    } finally {
      await client?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
