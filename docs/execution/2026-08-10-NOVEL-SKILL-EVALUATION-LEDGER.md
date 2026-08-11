# Novel Skill A/B evaluation ledger — implementation evidence

## Scope and safety contract

This change adds and hardens the pre-enable audit trail. The implementation can dispatch only after the author explicitly confirms the paid start action; no real provider request was dispatched during this work. It does not enable a Novel Skill by default, modify a skill definition, or silently modify a project binding. The desktop writing runtime is a separate, explicitly author-controlled experimental consumer of Novel Skills; the ledger itself neither enables that runtime nor proves that Skills improve output.

The ledger stores only:

- original fixture metadata: identifier, task, mode, genre tags, source marker, and a SHA-256 contract hash;
- two portable model-slot labels, four A/B arms, a repetition number, planning and lifecycle state;
- an exact applicability manifest for the fixture, task, genre, considered definitions, selected definitions, and task/genre mismatch omissions;
- exact attempt state, `model_invocation_facts` receipt, the matching `novel_skill_invocation_snapshots` receipt when an applicable arm uses Skills, the isolated Candidate, result hash, Unicode visible length, and bounded usage/latency/cost values;
- separately collected metric scores and immutable manual-decision hashes.

It never stores a prompt, chapter/body text, model output, provider reasoning, API key, credential, evaluator free text, or a commercial-fiction excerpt. The dedicated fixture project is blank and archived. Failed and cancelled attempts are still recorded content-free so that a paid failure cannot disappear into an invisible retry loop. `no_skill` observations deliberately have no Skill snapshot; applicable Skill arms must point to a snapshot whose `model_invocation_id` is the exact observation invocation. A non-applicable arm must instead preserve the exact target as discarded for `task_mismatch` or `genre_mismatch`.

## Matrix

`createNovelSkillEvaluationExecutionPlan(...)` creates the complete plan:

- 12 original Chinese micro-contracts across continuation, POV, causal scene, action specificity, narrow rewrite, multi-line continuity, voice, world rule, foreshadow, dialogue revision, summary, and restrained polish;
- four arms: `no_skill`, `core`, `core_genre`, `core_genre_preferences`;
- exactly two distinct text-model slots;
- at least two repetitions per cell.

The default plan therefore has `12 × 4 × 2 × 2 = 192` planned cells. The scoring contract has 13 separately judged dimensions, or `192 × 13 = 2,496` manual score slots per complete run; the former eight-dimension draft is no longer accepted by the schema, store or evaluator. A run begins as `NOT_EVALUATED`, and a cell may become observed only after its exact attempt/output evidence and every required score are present. `NOT_EVALUATED` and `ELIGIBLE_FOR_REVIEW` never update a definition or binding; only a separate immutable human decision may approve an experimental binding, and SQLite rejects that decision unless a run is already completed with `ELIGIBLE_FOR_REVIEW`.

## Migrations and backup

- Data `0060` / Tauri `63`: immutable Novel Skill registry, project binding and invocation snapshots.
- Data `0061` / Tauri `64`: the fixed evaluation ledger and evidence chain.
- Data `0062` / Tauri `65`: the active-project dispatch guard; the same change set extends the existing `0045` lease to loopback dispatch and strengthens Candidate/context commit authority in Rust/TypeScript.
- Data `0063` / Tauri `66`: exact targets, protocol, commercial authorization, reservations and blind review.
- Data `0064` / Tauri `67`: immutable content-free predispatch authority.
- The base `0061` ledger contributes nine tables in child-first delete and dependency-safe restore order; the `0063`/`0064` sidecars and review authority are included in the same maintenance contract.
- The current maintenance contract covers 166 restorable author-data tables. The additional content-free native project-dispatch lease is deliberately excluded from restore.

## Historical base-ledger evidence (2026-08-10)

