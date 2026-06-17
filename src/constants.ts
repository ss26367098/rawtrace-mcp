export const PACKAGE_NAME = "rawtrace-mcp";
export const PACKAGE_VERSION = "0.2.0";
export const TRACE_SCHEMA_VERSION = "1.0.0";
export const MAX_READ_EVENTS_LIMIT = 1000;
export const DEFAULT_READ_EVENTS_LIMIT = 200;
export const DEFAULT_SEARCH_EVENTS_LIMIT = 100;
export const MAX_SEARCH_EVENTS_LIMIT = 1000;
export const DEFAULT_SEARCH_BODIES_LIMIT = 100;
export const MAX_SEARCH_BODIES_LIMIT = 1000;
export const DEFAULT_INSPECTION_MAX_BYTES = 64_000;
export const DEFAULT_GET_ELEMENTS_LIMIT = 100;
export const MAX_GET_ELEMENTS_LIMIT = 500;
export const DEFAULT_GET_NETWORK_LIMIT = 100;
export const MAX_GET_NETWORK_LIMIT = 1000;
export const DEFAULT_ACCESSIBILITY_LIMIT = 200;
export const MAX_ACCESSIBILITY_LIMIT = 1000;
export const DEFAULT_GET_FORMS_LIMIT = 100;
export const MAX_GET_FORMS_LIMIT = 500;
export const DEFAULT_GET_DOWNLOADS_LIMIT = 100;
export const MAX_GET_DOWNLOADS_LIMIT = 1000;
export const DEFAULT_MAX_BODY_BYTES = 20_000_000;
export const DOM_INLINE_TEXT_LIMIT = 4096;
export const DOM_INLINE_HTML_LIMIT = 8192;

export const EVENT_STREAMS = [
  "actions",
  "dom",
  "network",
  "cookies",
  "websocket",
  "console",
  "frames"
] as const;

export const RAW_CAPTURE_WARNING =
  "RawTrace MCP records raw browser data by design, including cookies, tokens, headers, request bodies, response bodies, WebSocket frames, form values, and DOM text. Use it only on systems and accounts you are authorized to inspect, and treat trace output as highly sensitive.";

export const DANGEROUS_EVAL_WARNING =
  "browser_eval executes arbitrary JavaScript in the active page or frame with full page privileges. It can read or modify DOM, storage, cookies available to page scripts, and trigger network requests. Use only on pages you are authorized to automate.";

export const CREDENTIAL_ACCESS_WARNING =
  "Credential state tools expose or modify raw cookies, localStorage, sessionStorage, and storageState data. Treat outputs as secrets and do not commit or share them.";

export const STORAGE_STATE_OVERWRITE_WARNING =
  "Applying Playwright storageState clears existing cookies, localStorage, and IndexedDB for the browser context before importing the new state. This can overwrite real logged-in browser profiles.";

export const FILE_ACCESS_WARNING =
  "File access tools can upload local files into the active page. Use only files you intend to provide to the target site.";

export const PERMISSION_CHANGE_WARNING =
  "Permission tools change browser context permissions for the active automation session. Grant only permissions needed for pages you are authorized to automate.";

export const LOCATION_ACCESS_WARNING =
  "Geolocation tools set the browser context location. Use only coordinates you intend to expose to the target site.";
