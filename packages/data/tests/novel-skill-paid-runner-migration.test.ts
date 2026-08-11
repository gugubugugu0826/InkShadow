import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const foundation = [
  "0001_core.sql",
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
  "0056_model_hub_failure_diagnostics.sql",
  "0057_model_hub_content_quality_task.sql",
  "0058_story_settings_import_receipts.sql",
  "0060_novel_skill_registry.sql",
  "0061_novel_skill_evaluation_ledger.sql",
]
  .map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");
const paidRunnerMigration = readFileSync(
  new URL("../migrations/0063_novel_skill_evaluation_paid_runner.sql", import.meta.url),
  "utf8",
);
const predispatchAuthorityMigration = readFileSync(
  new URL("../migrations/0064_novel_skill_evaluation_predispatch_authority.sql", import.meta.url),
  "utf8",
);

const EXPECTED_TABLES = [
  "novel_skill_evaluation_authorization_limits",
  "novel_skill_evaluation_context_baselines",
  "novel_skill_evaluation_dispatch_authorizations",
  "novel_skill_evaluation_dispatch_reservations",
  "novel_skill_evaluation_protocols",
  "novel_skill_evaluation_request_profiles",
  "novel_skill_evaluation_review_batches",
  "novel_skill_evaluation_review_items",
  "novel_skill_evaluation_review_receipts",
  "novel_skill_evaluation_run_model_targets",
] as const;

