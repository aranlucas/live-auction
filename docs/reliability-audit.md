# Correctness and reliability audit — 2026-11-06

Baseline: remote default `fe344c9` (merged untangle pass #70). Clean isolated worktree; no structural cleanup. Tests and builds run only in CI.

## Inventory and trust boundaries

- `src/index.ts`, `auth.ts`, `openapi.ts`, `model.ts`: Hono REST/OpenAPI boundary; jose signature, issuer, audience and role verification; auction-scoped JWTs; path/body/query validation, body limits, CORS and per-actor rate limits. Seller ownership is checked again inside the authority.
- `src/auction.ts`: one SQLite Durable Object per auction. Creation, start, bid, cancel and deadline close; ordered immutable history, actor/key idempotency records, alarm scheduling and database triggers. Transactions include alarm mutations; reads close overdue auctions. No payment or external inventory transaction exists.
- `src/fanout.ts`, `realtime-topology.ts`: sharded WebSocket hibernation, persisted catch-up, bootstrap buffering and monotonic cursors. Fanout is best effort; HTTP polling is the documented repair path.
- `src/demo-session.ts`, auth CLI: short-lived demo identities, signing configuration, guest bidder minting restricted to live demo-owned rooms. Production disables minting. Public JWKS is not secret.
- `apps/web`: SSR routes, room/session restoration, TanStack Query polling plus sockets, setup/demo/join flows, bidding and seller commands. Tokens stay in tab session storage; explicit room/API changes reject mismatched restored configuration.
- Existing CI: type/lint/format/OpenAPI checks, Worker and web Vitest behavior/integration suites, compiled SSR render checks and deployment dry runs. Production integration is opt-in and is not used for this audit.

## Confirmed findings (recorded before implementation)

### R1 — custom bids lose cents (medium impact, high confidence)

Location: `apps/web/src/components/auction-panel.tsx`, form defaults/effect and number input. Trigger: a valid API auction has minimum 1025 or 1075 cents (the contract accepts positive integer cents). Expected: the form offers $10.25/$10.75 and allows cent increments. Actual: `toFixed(0)` fills $10/$11 and `step="1"` prevents ordinary cent increments. The rounded default is below min or mismatched to the input step, blocking ordinary browser submission. Fix the decimal presentation and input step without changing the API or auction rules. Regression: real browser checks exact initial and updated values, submits 1025 then 1045 cents (with an updated minimum of 1035), and verifies persisted history/price.

## Reconciled and rejected hypotheses

- Concurrent equal bids, persistence after eviction, replay with changed payload, cross-auction tokens, seller ownership, unsafe integer next-minimum, alarm close and late-bid rejection already have meaningful integration coverage. Existing code enforces these contracts; no replacement architecture is justified.
- Stale HTTP/socket snapshots: Query structural sharing retains the highest version, old socket identity is checked, and existing hook tests cover cancellation and credential changes. Do not reimplement ordering.
- Fanout delivery failure is logged and does not reverse a committed bid. Polling/bootstrap repair authoritative state; exactly-once event delivery is not a promised contract.
- JWT expiry is validated when present; requiring an additional claim would change the existing issuer contract without evidence of a product requirement.

## Validation and framework applicability

Read current published e2e quickstart, CI, GitHub Actions, web/browser/config docs and the supplied pinned Vite example. npm confirms `e2e@0.23.0` is tester-army/e2e and requires Node ^22.22.3 or >=24.8; `@e2e-dev/web@0.15.5` accepts e2e >=0.22.1 <1. These exact published versions will be locked. The web app is an honest supported Chromium target; use deterministic actions/assertions with no model or credentials. A local CI Worker with a public test JWKS provides real API, persistence and WebSocket behavior. No staging/production resources are used. Existing CI gates remain intact.

Independent review: three static rounds confirmed R1–R3; objections about route-remount credential loss, shallow baseline checkout and loose proof checks were corrected. Final review found no remaining blocking code issue. Explicit React hydration readiness now gates browser actions.

CI run [42299080634](https://github.com/aranlucas/live-auction/actions/runs/42299080634), head `621fbad`: the original CI gate passed (type/lint/format/OpenAPI, 23 Worker integration tests, 7 tooling tests, 21 web tests, 2 compiled SSR tests, builds and dry runs). Both real e2e journeys passed. Storage baseline reproduced the expected navigation failure, but its proof reader incorrectly assumed URL errors have `details`; corrected to verify its assertion message. Latest CI pending after that correction and R4 below.

### R2 — unavailable session storage aborts room setup (medium, high confidence)

`auction-room-page.tsx:saveConfig` handles read failures on restore but lets `sessionStorage.setItem` throw after updating state and before navigating. A browser that blocks storage therefore reports failure and interrupts demo creation/start or advanced setup. Session persistence is an enhancement; retain credentials in the existing per-router Query cache across route remounts and continue navigation when writing storage fails. Regression: block setItem with a SecurityError and connect/bid through the real browser and Worker.

### R3 — non-USD activity and winning ledger use USD (medium, high confidence)

`activity-feed.tsx:eventCopy` and `event-ledger.tsx:eventDetail` omit the auction currency when formatting bid/winner cents. An accepted EUR auction displays euro prices in controls but dollars in activity/closing history. Pass the authoritative auction currency (default USD retained for existing component callers). Regression: EUR activity and winning ledger assertions in the real journey.

### R4 — browser ignores invalid auction-ID pattern (low impact, high confidence)

CI browser evidence in the R2 baseline logged a SyntaxError for `setup-dialog.tsx`'s `[A-Za-z0-9_-]{1,100}` pattern under the HTML `v` regex flag. The browser silently ignores an invalid pattern, so native validation no longer rejects spaces. Zod/API validation still protects persisted IDs. Escape the literal hyphen; the journey now verifies the browser reports `patternMismatch` for `invalid room` before connecting a valid ID. A separate original-component CI variant must fail that assertion.
