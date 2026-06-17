import type { EVENT_STREAMS } from "./constants.js";

export type EventStream = (typeof EVENT_STREAMS)[number];

export interface BrowserLaunchInput {
  headless?: boolean;
  userDataDir?: string;
  cdpUrl?: string;
  storageStatePath?: string;
  acknowledgeRawCapture?: boolean;
  acknowledgeCredentialAccess?: boolean;
  acknowledgeStorageStateOverwrite?: boolean;
}

export interface CaptureOptions {
  captureDom: boolean;
  captureNetwork: boolean;
  captureCookies: boolean;
  captureBodies: boolean;
  captureWebSockets: boolean;
  captureConsole: boolean;
  captureFrames: boolean;
  maxBodyBytes?: number;
  outputDir?: string;
}

export interface MonitorStartInput extends Partial<CaptureOptions> {
  acknowledgeRawCapture?: boolean;
}

export interface EventCounts {
  actions: number;
  dom: number;
  network: number;
  cookies: number;
  websocket: number;
  console: number;
  frames: number;
}

export interface BodyRef {
  path: string;
  byteLength: number;
  sha256: string;
  encoding: "utf8" | "base64" | "binary";
}

export interface RawCaptureAcknowledgementInput {
  acknowledgeRawCapture?: boolean;
}

export interface DangerousEvalAcknowledgementInput extends RawCaptureAcknowledgementInput {
  acknowledgeDangerousEval?: boolean;
}

export interface CredentialAccessAcknowledgementInput extends RawCaptureAcknowledgementInput {
  acknowledgeCredentialAccess?: boolean;
}

export interface FileAccessAcknowledgementInput {
  acknowledgeFileAccess?: boolean;
}

export interface PermissionChangeAcknowledgementInput {
  acknowledgePermissionChange?: boolean;
}

export interface LocationAccessAcknowledgementInput {
  acknowledgeLocationAccess?: boolean;
}

export interface TraceEvent {
  sessionId: string;
  seq: number;
  source: EventStream;
  type: string;
  timeOrigin: number;
  t: number;
  wallTime: string;
  pageUrl: string;
  [key: string]: unknown;
}

export interface TraceManifest {
  traceSchemaVersion: "1.0.0";
  sessionId: string;
  createdAt: string;
  stoppedAt?: string;
  status: "running" | "stopped";
  captureOptions: CaptureOptions;
  eventCounts: EventCounts;
  streams: EventStream[];
  outputDir: string;
}

export interface ReadEventsInput {
  sessionId?: string;
  stream: EventStream | "all";
  offset?: number;
  limit?: number;
}

export interface MonitorGetManifestInput {
  sessionId?: string;
}

export interface MonitorReadArtifactInput extends RawCaptureAcknowledgementInput {
  sessionId?: string;
  path?: string;
  ref?: BodyRef;
  maxBytes?: number;
  asText?: boolean;
  parseJson?: boolean;
}

export interface SearchEventsInput {
  sessionId?: string;
  stream?: EventStream | "all";
  text?: string;
  urlContains?: string;
  type?: string;
  sinceSeq?: number;
  limit?: number;
}

export type BrowserGetStateInput = RawCaptureAcknowledgementInput;

export interface BrowserGetDomInput extends RawCaptureAcknowledgementInput {
  selector?: string;
  mode?: "html" | "text" | "both";
  maxBytes?: number;
}

export interface BrowserGetElementsInput extends RawCaptureAcknowledgementInput {
  selector?: string;
  textContains?: string;
  limit?: number;
}

export interface BrowserOptimizeSelectorInput extends RawCaptureAcknowledgementInput {
  selector: string;
  targetIndex?: number;
  textContains?: string;
  role?: string;
  name?: string;
  candidateLimit?: number;
  includeRejected?: boolean;
}

export interface BrowserScreenshotInput extends RawCaptureAcknowledgementInput {
  selector?: string;
  fullPage?: boolean;
  outputPath?: string;
}

export interface BrowserPressInput {
  key: string;
  selector?: string;
  delayMs?: number;
  timeoutMs?: number;
}

export interface BrowserHoverInput {
  selector: string;
  timeoutMs?: number;
}

export interface BrowserScrollInput {
  selector?: string;
  deltaX?: number;
  deltaY?: number;
  timeoutMs?: number;
}

export type BrowserSelectOptionValue =
  | string
  | {
      value?: string;
      label?: string;
      index?: number;
    };