| Evidence scope                               | Result                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| Data migration and restore attack suite      | PASS — 2 files / 22 tests, including nine new semantic-tamper negatives   |
| AI Core Novel Skill evaluator                | PASS — 1 file / 17 tests; all three truncation aliases are rejected       |
| Desktop evaluation SQLite Store              | PASS — 1 file / 9 tests                                                   |
| Data / AI Core / Desktop TypeScript          | PASS — all three projects, exit code 0                                    |
| Rust local migrations                        | PASS — 8/8; covers Data 0060–0062 / Tauri 63–65 upgrade and restart paths |
| Focused ESLint / Prettier / diff / cargo fmt | PASS — zero warning/error and no whitespace or Rust formatting drift      |

The restore attack suite includes FK/CHECK-valid source rewrites, fixed-fixture and suite-hash replacement,
Candidate state mutation, output-link removal, Skill snapshot/hash changes, observation result-hash changes,
invalidated-to-planned state forgery, cross-cell attempt replacement, and evaluation-project Skill-binding
pollution. A failed restore rolls back the data and reconstructs all temporarily removed evaluation guards.
Exact commands and preserved intermediate failures are recorded in `TEST_RESULTS.md`.

## 2026-08-11 local execution authority

The independent review result now covers the complete local, content-free execution boundary:

- Data `0061` / Tauri `64`: fixed 192-cell evidence ledger and 13-score contract: **APPROVE**;
- Data `0063` / Tauri `66`: exact targets, fixed protocol, explicit commercial authorization, per-currency
  ceilings, crash-safe reservations and blind-review receipts: **APPROVE**;
- Data `0064` / Tauri `67`: one immutable content-free predispatch authority sidecar per reservation,
  including payload sub-hashes, live target/capability/price revisions, exact predispatch cost,
  provider-receipt shape and final-dispatch identity: **APPROVE**;
- paid Runner, expert-only UI, browser fail-closed behavior, cancellation and restart recovery with no
  automatic provider call: **APPROVE**;
- a real paid 192-call run, 2,496 human scores, `ELIGIBLE_FOR_REVIEW`, binding approval or default
  enablement: **NOT_RUN / KEEP_DISABLED**.

The hard provider boundary is the committed `bound → dispatched` transition, not the local run entering
`running`. Before that transition the Store recomputes the live connection, catalog, capability, pricing and
final-dispatch identity and compares them with the immutable sidecar. After dispatch, settlement uses the
frozen intrinsic authority so a later credential/catalog/price edit cannot orphan a legitimate response.
Legacy reservations without this sidecar may be released before dispatch, or marked ambiguous after dispatch,
but can never be newly bound, sent or accepted as a verified settlement.

The expert panel deliberately separates local preparation, quote and commercial authorization from the only
action that may call a provider: “手动开始 192 次付费调用”. Mounting, preparation, quoting, authorization,
restart recovery and blind review all make zero provider calls. No real provider A/B observation or manual score
was created in this change; real DeepSeek/Tauri cold-start execution and the default-enable decision remain
`NOT_RUN`.

The ordinary Browser/Tauri startup graph now loads only the lightweight lazy coordinator. The paid Tauri factory
is dynamically loaded only after the author expands the expert evaluation section, where initialization performs
local recovery and fails closed. The current production snapshot is 2,240 modules with a `6,651,786 / 6,717,440`
byte Vite payload; the ordinary runtime is `495,618 / 512,000` bytes and the paid async factory is
`287,543 / 512,000` bytes. The async factory remains part of the aggregate budget.

Current local evidence: paid infrastructure 10 files / 96 tests; Data paid migration and maintenance 2 files /
65 tests; Tauri migration chain 10/10; full Rust gate 160 passed / 1 ignored; full `release:check` exit code 0;
production Chromium E2E 11/11. These results remain local engineering evidence, not provider observations.

The truthful state remains:

```text
status = NOT_EVALUATED
observationCount = 0
manualScoreCount = 0
defaultEnablement = KEEP_DISABLED
```
