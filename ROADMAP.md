# Gavel Live feature roadmap

Updated 2026-10-26. Proposed product work after Digits/MCP priorities; these
milestones do not turn the current demo into a payment or fulfillment service.

## Starting point

Baseline `a1de4c1cc5baacb6592fc0ba339d0940487ca9fe`: the [demo](README.md)
already creates temporary seller/bidder/viewer sessions and supports timed
auctions, persistent ordered events, idempotent commands and reconnect recovery.
The useful next question is whether a host can run a complete event.

## Ordered releases

1. **Run a sequence of lots.** Let a host prepare a small catalog, preview its
   order and move deliberately from one closed lot to the next. Acceptance:
   participants always see the active lot identity, old bids cannot target a new
   lot accidentally, and reconnect resumes the server's confirmed event state.
2. **Explain what happened to a bid.** Give a bidder a concise receipt with
   pending, accepted or rejected state and the auction's authoritative result.
   Acceptance: lost responses reconcile through the existing idempotency
   contract; an outbid participant can see the relevant event; local countdowns
   never decide whether a bid was accepted.
3. **Close an event with a reviewable results sheet.** Summarize sold/unsold
   lots, winning accepted bids and unresolved states for the host.
   Acceptance: the export comes from committed results, corrections are visible,
   and a winning bid is not described as payment received or fulfillment done.
4. **Prepare a small controlled pilot beyond instant-demo credentials.** Define
   durable host identity, event access and participant recovery with explicit
   roles. Acceptance: expired demo credentials cannot become durable access,
   users can identify the event they joined, and authorization tests cover every
   event/auction command. Real-money commerce needs a separate product decision.

## First slice and evidence

Use three fictional lots and two browser participants to rehearse priority 1.
Measure host setup effort, wrong-lot confusion, completed lots and recovery from
a deliberate disconnect. A second hosted rehearsal is more useful evidence than
WebSocket message counts. Keep bids synthetic during this validation.

Reuse the existing Worker, Durable Objects, schemas and test suites. Preserve
per-auction command authority while adding event coordination; fanout clients
must not become alternate auction authorities. No payment provider or live
customer auction is part of this planning pass.