export interface BrowserSelectOptionInput {
  selector: string;
  values: BrowserSelectOptionValue | BrowserSelectOptionValue[];
  timeoutMs?: number;
}

export interface BrowserCheckInput {
  selector: string;
  checked?: boolean;
  timeoutMs?: number;
}

export interface BrowserWaitForResponseInput {
  urlContains?: string;
  urlRegex?: string;
  method?: string;
  status?: number;
  timeoutMs?: number;
}

export interface BrowserWaitForResponseBodyInput extends RawCaptureAcknowledgementInput, BrowserWaitForResponseInput {
  maxBytes?: number;
  parseJson?: boolean;
}

export interface BrowserUploadFileInput extends FileAccessAcknowledgementInput {
  selector: string;
  paths: string[];
  timeoutMs?: number;
}

export interface BrowserWaitForDownloadInput extends RawCaptureAcknowledgementInput {
  triggerSelector?: string;
  timeoutMs?: number;
  outputDir?: string;
  suggestedFilename?: string;
}

export interface BrowserGetDownloadsInput {
  limit?: number;
}

export interface BrowserSetViewportInput {
  width: number;
  height: number;
}

export interface BrowserGrantPermissionsInput extends PermissionChangeAcknowledgementInput {
  permissions: string[];
  origin?: string;
}

export interface BrowserSetGeolocationInput extends LocationAccessAcknowledgementInput {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export interface BrowserHandleDialogInput {
  action: "accept" | "dismiss";
  promptText?: string;
  once?: boolean;
}

export interface BrowserGetNetworkInput {
  sessionId?: string;
  urlContains?: string;
  method?: string;
  status?: number;
  sinceSeq?: number;
  limit?: number;
}

export interface BrowserGetAccessibilityInput extends RawCaptureAcknowledgementInput {
  selector?: string;
  textContains?: string;
  limit?: number;
}

export interface BrowserGetFormsInput extends RawCaptureAcknowledgementInput {
  selector?: string;
  textContains?: string;
  limit?: number;
  maxBytes?: number;
}

export type BrowserFillFormValue = string | number | boolean | string[] | null;

export interface BrowserFillFormFieldInput {
  selector?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  value?: BrowserFillFormValue;
  checked?: boolean;
}

export interface BrowserFillFormInput {
  fields: BrowserFillFormFieldInput[];
  submitSelector?: string;
  timeoutMs?: number;
}

export interface BrowserEvalInput extends DangerousEvalAcknowledgementInput {
  expression: string;
  arg?: unknown;
  frameUrlContains?: string;
  frameName?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface BrowserGetCookiesInput extends CredentialAccessAcknowledgementInput {
  urls?: string[];
}

export interface BrowserSetCookiesInput extends CredentialAccessAcknowledgementInput {
  cookies: Array<Record<string, unknown>>;
}

export interface BrowserClearCookiesInput extends CredentialAccessAcknowledgementInput {
  name?: string;
  domain?: string;
  path?: string;
}

export interface BrowserGetStorageInput extends CredentialAccessAcknowledgementInput {
  origin?: string;
  includeSessionStorage?: boolean;
  maxBytes?: number;
}

export interface BrowserSetStorageInput extends CredentialAccessAcknowledgementInput {
  origin?: string;
  localStorage?: Record<string, string | null>;
  sessionStorage?: Record<string, string | null>;
}

export interface BrowserExportStorageStateInput extends CredentialAccessAcknowledgementInput {
  outputPath?: string;
  indexedDB?: boolean;
  maxBytes?: number;
}

export interface BrowserImportStorageStateInput extends CredentialAccessAcknowledgementInput {
  path: string;
  acknowledgeStorageStateOverwrite?: boolean;
}

export interface SearchBodiesInput extends RawCaptureAcknowledgementInput {
  sessionId?: string;
  text: string;
  urlContains?: string;
  method?: string;
  status?: number;
  sinceSeq?: number;
  limit?: number;
}

export interface SearchEventMatch {
  seq: number;
  source: EventStream;
  type: string;
  t: number;
  wallTime: string;
  pageUrl: string;
  preview: Record<string, unknown>;
  snippet?: string;
}

export interface SearchBodyMatch {
  seq: number;
  type: string;
  t: number;
  wallTime: string;
  pageUrl: string;
  requestId?: string;
  url?: string;
  method?: string;
  status?: number;
  bodyRef: BodyRef;
  snippet: string;
}

export interface Recorder {
  start(): Promise<void>;
  stop(): Promise<void>;
}
