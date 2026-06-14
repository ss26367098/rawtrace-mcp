import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraceSession } from "../../src/trace/session.js";

const tempDirs: string[] = [];

describe("TraceSession", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes stable manifest and monotonic event sequence", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: true,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      },
      pageUrlProvider: () => "https://example.test/"
    });

    await session.append("dom", "childList", { targetPath: "html > body" });
    await session.append("network", "requestWillBeSent", { url: "https://example.test/api" });
    const bodyRef = await session.writeBody("res", "{\"ok\":true}", "utf8");
    await session.append("network", "loadingFinished", { bodyRef });
    const manifest = await session.stop();

    expect(manifest.traceSchemaVersion).toBe("1.0.0");
    expect(manifest.eventCounts.dom).toBe(1);
    expect(manifest.eventCounts.network).toBe(2);
    expect(bodyRef.sha256).toHaveLength(64);
    expect(bodyRef.path).toMatch(/^bodies\/res_/);

    const all = await session.readEvents("all", 0, 10);
    expect(all.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(all.events[0]?.pageUrl).toBe("https://example.test/");
  });

  it("reads chunked events with offset and limit", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: false,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });

    await session.append("dom", "a");
    await session.append("dom", "b");
    await session.append("dom", "c");

    const chunk = await session.readEvents("dom", 1, 1);
    expect(chunk.total).toBe(3);
    expect(chunk.events).toHaveLength(1);
    expect(chunk.events[0]?.type).toBe("b");
  });

  it("flushes stream writes before chunked reads", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: false,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });

    await Promise.all(Array.from({ length: 20 }, (_, index) => session.append("dom", `event-${index}`)));
    const chunk = await session.readEvents("dom", 0, 100);

    expect(chunk.total).toBe(20);
    expect(chunk.events.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("drains queued append operations before stopping", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: true,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });
    const largeText = `${"x".repeat(6_000)} stop-drain-token ${"y".repeat(6_000)}`;

    void session.append("dom", "childList", { text: largeText });
    const manifest = await session.stop();
    const dom = await session.readEvents("dom", 0, 10);

    expect(manifest.eventCounts.dom).toBe(1);
    expect(dom.events).toHaveLength(1);
    expect(dom.events[0]?.textRef).toMatchObject({
      byteLength: Buffer.byteLength(largeText, "utf8")
    });
  });

  it("externalizes large DOM payload fields as file references", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: true,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });
    const largeHtml = `<div>${"x".repeat(10_000)}</div>`;

    await session.append("dom", "childList", {
      addedNodes: [
        {
          nodeType: "element",
          tagName: "DIV",
          path: "html > body > div",
          text: "small visible text",
          outerHTML: largeHtml
        }
      ]
    });

    const dom = await session.readEvents("dom", 0, 10);
    const node = dom.events[0]?.addedNodes as Array<Record<string, unknown>>;
    const htmlRef = node[0]?.htmlRef as { path: string; byteLength: number; sha256: string };

    expect(node[0]?.outerHTML).toBeUndefined();
    expect(htmlRef.path).toMatch(/^bodies\/dom_html_/);
    expect(htmlRef.byteLength).toBe(Buffer.byteLength(largeHtml, "utf8"));
    expect(htmlRef.sha256).toHaveLength(64);
    await expect(readFile(join(session.outputDir, htmlRef.path), "utf8")).resolves.toBe(largeHtml);
  });

  it("searches text stored in externalized DOM artifacts", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: true,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });
    const targetText = "外置DOM签到按钮";
    const largeText = `${"before ".repeat(900)}${targetText}${" after".repeat(900)}`;

    await session.append("dom", "childList", {
      addedNodes: [
        {
          nodeType: "element",
          tagName: "DIV",
          path: "html > body > div",
          text: largeText,
          outerHTML: `<div>${largeText}</div>`
        }
      ]
    });

    const result = await session.searchEvents({ stream: "dom", text: targetText });

    expect(result.matches.map((event) => event.seq)).toEqual([1]);
    expect(result.matches[0]?.snippet).toContain(targetText);
    expect(result.matches[0]?.snippet).toContain("bodies/dom_");
  });

  it("returns clear errors for oversized read limits", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: false,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });

    await expect(session.readEvents("dom", 0, 1001)).rejects.toThrow("monitor_read_events limit must be <= 1000");
  });

  it("searches events by text, URL, type, and sinceSeq", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: true,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });

    await session.append("dom", "childList", { targetPath: "html > body", text: "签到成功" });
    await session.append("network", "requestWillBeSent", { method: "POST", url: "https://example.test/api/checkin" });
    await session.append("network", "responseReceived", { status: 200, url: "https://example.test/api/checkin" });

    const text = await session.searchEvents({ text: "签到成功" });
    const url = await session.searchEvents({ stream: "network", urlContains: "/api/checkin", type: "requestWillBeSent" });
    const sinceSeq = await session.searchEvents({ sinceSeq: 2, limit: 1 });

    expect(text.matches.map((event) => event.seq)).toEqual([1]);
    expect(url.matches.map((event) => event.seq)).toEqual([2]);
    expect(sinceSeq.matches.map((event) => event.seq)).toEqual([3]);
  });

  it("writes generic artifacts with stable references", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: true,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });
    const content = "<html>raw inspection artifact</html>";

    const ref = await session.writeArtifact("inspection_html", content, "utf8", "html");

    expect(ref.path).toMatch(/^bodies\/inspection_html_/);
    expect(ref.path).toMatch(/\.html$/);
    expect(ref.byteLength).toBe(Buffer.byteLength(content, "utf8"));
    expect(ref.sha256).toHaveLength(64);
    await expect(readFile(join(session.outputDir, ref.path), "utf8")).resolves.toBe(content);
  });

  it("searches raw network body files by text, URL, status, and sinceSeq", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: true,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });

    await session.append("network", "requestWillBeSent", {
      requestId: "req-1",
      method: "POST",
      url: "https://example.test/api/checkin"
    });
    await session.append("network", "responseReceived", {
      requestId: "req-1",
      status: 200,
      url: "https://example.test/api/checkin"
    });
    const bodyRef = await session.writeBody("res", JSON.stringify({ message: "签到成功", token: "BODY_TOKEN_123" }), "utf8");
    await session.append("network", "loadingFinished", {
      requestId: "req-1",
      bodyRef
    });

    const found = await session.searchBodies({
      acknowledgeRawCapture: true,
      text: "BODY_TOKEN_123",
      urlContains: "/api/checkin",
      status: 200
    });
    const skipped = await session.searchBodies({
      acknowledgeRawCapture: true,
      text: "BODY_TOKEN_123",
      sinceSeq: 3
    });

    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({
      seq: 3,
      url: "https://example.test/api/checkin",
      method: "POST",
      status: 200,
      bodyRef
    });
    expect(found.matches[0]?.snippet).toContain("BODY_TOKEN_123");
    expect(skipped.matches).toHaveLength(0);
  });

  it("searches request body files with status metadata recorded later", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: true,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });
    const requestBodyRef = await session.writeBody("req", JSON.stringify({ token: "REQUEST_BODY_STATUS_TOKEN" }), "utf8");

    await session.append("network", "requestWillBeSent", {
      requestId: "req-2",
      method: "POST",
      url: "https://example.test/api/checkin",
      bodyRef: requestBodyRef
    });
    await session.append("network", "responseReceived", {
      requestId: "req-2",
      status: 200,
      url: "https://example.test/api/checkin"
    });

    const found = await session.searchBodies({
      acknowledgeRawCapture: true,
      text: "REQUEST_BODY_STATUS_TOKEN",
      urlContains: "/api/checkin",
      method: "POST",
      status: 200
    });

    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({
      seq: 1,
      method: "POST",
      status: 200,
      bodyRef: requestBodyRef
    });
  });

  it("preserves raw reserved payload fields without overwriting common event fields", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: false,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      },
      pageUrlProvider: () => "https://common.example/"
    });

    const event = await session.append("dom", "childList", {
      seq: 999,
      source: "network",
      type: "wrong",
      t: 123456,
      wallTime: "raw-wall-time",
      pageUrl: "https://raw.example/",
      targetPath: "html > body"
    });

    expect(event.seq).toBe(1);
    expect(event.source).toBe("dom");
    expect(event.type).toBe("childList");
    expect(event.t).not.toBe(123456);
    expect(event.pageUrl).toBe("https://common.example/");
    expect(event.payloadReservedFields).toMatchObject({
      seq: 999,
      source: "network",
      type: "wrong",
      t: 123456,
      wallTime: "raw-wall-time",
      pageUrl: "https://raw.example/"
    });
  });

  it("exports zip bundles with nested body paths intact", async () => {
    const base = await mkdtemp(join(tmpdir(), "rawtrace-test-"));
    tempDirs.push(base);
    const session = await TraceSession.create({
      baseOutputDir: base,
      captureOptions: {
        captureDom: true,
        captureNetwork: true,
        captureCookies: true,
        captureBodies: true,
        captureWebSockets: true,
        captureConsole: true,
        captureFrames: true
      }
    });

    const bodyRef = await session.writeBody("res", "{\"ok\":true}", "utf8");
    await session.append("network", "loadingFinished", { bodyRef });
    await session.stop();
    const zipPath = await session.exportZip(join(base, "export.zip"));
    const zipBytes = await readFile(zipPath);

    expect(zipBytes.toString("latin1")).toContain(`${session.sessionId}/${bodyRef.path}`);
  });
});
