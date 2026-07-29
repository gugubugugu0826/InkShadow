import type { ContentHasher } from "@inkshadow/application";
import {
  AppError,
  err,
  ok,
  parseContentChecksum,
  type ContentChecksum,
  type Result,
} from "@inkshadow/domain";

export type SubtleCryptoProvider = Pick<SubtleCrypto, "digest">;

export class CryptoContentHasher implements ContentHasher {
  public constructor(private readonly subtle: SubtleCryptoProvider = globalThis.crypto.subtle) {}

  public async sha256(content: string): Promise<Result<ContentChecksum, AppError>> {
    try {
      const bytes = new TextEncoder().encode(content);
      const digest = await this.subtle.digest("SHA-256", bytes);
      const checksum = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      const parsed = parseContentChecksum(checksum);
      return parsed.ok
        ? ok(parsed.value)
        : err(
            new AppError({
              code: "SAVE_FAILED",
              message: "The generated content checksum was invalid.",
              actions: ["RETRY", "EXPORT_DRAFT"],
            }),
          );
    } catch {
      return err(
        new AppError({
          code: "SAVE_FAILED",
          message: "Unable to calculate the content checksum.",
          retryable: true,
          actions: ["RETRY", "EXPORT_DRAFT"],
        }),
      );
    }
  }
}
