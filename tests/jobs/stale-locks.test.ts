import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { enqueueJob, openRun, requeueStaleJobs } from '@/jobs/runs';
import { saveRoundCheckpoint, loadRoundCheckpoint } from '@/jobs/checkpoint';
import { STALE_LOCK_MINUTES, STALE_SILENCE_MINUTES } from '@/config/constants';
import {
  START_TEST_DB_HINT,
  getTestDb,
  testDatabaseIsUp,
  testSql,
  type TestDb,
} from '../support/test-db';

/**
 * A worker that went away (SPEC §2.2, §5.3).
 *
 * A killed worker left its Job `running` for ever: no heartbeat, no lock
 * expiry, and recovery was a person noticing a Run that had stopped moving.
 *
 * **Both halves of the test matter.** A long lock alone is not evidence — the
 * measured recommend Job ran 62 minutes legitimately — so a Job is only taken
 * back when it has *also* been silent, writing no turn and no usage row for
 * fifteen minutes.
 */

const up = await testDatabaseIsUp();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
/** postgres.js wants an instant it can type; a bare `Date` in a raw tag cannot. */
const minutesAgoIso = (n: number) => minutesAgo(n).toISOString();

describe.skipIf(!up)(`the stale-lock sweep (needs: ${START_TEST_DB_HINT})`, () => {
  let db: TestDb;
  let programId: string;

  beforeAll(async () => {
    db = await getTestDb();
    await testSql()`DELETE FROM program WHERE name = 'stale locks fixture'`;
    const [program] = await testSql()`
      INSERT INTO program (name, importing_country, vehicle_class, sourcing_horizon)
      VALUES ('stale locks fixture', 'USA', 'BEV', 'FY2027') RETURNING id`;
    programId = program!.id;
  });

  beforeEach(async () => {
    await testSql()`DELETE FROM run WHERE program_id = ${programId}`;
  });

  afterAll(async () => {
    if (!up) return;
    // Nothing left `queued`: `dequeueJob` takes the oldest queued Job anywhere.
    await testSql()`DELETE FROM program WHERE name = 'stale locks fixture'`;
  });

  /** A Job claimed `lockedMinutesAgo`, with no rows written since. */
  async function claimedJob(lockedMinutesAgo: number): Promise<string> {
    const runId = await openRun(db, { programId, trigger: 'full', supplierCount: 1 });
    const jobId = await enqueueJob(db, {
      runId,
      kind: 'assess',
      subjectType: 'program',
      subjectId: programId,
    });
    await testSql()`
      UPDATE job SET state = 'running', locked_at = ${minutesAgoIso(lockedMinutesAgo)}::timestamptz,
                     started_at = ${minutesAgoIso(lockedMinutesAgo)}::timestamptz
      WHERE id = ${jobId}`;
    return jobId;
  }

  it('takes back a Job locked past the ceiling that has written nothing since', async () => {
    const jobId = await claimedJob(STALE_LOCK_MINUTES + 10);

    const requeued = await requeueStaleJobs(db);
    expect(requeued.map((job) => job.id)).toContain(jobId);

    const job = await db.query.job.findFirst({ where: eq(t.job.id, jobId) });
    expect(job!.state).toBe('queued');
    expect(job!.lockedAt).toBeNull();
    // `attempt` counts up: "this has been tried twice" is the fact a person
    // deciding whether to try again needs.
    expect(job!.attempt).toBe(1);
  });

  it('leaves a Job that is merely slow alone', async () => {
    // The one that would have been taken from a worker still spending on it:
    // a recommend Job ran 62 minutes and wrote a turn every couple of them.
    const jobId = await claimedJob(STALE_LOCK_MINUTES + 10);
    await db.insert(t.traceTurn).values({
      jobId,
      n: 1,
      request: {},
      response: '{}',
      ms: 0,
      createdAt: minutesAgo(STALE_SILENCE_MINUTES - 5),
    });

    expect((await requeueStaleJobs(db)).map((job) => job.id)).not.toContain(jobId);
    expect((await db.query.job.findFirst({ where: eq(t.job.id, jobId) }))!.state).toBe('running');
  });

  it('counts a usage row as a sign of life too, not only a turn', async () => {
    // An `enrich` Job runs no model and writes no `trace_turn` at all, so a
    // sweep reading turns alone would take every long enrichment away.
    const jobId = await claimedJob(STALE_LOCK_MINUTES + 10);
    const job = await db.query.job.findFirst({ where: eq(t.job.id, jobId) });
    await db.insert(t.usageEvent).values({
      runId: job!.runId,
      jobId,
      endpoint: 'entity.getEntity',
      ms: 10,
      outcome: 'ok',
      createdAt: minutesAgo(STALE_SILENCE_MINUTES - 5),
    });

    expect((await requeueStaleJobs(db)).map((each) => each.id)).not.toContain(jobId);
  });

  it('leaves a freshly claimed Job alone', async () => {
    const jobId = await claimedJob(1);
    expect((await requeueStaleJobs(db)).map((job) => job.id)).not.toContain(jobId);
  });

  it('keeps the Round checkpoint, because the Job lost its worker rather than ran away', async () => {
    // The difference from a retry, which discards it: a swept Job resumes at
    // the Round boundary it reached, and the Rounds already paid for stand.
    const jobId = await claimedJob(STALE_LOCK_MINUTES + 10);
    await saveRoundCheckpoint(db, jobId, 2, { carriedObjections: ['a citation dangles'] });

    await requeueStaleJobs(db);

    const checkpoint = await loadRoundCheckpoint<{ carriedObjections: string[] }>(db, jobId);
    expect(checkpoint?.n).toBe(2);
    expect(checkpoint?.checkpoint.carriedObjections).toEqual(['a citation dangles']);
  });
});
