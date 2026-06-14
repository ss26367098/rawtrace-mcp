import type { CDPSession, Page, Request } from "playwright";
import type { Recorder } from "../types.js";
import type { TraceSession } from "../trace/session.js";

export class NetworkRecorder implements Recorder {
  private cdp?: CDPSession;
  private readonly requestHandler = (request: Request): void => {
    void this.capturePlaywrightRequestBody(request);
  };

  constructor(
    private readonly page: Page,
    private readonly session: TraceSession,
    private readonly captureBodies: boolean,
    private readonly maxBodyBytes: number
  ) {}

  async start(): Promise<void> {
    this.page.on("request", this.requestHandler);
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Network.requestWillBeSent", (params) => {
      void this.captureCdpRequestWillBeSent(params);
    });
    this.cdp.on("Network.requestWillBeSentExtraInfo", (params) => {
      void this.session.append("network", "requestWillBeSentExtraInfo", {
        requestId: params.requestId,
        headers: params.headers,
        associatedCookies: params.associatedCookies,
        connectTiming: params.connectTiming,
        cdp: params
      });
    });
    this.cdp.on("Network.responseReceived", (params) => {
      void this.session.append("network", "responseReceived", {
        requestId: params.requestId,
        url: params.response?.url,
        status: params.response?.status,
        statusText: params.response?.statusText,
        headers: params.response?.headers,
        mimeType: params.response?.mimeType,
        protocol: params.response?.protocol,
        remoteIPAddress: params.response?.remoteIPAddress,
        remotePort: params.response?.remotePort,
        resourceType: params.type,
        cdp: params
      });
    });
    this.cdp.on("Network.responseReceivedExtraInfo", (params) => {
      void this.session.append("network", "responseReceivedExtraInfo", {
        requestId: params.requestId,
        statusCode: params.statusCode,
        headers: params.headers,
        blockedCookies: params.blockedCookies,
        cdp: params
      });
    });
    this.cdp.on("Network.loadingFinished", (params) => {
      void this.captureLoadingFinished(params);
    });
    this.cdp.on("Network.loadingFailed", (params) => {
      void this.session.append("network", "loadingFailed", {
        requestId: params.requestId,
        errorText: params.errorText,
        canceled: params.canceled,
        blockedReason: params.blockedReason,
        cdp: params
      });
    });

    await this.cdp.send("Network.enable", networkBufferOptions(this.maxBodyBytes));
  }

  async stop(): Promise<void> {
    this.page.off("request", this.requestHandler);
    await this.cdp?.detach().catch(() => undefined);
  }

  private async captureCdpRequestWillBeSent(params: Record<string, any>): Promise<void> {
    let bodyRef: unknown;
    let bodySkipped: boolean | undefined;
    let bodySkippedReason: string | undefined;
    let bodyByteLength: number | undefined;
    const postData = typeof params.request?.postData === "string" ? params.request.postData : undefined;

    if (this.captureBodies && postData !== undefined) {
      bodyByteLength = Buffer.byteLength(postData, "utf8");
      if (bodyByteLength > this.maxBodyBytes) {
        bodySkipped = true;
        bodySkippedReason = `Request body exceeds maxBodyBytes (${bodyByteLength} > ${this.maxBodyBytes}).`;
      } else {
        bodyRef = await this.session.writeBody("req", postData, "utf8");
      }
    }

    await this.session.append("network", "requestWillBeSent", {
      requestId: params.requestId,
      loaderId: params.loaderId,
      documentURL: params.documentURL,
      url: params.request?.url,
      method: params.request?.method,
      headers: params.request?.headers,
      postData: params.request?.postData,
      hasPostData: params.request?.hasPostData,
      bodyRef,
      bodySkipped,
      bodySkippedReason,
      bodyByteLength,
      initiator: params.initiator,
      resourceType: params.type,
      cdp: params
    });
  }

  private async captureLoadingFinished(params: Record<string, any>): Promise<void> {
    let bodyRef: unknown;
    let bodyError: string | undefined;
    let bodySkipped: boolean | undefined;
    let bodySkippedReason: string | undefined;
    let bodyByteLength: number | undefined;

    if (this.captureBodies && this.cdp) {
      try {
        const body = (await this.cdp.send("Network.getResponseBody", { requestId: params.requestId })) as {
          body: string;
          base64Encoded: boolean;
        };
        const encoding = body.base64Encoded ? "base64" : "utf8";
        bodyByteLength = byteLengthForBody(body.body, encoding);
        if (bodyByteLength > this.maxBodyBytes) {
          bodySkipped = true;
          bodySkippedReason = `Response body exceeds maxBodyBytes (${bodyByteLength} > ${this.maxBodyBytes}).`;
        } else {
          bodyRef = await this.session.writeBody("res", body.body, encoding);
        }
      } catch (error) {
        bodyError = error instanceof Error ? error.message : String(error);
      }
    }

    await this.session.append("network", "loadingFinished", {
      requestId: params.requestId,
      encodedDataLength: params.encodedDataLength,
      bodyRef,
      bodyError,
      bodySkipped,
      bodySkippedReason,
      bodyByteLength,
      cdp: params
    });
  }

  private async capturePlaywrightRequestBody(request: Request): Promise<void> {
    if (!this.captureBodies) {
      return;
    }

    const postData = request.postData();
    if (postData === null) {
      return;
    }

    const bodyByteLength = Buffer.byteLength(postData, "utf8");
    if (bodyByteLength > this.maxBodyBytes) {
      await this.session.append("network", "requestPostData", {
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        bodySkipped: true,
        bodySkippedReason: `Request body exceeds maxBodyBytes (${bodyByteLength} > ${this.maxBodyBytes}).`,
        bodyByteLength
      });
      return;
    }

    const bodyRef = await this.session.writeBody("req", postData, "utf8");
    await this.session.append("network", "requestPostData", {
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      bodyRef,
      postData
    });
  }
}

function byteLengthForBody(body: string, encoding: "utf8" | "base64"): number {
  return Buffer.byteLength(body, encoding);
}

export function networkBufferOptions(maxBodyBytes: number): { maxTotalBufferSize: number; maxResourceBufferSize: number } {
  const maxResourceBufferSize = Math.max(1, Math.trunc(maxBodyBytes));
  return {
    maxTotalBufferSize: Math.max(100_000_000, maxResourceBufferSize * 5),
    maxResourceBufferSize
  };
}
