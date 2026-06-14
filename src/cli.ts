#!/usr/bin/env node
import process from "node:process";
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRawTraceMcpServer } from "./server/mcpServer.js";
import { startHttpMcpServer, validateHttpSecurity } from "./server/http.js";

export interface CliOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
  unsafeRemote: boolean;
  authToken?: string;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const program = new Command();
  program
    .name("rawtrace-mcp")
    .description("Raw DOM/network tracing MCP server powered by Playwright and CDP.")
    .option("--transport <transport>", "MCP transport: stdio or http", "stdio")
    .option("--host <host>", "HTTP host", "127.0.0.1")
    .option("--port <port>", "HTTP port", (value) => Number.parseInt(value, 10), 3757)
    .option("--unsafe-remote", "Allow HTTP binding to a non-loopback host when paired with --auth-token", false)
    .option("--auth-token <token>", "Bearer token required for non-loopback HTTP");

  program.parse(argv);
  const options = program.opts<{
    transport: string;
    host: string;
    port: number;
    unsafeRemote: boolean;
    authToken?: string;
  }>();

  if (options.transport !== "stdio" && options.transport !== "http") {
    throw new Error(`Unsupported transport: ${options.transport}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error(`Invalid port: ${String(options.port)}`);
  }

  return {
    transport: options.transport,
    host: options.host,
    port: options.port,
    unsafeRemote: options.unsafeRemote,
    authToken: options.authToken
  };
}

export async function main(argv = process.argv): Promise<void> {
  const options = parseCliArgs(argv);
  const server = createRawTraceMcpServer();

  if (options.transport === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  validateHttpSecurity(options);
  const httpServer = await startHttpMcpServer(server, options);
  console.error(`RawTrace MCP listening on ${httpServer.url}`);

  const shutdown = async (): Promise<void> => {
    await httpServer.close();
    await server.close();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1]?.endsWith("cli.js")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
