import { describe, expect, it } from "vitest";
import { RawTraceError } from "../../src/errors.js";
import { RawTraceRuntime, normalizeCaptureOptions } from "../../src/runtime/browserRuntime.js";

describe("runtime safety", () => {
  it("requires explicit raw capture acknowledgement", async () => {
    const runtime = new RawTraceRuntime();
    await expect(runtime.monitorStart({})).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
  });

  it("requires explicit raw acknowledgement for inspection tools", async () => {
    const runtime = new RawTraceRuntime();

    await expect(runtime.browserGetState({})).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserGetDom({})).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserGetElements({})).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserScreenshot({})).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.monitorSearchBodies({ text: "token" })).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserGetAccessibility({})).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserEval({ expression: "1 + 1" })).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserGetCookies({})).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.monitorReadArtifact({ path: "bodies/test.txt" })).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserWaitForResponseBody({ urlContains: "/api" })).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserGetForms({})).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserSnapshot({})).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserPollUntil({ conditions: [{ type: "text", text: "ready" }] })).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserScreenshotAnnotated({ selector: "#submit" })).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(
      runtime.browserObserveActionResult({
        action: { type: "click", selector: "#submit" }
      })
    ).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
  });

  it("requires explicit dangerous eval, credential, file, permission, and location acknowledgements", async () => {
    const runtime = new RawTraceRuntime();

    await expect(runtime.browserEval({ acknowledgeRawCapture: true, expression: "1 + 1" })).rejects.toMatchObject({
      code: "DANGEROUS_EVAL_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(
      runtime.browserObserveActionResult({
        acknowledgeRawCapture: true,
        action: { type: "eval", expression: "1 + 1" }
      })
    ).rejects.toMatchObject({
      code: "DANGEROUS_EVAL_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserGetCookies({ acknowledgeRawCapture: true })).rejects.toMatchObject({
      code: "CREDENTIAL_ACCESS_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserUploadFile({ selector: "#file", paths: ["demo.txt"] })).rejects.toMatchObject({
      code: "FILE_ACCESS_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserGrantPermissions({ permissions: ["geolocation"] })).rejects.toMatchObject({
      code: "PERMISSION_CHANGE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserSetGeolocation({ latitude: 1, longitude: 2 })).rejects.toMatchObject({
      code: "LOCATION_ACCESS_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserLaunch({ headless: true, storageStatePath: "state.json" })).rejects.toMatchObject({
      code: "RAW_CAPTURE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(runtime.browserLaunch({ headless: true, storageStatePath: "state.json", acknowledgeRawCapture: true })).rejects.toMatchObject({
      code: "CREDENTIAL_ACCESS_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(
      runtime.browserLaunch({
        headless: true,
        userDataDir: "profile",
        storageStatePath: "state.json",
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true
      })
    ).rejects.toMatchObject({
      code: "STORAGE_STATE_OVERWRITE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
    await expect(
      runtime.browserLaunch({
        cdpUrl: "http://127.0.0.1:1",
        storageStatePath: "state.json",
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true
      })
    ).rejects.toMatchObject({
      code: "STORAGE_STATE_OVERWRITE_ACK_REQUIRED"
    } satisfies Partial<RawTraceError>);
  });

  it("normalizes capture options to raw-first defaults", () => {
    expect(normalizeCaptureOptions({ acknowledgeRawCapture: true })).toMatchObject({
      captureDom: true,
      captureNetwork: true,
      captureCookies: true,
      captureBodies: true,
      captureWebSockets: true,
      captureConsole: true,
      captureFrames: true
    });
  });
});
