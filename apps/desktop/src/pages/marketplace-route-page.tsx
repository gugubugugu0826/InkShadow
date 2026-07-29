import { useRuntime } from "../runtime-context";
import { MarketplacePage } from "./marketplace-page";

export function MarketplaceRoutePage() {
  const runtime = useRuntime();
  return <MarketplacePage runtime={runtime.marketplace} />;
}
