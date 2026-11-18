# Gazelle API notes

Official docs: https://gazelleapp.io/developer (read 2026-11-17; parts were summarized, not verbatim).

- Endpoint: POST https://gazelleapp.io/graphql/private (JSON), `Authorization: Bearer <token>`
- OAuth: authorize at /developer/oauth/authorize, token at /developer/oauth/token (form-encoded). Access token 30 days; revoked if not refreshed within 90. 401 + empty body = bad token.
- Pagination: first/after, `pageInfo { hasNextPage endCursor }`, `nodes`.
- Events: `allEventsBatched(filters: PrivateAllEventsFilter)`; filter fields startOn/endOn [CoreDate], type [[EventType]!], status [[EventStatus]!]. EventStatus: ACTIVE, CANCELED, NO_SHOW, COMPLETE. EventType: APPOINTMENT, PERSONAL, MEMO, SYNCED.
- Event location: `PrivateEventLocation` (latitude/longitude are String).
- Client addresses: contact -> `defaultLocation` (PrivateContactLocation).
- Invoices: totals are Int, unit not documented. Filters use `invoiceDateGet/Let`.
- Rate limits: undocumented.

## Verified against live API (2026-11-17)
- Event filter `type`/`status` are flat lists (`["APPOINTMENT"]`); `startOn`/`endOn` are single `CoreDate`s and agree with `startDateGet/Let` and `dateGet/Let` at range edges.
- `PrivateContactLocation` has no `singleLineAddress` (only `PrivateEventLocation` does).
- `duration` is minutes (3h appointments end 180 min after start).
- Event `location` is NULL on every October 2026 appointment; addresses/coordinates come from the client's default contact `defaultLocation` (the fallback in http-client.ts). If a job happens somewhere other than the client's default address, the log will be wrong for that stop. `timezone` is per-event (e.g. America/Chicago).
- Mileage pipeline end to end: 10 appointments -> 19 trips, ~517 mi, 0 skipped.
- **The author's Gazelle plan has no invoice access** (`Error 7AF8L: Your subscription does not include invoices.`). Invoice/payment queries fail.
- Revenue proxy: `PrivateEvent.allServiceItems { amount quantity isTaxable isTuning name }`. USD, divisor 100 (cents). `quantity` is in hundredths (100 = 1). Whether `amount` is unit price or line total is unconfirmed for quantity != 1 (one such item seen).

## Still to verify
- Client-address fallback when an event has no `location`
