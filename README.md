# Procurement Platform

A supplier-sourcing decision-support tool, built on the [Sayari](https://sayari.com)
entity graph. Given a roster of candidate suppliers for a sourcing program, it
matches each one to a real-world company record, scores and ranks them, and
produces cited, reviewable recommendations for who to award, second-source,
develop, or avoid. Built for the Sayari FDE technical exercise, covering
Scenarios 1 and 2 together.

---

## The business case

An automotive OEM's sourcing team is choosing suppliers for a new vehicle
program: four plants, eight purchasing categories, importing into the USA.
They start with a roster of 50 candidate companies and need two things before
they can act on it — to know who each name on the roster actually *is* in the
world (not just a string on a spreadsheet), and to know how each one compares
on the things that matter for the decision: risk, ownership, resilience, cost,
proximity.

**Scenario 1 — resolving the roster.** Each row is matched to a specific legal
entity in Sayari's graph, not a brand or a subsidiary of one. Two AI agents (a
proposer and an evaluator) work through a fixed set of eight checks — country,
locality, street, name overlap, alias context, LEI cross-reference, stated
business purpose, whether the company still appears active — and if exactly
one candidate passes every check, the match settles automatically with no
model call at all. Once a company is matched, the app pulls in six kinds of
supporting data (from Sayari itself, GLEIF, the World Bank, US trade
statistics, and OpenStreetMap/Nominatim) and its immediate corporate family,
with the option to walk the ownership graph further on demand.

**Scenario 2 — scoring and recommending.** Each matched supplier gets a score
built from six weighted factors: compliance risk, ownership exposure, country
resilience, tariff exposure, proximity to the buyer's plants, and adverse
media signal. A factor the app can't compute for a given supplier (no address
on file, no listed owner) is dropped rather than guessed at, and the
remaining weights are rescaled so the score stays comparable. The ranked list
is the shortlist. From there, the same two-agent pattern writes an assessment
and a recommendation — award, second-source, develop, or avoid — which a
person then accepts, rejects, or sends back for more work. A separate
"discover" pass proposes new candidate companies from trade data that never
appeared on the original roster; a person decides whether to add them.

The thing tying all of this together: **every factual sentence the app writes
carries a citation to a stored row** — an entity, a record, a score, a match.
Nothing is asserted without something concrete backing it.

---

## Why this matters to a client

None of this is hypothetical polish — every example below is a real bug the
build caught, and each one maps to a decision a sourcing team would otherwise
get wrong.

**A subsidiary almost stood in for its parent.** Four suppliers, mid-build,
matched to the *right* company's subsidiary instead of the company itself —
every automated check said the match was fine. Onboarding the wrong legal
entity into a supply chain is exactly the kind of mistake that surfaces later
as a compliance or liability problem, not a rendering bug. The address check
now catches this before a person ever sees the match.

**Sayari's raw data, taken at face value, would have misled scoring for more
than one in five suppliers.** 11 of 50 roster companies had a "country" field
that didn't match where they're actually headquartered. A team scoring
country risk directly off that field would be scoring the wrong country for
22% of its roster without knowing it.

**Every claim in a recommendation traces back to a real record.** When an AI
writes "avoid this supplier" or "second-source this one," a procurement team
needs to check *why* — not take a model's word for it. Here, every factual
sentence carries a citation to a stored entity, record, or score, so a
reviewer can verify a recommendation the same way they'd verify a human
analyst's memo.

**The AI is used where it earns its keep, not everywhere.** Matches every
automated check agrees on settle instantly, at zero model cost. On a real,
larger roster, that's the difference between paying for inference on every
row and paying only where a case is genuinely ambiguous.

---

## Tech stack

| | Why |
|---|---|
| **Next.js 16 (App Router) + React 19** | The whole app is five pages plus a chat panel. Server components let each page load its own data server-side without a separate API layer for reads. |
| **TypeScript 5.9** | End-to-end types from the Postgres schema through to the UI — a matching/scoring pipeline like this lives or dies on not silently passing the wrong shape of data between stages. |
| **Postgres 17 + Drizzle ORM** | The source of truth for suppliers, matches, scores, and jobs, and the cache for every upstream API response ever fetched. Real foreign keys and `CHECK` constraints enforce invariants (like "a citation must point at something real") that shouldn't be trusted to code alone. |
| **Vitest** | 128 test files, 1,233 tests, run against a real Postgres instance rather than mocks. |
| **Anthropic API (Claude)** | The proposer/evaluator agent pattern used for entity resolution and for writing assessments and recommendations. |
| **Sayari SDK** | The entity graph itself — company records, ownership/control edges, trade data, watchlist hits. |
| **Zod** | Runtime validation at every boundary that touches an LLM tool call or an upstream API response, since neither can be trusted to return exactly the shape it promises. |
| **Cytoscape.js** | Renders the ownership / corporate-family graph in the UI. |

---

## Architecture at a glance

