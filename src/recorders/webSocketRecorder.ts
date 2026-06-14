import type { CDPSession, Page } from "playwright";
import type { Recorder } from "../types.js";
import type { TraceSession } from "../trace/session.js";

export class WebSocketRecorder implements Recorder {
  private cdp?: CDPSession;

  constructor(
    private readonly page: Page,
    private readonly session: TraceSession
  ) {}

  async start(): Promise<void> {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Network.webSocketCreated", (params) => {
      void this.session.append("websocket", "created", {
        requestId: params.requestId,
        url: params.url,
        initiator: params.initiator,
        cdp: params
      });
    });
    this.cdp.on("Network.webSocketFrameSent", (params) => {
      void this.session.append("websocket", "frameSent", {
        requestId: params.requestId,
        opcode: params.response?.opcode,
        mask: params.response?.mask,
        payloadData: params.response?.payloadData,
        cdp: params
      });
    });
    this.cdp.on("Network.webSocketFrameReceived", (params) => {
      void this.session.append("websocket", "frameReceived", {
        requestId: params.requestId,
        opcode: params.response?.opcode,
        mask: params.response?.mask,
        payloadData: params.response?.payloadData,
        cdp: params
      });
    });
    this.cdp.on("Network.webSocketClosed", (params) => {
      void this.session.append("websocket", "closed", {
        requestId: params.requestId,
        timestamp: params.timestamp,
        cdp: params
      });
    });
    await this.cdp.send("Network.enable");
  }

  async stop(): Promise<void> {
    await this.cdp?.detach().catch(() => undefined);
  }
}
