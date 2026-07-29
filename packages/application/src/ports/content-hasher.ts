import type { AppError, ContentChecksum, Result } from "@inkshadow/domain";

export interface ContentHasher {
  sha256(content: string): Promise<Result<ContentChecksum, AppError>>;
}