describe("Novel Skill paid evaluation runner migration", () => {
  it("upgrades 0063 idempotently with a content-free predispatch authority sidecar", async () => {
    const executor = new NodeSqliteExecutor(
      `${foundation}\n${paidRunnerMigration}\n${predispatchAuthorityMigration}\n${predispatchAuthorityMigration}`,
    );
    const tables = await executor.select<{ readonly sql: string }>(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'table'
         AND name = 'novel_skill_evaluation_predispatch_authority_snapshots'`,
    );
    expect(tables).toHaveLength(1);
    expect(tables[0]?.sql).not.toMatch(
      /prompt_text|prompt_body|request_body|response_text|response_body|output_text|reasoning_text|reasoning_body|credential_ref|api_key|secret/iu,
    );
    expect(tables[0]?.sql).toContain("exact_predispatch_estimated_max_cost_micros");
    expect(tables[0]?.sql).toContain("capability_evidence_hash");
    expect(tables[0]?.sql).toContain("provider_receipt_shape_hash");
    expect(tables[0]?.sql).toContain("final_dispatch_authority_hash");
    const guards = await executor.select<{ readonly name: string }>(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name IN (
         'novel_skill_evaluation_predispatch_authority_insert_guard',
         'novel_skill_evaluation_reservation_authority_bind_guard',
         'novel_skill_evaluation_reservation_authority_dispatch_guard',
         'novel_skill_evaluation_reservation_authority_settlement_guard'
       ) ORDER BY name`,
    );
    expect(guards).toHaveLength(4);
    await executor.close();
  });

  it("fails closed when a legacy 0063 reservation has no verifiable sidecar", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await authorizeAndStart(executor, ids);
    const [cell] = await executor.select<{ readonly id: string }>(
      `SELECT id FROM novel_skill_evaluation_cells
       WHERE run_id = ? AND model_slot_id = 'text_tier_a'
       ORDER BY id LIMIT 1`,
      [ids.runId],
    );
    if (cell === undefined) throw new Error("paid evaluation cell missing");
    const attemptId = "019f9f4a-b3c7-7350-8008-000000000001";
    const reservationId = "019f9f4a-b3c7-7350-8008-000000000002";
    await insertStartedAttempt(executor, ids.runId, cell.id, attemptId, 1);
    await insertReservation(executor, ids, cell.id, attemptId, reservationId, 1);

    executor.database.exec(predispatchAuthorityMigration);
    await expect(bindReservation(executor, ids, attemptId, reservationId, 1)).rejects.toThrow(
      /lacks frozen predispatch authority/iu,
    );
    const state = await executor.select<{ readonly state: string }>(
      `SELECT state FROM novel_skill_evaluation_dispatch_reservations WHERE id = ?`,
      [reservationId],
    );
    expect(state[0]?.state).toBe("reserved");
    await executor.close();
  });

  it("upgrades through 0063 idempotently with ten content-free authority tables", async () => {
    const executor = new NodeSqliteExecutor(
      `${foundation}\n${paidRunnerMigration}\n${paidRunnerMigration}`,
    );
    const tables = await executor.select<{ readonly name: string; readonly sql: string }>(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'table' AND name IN (${EXPECTED_TABLES.map(() => "?").join(",")})
       ORDER BY name`,
      EXPECTED_TABLES,
    );
    expect(tables.map(({ name }) => name)).toEqual(EXPECTED_TABLES);
    const ddl = tables.map(({ sql }) => sql).join("\n");
    expect(ddl).not.toMatch(
      /prompt_text|prompt_body|request_body|response_text|response_body|reasoning_text|reasoning_body|credential_ref|api_key|secret/iu,
    );
    expect(ddl).toContain("provider_visible_output_hash");
    expect(ddl).toContain("message_payload_hash");
    expect(ddl).toContain("payload_authority_manifest_hash");
    expect(ddl).toContain("novel-skill-paid-payload-authority@1");
    expect(ddl).toContain("rubric_content_hash");
    expect(ddl).toContain("authorized_call_count = 192");
    expect(ddl).toContain("'ambiguous'");
    expect(ddl).toContain("CHECK (streaming = 1)");
    expect(ddl).toContain("CHECK (artifact_identity_source = 'provider_model_id')");
    await executor.close();
  });

  it("makes protocol, commercial authority and blind review evidence append-only", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const immutableTriggers = await executor.select<{ readonly name: string }>(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name IN (
         'novel_skill_evaluation_protocol_immutable',
         'novel_skill_evaluation_authorization_immutable',
         'novel_skill_evaluation_reservation_delete_guard',
         'novel_skill_evaluation_review_batch_immutable',
         'novel_skill_evaluation_review_item_immutable',
         'novel_skill_evaluation_review_receipt_immutable'
       ) ORDER BY name`,
    );
    expect(immutableTriggers).toHaveLength(6);
    await executor.close();
  });

  it("registers only explicit fail-closed reservation transitions", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const rows = await executor.select<{ readonly sql: string }>(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'novel_skill_evaluation_reservation_revision_guard'`,
    );
    expect(rows[0]?.sql).toMatch(/reserved.+bound.+dispatched.+settled.+ambiguous/isu);
    expect(rows[0]?.sql).toMatch(/not_dispatched/iu);
    expect(rows[0]?.sql).toMatch(/connection_status\s*=\s*'ready'/iu);
    expect(rows[0]?.sql).toMatch(/catalog\.revision\s*=\s*target\.catalog_revision/iu);
    expect(rows[0]?.sql).toMatch(/cost\.revision\s*=\s*target\.cost_profile_revision/iu);
    expect(rows[0]?.sql).toMatch(/NEW\.dispatched_at\s*<\s*NEW\.bound_at/iu);
    expect(rows[0]?.sql).toMatch(/NEW\.message_payload_hash\s*<>\s*OLD\.message_payload_hash/iu);
    expect(rows[0]?.sql).toMatch(
      /NEW\.payload_authority_manifest_hash\s*<>\s*OLD\.payload_authority_manifest_hash/iu,
    );
    expect(rows[0]?.sql).not.toMatch(/dispatched'\s+AND\s+NEW\.state\s*=\s*'reserved/iu);
    await executor.close();
  });

  it("fails closed until two live priced targets, 192 calls and a per-currency ceiling exist", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);

    await expect(startRun(executor, ids.runId)).rejects.toThrow(/commercial dispatch authority/iu);
    await expect(
      executor.execute(
        `INSERT INTO novel_skill_evaluation_dispatch_authorizations (
           id, run_id, protocol_hash, target_manifest_hash, pricing_manifest_hash,
           quote_hash, confirmation_hash, authorized_call_count, authorized_by,
           commercial_use_acknowledged, authorized_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 191, 'local_user', 1, ?)`,
        [
          ids.authorizationId,
          ids.runId,
          "1".repeat(64),
          "2".repeat(64),
          "3".repeat(64),
          "4".repeat(64),
          "5".repeat(64),
          NOW,
        ],
      ),
    ).rejects.toThrow(/CHECK constraint/iu);
    await insertAuthorization(executor, ids);
    await expect(startRun(executor, ids.runId)).rejects.toThrow(/commercial dispatch authority/iu);
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_authorization_limits (
         authorization_id, currency, estimated_max_cost_micros,
         hard_ceiling_micros, created_at
       ) VALUES (?, 'USD', '100000', '120000', ?)`,
      [ids.authorizationId, NOW],
    );
    await expect(startRun(executor, ids.runId)).resolves.toMatchObject({ rowsAffected: 1 });
    await executor.close();
  });

  it("rejects a target whose live catalog has no complete pricing evidence", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, true);
    await expect(insertTarget(executor, ids.runId, "text_tier_b", "b")).rejects.toThrow(
      /live exact priced/iu,
    );
    await executor.close();
  });

  it("rechecks exact connection and pricing authority when an authorized run starts", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await insertAuthorization(executor, ids);
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_authorization_limits (
         authorization_id, currency, estimated_max_cost_micros, hard_ceiling_micros, created_at
       ) VALUES (?, 'USD', '100000', '120000', ?)`,
      [ids.authorizationId, NOW],
    );
    await executor.execute(
      `UPDATE model_provider_connections
       SET connection_status = 'degraded', revision = revision + 1, updated_at = ?
       WHERE id = 'paid-connection-a'`,
      [NOW],
    );
    await expect(startRun(executor, ids.runId)).rejects.toThrow(/commercial dispatch authority/iu);
    await executor.close();
  });

  it("rejects non-streaming request profiles and non-provider model identities", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await expect(
      executor.execute(
        `INSERT INTO novel_skill_evaluation_request_profiles (
           suite_id, task_type, profile_version, request_profile_hash,
           maximum_input_tokens, maximum_output_tokens, temperature_basis_points,
           top_p_basis_points, reasoning_policy, response_format, streaming,
           stop_policy_hash, created_at
         ) VALUES (?, 'rewrite', 'model-hub-exact-evaluation-request@1', ?, 7000, 2048, 0, 10000,
                   'disabled', 'text', 0, ?, ?)`,
        [
          ids.suiteId,
          "b".repeat(64),
          "896247754b670bf5c4ac89424e7c5f2fffa598df9adcdc1377d8fcf0868831a6",
          NOW,
        ],
      ),
    ).rejects.toThrow(/CHECK constraint/iu);
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_run_model_targets
         SET artifact_identity_source = 'provider_version'
         WHERE run_id = ? AND model_slot_id = 'text_tier_a'`,
        [ids.runId],
      ),
    ).rejects.toThrow(/CHECK constraint|immutable/iu);
    await executor.close();
  });

  it("allows a pre-dispatch release but rejects skipping the bound dispatch state", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await insertAuthorization(executor, ids);
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_authorization_limits (
         authorization_id, currency, estimated_max_cost_micros, hard_ceiling_micros, created_at
       ) VALUES (?, 'USD', '100000', '120000', ?)`,
      [ids.authorizationId, NOW],
    );
    await startRun(executor, ids.runId);
    const cellId = "019f9f4a-b3c7-7350-8002-000000000001";
    const firstAttemptId = "019f9f4a-b3c7-7350-8003-000000000001";
    const firstReservationId = "019f9f4a-b3c7-7350-8003-000000000002";
    await insertStartedAttempt(executor, ids.runId, cellId, firstAttemptId, 1);
    await insertReservation(executor, ids, cellId, firstAttemptId, firstReservationId, 1);
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'dispatched', bound_at = ?, dispatched_at = ?, revision = revision + 1
         WHERE id = ?`,
        [NOW, NOW, firstReservationId],
      ),
    ).rejects.toThrow(/transition is invalid/iu);
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'not_dispatched', terminal_at = ?, revision = revision + 1 WHERE id = ?`,
        [NOW, firstReservationId],
      ),
    ).rejects.toThrow(/transition is invalid/iu);
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'not_dispatched', bound_at = ?, terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        [NOW, NOW, firstReservationId],
      ),
    ).rejects.toThrow(/transition is invalid/iu);
    await executor.execute(
      `UPDATE novel_skill_evaluation_attempts
       SET status = 'cancelled', error_code = 'PRE_DISPATCH_CANCELLED', completed_at = ?
       WHERE id = ?`,
      [NOW, firstAttemptId],
    );
    await executor.execute(
      `UPDATE novel_skill_evaluation_dispatch_reservations
       SET state = 'not_dispatched', terminal_at = ?, revision = revision + 1 WHERE id = ?`,
      [NOW, firstReservationId],
    );
    const secondAttemptId = "019f9f4a-b3c7-7350-8003-000000000003";
    await insertStartedAttempt(executor, ids.runId, cellId, secondAttemptId, 2);
    await expect(
      insertReservation(
        executor,
        ids,
        cellId,
        secondAttemptId,
        "019f9f4a-b3c7-7350-8003-000000000004",
        2,
      ),
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await executor.close();
  });

  it("releases a bound reservation only after its invocation and attempt are cancelled", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await authorizeAndStart(executor, ids);
    const cellId = "019f9f4a-b3c7-7350-8002-000000000001";
    const attemptId = "019f9f4a-b3c7-7350-8003-000000000011";
    const reservationId = "019f9f4a-b3c7-7350-8003-000000000012";
    await insertStartedAttempt(executor, ids.runId, cellId, attemptId, 1);
    await insertReservation(executor, ids, cellId, attemptId, reservationId, 1);
    const dispatch = await bindReservation(executor, ids, attemptId, reservationId, 1);
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'not_dispatched', terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        [NOW, reservationId],
      ),
    ).rejects.toThrow(/transition is invalid/iu);
    await executor.execute(
      `UPDATE model_invocation_facts
       SET status = 'cancelled', started_at = ?, completed_at = ?, revision = revision + 1
       WHERE id = ?`,
      [NOW, NOW, dispatch.invocationId],
    );
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'not_dispatched', terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        [NOW, reservationId],
      ),
    ).rejects.toThrow(/transition is invalid/iu);
    await executor.execute(
      `UPDATE novel_skill_evaluation_attempts
       SET status = 'cancelled', error_code = 'PRE_DISPATCH_CANCELLED', completed_at = ?
       WHERE id = ?`,
      [NOW, attemptId],
    );
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'not_dispatched', terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        [NOW, reservationId],
      ),
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await executor.close();
  });

  it("permits only one active dispatch per paid run across runtime instances", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await authorizeAndStart(executor, ids);
    const cells = await executor.select<{ readonly id: string }>(
      `SELECT id FROM novel_skill_evaluation_cells
       WHERE run_id = ? AND state = 'planned' ORDER BY id LIMIT 2`,
      [ids.runId],
    );
    const firstCell = cells[0]?.id;
    const secondCell = cells[1]?.id;
    if (firstCell === undefined || secondCell === undefined) {
      throw new Error("paid evaluation cells are missing");
    }
    const firstAttemptId = "019f9f4a-b3c7-7350-8003-000000000013";
    const secondAttemptId = "019f9f4a-b3c7-7350-8003-000000000014";
    await insertStartedAttempt(executor, ids.runId, firstCell, firstAttemptId, 1);
    await insertStartedAttempt(executor, ids.runId, secondCell, secondAttemptId, 1);
    await insertReservation(
      executor,
      ids,
      firstCell,
      firstAttemptId,
      "019f9f4a-b3c7-7350-8003-000000000015",
      1,
    );
    await expect(
      insertReservation(
        executor,
        ids,
        secondCell,
        secondAttemptId,
        "019f9f4a-b3c7-7350-8003-000000000016",
        1,
      ),
    ).rejects.toThrow(/UNIQUE constraint/iu);
    await executor.close();
  });

  it("refuses to cross the provider boundary after the paid run is invalidated", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await authorizeAndStart(executor, ids);
    const cellId = "019f9f4a-b3c7-7350-8002-000000000001";
    const attemptId = "019f9f4a-b3c7-7350-8003-000000000017";
    const reservationId = "019f9f4a-b3c7-7350-8003-000000000018";
    await insertStartedAttempt(executor, ids.runId, cellId, attemptId, 1);
    await insertReservation(executor, ids, cellId, attemptId, reservationId, 1);
    const dispatch = await bindReservation(executor, ids, attemptId, reservationId, 1);
    await executor.execute(
      `UPDATE novel_skill_evaluation_runs
       SET status = 'invalidated', evaluation_status = 'EVIDENCE_INCOMPLETE',
           completed_at = ?, revision = revision + 1 WHERE id = ?`,
      [NOW, ids.runId],
    );
    await expect(
      dispatchReservation(executor, reservationId, dispatch.invocationId),
    ).rejects.toThrow(/transition is invalid/iu);
    await executor.close();
  });

  it("marks a dispatched reservation ambiguous only after exact interrupted terminals", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await authorizeAndStart(executor, ids);
    const cellId = "019f9f4a-b3c7-7350-8002-000000000001";
    const attemptId = "019f9f4a-b3c7-7350-8003-000000000021";
    const reservationId = "019f9f4a-b3c7-7350-8003-000000000022";
    await insertStartedAttempt(executor, ids.runId, cellId, attemptId, 1);
    await insertReservation(executor, ids, cellId, attemptId, reservationId, 1);
    const dispatch = await bindReservation(executor, ids, attemptId, reservationId, 1);
    await dispatchReservation(executor, reservationId, dispatch.invocationId);
    await executor.execute(
      `UPDATE model_invocation_facts
       SET status = 'failed', error_code = 'DISPATCH_INTERRUPTED',
           failure_stage = 'dispatch', failure_retryable = 0,
           completed_at = ?, revision = revision + 1
       WHERE id = ?`,
      [NOW, dispatch.invocationId],
    );
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'ambiguous', terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        [NOW, reservationId],
      ),
    ).rejects.toThrow(/transition is invalid/iu);
    await executor.execute(
      `UPDATE novel_skill_evaluation_attempts
       SET status = 'cancelled', error_code = 'DISPATCH_INTERRUPTED', completed_at = ?
       WHERE id = ?`,
      [NOW, attemptId],
    );
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'ambiguous', terminal_at = ?, revision = revision
         WHERE id = ?`,
        [NOW, reservationId],
      ),
    ).rejects.toThrow(/transition is invalid/iu);
    await executor.execute(
      `UPDATE novel_skill_evaluation_dispatch_reservations
       SET state = 'ambiguous', terminal_at = ?, revision = revision + 1
       WHERE id = ?`,
      [NOW, reservationId],
    );
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET provider_receipt_hash = ?, revision = revision + 1 WHERE id = ?`,
        ["d".repeat(64), reservationId],
      ),
    ).rejects.toThrow(/transition is invalid/iu);
    await executor.close();
  });

  it("settles a failed dispatch only when the outcome matches both terminal facts", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await authorizeAndStart(executor, ids);
    const cellId = "019f9f4a-b3c7-7350-8002-000000000001";
    const attemptId = "019f9f4a-b3c7-7350-8003-000000000031";
    const reservationId = "019f9f4a-b3c7-7350-8003-000000000032";
    await insertStartedAttempt(executor, ids.runId, cellId, attemptId, 1);
    await insertReservation(executor, ids, cellId, attemptId, reservationId, 1);
    const dispatch = await bindReservation(executor, ids, attemptId, reservationId, 1);
    await dispatchReservation(executor, reservationId, dispatch.invocationId);
    await executor.execute(
      `UPDATE model_invocation_facts
       SET status = 'timed_out', error_code = 'MODEL_TIMEOUT', failure_stage = 'transport',
           failure_retryable = 0, completed_at = ?, revision = revision + 1
       WHERE id = ?`,
      [NOW, dispatch.invocationId],
    );
    await executor.execute(
      `UPDATE novel_skill_evaluation_attempts
       SET status = 'failed', error_code = 'MODEL_TIMEOUT', completed_at = ?
       WHERE id = ?`,
      [NOW, attemptId],
    );
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'settled', settlement_outcome = 'failed', provider_receipt_hash = ?,
             actual_cost_micros = '1', terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        ["e".repeat(64), NOW, reservationId],
      ),
    ).rejects.toThrow(/exact visible Candidate evidence/iu);
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'settled', settlement_outcome = 'timed_out', provider_receipt_hash = ?,
             actual_cost_micros = '1', terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        ["e".repeat(64), NOW, reservationId],
      ),
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await executor.close();
  });

  it("settles success only after a visible isolated Candidate and succeeded facts exist", async () => {
    const executor = new NodeSqliteExecutor(`${foundation}\n${paidRunnerMigration}`);
    const ids = await seedAuthorizedPlan(executor, false);
    await authorizeAndStart(executor, ids);
    const cellId = "019f9f4a-b3c7-7350-8002-000000000001";
    const attemptId = "019f9f4a-b3c7-7350-8003-000000000041";
    const reservationId = "019f9f4a-b3c7-7350-8003-000000000042";
    await insertStartedAttempt(executor, ids.runId, cellId, attemptId, 1);
    await insertReservation(executor, ids, cellId, attemptId, reservationId, 1);
    const dispatch = await bindReservation(executor, ids, attemptId, reservationId, 1);
    await dispatchReservation(executor, reservationId, dispatch.invocationId);
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'settled', settlement_outcome = 'succeeded', provider_receipt_hash = ?,
             provider_visible_output_hash = ?, output_candidate_id = ?,
             actual_cost_micros = '1', terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        ["f".repeat(64), "a".repeat(64), dispatch.candidateId, NOW, reservationId],
      ),
    ).rejects.toThrow(/FOREIGN KEY|exact visible Candidate evidence/iu);
    await executor.execute(
      `UPDATE model_invocation_facts
       SET status = 'succeeded', input_tokens = 1, output_tokens = 1,
           estimated_cost_micros = '1', finish_reason = 'stop', visible_content_length = 3,
           streamed = 0, requested_max_output_tokens = 2048,
           completed_at = ?, revision = revision + 1
       WHERE id = ?`,
      [NOW, dispatch.invocationId],
    );
    await executor.execute(
      `UPDATE novel_skill_evaluation_attempts
       SET status = 'succeeded', completed_at = ? WHERE id = ?`,
      [NOW, attemptId],
    );
    await executor.execute(
      `INSERT INTO ai_candidates (
         id, project_id, chapter_id, source, base_version_id, content, content_checksum,
         status, incomplete, created_at, updated_at, decided_at
       ) VALUES (?, ?, NULL, 'generate', NULL, '结果文本', ?, 'ready', 0, ?, ?, NULL)`,
      [dispatch.candidateId, ids.projectId, "a".repeat(64), NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO context_compilation_output_candidate_links (
         trace_id, ai_candidate_id, linked_at
       ) VALUES (?, ?, ?)`,
      [dispatch.traceId, dispatch.candidateId, NOW],
    );
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'settled', settlement_outcome = 'succeeded', provider_receipt_hash = ?,
             provider_visible_output_hash = ?, output_candidate_id = ?,
             actual_cost_micros = '1', terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        ["f".repeat(64), "a".repeat(64), dispatch.candidateId, NOW, reservationId],
      ),
    ).rejects.toThrow(/exact visible Candidate evidence/iu);
    await executor.execute(
      `UPDATE model_invocation_facts
       SET streamed = 1, revision = revision + 1 WHERE id = ?`,
      [dispatch.invocationId],
    );
    await expect(
      executor.execute(
        `UPDATE novel_skill_evaluation_dispatch_reservations
         SET state = 'settled', settlement_outcome = 'succeeded', provider_receipt_hash = ?,
             provider_visible_output_hash = ?, output_candidate_id = ?,
             actual_cost_micros = '1', terminal_at = ?, revision = revision + 1
         WHERE id = ?`,
        ["f".repeat(64), "a".repeat(64), dispatch.candidateId, NOW, reservationId],
      ),
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await expect(
      executor.execute("DELETE FROM context_compilation_execution_links WHERE trace_id = ?", [
        dispatch.traceId,
      ]),
    ).rejects.toThrow(/execution links cannot be deleted/iu);
    await executor.close();
  });
});

