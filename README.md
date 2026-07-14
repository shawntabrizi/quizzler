# Quizzler

**Proof of Knowledge** — a social trivia party game on Polkadot, inspired by Sporcle Party.

One player hosts a game from a quiz pack, friends join with a game code, everyone answers
typed questions on their own device and wagers 1–10 points on their confidence. When time
runs out (or everyone has locked in), the table reviews the answers together — wrong
answers can be voted "close enough" by the other players — and a difficulty-voted final
round with a big wager decides the winner. The entire game — lobby, timing, answers,
scoring, votes — runs as a smart contract on Paseo Asset Hub.

## How it works

- **Contract** (`contracts/quizzler/`): Rust, compiled to PolkaVM with a Solidity ABI via
  [`cargo-pvm-contract`](https://github.com/paritytech/cargo-pvm-contract), deployed through
  `pallet-revive`. Game phases are a pure function of block number — no keeper
  transactions — with early collapse when every player has acted. Answer matching is
  on-chain: normalization + exact match + Levenshtein tolerance, with a review-phase
  majority vote as the human "close enough" layer.
- **Pure logic** (`contracts/logic/`): normalization, Levenshtein, and the phase state
  machine as a host-testable crate (`cargo test`), kept in lockstep with the client via
  `shared/answer-test-vectors.json`.
- **App** (`app/`): a [Polkadot Triangle](https://github.com/paritytech/product-sdk) product
  app — Vite + TypeScript, `SignerManager` product accounts, contract calls through
  `@parity/product-sdk-contracts`. The app polls `getPhase` and renders whichever screen
  the chain says the table is on.
- **Starter content** (`shared/packs/`): 10 packs × 200 questions (+ easy/medium/hard
  finals each), seeded on-chain by script.

The trust model is deliberately casual: answers are public on-chain the moment they land,
and the client simply doesn't show them before the review phase — like cards face-down on
a table. Don't play for money with block explorers open.

## Development

Contract (needs Rust nightly + `cargo-pvm-contract`):

```sh
cd contracts/logic && cargo test          # pure-logic unit tests
cd contracts/quizzler && cargo pvm-contract build
```

App (needs Node ≥ 22, pnpm):

```sh
cd app
pnpm install
pnpm test                 # normalize-parity unit tests
pnpm validate:packs       # validate all starter-pack files offline
pnpm deploy:contract      # deploy to Paseo Asset Hub (dev //Alice; writes src/contract-address.json)
pnpm seed:packs           # seed shared/packs/*.json on-chain (resume-safe)
pnpm dev                  # vite dev server on :5301
LIVE_E2E=1 pnpm test:e2e  # destructive Playwright run against public Paseo
```

The e2e suite (`app/e2e/`) runs the app inside `@parity/host-api-test-sdk`'s test host
against public Paseo — `game.spec.ts` plays a complete two-player game (one player through
the UI, one scripted straight against the contract). It creates permanent testnet packs and
games, so it requires the explicit `LIVE_E2E=1` opt-in. Set `REUSE_E2E_SERVER=1` only when
you deliberately want it to use an already-running local Vite server.

Current deployment: see `app/src/contract-address.json`.
