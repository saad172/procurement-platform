# Procurement Platform

Supplier-sourcing decision support for an automotive OEM, built on the
[Sayari](https://sayari.com) entity graph.

It takes a roster of candidate suppliers, resolves each row to a company in the
Sayari graph through an agent-plus-evaluator loop, enriches each resolved
company from six external sources, ranks them on a transparent weighted Score,
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
service, the Next.js `web` service on <http://localhost:3000>, and the `worker`.
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

### Checks

```bash
pnpm check      # typecheck + lint + tests — no credentials, no network
```

Two checks spend real Sayari credits and so are scripts rather than tests:

```bash
pnpm smoke:upstream           # one live call to each of the five sources
pnpm smoke:model              # one Tool Runner loop with every pinned setting
pnpm smoke:resolve [name]     # the eight Discriminators and the auto-accept gate, live
pnpm smoke:enrich [name] [id] # the six enrichment sources and the Corporate family
pnpm check:founding-example   # re-measures the Bosch example the app is built around
```

The suite is keyless by construction (`docs/SPEC.md` §19.1): it runs off cached
response bodies, and a cache miss throws naming the key it missed rather than
falling through to a live call. The honest cost is that **live upstream
behaviour never reaches CI** — which is what those two scripts are for.

---

## How it is laid out

```
src/
  app/          Next.js App Router — the five-page spine, the chat route handler
  config/       env.ts (boot validation), constants.ts (the shared numbers)
  db/           Drizzle schema, migrations, the idempotent seed
  upstream/     the ONE place that may reach Sayari, GLEIF, World Bank, USITC, Nominatim
  model/        the ONE place that may construct an Anthropic client
  tools/        the tool registry: one catalog across chat, Jobs and MCP
  domain/       score.ts, staleness.ts, the Match Discriminators, the validators
  jobs/         one handler per Job kind: resolve, enrich, traverse, assess, recommend, discover
  worker/       the long-lived poller
tests/          unit tests, and the replay fixtures exported from real runs
```

### The four chokepoints

The build's structural discipline is four places where a whole class of mistake
is made **unrepresentable** rather than tested for. Three are ESLint import
boundaries, checked by `pnpm lint`; the fourth throws at boot.

| Chokepoint | Makes impossible |
|---|---|
| `src/upstream/call()` | spending an upstream credit without caching it |
| `src/model/runLoop()` | an unmetered, untraced model call |
| `settleMatch()` | a tool writing `match.status` or `match.entity_id` — the agents propose, our code settles |
| `finalizeRegistry()` | handing a loop a tool it cannot reach — per-surface and per-Round tool lists are derived, never hand-written |

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
- [x] 10 — Assess and Recommend (validators; loops next)
- [ ] 11 — Pages
- [ ] 12 — Chat
- [ ] 13 — Discover
- [ ] 14 — The Runs branch
- [ ] 15 — Fixtures and replay
- [ ] 16 — CI
