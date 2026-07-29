import type {
  IdentityChallengeDelivery,
  IdentityChallengeNotifier,
} from "../service/identity-service.js";

export interface HttpChallengeNotifierOptions {
  readonly endpoint: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
  readonly token: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpChallengeNotifier implements IdentityChallengeNotifier {
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;
  private readonly token: string;

  public constructor(options: HttpChallengeNotifierOptions) {
    const endpoint = new URL(options.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.hash !== ""
    ) {
      throw new Error("The challenge-delivery endpoint must be a credential-free HTTPS URL.");
    }
    if (
      options.token.length < 32 ||
      options.token.length > 4_096 ||
      /[\r\n]/u.test(options.token)
    ) {
      throw new Error("The challenge-delivery token is invalid.");
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 60_000
    ) {
      throw new Error("The challenge-delivery timeout is invalid.");
    }
    this.endpoint = endpoint.toString();
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.token = options.token;
  }

  public async deliver(delivery: IdentityChallengeDelivery): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          deliveryId: delivery.challengeId,
          template:
            delivery.kind === "registration"
              ? "inkshadow-email-verification"
              : "inkshadow-password-reset",
          recipient: delivery.email,
          oneTimeCode: delivery.code,
          expiresAt: delivery.expiresAt,
        }),
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": delivery.challengeId,
          "X-Delivery-Id": delivery.challengeId,
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("Challenge delivery was rejected.");
      }
      await response.body?.cancel();
    } catch {
      throw new Error("Challenge delivery failed.");
    } finally {
      clearTimeout(timeout);
    }
  }
}
