# Gazelle MCP

Unofficial, community-built MCP server (not affiliated with Gazelle) giving Claude access to a piano technician's data in **Gazelle** (gazelleapp.io), an all-in-one business platform for piano technicians. Primary uses: appointment lookups, an IRS-style mileage log, and per-jurisdiction visit/value summaries for tax filing. See README.md for user setup.

Personal, machine-specific notes belong in `CLAUDE.local.md` (gitignored), not here.

## Goals (priority order)
1. **Appointments**: query by date range, client, status, location.
2. **Mileage log** for tax filing: a dated, per-trip log (home → stops → home) with miles, purpose, and client, exportable as CSV. Must be IRS-defensible (date, miles, business purpose, destination).
3. **Tax jurisdiction analysis**: from appointment service locations, summarize visits and value per state/city to gauge state/local filing obligations.
4. **Broad read access** to the rest of the account: clients, pianos, invoices/payments, inventory, service history, reminders.

Ideas not yet built: revenue/expense reports, overdue invoices (needs invoice access), clients due for tuning (last service + interval), piano service history lookups, route planning for a day, quarterly estimated-tax helper, schedule gaps.

## Gazelle API
Official private GraphQL API (docs: https://gazelleapp.io/developer, schema: https://gazelleapp.io/docs/graphql/private/). POST `https://gazelleapp.io/graphql/private`, OAuth 2.0 bearer tokens (30-day access; revoked if not refreshed within 90 days). Gazelle gives no support beyond docs. Notes from live testing are in `docs/api-notes.md`.
- Appointments are `PrivateEvent` (`allEventsBatched`, `event`); no end time (`start` + `duration` in minutes, verified), `start` is UTC, `timezone` is per event.
- Event `location` is usually null; addresses come from the client's default contact location (fallback in `http-client.ts`). The mileage log assumes the job happened at that address.
- **No distance/mileage data exists in the API** (`travelTimes` returns seconds only). Miles come from OSRM routing in `src/mileage/routing.ts`.
- **Invoice access depends on the Gazelle plan** and is not used (`Error 7AF8L: Your subscription does not include invoices.` on plans without it). Appointment value comes from event service items (`allServiceItems`, cents, quantity in hundredths): a *quoted* value, not collected revenue. Whether `amount` is unit price or line total is unconfirmed for quantity != 1.
- `npm run introspect` writes the live schema to `docs/schema.json` (gitignored; Gazelle's schema is not ours to redistribute). Verify new queries against it.
- GraphQL mutation errors come back in `mutationErrors { fieldName key messages type }` (not message/path).

## Architecture
- `src/gazelle/types.ts`: normalized domain model (Appointment, Client, Address, ...). Tools and logic use only these. Status `no_show` is distinct from `cancelled`: excluded from value totals, but kept in the mileage log (the trip was still driven).
- `src/gazelle/client.ts`: `GazelleClient` interface + `FixtureClient` (tests; `GAZELLE_USE_FIXTURES=1`). `http-client.ts` (GraphQL impl), `graphql.ts`, `auth.ts`.
- `src/mileage/`: trip building, IRS rate table, and CSV (`mileage.ts`, unit-tested); OSRM routing and Census geocoding (`routing.ts`).
- `src/tax/`: jurisdiction grouping/summaries. Pure logic, unit-tested.
- `src/index.ts`: MCP server (stdio), tool registration with zod schemas.
- `src/gazelle/overrides.ts`: user corrections in `data/overrides.json` (`{ "<event id>": { "quotedCents": 0, "tipCents": 2000, "reason": "..." } }`), applied to every appointment the tools return. For when Gazelle's pricing doesn't reflect what was charged, and for tips (which Gazelle only stores on invoice payments).

## Writes
Write tools must stay narrow and safe. Gazelle exposes ~250 mutations (billing plans, passwords, bulk jobs, deletes). **Never expose generic mutation access**; add one narrow tool per need, with preview-unless-`confirm=true`, before/after verification, and an entry in `data/audit-log.jsonl`.
- Gazelle-writing tools are only registered when `GAZELLE_ENABLE_WRITES=1`. The server is read-only by default.
- The only mutation used is `updateEvent`, in `src/gazelle/writer.ts`, for two things: appending to `notes` (`append_appointment_note`) and one service item's price (`set_service_item_price`).
- `set_service_item_price`: VERIFIED that `updateEvent` replaces the whole `serviceItems` list and Gazelle assigns new item ids (status, notes, piano links, date unchanged). The tool resends all items unchanged except the target, compares before/after, and auto-restores the originals on any mismatch.
- `set_appointment_override` is local-only (`data/overrides.json`) and always available.

## Privacy and security
- Client names, addresses, and finances are sensitive. Never send them to third-party services without the user's explicit opt-in. External calls are limited to:
  - OSRM routing: bare coordinates only, no names/addresses. Public demo server by default; `GAZELLE_OSRM_URL` for self-hosted.
  - US Census geocoder: street address, only for the home address and appointments lacking Gazelle coordinates.
  Both are cached under `data/`. Do not add other third parties.
- Credentials and tokens come from `GAZELLE_*` env vars / `data/token.json`, never committed. `.env`, `data/`, and `CLAUDE.local.md` are gitignored.
- Never put real client names, addresses, or amounts in code, tests, docs, or commit messages. Tests use made-up fixtures.

## Commands
- `npm run dev`: run server with tsx (loads `.env`)
- `npm run build`: compile to `dist/`
- `npm test`: vitest
- `npm run typecheck`
- `npm run auth`: one-time OAuth; `npm run introspect`: dump live schema

## Conventions
- TypeScript, ESM, strict. zod for all tool input schemas.
- Dates as ISO strings; trips are dated in each appointment's own timezone (fallback `GAZELLE_TIMEZONE`, default `America/New_York`).
- Money as integer cents.
- IRS standard mileage rates live in `IRS_RATE_PERIODS` in `src/mileage/mileage.ts` (supports mid-year changes). Add each new year's rate from https://www.irs.gov/tax-professionals/standard-mileage-rates.
- Tax output is informational, not tax advice; say so in tool output where relevant.
