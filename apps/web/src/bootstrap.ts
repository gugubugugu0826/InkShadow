import { GuestWorkspaceService } from "./application/guest-workspace-service";
import { IndexedDbEncryptedProjectStore } from "./infrastructure/indexed-db-encrypted-project-store";

export function createBrowserGuestWorkspaceService(): GuestWorkspaceService {
  return new GuestWorkspaceService(new IndexedDbEncryptedProjectStore());
}
