import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RawTraceError } from "../errors.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  authToken?: string;
}

export async function startHttpMcpServer(mcpServer: McpServer, options: HttpServerOptions): Promise<{ close(): Promise<void>; url: string }> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });
  await mcpServer.connect(transport);

  const server = createServer((req, res) => {
    void handleRequest(req, res, transport, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? options.port;

  return {
    url: `http://${options.host}:${port}/mcp`,
    close: async () => {
      await transport.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

export function validateHttpSecurity(options: { host: string; unsafeRemote?: boolean; authToken?: string }): void {
  if (isLoopbackHost(options.host)) {
    return;
  }

  if (options.unsafeRemote !== true) {
    throw new RawTraceError(
      "HTTP_UNSAFE_REMOTE_REQUIRED",
      "HTTP transport binds to loopback by default. Non-loopback hosts require --unsafe-remote."
    );
  }

  if (!options.authToken) {
    throw new RawTraceError(
      "HTTP_AUTH_TOKEN_REQUIRED",
      "Non-loopback HTTP transport requires --auth-token because RawTrace can expose raw browser data."
    );
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport,
  options: HttpServerOptions
): Promise<void> {
  try {
    if (req.url !== "/mcp") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }

    if (!isAuthorized(req, options.authToken)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    addCorsHeaders(res);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      writeJson(res, 500, { error: "internal_error", message });
    } else {
      res.end();
    }
  }
}

function isAuthorized(req: IncomingMessage, authToken?: string): boolean {
  if (!authToken) {
    return true;
  }

  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const received = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(authToken);
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > 10 * 1024 * 1024) {
      throw new RawTraceError("HTTP_BODY_TOO_LARGE", "HTTP MCP request body exceeds 10 MiB.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    ...corsHeaders()
  });
  res.end(JSON.stringify(value));
}

function addCorsHeaders(res: ServerResponse): void {
  for (const [key, value] of Object.entries(corsHeaders())) {
    res.setHeader(key, value);
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "http://localhost",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, mcp-session-id"
  };
}
