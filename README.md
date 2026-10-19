# Wheatpaste

One shared billboard. Post an ad on any part of it, over anyone, any time:
the price is the only rule.

The board is a chain, 32 × 18 squares. Two things live on it, apart:

- **Space** is owned. The whole board starts with one owner, who can cut it
  into rectangles, sell them, give them away, and set what an empty square
  costs. Owners are paid by every ad posted on their squares.
- **Ads** are posted. An ad covers any rectangle, across any owners' lines,
  and pays each square's owner for every block it runs, up front. An ad that
  touches any square of an ad still up takes that ad down whole, pays its
  poster back for the time it had left, and must pay at least as much an hour
  as everything it replaces. No one pays for being covered.

Nothing is burned, nothing decays, and there are no auctions: owners ask,
posters pay, and covering an ad costs at least what it was worth.

## Records

| Key | Value | Who may write |
| --- | --- | --- |
| `parcel/<x>,<y>,<w>,<h>` | `<owner> <min>` or `<owner> <min> <ask>`; `-` once cut or joined away | the owner, or anyone paying the ask |
| `cell/<x>,<y>` | `<poster> <id> <rate> <start> <end> <x>,<y>,<w>,<h>`: the terms of the ad on it | anyone, under the rules above |
| `user/<a>/post/<id>` | the ad: JSON `{ image, link?, caption? }`, `image` a `data:image/webp\|png\|jpeg` URL | `<a>` |
| `user/<a>/...` | anything else of the account's own, e.g. labels | `<a>` |

`min` and `rate` are coins per square per block. An ad pays each owner
`rate × (end − start)` for each of their squares; `start` must be at or below
the block the ad lands in, so a late landing costs only the poster. Because
every square of an ad carries its whole rectangle, the policy sees any ad's
full size from one square and needs no state reads; an ad names each parcel
under it, unchanged, so the policy sees who to pay. Consensus checks every
old value a write names.

One write per key per block: two ads on one parcel land in different blocks.
Owners who want more traffic cut their space into smaller parcels.

## Layout

- `policy/`: the transaction-scope WASM policy (Rust, on the shared
  `lattice-policy-rules` crate from Moniker). `test/` runs every rule through
  the built module; `host-check/` replays the recorded contexts through
  Lattice's own evaluator.
- `client/board.mjs`: the board as records, and every write: post, take
  down, claim, set terms, buy, cut. `state.mjs` and `wallet.mjs` come from
  moniker-sdk.
- `app/`: the page. The board is the page; drag across it to post. Reads
  need no wallet; writes go to Selfhold, one approval each.
- `e2e/board.mjs`: the rules against a real node. `e2e/ui/shots.mjs`:
  screenshots of the page for review.
- `scripts/`: claim a new board, fund accounts, seed example ads.

```bash
cd policy && cargo build --release --target wasm32-unknown-unknown
LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
LATTICE=<lattice-node>/.build/debug/lattice LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/board.mjs
```

## Trial

The trial board is `Nexus/testnet/wheatpaste-acbbcf`, hosted by the shared
testnet hosts `lattice-testnet-apps-iad` and `-ams`. Writes there are free of
fees; posting still pays owners in the chain's coin.
