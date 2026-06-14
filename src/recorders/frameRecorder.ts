import type { Frame, Page } from "playwright";
import type { Recorder } from "../types.js";
import type { TraceSession } from "../trace/session.js";

export class FrameRecorder implements Recorder {
  private readonly attachedHandler = (frame: Frame): void => {
    void this.session.append("frames", "attached", framePayload(frame));
  };

  private readonly detachedHandler = (frame: Frame): void => {
    void this.session.append("frames", "detached", framePayload(frame));
  };

  private readonly navigatedHandler = (frame: Frame): void => {
    void this.session.append("frames", "navigated", framePayload(frame));
  };

  constructor(
    private readonly page: Page,
    private readonly session: TraceSession
  ) {}

  async start(): Promise<void> {
    this.page.on("frameattached", this.attachedHandler);
    this.page.on("framedetached", this.detachedHandler);
    this.page.on("framenavigated", this.navigatedHandler);
  }

  async stop(): Promise<void> {
    this.page.off("frameattached", this.attachedHandler);
    this.page.off("framedetached", this.detachedHandler);
    this.page.off("framenavigated", this.navigatedHandler);
  }
}

function framePayload(frame: Frame): Record<string, unknown> {
  return {
    frameUrl: frame.url(),
    name: frame.name(),
    parentFrameUrl: frame.parentFrame()?.url()
  };
}