const NOW = "2026-08-10T00:00:00.000Z";

interface PaidPlanIds {
  readonly projectId: string;
  readonly suiteId: string;
  readonly runId: string;
  readonly authorizationId: string;
}

async function seedAuthorizedPlan(
  executor: NodeSqliteExecutor,
  leaveSecondTargetUnpriced: boolean,
): Promise<PaidPlanIds> {
  const projectId = "019f9f4a-b3c7-7350-8001-000000000001";
  const suiteId = "019f9f4a-b3c7-7350-8001-000000000002";
  const runId = "019f9f4a-b3c7-7350-8001-000000000003";
  const authorizationId = "019f9f4a-b3c7-7350-8001-000000000004";
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at, archived_at
     ) VALUES (?, 'Paid evaluation fixture', 'archived', 1, 0, ?, ?, ?)`,
    [projectId, NOW, NOW, NOW],
  );
  for (const [skillId, kind, definitionHash, precedence] of [
    ["core.paid_test", "core", "a".repeat(64), 200],
    ["genre.paid_test", "genre", "b".repeat(64), 300],
  ] as const) {
    await executor.execute(
      `INSERT INTO novel_skill_definitions (
         skill_id, version, display_name, summary, kind, owner_scope, status,
         default_enabled, precedence, task_types_json, activation_json,
         context_requirements_json, instructions_json, output_contract_json,
         validation_json, definition_hash, created_at
       ) VALUES (?, '1.0.0', ?, 'paid evaluation test', ?, 'builtin', 'experimental',
                 0, ?, '["continuation"]', ?, '{}', '{}', '{}', '{}', ?, ?)`,
      [
        skillId,
        skillId,
        kind,
        precedence,
        kind === "core"
          ? '{"allowedModes":["draft"],"genreTags":[]}'
          : '{"allowedModes":["draft"],"genreTags":["campus_romance"]}',
        definitionHash,
        NOW,
      ],
    );
  }
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_suites (
       id, schema_version, evaluator_version, compiler_version, evaluation_project_id,
       plan_hash, fixture_set_hash, target_manifest_hash, core_manifest_hash,
       core_genre_manifest_hash, core_genre_preferences_manifest_hash,
       preference_configuration_hash, model_slots_json, minimum_repetitions, created_at
     ) VALUES (?, 1, 'novel-skill-ab@1', 'novel-skill-compiler@1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
    [
      suiteId,
      projectId,
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
      "6".repeat(64),
      "7".repeat(64),
      JSON.stringify([
        { slotId: "text_tier_a", modelTier: "economy" },
        { slotId: "text_tier_b", modelTier: "quality" },
      ]),
      NOW,
    ],
  );
  for (const [arm, items] of [
    ["core", [["core.paid_test", "core", "a".repeat(64)]]],
    [
      "core_genre",
      [
        ["core.paid_test", "core", "a".repeat(64)],
        ["genre.paid_test", "genre", "b".repeat(64)],
      ],
    ],
    [
      "core_genre_preferences",
      [
        ["core.paid_test", "core", "a".repeat(64)],
        ["genre.paid_test", "genre", "b".repeat(64)],
      ],
    ],
  ] as const) {
    for (const [index, [skillId, kind, definitionHash]] of items.entries()) {
      await executor.execute(
        `INSERT INTO novel_skill_evaluation_manifest_items (
           suite_id, arm, item_order, skill_id, skill_version, definition_hash, kind
         ) VALUES (?, ?, ?, ?, '1.0.0', ?, ?)`,
        [suiteId, arm, index + 1, skillId, definitionHash, kind],
      );
    }
  }
  const dimensions = [
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
  ] as const;
  for (const [index, dimension] of dimensions.entries()) {
    const fixtureId = `paid.fixture.${String(index + 1).padStart(2, "0")}`;
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_fixtures (
         suite_id, fixture_id, language, origin, task_type, invocation_mode,
         genre_tags_json, coverage_dimensions_json, contract_hash, input_content_hash
       ) VALUES (?, ?, 'zh-CN', 'inkshadow_original_short_contract',
                 'continuation', 'draft', '["campus_romance"]', ?, ?, ?)`,
      [
        suiteId,
        fixtureId,
        JSON.stringify([dimension]),
        (index + 1).toString(16).padStart(64, "0"),
        (index + 17).toString(16).padStart(64, "0"),
      ],
    );
  }
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_runs (
       id, suite_id, status, evaluation_status, model_assignments_json,
       revision, started_at, completed_at, created_at
     ) VALUES (?, ?, 'planned', 'NOT_EVALUATED', ?, 1, NULL, NULL, ?)`,
    [
      runId,
      suiteId,
      JSON.stringify([
        {
          slotId: "text_tier_a",
          modelIdentityHash: "c".repeat(64),
          modelArtifactHash: "d".repeat(64),
        },
        {
          slotId: "text_tier_b",
          modelIdentityHash: "e".repeat(64),
          modelArtifactHash: "f".repeat(64),
        },
      ]),
      NOW,
    ],
  );
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_protocols (
       suite_id, schema_version, execution_protocol_version, protocol_hash,
       request_profile_manifest_hash, context_baseline_manifest_hash,
       prompt_template_version, prompt_template_hash, rubric_version,
       rubric_content_hash, evaluator_contract_hash, blinding_protocol_version,
       blinding_protocol_hash, randomization_protocol_version,
       randomization_protocol_hash, created_at
     ) VALUES (?, 1, 'novel-skill-paid-ab@1', ?, ?, ?, 'paid-template@1', ?,
               'novel-skill-human-rubric@1', ?, ?, 'blind@1', ?, 'random@1', ?, ?)`,
    [
      suiteId,
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
      "6".repeat(64),
      "7".repeat(64),
      "8".repeat(64),
      NOW,
    ],
  );
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_request_profiles (
       suite_id, task_type, profile_version, request_profile_hash,
       maximum_input_tokens, maximum_output_tokens, temperature_basis_points,
       top_p_basis_points, reasoning_policy, response_format, streaming,
       stop_policy_hash, created_at
     ) VALUES (?, 'continuation', 'model-hub-exact-evaluation-request@1', ?, 7000, 2048, 0, 10000,
               'disabled', 'text', 1, ?, ?)`,
    [
      suiteId,
      "9".repeat(64),
      "896247754b670bf5c4ac89424e7c5f2fffa598df9adcdc1377d8fcf0868831a6",
      NOW,
    ],
  );
  for (let index = 0; index < 12; index += 1) {
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_context_baselines (
         suite_id, fixture_id, baseline_contract_hash, included_source_manifest_hash,
         omitted_source_manifest_hash, compiled_baseline_hash, baseline_token_budget, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 7000, ?)`,
      [
        suiteId,
        `paid.fixture.${String(index + 1).padStart(2, "0")}`,
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
        (index + 33).toString(16).padStart(64, "0"),
        NOW,
      ],
    );
  }
  let cellIndex = 1;
  for (let fixture = 1; fixture <= 12; fixture += 1) {
    for (const [arm, armHash] of [
      ["no_skill", null],
      ["core", "4".repeat(64)],
      ["core_genre", "5".repeat(64)],
      ["core_genre_preferences", "6".repeat(64)],
    ] as const) {
      for (const [slotId, modelTier] of [
        ["text_tier_a", "economy"],
        ["text_tier_b", "quality"],
      ] as const) {
        for (const repetition of [1, 2] as const) {
          await executor.execute(
            `INSERT INTO novel_skill_evaluation_cells (
               id, run_id, suite_id, fixture_id, arm, arm_configuration_hash,
               model_slot_id, model_tier, repetition, state, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
            [
              `019f9f4a-b3c7-7350-8002-${cellIndex.toString(16).padStart(12, "0")}`,
              runId,
              suiteId,
              `paid.fixture.${String(fixture).padStart(2, "0")}`,
              arm,
              armHash,
              slotId,
              modelTier,
              repetition,
              NOW,
            ],
          );
          cellIndex += 1;
        }
      }
    }
  }
  await seedTargetModel(executor, "a", true);
  await seedTargetModel(executor, "b", !leaveSecondTargetUnpriced);
  await insertTarget(executor, runId, "text_tier_a", "a");
  if (!leaveSecondTargetUnpriced) {
    await insertTarget(executor, runId, "text_tier_b", "b");
  }
  return { projectId, suiteId, runId, authorizationId };
}

async function seedTargetModel(
  executor: NodeSqliteExecutor,
  suffix: "a" | "b",
  priced: boolean,
): Promise<void> {
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, base_url, credential_ref,
       credential_state, connection_status, enabled, revision, created_at, updated_at
     ) VALUES (?, 'deepseek', ?, 'openai_compatible', ?, ?, 'present', 'ready', 1, 1, ?, ?)`,
    [
      `paid-connection-${suffix}`,
      `Paid target ${suffix}`,
      `https://${suffix}.example.test/v1`,
      `keyring:paid-${suffix}`,
      NOW,
      NOW,
    ],
  );
  await executor.execute(
    `INSERT INTO model_catalog_entries (
       id, connection_id, provider_model_id, display_name, catalog_source,
       availability, lifecycle, first_discovered_at, last_seen_at, revision
     ) VALUES (?, ?, ?, ?, 'manual', 'available', 'stable', ?, ?, 1)`,
    [
      `paid-catalog-${suffix}`,
      `paid-connection-${suffix}`,
      `paid-model-${suffix}`,
      `Paid model ${suffix}`,
      NOW,
      NOW,
    ],
  );
  if (priced) {
    await executor.execute(
      `INSERT INTO model_cost_privacy_profiles (
         catalog_entry_id, currency, input_micros_per_million_tokens,
         output_micros_per_million_tokens, cached_input_micros_per_million_tokens,
         pricing_version, price_updated_at, data_destination, retention_policy,
         training_policy, evidence_source, evidence_version, evidence_updated_at,
         revision, created_at, updated_at
       ) VALUES (?, 'USD', '1000', '2000', NULL, 'paid-price@1', ?, 'remote',
                 'provider_default', 'provider_default', 'user_confirmed',
                 'paid-price@1', ?, 1, ?, ?)`,
      [`paid-catalog-${suffix}`, NOW, NOW, NOW, NOW],
    );
  }
}

function insertTarget(
  executor: NodeSqliteExecutor,
  runId: string,
  slotId: "text_tier_a" | "text_tier_b",
  suffix: "a" | "b",
) {
  return executor.execute(
    `INSERT INTO novel_skill_evaluation_run_model_targets (
       run_id, model_slot_id, connection_id, catalog_entry_id,
       provider_kind_snapshot, connection_protocol_snapshot, connection_revision,
       connection_configuration_hash, catalog_revision, provider_model_id_snapshot,
       catalog_identity_hash, model_identity_hash, model_artifact_hash,
       artifact_identity_source, cost_profile_revision, currency,
       input_micros_per_million_tokens, output_micros_per_million_tokens,
       cached_input_micros_per_million_tokens, pricing_version, price_updated_at,
       pricing_snapshot_hash, target_hash, created_at
     ) VALUES (?, ?, ?, ?, 'deepseek', 'openai_compatible', 1, ?, 1, ?, ?, ?, ?,
               'provider_model_id', 1, 'USD', '1000', '2000', NULL,
               'paid-price@1', ?, ?, ?, ?)`,
    [
      runId,
      slotId,
      `paid-connection-${suffix}`,
      `paid-catalog-${suffix}`,
      `${suffix}`.repeat(64),
      `paid-model-${suffix}`,
      `${suffix === "a" ? "1" : "2"}`.repeat(64),
      suffix === "a" ? "c".repeat(64) : "e".repeat(64),
      suffix === "a" ? "d".repeat(64) : "f".repeat(64),
      NOW,
      `${suffix === "a" ? "3" : "4"}`.repeat(64),
      `${suffix === "a" ? "5" : "6"}`.repeat(64),
      NOW,
    ],
  );
}

function insertAuthorization(executor: NodeSqliteExecutor, ids: PaidPlanIds) {
  return executor.execute(
    `INSERT INTO novel_skill_evaluation_dispatch_authorizations (
       id, run_id, protocol_hash, target_manifest_hash, pricing_manifest_hash,
       quote_hash, confirmation_hash, authorized_call_count, authorized_by,
       commercial_use_acknowledged, authorized_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 192, 'local_user', 1, ?)`,
    [
      ids.authorizationId,
      ids.runId,
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
      NOW,
    ],
  );
}

function startRun(executor: NodeSqliteExecutor, runId: string) {
  return executor.execute(
    `UPDATE novel_skill_evaluation_runs
     SET status = 'running', started_at = ?, revision = revision + 1
     WHERE id = ?`,
    [NOW, runId],
  );
}

async function authorizeAndStart(executor: NodeSqliteExecutor, ids: PaidPlanIds): Promise<void> {
  await insertAuthorization(executor, ids);
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_authorization_limits (
       authorization_id, currency, estimated_max_cost_micros, hard_ceiling_micros, created_at
     ) VALUES (?, 'USD', '100000', '120000', ?)`,
    [ids.authorizationId, NOW],
  );
  await startRun(executor, ids.runId);
}

function insertStartedAttempt(
  executor: NodeSqliteExecutor,
  runId: string,
  cellId: string,
  attemptId: string,
  attemptNumber: number,
) {
  return executor.execute(
    `INSERT INTO novel_skill_evaluation_attempts (
       id, run_id, cell_id, attempt_number, status, context_trace_id,
       model_invocation_id, error_code, started_at, completed_at
     ) VALUES (?, ?, ?, ?, 'started', NULL, NULL, NULL, ?, NULL)`,
    [attemptId, runId, cellId, attemptNumber, NOW],
  );
}

function insertReservation(
  executor: NodeSqliteExecutor,
  ids: PaidPlanIds,
  cellId: string,
  attemptId: string,
  reservationId: string,
  generation: number,
) {
  const suffix = generation.toString(16).padStart(12, "0");
  return executor.execute(
    `INSERT INTO novel_skill_evaluation_dispatch_reservations (
       id, authorization_id, run_id, cell_id, attempt_id, model_slot_id,
       dispatch_generation, planned_context_trace_id, planned_model_invocation_id,
       planned_candidate_id, state, target_hash, pricing_snapshot_hash,
       request_profile_hash, context_baseline_hash, prompt_template_hash,
       invariant_request_hash, request_payload_hash, execution_lock_hash,
       message_payload_hash, payload_authority_version,
       payload_authority_manifest_hash, data_destination, skill_configuration_hash,
       preference_configuration_hash,
       idempotency_key_hash, currency,
       reserved_max_cost_micros, settlement_outcome, provider_receipt_hash,
       provider_visible_output_hash, output_candidate_id, actual_cost_micros,
       reserved_at, bound_at, dispatched_at, terminal_at, revision
     ) VALUES (?, ?, ?, ?, ?, 'text_tier_a', ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'novel-skill-paid-payload-authority@1', ?, 'remote',
               NULL, NULL, ?, 'USD', '100', NULL, NULL, NULL, NULL, NULL,
               ?, NULL, NULL, NULL, 1)`,
    [
      reservationId,
      ids.authorizationId,
      ids.runId,
      cellId,
      attemptId,
      generation,
      `019f9f4a-b3c7-7350-8004-${suffix}`,
      `paid-invocation-${generation}`,
      `019f9f4a-b3c7-7350-8005-${suffix}`,
      "5".repeat(64),
      "3".repeat(64),
      "9".repeat(64),
      (33).toString(16).padStart(64, "0"),
      "4".repeat(64),
      "7".repeat(64),
      "e".repeat(64),
      "8".repeat(64),
      "d".repeat(64),
      "c".repeat(64),
      generation.toString(16).padStart(64, "0"),
      NOW,
    ],
  );
}

interface BoundDispatch {
  readonly candidateId: string;
  readonly invocationId: string;
  readonly traceId: string;
}

async function bindReservation(
  executor: NodeSqliteExecutor,
  ids: PaidPlanIds,
  attemptId: string,
  reservationId: string,
  generation: number,
): Promise<BoundDispatch> {
  const suffix = generation.toString(16).padStart(12, "0");
  const traceId = `019f9f4a-b3c7-7350-8004-${suffix}`;
  const invocationId = `paid-invocation-${generation}`;
  const candidateId = `019f9f4a-b3c7-7350-8005-${suffix}`;
  await executor.execute(
    `INSERT INTO context_compilation_runs (
       id, project_id, chapter_id, task_type, maximum_context_tokens,
       required_tokens, used_tokens, remaining_tokens, discarded_tokens,
       token_estimate_source, candidate_count, included_count, discarded_count, created_at
     ) VALUES (?, ?, NULL, 'continuation', 7000, 1, 1, 6999, 0,
               'utf8_conservative', 1, 1, 0, ?)`,
    [traceId, ids.projectId, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_entries (
       run_id, candidate_id, layer, selection_reason, included, discarded_reason,
       estimated_tokens, evaluation_order, layer_order, priority, relevance_score,
       required, budget_remaining_before, budget_remaining_after
     ) VALUES (?, 'evaluation-fixture:paid.fixture.01', 'current_task',
               'evaluation_fixture_required', 1, NULL, 1, 1, 1, 1000, 1, 1, 7000, 6999)`,
    [traceId],
  );
  await executor.execute(
    `INSERT INTO context_compilation_entry_sources (
       run_id, candidate_id, source_order, source_type, source_id,
       source_version_id, locator, content_hash
     ) VALUES (?, 'evaluation-fixture:paid.fixture.01', 1, 'user_input',
               'paid.fixture.01', NULL, 'novel_skill_evaluation_fixture', ?)`,
    [traceId, (17).toString(16).padStart(64, "0")],
  );
  await executor.execute(
    `INSERT INTO context_compilation_execution_links (
       trace_id, generation_id, generation_run_id, created_at
     ) VALUES (?, ?, NULL, ?)`,
    [traceId, `019f9f4a-b3c7-7350-8006-${suffix}`, NOW],
  );
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, route_task, connection_id, catalog_entry_id,
       provider_kind_snapshot, model_id_snapshot, route_reason, status, attempt,
       fallback_from_invocation_id, privacy_policy, data_destination,
       maximum_cost_micros, currency, created_at
     ) VALUES (?, 'continuation', NULL, 'paid-connection-a', 'paid-catalog-a',
               'deepseek', 'paid-model-a', 'user_override', 'queued', 1,
               NULL, 'cloud_allowed', 'remote', '100', 'USD', ?)`,
    [invocationId, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_model_invocation_links (
       trace_id, model_invocation_id, linked_at
     ) VALUES (?, ?, ?)`,
    [traceId, invocationId, NOW],
  );
  await executor.execute(
    `UPDATE novel_skill_evaluation_attempts
     SET context_trace_id = ?, model_invocation_id = ?
     WHERE id = ?`,
    [traceId, invocationId, attemptId],
  );
  await executor.execute(
    `UPDATE novel_skill_evaluation_dispatch_reservations
     SET state = 'bound', bound_at = ?, revision = revision + 1
     WHERE id = ?`,
    [NOW, reservationId],
  );
  return { candidateId, invocationId, traceId };
}

async function dispatchReservation(
  executor: NodeSqliteExecutor,
  reservationId: string,
  invocationId: string,
): Promise<void> {
  await executor.execute(
    `UPDATE model_invocation_facts
     SET status = 'running', started_at = ?, revision = revision + 1
     WHERE id = ?`,
    [NOW, invocationId],
  );
  await executor.execute(
    `UPDATE novel_skill_evaluation_dispatch_reservations
     SET state = 'dispatched', dispatched_at = ?, revision = revision + 1
     WHERE id = ?`,
    [NOW, reservationId],
  );
}
