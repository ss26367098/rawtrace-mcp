import type { ConsoleMessage, Page } from "playwright";
import type { Recorder } from "../types.js";
import type { TraceSession } from "../trace/session.js";

export class ConsoleRecorder implements Recorder {
  private readonly consoleHandler = (message: ConsoleMessage): void => {
    void this.session.append("console", "console", {
      level: message.type(),
      text: message.text(),
      location: message.location()
    });
  };

  private readonly pageErrorHandler = (error: Error): void => {
    void this.session.append("console", "pageerror", {
      message: error.message,
      stack: error.stack
    });
  };

  constructor(
    private readonly page: Page,
    private readonly session: TraceSession
  ) {}

  async start(): Promise<void> {
    this.page.on("console", this.consoleHandler);
    this.page.on("pageerror", this.pageErrorHandler);
  }

  async stop(): Promise<void> {
    this.page.off("console", this.consoleHandler);
    this.page.off("pageerror", this.pageErrorHandler);
  }
}
