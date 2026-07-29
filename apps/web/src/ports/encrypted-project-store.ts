import type {
  CipherEnvelopeV1,
  EncryptedGuestProjectRecordV1,
} from "../contracts/encrypted-guest-project";

export interface EncryptedProjectStore {
  list(): Promise<readonly EncryptedGuestProjectRecordV1[]>;
  get(projectId: string): Promise<EncryptedGuestProjectRecordV1 | null>;
  create(record: EncryptedGuestProjectRecordV1): Promise<void>;
  appendChapter(
    projectId: string,
    expectedContentVersion: number,
    envelope: CipherEnvelopeV1,
  ): Promise<void>;
}
