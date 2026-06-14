import type { Page } from "playwright";
import type { Recorder } from "../types.js";
import type { TraceSession } from "../trace/session.js";

export class DomRecorder implements Recorder {
  private readonly bindingName: string;
  private active = false;

  constructor(
    private readonly page: Page,
    private readonly session: TraceSession
  ) {
    this.bindingName = `__rawtraceEmitDomEvent_${session.sessionId.replaceAll("-", "_")}`;
  }

  async start(): Promise<void> {
    this.active = true;
    await this.page.exposeBinding(this.bindingName, async (source, eventOrEvents: unknown) => {
      if (!this.active) {
        return;
      }
      const events = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];
      for (const event of events) {
        if (!isRecord(event)) {
          continue;
        }
        await this.session.append("dom", String(event.type ?? "dom"), {
          ...event,
          pageUrl: source.page.url(),
          frameUrl: source.frame.url()
        });
      }
    });

    const script = buildDomRecorderScript(this.session.sessionId, this.bindingName);
    await this.page.addInitScript(script);
    await this.page.evaluate(script).catch(() => undefined);
  }

  async stop(): Promise<void> {
    const stopName = `__rawtraceStopDomRecorder_${this.session.sessionId.replaceAll("-", "_")}`;
    await this.page.evaluate(async (name) => {
      const maybeStop = (globalThis as Record<string, unknown>)[name];
      if (typeof maybeStop === "function") {
        await (maybeStop as () => unknown)();
      }
    }, stopName).catch(() => undefined);
    this.active = false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildDomRecorderScript(sessionId: string, bindingName: string): string {
  return `
(() => {
  const sessionId = ${JSON.stringify(sessionId)};
  const bindingName = ${JSON.stringify(bindingName)};
  const stateKey = "__rawtraceDomRecorder_" + sessionId.replaceAll("-", "_");
  const stopKey = "__rawtraceStopDomRecorder_" + sessionId.replaceAll("-", "_");
  if (window[stateKey]) return;

  const queue = [];
  let flushTimer = 0;
  const flushDelayMs = 50;
  const maxBatchSize = 100;

  const flushQueue = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = 0;
    }
    if (queue.length === 0) return Promise.resolve();
    const events = queue.splice(0).map((queued) => ({
      ...queued,
      pageHref: location.href,
      pageTitle: document.title
    }));
    const binding = window[bindingName];
    if (typeof binding === "function") {
      return Promise.resolve(binding(events)).catch(() => {});
    }
    return Promise.resolve();
  };

  const enqueue = (event) => {
    queue.push(event);
    if (queue.length >= maxBatchSize) {
      void flushQueue();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        void flushQueue();
      }, flushDelayMs);
    }
  };

  const emit = (event) => {
    enqueue(event);
  };

  const pathFor = (node) => {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) {
      return pathFor(node.parentElement) + " > #text";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return node.nodeName;
    }
    const parts = [];
    let current = node;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = current.localName;
      if (current.id) {
        part += "#" + current.id;
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };

  const summarizeNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return {
        nodeType: "text",
        path: pathFor(node),
        text: node.textContent
      };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return {
        nodeType: node.nodeName,
        text: node.textContent
      };
    }
    const element = node;
    const attrs = {};
    for (const attr of Array.from(element.attributes)) {
      attrs[attr.name] = attr.value;
    }
    return {
      nodeType: "element",
      tagName: element.tagName,
      path: pathFor(element),
      attributes: attrs,
      text: element.textContent,
      outerHTML: element.outerHTML
    };
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      emit({
        type: mutation.type,
        targetPath: pathFor(mutation.target),
        attributeName: mutation.attributeName ?? undefined,
        oldValue: mutation.oldValue ?? undefined,
        addedNodes: Array.from(mutation.addedNodes).map(summarizeNode),
        removedNodes: Array.from(mutation.removedNodes).map(summarizeNode),
        textValue: mutation.type === "characterData" ? mutation.target.data : undefined,
        t: performance.now()
      });
    }
  });

  const inputHandler = (event) => {
    const target = event.target;
    emit({
      type: event.type,
      targetPath: pathFor(target),
      value: target && "value" in target ? target.value : undefined,
      checked: target && "checked" in target ? target.checked : undefined,
      t: performance.now()
    });
  };

  const scrollHandler = (event) => {
    const target = event.target === document ? document.documentElement : event.target;
    emit({
      type: "scroll",
      targetPath: pathFor(target),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      t: performance.now()
    });
  };

  const emitLocationChange = (type) => emit({ type, url: location.href, t: performance.now() });
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    emitLocationChange("history.pushState");
    return result;
  };
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    emitLocationChange("history.replaceState");
    return result;
  };

  observer.observe(document.documentElement || document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    attributeOldValue: true,
    characterDataOldValue: true
  });
  document.addEventListener("input", inputHandler, true);
  document.addEventListener("change", inputHandler, true);
  document.addEventListener("scroll", scrollHandler, true);
  window.addEventListener("hashchange", () => emitLocationChange("hashchange"), true);
  window.addEventListener("popstate", () => emitLocationChange("popstate"), true);

  window[stateKey] = true;
  window[stopKey] = async () => {
    await flushQueue();
    observer.disconnect();
    document.removeEventListener("input", inputHandler, true);
    document.removeEventListener("change", inputHandler, true);
    document.removeEventListener("scroll", scrollHandler, true);
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window[stateKey] = false;
  };
})();
`;
}
