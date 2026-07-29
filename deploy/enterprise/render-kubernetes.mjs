import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const argumentsByName = parseArguments(process.argv.slice(2));
const required = [
  "image",
  "namespace",
  "public-host",
  "tls-secret",
  "trusted-proxy-cidrs",
  "ingress-namespace",
  "monitoring-namespace",
  "database-cidr",
  "https-egress-cidrs",
  "output",
];
const allowed = new Set([
  ...required,
  "replicas",
  "max-replicas",
  "cpu-request",
  "memory-request",
  "cpu-limit",
  "memory-limit",
]);
for (const name of argumentsByName.keys()) {
  if (!allowed.has(name)) {
    fail(`Unsupported --${name}.`);
  }
}
for (const name of required) {
  if (!argumentsByName.has(name)) {
    fail(`Missing --${name}.`);
  }
}

const image = value("image");
if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/u.test(image)) {
  fail("--image must be an immutable OCI reference ending in @sha256:<64 lowercase hex>.");
}
const namespace = dnsLabel(value("namespace"), "namespace");
const publicHost = dnsName(value("public-host"), "public-host");
const tlsSecret = dnsLabel(value("tls-secret"), "tls-secret");
const ingressNamespace = dnsLabel(value("ingress-namespace"), "ingress-namespace");
const monitoringNamespace = dnsLabel(value("monitoring-namespace"), "monitoring-namespace");
const trustedProxyCidrs = cidrList(value("trusted-proxy-cidrs"), "trusted-proxy-cidrs").join(",");
const databaseCidr = singleCidr(value("database-cidr"), "database-cidr");
const httpsEgressCidrs = cidrList(value("https-egress-cidrs"), "https-egress-cidrs");
const replicas = boundedInteger(argumentsByName.get("replicas") ?? "2", "replicas", 2, 20);
const maximumReplicas = boundedInteger(
  argumentsByName.get("max-replicas") ?? "6",
  "max-replicas",
  replicas,
  50,
);
const resources = {
  __CPU_REQUEST__: cpuResource(argumentsByName.get("cpu-request") ?? "250m", "cpu-request"),
  __MEMORY_REQUEST__: memoryResource(
    argumentsByName.get("memory-request") ?? "512Mi",
    "memory-request",
  ),
  __CPU_LIMIT__: cpuResource(argumentsByName.get("cpu-limit") ?? "2", "cpu-limit"),
  __MEMORY_LIMIT__: memoryResource(argumentsByName.get("memory-limit") ?? "2Gi", "memory-limit"),
};
if (
  cpuMillis(resources.__CPU_REQUEST__) > cpuMillis(resources.__CPU_LIMIT__) ||
  memoryMebibytes(resources.__MEMORY_REQUEST__) > memoryMebibytes(resources.__MEMORY_LIMIT__)
) {
  fail("Resource requests cannot exceed their corresponding limits.");
}

const template = await readFile(
  path.join(scriptDirectory, "kubernetes", "inkshadow-enterprise.yaml.template"),
  "utf8",
);
const replacements = new Map([
  ["__IMAGE__", image],
  ["__NAMESPACE__", namespace],
  ["__PUBLIC_HOST__", publicHost],
  ["__TLS_SECRET__", tlsSecret],
  ["__TRUSTED_PROXY_CIDRS__", trustedProxyCidrs],
  ["__INGRESS_NAMESPACE__", ingressNamespace],
  ["__MONITORING_NAMESPACE__", monitoringNamespace],
  ["__REPLICAS__", String(replicas)],
  ["__MAX_REPLICAS__", String(maximumReplicas)],
  ["__EGRESS_RULES__", renderEgressRules(databaseCidr, httpsEgressCidrs)],
  ...Object.entries(resources),
]);
let rendered = template;
for (const [token, replacement] of replacements) {
  rendered = rendered.replaceAll(token, replacement);
}
if (/__[A-Z0-9_]+__/u.test(rendered)) {
  fail("The Kubernetes template still contains unresolved values.");
}
const output = path.resolve(value("output"));
await writeFile(output, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
process.stdout.write(`Rendered ${output}\n`);

function renderEgressRules(database, httpsCidrs) {
  const rules = [
    "    - to:",
    "        - ipBlock:",
    `            cidr: ${database}`,
    "      ports:",
    "        - protocol: TCP",
    "          port: 5432",
    "    - to:",
  ];
  for (const cidr of httpsCidrs) {
    rules.push("        - ipBlock:", `            cidr: ${cidr}`);
  }
  rules.push("      ports:", "        - protocol: TCP", "          port: 443");
  return rules.join("\n");
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const candidate = values[index + 1];
    if (!name?.startsWith("--") || candidate === undefined || candidate.startsWith("--")) {
      fail("Arguments must use --name value pairs.");
    }
    const normalized = name.slice(2);
    if (parsed.has(normalized)) {
      fail(`Duplicate --${normalized}.`);
    }
    parsed.set(normalized, candidate);
  }
  return parsed;
}

