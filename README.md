# Quizzler

**Proof of Knowledge** — a social trivia party game on Polkadot, inspired by Sporcle Party.

One player opens a lobby from a quiz pack, friends join with a game code, everyone answers
typed questions on their own device and spends each regular wager from 1 through the number
of questions once. When time runs out (or everyone has locked in), the table reviews the
answers together — wrong answers can be voted "close enough" by the other players — and, when
there is a real choice, the group votes among viable final difficulties before everyone locks a
wager and sees the prompt. The
entire game — lobby, timing, answers, scoring, votes — runs as a smart contract on Paseo
Asset Hub.

## How it works

- **Contract** (`contracts/quizzler/`): Rust, compiled to PolkaVM with a Solidity ABI via
  [`cargo-pvm-contract`](https://github.com/paritytech/cargo-pvm-contract), deployed through
  `pallet-revive`. Game phases are a pure function of block number — no keeper
  transactions — with early collapse when every player has acted. Answer matching is
  on-chain: normalization + exact match + Levenshtein tolerance, with a review-phase
  majority vote as the human "close enough" layer.
- **Pack discovery** (`contracts/registry/`, `contracts/pack-signals/`): sealed packs are
  paginated directly from the registry. Favorites and favorite counts live in PackSignals,
  which keeps every pack's score and exposes a bounded top list without an indexer or backend.
- **Pure logic** (`contracts/logic/`): normalization, Levenshtein, and the phase state
  machine as a host-testable crate (`cargo test`), kept in lockstep with the client via
  `shared/answer-test-vectors.json`.
- **App** (`app/`): a [Polkadot Triangle](https://github.com/paritytech/product-sdk) product
  app — Vite + TypeScript, `SignerManager` product accounts, contract calls through
  `@parity/product-sdk-contracts`. The app polls the compact `getLiveGame` snapshot and
  renders whichever screen the chain says the table is on.
- **Starter content** (`shared/packs/`): 10 packs × 200 questions, each labelled Easy,
  Medium, or Hard, seeded on-chain by script; community packs support up to 255 questions.
  A game plans its regular rounds from those questions and holds a different unused question
  back for its final. Repository-only
  provenance and editorial review
  records live alongside them in [`shared/pack-sources/`](shared/pack-sources/README.md);
  they are never deployed or read at runtime.

The trust model is deliberately casual: answers are public on-chain the moment they land,
and the client simply doesn't show them before the review phase — like cards face-down on
a table. Don't play for money with block explorers open.

## Rooms, refreshes, and leaving

The first lobby participant is the temporary **starter**. If they leave before play begins,
the next-longest-waiting participant automatically becomes the starter; the original creator
has no special authority once the quiz starts. A lobby departure frees its seat, and an empty
lobby becomes `Abandoned`.

During a running quiz, **Leave screen** is local navigation: the browser remembers the current
game (scoped to the account and game-contract address) and restores it after a refresh only
after the contract confirms that the account is still active. **Forfeit quiz** is different: it
is an explicit, permanent on-chain action. The player remains on the historical scorecard, but
does not block future answer, review, or difficulty-vote quorums. If the last active player
forfeits, the room becomes `Abandoned`; it is not recorded as a normal finished result.

The app intentionally keeps one resumable current quiz per browser session and will not silently
replace it when someone tries to join another room. The contract itself does not impose a global
one-game-per-account rule, so this stays a lightweight party-game UX choice rather than permanent
on-chain account state.

Hosts can share the lobby's invite link (`?join=<six-digit-code>`) as well as the visible game
code. Opening a valid link starts the normal signed join flow after connection; an existing saved
quiz still takes precedence, so an invite never silently replaces a player's current table.

## Development

Contract (needs Rust nightly + `cargo-pvm-contract`):

```sh
cd contracts/logic && cargo test          # pure-logic unit tests
cd contracts/quizzler && cargo pvm-contract build
cd contracts/registry && cargo pvm-contract build
cd contracts/session-registry && cargo pvm-contract build
cd contracts/pack-signals && cargo pvm-contract build
```

App (needs Node ≥ 22, pnpm):

```sh
cd app
pnpm install
pnpm test                 # normalize-parity unit tests
pnpm typecheck:tools      # type-check scripts, Playwright config, and E2E helpers
pnpm validate:packs       # validate all starter-pack files offline
pnpm validate:editorial   # non-blocking editorial coverage + quality lint for drafts
pnpm audit:editorial      # strictly audit only packs marked release-ready
pnpm deploy:contract      # fresh registry + session registry + signals + game deployment
pnpm deploy:e2e-contracts # fresh, isolated four-contract stack for public LIVE_E2E
pnpm seed:packs           # seed shared/packs/*.json into the active registry (resume-safe)
pnpm dev                  # vite dev server on :5301
pnpm build                # production build into dist/
pnpm deploy:dot           # build + publish dist/ as quizzler.dot (Bulletin + DotNS)
LIVE_E2E=1 pnpm test:e2e  # destructive Playwright run against public Paseo
```

`deploy:contract` waits for finalized inclusion before it records an address. It deploys one
fresh registry, session registry, PackSignals, and game stack and updates the active app
configuration and generated ABIs together only after every deployment finalizes.

A newly deployed registry starts empty, so run `pnpm seed:packs` before asking players to host
from it. The seed command is resume-safe and can be rerun after an interrupted batch.

The e2e suite (`app/e2e/`) runs the app inside `@parity/host-api-test-sdk`'s test host
against public Paseo — `game.spec.ts` plays a complete two-player game (one player through
the UI, one scripted straight against the contract). It creates permanent testnet packs and
games, so it requires the explicit `LIVE_E2E=1` opt-in and an isolated contract profile from
`pnpm deploy:e2e-contracts`. That command writes only the ignored
`app/.quizzler-e2e-contract-address.json`; it never changes the player-facing deployment.
Run it after `pnpm deploy:contract` has refreshed the active ABI files for the current contract build.
The E2E host uses its own Vite server on port 5302 and fails rather than
falling back to an active player-facing profile or server.

Current deployment: see `app/src/contract-address.json`.

## Publishing

`pnpm deploy:dot` builds the app and publishes `dist/` through the Polkadot
Bulletin Chain, then points the `quizzler.dot` DotNS name at the new CID. It
uses the direct `bulletin-deploy` publisher; it does not list the app in
Playground or require a Playground competition enrollment.

Each build automatically embeds a small release label in the Home and in-game
settings footers: the package version plus the current Git revision (for
example, `v0.1.0 · abc1234`). It is computed from `HEAD` during the Vite build,
so every merged PR has a distinct visible version without a manual version bump.
Game settings also shows a compact 12-character **release fingerprint**. It is
computed from that frontend label, the active four-contract address stack, and
the canonical default-pack catalog (metadata plus every starter-pack file).
This lets playtesters distinguish full-stack releases without exposing chain
addresses on the Home screen. It is not a version for every community pack:
sealed packs are individually identified by their registry address and pack ID.
Propagation takes a minute or two (IPFS pin + DotNS confirmation + gateway
cache). Bulletin storage has a **~2-week retention window** — the content
stays addressable only while a provider serves it, so re-run `pnpm deploy:dot`
at least every couple of weeks (or after any contract redeploy) to keep the
hosted app alive.

## Troubleshooting

- **App boots but every read/write fails after a contract change** — the
  generated ABIs no longer match the deployed four-contract stack. Run
  `pnpm verify:deployment`, then redeploy with `pnpm deploy:contract`.
- **`test:e2e` exits immediately** — the suite is destructive against public
  Paseo and requires the explicit `LIVE_E2E=1` opt-in plus an isolated profile
  from `pnpm deploy:e2e-contracts`.
- **Contract build fails on a fresh machine** — the contracts need the pinned
  Rust nightly with `rust-src` and the `cargo-pvm-contract` CLI from the
  `charles/cdm-integration` branch (see `.github/workflows/ci.yml` for the
  exact install step).

## Creating a pack

The app’s **Pack studio** is import-first: paste a JSON document or import a
`.json` file, review its local validation and preview, then publish it. Drafts
are saved locally before anything is sent on-chain. A portable pack file has
one title and at least two difficulty-labelled questions:

```json
{
  "title": "Friday food quiz",
  "questions": [
    {
      "text": "What fruit is used in guacamole?",
      "answers": ["avocado"],
      "difficulty": "easy"
    },
    {
      "text": "Which region is traditionally associated with guacamole?",
      "answers": ["Mexico"],
      "difficulty": "medium"
    }
  ]
}
```

`difficulty` must be `"easy"`, `"medium"`, or `"hard"`. The game never
needs special final-only prompts: it selects its final from an unused ordinary
question in a difficulty the pack can support. Sparse packs adapt honestly —
an all-Easy pack goes straight to its final wager, while a pack with multiple
eligible tiers lets the group vote among only those tiers.

The optional top-level `emoji` is preserved on import; authors can also choose
or paste any raw emoji in Pack studio. The publisher normalizes equivalent
answer variants before batching them to the registry, and keeps a local resume
cursor if a publish is interrupted.
