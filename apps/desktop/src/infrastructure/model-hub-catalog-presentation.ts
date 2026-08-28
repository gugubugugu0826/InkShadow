import { formatNaturalLocalTime } from "./natural-local-time";
import type { ModelCatalogEntry } from "./model-hub-store";

/**
 * Describes the persisted origin of one model row. It deliberately does not
 * infer origin from model count, connection status or the most recent button.
 */
export function describeModelHubCatalogEntrySource(
  entry: Pick<ModelCatalogEntry, "catalogSource" | "lastSeenAt">,
  options: Readonly<{ cached: boolean }>,
): string {
  const observedAt = formatNaturalLocalTime(entry.lastSeenAt);
  switch (entry.catalogSource) {
    case "manual":
      return `手动添加 · 保存于 ${observedAt}`;
    case "official_preset":
      return `内置预设 · 记录于 ${observedAt}`;
    case "legacy":
      return `旧版本本机记录 · 记录于 ${observedAt}`;
    case "provider_api":
      return options.cached
        ? `本机保留的服务商目录 · 上次读取于 ${observedAt}`
        : `从服务商读取 · 读取于 ${observedAt}`;
  }
}
