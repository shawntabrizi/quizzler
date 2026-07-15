# Quizzler

**Proof of Knowledge** — a social trivia party game on Polkadot, inspired by Sporcle Party.

One player opens a lobby from a quiz pack, friends join with a game code, everyone answers
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
```

App (needs Node ≥ 22, pnpm):

```sh
cd app
pnpm install
pnpm test                 # normalize-parity unit tests
pnpm typecheck:tools      # type-check scripts, Playwright config, and E2E helpers
pnpm validate:packs       # validate all starter-pack files offline
pnpm deploy:contract      # routine game redeploy; refuses registry ABI changes
pnpm deploy:e2e-contracts # fresh, isolated contract pair for public LIVE_E2E
pnpm seed:packs           # seed shared/packs/*.json on-chain (resume-safe)
pnpm dev                  # vite dev server on :5301
LIVE_E2E=1 pnpm test:e2e  # destructive Playwright run against public Paseo
```

`deploy:contract` waits for finalized inclusion before it records a contract address. It is a
fresh game-contract cutover: existing unfinished rooms remain on the old game contract and are
not automatically migrated. Promotion retains the prior registry/game pair in the bounded
`previousDeployments` allowlist in `src/contract-address.json`, so a saved browser session or
an invite link can continue to open that known older room. The browser still presents one
resumable quiz at a time; this is continuity, not a multi-game mode.

The lobby ceiling is also deployment metadata, not a host configuration field. The current
checked-in game contract remains capped at 16; newly built game contracts are capped at 24.
Promotion records that value alongside the addresses, so do not manually change an active
deployment's `maxPlayers` before the matching game contract has been deployed.

The e2e suite (`app/e2e/`) runs the app inside `@parity/host-api-test-sdk`'s test host
against public Paseo — `game.spec.ts` plays a complete two-player game (one player through
the UI, one scripted straight against the contract). It creates permanent testnet packs and
games, so it requires the explicit `LIVE_E2E=1` opt-in and an isolated contract profile from
`pnpm deploy:e2e-contracts`. That command writes only the ignored
`app/.quizzler-e2e-contract-address.json`; it never changes the player-facing deployment.
Run it after the active ABI files have been promoted for the current contract build.
The E2E host uses its own Vite server on port 5302 and fails rather than
falling back to an active player-facing profile or server.

Current deployment: see `app/src/contract-address.json`.

## Creating a pack

The app’s **Pack studio** is import-first: paste a JSON document or import a
`.json` file, review its local validation and preview, then publish it. Drafts
are saved locally before anything is sent on-chain. A portable pack file has
one title, one or more regular questions, and all three final difficulties:

```json
{
  "title": "Friday food quiz",
  "questions": [
    { "text": "What fruit is used in guacamole?", "answers": ["avocado"] }
  ],
  "finals": {
    "easy": { "text": "…", "answers": ["…"] },
    "medium": { "text": "…", "answers": ["…"] },
    "hard": { "text": "…", "answers": ["…"] }
  }
}
```

The optional top-level `emoji` is preserved on import; authors can also choose
or paste any raw emoji in Pack studio. The publisher normalizes equivalent
answer variants before batching them to the registry, and keeps a local resume
cursor if a publish is interrupted.

## Fresh registry migration

Registry content is immutable: a clean catalog (including a registry ABI
change such as pack emoji metadata) must use a new registry and a new game
bound to it. The migration commands stage that pair first, so the active app,
existing games, and the E2E host continue using `src/contract-address.json`
until the starter catalog is fully verified.

From `app/`, after building both contracts:

```sh
pnpm deploy:registry-migration
pnpm seed:registry-migration
CONFIRM_PROMOTE_REGISTRY=1 pnpm promote:registry-migration
```

The first command writes only the ignored
`app/.quizzler-registry-migration.json`; it does not replace active addresses
or ABI files. The seed command uses the newly-built registry ABI, creates the
ten packs with the immutable emoji declared in
`shared/starter-pack-metadata.json`, and verifies their title, emoji, question
count, finals, and sealed state. It is resume-safe. `SEED_ONLY` is useful for
recovery, but intentionally does not mark a migration ready for promotion.
If the paired game deployment is interrupted after the registry is created,
rerunning the first command reuses that staged registry rather than creating
another one.

The staged state pins the generated registry/game artifacts and a fingerprint
of every starter-pack source file plus its emoji metadata. Seeding and
promotion refuse artifact or catalog drift. A full seed also verifies that the
fresh registry contains exactly the ten canonical starter packs at IDs 0–9;
use the same `DEPLOY_DEV_ACCOUNT` for deploy and seed so they have one
canonical creator.

Promotion requires the explicit confirmation variable and a completed seed
marker. It copies the generated ABI files, swaps in the staged registry and
game addresses, and retains the old pair as a known historical deployment for
invite/resume continuity. Rebuild/redeploy the app and commit those updated
tracked files afterwards. The old registry and its games remain on-chain; this
flow does not delete or mutate them. The staging file is ignored and never
read by the app or E2E suite, keeping unpromoted deployments isolated.
