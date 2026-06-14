import type { BrowserContext, Cookie } from "playwright";
import type { TraceSession } from "../trace/session.js";

export class CookieRecorder {
  private previous: Cookie[] = [];

  constructor(
    private readonly context: BrowserContext,
    private readonly session: TraceSession
  ) {}

  async snapshot(label: string): Promise<void> {
    const cookies = await this.context.cookies();
    this.previous = cookies;
    await this.session.append("cookies", "snapshot", {
      label,
      cookies
    });
  }

  async diff(label: string): Promise<void> {
    const current = await this.context.cookies();
    const previousMap = new Map(this.previous.map((cookie) => [cookieKey(cookie), cookie]));
    const currentMap = new Map(current.map((cookie) => [cookieKey(cookie), cookie]));
    const added: Cookie[] = [];
    const removed: Cookie[] = [];
    const changed: Array<{ before: Cookie; after: Cookie }> = [];

    for (const [key, cookie] of currentMap) {
      const before = previousMap.get(key);
      if (!before) {
        added.push(cookie);
      } else if (JSON.stringify(before) !== JSON.stringify(cookie)) {
        changed.push({ before, after: cookie });
      }
    }

    for (const [key, cookie] of previousMap) {
      if (!currentMap.has(key)) {
        removed.push(cookie);
      }
    }

    this.previous = current;
    await this.session.append("cookies", "diff", {
      label,
      added,
      removed,
      changed
    });
  }
}

function cookieKey(cookie: Cookie): string {
  return `${cookie.name};${cookie.domain};${cookie.path}`;
}
