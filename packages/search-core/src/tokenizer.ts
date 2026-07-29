const MAX_QUERY_LENGTH = 500;

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replaceAll(/\s+/gu, " ").trim();
}

export function validateAndNormalizeQuery(value: string): string {
  const normalized = normalizeSearchText(value);
  if (normalized.length === 0 || normalized.length > MAX_QUERY_LENGTH) {
    throw new RangeError(`Search query length must be between 1 and ${String(MAX_QUERY_LENGTH)}.`);
  }
  return normalized;
}

export function tokenizeForSearch(value: string): readonly string[] {
  const normalized = normalizeSearchText(value);
  if (normalized.length === 0) {
    return [];
  }

  const tokens = new Set<string>();
  for (const segment of normalized.split(" ")) {
    if (segment.length === 0) {
      continue;
    }

    if (segment.length <= 2) {
      tokens.add(segment);
      continue;
    }

    for (let index = 0; index <= segment.length - 3; index += 1) {
      tokens.add(segment.slice(index, index + 3));
    }
  }

  return [...tokens];
}
