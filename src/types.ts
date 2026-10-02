export type Source = 'dom' | 'network' | 'websocket' | 'cookies' | 'console' | 'frames' | 'system';
export interface ArtifactRef { path: string; sha256: string; byteLength: number }
export interface EventInput {
  source: Source; type: string; pageId?: string; frameId?: string; documentId?: string;
  contextId?: string; sourceSeq?: number; sourceTime?: number;
  clock?: { kind: string; offsetMs: number; uncertaintyMs?: number }; data: any;
}
export interface TraceEvent extends EventInput { sessionId: string; seq: number; receivedAt: number; time: number }
export interface CaptureOptions {
  captureDom: boolean; captureNetwork: boolean; captureWebSockets: boolean;
  captureCookies: boolean; captureConsole: boolean; captureFrames: boolean; maxBodyBytes: number;
}
export interface Target { targetId: string; url: string; title: string; contextId: string }
export interface Manifest {
  traceSchemaVersion: '2.0.0'; sessionId: string; createdAt: number; stoppedAt?: number;
  status: 'running' | 'stopped' | 'interrupted' | 'failed'; reason?: string;
  targets: Target[]; options: CaptureOptions; eventCount: number; bytes: number;
  counts: Partial<Record<Source, number>>; gapCount: number;
  cookieScope: string; cookieIntervalMs: number; recorderVersion: string;
}
export interface EventQuery {
  afterSeq?: number; untilSeq?: number; fromTime?: number; toTime?: number;
  source?: Source; type?: string; pageId?: string; documentId?: string; nodeId?: number;
  urlContains?: string; text?: string; searchBodies?: boolean; limit?: number;
}
export const defaults: CaptureOptions = {
  captureDom: true, captureNetwork: true, captureWebSockets: true, captureCookies: true,
  captureConsole: true, captureFrames: true, maxBodyBytes: 20_000_000
};
