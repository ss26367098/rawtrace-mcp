export class RawTraceError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "RawTraceError";
    this.code = code;
    this.details = details;
  }
}

export function asRawTraceError(error: unknown): RawTraceError {
  if (error instanceof RawTraceError) {
    return error;
  }

  if (error instanceof Error) {
    return new RawTraceError("RAWTRACE_ERROR", error.message);
  }

  return new RawTraceError("RAWTRACE_ERROR", String(error));
}
