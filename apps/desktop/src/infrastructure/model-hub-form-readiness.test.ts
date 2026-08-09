import { describe, expect, it } from "vitest";

import { resolveModelHubFormReadiness } from "./model-hub-form-readiness";

const readyInput = {
  busy: false,
  nativeGatewayAvailable: true,
  online: true,
  endpointCanRunOffline: false,
  providerId: "deepseek",
  baseUrl: "https://api.deepseek.com",
  connectionFieldsValid: true,
  authenticationRequired: true,
  storedCredentialConfigured: true,
  newlyEnteredCredentialValid: false,
  automaticDiscovery: true,
  selectedModelId: "deepseek-chat",
  endpointModelId: "",
  connectionReady: true,
} as const;

describe("resolveModelHubFormReadiness", () => {
  it("accepts a stored system credential when the visible key field is empty", () => {
    const readiness = resolveModelHubFormReadiness(readyInput);

    expect(readiness.credentialAvailable).toBe(true);
    expect(readiness.save.enabled).toBe(true);
    expect(readiness.discover.enabled).toBe(true);
    expect(readiness.verify.enabled).toBe(true);
  });

  it("accepts a newly entered key before a separate credential save", () => {
    const readiness = resolveModelHubFormReadiness({
      ...readyInput,
      storedCredentialConfigured: false,
      newlyEnteredCredentialValid: true,
      connectionReady: false,
    });

    expect(readiness.save.enabled).toBe(true);
    expect(readiness.discover.enabled).toBe(true);
    expect(readiness.verify.blockers.map(({ code }) => code)).toEqual(["CONNECTION_NOT_READY"]);
  });

  it("does not depend on pricing, context-window, capability, evaluation, or routing metadata", () => {
    const readiness = resolveModelHubFormReadiness(readyInput);

    expect(readiness.save.blockers).toEqual([]);
    expect(readiness.discover.blockers).toEqual([]);
    expect(readiness.verify.blockers).toEqual([]);
  });

  it("reports the exact missing credential and manual model requirements", () => {
    const readiness = resolveModelHubFormReadiness({
      ...readyInput,
      storedCredentialConfigured: false,
      automaticDiscovery: false,
      selectedModelId: "",
      connectionReady: false,
    });

    expect(readiness.save.blockers.map(({ code }) => code)).toEqual(["CREDENTIAL_REQUIRED"]);
    expect(readiness.discover.blockers.map(({ code }) => code)).toEqual([
      "CREDENTIAL_REQUIRED",
      "MANUAL_MODEL_ID_REQUIRED",
    ]);
    expect(readiness.verify.blockers.map(({ code }) => code)).toEqual([
      "CREDENTIAL_REQUIRED",
      "CONNECTION_NOT_READY",
      "TEXT_MODEL_REQUIRED",
    ]);
  });
});
