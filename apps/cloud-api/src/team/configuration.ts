import { parseBase64UrlSecret } from "../security/tokens.js";

export interface CloudTeamInvitationDeliveryConfiguration {
  readonly encryptionKeyId: string;
  readonly encryptionKeys: Readonly<Record<string, Buffer>>;
  readonly endpoint: string;
  readonly token: string;
}

const MAXIMUM_PREVIOUS_KEYS = 3;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

export function loadCloudTeamInvitationDeliveryConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): CloudTeamInvitationDeliveryConfiguration | null {
  const rawEndpoint = environment.INKSHADOW_TEAM_INVITATION_DELIVERY_URL?.trim();
  const rawToken = environment.INKSHADOW_TEAM_INVITATION_DELIVERY_TOKEN?.trim();
  const rawEncryptionKey = environment.INKSHADOW_TEAM_INVITATION_OUTBOX_KEY?.trim();
  const rawEncryptionKeyId = environment.INKSHADOW_TEAM_INVITATION_OUTBOX_KEY_ID?.trim();
  const rawPreviousKeys = environment.INKSHADOW_TEAM_INVITATION_OUTBOX_PREVIOUS_KEYS_JSON?.trim();
  const configuredValues = [rawEndpoint, rawToken, rawEncryptionKey, rawEncryptionKeyId].filter(
    (value) => value !== undefined && value !== "",
  );
  if (configuredValues.length === 0 && (rawPreviousKeys === undefined || rawPreviousKeys === "")) {
    return null;
  }
  if (
    configuredValues.length !== 4 ||
    rawEndpoint === undefined ||
    rawEndpoint === "" ||
    rawToken === undefined ||
    rawToken === "" ||
    rawEncryptionKey === undefined ||
    rawEncryptionKey === "" ||
    rawEncryptionKeyId === undefined ||
    rawEncryptionKeyId === ""
  ) {
    throw new Error(
      "Team invitation delivery URL, bearer token, outbox key and key id must be configured together.",
    );
  }
  const endpoint = new URL(rawEndpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("INKSHADOW_TEAM_INVITATION_DELIVERY_URL must be credential-free HTTPS.");
  }
  if (rawToken.length < 32 || rawToken.length > 4_096 || /[\r\n]/u.test(rawToken)) {
    throw new Error("INKSHADOW_TEAM_INVITATION_DELIVERY_TOKEN is invalid.");
  }
  if (!KEY_ID_PATTERN.test(rawEncryptionKeyId)) {
    throw new Error("INKSHADOW_TEAM_INVITATION_OUTBOX_KEY_ID is invalid.");
  }
  const primaryKey = parseBase64UrlSecret("INKSHADOW_TEAM_INVITATION_OUTBOX_KEY", rawEncryptionKey);
  const previousKeys = parsePreviousKeys(rawPreviousKeys, rawEncryptionKeyId);
  return {
    encryptionKeyId: rawEncryptionKeyId,
    encryptionKeys: Object.freeze({
      [rawEncryptionKeyId]: primaryKey,
      ...previousKeys,
    }),
    endpoint: endpoint.toString(),
    token: rawToken,
  };
}

function parsePreviousKeys(
  rawValue: string | undefined,
  primaryKeyId: string,
): Readonly<Record<string, Buffer>> {
  if (rawValue === undefined || rawValue === "") {
    return Object.freeze({});
  }
  if (rawValue.length > 16_384) {
    throw new Error("INKSHADOW_TEAM_INVITATION_OUTBOX_PREVIOUS_KEYS_JSON is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("INKSHADOW_TEAM_INVITATION_OUTBOX_PREVIOUS_KEYS_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length > MAXIMUM_PREVIOUS_KEYS) {
    throw new Error(
      `INKSHADOW_TEAM_INVITATION_OUTBOX_PREVIOUS_KEYS_JSON must contain at most ${String(MAXIMUM_PREVIOUS_KEYS)} keys.`,
    );
  }
  const keyIds = new Set([primaryKeyId]);
  const entries: [string, Buffer][] = [];
  for (const candidate of parsed) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Every previous team-invitation key must be an object.");
    }
    const keyRecord = candidate as Readonly<Record<string, unknown>>;
    const fields = Object.keys(keyRecord).sort();
    if (fields.length !== 2 || fields[0] !== "key" || fields[1] !== "keyId") {
      throw new Error("Every previous team-invitation key must contain only keyId and key.");
    }
    const keyId = keyRecord.keyId;
    const key = keyRecord.key;
    if (
      typeof keyId !== "string" ||
      !KEY_ID_PATTERN.test(keyId) ||
      keyIds.has(keyId) ||
      typeof key !== "string"
    ) {
      throw new Error("A previous team-invitation key is invalid or duplicated.");
    }
    keyIds.add(keyId);
    entries.push([
      keyId,
      parseBase64UrlSecret(`INKSHADOW_TEAM_INVITATION_OUTBOX_PREVIOUS_KEYS_JSON:${keyId}`, key),
    ]);
  }
  return Object.freeze(Object.fromEntries(entries));
}
