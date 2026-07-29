export type GovernedExtensionProviderUrlLocation = "loopback" | "remote";

export type GovernedExtensionProviderUrlInspection =
  | {
      readonly ok: true;
      readonly canonicalUrl: string;
      readonly canonicalHostname: string;
      readonly isLoopback: boolean;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

/**
 * Performs the shared, deterministic URL-string boundary used by both the
 * desktop preflight and the durable store.
 *
 * This is not complete SSRF protection. The native network gateway must also
 * resolve every connection target and reject private, link-local, loopback and
 * otherwise disallowed addresses at connect time (including every redirect)
 * so DNS rebinding cannot bypass this string-level classification.
 */
export function inspectGovernedExtensionProviderUrl(
  value: string,
  location: GovernedExtensionProviderUrlLocation,
): GovernedExtensionProviderUrlInspection {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "The provider base URL is invalid." };
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname.includes("..") ||
    url.hostname.endsWith("..") ||
    url.toString() !== value
  ) {
    return {
      ok: false,
      message: "The provider base URL must be canonical and contain no credentials or query.",
    };
  }
  const canonicalHostname = canonicalizeGovernedProviderHostname(url.hostname);
  const loopback = isGovernedExtensionLoopbackHostname(canonicalHostname);
  if (location === "remote" && (url.protocol !== "https:" || loopback)) {
    return {
      ok: false,
      message: "Remote plaintext egress requires a non-loopback HTTPS destination.",
    };
  }
  if (
    location === "loopback" &&
    (!loopback || (url.protocol !== "http:" && url.protocol !== "https:"))
  ) {
    return {
      ok: false,
      message: "A local provider destination must use HTTP(S) and an explicit loopback host.",
    };
  }
  return {
    ok: true,
    canonicalUrl: value,
    canonicalHostname,
    isLoopback: loopback,
  };
}

export function canonicalizeGovernedProviderHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.+$/u, "");
}

export function isGovernedExtensionLoopbackHostname(hostname: string): boolean {
  const canonical = canonicalizeGovernedProviderHostname(hostname);
  if (
    canonical === "localhost" ||
    canonical.endsWith(".localhost") ||
    canonical === "::1" ||
    canonical === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  if (isIpv4Loopback(canonical)) {
    return true;
  }
  return isIpv4MappedIpv6Loopback(canonical);
}

function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) {
    return false;
  }
  const numbers = octets.map(Number);
  return (
    numbers.every(
      (value, index) =>
        Number.isInteger(value) && value >= 0 && value <= 255 && String(value) === octets[index],
    ) && numbers[0] === 127
  );
}

function isIpv4MappedIpv6Loopback(hostname: string): boolean {
  const canonical = hostname.replace(/^0:0:0:0:0:ffff:/u, "::ffff:");
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(canonical);
  if (dotted !== null) {
    return isIpv4Loopback(dotted[1] ?? "");
  }
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
  if (hexadecimal === null) {
    return false;
  }
  const upper = Number.parseInt(hexadecimal[1] ?? "", 16);
  const lower = Number.parseInt(hexadecimal[2] ?? "", 16);
  return (
    Number.isInteger(upper) &&
    Number.isInteger(lower) &&
    upper >= 0 &&
    upper <= 0xffff &&
    lower >= 0 &&
    lower <= 0xffff &&
    upper >> 8 === 127
  );
}
