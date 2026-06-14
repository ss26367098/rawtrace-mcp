import type { TraceEvent } from "../types.js";
import type { EventCounts } from "../types.js";
import type { TraceSession } from "./session.js";

export interface TraceSummary {
  sessionId: string;
  outputDir: string;
  eventCounts: EventCounts;
  highlights: string[];
  requests: Array<{ method?: string; url?: string; status?: number; requestId?: string; t: number }>;
  cookieChanges: Array<{ type: string; label?: string; changed?: number; added?: number; removed?: number; t: number }>;
  domMutationClusters: Array<{ startT: number; endT: number; count: number; sampleTypes: string[] }>;
  errors: string[];
}

export async function summarizeTrace(session: TraceSession): Promise<TraceSummary> {
  let firstAction: TraceEvent | undefined;
  const requests: TraceSummary["requests"] = [];
  const cookieChanges: TraceSummary["cookieChanges"] = [];
  const consoleErrors: string[] = [];
  const domClusters = new DomClusterBuilder();

  for await (const event of session.iterateEvents("all")) {
    if (!firstAction && event.source === "actions") {
      firstAction = event;
    }

    if (event.source === "network" && requests.length < 50 && (event.type === "requestWillBeSent" || event.type === "responseReceived")) {
      requests.push({
        method: stringField(event, "method"),
        url: stringField(event, "url"),
        status: numberField(event, "status"),
        requestId: stringField(event, "requestId"),
        t: event.t
      });
    }

    if (event.source === "cookies" && cookieChanges.length < 50 && (event.type === "diff" || event.type === "snapshot")) {
      cookieChanges.push({
        type: event.type,
        label: stringField(event, "label"),
        changed: arrayLength(event.changed),
        added: arrayLength(event.added),
        removed: arrayLength(event.removed),
        t: event.t
      });
    }

    if (event.source === "console" && consoleErrors.length < 20 && (event.type === "pageerror" || event.level === "error")) {
      consoleErrors.push(String(event.text ?? event.message ?? event.type));
    }

    if (event.source === "dom") {
      domClusters.add(event);
    }
  }

  const domMutationClusters = domClusters.finish();
  const highlights = buildHighlights(firstAction, requests, domMutationClusters, cookieChanges);

  return {
    sessionId: session.sessionId,
    outputDir: session.outputDir,
    eventCounts: session.manifest().eventCounts,
    highlights,
    requests,
    cookieChanges,
    domMutationClusters,
    errors: consoleErrors
  };
}

function buildHighlights(
  firstAction: TraceEvent | undefined,
  requests: TraceSummary["requests"],
  domMutationClusters: TraceSummary["domMutationClusters"],
  cookieChanges: TraceSummary["cookieChanges"]
): string[] {
  const highlights: string[] = [];
  if (firstAction) {
    highlights.push(`First action ${firstAction.type} started at +${firstAction.t}ms.`);
  }
  const firstRequest = requests.find((request) => request.url);
  if (firstRequest) {
    highlights.push(`${firstRequest.method ?? "REQUEST"} ${firstRequest.url} observed at +${firstRequest.t}ms.`);
  }
  const firstDomCluster = domMutationClusters[0];
  if (firstDomCluster) {
    highlights.push(
      `${firstDomCluster.count} DOM events clustered from +${firstDomCluster.startT}ms to +${firstDomCluster.endT}ms.`
    );
  }
  const firstCookieChange = cookieChanges.find((change) => (change.added ?? 0) + (change.changed ?? 0) + (change.removed ?? 0) > 0);
  if (firstCookieChange) {
    highlights.push(`Cookie ${firstCookieChange.label ?? "diff"} recorded at +${firstCookieChange.t}ms.`);
  }
  if (highlights.length === 0) {
    highlights.push("Trace contains no high-level events yet.");
  }
  return highlights;
}

class DomClusterBuilder {
  private readonly clusters: TraceSummary["domMutationClusters"] = [];
  private currentStart?: TraceEvent;
  private currentLast?: TraceEvent;
  private currentCount = 0;
  private currentSampleTypes: string[] = [];

  add(event: TraceEvent): void {
    if (!this.currentLast || event.t - this.currentLast.t <= 100) {
      this.addToCurrent(event);
      return;
    }

    this.pushCurrent();
    this.addToCurrent(event);
  }

  finish(): TraceSummary["domMutationClusters"] {
    this.pushCurrent();
    return this.clusters;
  }

  private addToCurrent(event: TraceEvent): void {
    this.currentStart ??= event;
    this.currentLast = event;
    this.currentCount += 1;
    if (this.currentSampleTypes.length < 5 && !this.currentSampleTypes.includes(event.type)) {
      this.currentSampleTypes.push(event.type);
    }
  }

  private pushCurrent(): void {
    if (!this.currentStart || !this.currentLast) {
      return;
    }
    if (this.clusters.length < 20) {
      this.clusters.push({
        startT: this.currentStart.t,
        endT: this.currentLast.t,
        count: this.currentCount,
        sampleTypes: [...this.currentSampleTypes]
      });
    }
    this.currentStart = undefined;
    this.currentLast = undefined;
    this.currentCount = 0;
    this.currentSampleTypes = [];
  }
}

function stringField(event: TraceEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(event: TraceEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === "number" ? value : undefined;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}
