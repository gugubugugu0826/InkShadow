export const BOUNDED_LOCAL_QUERY_PLAN_LIMIT = 4;
export const BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT = 80;
export const BOUNDED_LOCAL_RECOVERY_QUERY_PLAN_LIMIT = 4;

export type BoundedLocalQueryType = "fact" | "alias" | "time" | "location" | "fallback";

export interface BoundedLocalQuerySource {
  readonly sourceId: string | null;
  readonly sourceType: string;
  /** Transient authoritative text. Receipts must persist only sourceId/sourceType. */
  readonly content: string;
}

export interface BoundedLocalRetrievalQueryPlan {
  readonly sourceId: string | null;
  readonly sourceType: string;
  /** Transient evidence text. Content-free receipts must never persist this field. */
  readonly sourceQuestion: string;
  /** Transient FTS input. Content-free receipts must never persist this field. */
  readonly query: string;
  readonly queryType: BoundedLocalQueryType;
  readonly filters: Readonly<{
    readonly timeTerms: readonly string[];
    readonly locationTerms: readonly string[];
  }>;
  readonly retrievalMethod: "fts";
  readonly fusionWeight: number;
}

export type BoundedLocalQueryRecoveryType =
  "local_alias_expansion" | "local_time_location_scope" | "fts_rewrite" | "bounded_multi_query";

export interface BoundedLocalRecoveryQueryPlan extends BoundedLocalRetrievalQueryPlan {
  readonly recoveryType: BoundedLocalQueryRecoveryType;
}

/**
 * Shared bounded local rewrite plan for continuation and consistency reads.
 * It can only derive short FTS strings from already-authoritative local text;
 * it cannot construct SQL, invoke a model, or relax a retrieval scope.
 */
export function planBoundedLocalRetrievalQueries(
  sources: readonly BoundedLocalQuerySource[],
): readonly BoundedLocalRetrievalQueryPlan[] {
  const plans: BoundedLocalRetrievalQueryPlan[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (plans.length >= BOUNDED_LOCAL_QUERY_PLAN_LIMIT) break;
    const sourceQuestion = normalize(source.content).slice(0, BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT);
    if (sourceQuestion.length === 0) continue;
    const timeTerms = matchTerms(sourceQuestion, TIME_TERM_PATTERN);
    const locationTerms = matchTerms(sourceQuestion, LOCATION_TERM_PATTERN, 1);
    addPlan(plans, seen, {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      sourceQuestion,
      query: sourceQuestion,
      queryType: "fact",
      filters: { timeTerms, locationTerms },
      retrievalMethod: "fts",
      fusionWeight: 1,
    });

    if (plans.length >= BOUNDED_LOCAL_QUERY_PLAN_LIMIT) break;
    const aliases = matchAliasTerms(sourceQuestion);
    if (aliases.length > 0) {
      addPlan(plans, seen, {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        sourceQuestion,
        query: aliases.join(" "),
        queryType: "alias",
        filters: { timeTerms: [], locationTerms: [] },
        retrievalMethod: "fts",
        fusionWeight: 0.9,
      });
    }
    if (plans.length >= BOUNDED_LOCAL_QUERY_PLAN_LIMIT) break;
    if (timeTerms.length > 0) {
      addPlan(plans, seen, {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        sourceQuestion,
        query: timeTerms.join(" "),
        queryType: "time",
        filters: { timeTerms, locationTerms: [] },
        retrievalMethod: "fts",
        fusionWeight: 0.75,
      });
    }
    if (plans.length >= BOUNDED_LOCAL_QUERY_PLAN_LIMIT) break;
    if (locationTerms.length > 0) {
      addPlan(plans, seen, {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        sourceQuestion,
        query: locationTerms.join(" "),
        queryType: "location",
        filters: { timeTerms: [], locationTerms },
        retrievalMethod: "fts",
        fusionWeight: 0.75,
      });
    }
  }
  if (plans.length === 0) {
    const fallbackSource = sources[0];
    addPlan(plans, seen, {
      sourceId: fallbackSource?.sourceId ?? null,
      sourceType: fallbackSource?.sourceType ?? "local_fallback",
      sourceQuestion: "人物 时间 地点 关系",
      query: "人物 时间 地点 关系",
      queryType: "fallback",
      filters: { timeTerms: [], locationTerms: [] },
      retrievalMethod: "fts",
      fusionWeight: 0.5,
    });
  }
  return Object.freeze(plans);
}

