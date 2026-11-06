# Untangle decisions — 2026-11-06

## Baseline and scope

Started at `0a4d96e` with a clean checkout. Read root AGENTS.md and the
caldoai untangle-codebase skill. Both Comments and Tests additions are selected.
Preserve the recent documentation, CLI and test pruning in PRs #65–67. No local
tests, builds, benchmarks or browser tests: validation belongs to existing PR CI.
No owned local validation processes were started. Baseline test status is unknown.

## Inventory and redesign (recorded before implementation)

- Give realtime topology one domain module, shared by publication and routing.
  - `src/auction.ts` publishes to four shards; `src/index.ts` independently hashes
    modulo four. Changing only one silently loses delivery.
  - The events handler repeats protocol validation already performed by middleware.
- Keep validation contracts with their owners and reuse their Zod schemas.
  - The persisted auction state schema copies the public state enum.
  - Three room routes independently define the same search schema.
  - Room configuration repeats the public auction ID regex and handwrites a type
    already represented by its schema.
- Restore credentials only within the saved auction and API endpoint.
  - `room-config.ts` checks auction identity but overrides the saved API URL with
    route input while retaining tokens. A link to another API can receive credentials.
  - Its existing test explicitly expects that override; replace it with behavior
    checks for same-endpoint restoration and cross-endpoint credential isolation.
- Express environment differences inside one Cloudflare config.
  - Staging and production copy exports, runtime flags, auth settings, origins and
    observability; only names, mode, rate limits and trace sampling differ.
- Remove implementation-restating comments after structural work; retain package
  interop notes, script rationale, lint directives and external platform constraints.

## Retained boundaries and special cases

The auction authority owns SQL transactions, exact retry responses and alarms;
fanout owns socket retention and bounded replay. Do not split the state machine
merely because it is long. Keep deployed schema migration history and SQL triggers:
storage invariants are an independent defense, not redundant API validation.
Keep polling/reconnect/heartbeat, malformed-message rejection and socket errors:
these model transport failures. Keep best-effort post-commit fanout and its logs;
a transactional outbox is documented future work, not a refactor requirement.
Keep disabled-demo gates, role/scope checks, numeric overflow checks and hydration
handling. Generated router output is owned by TanStack. Production integration is
an explicit opt-in deployment check; do not run it or deploy here.

## Test decisions

Existing auction, auth, retry, deadline, fanout, room-switch and render tests protect
observable contracts. Recent PR #67 already pruned redundancy; retain meaningful
checks. New credential tests must catch token reuse on a different API endpoint,
with empty credentials justified by the isolation requirement, not copied logic.
Existing CI runs Worker integration, tooling, browser-hook and render regressions,
as well as type/lint/format/OpenAPI and both deployment dry runs.

## Reviews and validation

Initial independent read-only inventory in progress. Follow-up review will check
all changes and remaining worthwhile structural issues. CI results will be recorded
when available; no local test success is claimed.

Initial review also identified two hidden contracts worth fixing:

- Use native Node `parseArgs` for auth-token options, rejecting unknown flags
  instead of silently dropping them. Keep Zod responsible for auction claims.
- Make the web history reader return the latest bounded window. The API is
  oldest-first and paginated, but panels display recent activity; requesting only
  page zero freezes them after 100 events. If the first response reports a newer
  version, fetch the final 100-event window using that authoritative version.
  This keeps reads bounded under continuous bidding. Test a 150-event auction
  and assert the latest event is exposed, with at most two history requests.

Follow-up review found the room settings owner still imported HTTP transport.
Move schema, default and inferred room type into `room-config.ts`; transport and
components depend on that stable configuration module. No re-export wrapper.

Completion review confirmed no worthwhile structural/correctness findings remain
following the configuration ownership fix. Fixed its sole mechanical finding
(duplicate imports). Meaningful tests remain; no tests were removed. Local work
was limited to dependency installation, formatting and `git diff --check`.
All tests/build/type/lint validation remains assigned to PR CI.

CI run `42269227851` passed type checking and stopped at a lint spacing error in
the new CLI regression. Added the required blank line; behavior tests were not
reached in that run. No local tests were run to diagnose it.