```
src/
  app/          Next.js pages and the chat route
  components/   shared UI: chat panel, weighting controls, widgets
  chat/         one chat turn: thread, run, tools, transcript
  config/       env var validation at boot, shared constants
  db/           Drizzle schema, migrations, seed data — the only place a page queries from
  upstream/     the only place that calls Sayari, GLEIF, World Bank, USITC, or Nominatim
  model/        the only place that constructs an Anthropic client
  tools/        the tool registry shared by chat, background jobs, and MCP
  domain/       scoring, staleness, the matching checks, validation
  jobs/         one handler per background job kind: resolve, enrich, traverse, assess, recommend, discover
  worker/       the long-running job poller
  fixtures/     records a real job's outputs, replays them without live credentials
  lib/          shared utilities: JSON canonicalization, server-sent events, URL state, error formatting
scripts/        credit-spending checks, fixture recorders
tests/          unit tests plus the replayed fixtures
```

A handful of places are structurally locked down so a whole class of bug can't
happen, rather than relying on someone remembering not to write it: only one
function may spend a Sayari or Anthropic API credit (and it always caches
what it gets back), only one file may write to the job/run state tables, no
page is allowed to query the database directly — it goes through
`db/queries` — and a database constraint makes it impossible to insert a
citation that points at nothing. Most of these are enforced by lint rules,
not just convention.

---

## Key assumptions & tradeoffs

- **We match the exact legal company, not just its brand or parent.** A
  roster row has to match the specific company registered at that address —
  not a related company, not a division of it. (The parent company still
  gets recorded, just separately, as part of that company's ownership
  family.) Partway through the build, testing caught four suppliers that had
  matched to the *right* company's subsidiary instead of the company itself
  — every automated check said it was fine, but it wasn't. We tightened the
  address check so it has to line up on one specific building, not just a
  matching city or country.
- **We don't trust Sayari's "country" field at face value.** It's just
  whichever address happens to be listed first on a company's record, which
  isn't always where that company is actually headquartered — 11 of our 50
  suppliers had a mismatch against the country on our own roster. So we
  don't use that field directly for scoring. Instead, for each match we work
  out the country ourselves: prefer an official legal registry when one's
  available, fall back to whichever address we used to confirm the match,
  and only use Sayari's raw field as a last resort.
- **One company can show up as more than one record — we don't let that
  confuse "who it is."** Sayari sometimes has several records that all
  describe the same real company. We pull risk information from all of
  them, but every supplier is still matched to exactly one record. A
  duplicate never gets to stand in as the match itself.
- **A search taking a lot of steps doesn't mean it found a lot of
  companies.** When we look up a supplier's corporate family, Sayari tells
  us how many steps the search took through the ownership graph — not how
  many actual companies it found. In one real case, the search took 5,817
  steps but only turned up 89 real, distinct companies. If we'd reported the
  step count as the family size, that one supplier's corporate family would
  have looked about 65 times bigger than it really is. We always show the
  real company count and treat the step count as background detail, never
  as the headline number.
- **A full company record is too big to hand to the AI as-is.** One
  supplier's complete record from Sayari was 250KB with over 88,000
  relationships attached — sending all of that to the model blew past what
  it could handle in a single pass. So we send a trimmed-down version with
  just what's needed to make a decision and back it up with a source, which
  cut that same request down to about a sixth of its original size.
- **If we can't measure something, we leave it out — we don't guess.** Each
  supplier gets scored on six factors (things like compliance risk and
  distance from the buyer's plants). If we're missing what we need to
  compute one of those factors for a given supplier, we simply skip it and
  rebalance the rest, rather than filling in a made-up number that would
  quietly skew the ranking.
- **We only skip the AI when every check already agrees.** If all of our
  automated checks agree on a single match, we accept it immediately, at no
  cost and with no AI model involved. The AI only gets involved when the
  checks disagree or the answer isn't clear-cut.

---

## Running it locally

**Prerequisites:** Docker with Compose, Sayari OAuth2 credentials, and an
Anthropic API key. (Node 22+ and pnpm 9 only if you want to run outside
containers.)

```bash
cp .env.example .env      # fill in your credentials
docker compose up
```

This starts Postgres, runs migrations once, then brings up the Next.js app
(<http://localhost:3100>) and the background worker. A missing credential
fails fast at boot, naming what's missing, rather than starting in some
degraded mode.

To run outside Docker:

```bash
pnpm install
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed
pnpm dev        # web, in one terminal
pnpm worker     # background jobs, in a second terminal
```

---

## Testing / CI

```bash
pnpm check      # typecheck + lint + tests — no credentials, no network required
```

128 test files, 1,233 tests, all passing against a real Postgres instance
(not mocks). A replay is only as honest as the state it starts from, so the
harness rebuilds that state from the cached bodies themselves — down to the
`record` rows a citation has to resolve through — rather than inheriting
whatever a development database happened to be holding.

CI (`.github/workflows/ci.yml`) runs the same suite against a real
`postgres:17` service container on every push and PR — with no API keys
configured at all. That's possible because every model call and every
upstream API response the tests exercise comes from a recorded fixture or a
cached response body, replayed rather than called live; a cache miss fails
loudly rather than silently falling through to a real network call. The
tradeoff is explicit: CI can't catch a live Sayari or Anthropic API change
breaking something, which is why a small set of credit-spending smoke
scripts (`pnpm smoke:*`) exist separately, to be run by hand against the real
APIs when needed.