function value(name) {
  const candidate = argumentsByName.get(name);
  if (candidate === undefined) {
    fail(`Missing --${name}.`);
  }
  return candidate;
}

function dnsLabel(candidate, label) {
  if (candidate.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(candidate)) {
    fail(`--${label} must be a Kubernetes DNS label.`);
  }
  return candidate;
}

function dnsName(candidate, label) {
  if (
    candidate.length > 253 ||
    !candidate.includes(".") ||
    candidate.split(".").some((part) => dnsLabelValueInvalid(part))
  ) {
    fail(`--${label} must be a fully-qualified DNS name.`);
  }
  return candidate;
}

function dnsLabelValueInvalid(candidate) {
  return (
    candidate.length < 1 ||
    candidate.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(candidate)
  );
}

function cidrList(candidate, label) {
  const values = candidate.split(",").map((entry) => singleCidr(entry.trim(), label));
  if (values.length < 1 || values.length > 32 || new Set(values).size !== values.length) {
    fail(`--${label} must contain 1-32 unique CIDRs.`);
  }
  return values.sort();
}

function singleCidr(candidate, label) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/u.exec(candidate);
  if (
    match === null ||
    match
      .slice(1, 5)
      .some((part) => Number(part) > 255 || (part.length > 1 && part.startsWith("0")))
  ) {
    fail(`--${label} currently accepts canonical IPv4 CIDRs only.`);
  }
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  const address =
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if ((address & mask) >>> 0 !== address) {
    fail(`--${label} must use the network address for its prefix.`);
  }
  if (
    prefix < 8 ||
    (octets[0] ?? 0) === 0 ||
    (octets[0] ?? 0) === 127 ||
    ((octets[0] ?? 0) === 169 && (octets[1] ?? 0) === 254) ||
    (octets[0] ?? 0) >= 224
  ) {
    fail(`--${label} cannot use broad, loopback, link-local or multicast CIDRs.`);
  }
  return candidate;
}

function boundedInteger(candidate, label, minimum, maximum) {
  if (!/^\d+$/u.test(candidate)) {
    fail(`--${label} must be an integer.`);
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`--${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function cpuResource(candidate, label) {
  const match = /^([1-9]\d*)(m)?$/u.exec(candidate);
  if (match === null) {
    fail(`--${label} must be a positive whole CPU or millicpu quantity.`);
  }
  const value = Number(match[1]);
  const millicpu = match[2] === "m" ? value : value * 1_000;
  if (!Number.isSafeInteger(millicpu) || millicpu < 10 || millicpu > 64_000) {
    fail(`--${label} must be between 10m and 64 CPU.`);
  }
  return candidate;
}

function memoryResource(candidate, label) {
  const match = /^([1-9]\d*)(Mi|Gi)$/u.exec(candidate);
  if (match === null) {
    fail(`--${label} must be a positive Mi or Gi memory quantity.`);
  }
  const mebibytes = Number(match[1]) * (match[2] === "Gi" ? 1_024 : 1);
  if (!Number.isSafeInteger(mebibytes) || mebibytes < 64 || mebibytes > 128 * 1_024) {
    fail(`--${label} must be between 64Mi and 128Gi.`);
  }
  return candidate;
}

function cpuMillis(candidate) {
  return candidate.endsWith("m") ? Number(candidate.slice(0, -1)) : Number(candidate) * 1_000;
}

function memoryMebibytes(candidate) {
  return candidate.endsWith("Gi")
    ? Number(candidate.slice(0, -2)) * 1_024
    : Number(candidate.slice(0, -2));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
