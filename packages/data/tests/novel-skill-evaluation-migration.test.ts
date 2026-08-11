import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const evidenceFoundationMigration = [
  "0004_model_profiles.sql",
  "0005_ai_generation_governance.sql",
  "0007_model_routing_usage.sql",
  "0030_creative_journeys.sql",
  "0031_model_hub.sql",
  "0032_unified_story_facts.sql",
  "0034_context_compilation_trace.sql",
  "0035_writing_feedback_learning.sql",
  "0036_story_planning_candidates.sql",
  "0039_project_seeds.sql",
  "0047_context_compilation_exact_provenance.sql",
  "0058_story_settings_import_receipts.sql",
]
  .map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");
const registryMigration = readFileSync(
  new URL("../migrations/0060_novel_skill_registry.sql", import.meta.url),
  "utf8",
);
const evaluationMigration = readFileSync(
  new URL("../migrations/0061_novel_skill_evaluation_ledger.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-10T00:00:00.000Z";
const SUITE_ID = "019f9f4a-b3c7-7350-8000-000000000061";
const RUN_ID = "019f9f4a-b3c7-7350-8000-000000000062";
const MODEL_ASSIGNMENTS = JSON.stringify([
  {
    slotId: "text_tier_a",
    modelIdentityHash: "1".repeat(64),
    modelArtifactHash: "4".repeat(64),
  },
  {
    slotId: "text_tier_b",
    modelIdentityHash: "2".repeat(64),
    modelArtifactHash: "5".repeat(64),
  },
]);

describe("Novel Skill evaluation ledger migration", () => {
  it("upgrades through 0061 idempotently and creates only content-free evidence tables", async () => {
    const executor = new NodeSqliteExecutor(
      `${coreMigration}\n${evidenceFoundationMigration}\n${registryMigration}\n${evaluationMigration}\n${evaluationMigration}`,
    );
    const tables = await executor.select<{ readonly name: string; readonly sql: string }>(
      `SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name LIKE 'novel_skill_evaluation_%'
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual([
      "novel_skill_evaluation_attempts",
      "novel_skill_evaluation_cells",
      "novel_skill_evaluation_fixtures",
      "novel_skill_evaluation_manifest_items",
      "novel_skill_evaluation_manual_decisions",
      "novel_skill_evaluation_observations",
      "novel_skill_evaluation_runs",
      "novel_skill_evaluation_scores",
      "novel_skill_evaluation_suites",
    ]);
    expect(tables.map(({ sql }) => sql).join("\n")).not.toMatch(
      /chapter_text|prompt_text|response_text|reasoning_text|credential|api_key/iu,
    );
    expect(evaluationMigration.match(/'max_output_tokens'/gu)).toHaveLength(2);
    await executor.close();
  });

  it("rejects forged terminal eligibility, conflicting decisions, mutation and deletion", async () => {
    const executor = new NodeSqliteExecutor(
      `${coreMigration}\n${evidenceFoundationMigration}\n${registryMigration}\n${evaluationMigration}`,
    );
    await expect(insertSuite(executor)).resolves.toMatchObject({ rowsAffected: 1 });
    await expect(
      insertSuite(
        executor,
        "019f9f4a-b3c7-7350-8000-000000000063",
        '[{"slotId":"text_tier_a","modelTier":"same"},{"slotId":"text_tier_a","modelTier":"same"}]',
      ),
    ).rejects.toThrow(/distinct content-free/iu);
    await expect(
      executor.execute(
        `INSERT INTO novel_skill_evaluation_fixtures (
           suite_id, fixture_id, language, origin, task_type, invocation_mode,
           genre_tags_json, coverage_dimensions_json, contract_hash, input_content_hash
         ) VALUES (?, 'zh.original.contract', 'zh-CN', 'inkshadow_original_short_contract',
                   'continuation', 'draft', '["campus_romance","light_novel"]', ?, ?, ?)`,
        [
          SUITE_ID,
          JSON.stringify([
            "youth_romance",
            "suspense",
            "fantasy",
            "light_novel",
            "web_novel",
            "literary",
            "multi_character_dialogue",
            "pov",
            "timeline",
            "rule_conflict",
            "continuation",
            "rewrite",
          ]),
          "c".repeat(64),
          "d".repeat(64),
        ],
      ),
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_fixtures SET contract_hash = ?
         WHERE suite_id = ? AND fixture_id = 'zh.original.contract'`,
        ["d".repeat(64), SUITE_ID],
      ),
    ).rejects.toThrow(/immutable/iu);

    await expect(
      executor.execute(
        `INSERT INTO novel_skill_evaluation_runs (
           id, suite_id, status, evaluation_status, model_assignments_json,
           revision, started_at, completed_at, created_at
         ) VALUES (?, ?, 'completed', 'ELIGIBLE_FOR_REVIEW', ?, 1, ?, ?, ?)`,
        [RUN_ID, SUITE_ID, MODEL_ASSIGNMENTS, NOW, NOW, NOW],
      ),
    ).rejects.toThrow(/must begin/iu);
    await expect(
      executor.execute(
        `INSERT INTO novel_skill_evaluation_runs (
           id, suite_id, status, evaluation_status, model_assignments_json,
           revision, started_at, completed_at, created_at
         ) VALUES (?, ?, 'planned', 'NOT_EVALUATED', ?, 1, NULL, NULL, ?)`,
        [
          RUN_ID,
          SUITE_ID,
          JSON.stringify([
            {
              slotId: "text_tier_a",
              modelIdentityHash: "1".repeat(64),
              modelArtifactHash: "4".repeat(64),
            },
            {
              slotId: "text_tier_b",
              modelIdentityHash: "2".repeat(64),
              modelArtifactHash: "4".repeat(64),
            },
          ]),
          NOW,
        ],
      ),
    ).rejects.toThrow(/distinct two-model/iu);
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_runs (
         id, suite_id, status, evaluation_status, model_assignments_json,
         revision, started_at, completed_at, created_at
       ) VALUES (?, ?, 'planned', 'NOT_EVALUATED', ?, 1, NULL, NULL, ?)`,
      [RUN_ID, SUITE_ID, MODEL_ASSIGNMENTS, NOW],
    );
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_cells (
         id, run_id, suite_id, fixture_id, arm, arm_configuration_hash,
         model_slot_id, model_tier, repetition, state, created_at
       ) VALUES ('019f9f4a-b3c7-7350-8000-000000000067', ?, ?,
                 'zh.original.contract', 'no_skill', NULL, 'text_tier_a',
                 'economy', 1, 'planned', ?)`,
      [RUN_ID, SUITE_ID, NOW],
    );
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_cells SET state = 'observed'
         WHERE id = '019f9f4a-b3c7-7350-8000-000000000067'`,
      ),
    ).rejects.toThrow(/terminal observation/iu);
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_runs
         SET status = 'completed', evaluation_status = 'ELIGIBLE_FOR_REVIEW',
             started_at = ?, completed_at = ?, revision = revision + 1
         WHERE id = ?`,
        [NOW, NOW, RUN_ID],
      ),
    ).rejects.toThrow(/evidence-complete/iu);
    await expect(
      executor.execute(
        `INSERT INTO novel_skill_evaluation_manual_decisions (
           id, run_id, target_manifest_hash, decision, rationale_hash, created_at
         ) VALUES ('019f9f4a-b3c7-7350-8000-000000000064', ?, ?,
                   'APPROVE_EXPERIMENTAL_BINDING', ?, ?)`,
        [RUN_ID, "3".repeat(64), "e".repeat(64), NOW],
      ),
    ).rejects.toThrow(/terminal exact-manifest/iu);

    await executor.execute(
      `UPDATE novel_skill_evaluation_runs
       SET status = 'invalidated', evaluation_status = 'EVIDENCE_INCOMPLETE',
           completed_at = ?, revision = revision + 1 WHERE id = ?`,
      [NOW, RUN_ID],
    );
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_manual_decisions (
         id, run_id, target_manifest_hash, decision, rationale_hash, created_at
       ) VALUES ('019f9f4a-b3c7-7350-8000-000000000065', ?, ?, 'KEEP_DISABLED', ?, ?)`,
      [RUN_ID, "3".repeat(64), "e".repeat(64), NOW],
    );
    await expect(
      executor.execute(
        `INSERT INTO novel_skill_evaluation_manual_decisions (
           id, run_id, target_manifest_hash, decision, rationale_hash, created_at
         ) VALUES ('019f9f4a-b3c7-7350-8000-000000000066', ?, ?, 'REJECT_ENABLEMENT', ?, ?)`,
        [RUN_ID, "3".repeat(64), "f".repeat(64), NOW],
      ),
    ).rejects.toThrow(/unique/iu);
    await expect(
      executor.execute("DELETE FROM novel_skill_evaluation_manual_decisions"),
    ).rejects.toThrow(/cannot be deleted/iu);
    await expect(
      executor.execute("DELETE FROM novel_skill_evaluation_runs WHERE id = ?", [RUN_ID]),
    ).rejects.toThrow(/cannot be deleted/iu);
    await expect(
      executor.execute("DELETE FROM novel_skill_evaluation_fixtures WHERE suite_id = ?", [
        SUITE_ID,
      ]),
    ).rejects.toThrow(/cannot be deleted/iu);
    await expect(
      executor.execute("DELETE FROM novel_skill_evaluation_manifest_items WHERE suite_id = ?", [
        SUITE_ID,
      ]),
    ).rejects.toThrow(/cannot be deleted/iu);
    await expect(
      executor.execute("DELETE FROM novel_skill_evaluation_suites WHERE id = ?", [SUITE_ID]),
    ).rejects.toThrow(/cannot be deleted/iu);
    await executor.close();
  });
});

async function insertSuite(
  executor: NodeSqliteExecutor,
  suiteId = SUITE_ID,
  slots = '[{"slotId":"text_tier_a","modelTier":"economy"},{"slotId":"text_tier_b","modelTier":"quality"}]',
) {
  const evaluationProjectId = suiteId;
  await seedManifestDefinitions(executor);
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at, archived_at,
       trashed_at, retention_until, status_before_trash
     ) VALUES (?, ?, 'archived', 1, 0, ?, ?, ?, NULL, NULL, NULL)`,
    [evaluationProjectId, `Novel Skill evaluation ${suiteId}`, NOW, NOW, NOW],
  );
  const inserted = await executor.execute(
    `INSERT INTO novel_skill_evaluation_suites (
       id, schema_version, evaluator_version, compiler_version,
       evaluation_project_id, plan_hash, fixture_set_hash,
       target_manifest_hash, core_manifest_hash, core_genre_manifest_hash,
       core_genre_preferences_manifest_hash, preference_configuration_hash,
       model_slots_json, minimum_repetitions, created_at
     ) VALUES (?, 1, 'novel-skill-ab@1', 'novel-skill-compiler@1',
               ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
    [
      suiteId,
      evaluationProjectId,
      "a".repeat(64),
      "b".repeat(64),
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
      "6".repeat(64),
      "7".repeat(64),
      slots,
      NOW,
    ],
  );
  for (const [arm, items] of [
    ["core", [["core.test", "core"]]],
    [
      "core_genre",
      [
        ["core.test", "core"],
        ["genre.test", "genre"],
      ],
    ],
    [
      "core_genre_preferences",
      [
        ["core.test", "core"],
        ["genre.test", "genre"],
      ],
    ],
  ] as const) {
    for (const [index, [skillId, kind]] of items.entries()) {
      await executor.execute(
        `INSERT INTO novel_skill_evaluation_manifest_items (
           suite_id, arm, item_order, skill_id, skill_version, definition_hash, kind
         ) VALUES (?, ?, ?, ?, '1.0.0', ?, ?)`,
        [suiteId, arm, index + 1, skillId, kind === "core" ? "8".repeat(64) : "9".repeat(64), kind],
      );
    }
  }
  return inserted;
}

async function seedManifestDefinitions(executor: NodeSqliteExecutor): Promise<void> {
  for (const [skillId, kind, definitionHash, activation] of [
    ["core.test", "core", "8".repeat(64), '{"allowedModes":["draft"],"genreTags":[]}'],
    [
      "genre.test",
      "genre",
      "9".repeat(64),
      '{"allowedModes":["draft"],"genreTags":["campus_romance"]}',
    ],
  ] as const) {
    await executor.execute(
      `INSERT OR IGNORE INTO novel_skill_definitions (
         skill_id, version, display_name, summary, kind, owner_scope, status, default_enabled,
         precedence, task_types_json, activation_json, context_requirements_json,
         instructions_json, output_contract_json, validation_json, definition_hash,
         provenance_url, provenance_commit, provenance_license, created_at
       ) VALUES (?, '1.0.0', ?, 'test manifest definition', ?, 'builtin', 'experimental', 0,
                 ?, '["continuation"]', ?, '{}', '{}', '{}', '{}', ?, NULL, NULL, NULL, ?)`,
      [skillId, skillId, kind, kind === "core" ? 200 : 300, activation, definitionHash, NOW],
    );
  }
}
