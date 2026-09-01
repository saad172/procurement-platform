# Procurement Platform

Supplier-sourcing decision support for an automotive OEM, built on the
[Sayari](https://sayari.com) entity graph.

It takes a roster of candidate suppliers, resolves each row to a company in the
Sayari graph through an agent-plus-evaluator loop, attaches six kinds of dated
Enrichment from five upstream sources, ranks them on a transparent weighted Score,
and produces agent-written, evaluator-reviewed Assessments and Recommendations
in which **every factual sentence carries a citation to a stored row**.

Built for the Sayari FDE technical exercise, Scenarios 1 and 2 together.

---

## The documents

| Document | What it is |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | The build-ready specification. 22 sections; every decision carries the reason that stops it being re-litigated. |
| [`docs/BUILD-NOTES.md`](docs/BUILD-NOTES.md) | Everything the build measured that differs from the spec, and whether the decision survives. **Quote this for numbers, not the spec.** |
| [`CONTEXT.md`](CONTEXT.md) | The glossary, and it is normative. One meaning per word — *Supplier*, *Profile*, *Twin*, *Match*, *Criterion*, *Pick*, *Run*, *Job*. Read it before naming anything. |
| [`.scratch/wayfinder/map.md`](.scratch/wayfinder/map.md) | The decision record: 26 planning tickets, each naming what was rejected and why. |
| [`docs/seed/demo-program.md`](docs/seed/demo-program.md) | The approved demo data — one Sourcing Program, four Plants, eight Categories, a 50-row roster. |
| [`docs/research/`](docs/research/) | The measurements the design rests on, with the probe scripts that produced them. |
| [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) | Where does X live — the rules in one line each, then a lookup table for the questions a reviewer asks out loud. |
| [`docs/DEMO.md`](docs/DEMO.md) | The rehearsal script along the spine, and the state of the data said honestly. |

---

## Running it

### Prerequisites

- Docker with Compose
- Node 22+ and pnpm 9 (only for running outside containers)
- Sayari OAuth2 credentials and an Anthropic API key

### Local

```bash
cp .env.example .env      # then fill in the credentials
docker compose up
```

That brings up four things: Postgres on a named volume, a one-shot `migrate`
service, the Next.js `web` service on <http://localhost:3100>, and the `worker`.
Web and worker both wait for `migrate` to complete successfully, so no process
ever starts against a schema it does not understand.

A **missing credential refuses to boot**, naming what is absent and where it
comes from. There is no degraded mode, because there is no committed snapshot of
results to degrade into.

### Outside containers

```bash
pnpm install
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed
pnpm dev        # web
pnpm worker     # in a second terminal
```

### Running a Job the way production does

The smoke scripts call a Job's function directly, which is right for probing one
layer — but they pass no `jobId`, so nothing writes a Trace. Queueing exercises
what production runs: the dequeue, the caps, the Trace, the usage rows.

```
pnpm enqueue resolve Yazaki          # queue it
pnpm worker                          # in a second terminal, claim and run it
pnpm enqueue recommend HAR
pnpm enqueue resolve Rosoboronexport --test-program   # the arranged fixtures program
```

### Re-recording a fixture

A fixture is an **export of one real Job's rows**, never hand-written. Change a
prompt, a tool schema or a stored figure and every recording made before it is
stale — re-run the Job, then export it.

```
pnpm fixtures:record resolve/agree-r1        # latest resolve Job, or pass a job id
pnpm fixtures:record-chat                    # chat has no Trace; recorded at the fetch seam
pnpm fixtures:rehash <name> <dumpDir>        # only when the HASH changed, not the request
```

Record with `MODEL_REQUEST_DUMP_DIR=/tmp/dumps` set and `fixtures:rehash` can
rebuild the hashes offline. Without it, a change to how a request is hashed costs
a full pipeline re-run — about forty-five minutes
([finding 56](docs/BUILD-NOTES.md)).

### Checks

```bash
pnpm check      # typecheck + lint + tests — no credentials, no network
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest run  (pnpm test:watch to iterate)
pnpm format     # prettier --write
```

> **All 629 pass, including on a database created seconds ago.** Two replays used
> to miss at turn 3 on a freshly created `procurement_test`, which read as a
> drifted fixture for three sessions and was not one: `enrich` asked for "the
> cached entity body" without saying *which* entity, so it could attribute one
> company's ownership to another, and the recorded fixture had frozen the wrong
> answer. [`docs/BUILD-NOTES.md` finding 100](docs/BUILD-NOTES.md) is the
> account; `tests/jobs/owner-edges.test.ts` is what stops it returning, because a
> replay fixture provably cannot.

Two checks spend real Sayari credits and so are scripts rather than tests:

```bash
pnpm smoke:upstream           # one live call to each of the five sources
pnpm smoke:model              # one Tool Runner loop with every pinned setting
pnpm smoke:resolve [name]     # the eight Discriminators and the auto-accept gate, live
pnpm smoke:enrich [name] [id] # the six enrichment sources and the Corporate family
pnpm smoke:assess [name]      # the full proposer/evaluator loop, published
pnpm smoke:discover [code]    # trade counterparties, classified
pnpm check:founding-example   # re-measures the Bosch example the app is built around
pnpm check:prefilter          # grades the forwarder heuristic against Sayari's own flag
```

One check spends nothing but needs the app running, because what it checks is
the app running:

```bash
pnpm dev          # in one terminal
pnpm smoke:pages  # in another — fetches all thirteen pages
```

**Nothing in the suite touches `src/app`.** Sixty-one test files cover the
domain, the jobs, the tools and the two clients, and not one renders a page. So
`smoke:pages` fetches every route and asserts more than a status code: a page
that lost its `where` clause still returns 200, renders empty, and passes a
status check. Each route carries **markers read out of the database** — the
Program's name, the Supplier's roster name, a real Risk factor's name, a real
Family member's label — strings that can only be on the page if it loaded the
row it is about. There is one per `<h2>` section, 34 across the thirteen
routes, because a page is now one component per section and a section handed
an empty prop renders nothing and still returns 200. A page whose subject does
not exist yet is skipped by name (*"no Recommendation has been published"*)
rather than failed, because a check that cries wolf on a fresh database is a
check people learn to ignore.

The suite is keyless by construction (`docs/SPEC.md` §19.1): it runs off cached
response bodies, and a cache miss throws naming the key it missed rather than
falling through to a live call. The honest cost is that **live upstream
behaviour never reaches CI** — which is what those two scripts are for.

---

## How it is laid out

```
src/
  app/          Next.js App Router — the five-page spine, the chat route handler;
                each page.tsx is a loader call and one component per <h2>, in the
                sections.tsx beside it
  components/   client components shared across pages: the chat dock, the weight rail,
                and widgets/ — one renderer per frozen chat widget type
  chat/         one chat turn: the Thread, the Run, the tools, the transcript
  config/       env.ts (boot validation), constants.ts (the shared numbers)
  db/           Drizzle schema, migrations, the idempotent seed;
                queries/ is the ONE place a page reads from
  upstream/     the ONE place that may reach Sayari, GLEIF, World Bank, USITC, Nominatim
  model/        the ONE place that may construct an Anthropic client
  tools/        the tool registry: one catalog across chat, Jobs and MCP
  domain/       score.ts, staleness.ts, the Match Discriminators, the validators,
                and the pure derive* a page's rows pass through on the way to a section
  jobs/         one handler per Job kind: resolve, enrich, traverse, assess, recommend, discover
  worker/       the long-lived poller
  fixtures/     record a real Job's rows; replay them without a key
  lib/          canonical JSON, server-sent events, the URL view state
scripts/        the checks that spend credits, the fixture recorders, smoke:pages
tests/          unit tests, and the replay fixtures exported from real runs
```

### The seven chokepoints

The build's structural discipline is seven places where a whole class of mistake
is made **unrepresentable** rather than tested for. Six are ESLint rules,
checked by `pnpm lint`; the other throws at boot.

| Chokepoint | Makes impossible |
|---|---|
| `src/upstream/call()` | spending an upstream credit without caching it |
| `src/model/runLoop()` | an unmetered, untraced model call |
| `settleMatch()` | a tool writing `match.status` or `match.entity_id` — the agents propose, our code settles |
| `finalizeRegistry()` | handing a loop a tool it cannot reach — per-surface and per-Round tool lists are derived, never hand-written |
| `src/jobs/runs.ts` | a second owner of the Job state machine — no other file in `src/` writes the `job` or `run` tables |
| `db/queries/` | a page reaching past it — no `page.tsx` imports `@/db/schema` as a value, so a page renders and `db/queries` reads |
| `max-lines-per-function` | a body that scrolls — no function in `src/` or `scripts/` is over 120 lines counted raw, comments included, so any path through the code can be re-read whole while someone watches |

The fifth is the only one added after a bug rather than before one. The UI had
become a second writer: `retryJob` and `retryRun` each carried the same
eight-field requeue payload verbatim, and `run-actions.ts` had grown its own
`resumeRun` that disagreed with `jobs/runs.ts`'s about money. It is a
`no-restricted-syntax` rule rather than an import boundary, because the schema
is one module every reader legitimately imports — what is restricted is the
write, not the import.

The seventh is the only one that guards legibility rather than a runtime
property, and it is counted **raw** on purpose: counting code alone would have
exempted `call()`, `runLoop()` and `finalizeRegistry()` on their comment
density, and those are the three functions this table rests on. A chokepoint
that is dense because it matters is the one most worth seeing whole. Each of
them is now a spine of private same-file helpers named for its phases, never
sibling modules, because the guarantee a chokepoint sells is that it fits in
one file. It is a core rule and so carries no custom message; its reason is the
comment above it in `eslint.config.mjs`
([finding 101](docs/BUILD-NOTES.md)).

The sixth and seventh together are one sentence, and it is the one to say out
loud about the page layer:

> **A page renders, `db/queries` reads, `domain` derives.**

A `page.tsx` calls one loader, hands the rows to pure `derive*` functions in
`src/domain/`, and lays out one component per `<h2>` from the `sections.tsx`
beside it. The loader reads everything the page needs in one pass; the
derivations are unit-tested without a database; the sections receive props and
neither query nor derive.

Plus one at the database: a `citation` row carries exactly one target group
under a one-of `CHECK`, so a dangling citation cannot be inserted at all.

Each rule carries its reason in the error message, because the failure they
exist to stop is *a file added later without thinking about it*.

---

## Build progress

Sequenced so each step is verifiable before the next depends on it
([`docs/SPEC.md` §21](docs/SPEC.md)).

- [x] 1 — Skeleton: Next.js + Drizzle + compose, boot validation, import boundaries
- [x] 2 — Schema and seed
- [x] 3 — `src/upstream/`
- [x] 4 — `score.ts` + `staleness.ts` and their unit tests
- [x] 5 — `src/model/`
- [x] 6 — The tool registry
- [x] 7 — Worker, `run` and `job`
- [x] 8 — The resolve loop
- [x] 9 — Enrichment fan-out and the Corporate family
- [x] 10 — Assess and Recommend
- [x] 11 — Pages
- [x] 12 — Chat
- [x] 13 — Discover
- [x] 14 — The Runs branch
- [x] 15 — Fixtures and replay
- [x] 16 — CI

All sixteen are done. What each step actually cost, and every place the spec's
assumptions turned out to be wrong, is in
[`docs/BUILD-NOTES.md`](docs/BUILD-NOTES.md) — 103 numbered findings, each one a
measurement rather than an opinion. **The write-up should quote that file, not
the spec, for any number.**