/**
 * A second bounded local-only plan. Callers run it only after the initial FTS
 * pass and expanded K remain insufficient; hard filters stay unchanged.
 */
export function planBoundedLocalRecoveryQueries(
  sources: readonly BoundedLocalQuerySource[],
  initial: readonly Pick<BoundedLocalRetrievalQueryPlan, "query">[],
): readonly BoundedLocalRecoveryQueryPlan[] {
  const plans: BoundedLocalRecoveryQueryPlan[] = [];
  const seen = new Set(initial.map(({ query }) => normalize(query)));
  const maximumRecoveryPlans = Math.min(
    BOUNDED_LOCAL_RECOVERY_QUERY_PLAN_LIMIT,
    Math.max(0, BOUNDED_LOCAL_QUERY_PLAN_LIMIT - seen.size),
  );
  if (maximumRecoveryPlans === 0) return Object.freeze(plans);
  for (const source of sources) {
    if (plans.length >= maximumRecoveryPlans) break;
    const sourceQuestion = normalize(source.content).slice(0, BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT);
    if (sourceQuestion.length === 0) continue;
    const aliases = matchAliasTerms(sourceQuestion);
    if (aliases.length > 0) {
      addRecoveryPlan(
        plans,
        seen,
        {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          sourceQuestion,
          query: aliases.join(" "),
          queryType: "alias",
          filters: { timeTerms: [], locationTerms: [] },
          retrievalMethod: "fts",
          fusionWeight: 0.9,
          recoveryType: "local_alias_expansion",
        },
        maximumRecoveryPlans,
      );
    }
    if (plans.length >= maximumRecoveryPlans) break;
    const timeTerms = matchTerms(sourceQuestion, TIME_TERM_PATTERN);
    const locationTerms = matchTerms(sourceQuestion, LOCATION_TERM_PATTERN, 1);
    if (timeTerms.length + locationTerms.length > 0) {
      addRecoveryPlan(
        plans,
        seen,
        {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          sourceQuestion,
          query: [...timeTerms, ...locationTerms].join(" "),
          queryType: timeTerms.length > 0 ? "time" : "location",
          filters: { timeTerms, locationTerms },
          retrievalMethod: "fts",
          fusionWeight: 0.75,
          recoveryType: "local_time_location_scope",
        },
        maximumRecoveryPlans,
      );
    }
    if (plans.length >= maximumRecoveryPlans) break;
    const rewritten = rewriteFtsTerms(sourceQuestion);
    if (rewritten.length > 0) {
      addRecoveryPlan(
        plans,
        seen,
        {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          sourceQuestion,
          query: rewritten.join(" "),
          queryType: "fact",
          filters: { timeTerms: [], locationTerms: [] },
          retrievalMethod: "fts",
          fusionWeight: 0.65,
          recoveryType: "fts_rewrite",
        },
        maximumRecoveryPlans,
      );
    }
    if (plans.length >= maximumRecoveryPlans) break;
    for (const segment of boundedQuestionSegments(source.content)) {
      addRecoveryPlan(
        plans,
        seen,
        {
          sourceId: source.sourceId,
          sourceType: source.sourceType,
          sourceQuestion,
          query: segment,
          queryType: "fact",
          filters: { timeTerms: [], locationTerms: [] },
          retrievalMethod: "fts",
          fusionWeight: 0.55,
          recoveryType: "bounded_multi_query",
        },
        maximumRecoveryPlans,
      );
      if (plans.length >= maximumRecoveryPlans) break;
    }
  }
  return Object.freeze(plans);
}

