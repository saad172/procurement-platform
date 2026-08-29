/**
 * The data model (SPEC §3).
 *
 * One schema, split into files by the layer each table belongs to, with a
 * documented **authored / derived** convention rather than separate `seed` and
 * `app` Postgres schemas — derived rows FK into authored ones constantly, and a
 * cross-schema foreign key buys ceremony and nothing else.
 *
 *   enums       every closed set, as a pgEnum
 *   authored    written ONLY by src/db/seed.ts
 *   upstream    the response cache and the single home of usage
 *   entities    the entity graph projection — a Profile is a role, not a table
 *   matching    match → attempt → candidate → per-Discriminator verdict
 *   enrichment  one registry row, six typed value tables
 *   scoring     criterion_value, append-only. No score table, no shortlist table.
 *   narrative   assessment / recommendation → version → sentence → citation
 *   runs        run → job → job_round / trace_turn → trace_tool_call
 *   chat        thread → thread_message
 */
export * from './enums';
export * from './authored';
export * from './upstream';
export * from './entities';
export * from './matching';
export * from './enrichment';
export * from './scoring';
export * from './narrative';
export * from './runs';
export * from './chat';
