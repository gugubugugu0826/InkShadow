import { describe, expect, it } from "vitest";

import {
  inspectGovernedExtensionProviderUrl,
  isGovernedExtensionLoopbackHostname,
} from "../src/governed-extension-provider-url.js";

describe("governed extension provider URL classification", () => {
  it.each([
    "localhost",
    "localhost.",
    "models.localhost",
    "models.dev.localhost.",
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.254",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:7fff:ffff",
    "0:0:0:0:0:ffff:7f00:1",
  ])("classifies %s as loopback", (hostname) => {
    expect(isGovernedExtensionLoopbackHostname(hostname)).toBe(true);
  });

  it.each([
    "localhost.example",
    "notlocalhost",
    "126.255.255.255",
    "128.0.0.1",
    "::2",
    "::ffff:7e00:1",
    "::ffff:8000:1",
  ])("does not classify %s as loopback", (hostname) => {
    expect(isGovernedExtensionLoopbackHostname(hostname)).toBe(false);
  });

  it.each([
    "http://localhost.:11434/v1",
    "http://models.localhost:11434/v1",
    "http://127.42.1.9:11434/v1",
    "http://[::1]:11434/v1",
    "http://[::ffff:7f00:1]:11434/v1",
  ])("accepts canonical local URL %s only as loopback", (url) => {
    expect(inspectGovernedExtensionProviderUrl(url, "loopback")).toMatchObject({
      ok: true,
      isLoopback: true,
    });
    expect(inspectGovernedExtensionProviderUrl(url, "remote")).toMatchObject({ ok: false });
  });

  it("requires a canonical non-loopback HTTPS URL for remote egress", () => {
    expect(
      inspectGovernedExtensionProviderUrl("https://provider.example/v1", "remote"),
    ).toMatchObject({ ok: true, isLoopback: false });
    expect(
      inspectGovernedExtensionProviderUrl("http://provider.example/v1", "remote"),
    ).toMatchObject({ ok: false });
    expect(
      inspectGovernedExtensionProviderUrl("https://user@provider.example/v1", "remote"),
    ).toMatchObject({ ok: false });
    expect(
      inspectGovernedExtensionProviderUrl(
        "https://provider.example/v1?redirect=localhost",
        "remote",
      ),
    ).toMatchObject({ ok: false });
    expect(
      inspectGovernedExtensionProviderUrl("http://localhost..:11434/v1", "loopback"),
    ).toMatchObject({ ok: false });
  });
});