function addPlan(
  plans: BoundedLocalRetrievalQueryPlan[],
  seen: Set<string>,
  input: BoundedLocalRetrievalQueryPlan,
): void {
  if (plans.length >= BOUNDED_LOCAL_QUERY_PLAN_LIMIT) return;
  const query = normalize(input.query).slice(0, BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT);
  if (query.length === 0 || seen.has(query)) return;
  seen.add(query);
  plans.push(freezePlan(input, query));
}

function addRecoveryPlan(
  plans: BoundedLocalRecoveryQueryPlan[],
  seen: Set<string>,
  input: BoundedLocalRecoveryQueryPlan,
  maximumPlans: number,
): void {
  if (plans.length >= maximumPlans) return;
  const query = normalize(input.query).slice(0, BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT);
  if (query.length === 0 || seen.has(query)) return;
  seen.add(query);
  plans.push(
    Object.freeze({
      ...freezePlan(input, query),
      recoveryType: input.recoveryType,
    }),
  );
}

function freezePlan(
  input: BoundedLocalRetrievalQueryPlan,
  query: string,
): BoundedLocalRetrievalQueryPlan {
  return Object.freeze({
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    sourceQuestion: input.sourceQuestion,
    query,
    queryType: input.queryType,
    filters: Object.freeze({
      timeTerms: Object.freeze([...input.filters.timeTerms]),
      locationTerms: Object.freeze([...input.filters.locationTerms]),
    }),
    retrievalMethod: input.retrievalMethod,
    fusionWeight: input.fusionWeight,
  });
}

function normalize(value: string): string {
  return value
    .normalize("NFC")
    .replaceAll(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

function matchAliasTerms(value: string): readonly string[] {
  const terms = new Set<string>();
  for (const match of value.matchAll(ALIAS_PATTERN)) {
    const left = match[1]?.trim();
    const right = match[2]?.trim();
    if (left !== undefined && left.length > 0) terms.add(left);
    if (right !== undefined && right.length > 0) terms.add(right);
    if (terms.size >= 4) break;
  }
  return Object.freeze([...terms]);
}

function matchTerms(value: string, pattern: RegExp, group = 0): readonly string[] {
  const terms = new Set<string>();
  for (const match of value.matchAll(pattern)) {
    const term = match[group]?.trim();
    if (term !== undefined && term.length > 0) terms.add(term);
    if (terms.size >= 4) break;
  }
  return Object.freeze([...terms]);
}

function rewriteFtsTerms(value: string): readonly string[] {
  const terms = new Set<string>();
  for (const token of value.split(" ")) {
    const normalized = token.trim();
    if (normalized.length < 2 || LOCAL_PRONOUNS.has(normalized)) continue;
    if (normalized.length <= 12) {
      terms.add(normalized);
    } else {
      terms.add(normalized.slice(0, 12));
      terms.add(normalized.slice(-12));
    }
    if (terms.size >= 4) break;
  }
  return Object.freeze([...terms]);
}

function boundedQuestionSegments(value: string): readonly string[] {
  const segments = value
    .normalize("NFC")
    .split(/[，。；！？、,.;!?\r\n]+/u)
    .map(normalize)
    .filter((segment) => segment.length >= 2)
    .map((segment) => segment.slice(0, BOUNDED_LOCAL_QUERY_CHARACTER_LIMIT));
  return Object.freeze([...new Set(segments)].slice(0, BOUNDED_LOCAL_RECOVERY_QUERY_PLAN_LIMIT));
}

const LOCAL_PRONOUNS = new Set(["他", "她", "它", "他们", "她们", "它们", "其", "自己"]);

const ALIAS_PATTERN = /([\p{L}\p{N}]{1,12})(?:又名|别名|也叫|即)([\p{L}\p{N}]{1,12})/gu;
const TIME_TERM_PATTERN =
  /(?:第[一二三四五六七八九十百千万\d]+(?:天|日|年)|当天|当晚|翌日|次日|清晨|早晨|上午|中午|下午|傍晚|深夜|[一二三四五六七八九十百千万\d]+(?:天|年|个月|小时)前|[春夏秋冬]季?)/gu;
const LOCATION_TERM_PATTERN =
  /(?:在|到|从)([^，。；！？、\s]{1,16}?)(?:里|内|外|附近|门口|上|下|中|前|后)/gu;
