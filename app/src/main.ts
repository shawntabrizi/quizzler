/**
 * Quizzler — social trivia on Polkadot.
 *
 * Four contracts: the pack REGISTRY (quiz content — packs, questions,
 * answers), GAME (lobby, phases, scoring, votes), SESSION REGISTRY
 * (quick-action ownership), and PACK SIGNALS (saved packs and popularity).
 * Game state is polled from the game contract; question text and the
 * review-time canonical answer are read from the registry by (pack_id, slot).
 *
 * Boot follows the product-sdk contracts-demo: SignerManager → product
 * account → chain client → contract handles → account mapping. Answers and
 * correctness are public on-chain. The client reveals submitted answers and
 * wagers after the local player locks in, while keeping correctness for review.
 */

import "./styles.css";

import { SignerManager, type SignerAccount } from "@parity/product-sdk-signer";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { requestResourceAllocation } from "@parity/product-sdk-host";
import { SessionKeyManager, type SessionKeyInfo } from "@parity/product-sdk-keys";
import { createLocalKvStore, type LocalKvStore } from "@parity/product-sdk-local-storage";
import {
    createContractFromClient,
    createContractRuntimeFromClient,
    ensureContractAccountMapped,
} from "@parity/product-sdk-contracts";
import { accountIdBytes, ss58Encode, ss58ToH160 } from "@parity/product-sdk-address";
import { encodeFunctionData, erc20Abi, hexToBytes } from "viem";

import registryAbi from "./abi-registry.json";
import gameAbi from "./abi-game.json";
import sessionRegistryAbi from "./abi-session-registry.json";
import packSignalsAbi from "./abi-pack-signals.json";
import contractInfo from "./contract-address.json";
import { retryChainRead, withTimeout } from "./chain-read-retry";
import { hydrateLiveSnapshotContent } from "./live-snapshot-content";
import { generatedPlayerName, playerLabels as resolvePlayerLabels, playerName } from "./player-identity";
import {
    ANSWER_BLOCK_PRESETS,
    countdownLabel,
    isAllowedBlockPreset,
    MAX_LOBBY_PLAYERS,
    presetDurationLabel,
    questionCountOptions,
    REVIEW_BLOCK_PRESETS,
} from "./game-config";
import {
    gamePaceLabel,
    gameProgressLabel,
    playerCountLabel,
    questionCountLabel as gameQuestionCountLabel,
    reviewContinueLabel,
} from "./game-settings";
import {
    knownGamesKey,
    readKnownGames,
    removeKnownGame,
    touchKnownGame,
    writeKnownGames,
    type KnownGame,
    type KnownGamesStore,
} from "./known-games";
import { parseGameCode, parseIntegerInRange, utf8ByteLength } from "./input";
import { consumeSharedLobbyInvite, sharedLobbyInviteUrl } from "./invite";
import { normalizeAnswer } from "./normalize";
import {
    finalOutcomeText,
    finalWagerValue,
    ordinal,
    PLACEMENT_TROPHIES,
    placementText,
    rankFinalStandings,
    type FinalStanding,
} from "./results";
import {
    automaticInstantPlayAllowed,
    normalizeInstantPlayPreference,
    temporaryInstantPlayFailure,
    type InstantPlayPreference,
} from "./instant-play-preference";
import {
    clearPendingGameCreation,
    readPendingGameCreation,
    rememberPendingGameCreation,
} from "./pending-game-creation";
import {
    DebouncedPackDraftSaver,
    EMPTY_PACK_JSON,
    canResumePackPublish,
    createBrowserPackDraftStore,
    createPackDraft,
    createPackPublishResume,
    exportPackDraft,
    exportPackFile,
    importPackDraft,
    updatePackDraft,
    validatePackDraft,
    type PackDraft,
    type PackDraftValidation,
    type PackPublishResume,
} from "./pack-drafts";
import { normalizeAcceptedAnswers, type PackQuestion } from "./pack-validation";
import {
    featuredPack,
    packPresentation,
    STARTER_PACK_COUNT,
    type PackListItem,
} from "./pack-presentation";
import {
    appendUniquePacks,
    buildPackLibrarySections,
    visibleLibraryPacks,
    type PackLibrarySectionId,
} from "./pack-library";
import { appendLog, getEl, li, renderList, span } from "./ui";

function isContractAddress(value: unknown): value is `0x${string}` {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function sessionRegistryConfigured(): boolean {
    return isContractAddress(activeContracts.sessionRegistry);
}

function packSignalsConfigured(): boolean {
    return isContractAddress(activeContracts.packSignals);
}

const configuredRegistry = import.meta.env.VITE_QUIZZLER_REGISTRY;
const configuredGame = import.meta.env.VITE_QUIZZLER_GAME;
const configuredSessionRegistry = import.meta.env.VITE_QUIZZLER_SESSION_REGISTRY;
const configuredPackSignals = import.meta.env.VITE_QUIZZLER_PACK_SIGNALS;
// Consume an invite once per page load so a refresh while a signer prompt is
// open cannot prompt the player to join the same room twice.
const sharedLobbyInvite = consumeSharedLobbyInvite(window.location.href);
if (sharedLobbyInvite.present) {
    try {
        window.history.replaceState(window.history.state, "", sharedLobbyInvite.cleanedUrl);
    } catch {
        // A host can disallow history writes; the join flow itself still works.
    }
}

// A test host can inject one isolated contract set at build time. There is one
// active four-contract deployment for this unreleased app; lobby links contain
// only a game code.
const hasContractOverride =
    configuredRegistry !== undefined
    || configuredGame !== undefined
    || configuredSessionRegistry !== undefined
    || configuredPackSignals !== undefined;
const activeContracts: {
    registry: string | undefined;
    game: string | undefined;
    sessionRegistry: string | undefined;
    packSignals: string | undefined;
} = hasContractOverride
    ? {
        registry: configuredRegistry,
        game: configuredGame,
        sessionRegistry: configuredSessionRegistry,
        packSignals: configuredPackSignals,
    }
    : {
        registry: contractInfo.registry,
        game: contractInfo.game,
        sessionRegistry: (contractInfo as { sessionRegistry?: string }).sessionRegistry,
        packSignals: (contractInfo as { packSignals?: string }).packSignals,
    };

// ── Constants ────────────────────────────────────────────────────────

const STAGE_LOBBY = 0;
const STAGE_ANSWER = 1;
const STAGE_REVIEW = 2;
const STAGE_VOTE = 3;
const STAGE_FINAL_WAGER = 4;
const STAGE_FINAL_ANSWER = 5;
const STAGE_FINAL_REVIEW = 6;
const STAGE_FINISHED = 7;
const STAGE_ABANDONED = 8;
const FINAL_QKEY = 255;
const FINAL_SLOT_BASE = 0xf0;
const NO_SLOT = 255;
const NO_PACK = 0xffffffff;
const MAX_GAME_QUESTIONS = 20;
const POLL_FALLBACK_MS = 8_000;
const LIVE_GAME_READ_TIMEOUT_MS = 12_000;
const REGISTRY_CONTENT_READ_TIMEOUT_MS = 8_000;
const KNOWN_GAMES_STORAGE_TIMEOUT_MS = 2_500;
const PREFLIGHT_TTL_MS = 5 * 60_000;
const DIFFICULTY_NAMES = ["Easy", "Medium", "Hard"];
const PACK_VIEW_BATCH_SIZE = 32;
const PRODUCT_DERIVATION_INDEX = 0;

function isSettingsStage(stage: number): boolean {
    return stage >= STAGE_LOBBY && stage <= STAGE_FINAL_REVIEW;
}

function isActiveGameplayStage(stage: number): boolean {
    return stage >= STAGE_ANSWER && stage <= STAGE_FINAL_REVIEW;
}

// Paseo Next Asset Hub's personhood-backed gas asset. The session setup
// keeps its batch entirely Revive calls (including this ERC-20 transfer), so
// the runtime can charge PGAS without requiring native tokens.
const PGAS_ASSET_ID = 2_000_000_000;
const PGAS_ERC20_PRECOMPILE = "0x7735940000000000000000000000000001200000" as const;
const PASEO_SS58_PREFIX = 0;
// Quizzler's two-phase registry activation creates more storage than the
// minimal reference registry. Fund enough for activation plus a game, while
// retaining product-account PGAS for the setup batch itself.
const SESSION_PGAS_BUDGET = 20_000_000_000n;
// Ending instant actions drains the session's PGAS back to the product
// account with a Revive call whose own fee is charged from that same PGAS
// balance. Leave a reserve behind so the transfer never competes with its
// fee; dust on a revoked key is acceptable, a failed drain that blocks
// revocation is not.
const SESSION_DRAIN_FEE_RESERVE = 1_000_000_000n;
// Revive calls vary materially with the storage they touch. In particular,
// registering a session writes four mappings and is larger than a normal game
// move, so always dry-run it rather than relying on a static gas guess.
const REVIVE_GAS_MARGIN = 2n;
const REVIVE_STORAGE_MARGIN = 2n;
const MIN_REVIVE_STORAGE_HEADROOM = 1_000_000_000n;
// Submission resolves at best-block for responsiveness, while contract and
// storage reads can lag until the next finalized view. Give that hand-off a
// little over one normal Paseo block before treating setup as failed.
const SESSION_STATE_CONFIRM_ATTEMPTS = 12;
const SESSION_STATE_CONFIRM_DELAY_MS = 750;

// These are the only calls a session key may make on a Quizzler game. Pack
// authoring, profile changes, lobby management, forfeiting, and creation stay
// on the product account even when instant actions are enabled.
const SESSION_GAME_METHODS = new Set([
    "submitAnswer",
    "submitFinalWager",
    "submitFinalAnswer",
    "voteCorrect",
    "readyContinue",
    "voteDifficulty",
]);

// Saving a pack is a small, player-owned interaction. The PackSignals
// contract resolves the session key back to the same product account, so it
// belongs on the same instant-action path as in-game moves—not on a separate
// wallet-only preference path.
const SESSION_SIGNAL_METHODS = new Set(["setFavorite"]);

// These marks are deliberately local-only: they make startup, catalog, and
// first-snapshot timing visible in the browser Performance panel without
// adding analytics, network requests, or player-visible work.
const PERFORMANCE_PREFIX = "quizzler:";

function performanceMark(name: string): string {
    const mark = `${PERFORMANCE_PREFIX}${name}`;
    try {
        globalThis.performance?.mark(mark);
    } catch {
        // Performance entries are optional (and can be disabled by an embed).
    }
    return mark;
}

function performanceMeasure(name: string, startMark: string, endMark: string): void {
    try {
        globalThis.performance?.measure(`${PERFORMANCE_PREFIX}${name}`, startMark, endMark);
    } catch {
        // A missing/cleared mark must never affect the game itself.
    }
}

const appStartMark = performanceMark("app:start");

// ── Chain-facing types (viem decodes named tuples to objects) ───────

interface PhaseView {
    stage: number;
    cursor: number;
    deadline: bigint;
    current_block: bigint;
    final_difficulty: number;
    /** Registry slot of the live question (255 when none). */
    slot: number;
    submit_count: number;
    continue_count: number;
    final_wager_count: number;
    easy_vote_count: number;
    medium_vote_count: number;
    hard_vote_count: number;
    /** Historical roster size; use active_player_count for action progress. */
    player_count: number;
    active_player_count: number;
}

interface SubmissionView {
    player: string;
    submitted: boolean;
    answer: string;
    wager: number;
    correct: boolean;
    overturn_votes: number;
    continue_ready: boolean;
    active: boolean;
}

interface GameView {
    pack_id: number;
    creator: string;
    num_questions: number;
    answer_blocks: number;
    review_blocks: number;
    max_players: number;
    player_count: number;
    active_player_count: number;
}

/** The newer game contract returns this in one consistent RPC read. */
interface LiveGameView extends GameView, PhaseView {
    players: string[];
    scores: (number | bigint)[];
    player_names: string[];
    difficulty_choices: (number | bigint)[];
    difficulty_vote_locked: boolean[];
    final_wagers: (number | bigint)[];
    final_wager_locked: boolean[];
    submissions: SubmissionView[];
}

interface PackView {
    creator: string;
    title: string;
    emoji: string;
    regular_count: number;
    finals_set_count: number;
    sealed: boolean;
}

interface Snapshot {
    phase: PhaseView;
    game: GameView;
    players: string[];
    /** Optional on-chain names, parallel to `players`. */
    playerNames: string[];
    /** Friendly labels derived from on-chain names and stable fallbacks. */
    playerLabels: string[];
    scores: number[];
    /** Per-roster-player difficulty choice and whether it is locked. */
    difficultyChoices: number[];
    difficultyVoteLocked: boolean[];
    /** Per-roster-player final wagers and whether their choice is locked. */
    finalWagers: number[];
    finalWagerLocked: boolean[];
    submissions: SubmissionView[];
    questionText: string;
    /** Canonical answer — only fetched during review stages. */
    answerText: string;
}

interface TxOverrides {
    gasLimit: {
        ref_time: bigint;
        proof_size: bigint;
    };
    storageDepositLimit: bigint;
}

interface TxPreflight {
    expiresAt: number;
    overrides: TxOverrides | null;
    pending: Promise<TxOverrides | null>;
    /** The warm estimate failed on transport; re-estimate on the tap path. */
    failed?: boolean;
}

interface CreatedGameConfig {
    packId: number;
    numQuestions: number;
    answerBlocks: number;
    reviewBlocks: number;
}

interface BestBlock {
    number: number;
}

interface TransactionActor {
    /** SS58 address used as the Revive dry-run origin and nonce account. */
    address: string;
    /** H160 identity; product addresses are used in game state. */
    h160: string;
    signer: ReturnType<SignerAccount["getSigner"]>;
    kind: "product" | "session";
}

interface ReviveCallLimits {
    weight_limit: {
        ref_time: bigint;
        proof_size: bigint;
    };
    storage_deposit_limit: bigint;
}

type SessionAccount = SessionKeyInfo["account"];

// ── App state ────────────────────────────────────────────────────────

const manager = new SignerManager({ ss58Prefix: 0, dappName: "quizzler" });

let productAccount: SignerAccount | null = null;
let registry: any = null;
let game: any = null;
let sessionRegistry: any = null;
let packSignals: any = null;
let assetHub: any = null;
let unsafeAssetHub: any = null;
let myAddress = ""; // lowercase H160
let knownGames: KnownGame[] = [];
let knownGamesStore: KnownGamesStore | null = null;
let knownGamesHydration: Promise<void> | null = null;
let knownGamesPersist: Promise<void> = Promise.resolve();
const nextTxNonceByAddress = new Map<string, number>();
const nonceSyncByAddress = new Map<string, Promise<number | null>>();
let gameId: bigint | null = null;
// A settings view is a stable overlay in the navigation state, not a new
// chain phase. Polls keep refreshing the details without kicking a player
// back into a question while they are deciding whether to leave.
let gameSettingsOpen = false;
// A final forfeit can make the game Abandoned. Keep that one terminal
// snapshot long enough to show its scorecard, even though this account is no
// longer active and therefore cannot resume it later.
let pendingAbandonedForfeit: bigint | null = null;
let latest: Snapshot | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let blockPollSubscription: { unsubscribe(): void } | null = null;
let chainStatusSubscription: { unsubscribe(): void } | null = null;
let bestBlocks: { subscribe: (next: (blocks: readonly BestBlock[]) => void) => { unsubscribe(): void } } | null = null;
let lastBlockSignalAt = 0;
let selectedPackId: number | null = null;
let selectedPack: PackView | null = null;
let busy = false;

// Instant actions deliberately use a locally held, narrow session key rather
// than the host's broad AutoSigning capability. The mnemonic lives only in
// host-backed per-app storage; it is never copied into browser storage.
let sessionKeyManager: SessionKeyManager | null = null;
let instantPlayPreferenceStore: LocalKvStore | null = null;
let sessionAccount: SessionAccount | null = null;
let quickPlaySetup: Promise<void> | null = null;
let quickPlayHydration: Promise<void> | null = null;
let automaticInstantPlaySetup: Promise<void> | null = null;
let automaticInstantPlayAttempted = false;
let pendingInstantPlayRequest: { gameSession: number; force: boolean } | null = null;
let instantPlayFallback = false;
let instantPlayPreference: InstantPlayPreference | null = null;
let instantPlayPreferenceLoaded = false;
let quickPlayMessage = "";
let quickPlayPending = false;
let instantPlayFailureDetail = "";

// Local per-stage action guards (cleared when the stage key changes) so we
// don't re-send txs the chain would reject anyway.
let actionKey = "";
const actionsSent = new Set<string>();
const actionSentAt = new Map<string, number>();

function markActionSent(action: string): void {
    actionsSent.add(action);
    actionSentAt.set(action, Date.now());
}

function clearActionSent(action: string): void {
    actionsSent.delete(action);
    actionSentAt.delete(action);
}

/**
 * A best-block inclusion can be reorged out. Never let that optimistic local
 * guard trap the player forever: confirmed state wins immediately; an
 * unconfirmed intent becomes safely retryable after a short reconciliation
 * window (the contract remains the idempotent authority).
 */
function reconcileActionGuards(snap: Snapshot): void {
    const mine = snap.submissions.find((submission) => submission.player.toLowerCase() === myAddress);
    if (mine?.submitted) clearActionSent("submit");
    if (mine?.continue_ready) clearActionSent("continue");
    const myIndex = snap.players.indexOf(myAddress);
    if (myIndex >= 0 && snap.difficultyVoteLocked[myIndex]) clearActionSent("difficulty");
    if (myIndex >= 0 && snap.finalWagerLocked[myIndex]) clearActionSent("final-wager");
    const now = Date.now();
    for (const [action, sentAt] of actionSentAt) {
        if (now - sentAt < 18_000) continue;
        clearActionSent(action);
        setTransactionStatus("Still confirming — you can retry safely if needed.");
    }
}

// Poll ordering guards: polls are skipped while one is in flight, and a
// snapshot that is BEHIND the one on screen is dropped unless it persists
// (a stale read or transient fork view resolves out of order; a genuine
// reorg keeps reporting the earlier phase and wins after a few polls).
let pollInFlight = false;
let pollQueued = false;
let consecutivePollFailures = 0;
let lastRank = -1;
let behindPhaseCandidate: {
    rank: number;
    stage: number;
    cursor: number;
    currentBlock: bigint;
    sightings: number;
} | null = null;
let latestObservedAt = 0;
// Incremented whenever a game is entered or left. This distinguishes a new
// session from a stale request even when the player re-enters the same game.
let gameSession = 0;
let gameEntryMark: string | null = null;
let awaitingFirstGameSnapshot = false;

// Once-per-game wager pool: value → correct? (undefined = still available)
let wagerOutcomes = new Map<number, boolean>();
let wagerHistoryLoadedUpTo = -1;
let selectedWager: number | null = null;
let selectedDifficulty: number | null = null;
let activeAnswerKey = "";
let activeFinalWagerKey = "";
// Final scoring is already settled during final review, even though the
// contract keeps the room there until everyone has acknowledged it. This is
// a local route only: it lets players see the trophy page immediately while
// polling continues until the terminal on-chain stage arrives.
let finalResultsPreviewOpen = false;
// Optimistic local echo of my in-flight answer, shown until the chain
// confirms it (rolled back if the tx fails).
let optimisticAnswer: { qkey: number; answer: string; wager: number } | null = null;

// Registry content caches (immutable once sealed)
const questionCache = new Map<string, string>();
const answerCache = new Map<string, string>();
const packTitleCache = new Map<string, string>();
// A sealed pack is immutable, so its metadata never needs another RPC read.
const sealedPackCache = new Map<string, PackView>();
const questionRequests = new Map<string, Promise<string>>();
const answerRequests = new Map<string, Promise<string>>();
const packTitleRequests = new Map<string, Promise<string>>();
const gameSettingsPackRequests = new Map<string, Promise<PackView | null>>();
const gameSettingsPackRetryAfter = new Map<string, number>();
const GAME_SETTINGS_PACK_RETRY_MS = 15_000;

// A dry-run is needed to size each contract call. Most game actions have
// plenty of think time, so warm the estimate in the background and let the
// wallet open immediately when the player taps the button.
const txPreflights = new Map<string, TxPreflight>();
let createGamePreflightTimer: ReturnType<typeof setTimeout> | null = null;
let preparedGameCreationNonce: bigint | null = null;

let myDisplayName = "";
// Profile reads are intentionally non-blocking, so guard an optimistic save
// from an older RPC response (or a pre-inclusion game snapshot) that arrives
// afterwards. Keep the local result until the chain echoes the same value.
let displayNameRevision = 0;
let pendingDisplayName: string | null = null;

// Pack studio state. Draft contents are deliberately local until the final
// publish action; only the selected cover and validated quiz are ever sent to
// the public registry.
const packDraftStore = createBrowserPackDraftStore();
const packDraftSaver = new DebouncedPackDraftSaver(packDraftStore, {
    onError: () => setDraftSaveStatus("Couldn’t save this draft locally."),
});
let packDrafts: PackDraft[] = [];
let activePackDraft: PackDraft | null = null;
let packDraftValidation: PackDraftValidation | null = null;
let packStudioLoaded = false;
let packPublishInProgress = false;
let publishingDraftId: string | null = null;

// ── Screen switching ─────────────────────────────────────────────────

const SCREENS = ["boot", "home", "pack-select", "configure", "builder", "lobby", "game-settings", "question", "review", "vote", "final-wager", "results", "abandoned"] as const;
type Screen = (typeof SCREENS)[number];
const $appShell = document.querySelector<HTMLElement>("main");
let visibleScreen: Screen | null = null;

function showScreen(name: Screen): void {
    for (const s of SCREENS) {
        getEl(`screen-${s}`).classList.toggle("active", s === name);
    }
    const isSetupFlow = name === "pack-select" || name === "configure";
    const isGameStage = name === "question" || name === "review" || name === "vote" || name === "final-wager";
    // The header gear only opens a current game's settings. Make route changes
    // authoritative so it can never remain as a dead control on setup, home,
    // or results screens after a game transition.
    const gameControlMode = name === "lobby"
        ? "lobby"
        : isGameStage
          ? "active"
          : "hidden";
    setGameControls(gameControlMode);
    document.body.classList.toggle("setup-flow-open", isSetupFlow);
    document.body.classList.toggle("game-stage-open", isGameStage);
    $appShell?.classList.toggle("setup-flow-open", isSetupFlow);
    $appShell?.classList.toggle("game-stage-open", isGameStage);
    const changed = visibleScreen !== name;
    visibleScreen = name;
    if (name === "home" || name === "lobby" || name === "game-settings") renderQuickPlayStatus();
    // Announce a genuine stage transition without stealing the cursor from an
    // answer field on every block-driven re-render.
    if (changed && name !== "boot") {
        queueMicrotask(() => {
            const target = getEl(`screen-${name}`).querySelector<HTMLElement>("h2, .question-text");
            if (!target) return;
            target.tabIndex = -1;
            target.focus({ preventScroll: true });
        });
    }
}

function knownGamesStorageKey(): string | null {
    return myAddress && isContractAddress(activeContracts.game)
        ? knownGamesKey(activeContracts.game, myAddress)
        : null;
}

function browserKnownGamesStore(): KnownGamesStore {
    const keyFor = (key: string) => `quizzler:games:${key}`;
    return {
        async getJSON<T>(key: string): Promise<T | null> {
            try {
                const raw = window.localStorage.getItem(keyFor(key));
                return raw === null ? null : JSON.parse(raw) as T;
            } catch {
                return null;
            }
        },
        async setJSON(key: string, value: unknown): Promise<void> {
            try {
                window.localStorage.setItem(keyFor(key), JSON.stringify(value));
            } catch {
                // Browser privacy settings should not block party play.
            }
        },
        async remove(key: string): Promise<void> {
            try {
                window.localStorage.removeItem(keyFor(key));
            } catch {
                // Best effort only.
            }
        },
    };
}

async function getKnownGamesStore(): Promise<KnownGamesStore> {
    if (knownGamesStore) return knownGamesStore;
    try {
        knownGamesStore = await createLocalKvStore({ prefix: "quizzler:games" });
    } catch {
        // The published app uses Polkadot's host storage. A normal browser
        // preview still gets durable recovery through its own local storage.
        knownGamesStore = browserKnownGamesStore();
    }
    return knownGamesStore;
}

async function hydrateKnownGames(): Promise<void> {
    if (knownGamesHydration) return knownGamesHydration;
    knownGamesHydration = (async () => {
        const key = knownGamesStorageKey();
        if (key === null) return;
        const load = (async (): Promise<KnownGame[]> =>
            readKnownGames(await getKnownGamesStore(), key))();
        try {
            knownGames = await withTimeout(
                load,
                KNOWN_GAMES_STORAGE_TIMEOUT_MS,
                "Timed out restoring saved games.",
            );
        } catch {
            // Host storage is recovery-only. Show Home on time, then let a
            // late result populate the visible rejoin list if it arrives
            // before the player enters another room.
            knownGames = [];
            void load.then((stored) => {
                if (knownGames.length > 0) return;
                knownGames = stored;
                renderKnownGames();
                refreshKnownGames();
            }).catch(() => undefined);
        }
        renderKnownGames();
    })();
    return knownGamesHydration;
}

function persistKnownGames(): void {
    const key = knownGamesStorageKey();
    if (key === null) return;
    const snapshot = [...knownGames];
    knownGamesPersist = knownGamesPersist
        .catch(() => undefined)
        .then(async () => {
            try {
                await writeKnownGames(await getKnownGamesStore(), key, snapshot);
            } catch {
                // Recovery is a convenience; a storage outage never blocks play.
            }
        });
}

/** Start an independent final write when a page is about to close. */
function flushKnownGames(): void {
    const key = knownGamesStorageKey();
    if (key === null) return;
    const snapshot = [...knownGames];
    void getKnownGamesStore()
        .then((store) => writeKnownGames(store, key, snapshot))
        .catch(() => undefined);
}

function rememberGame(id: bigint): void {
    knownGames = touchKnownGame(knownGames, id);
    persistKnownGames();
    renderKnownGames();
}

function forgetKnownGame(id: bigint): void {
    knownGames = removeKnownGame(knownGames, id);
    persistKnownGames();
    renderKnownGames();
}

const $bootLog = getEl("boot-log");
const $connPill = getEl("conn-pill");
const $appHeader = getEl<HTMLElement>("app-header");
const $gameStageTimer = getEl("game-stage-timer");
const $btnGameSettings = getEl<HTMLButtonElement>("btn-game-settings");
const $forfeitDialog = getEl<HTMLDialogElement>("forfeit-dialog");
const $transactionStatus = getEl("transaction-status");

function setGameControls(mode: "hidden" | "lobby" | "active"): void {
    const showingSettings = gameSettingsOpen;
    $btnGameSettings.hidden = mode === "hidden" || showingSettings;
    const showTimer = mode === "active" && !showingSettings;
    $gameStageTimer.hidden = !showTimer;
    if (!showTimer) {
        $gameStageTimer.textContent = "";
        $gameStageTimer.classList.remove("urgent");
    }
    syncAppHeader();
}

/** Only reserve top-bar space when a player can act there or needs feedback. */
function syncAppHeader(): void {
    $appHeader.hidden = $btnGameSettings.hidden && $gameStageTimer.hidden && $transactionStatus.hidden;
}

function bootLog(msg: string, level: "info" | "ok" | "err" = "info"): void {
    appendLog($bootLog, msg, level);
}

/**
 * The one player-facing line on the boot screen. The step-by-step log stays
 * in a collapsed details section for diagnosis (and the e2e boot ordering
 * assertions); players only ever need the headline.
 */
function setBootHeadline(message: string, failed = false): void {
    const headline = getEl("boot-headline");
    headline.textContent = message;
    headline.classList.toggle("is-error", failed);
}

function setConnectionStatus(label: string, state: "pending" | "ok" | "err"): void {
    $connPill.textContent = label;
    $connPill.dataset.state = state;
}

function setTransactionStatus(message: string | null): void {
    $transactionStatus.hidden = !message;
    $transactionStatus.textContent = message ?? "";
    syncAppHeader();
}

// Chain plumbing (block numbers) stays out of the header; the shared block
// subscription instead keeps an open pack picker gently fresh.
function onBlockSignal(blocks: readonly BestBlock[]): void {
    if (blocks[0]?.number === undefined) return;
    maybeRefreshOpenCatalog();
}

function subscribeChainStatus(): void {
    chainStatusSubscription?.unsubscribe();
    if (!bestBlocks) return;
    chainStatusSubscription = bestBlocks.subscribe(onBlockSignal);
}

function fmtPlayer(snap: Pick<Snapshot, "players" | "playerLabels">, addr: string): string {
    if (addr.toLowerCase() === myAddress.toLowerCase()) return "You";
    const index = snap.players.findIndex((player) => player.toLowerCase() === addr.toLowerCase());
    return index >= 0 ? snap.playerLabels[index] ?? playerName(addr) : playerName(addr);
}

/** In-flight tx feedback: spinner + disabled, cleared in the finally. */
function setLoading(id: string, on: boolean): void {
    const btn = getEl<HTMLButtonElement>(id);
    btn.classList.toggle("loading", on);
    btn.disabled = on;
    btn.setAttribute("aria-busy", String(on));
}

/** Raw error text, for control flow (`includes("AlreadyJoined")`) and logs. */
function txError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    // contract reverts carry the raw revert string (e.g. "AlreadyJoined")
    return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

// Player-facing copy for the contract reverts a real table can hit. Anything
// technical that slips past this list falls into the calm generic buckets in
// `friendlyError` — raw revert names, dispatch-error JSON, and hex never
// reach the screen.
const REVERT_MESSAGES: readonly (readonly [pattern: string, copy: string])[] = [
    ["AlreadyJoined", "You’re already in this game."],
    ["GameAlreadyStarted", "This game has already started."],
    ["GameFull", "This lobby is full."],
    ["NoSuchGame", "No game found with that code — check the six digits."],
    ["LobbyClosed", "This lobby is no longer open."],
    ["NotLobbyStarter", "Only the longest-waiting player can start the game."],
    ["NotAPlayer", "You’re not part of this quiz."],
    ["PlayerForfeited", "You forfeited this quiz, so this move isn’t available."],
    ["GameNotActive", "This quiz has ended."],
    ["AlreadyAnswered", "Your answer is already in."],
    ["NotAcceptingFinalAnswer", "Time’s up for the final question."],
    ["NotAcceptingAnswers", "Time’s up for this question."],
    ["FinalWagerLocked", "Your final wager is already locked."],
    ["BadWager", "That wager isn’t available — pick an unused number."],
    ["AlreadyVoted", "Your vote is already recorded."],
    ["AlreadyContinued", "You’re already ready for the next question."],
    ["AlreadyCorrect", "That answer is already marked correct."],
    ["CannotVoteForSelf", "You can’t vote on your own answer."],
    ["NotInReview", "The table has moved on — this screen will catch up in a moment."],
    ["NotInDifficultyVote", "The table has moved on — this screen will catch up in a moment."],
    ["NotInFinalWager", "The table has moved on — this screen will catch up in a moment."],
    ["BadDisplayName", "That name can’t be used — try a shorter one-line name."],
];

/**
 * Player-facing error copy. Known reverts get specific guidance; everything
 * technical collapses to a calm, action-oriented fallback. Messages our own
 * code authored (human sentences) pass through unchanged. The raw error is
 * kept in the console for diagnosis.
 */
function friendlyError(e: unknown): string {
    console.warn("action failed", e);
    const raw = txError(e);
    for (const [pattern, copy] of REVERT_MESSAGES) {
        if (raw.includes(pattern)) return copy;
    }
    const lower = raw.toLowerCase();
    if (/\b(reject|cancel|declin|denied|dismiss)/.test(lower)) {
        return "No changes made. Tap Allow when you’re ready.";
    }
    if (/timed? ?out|network|fetch|disconnect|unreachable/.test(lower)) {
        return "Trouble reaching the network — nothing changed. Try again.";
    }
    if (/out ?of ?gas|exhaustsresources|stale|nonce|priority|insufficient|payment/.test(lower)) {
        return "That didn’t go through — nothing changed. Try again.";
    }
    // Dispatch-error JSON, hex blobs, bare revert tokens, and chain jargon
    // are never player copy.
    if (/[{}"]|0x[0-9a-f]{6,}|revert|extrinsic|dispatch/i.test(raw) || !raw.includes(" ")) {
        return "That didn’t go through — nothing changed. Try again.";
    }
    return raw;
}

function clearInstantPlayFailure(): void {
    instantPlayFailureDetail = "";
}

function rememberInstantPlayFailure(error: unknown): void {
    instantPlayFailureDetail = friendlyError(error);
}

/** Transaction sizing, nonce handling, and submission helpers. */
function productTransactionActor(): TransactionActor {
    if (!productAccount) throw new Error("Account not ready");
    return {
        address: productAccount.address,
        h160: myAddress,
        signer: productAccount.getSigner(),
        kind: "product",
    };
}

function activeSessionActor(): TransactionActor | null {
    if (!sessionAccount) return null;
    return sessionTransactionActor(sessionAccount);
}

function sessionTransactionActor(account: SessionAccount): TransactionActor {
    return {
        // SessionKeyManager intentionally uses generic SS58 (prefix 42). The
        // Paseo chain client expects its own prefix for account queries,
        // nonces, and Revive-call origins, so always re-encode the same key.
        address: sessionChainAddress(account),
        h160: account.h160Address.toLowerCase(),
        signer: account.signer,
        kind: "session",
    };
}

function sessionChainAddress(account: SessionAccount): string {
    return ss58Encode(account.publicKey, PASEO_SS58_PREFIX);
}

/** Resolve the narrow signer allowed for this exact UI action. */
function transactionActor(handle: any, method: string): TransactionActor {
    const session = (
        (handle === game && SESSION_GAME_METHODS.has(method))
        || (handle === packSignals && SESSION_SIGNAL_METHODS.has(method))
    ) ? activeSessionActor() : null;
    return session ?? productTransactionActor();
}

/**
 * Session infrastructure can disappear between lobby entry and a move. Retry
 * exactly once with the product account only when the owner mapping is gone
 * or the error clearly concerns the session's gas/fee path; semantic game
 * errors still surface normally and are never replayed.
 */
function isSessionInfrastructureFailure(error: unknown): boolean {
    return /\b(out\s*of\s*gas|outofgas|pgas|insufficient\s+(?:balance|funds|gas)|(?:fee|payment)\s+(?:failed|required|unavailable))\b/i
        .test(txError(error));
}

async function fallBackFromUnavailableSession(actor: TransactionActor, error: unknown): Promise<boolean> {
    if (actor.kind !== "session" || !sessionAccount) return false;
    let registered: boolean;
    try {
        registered = await sessionIsRegistered(sessionAccount);
    } catch {
        // An RPC outage is not proof that the session is inactive, so avoid
        // opening an unnecessary wallet approval in that case.
        return false;
    }
    if (registered && !isSessionInfrastructureFailure(error)) return false;

    sessionAccount = null;
    quickPlayPending = false;
    // Keep the local key until the next serialized setup can reconcile it.
    // Clearing it here races a new enrollment and can erase the new key.
    // When the failure is gas/fee related, skip sessions for the rest of this
    // page visit; a reload can safely re-check the still-live mapping.
    if (registered) automaticInstantPlayAttempted = true;
    instantPlayFallback = true;
    quickPlayMessage = registered
        ? "Instant actions couldn’t cover this move — approve it yourself instead."
        : "Instant actions ended — approve this action yourself instead.";
    renderQuickPlayStatus();
    return true;
}

function preflightKey(actor: TransactionActor, method: string, args: readonly unknown[]): string {
    return `${actor.address}:${method}:${args.map((arg) => String(arg)).join(":")}`;
}

/** Dry-run once to validate a call and produce the safely padded gas limit. */
async function estimateTx(
    handle: any,
    method: string,
    args: readonly unknown[],
    actor = transactionActor(handle, method),
): Promise<TxOverrides | null> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            const q = await handle[method].query(...args, { origin: actor.address });
            // Do not turn a failed dry-run into a paid transaction. Leaving the
            // overrides empty lets the SDK surface the contract's revert reason.
            if (!q?.success || !q.gasRequired) return null;
            return {
                gasLimit: {
                    ref_time: (q.gasRequired.ref_time * 3n) / 2n,
                    proof_size: (q.gasRequired.proof_size * 3n) / 2n,
                },
                // This is a cap rather than a cost. Supplying both values tells
                // the SDK not to repeat this exact dry-run before signing.
                storageDepositLimit: 20_000_000_000n,
            };
        } catch (error) {
            // A *thrown* dry-run is a transport failure, not a contract
            // revert. Falling through to an unpadded submit would let the SDK
            // sign with the exact dry-run weight, which OutOfGas-es the
            // game's nested registry calls on-chain — a paid failure. Retry
            // the estimate once, then refuse to submit.
            if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                continue;
            }
            throw new Error("Couldn’t size this action — check your connection and try again.", { cause: error });
        }
    }
}

/** Start a best-effort preflight without making the UI wait for it. */
function warmTx(handle: any, method: string, args: readonly unknown[]): string {
    const actor = transactionActor(handle, method);
    const key = preflightKey(actor, method, args);
    const existing = txPreflights.get(key);
    if (existing && existing.expiresAt > Date.now()) return key;
    const preflight: TxPreflight = {
        expiresAt: Date.now() + PREFLIGHT_TTL_MS,
        overrides: null,
        pending: Promise.resolve(null),
    };
    preflight.pending = estimateTx(handle, method, args, actor).then((overrides) => {
        preflight.overrides = overrides;
        return overrides;
    }).catch(() => {
        // A background warm-up must never surface as an unhandled rejection.
        // Mark it failed so the tap path runs a fresh, error-visible estimate.
        preflight.failed = true;
        return null;
    });
    txPreflights.set(key, preflight);
    return key;
}

async function warmedOverrides(handle: any, method: string, args: readonly unknown[]): Promise<TxOverrides | null> {
    const key = warmTx(handle, method, args);
    const preflight = txPreflights.get(key);
    if (!preflight) return estimateTx(handle, method, args);
    const overrides = preflight.overrides ?? await preflight.pending;
    txPreflights.delete(key); // estimates are one-use and state-sensitive
    if (overrides === null && preflight.failed) return estimateTx(handle, method, args);
    return overrides;
}

async function reserveTxNonce(actor: TransactionActor): Promise<number | null> {
    if (!assetHub) return null;
    const key = actor.address;
    if (!nextTxNonceByAddress.has(key)) {
        await syncTxNonce(actor);
    }
    const next = nextTxNonceByAddress.get(key);
    if (next === undefined) return null;
    const nonce = next;
    nextTxNonceByAddress.set(key, nonce + 1);
    return nonce;
}

/** Fetch one actor's best-block nonce, shared by its first transaction. */
function syncTxNonce(actor: TransactionActor): Promise<number | null> {
    if (!assetHub) return Promise.resolve(null);
    const key = actor.address;
    const inFlight = nonceSyncByAddress.get(key);
    if (inFlight) return inFlight;
    const request: Promise<number | null> = assetHub.apis.AccountNonceApi.account_nonce(actor.address, { at: "best" })
        .then((nonce: number | bigint) => {
            const next = Number(nonce);
            nextTxNonceByAddress.set(key, next);
            return next;
        })
        .catch(() => null)
        .finally(() => {
            nonceSyncByAddress.delete(key);
        });
    nonceSyncByAddress.set(key, request);
    return request;
}

function clearActorNonce(actor: TransactionActor): void {
    nextTxNonceByAddress.delete(actor.address);
    nonceSyncByAddress.delete(actor.address);
}

/**
 * The contracts helper deliberately hides nonce selection. For interactive
 * games, however, finalized-state nonces turn Create → Start into a frequent
 * stale transaction. Submit its prepared Revive call with our best-block
 * nonce, resolving at inclusion just like the helper does.
 */
async function submitPreparedTx(
    transaction: any,
    actor: TransactionActor,
    nonce: number | null,
    signingOptions: Record<string, unknown> = {},
): Promise<void> {
    setTransactionStatus(actor.kind === "session" ? null : "Waiting for your approval…");
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        let subscription: { unsubscribe(): void } | null = null;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            subscription?.unsubscribe();
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => finish(new Error("Timed out waiting for a block.")), 90_000);
        try {
            const nextSubscription = transaction.signSubmitAndWatch(actor.signer, {
                ...signingOptions,
                ...(nonce === null ? {} : { nonce }),
                mortality: { mortal: true, period: 256 },
            }).subscribe({
                next: (event: any) => {
                    if (event.type !== "txBestBlocksState" || !event.found || event.ok === undefined) return;
                    if (!event.ok) {
                        // Plain JSON.stringify throws on the bigints a dispatch
                        // error can carry, which would leave this promise
                        // hanging until the timeout with the reason lost.
                        finish(new Error(stringifyChainError(event.dispatchError)));
                    } else {
                        setTransactionStatus(null);
                        finish();
                    }
                },
                error: (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
            });
            subscription = nextSubscription;
            if (actor.kind === "session") setTransactionStatus(null);
            if (settled) nextSubscription.unsubscribe();
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

async function submitTx(
    handle: any,
    method: string,
    args: readonly unknown[],
    initialOverrides: TxOverrides | null = null,
): Promise<void> {
    const actor = transactionActor(handle, method);
    for (let attempt = 0; ; attempt++) {
        try {
            // Buttons already show their own in-flight state; the shared
            // status line only narrates when the player must act or retry.
            setTransactionStatus(attempt === 0 ? null : "Retrying…");
            // A warmed estimate avoids an RPC on the tap path. On retries we
            // intentionally estimate again against current chain state.
            const overrides = attempt === 0 && initialOverrides !== null
                ? initialOverrides
                : await estimateTx(handle, method, args, actor);
            const nonce = await reserveTxNonce(actor);
            if (nonce === null) {
                // Degrade safely to the SDK's submission path if the account
                // nonce API is unavailable in a host implementation.
                setTransactionStatus(actor.kind === "session" ? null : "Waiting for your approval…");
                const result = await handle[method].tx(...args, {
                    signer: actor.signer,
                    origin: actor.address,
                    ...(overrides ?? {}),
                });
                if (!result.ok) throw new Error(stringifyChainError(result.dispatchError));
                setTransactionStatus(null);
            } else {
                const transaction = await handle[method].prepare(...args, {
                    origin: actor.address,
                    ...(overrides ?? {}),
                });
                await submitPreparedTx(transaction, actor, nonce);
            }
            return;
        } catch (e) {
            // The tx may or may not have reached a best block. Re-read before
            // another action/retry instead of assuming a nonce is still free.
            clearActorNonce(actor);
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt === 0 && msg.includes("Stale")) {
                setTransactionStatus("Retrying…");
                await new Promise((r) => setTimeout(r, 5_000));
                continue;
            }
            // A gas-shaped dispatch failure usually means the state moved
            // between the (possibly warmed) estimate and inclusion — e.g. more
            // players joined before startGame. One fresh estimate normally
            // resolves it; a second failure surfaces normally.
            if (attempt === 0 && /out ?of ?gas|exhaustsresources|weight/i.test(msg)) {
                setTransactionStatus("Retrying…");
                continue;
            }
            if (await fallBackFromUnavailableSession(actor, e)) {
                setTransactionStatus("Instant actions unavailable — waiting for your approval…");
                // Drop the session-specific warm estimate and let the product
                // account dry-run/sign this one action normally.
                return submitTx(handle, method, args);
            }
            // The local action's own error line carries the friendly message;
            // clear the shared status so the failure isn't narrated twice.
            setTransactionStatus(null);
            throw e;
        }
    }
}

async function sendTx(handle: any, method: string, ...args: unknown[]): Promise<void> {
    await submitTx(handle, method, args);
}

async function sendWarmedTx(handle: any, method: string, args: readonly unknown[]): Promise<void> {
    await submitTx(handle, method, args, await warmedOverrides(handle, method, args));
}

// ── Instant-action sessions ──────────────────────────────────────────

class InstantPlayAllowanceError extends Error {
    constructor(
        readonly outcome: "Rejected" | "NotAvailable" | "HostError",
        message: string,
    ) {
        super(message);
        this.name = "InstantPlayAllowanceError";
    }
}

/** An automatic attempt became irrelevant because its lobby was left. */
class InstantPlaySetupCancelled extends Error {
    constructor() {
        super("Instant-action setup was cancelled because the game was left.");
        this.name = "InstantPlaySetupCancelled";
    }
}

type InstantPlaySetupGuard = () => boolean;
const alwaysContinueInstantPlaySetup: InstantPlaySetupGuard = () => true;

function assertInstantPlaySetupCurrent(canContinue: InstantPlaySetupGuard): void {
    if (!canContinue()) throw new InstantPlaySetupCancelled();
}

function instantPlayPreferenceName(): string {
    if (!myAddress) throw new Error("Instant actions are not configured.");
    // This is intentionally scoped to the product identity and network, not
    // the session-registry address. A contract upgrade must not re-prompt a
    // player who previously chose normal wallet signing.
    return `autosign-preference:paseo-asset-hub:${myAddress}`;
}

async function getInstantPlayPreferenceStore(): Promise<LocalKvStore> {
    if (instantPlayPreferenceStore) return instantPlayPreferenceStore;
    instantPlayPreferenceStore = await createLocalKvStore({ prefix: "quizzler:instant-play" });
    return instantPlayPreferenceStore;
}

async function loadInstantPlayPreference(): Promise<InstantPlayPreference | null> {
    if (instantPlayPreferenceLoaded) return instantPlayPreference;
    try {
        const store = await getInstantPlayPreferenceStore();
        instantPlayPreference = normalizeInstantPlayPreference(
            await store.getJSON<InstantPlayPreference>(instantPlayPreferenceName()),
        );
    } catch {
        // If host KV is unavailable, setup itself cannot safely persist a
        // bearer key either. The in-memory one-attempt guard still prevents
        // repeated prompts during this visit.
        instantPlayPreference = null;
    }
    instantPlayPreferenceLoaded = true;
    return instantPlayPreference;
}

async function saveInstantPlayPreference(preference: InstantPlayPreference | null): Promise<void> {
    instantPlayPreference = preference;
    instantPlayPreferenceLoaded = true;
    try {
        const store = await getInstantPlayPreferenceStore();
        const name = instantPlayPreferenceName();
        if (preference === null) await store.remove(name);
        else await store.setJSON(name, preference);
    } catch {
        // This is only a non-secret UX preference. In-memory state remains a
        // safe fallback if host storage is unavailable.
    }
}

function quickPlayStorageName(): string {
    const registryAddress = activeContracts.sessionRegistry;
    if (!isContractAddress(registryAddress) || !myAddress) throw new Error("Instant actions are not configured.");
    // The session credential is tied to this registry and to the account-backed
    // enrollment protocol, never to the browser's generic local-storage key.
    return `account-backed:${registryAddress.toLowerCase()}:${myAddress}`;
}

async function getSessionKeyManager(): Promise<SessionKeyManager> {
    if (sessionKeyManager) return sessionKeyManager;
    const store = await createLocalKvStore({ prefix: "quizzler:quick-play" });
    sessionKeyManager = new SessionKeyManager({
        store,
        name: quickPlayStorageName(),
    });
    return sessionKeyManager;
}

async function sessionIsRegistered(candidate: SessionAccount): Promise<boolean> {
    if (!sessionRegistry || !productAccount) throw new Error("Instant-action registry is unavailable.");
    const registered = await sessionRegistry.sessionOf.query(myAddress, { origin: productAccount.address });
    if (!registered.success) throw new Error("Couldn’t check the instant-action session. Try again in a moment.");
    return String(registered.value).toLowerCase() === candidate.h160Address.toLowerCase();
}

async function sessionActivationPending(candidate: SessionAccount): Promise<boolean> {
    if (!sessionRegistry || !productAccount) throw new Error("Instant-action registry is unavailable.");
    const pending = await sessionRegistry.pendingOwnerOf.query(candidate.h160Address, {
        origin: productAccount.address,
    });
    if (!pending.success) throw new Error("Couldn’t check the instant-action setup. Try again in a moment.");
    return String(pending.value).toLowerCase() === myAddress;
}

/** Inclusion notifications can arrive just before the contract query sees the new state. */
async function waitForSessionState(check: () => Promise<boolean>): Promise<boolean> {
    for (let attempt = 0; attempt < SESSION_STATE_CONFIRM_ATTEMPTS; attempt += 1) {
        if (await check().catch(() => false)) return true;
        if (attempt + 1 < SESSION_STATE_CONFIRM_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, SESSION_STATE_CONFIRM_DELAY_MS));
        }
    }
    return false;
}

function waitForSessionRegistration(candidate: SessionAccount): Promise<boolean> {
    return waitForSessionState(() => sessionIsRegistered(candidate));
}

function waitForSessionActivationPending(candidate: SessionAccount): Promise<boolean> {
    return waitForSessionState(() => sessionActivationPending(candidate));
}

async function sessionHasOnChainMapping(candidate: SessionAccount): Promise<boolean> {
    if (!assetHub) throw new Error("Chain client is not ready.");
    const original = await assetHub.query.Revive.OriginalAccount.getValue(candidate.h160Address);
    if (original === undefined || original === null) return false;
    try {
        const mappedAccount = accountIdBytes(String(original));
        return mappedAccount.length === candidate.publicKey.length
            && mappedAccount.every((byte, index) => byte === candidate.publicKey[index]);
    } catch {
        return false;
    }
}

function waitForSessionMapping(candidate: SessionAccount): Promise<boolean> {
    return waitForSessionState(() => sessionHasOnChainMapping(candidate));
}

function waitForPgasBalance(address: string, minimum: bigint): Promise<boolean> {
    return waitForSessionState(async () => (await pgasBalance(address)) >= minimum);
}

/** A fresh, unbound key resolves to itself; used or tombstoned keys resolve to zero. */
async function sessionKeyCanBeRequested(candidate: SessionAccount): Promise<boolean> {
    if (!sessionRegistry || !productAccount) throw new Error("Instant-action registry is unavailable.");
    const resolved = await sessionRegistry.resolve.query(candidate.h160Address, { origin: productAccount.address });
    if (!resolved.success) throw new Error("Couldn’t check the saved instant-action key. Try again in a moment.");
    return String(resolved.value).toLowerCase() === candidate.h160Address.toLowerCase();
}

async function pgasBalance(address: string): Promise<bigint> {
    if (!assetHub) return 0n;
    const account = await assetHub.query.Assets.Account.getValue(PGAS_ASSET_ID, address);
    const balance = account?.balance;
    return typeof balance === "bigint" ? balance : balance === undefined ? 0n : BigInt(balance);
}

/** The PGAS pool location used for ordinary (non-Revive) setup transaction fees. */
function pgasFeeAssetLocation(): Record<string, unknown> {
    return {
        parents: 0,
        interior: {
            type: "X2",
            value: [
                { type: "PalletInstance", value: 50 },
                { type: "GeneralIndex", value: BigInt(PGAS_ASSET_ID) },
            ],
        },
    };
}

async function ensureQuickPlayAllowance(): Promise<void> {
    if (!productAccount) throw new Error("Product account is not ready.");
    // The product account's PGAS balance is the passive, on-chain allowance
    // check. Calling the host allocation API unnecessarily can show another
    // permission UI, so only ask when there is no credit at all.
    if (await pgasBalance(productAccount.address) > 0n) return;

    const allocation = await requestResourceAllocation([
        { tag: "SmartContractAllowance", value: PRODUCT_DERIVATION_INDEX },
    ]);
    if (!allocation.ok) {
        throw new InstantPlayAllowanceError("HostError", "Instant actions could not request the free game allowance.");
    }
    const outcome = allocation.value[0];
    if (outcome === "Rejected" || outcome === "NotAvailable") {
        throw new InstantPlayAllowanceError(
            outcome,
            outcome === "Rejected"
                ? "Instant actions were skipped."
                : "Instant actions aren’t available here right now.",
        );
    }
    if (outcome !== "Allocated") {
        throw new InstantPlayAllowanceError("HostError", "Instant actions could not request the free game allowance.");
    }
}

function stringifyChainError(value: unknown): string {
    try {
        return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
    } catch {
        return String(value);
    }
}

/**
 * Estimate a raw Revive call before signing it. The contract helper does this
 * for ABI methods, but instant actions also call the PGAS ERC-20 precompile and
 * batches decoded calls, so it needs the same protection explicitly.
 */
async function estimateReviveCall(
    destination: `0x${string}`,
    data: `0x${string}`,
    actor: TransactionActor,
): Promise<ReviveCallLimits> {
    if (!unsafeAssetHub) throw new Error("Chain client is not ready.");
    const result: any = await unsafeAssetHub.apis.ReviveApi.call(
        actor.address,
        destination,
        0n,
        undefined,
        undefined,
        hexToBytes(data),
        { at: "best" },
    );
    if (!result?.result?.success || result.result.value?.flags !== 0) {
        throw new Error(`Instant-action call could not be estimated: ${stringifyChainError(result?.result?.value ?? result)}`);
    }
    const gas = result.weight_required;
    if (typeof gas?.ref_time !== "bigint" || typeof gas?.proof_size !== "bigint") {
        throw new Error("Instant-action call did not return a gas estimate.");
    }
    const deposit = result.storage_deposit?.type === "Charge" && typeof result.storage_deposit.value === "bigint"
        ? result.storage_deposit.value
        : 0n;
    return {
        // The reference session flow uses a 2× dry-run buffer. It protects
        // the signed call from small best-block state changes without turning
        // a large static limit into an intermittent OutOfGas failure.
        weight_limit: {
            ref_time: gas.ref_time * REVIVE_GAS_MARGIN,
            proof_size: gas.proof_size * REVIVE_GAS_MARGIN,
        },
        storage_deposit_limit: deposit === 0n
            ? 0n
            : deposit * REVIVE_STORAGE_MARGIN + MIN_REVIVE_STORAGE_HEADROOM,
    };
}

function reviveCall(destination: `0x${string}`, data: `0x${string}`, limits: ReviveCallLimits): any {
    if (!assetHub) throw new Error("Chain client is not ready.");
    return assetHub.tx.Revive.call({
        dest: destination,
        value: 0n,
        weight_limit: limits.weight_limit,
        storage_deposit_limit: limits.storage_deposit_limit,
        data: hexToBytes(data),
    });
}

async function estimatedReviveCall(
    destination: `0x${string}`,
    data: `0x${string}`,
    actor: TransactionActor,
): Promise<any> {
    return reviveCall(destination, data, await estimateReviveCall(destination, data, actor));
}

async function submitStandaloneTx(
    transaction: any,
    actor: TransactionActor,
    signingOptions: Record<string, unknown> = {},
): Promise<void> {
    const nonce = await reserveTxNonce(actor);
    try {
        await submitPreparedTx(transaction, actor, nonce, signingOptions);
    } catch (error) {
        clearActorNonce(actor);
        throw error;
    }
}

async function restoreQuickPlay(): Promise<void> {
    if (!sessionRegistry || !sessionRegistryConfigured() || !productAccount) return;
    try {
        sessionAccount = null;
        quickPlayPending = false;
        const keys = await getSessionKeyManager();
        const stored = await keys.get();
        if (!stored) {
            quickPlayMessage = "Instant actions will be set up when you join a game.";
        } else if (await sessionIsRegistered(stored.account)) {
            sessionAccount = stored.account;
            instantPlayFallback = false;
            clearInstantPlayFailure();
            quickPlayMessage = "Instant actions are ready.";
        } else if (await sessionActivationPending(stored.account)) {
            // The product-signed request may have landed just before an app
            // reload. Retain the bearer key and resume the silent
            // possession-proof call the next time the player enters a game,
            // without another wallet prompt.
            quickPlayPending = true;
            quickPlayMessage = "Instant actions will finish when you join a game.";
        } else if (await sessionKeyCanBeRequested(stored.account)) {
            // A declined setup may have created and safely persisted a fresh
            // key before the allowance prompt. Keep it for an explicit retry
            // instead of replacing it and asking the wallet twice.
            quickPlayMessage = "Instant actions will be retried when you play.";
        } else {
            // This key was used or tombstoned by an earlier session and can
            // never be requested again. Replace it only when setup resumes.
            await keys.clear();
            quickPlayMessage = "Instant actions will be renewed when you play.";
        }
    } catch {
        // Do not erase a bearer key on an indeterminate host or RPC failure.
        // A later restore can still validate or finish the same session.
        quickPlayMessage = "Instant actions couldn’t be checked — you’ll approve each move.";
    }
    renderQuickPlayStatus();
}

/** Serialize the boot restore with later automatic game-entry setup. */
function hydrateQuickPlay(): Promise<void> {
    if (!quickPlayHydration) quickPlayHydration = restoreQuickPlay();
    return quickPlayHydration;
}

/** Complete the session-key half of the setup handshake without a wallet. */
async function activatePendingQuickPlay(
    session: SessionAccount,
    canContinue: InstantPlaySetupGuard = alwaysContinueInstantPlaySetup,
): Promise<void> {
    assertInstantPlaySetupCurrent(canContinue);
    const sessionRegistryAddress = activeContracts.sessionRegistry;
    if (!isContractAddress(sessionRegistryAddress)) {
        throw new Error("Instant actions are not available for this game deployment.");
    }
    const activationData = encodeFunctionData({
        abi: sessionRegistryAbi,
        functionName: "activateSession",
        args: [productTransactionActor().h160 as `0x${string}`],
    });
    quickPlayMessage = "Finishing instant actions…";
    renderQuickPlayStatus();
    const actor = sessionTransactionActor(session);
    // A successful direct PGAS asset transfer creates the real AccountId32
    // and AutoMap records the H160 ↔ session-key relationship. Do not trust a
    // Revive dry-run here: it temporarily maps an account for simulation, so
    // it can succeed even when a signed activation would never be accepted.
    // Both facts land in the same setup batch, so wait for them in parallel
    // rather than serializing two full polling windows.
    const [mapped, funded] = await Promise.all([
        waitForSessionMapping(session),
        waitForPgasBalance(actor.address, 1n),
    ]);
    if (!mapped) {
        throw new Error("The temporary game account was not prepared in time. Please try instant actions again.");
    }
    if (!funded) {
        throw new Error("The temporary game account was not funded in time. Please try instant actions again.");
    }
    assertInstantPlaySetupCurrent(canContinue);
    const limits = await estimateReviveCall(sessionRegistryAddress, activationData, actor);
    assertInstantPlaySetupCurrent(canContinue);
    await submitStandaloneTx(reviveCall(sessionRegistryAddress, activationData, limits), actor);
    assertInstantPlaySetupCurrent(canContinue);
    if (!await waitForSessionRegistration(session)) {
        throw new Error("Instant actions weren’t confirmed in time. Please try again.");
    }
    assertInstantPlaySetupCurrent(canContinue);
    sessionAccount = session;
    instantPlayFallback = false;
    quickPlayPending = false;
    clearInstantPlayFailure();
    quickPlayMessage = "Instant actions are ready.";
}

async function setupQuickPlay(
    canContinue: InstantPlaySetupGuard = alwaysContinueInstantPlaySetup,
): Promise<void> {
    assertInstantPlaySetupCurrent(canContinue);
    const sessionRegistryAddress = activeContracts.sessionRegistry;
    if (!sessionRegistry || !isContractAddress(sessionRegistryAddress)) {
        throw new Error("Instant actions are not available for this game deployment.");
    }
    const keys = await getSessionKeyManager();
    assertInstantPlaySetupCurrent(canContinue);
    const stored = await keys.get();
    assertInstantPlaySetupCurrent(canContinue);
    if (sessionAccount) {
        if (await sessionIsRegistered(sessionAccount)) {
            assertInstantPlaySetupCurrent(canContinue);
            instantPlayFallback = false;
            clearInstantPlayFailure();
            quickPlayMessage = "Instant actions are ready.";
            renderQuickPlayStatus();
            return;
        }
        assertInstantPlaySetupCurrent(canContinue);
        sessionAccount = null;
    }

    let session = stored;
    if (stored) {
        if (await sessionIsRegistered(stored.account)) {
            assertInstantPlaySetupCurrent(canContinue);
            sessionAccount = stored.account;
            instantPlayFallback = false;
            clearInstantPlayFailure();
            quickPlayMessage = "Instant actions are ready.";
            renderQuickPlayStatus();
            return;
        }
        if (await sessionActivationPending(stored.account)) {
            assertInstantPlaySetupCurrent(canContinue);
            quickPlayPending = true;
            await activatePendingQuickPlay(stored.account, canContinue);
            renderQuickPlayStatus();
            return;
        }
        assertInstantPlaySetupCurrent(canContinue);
        // A rejected allowance request can leave behind a safe, unbound key.
        // Reuse it on the next manual retry; only tombstoned/used keys must
        // be replaced before asking the wallet for another allowance.
        if (!await sessionKeyCanBeRequested(stored.account)) {
            assertInstantPlaySetupCurrent(canContinue);
            await keys.clear();
            assertInstantPlaySetupCurrent(canContinue);
            session = null;
        }
        quickPlayPending = false;
    }

    if (!session) {
        const created = await keys.create();
        // Host KV implementations may report a successful write while silently
        // declining persistence. Verify the mnemonic-derived account before
        // showing any allowance prompt or funding a key on-chain.
        const persisted = await keys.get();
        if (!persisted || persisted.account.h160Address.toLowerCase() !== created.account.h160Address.toLowerCase()) {
            await keys.clear().catch(() => undefined);
            throw new Error("Instant actions could not save their local key. Please try again in a supported host.");
        }
        if (!canContinue()) {
            await keys.clear().catch(() => undefined);
            throw new InstantPlaySetupCancelled();
        }
        session = persisted;
    }

    assertInstantPlaySetupCurrent(canContinue);
    quickPlayMessage = "Requesting your free instant-action allowance…";
    renderQuickPlayStatus();
    await ensureQuickPlayAllowance();
    assertInstantPlaySetupCurrent(canContinue);

    const candidate = session;
    const product = productTransactionActor();
    const requestData = encodeFunctionData({
        abi: sessionRegistryAbi,
        functionName: "requestSession",
        args: [candidate.account.h160Address],
    });
    quickPlayMessage = "Preparing instant actions…";
    renderQuickPlayStatus();
    const request = await estimatedReviveCall(sessionRegistryAddress, requestData, product);
    assertInstantPlaySetupCurrent(canContinue);
    const setup = assetHub.tx.Utility.batch_all({
        // Send PGAS to the actual AccountId32, not its unmapped H160 fallback.
        // AutoMap then creates the reverse Revive mapping needed for the
        // session key's first contract call. This batch is paid in PGAS as a
        // normal asset-fee transaction (below), rather than the pure-Revive
        // fee path used by game actions.
        calls: [
            assetHub.tx.Assets.transfer({
                id: PGAS_ASSET_ID,
                target: { type: "Id", value: sessionChainAddress(candidate.account) },
                amount: SESSION_PGAS_BUDGET,
            }).decodedCall,
            request.decodedCall,
        ],
    });

    quickPlayMessage = "Confirm once to turn on instant actions…";
    renderQuickPlayStatus();
    try {
        await submitStandaloneTx(setup, product, { asset: pgasFeeAssetLocation() });
        quickPlayPending = true;
        assertInstantPlaySetupCurrent(canContinue);
        await activatePendingQuickPlay(candidate.account, canContinue);
    } catch (error) {
        if (error instanceof InstantPlaySetupCancelled) throw error;
        // A watch timeout can occur after inclusion. Preserve the key either
        // way; when the chain can confirm the pending request, also expose the
        // explicit cancel/retry controls immediately.
        if (await waitForSessionRegistration(candidate.account)) {
            sessionAccount = candidate.account;
            instantPlayFallback = false;
            quickPlayPending = false;
            clearInstantPlayFailure();
            quickPlayMessage = "Instant actions are ready.";
            return;
        }
        quickPlayPending = await waitForSessionActivationPending(candidate.account);
        throw error;
    } finally {
        renderQuickPlayStatus();
    }
}

function enableQuickPlay(canContinue: InstantPlaySetupGuard = alwaysContinueInstantPlaySetup): Promise<void> {
    if (quickPlaySetup) return quickPlaySetup;
    quickPlaySetup = setupQuickPlay(canContinue).finally(() => {
        quickPlaySetup = null;
    });
    return quickPlaySetup;
}

function instantPlayUsesManualSigning(error: unknown): boolean {
    if (error instanceof InstantPlayAllowanceError) {
        return error.outcome === "Rejected" || error.outcome === "NotAvailable";
    }
    // Wallet hosts do not share one error class for an explicitly dismissed
    // approval. Treat the common cancellation text as an opt-out rather than
    // opening the same modal again on the next lobby.
    return /\b(reject(?:ed|ion)?|cancel(?:led|ed)?|declin(?:ed|e)|denied|dismissed)\b/i.test(txError(error));
}

/**
 * Default path after entering a party: reuse a live session silently, or make
 * one non-blocking enrollment attempt. Any failure leaves `sessionAccount`
 * empty, which routes every game action to the normal product signer.
 */
function instantPlayRequestIsCurrent(request: { gameSession: number }): boolean {
    return gameId !== null && gameSession === request.gameSession;
}

async function ensureDefaultInstantPlay(
    request: { gameSession: number; force: boolean },
): Promise<void> {
    if (!sessionRegistry || !sessionRegistryConfigured() || !productAccount) return;
    const canContinue = () => instantPlayRequestIsCurrent(request);
    await hydrateQuickPlay();
    if (!canContinue()) return;
    if (sessionAccount) {
        try {
            if (await sessionIsRegistered(sessionAccount)) {
                if (!canContinue()) return;
                instantPlayFallback = false;
                return;
            }
        } catch {
            // A failed on-chain check must not create a new allowance prompt.
            // Normal signing remains available, and the next game can retry
            // the passive verification before it considers a new setup.
            if (!canContinue()) return;
            sessionAccount = null;
            instantPlayFallback = true;
            quickPlayMessage = "Instant actions couldn’t be checked — you’ll approve each move.";
            renderQuickPlayStatus();
            return;
        }
        if (!canContinue()) return;
        // Keep the key until setup can determine whether it was tombstoned;
        // a fire-and-forget clear here could race a new enrollment.
        sessionAccount = null;
        quickPlayPending = false;
    }
    if (quickPlaySetup) return;

    const preference = await loadInstantPlayPreference();
    if (!canContinue()) return;
    // A persisted transient cooldown can expire while this tab remains open.
    // An in-memory-only failure stays blocked for the visit, because we have
    // no durable signal that it is safe to surface the host prompt again.
    const inMemoryAttemptStillBlocked = automaticInstantPlayAttempted && preference?.retryAfter === undefined;
    if (!request.force && (!automaticInstantPlayAllowed(preference) || inMemoryAttemptStillBlocked)) {
        instantPlayFallback = true;
        quickPlayMessage = preference?.mode === "manual"
            ? "You’ll approve each move."
            : "Instant actions are unavailable right now — you’ll approve each move.";
        renderQuickPlayStatus();
        return;
    }

    automaticInstantPlayAttempted = true;
    instantPlayFallback = false;
    clearInstantPlayFailure();
    quickPlayMessage = "Setting up instant actions…";
    renderQuickPlayStatus();
    try {
        await enableQuickPlay(canContinue);
        if (!canContinue()) return;
        if (sessionAccount) {
            automaticInstantPlayAttempted = false;
            await saveInstantPlayPreference(null);
        }
    } catch (error) {
        if (error instanceof InstantPlaySetupCancelled) {
            // A later lobby gets its own fresh, single setup attempt.
            automaticInstantPlayAttempted = false;
            return;
        }
        rememberInstantPlayFailure(error);
        const useManualSigning = instantPlayUsesManualSigning(error);
        if (!canContinue() && !useManualSigning) {
            automaticInstantPlayAttempted = false;
            return;
        }
        if (quickPlayPending) {
            // The product-approved batch landed. A later retry will use the
            // stored pending key and only repeat its silent activation call,
            // never the allowance request or product-signed setup batch.
            instantPlayFallback = true;
            quickPlayMessage = "Instant actions couldn’t finish — you’ll approve each move for now.";
            console.warn("instant action activation is still pending", error);
        } else {
            instantPlayFallback = true;
            await saveInstantPlayPreference(
                useManualSigning ? { mode: "manual" } : temporaryInstantPlayFailure(),
            );
            quickPlayMessage = useManualSigning
                ? "You’ll approve each move."
                : "Instant actions are unavailable right now — you’ll approve each move.";
            console.warn("instant action setup fell back to normal signing", error);
        }
    } finally {
        if (canContinue()) renderQuickPlayStatus();
    }
}

function startDefaultInstantPlay(force = false): void {
    if (gameId === null) return;
    const request = { gameSession, force };
    if (automaticInstantPlaySetup || quickPlaySetup) {
        pendingInstantPlayRequest = request;
        return;
    }
    if (pendingInstantPlayRequest?.gameSession === request.gameSession) {
        pendingInstantPlayRequest = null;
    }
    automaticInstantPlaySetup = ensureDefaultInstantPlay(request).catch((error) => {
        // This must never break the party flow. Known setup failures are
        // handled above; retain a log for an unexpected host integration bug.
        console.warn("instant action setup stopped unexpectedly", error);
    }).finally(() => {
        automaticInstantPlaySetup = null;
        const queued = pendingInstantPlayRequest;
        pendingInstantPlayRequest = null;
        if (queued && instantPlayRequestIsCurrent(queued)) startDefaultInstantPlay(queued.force);
    });
}

async function endQuickPlay(): Promise<void> {
    if (!sessionRegistry || !sessionKeyManager) return;
    const stored = sessionAccount ?? (await sessionKeyManager.get())?.account;
    if (!stored) return;
    const session = sessionTransactionActor(stored);
    quickPlayMessage = "Turning off instant actions…";
    renderQuickPlayStatus();

    const balance = await pgasBalance(session.address);
    const drainable = balance > SESSION_DRAIN_FEE_RESERVE ? balance - SESSION_DRAIN_FEE_RESERVE : 0n;
    if (drainable > 0n) {
        const drainData = encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [productTransactionActor().h160 as `0x${string}`, drainable],
        });
        await submitStandaloneTx(await estimatedReviveCall(PGAS_ERC20_PRECOMPILE, drainData, session), session);
    }

    quickPlayMessage = "Confirm turning off instant actions…";
    renderQuickPlayStatus();
    try {
        await sendTx(sessionRegistry, "revokeSession");
    } catch (error) {
        // An expiry has already stopped the key from acting. Clearing its
        // local mnemonic remains safe if the registry reports no live link.
        if (!txError(error).includes("NoActiveSession")) throw error;
    }
    await sessionKeyManager.clear();
    sessionAccount = null;
    quickPlayPending = false;
    automaticInstantPlayAttempted = true;
    instantPlayFallback = true;
    await saveInstantPlayPreference({ mode: "manual" });
    quickPlayMessage = "You’ll approve each move.";
    renderQuickPlayStatus();
}

// ── Registry content lookups (cached) ────────────────────────────────

/** Pack IDs are local to a registry, so every immutable-content cache is scoped. */
function registryCacheScope(): string {
    return activeContracts.registry?.toLowerCase() ?? "unconfigured-registry";
}

function registryPackCacheKey(packId: number, scope = registryCacheScope()): string {
    return `${scope}:${packId}`;
}

function registryQuestionCacheKey(packId: number, slot: number, scope = registryCacheScope()): string {
    return `${registryPackCacheKey(packId, scope)}:${slot}`;
}

async function questionText(packId: number, slot: number): Promise<string> {
    const key = registryQuestionCacheKey(packId, slot);
    const cached = questionCache.get(key);
    if (cached !== undefined) return cached;
    const pending = questionRequests.get(key);
    if (pending) return pending;
    const registryAtRequest = registry;
    const request = withTimeout(
        retryChainRead<any>(() => registryAtRequest.getQuestion.query(packId, slot)),
        REGISTRY_CONTENT_READ_TIMEOUT_MS,
        "Timed out loading this question.",
    ).then((res) => {
        if (!res.success) return "";
        const text = res.value as string;
        questionCache.set(key, text);
        return text;
    }).catch(() => "").finally(() => questionRequests.delete(key));
    questionRequests.set(key, request);
    return request;
}

async function canonicalAnswer(packId: number, slot: number): Promise<string> {
    const key = registryQuestionCacheKey(packId, slot);
    const cached = answerCache.get(key);
    if (cached !== undefined) return cached;
    const pending = answerRequests.get(key);
    if (pending) return pending;
    const registryAtRequest = registry;
    const request = withTimeout(
        retryChainRead<any>(() => registryAtRequest.getAnswers.query(packId, slot)),
        REGISTRY_CONTENT_READ_TIMEOUT_MS,
        "Timed out loading this answer.",
    ).then((res) => {
        if (!res.success) return "";
        const answers = res.value as string[];
        const canonical = answers[0] ?? "";
        answerCache.set(key, canonical);
        return canonical;
    }).catch(() => "").finally(() => answerRequests.delete(key));
    answerRequests.set(key, request);
    return request;
}

async function packTitle(packId: number): Promise<string> {
    const key = registryPackCacheKey(packId);
    const sealedPack = sealedPackCache.get(key);
    if (sealedPack) return sealedPack.title;
    const cached = packTitleCache.get(key);
    if (cached !== undefined) return cached;
    const pending = packTitleRequests.get(key);
    if (pending) return pending;
    const registryAtRequest = registry;
    const request = (async () => {
        const res = await retryChainRead<any>(() => registryAtRequest.getPack.query(packId));
        if (!res.success) return "Quiz pack";
        const pack = res.value as PackView;
        if (pack.sealed) sealedPackCache.set(key, pack);
        const title = pack.title;
        packTitleCache.set(key, title);
        return title;
    })().finally(() => packTitleRequests.delete(key));
    packTitleRequests.set(key, request);
    return request;
}

/** Fetch catalog cards in bounded batches from the active registry. */
async function sealedPacks(
    packIds: readonly number[],
    registryAtRequest = registry,
    scope = registryCacheScope(),
): Promise<(PackView | null)[]> {
    const byId = new Map<number, PackView | null>();
    const uncached: number[] = [];
    for (const packId of packIds) {
        const cached = sealedPackCache.get(registryPackCacheKey(packId, scope));
        if (cached) byId.set(packId, cached);
        else if (!byId.has(packId)) uncached.push(packId);
    }

    if (uncached.length > 0) {
        const batches = Array.from(
            { length: Math.ceil(uncached.length / PACK_VIEW_BATCH_SIZE) },
            (_, index) => uncached.slice(index * PACK_VIEW_BATCH_SIZE, (index + 1) * PACK_VIEW_BATCH_SIZE),
        );
        const responses = await mapWithConcurrency(batches, 3, async (batch) => {
            try {
                const result = await retryChainRead<any>(() => registryAtRequest.getPacks.query(batch));
                return result.success ? result.value as PackView[] : null;
            } catch {
                return null;
            }
        });
        for (let index = 0; index < batches.length; index += 1) {
            const batch = batches[index];
            const views = responses[index];
            if (views === null || views.length !== batch.length) continue;
            for (let viewIndex = 0; viewIndex < batch.length; viewIndex += 1) {
                const packId = batch[viewIndex];
                const view = views[viewIndex];
                if (view?.sealed) {
                    const key = registryPackCacheKey(packId, scope);
                    sealedPackCache.set(key, view);
                    packTitleCache.set(key, view.title);
                    byId.set(packId, view);
                } else {
                    byId.set(packId, null);
                }
            }
        }
    }

    // A failed batch maps to an unavailable card rather than falling back to
    // dozens of individual RPCs. The next catalog refresh retries it.
    for (const packId of uncached) {
        if (!byId.has(packId)) byId.set(packId, null);
    }
    return packIds.map((packId) => byId.get(packId) ?? null);
}

/**
 * The settings screen re-renders on every live-game poll. Coalesce its
 * cosmetic pack lookup and briefly back off after an unavailable registry so
 * opening settings never turns into a request per block.
 */
function gameSettingsPack(packId: number): Promise<PackView | null> {
    const key = registryPackCacheKey(packId);
    const cached = sealedPackCache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = gameSettingsPackRequests.get(key);
    if (pending) return pending;
    if ((gameSettingsPackRetryAfter.get(key) ?? 0) > Date.now()) return Promise.resolve(null);

    const request = sealedPacks([packId])
        .then(([pack]) => {
            if (pack) gameSettingsPackRetryAfter.delete(key);
            else gameSettingsPackRetryAfter.set(key, Date.now() + GAME_SETTINGS_PACK_RETRY_MS);
            return pack;
        })
        .catch(() => {
            gameSettingsPackRetryAfter.set(key, Date.now() + GAME_SETTINGS_PACK_RETRY_MS);
            return null;
        })
        .finally(() => gameSettingsPackRequests.delete(key));
    gameSettingsPackRequests.set(key, request);
    return request;
}

// ── Boot ─────────────────────────────────────────────────────────────

function createContractHandles(client: any, descriptor: any): void {
    if (
        !isContractAddress(activeContracts.registry)
        || !isContractAddress(activeContracts.game)
        || !isContractAddress(activeContracts.sessionRegistry)
        || !isContractAddress(activeContracts.packSignals)
    ) {
        throw new Error("Contract addresses are not configured.");
    }
    if (!productAccount) {
        throw new Error("Product account is not ready.");
    }
    // A SignerManager may have a primary account selected that is different
    // from the app-scoped product account. Keep every dry-run and transaction
    // rooted in the account we just mapped for this product.
    const accountOptions = {
        defaultOrigin: productAccount.address,
        defaultSigner: productAccount.getSigner(),
    };
    registry = createContractFromClient(
        client.raw.assetHub,
        descriptor,
        activeContracts.registry,
        registryAbi as never,
        accountOptions,
    );
    game = createContractFromClient(
        client.raw.assetHub,
        descriptor,
        activeContracts.game,
        gameAbi as never,
        accountOptions,
    );
    const sessionRegistryAddress = activeContracts.sessionRegistry;
    sessionRegistry = isContractAddress(sessionRegistryAddress)
        ? createContractFromClient(
            client.raw.assetHub,
            descriptor,
            sessionRegistryAddress,
            sessionRegistryAbi as never,
            accountOptions,
        )
        : null;
    const packSignalsAddress = activeContracts.packSignals;
    packSignals = isContractAddress(packSignalsAddress)
        ? createContractFromClient(
            client.raw.assetHub,
            descriptor,
            packSignalsAddress,
            packSignalsAbi as never,
            accountOptions,
        )
        : null;
}

type ContractTopologyStatus = "linked" | "mismatch" | "unavailable";

async function verifyActiveContractTopology(): Promise<ContractTopologyStatus> {
    try {
        // Linkage reads are independent; don't serialize boot on them.
        const [linkedRegistry, linkedSessionRegistry, signalsRegistry, signalsSessionRegistry] = await Promise.all([
            retryChainRead<any>(() => game.registry.query()),
            retryChainRead<any>(() => game.sessionRegistry.query()),
            retryChainRead<any>(() => packSignals.registry.query()),
            retryChainRead<any>(() => packSignals.sessionRegistry.query()),
        ]);
        if (!linkedRegistry.success || !linkedSessionRegistry.success || !signalsRegistry.success || !signalsSessionRegistry.success) {
            return "unavailable";
        }
        if (String(linkedRegistry.value).toLowerCase() !== activeContracts.registry?.toLowerCase()) return "mismatch";
        if (String(linkedSessionRegistry.value).toLowerCase() !== activeContracts.sessionRegistry?.toLowerCase()) return "mismatch";
        if (String(signalsRegistry.value).toLowerCase() !== activeContracts.registry?.toLowerCase()) return "mismatch";
        return String(signalsSessionRegistry.value).toLowerCase() === activeContracts.sessionRegistry?.toLowerCase()
            ? "linked"
            : "mismatch";
    } catch {
        return "unavailable";
    }
}

async function init(): Promise<void> {
    const bootStartMark = performanceMark("boot:start");
    showScreen("boot");
    setBootHeadline("Setting up your game night…");
    if (
        !isContractAddress(activeContracts.registry)
        || !isContractAddress(activeContracts.game)
        || !sessionRegistryConfigured()
        || !packSignalsConfigured()
    ) {
        setConnectionStatus("not connected", "err");
        setBootHeadline("This build isn’t set up yet.", true);
        bootLog("Contract addresses not configured.", "err");
        bootLog("Run `pnpm deploy:contract` and rebuild.", "err");
        return;
    }

    // Runtime metadata is independent of the signer prompt. Start loading it
    // now so the often-expensive descriptor parse overlaps the account flow.
    const descriptorStartMark = performanceMark("descriptor:start");
    const descriptorReady = import("@parity/product-sdk-descriptors/paseo-asset-hub");
    // Keep an early import failure handled until the boot flow reaches it,
    // avoiding an unhandled-rejection warning while a signer prompt is open.
    void descriptorReady.catch(() => undefined);

    bootLog("Connecting signer…");
    const connectRes = await manager.connect();
    if (!connectRes.ok) {
        setConnectionStatus("not connected", "err");
        setBootHeadline("Couldn’t connect — check your connection and reload.", true);
        bootLog(`Signer connect failed: ${connectRes.error.message}`, "err");
        return;
    }
    bootLog("Signer connected", "ok");
    const signerConnectedMark = performanceMark("signer:connected");
    performanceMeasure("signer:connect", bootStartMark, signerConnectedMark);

    bootLog("Requesting product account quizzler.dot/0…");
    const productRes = await manager.getProductAccount("quizzler.dot", 0);
    if (!productRes.ok) {
        setConnectionStatus("not connected", "err");
        setBootHeadline("Couldn’t set up your account — reload to try again.", true);
        bootLog(`getProductAccount failed: ${productRes.error.message}`, "err");
        return;
    }
    productAccount = productRes.value;
    myAddress = ss58ToH160(productAccount.address).toLowerCase();
    // Begin restoring the durable recovery list in parallel with the chain
    // setup. The host-backed read is small and must never delay signing.
    const knownGamesReady = hydrateKnownGames();
    bootLog("Player account ready", "ok");

    bootLog("Opening chain client…");
    const { paseo_asset_hub } = await descriptorReady;
    const descriptorReadyMark = performanceMark("descriptor:ready");
    performanceMeasure("descriptor:load", descriptorStartMark, descriptorReadyMark);
    const client = await createChainClient({ chains: { assetHub: paseo_asset_hub } });
    assetHub = client.assetHub;
    unsafeAssetHub = client.raw.assetHub.getUnsafeApi();
    bestBlocks = client.raw.assetHub.bestBlocks$;
    subscribeChainStatus();
    bootLog("Chain client ready", "ok");
    const chainReadyMark = performanceMark("chain:ready");
    performanceMeasure("chain:open", descriptorReadyMark, chainReadyMark);

    // One-time SS58 → H160 mapping required by pallet-revive for .tx().
    // It must happen before any product-account contract dry-run, including
    // the pair check immediately below. Idempotent: costs one signature the
    // first time, free afterwards.
    try {
        bootLog("Ensuring account is mapped on pallet-revive…");
        const runtime = createContractRuntimeFromClient(client.raw.assetHub, paseo_asset_hub);
        const mapped = await ensureContractAccountMapped(
            runtime,
            productAccount.address,
            productAccount.getSigner(),
        );
        bootLog(mapped === null ? "Account already mapped" : "Account mapped", "ok");
    } catch (e) {
        setConnectionStatus("not connected", "err");
        setBootHeadline("Couldn’t finish setting up — reload to try again.", true);
        bootLog(`Account mapping failed: ${txError(e)}`, "err");
        return;
    }

    createContractHandles(client, paseo_asset_hub);
    bootLog("Contract handles ready (registry + signals + game + sessions)", "ok");

    const contractTopologyStatus = await verifyActiveContractTopology();
    if (contractTopologyStatus !== "linked") {
        setConnectionStatus("not connected", "err");
        if (contractTopologyStatus === "mismatch") {
            setBootHeadline("Couldn’t start — try reloading.", true);
            bootLog("contract mismatch: the deployed contracts are not linked to the same catalog.", "err");
        } else {
            setBootHeadline("Couldn’t reach the game — try reloading.", true);
            bootLog("Couldn’t verify the game connection. Try reloading.", "err");
        }
        return;
    }

    await knownGamesReady;

    // A profile read is independent of resuming a game. Start it now so the
    // home form reflects the saved on-chain name without delaying a returning
    // player's game recovery.
    syncDisplayNameProfile();
    void hydrateDisplayName();

    // Sealed packs are immutable. Restore their last known metadata for an
    // instant picker on a return visit, then reconcile the editorial picks in
    // the background. Full decentralized discovery starts only on demand.
    hydratePackCatalogCache();
    void refreshPacks();

    // A remembered room is trusted only after its on-chain roster and live
    // status are checked. Storage trouble never blocks normal party play.
    if (sessionRegistry) void hydrateQuickPlay();

    // Prime the best-block nonce without holding up the home screen. It is
    // shared with the first action if the player gets there before it returns.
    void syncTxNonce(productTransactionActor());

    setConnectionStatus("connected", "ok");
    const resume = await resumeMostRecentKnownGame();
    if (resume === "resumed") return;
    // A saved active room takes precedence over a recovery marker. If its
    // status is temporarily unavailable, do not risk opening another table.
    const pendingCreation = resume === "unavailable"
        ? "none"
        : await resumePendingGameCreation();
    if (pendingCreation === "resumed") return;
    let inviteError = "";
    if (pendingCreation === "unavailable") {
        inviteError = "Your new lobby is still being confirmed. Reload in a moment to reopen it.";
    } else if (sharedLobbyInvite.present) {
        if (sharedLobbyInvite.gameId === null) {
            inviteError = "This invite link doesn’t contain a valid six-digit game code.";
        } else if (knownGames.length === 0) {
            $joinGameId.value = sharedLobbyInvite.gameId.toString();
            bootLog(`Joining shared lobby ${sharedLobbyInvite.gameId}…`);
            if (await joinGameById(sharedLobbyInvite.gameId, $homeError)) return;
            // Catalog refreshes run in parallel and may clear the home error.
            // Save it until the home screen is ready to show it.
            inviteError = $homeError.textContent || "Couldn’t join this shared lobby.";
        }
    }
    showScreen("home");
    const homeReadyMark = performanceMark("home:shown");
    performanceMeasure("boot:to-home", appStartMark, homeReadyMark);
    renderKnownGames();
    refreshKnownGames();
    if (inviteError) {
        $homeError.textContent = inviteError;
    } else if (resume === "unavailable") {
        $homeError.textContent = "Couldn’t reopen your game yet. Try again from Your games when the connection recovers.";
    }
}

// ── Home: pack selection & game setup ─────────────────────────────────

const $packList = getEl("pack-list");
const $packSearch = getEl<HTMLInputElement>("pack-search");
const $packCatalogStatus = getEl("pack-catalog-status");
const $selectedPackSummary = getEl("selected-pack-summary");
const $homeError = getEl("home-error");
const $joinGameId = getEl<HTMLInputElement>("join-game-id");
const $packSelectionError = getEl("pack-selection-error");
const $configError = getEl("config-error");
const $btnCreateGame = getEl<HTMLButtonElement>("btn-create-game");
const $btnPackContinue = getEl<HTMLButtonElement>("btn-pack-continue");
const $questionCount = getEl("cfg-questions");
const $answerBlocks = getEl("cfg-answer-blocks");
const $reviewBlocks = getEl("cfg-review-blocks");
const $configPackArt = getEl("config-pack-art");
const $configPackTitle = getEl("config-pack-title");
const $configPackMeta = getEl("config-pack-meta");
const $yourGames = getEl("your-games");
const $yourGamesList = getEl("your-games-list");
const $displayNameCard = getEl("display-name-card");
const $homeNameGreeting = getEl("home-name-greeting");
const $homeNameDescription = getEl("home-name-description");
const $homeDisplayNameEditor = getEl("display-name-editor");
const $displayName = getEl<HTMLInputElement>("display-name");
const $displayNameStatus = getEl("display-name-status");
const $btnEditDisplayName = getEl<HTMLButtonElement>("btn-edit-display-name");
const $btnCancelDisplayName = getEl<HTMLButtonElement>("btn-cancel-display-name");
const $settingsDisplayName = getEl<HTMLInputElement>("settings-display-name");
const $settingsDisplayNameStatus = getEl("settings-display-name-status");
const $instantPlayCard = getEl("instant-play-card");
const $instantPlayStatus = getEl("instant-play-status");
const $instantPlayError = getEl("instant-play-error");
const $btnTurnOffInstantPlay = getEl<HTMLButtonElement>("btn-turn-off-instant-play");
const $lobbyInstantPlay = getEl("lobby-instant-play");
const $lobbyInstantPlayStatus = getEl("lobby-instant-play-status");
const $lobbyInstantPlayError = getEl("lobby-instant-play-error");
const $btnRetryInstantPlay = getEl<HTMLButtonElement>("btn-retry-instant-play");
const $settingsInstantPlay = getEl("settings-instant-play");
const $settingsInstantPlayStatus = getEl("settings-instant-play-status");
const $settingsInstantPlayError = getEl("settings-instant-play-error");
const $btnSettingsRetryInstantPlay = getEl<HTMLButtonElement>("btn-settings-retry-instant-play");
const $btnSettingsTurnOffInstantPlay = getEl<HTMLButtonElement>("btn-settings-turn-off-instant-play");
const displayNameDraftInputs = new Set<HTMLInputElement>();
let displayNameFeedback: { message: string; error: boolean } | null = null;
let homeDisplayNameEditorOpen = false;

function displayNameDefaultStatus(_fallback: string): string {
    // The welcome card already shows the generated or saved name. Reserve the
    // status line for useful feedback such as saving and validation errors.
    return "";
}

function setDisplayNameStatus(message: string, error = false): void {
    for (const status of [$displayNameStatus, $settingsDisplayNameStatus]) {
        status.textContent = message;
        status.classList.toggle("is-error", error);
        status.setAttribute("role", error ? "alert" : "status");
    }
}

function setDisplayNameFeedback(message: string, error = false): void {
    displayNameFeedback = { message, error };
    setDisplayNameStatus(message, error);
}

function syncDisplayNameProfile(): void {
    if (!myAddress) return;
    const fallback = generatedPlayerName(myAddress);
    const hasCustomName = myDisplayName.length > 0;
    const visibleName = playerName(myAddress, myDisplayName);

    $homeNameGreeting.textContent = `Welcome, ${visibleName}`;
    $homeNameDescription.textContent = hasCustomName
        ? "Tap your name whenever you want to change it."
        : "This is your name in the game. Tap it to edit.";
    $displayNameCard.classList.toggle("has-custom-name", hasCustomName);
    $displayNameCard.classList.toggle("uses-generated-name", !hasCustomName);
    $btnEditDisplayName.setAttribute("aria-label", `Edit your player name: ${visibleName}`);
    $btnEditDisplayName.title = "Edit your player name";
    $btnEditDisplayName.setAttribute("aria-expanded", String(homeDisplayNameEditorOpen));
    $homeDisplayNameEditor.hidden = !homeDisplayNameEditorOpen;

    for (const input of [$displayName, $settingsDisplayName]) {
        input.placeholder = fallback;
        // A live snapshot may arrive while the player is editing their name.
        // Do not overwrite that field's unsaved text just because a polling
        // read completes.
        if (!displayNameDraftInputs.has(input)) input.value = myDisplayName;
    }
    const feedback = displayNameFeedback;
    setDisplayNameStatus(
        feedback?.message ?? displayNameDefaultStatus(fallback),
        feedback?.error ?? false,
    );
}

function openHomeDisplayNameEditor(): void {
    homeDisplayNameEditorOpen = true;
    syncDisplayNameProfile();
    requestAnimationFrame(() => $displayName.focus());
}

function closeHomeDisplayNameEditor(): void {
    homeDisplayNameEditorOpen = false;
    displayNameDraftInputs.delete($displayName);
    displayNameFeedback = null;
    syncDisplayNameProfile();
}

function applyOnChainDisplayName(name: string, observedRevision: number): void {
    if (observedRevision !== displayNameRevision) return;
    if (pendingDisplayName !== null) {
        if (name !== pendingDisplayName) return;
        pendingDisplayName = null;
    }
    if (name === myDisplayName) return;
    myDisplayName = name;
    displayNameRevision += 1;
    syncDisplayNameProfile();
}

function applyMyDisplayNameToLatest(): void {
    if (latest === null) return;
    const index = latest.players.findIndex((player) => player.toLowerCase() === myAddress);
    if (index < 0) return;
    const playerNames = [...latest.playerNames];
    playerNames[index] = myDisplayName;
    latest = {
        ...latest,
        playerNames,
        playerLabels: resolvePlayerLabels(latest.players, playerNames),
    };
    render(latest);
}

async function hydrateDisplayName(): Promise<void> {
    if (!productAccount || !myAddress) return;
    const observedRevision = displayNameRevision;
    try {
        const result = await retryChainRead<any>(() => game.getDisplayName.query(myAddress, {
            origin: productAccount!.address,
        }));
        if (!result.success) return;
        applyOnChainDisplayName(String(result.value).trim(), observedRevision);
    } catch {
        // The party game remains usable with its generated identity when this
        // optional profile read is temporarily unavailable.
    }
}

function renderQuickPlayStatus(): void {
    const configured = sessionRegistryConfigured();
    const enabled = sessionAccount !== null;
    const pending = !enabled && quickPlayPending;
    // Pending is a factual on-chain state, not a spinner. Keeping it separate
    // from in-flight work makes a failed activation readable and retryable.
    const settingUp = quickPlaySetup !== null || automaticInstantPlaySetup !== null;
    renderSettingsInstantPlayStatus(configured, enabled, pending, settingUp);
    $instantPlayCard.style.display = configured && enabled ? "" : "none";
    if (!configured) {
        $lobbyInstantPlay.style.display = "none";
        return;
    }

    $instantPlayStatus.textContent = "Instant actions are on — game moves don’t need approvals. Turning them off applies everywhere you play with this account.";
    $btnTurnOffInstantPlay.disabled = busy;

    const inLobby = visibleScreen === "lobby";
    const showLobbyStatus = inLobby && !enabled;
    $lobbyInstantPlay.style.display = showLobbyStatus ? "" : "none";
    if (!showLobbyStatus) return;

    $lobbyInstantPlayStatus.textContent = settingUp
        ? quickPlayMessage || "Setting up instant actions…"
        : quickPlayMessage || "You’ll approve each move.";
    $lobbyInstantPlayError.textContent = instantPlayFailureDetail;
    const canRetry = !settingUp && (instantPlayFallback || pending);
    $btnRetryInstantPlay.style.display = canRetry ? "" : "none";
    $btnRetryInstantPlay.disabled = !canRetry || busy;
    $btnRetryInstantPlay.textContent = pending ? "Finish instant actions" : "Try instant actions";
}

function renderSettingsInstantPlayStatus(
    configured: boolean,
    enabled: boolean,
    pending: boolean,
    settingUp: boolean,
): void {
    const showingSettings = visibleScreen === "game-settings";
    $settingsInstantPlay.style.display = configured && showingSettings ? "" : "none";
    if (!configured || !showingSettings) return;

    $settingsInstantPlayStatus.textContent = enabled
        ? "Instant actions are on — game moves don’t need approvals."
        : settingUp
          ? quickPlayMessage || "Setting up instant actions…"
          : quickPlayMessage || "You’ll approve each move.";
    $settingsInstantPlayError.textContent = instantPlayFailureDetail;
    $btnSettingsRetryInstantPlay.style.display = enabled ? "none" : "";
    $btnSettingsRetryInstantPlay.disabled = settingUp || busy;
    $btnSettingsRetryInstantPlay.textContent = pending ? "Finish instant actions" : "Try instant actions";
    $btnSettingsTurnOffInstantPlay.style.display = enabled ? "" : "none";
    $btnSettingsTurnOffInstantPlay.disabled = busy;
}

function retryInstantPlay(): void {
    if (busy || quickPlaySetup || automaticInstantPlaySetup) return;
    automaticInstantPlayAttempted = false;
    instantPlayFallback = false;
    clearInstantPlayFailure();
    quickPlayMessage = "Retrying instant actions…";
    // A forced retry bypasses the preference either way. Save it in the
    // background so storage latency never makes the button appear inert.
    void saveInstantPlayPreference(null);
    startDefaultInstantPlay(true);
    renderQuickPlayStatus();
}

$btnRetryInstantPlay.addEventListener("click", retryInstantPlay);
$btnSettingsRetryInstantPlay.addEventListener("click", retryInstantPlay);

async function turnOffInstantPlay(
    buttonId: "btn-turn-off-instant-play" | "btn-settings-turn-off-instant-play",
    error: HTMLElement,
): Promise<void> {
    if (busy || !sessionAccount) return;
    busy = true;
    error.textContent = "";
    setLoading(buttonId, true);
    renderQuickPlayStatus();
    try {
        await endQuickPlay();
    } catch (cause) {
        error.textContent = friendlyError(cause);
    } finally {
        busy = false;
        setLoading(buttonId, false);
        renderQuickPlayStatus();
    }
}

$btnTurnOffInstantPlay.addEventListener("click", () => void turnOffInstantPlay(
    "btn-turn-off-instant-play",
    $instantPlayError,
));
$btnSettingsTurnOffInstantPlay.addEventListener("click", () => void turnOffInstantPlay(
    "btn-settings-turn-off-instant-play",
    $settingsInstantPlayError,
));

async function saveDisplayName(input: HTMLInputElement): Promise<void> {
    if (busy || !productAccount) return;
    const name = input.value;
    if (name !== "" && (name !== name.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(name) || utf8ByteLength(name) > 24)) {
        displayNameDraftInputs.add(input);
        setDisplayNameFeedback("Use a short, one-line name.", true);
        return;
    }
    busy = true;
    // Invalidate reads launched before the player chose this new value.
    displayNameRevision += 1;
    setDisplayNameFeedback("Saving name…");
    setLoading("btn-save-display-name", true);
    setLoading("btn-settings-save-display-name", true);
    try {
        await sendTx(game, "setDisplayName", name);
        myDisplayName = name;
        pendingDisplayName = name;
        displayNameRevision += 1;
        displayNameDraftInputs.delete(input);
        if (input === $displayName) homeDisplayNameEditorOpen = false;
        setDisplayNameFeedback(name
            ? `Saved as ${name}. Everyone in your games will see it.`
            : `Name cleared. You’ll appear as ${generatedPlayerName(myAddress)}.`);
        syncDisplayNameProfile();
        applyMyDisplayNameToLatest();
    } catch (error) {
        displayNameDraftInputs.add(input);
        setDisplayNameFeedback(friendlyError(error), true);
        syncDisplayNameProfile();
    } finally {
        busy = false;
        setLoading("btn-save-display-name", false);
        setLoading("btn-settings-save-display-name", false);
    }
}

getEl<HTMLButtonElement>("btn-save-display-name").addEventListener("click", () => {
    void saveDisplayName($displayName);
});
$btnEditDisplayName.addEventListener("click", openHomeDisplayNameEditor);
$btnCancelDisplayName.addEventListener("click", closeHomeDisplayNameEditor);
getEl<HTMLButtonElement>("btn-settings-save-display-name").addEventListener("click", () => {
    void saveDisplayName($settingsDisplayName);
});
for (const input of [$displayName, $settingsDisplayName]) {
    input.addEventListener("input", () => {
        displayNameDraftInputs.add(input);
        setDisplayNameFeedback("Save to use this name in your games.");
    });
    input.addEventListener("keydown", (event) => {
        if (input === $displayName && homeDisplayNameEditorOpen && event.key === "Escape") {
            event.preventDefault();
            closeHomeDisplayNameEditor();
            return;
        }
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        void saveDisplayName(input);
    });
}

// The configure screen shares one status line for progress and failures.
// Progress must never wear error styling — a freshly created lobby reading
// as a failure is worse than no message at all.
function showConfigProgress(message: string): void {
    $configError.classList.add("is-progress");
    $configError.textContent = message;
}

function showConfigError(message: string): void {
    $configError.classList.remove("is-progress");
    $configError.textContent = message;
}

type KnownGameInspection =
    | { kind: "checking" }
    | { kind: "active"; stage: number; cursor: number; questionCount: number }
    | { kind: "unavailable" };

const knownGameInspections = new Map<bigint, KnownGameInspection>();
const knownGameOpenings = new Set<bigint>();

async function inspectKnownGame(id: bigint): Promise<KnownGameInspection | "stale"> {
    if (!game || !myAddress) return { kind: "unavailable" };
    try {
        const result = await withTimeout(
            retryChainRead<any>(() => game.getLiveGame.query(id)),
            LIVE_GAME_READ_TIMEOUT_MS,
            "Timed out checking this quiz.",
        );
        if (!result.success) return { kind: "unavailable" };
        const live = result.value as LiveGameView;
        const stage = Number(live.stage);
        const players = live.players.map((player) => String(player).toLowerCase());
        const index = players.indexOf(myAddress);
        const submission = index >= 0
            ? live.submissions.find((item) => String(item.player).toLowerCase() === myAddress)
            : undefined;
        if (stage < STAGE_LOBBY || stage > STAGE_FINAL_REVIEW || index < 0 || submission?.active === false) {
            return "stale";
        }
        return {
            kind: "active",
            stage,
            cursor: Number(live.cursor),
            questionCount: Number(live.num_questions),
        };
    } catch {
        // A transient host/RPC failure is not evidence that a player left.
        return { kind: "unavailable" };
    }
}

function knownGameStatusLabel(inspection: KnownGameInspection | undefined): string {
    if (!inspection || inspection.kind === "checking") return "Checking game…";
    if (inspection.kind === "unavailable") return "Couldn’t check this game yet.";
    return gameProgressLabel(inspection.stage, inspection.cursor, inspection.questionCount);
}

function renderKnownGames(): void {
    const show = gameId === null && knownGames.length > 0;
    $yourGames.style.display = show ? "" : "none";
    if (!show) {
        $yourGamesList.replaceChildren();
        return;
    }
    renderList(
        $yourGamesList,
        knownGames.map((known) => {
            const inspection = knownGameInspections.get(known.id);
            const summary = document.createElement("span");
            summary.className = "your-game-summary";
            summary.append(
                span("your-game-code", `Game ${known.id}`),
                span("sub", knownGameStatusLabel(inspection)),
            );
            const actions = document.createElement("span");
            actions.className = "your-game-actions";
            const rejoin = document.createElement("button");
            rejoin.type = "button";
            rejoin.className = "primary";
            rejoin.dataset.testid = "btn-rejoin-game";
            rejoin.dataset.gameId = known.id.toString();
            rejoin.textContent = inspection?.kind === "unavailable" ? "Try again" : "Rejoin";
            rejoin.disabled = inspection?.kind === "checking" || knownGameOpenings.has(known.id);
            rejoin.addEventListener("click", () => void reopenKnownGame(known.id));
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "quiet";
            remove.dataset.testid = "btn-remove-known-game";
            remove.dataset.gameId = known.id.toString();
            remove.textContent = "Remove";
            remove.setAttribute("aria-label", `Remove game ${known.id} from this device`);
            remove.disabled = knownGameOpenings.has(known.id);
            remove.addEventListener("click", () => forgetKnownGame(known.id));
            actions.append(rejoin, remove);
            const row = li(summary, actions);
            row.className = "your-game-row";
            return row;
        }),
    );
}

function refreshKnownGames(): void {
    if (!game || !myAddress || gameId !== null || knownGames.length === 0) return;
    const records = [...knownGames];
    for (const known of records) knownGameInspections.set(known.id, { kind: "checking" });
    renderKnownGames();
    void Promise.all(records.map(async (known) => {
        const inspection = await inspectKnownGame(known.id);
        // The player may have removed it while the lookup was in flight.
        if (!knownGames.some((current) => current.id === known.id)) return;
        if (inspection === "stale") {
            forgetKnownGame(known.id);
            return;
        }
        knownGameInspections.set(known.id, inspection);
        renderKnownGames();
    }));
}

async function reopenKnownGame(id: bigint): Promise<boolean> {
    if (gameId !== null || knownGameOpenings.has(id)) return false;
    knownGameOpenings.add(id);
    renderKnownGames();
    try {
        const inspection = await inspectKnownGame(id);
        if (inspection === "stale") {
            forgetKnownGame(id);
            $homeError.textContent = "That game is no longer available to rejoin.";
            return false;
        }
        knownGameInspections.set(id, inspection);
        if (inspection.kind === "unavailable") {
            $homeError.textContent = "Couldn’t reopen that game yet. Try again when the connection recovers.";
            return false;
        }
        enterGame(id);
        return true;
    } finally {
        knownGameOpenings.delete(id);
        if (gameId === null) renderKnownGames();
    }
}

interface ConfigChoiceOption {
    value: number;
    label: string;
    detail?: string;
}

let selectedQuestionCount = Math.min(5, MAX_GAME_QUESTIONS);
let selectedAnswerBlocks = 30;
let selectedReviewBlocks = 18;

function onGameConfigChoiceChanged(): void {
    $configError.textContent = "";
    preparedGameCreationNonce = null;
    scheduleCreateGamePreflight();
}

function renderConfigChoices(
    container: HTMLElement,
    name: string,
    options: readonly ConfigChoiceOption[],
    selectedValue: number,
    onSelect: (value: number) => void,
): void {
    const choices = document.createDocumentFragment();
    for (const option of options) {
        const id = `${name}-option-${option.value}`;
        const label = document.createElement("label");
        label.className = "config-choice";
        label.dataset.testid = id;

        const input = document.createElement("input");
        input.className = "config-choice-input";
        input.id = id;
        input.name = name;
        input.type = "radio";
        input.value = String(option.value);
        input.checked = option.value === selectedValue;
        input.addEventListener("change", () => {
            if (input.checked) onSelect(option.value);
        });

        const copy = document.createElement("span");
        copy.className = "config-choice-copy";
        const title = document.createElement("strong");
        title.textContent = option.label;
        copy.append(title);
        if (option.detail) {
            const detail = document.createElement("small");
            detail.textContent = option.detail;
            copy.append(detail);
        }

        label.append(input, copy);
        choices.append(label);
    }
    container.replaceChildren(choices);
}

function renderQuestionCountOptions(maxQuestions: number): void {
    const options = questionCountOptions(maxQuestions).map((value) => ({
        value,
        label: `${value} ${value === 1 ? "question" : "questions"}`,
    }));
    if (!options.some((option) => option.value === selectedQuestionCount)) {
        const preferredValue = Math.min(5, maxQuestions);
        selectedQuestionCount = options.find((option) => option.value === preferredValue)?.value
            ?? options[0]?.value
            ?? 0;
    }
    renderConfigChoices($questionCount, "cfg-questions", options, selectedQuestionCount, (value) => {
        selectedQuestionCount = value;
        onGameConfigChoiceChanged();
    });
}

function configureGameControls(): void {
    renderConfigChoices(
        $answerBlocks,
        "cfg-answer-blocks",
        ANSWER_BLOCK_PRESETS.map((preset) => ({
            value: preset.blocks,
            label: preset.name,
            detail: presetDurationLabel(preset),
        })),
        selectedAnswerBlocks,
        (value) => {
            selectedAnswerBlocks = value;
            onGameConfigChoiceChanged();
        },
    );
    renderConfigChoices(
        $reviewBlocks,
        "cfg-review-blocks",
        REVIEW_BLOCK_PRESETS.map((preset) => ({
            value: preset.blocks,
            label: preset.name,
            detail: presetDurationLabel(preset),
        })),
        selectedReviewBlocks,
        (value) => {
            selectedReviewBlocks = value;
            onGameConfigChoiceChanged();
        },
    );
    renderQuestionCountOptions(MAX_GAME_QUESTIONS);
}

configureGameControls();

type CatalogPack = PackView & PackListItem;

interface SealedCatalogPage {
    packs: CatalogPack[];
    nextCursor: number;
}

interface FavoriteCatalogPage {
    packIds: number[];
    nextCursor: bigint;
    total: number;
}

interface PackSignalState {
    favoriteCount: number;
    favorited: boolean;
}

interface PopularEntry {
    packId: number;
    favoriteCount: number;
}

interface PopularCatalogPage {
    entries: PopularEntry[];
    nextScore: number;
    nextCursor: bigint;
    total: number;
}

type CatalogView = "library" | "browse" | "favorites" | "popular";

const SEALED_PACK_CURSOR_LATEST = 0xffff_ffff;
const NEW_PACK_PAGE_SIZE = 12;
const BROWSE_PACK_PAGE_SIZE = 24;
const SIGNAL_VIEW_BATCH_SIZE = 32;
const PACK_CATALOG_CACHE_VERSION = 2;
const PACK_CATALOG_CACHE_LIMIT = 96;

let refreshingPacks: Promise<void> | null = null;
let newPacksRefresh: Promise<void> | null = null;
let popularPacksRefresh: Promise<void> | null = null;
let favoritePacksRefresh: Promise<void> | null = null;
let browsePacksRefresh: Promise<void> | null = null;
let lastPackListSignature: string | null = null;
let catalogPacks: CatalogPack[] = [];
let newPackIds: number[] = [];
let browsePackIds: number[] = [];
let browseNextCursor = SEALED_PACK_CURSOR_LATEST;
let browseExhausted = false;
let favoritePackIds: number[] = [];
let favoriteNextCursor = 0n;
let favoriteTotal = 0;
let favoritesExhausted = false;
let popularEntries: PopularEntry[] = [];
let popularNextScore = 0;
let popularNextCursor = 0n;
let popularTotal = 0;
let popularExhausted = false;
const packSignalsById = new Map<number, PackSignalState>();
const favoriteActionsInFlight = new Set<number>();
let packSearch = "";
let catalogView: CatalogView = "library";
let starterPacksLoading = false;
let discoveryPacksLoading = false;
let discoveryRefreshRequested = false;
// E2E runs can opt in to their disposable packs without exposing them to
// players on the normal home screen.
const showE2ETestPacks = import.meta.env.VITE_SHOW_E2E_PACKS === "1"
    || new URLSearchParams(window.location.search).get("show-test-packs") === "1";

function packCatalogCacheKey(): string | null {
    return isContractAddress(activeContracts.registry)
        ? `quizzler:pack-catalog:${PACK_CATALOG_CACHE_VERSION}:${activeContracts.registry.toLowerCase()}`
        : null;
}

function isCachedCatalogPack(value: unknown): value is CatalogPack {
    if (value === null || typeof value !== "object") return false;
    const pack = value as Partial<CatalogPack>;
    return Number.isSafeInteger(pack.id)
        && (pack.id as number) >= 0
        && typeof pack.creator === "string"
        && typeof pack.title === "string"
        && typeof pack.emoji === "string"
        && Number.isSafeInteger(pack.regular_count)
        && (pack.regular_count as number) >= 0
        && Number.isSafeInteger(pack.finals_set_count)
        && (pack.finals_set_count as number) >= 0
        && pack.sealed === true;
}

/** A sealed pack is immutable, so metadata—not social state—can be cached. */
function hydratePackCatalogCache(): void {
    const key = packCatalogCacheKey();
    if (key === null) return;
    try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return;
        const cached = JSON.parse(raw) as { version?: unknown; packs?: unknown };
        if (cached.version !== PACK_CATALOG_CACHE_VERSION || !Array.isArray(cached.packs)) return;
        const byId = new Map<number, CatalogPack>();
        for (const value of cached.packs) {
            if (isCachedCatalogPack(value)) byId.set(value.id, value);
        }
        if (byId.size === 0) return;
        catalogPacks = [...byId.values()].slice(0, PACK_CATALOG_CACHE_LIMIT);
        for (const pack of catalogPacks) {
            const cacheKey = registryPackCacheKey(pack.id);
            sealedPackCache.set(cacheKey, pack);
            packTitleCache.set(cacheKey, pack.title);
        }
        renderPackList();
        performanceMark("catalog:cache-restored");
    } catch {
        // Storage is only a cache. Direct registry reads remain authoritative.
    }
}

function persistPackCatalog(): void {
    const key = packCatalogCacheKey();
    if (key === null) return;
    try {
        window.localStorage.setItem(key, JSON.stringify({
            version: PACK_CATALOG_CACHE_VERSION,
            packs: catalogPacks.filter((pack) => pack.sealed).slice(-PACK_CATALOG_CACHE_LIMIT),
        }));
    } catch {
        // Private mode and quota limits should not affect normal browsing.
    }
}

function starterPackIds(count: number): number[] {
    return Array.from({ length: Math.min(count, STARTER_PACK_COUNT) }, (_, id) => id);
}

async function mapWithConcurrency<T, U>(
    items: readonly T[],
    limit: number,
    mapper: (item: T) => Promise<U>,
): Promise<U[]> {
    const results = new Array<U>(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await mapper(items[index]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
}

function numericField(record: Record<string, unknown>, snake: string, camel = snake): number | null {
    const raw = record[snake] ?? record[camel];
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function catalogPackFromView(id: number, raw: unknown): CatalogPack | null {
    if (raw === null || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const regularCount = numericField(value, "regular_count", "regularCount");
    const finalsSetCount = numericField(value, "finals_set_count", "finalsSetCount");
    if (
        regularCount === null
        || finalsSetCount === null
        || typeof value.creator !== "string"
        || typeof value.title !== "string"
        || typeof value.emoji !== "string"
        || value.sealed !== true
    ) {
        return null;
    }
    return {
        id,
        creator: value.creator,
        title: value.title,
        emoji: value.emoji,
        regular_count: regularCount,
        finals_set_count: finalsSetCount,
        sealed: true,
    };
}

function sealedCatalogPage(raw: unknown): SealedCatalogPage | null {
    if (raw === null || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const entries = value.packs;
    const nextCursor = numericField(value, "next_cursor", "nextCursor");
    if (!Array.isArray(entries) || nextCursor === null) return null;
    const packs = entries.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const id = numericField(entry as Record<string, unknown>, "pack_id", "packId");
        const pack = id === null ? null : catalogPackFromView(id, entry);
        return pack === null ? [] : [pack];
    });
    return { packs, nextCursor };
}

function favoriteCatalogPage(raw: unknown): FavoriteCatalogPage | null {
    if (raw === null || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const rawIds = value.pack_ids ?? value.packIds;
    if (!Array.isArray(rawIds)) return null;
    const ids = rawIds.flatMap((id) => {
        const number = Number(id);
        return Number.isSafeInteger(number) && number >= 0 ? [number] : [];
    });
    const nextRaw = value.next_cursor ?? value.nextCursor;
    const total = Number(value.total);
    try {
        const nextCursor = typeof nextRaw === "bigint" ? nextRaw : BigInt(nextRaw as string | number);
        if (!Number.isSafeInteger(total) || total < 0 || nextCursor < 0n) return null;
        return { packIds: ids, nextCursor, total };
    } catch {
        return null;
    }
}

function popularCatalogPage(raw: unknown): PopularCatalogPage | null {
    if (raw === null || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const rawEntries = value.packs;
    const nextScore = numericField(value, "next_score", "nextScore");
    const nextRaw = value.next_cursor ?? value.nextCursor;
    const total = Number(value.total);
    if (!Array.isArray(rawEntries) || nextScore === null || !Number.isSafeInteger(total) || total < 0) {
        return null;
    }
    try {
        const nextCursor = typeof nextRaw === "bigint" ? nextRaw : BigInt(nextRaw as string | number);
        if (nextCursor < 0n || (nextScore === 0) !== (nextCursor === 0n)) return null;
        const entries = rawEntries.flatMap((rawEntry) => {
            if (rawEntry === null || typeof rawEntry !== "object") return [];
            const entry = rawEntry as Record<string, unknown>;
            const packId = numericField(entry, "pack_id", "packId");
            const favoriteCount = numericField(entry, "favorite_count", "favoriteCount");
            return packId === null || favoriteCount === null || favoriteCount === 0
                ? []
                : [{ packId, favoriteCount }];
        });
        return { entries, nextScore, nextCursor, total };
    } catch {
        return null;
    }
}

function mergeCatalogPacks(packs: readonly CatalogPack[]): void {
    if (packs.length === 0) return;
    const byId = new Map(catalogPacks.map((pack) => [pack.id, pack]));
    for (const pack of packs) {
        byId.set(pack.id, pack);
        const cacheKey = registryPackCacheKey(pack.id);
        sealedPackCache.set(cacheKey, pack);
        packTitleCache.set(cacheKey, pack.title);
    }
    catalogPacks = [...byId.values()];
    persistPackCatalog();
}

function catalogPacksFor(ids: readonly number[]): CatalogPack[] {
    const byId = new Map(catalogPacks.map((pack) => [pack.id, pack]));
    return ids.flatMap((id) => {
        const pack = byId.get(id);
        return pack ? [pack] : [];
    });
}

function curatedPacks(): CatalogPack[] {
    return catalogPacks
        .filter((pack) => featuredPack(pack) !== undefined)
        .sort((left, right) => featuredPack(left)!.featuredOrder! - featuredPack(right)!.featuredOrder!);
}

async function hydrateCatalogPackIds(ids: readonly number[]): Promise<void> {
    const missing = ids.filter((id) => !catalogPacks.some((pack) => pack.id === id));
    if (missing.length === 0) return;
    const packs = await sealedPacks(missing);
    mergeCatalogPacks(packs.flatMap((pack, index) => pack === null ? [] : [{ id: missing[index], ...pack }]));
}

async function refreshStarterPacks(): Promise<void> {
    const startMark = performanceMark("catalog:starters:start");
    const registryAtRequest = registry;
    const countRes = await registryAtRequest.packCount.query();
    if (!countRes.success) throw new Error("pack count query failed");
    const ids = starterPackIds(Number(countRes.value));
    const packs = await sealedPacks(ids, registryAtRequest, registryCacheScope());
    mergeCatalogPacks(packs.flatMap((pack, index) => pack === null ? [] : [{ id: ids[index], ...pack }]));
    performanceMeasure("catalog:starters", startMark, performanceMark("catalog:starters:ready"));
}

async function refreshNewPacks(): Promise<void> {
    const registryAtRequest = registry;
    const result = await retryChainRead<any>(() => registryAtRequest.getSealedPacks.query(
        SEALED_PACK_CURSOR_LATEST,
        NEW_PACK_PAGE_SIZE,
    ));
    if (!result.success) throw new Error("new packs query failed");
    const page = sealedCatalogPage(result.value);
    if (page === null) throw new Error("new packs response was invalid");
    mergeCatalogPacks(page.packs);
    newPackIds = page.packs.map((pack) => pack.id);
}

async function loadBrowsePacks(reset = false): Promise<void> {
    if (browsePacksRefresh) return browsePacksRefresh;
    if (reset) {
        browsePackIds = [];
        browseNextCursor = SEALED_PACK_CURSOR_LATEST;
        browseExhausted = false;
    }
    if (browseExhausted) return;
    const cursor = browseNextCursor;
    let request: Promise<void>;
    request = (async () => {
        const result = await retryChainRead<any>(() => registry.getSealedPacks.query(cursor, BROWSE_PACK_PAGE_SIZE));
        if (!result.success) throw new Error("browse packs query failed");
        const page = sealedCatalogPage(result.value);
        if (page === null) throw new Error("browse packs response was invalid");
        mergeCatalogPacks(page.packs);
        const byId = new Map(catalogPacks.map((pack) => [pack.id, pack]));
        browsePackIds = appendUniquePacks(
            browsePackIds.flatMap((id) => byId.get(id) ?? []),
            page.packs,
        ).map((pack) => pack.id);
        browseNextCursor = page.nextCursor;
        browseExhausted = page.nextCursor === 0;
    })().finally(() => {
        if (browsePacksRefresh === request) browsePacksRefresh = null;
        renderPackList();
    });
    browsePacksRefresh = request;
    renderPackList();
    return request;
}

async function refreshFavoritePacks(reset = false): Promise<void> {
    if (favoritePacksRefresh) return favoritePacksRefresh;
    if (reset) {
        favoritePackIds = [];
        favoriteNextCursor = 0n;
        favoriteTotal = 0;
        favoritesExhausted = false;
    }
    if (favoritesExhausted || !packSignals || !myAddress) return;
    const cursor = favoriteNextCursor;
    let request: Promise<void>;
    request = (async () => {
        const result = await retryChainRead<any>(() => packSignals.getFavorites.query(
            myAddress,
            cursor,
            BROWSE_PACK_PAGE_SIZE,
        ));
        if (!result.success) throw new Error("favorites query failed");
        const page = favoriteCatalogPage(result.value);
        if (page === null) throw new Error("favorites response was invalid");
        await hydrateCatalogPackIds(page.packIds);
        favoritePackIds = appendUniquePacks(catalogPacksFor(favoritePackIds), catalogPacksFor(page.packIds))
            .map((pack) => pack.id);
        favoriteNextCursor = page.nextCursor;
        favoriteTotal = page.total;
        favoritesExhausted = page.nextCursor === 0n;
    })().finally(() => {
        if (favoritePacksRefresh === request) favoritePacksRefresh = null;
        renderPackList();
    });
    favoritePacksRefresh = request;
    renderPackList();
    return request;
}

async function loadPopularPacks(reset = false): Promise<void> {
    if (popularPacksRefresh) return popularPacksRefresh;
    if (reset) {
        popularEntries = [];
        popularNextScore = 0;
        popularNextCursor = 0n;
        popularTotal = 0;
        popularExhausted = false;
    }
    if (popularExhausted || !packSignals) return;
    const cursorScore = popularNextScore;
    const cursor = popularNextCursor;
    let request: Promise<void>;
    request = (async () => {
        const result = await retryChainRead<any>(() => packSignals.getPopularPage.query(
            cursorScore,
            cursor,
            BROWSE_PACK_PAGE_SIZE,
        ));
        if (!result.success) throw new Error("popular packs query failed");
        const page = popularCatalogPage(result.value);
        if (page === null) throw new Error("popular packs response was invalid");
        await hydrateCatalogPackIds(page.entries.map((entry) => entry.packId));
        const available = new Set(catalogPacks.map((pack) => pack.id));
        const seen = new Set(popularEntries.map((entry) => entry.packId));
        popularEntries = [
            ...popularEntries,
            ...page.entries.filter((entry) => available.has(entry.packId) && !seen.has(entry.packId)),
        ];
        popularNextScore = page.nextScore;
        popularNextCursor = page.nextCursor;
        popularTotal = page.total;
        popularExhausted = page.nextScore === 0 && page.nextCursor === 0n;
    })().finally(() => {
        if (popularPacksRefresh === request) popularPacksRefresh = null;
        renderPackList();
    });
    popularPacksRefresh = request;
    renderPackList();
    return request;
}

async function refreshPopularPacks(): Promise<void> {
    await loadPopularPacks(true);
}

async function refreshSignalStates(ids: readonly number[]): Promise<void> {
    if (!packSignals || !myAddress) return;
    const unique = [...new Set(ids)];
    const batches = Array.from(
        { length: Math.ceil(unique.length / SIGNAL_VIEW_BATCH_SIZE) },
        (_, index) => unique.slice(index * SIGNAL_VIEW_BATCH_SIZE, (index + 1) * SIGNAL_VIEW_BATCH_SIZE),
    );
    await mapWithConcurrency(batches, 2, async (batch) => {
        const result = await retryChainRead<any>(() => packSignals.getPackSignals.query(myAddress, batch));
        if (!result.success || !Array.isArray(result.value)) return;
        for (const raw of result.value) {
            if (raw === null || typeof raw !== "object") continue;
            const record = raw as Record<string, unknown>;
            const packId = numericField(record, "pack_id", "packId");
            const favoriteCount = numericField(record, "favorite_count", "favoriteCount");
            const favorited = record.favorited;
            if (
                packId === null
                || favoriteCount === null
                || typeof favorited !== "boolean"
                || favoriteActionsInFlight.has(packId)
            ) continue;
            packSignalsById.set(packId, { favoriteCount, favorited });
        }
    });
}

function visibleCatalogPackIds(): number[] {
    if (catalogView === "browse") return browsePackIds;
    if (catalogView === "favorites") return favoritePackIds;
    if (catalogView === "popular") return popularEntries.map((entry) => entry.packId);
    return [
        ...curatedPacks().map((pack) => pack.id),
        ...favoritePackIds,
        ...popularEntries.map((entry) => entry.packId),
        ...newPackIds,
    ];
}

async function refreshSocialPacks(): Promise<void> {
    await Promise.all([
        refreshFavoritePacks(true).catch(() => undefined),
        refreshPopularPacks().catch(() => undefined),
    ]);
    await refreshSignalStates(visibleCatalogPackIds());
}

function refreshPacks({ includeDiscovery = getEl("screen-pack-select").classList.contains("active") }: {
    includeDiscovery?: boolean;
} = {}): Promise<void> {
    if (includeDiscovery) discoveryRefreshRequested = true;
    if (refreshingPacks) return refreshingPacks;
    const refreshDiscovery = discoveryRefreshRequested;
    discoveryRefreshRequested = false;
    starterPacksLoading = true;
    if (refreshDiscovery) discoveryPacksLoading = true;
    renderPackList();
    let request: Promise<void>;
    request = (async () => {
        await refreshStarterPacks();
        if (refreshDiscovery) {
            await Promise.all([
                refreshNewPacks(),
                refreshSocialPacks(),
            ]);
            await refreshSignalStates(visibleCatalogPackIds());
        }
    })().catch(() => {
        const error = getEl("screen-pack-select").classList.contains("active")
            ? $packSelectionError
            : $homeError;
        error.textContent = "Couldn’t refresh quiz packs. Try again in a moment.";
    }).finally(() => {
        if (refreshingPacks !== request) return;
        starterPacksLoading = false;
        discoveryPacksLoading = false;
        refreshingPacks = null;
        renderPackList();
        // Boot intentionally loads only the small editorial set. If a player
        // opens the picker before that request completes, honor their later
        // request for decentralized discovery instead of leaving the rails
        // half-loaded until the next poll.
        if (discoveryRefreshRequested) void refreshPacks({ includeDiscovery: true });
    });
    refreshingPacks = request;
    return request;
}

function questionCountLabel(pack: Pick<PackView, "regular_count">): string {
    return `${pack.regular_count} ${pack.regular_count === 1 ? "question" : "questions"}`;
}

function finalCountLabel(pack: Pick<PackView, "finals_set_count">): string {
    const count = pack.finals_set_count;
    if (count === 0) return "";
    return ` · ${count} ${count === 1 ? "final" : "finals"}`;
}

function updateSelectedPackSummary(): void {
    if (selectedPackId === null || selectedPack === null) {
        $selectedPackSummary.textContent = "Choose a pack to continue.";
        $configPackArt.className = "config-pack-art";
        $configPackArt.textContent = "✨";
        $configPackTitle.textContent = "Choose a pack";
        $configPackMeta.textContent = "Select a pack to configure a game.";
        return;
    }
    const presentation = packPresentation({ id: selectedPackId, ...selectedPack });
    $selectedPackSummary.textContent = `Selected: ${presentation.emoji} ${selectedPack.title} · ${questionCountLabel(selectedPack)}`;
    $configPackArt.className = `config-pack-art tone-${presentation.tone}`;
    $configPackArt.textContent = presentation.emoji;
    $configPackTitle.textContent = selectedPack.title;
    $configPackMeta.textContent = `${questionCountLabel(selectedPack)}${finalCountLabel(selectedPack)} · ${presentation.category}`;
}

function selectPack(id: number, pack: CatalogPack): void {
    selectedPackId = id;
    selectedPack = pack;
    $btnCreateGame.disabled = false;
    $btnPackContinue.disabled = false;
    const maxQ = Math.min(pack.regular_count, MAX_GAME_QUESTIONS);
    renderQuestionCountOptions(maxQ);
    for (const input of $packList.querySelectorAll<HTMLInputElement>('input[name="pack-choice"]')) {
        input.checked = Number(input.value) === id;
    }
    for (const card of $packList.querySelectorAll<HTMLLabelElement>(".pack-card")) {
        card.classList.toggle("selected", Number(card.dataset.packId) === id);
    }
    updateSelectedPackSummary();
    $packSelectionError.textContent = "";
    preparedGameCreationNonce = null;
    scheduleCreateGamePreflight();
}

function favoriteCountLabel(count: number): string {
    return `${count} ${count === 1 ? "favorite" : "favorites"}`;
}

function packCard(pack: CatalogPack, occurrence: string): HTMLLIElement {
    const presentation = packPresentation(pack);
    const item = document.createElement("li");
    const choice = document.createElement("input");
    choice.className = "pack-card-input";
    choice.type = "radio";
    choice.name = "pack-choice";
    choice.id = `pack-${pack.id}-choice-${occurrence}`;
    choice.value = String(pack.id);
    choice.checked = selectedPackId === pack.id;
    choice.setAttribute(
        "aria-label",
        `${pack.title}, ${questionCountLabel(pack)}${finalCountLabel(pack)}. ${presentation.category} pack.`,
    );
    choice.addEventListener("change", () => selectPack(pack.id, pack));

    const card = document.createElement("label");
    card.className = `pack-card tone-${presentation.tone}`;
    card.htmlFor = choice.id;
    card.dataset.testid = `pack-${pack.id}`;
    card.dataset.packId = String(pack.id);
    card.classList.toggle("selected", choice.checked);

    const art = span("pack-art", presentation.emoji);
    art.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "pack-card-copy";
    const heading = document.createElement("span");
    heading.className = "pack-card-heading";
    heading.append(
        span("pack-card-category", presentation.category),
        span("pack-card-check", "✓"),
    );
    const signal = packSignalsById.get(pack.id);
    const signalMeta = signal
        ? span("pack-card-favorite-count", favoriteCountLabel(signal.favoriteCount))
        : span("pack-card-favorite-count muted", "Loading saves…");
    const meta = span("pack-card-meta", `${questionCountLabel(pack)}${finalCountLabel(pack)} · `);
    meta.append(signalMeta);
    copy.append(
        heading,
        span("pack-card-title", pack.title),
        span("pack-card-description", presentation.description),
        meta,
    );
    card.append(art, copy);
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = "pack-card-favorite";
    favorite.dataset.testid = `btn-favorite-pack-${pack.id}`;
    favorite.disabled = signal === undefined || favoriteActionsInFlight.has(pack.id);
    favorite.setAttribute("aria-pressed", String(signal?.favorited ?? false));
    favorite.setAttribute("aria-label", signal === undefined
        ? `Loading saved state for ${pack.title}`
        : signal.favorited ? `Remove ${pack.title} from favorites` : `Save ${pack.title} to favorites`);
    favorite.title = favorite.getAttribute("aria-label") ?? "";
    favorite.textContent = signal?.favorited ? "★" : "☆";
    favorite.addEventListener("click", () => void setPackFavorite(pack, !(signal?.favorited ?? false)));
    item.append(choice, card, favorite);
    return item;
}

function packGrid(packs: readonly CatalogPack[], occurrence: string): HTMLUListElement {
    const grid = document.createElement("ul");
    grid.className = "pack-grid";
    grid.append(...packs.map((pack, index) => packCard(pack, `${occurrence}-${index}`)));
    return grid;
}

function openCatalogView(view: CatalogView): void {
    catalogView = view;
    packSearch = "";
    $packSearch.value = "";
    if (view === "browse" && browsePackIds.length === 0) {
        void loadBrowsePacks(true).then(() => refreshSignalStates(visibleCatalogPackIds())).catch(() => {
            $packSelectionError.textContent = "Couldn’t load more packs yet.";
        });
    }
    if (view === "popular" && popularEntries.length === 0 && !popularExhausted) {
        void loadPopularPacks(true).then(() => refreshSignalStates(visibleCatalogPackIds())).catch(() => {
            $packSelectionError.textContent = "Couldn’t load popular packs yet.";
        });
    }
    renderPackList();
}

function packSection(
    title: string,
    packs: readonly CatalogPack[],
    occurrence: string,
    view: CatalogView | null,
): HTMLElement {
    const section = document.createElement("section");
    section.className = "pack-section pack-rail";
    const headingRow = document.createElement("div");
    headingRow.className = "pack-section-heading";
    const heading = document.createElement("h3");
    heading.textContent = title;
    headingRow.append(heading);
    if (view !== null) {
        const seeAll = document.createElement("button");
        seeAll.type = "button";
        seeAll.className = "text-link pack-section-see-all";
        seeAll.textContent = "See all";
        seeAll.addEventListener("click", () => openCatalogView(view));
        headingRow.append(seeAll);
    }
    section.append(headingRow, packGrid(packs, occurrence));
    return section;
}

function detailPacks(): readonly CatalogPack[] {
    if (catalogView === "favorites") return catalogPacksFor(favoritePackIds);
    if (catalogView === "popular") return catalogPacksFor(popularEntries.map((entry) => entry.packId));
    if (catalogView === "browse") return catalogPacksFor(browsePackIds);
    return [];
}

function detailTitle(): string {
    if (catalogView === "favorites") return "Your favorites";
    if (catalogView === "popular") return "Popular";
    return "Browse all packs";
}

function updatePackCatalogStatus(): void {
    if (starterPacksLoading || discoveryPacksLoading || browsePacksRefresh || favoritePacksRefresh || popularPacksRefresh) {
        $packCatalogStatus.textContent = "Loading quiz packs…";
        return;
    }
    if (catalogView === "browse") {
        const loaded = visibleLibraryPacks(detailPacks(), packSearch, showE2ETestPacks).length;
        $packCatalogStatus.textContent = `Showing ${loaded} loaded ${loaded === 1 ? "pack" : "packs"}.`;
        return;
    }
    if (catalogView === "favorites") {
        const loaded = visibleLibraryPacks(detailPacks(), "", showE2ETestPacks).length;
        $packCatalogStatus.textContent = `Showing ${loaded} of ${favoriteTotal} saved ${favoriteTotal === 1 ? "pack" : "packs"}.`;
        return;
    }
    if (catalogView === "popular") {
        const loaded = visibleLibraryPacks(detailPacks(), "", showE2ETestPacks).length;
        $packCatalogStatus.textContent = `Showing ${loaded} of ${popularTotal} popular ${popularTotal === 1 ? "pack" : "packs"}.`;
        return;
    }
    $packCatalogStatus.textContent = "";
}

function renderPackList(): void {
    const librarySections = buildPackLibrarySections({
        picks: curatedPacks(),
        favorites: catalogPacksFor(favoritePackIds),
        popular: catalogPacksFor(popularEntries.map((entry) => entry.packId)),
        newest: catalogPacksFor(newPackIds).filter((pack) => featuredPack(pack) === undefined),
        includeE2ETestPacks: showE2ETestPacks,
    });
    const signature = JSON.stringify(
        {
            packs: catalogPacks.map((pack) => [
                pack.id,
                pack.title,
                pack.emoji ?? "",
                pack.regular_count,
                pack.finals_set_count,
            ]),
            newPackIds,
            browsePackIds,
            favoritePackIds,
            popularEntries,
            signals: [...packSignalsById.entries()],
            actions: [...favoriteActionsInFlight],
            view: catalogView,
            search: packSearch,
            showE2ETestPacks,
        },
    );
    // Avoid replacing identical DOM nodes every five seconds: it preserves
    // keyboard focus and prevents needless layout work on a static catalog.
    if (signature === lastPackListSignature) {
        updatePackCatalogStatus();
        return;
    }
    lastPackListSignature = signature;
    $packSearch.hidden = catalogView !== "browse";
    const content = document.createDocumentFragment();
    if (catalogView === "library") {
        const destination: Record<PackLibrarySectionId, CatalogView | null> = {
            picks: null,
            favorites: "favorites",
            popular: "popular",
            new: "browse",
        };
        for (const section of librarySections) {
            content.append(packSection(section.title, section.packs, section.id, destination[section.id]));
        }
        const browse = document.createElement("button");
        browse.type = "button";
        browse.className = "pack-browse-all";
        browse.dataset.testid = "btn-browse-all-packs";
        browse.textContent = "Browse all community packs";
        browse.addEventListener("click", () => openCatalogView("browse"));
        content.append(browse);
    } else {
        const heading = document.createElement("div");
        heading.className = "pack-detail-heading";
        const back = document.createElement("button");
        back.type = "button";
        back.className = "text-link";
        back.dataset.testid = "btn-pack-library-back";
        back.textContent = "Back to picks";
        back.addEventListener("click", () => openCatalogView("library"));
        const title = document.createElement("h3");
        title.textContent = detailTitle();
        heading.append(back, title);
        content.append(heading);

        const packs = visibleLibraryPacks(detailPacks(), packSearch, showE2ETestPacks);
        if (packs.length === 0) {
            const empty = document.createElement("p");
            empty.className = "pack-empty";
            empty.textContent = packSearch.trim()
                ? `No loaded packs match “${packSearch.trim()}”.`
                : "No packs to show yet.";
            content.append(empty);
        } else {
            content.append(packGrid(packs, catalogView));
        }
        if (catalogView === "browse" && !browseExhausted) {
            const loadMore = document.createElement("button");
            loadMore.type = "button";
            loadMore.className = "quiet pack-load-more";
            loadMore.dataset.testid = "btn-load-more-packs";
            loadMore.textContent = browsePacksRefresh ? "Loading packs…" : "Load more packs";
            loadMore.disabled = browsePacksRefresh !== null;
            loadMore.addEventListener("click", () => void loadBrowsePacks().then(
                () => refreshSignalStates(visibleCatalogPackIds()),
            ).catch(() => {
                $packSelectionError.textContent = "Couldn’t load more packs yet.";
            }));
            content.append(loadMore);
        }
        if (catalogView === "favorites" && !favoritesExhausted) {
            const loadMore = document.createElement("button");
            loadMore.type = "button";
            loadMore.className = "quiet pack-load-more";
            loadMore.textContent = favoritePacksRefresh ? "Loading favorites…" : "Load more favorites";
            loadMore.disabled = favoritePacksRefresh !== null;
            loadMore.addEventListener("click", () => void refreshFavoritePacks().then(
                () => refreshSignalStates(visibleCatalogPackIds()),
            ).catch(() => {
                $packSelectionError.textContent = "Couldn’t load more favorites yet.";
            }));
            content.append(loadMore);
        }
        if (catalogView === "popular" && !popularExhausted) {
            const loadMore = document.createElement("button");
            loadMore.type = "button";
            loadMore.className = "quiet pack-load-more";
            loadMore.dataset.testid = "btn-load-more-popular-packs";
            loadMore.textContent = popularPacksRefresh ? "Loading popular packs…" : "Load more popular packs";
            loadMore.disabled = popularPacksRefresh !== null;
            loadMore.addEventListener("click", () => void loadPopularPacks().then(
                () => refreshSignalStates(visibleCatalogPackIds()),
            ).catch(() => {
                $packSelectionError.textContent = "Couldn’t load more popular packs yet.";
            }));
            content.append(loadMore);
        }
    }
    $packList.replaceChildren(content);
    updatePackCatalogStatus();
}

$packSearch.addEventListener("input", () => {
    packSearch = $packSearch.value;
    renderPackList();
});

async function setPackFavorite(pack: CatalogPack, saved: boolean): Promise<void> {
    const previous = packSignalsById.get(pack.id);
    if (!previous || !packSignals || favoriteActionsInFlight.has(pack.id)) return;
    favoriteActionsInFlight.add(pack.id);
    packSignalsById.set(pack.id, {
        favorited: saved,
        favoriteCount: Math.max(0, previous.favoriteCount + (saved ? 1 : -1)),
    });
    renderPackList();
    try {
        await sendTx(packSignals, "setFavorite", pack.id, saved);
        $packSelectionError.textContent = "";
    } catch (error) {
        packSignalsById.set(pack.id, previous);
        $packSelectionError.textContent = friendlyError(error);
        favoriteActionsInFlight.delete(pack.id);
        renderPackList();
        return;
    }
    favoriteActionsInFlight.delete(pack.id);
    renderPackList();
    // The write is final at this point. Re-read the affected rails so their
    // order and exact count come from the contract rather than the optimistic
    // approximation above. A transient read failure must not undo a confirmed
    // save/remove action.
    try {
        await refreshSocialPacks();
        await refreshSignalStates(visibleCatalogPackIds());
    } catch {
        // The next normal catalog poll reconciles a confirmed chain write.
    }
}

function showPackSelection(): void {
    $homeError.textContent = "";
    $packSelectionError.textContent = "";
    catalogView = "library";
    packSearch = "";
    $packSearch.value = "";
    showScreen("pack-select");
    window.scrollTo(0, 0);
    void refreshPacks({ includeDiscovery: true });
}

getEl("btn-host-game").addEventListener("click", showPackSelection);

getEl("btn-pack-back").addEventListener("click", () => {
    showScreen("home");
    renderKnownGames();
    refreshKnownGames();
});

getEl("btn-pack-continue").addEventListener("click", () => {
    if (selectedPackId === null || selectedPack === null) {
        $packSelectionError.textContent = "Choose a pack before continuing.";
        return;
    }
    $configError.textContent = "";
    updateSelectedPackSummary();
    showScreen("configure");
    // The picker owns its own scroll region on phones. Start the next setup
    // step at its heading rather than preserving the previous page position.
    window.scrollTo(0, 0);
    scheduleCreateGamePreflight();
});

for (const id of ["btn-config-back-bottom"]) {
    getEl(id).addEventListener("click", () => {
        $configError.textContent = "";
        showScreen("pack-select");
    });
}

// Keep direct contract rails fresh while someone compares packs. The static
// client never polls a catalog service; this is driven by best-chain blocks.
let lastCatalogAutoRefreshAt = 0;
function maybeRefreshOpenCatalog(): void {
    if (!registry || busy || !getEl("screen-pack-select").classList.contains("active")) return;
    const now = Date.now();
    if (now - lastCatalogAutoRefreshAt < 10_000) return;
    lastCatalogAutoRefreshAt = now;
    void refreshPacks({ includeDiscovery: true });
}

function readCreatedGameConfig(showErrors = false): CreatedGameConfig | null {
    if (selectedPackId === null || selectedPack === null) return null;
    const fail = (message: string): null => {
        if (showErrors) showConfigError(message);
        return null;
    };
    const maxQuestions = Math.min(selectedPack.regular_count, MAX_GAME_QUESTIONS);
    const numQuestions = selectedQuestionCount;
    if (!questionCountOptions(maxQuestions).includes(numQuestions)) {
        return fail(`Choose between 1 and ${maxQuestions} questions.`);
    }
    const answerBlocks = selectedAnswerBlocks;
    if (!isAllowedBlockPreset(answerBlocks, ANSWER_BLOCK_PRESETS)) {
        return fail("Choose one of the listed answer-time options.");
    }
    const reviewBlocks = selectedReviewBlocks;
    if (!isAllowedBlockPreset(reviewBlocks, REVIEW_BLOCK_PRESETS)) {
        return fail("Choose one of the listed review-time options.");
    }
    return {
        packId: selectedPackId,
        numQuestions,
        answerBlocks,
        reviewBlocks,
    };
}

function gameConfigArgs(config: CreatedGameConfig): readonly unknown[] {
    return [
        config.packId,
        config.numQuestions,
        config.answerBlocks,
        config.reviewBlocks,
        // The contract enforces its fixed lobby ceiling. This is not a host
        // setting, so players never need to choose it.
        MAX_LOBBY_PLAYERS,
    ];
}

function gameCreateCall(config: CreatedGameConfig): { method: string; args: readonly unknown[]; nonce: bigint } {
    const args = gameConfigArgs(config);
    const nonce = preparedGameCreationNonce ??= creationNonce();
    return { method: "createGameWithNonce", args: [...args, nonce], nonce };
}

/** Debounce form edits, then use the player's think time to size createGame. */
function scheduleCreateGamePreflight(): void {
    if (createGamePreflightTimer) clearTimeout(createGamePreflightTimer);
    createGamePreflightTimer = setTimeout(() => {
        createGamePreflightTimer = null;
        if (!game || !productAccount) return;
        const config = readCreatedGameConfig();
        if (config) {
            const call = gameCreateCall(config);
            void warmTx(game, call.method, call.args);
        }
    }, 250);
}

/** Resolve a creation nonce instead of racing another tab's latest-game pointer. */
async function resolveCreatedGame(nonce: bigint): Promise<bigint | null> {
    // Submission resolves at best-block, but contract reads can lag until the
    // next finalized view (~9s on Paseo, same budget as the session-state
    // waits). A too-short window here strands creators on "could not locate
    // the created game" even though the recovery marker would save them.
    for (let attempt = 0; attempt < SESSION_STATE_CONFIRM_ATTEMPTS; attempt += 1) {
        const res = await game.getGameForCreation.query(myAddress, nonce);
        if (res.success) {
            const id = BigInt(res.value ?? 0);
            if (id !== 0n) return id;
        }
        if (attempt + 1 < SESSION_STATE_CONFIRM_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, SESSION_STATE_CONFIRM_DELAY_MS));
        }
    }
    return null;
}

function pendingGameCreation() {
    if (!myAddress || !isContractAddress(activeContracts.game)) return null;
    try {
        return readPendingGameCreation(window.sessionStorage, activeContracts.game, myAddress);
    } catch {
        return null;
    }
}

function clearPendingGameCreationMarker(): void {
    if (!myAddress || !isContractAddress(activeContracts.game)) return;
    try {
        clearPendingGameCreation(window.sessionStorage, activeContracts.game, myAddress);
    } catch {
        // Private browsing policies must not disrupt a successfully created lobby.
    }
}

function rememberPendingGameCreationMarker(nonce: bigint, config: CreatedGameConfig): void {
    if (!myAddress || !isContractAddress(activeContracts.game)) return;
    try {
        rememberPendingGameCreation(window.sessionStorage, activeContracts.game, myAddress, { nonce, config });
    } catch {
        // Storage is recovery-only; the in-memory path still opens the lobby.
    }
}

/**
 * A refresh can land after createGame has been included but before its nonce
 * becomes a lobby code. Resolve that tiny gap before offering another table.
 */
async function resumePendingGameCreation(): Promise<"none" | "resumed" | "unavailable"> {
    const pending = pendingGameCreation();
    if (!pending) return "none";
    const id = await resolveCreatedGame(pending.nonce);
    if (id === null) return "unavailable";
    clearPendingGameCreationMarker();
    enterGame(id, createdLobbySnapshot(pending.config));
    return "resumed";
}

/** `null` means the chain could not be queried; `false` is authoritative. */
async function activePlayerStatus(id: bigint): Promise<boolean | null> {
    try {
        const res = await withTimeout(
            retryChainRead<any>(() => game.isPlayerActive.query(id, myAddress)),
            LIVE_GAME_READ_TIMEOUT_MS,
            "Timed out checking this player.",
        );
        // A failed contract read is not evidence that the player left. Keep
        // the known room so a temporary RPC/fork error cannot erase the
        // player’s recovery path.
        if (!res.success) return null;
        return Boolean(res.value);
    } catch {
        return null;
    }
}

/** A started game is rejoinable only by an active (not forfeited) player. */
async function amActivePlayerInGame(id: bigint): Promise<boolean> {
    return (await activePlayerStatus(id)) === true;
}

type ResumeResult = "none" | "resumed" | "unavailable";

/**
 * Restore the newest room this account has opened on this device. The game
 * contract has no account-to-game index, so this durable local list is a
 * recovery aid rather than a claim that it can discover every room globally.
 */
async function resumeMostRecentKnownGame(): Promise<ResumeResult> {
    if (!game || !myAddress) return "none";
    // Begin every lookup concurrently so stale records do not add their
    // timeout budgets together, but await them in recency order. That lets a
    // healthy newest room reopen immediately without waiting on old entries.
    const inspections = [...knownGames].map(async (known) => ({
            known,
            inspection: await inspectKnownGame(known.id),
        }));
    let hadUnavailable = false;
    for (const pending of inspections) {
        const { known, inspection } = await pending;
        if (inspection === "stale") {
            forgetKnownGame(known.id);
            continue;
        }
        knownGameInspections.set(known.id, inspection);
        if (inspection.kind === "unavailable") {
            hadUnavailable = true;
            continue;
        }
        bootLog(`Reopening game ${known.id}…`, "ok");
        enterGame(known.id);
        return "resumed";
    }
    return hadUnavailable ? "unavailable" : "none";
}

/**
 * A party is deliberately one current table per app. The
 * contract remains permissive — it does not maintain a costly global
 * account-to-game index — but never silently replace the room a player can
 * resume locally.
 */
async function canStartAnotherQuiz(error = $homeError): Promise<boolean> {
    if (pendingGameCreation()) {
        error.textContent = "Your new lobby is still being confirmed. Give it a moment, then try again to reopen it.";
        return false;
    }
    for (const known of [...knownGames]) {
        const inspection = await inspectKnownGame(known.id);
        // A stale device record must not lock a player out of starting a new
        // quiz while the normal background refresh is still catching up.
        if (inspection === "stale") {
            forgetKnownGame(known.id);
            continue;
        }
        knownGameInspections.set(known.id, inspection);
        if (inspection.kind === "unavailable") {
            error.textContent = "Couldn’t check your existing quiz yet. Try again in a moment.";
        } else {
            error.textContent = "You already have a quiz in progress. Rejoin it, leave its lobby, or forfeit it before starting another.";
        }
        renderKnownGames();
        return false;
    }
    return true;
}

/** Join or reopen a room, shared by the manual form and `?join=` invites. */
async function joinGameById(id: bigint, error: HTMLElement): Promise<boolean> {
    if (!productAccount || busy) return false;
    busy = true;
    try {
        const pendingCreation = await resumePendingGameCreation();
        if (pendingCreation === "resumed") return true;
        if (pendingCreation === "unavailable") {
            error.textContent = "Your new lobby is still being confirmed. Try again in a moment.";
            return false;
        }
        if (knownGames.some((known) => known.id === id)) {
            if (await reopenKnownGame(id)) return true;
            error.textContent = $homeError.textContent || "Couldn’t reopen that quiz yet. Try again when the connection recovers.";
            return false;
        }
        if (!await canStartAnotherQuiz(error)) return false;

        await sendTx(game, "joinGame", id);
        enterGame(id);
        return true;
    } catch (e) {
        const msg = txError(e);
        // Rejoining from the lobby is always safe. Once a game starts,
        // `GameAlreadyStarted` is also returned to strangers, so verify that
        // this account already belongs to the game before entering its UI.
        if (msg.includes("AlreadyJoined")) {
            enterGame(id);
            return true;
        }
        if (msg.includes("GameAlreadyStarted") && await amActivePlayerInGame(id)) {
            enterGame(id);
            return true;
        }
        error.textContent = friendlyError(e);
        return false;
    } finally {
        busy = false;
    }
}

getEl("btn-create-game").addEventListener("click", async () => {
    if (busy || selectedPackId === null || selectedPack === null || !productAccount) return;
    if (createGamePreflightTimer) {
        clearTimeout(createGamePreflightTimer);
        createGamePreflightTimer = null;
    }
    $configError.textContent = "";
    busy = true;
    let submitted = false;
    try {
        const pendingCreation = await resumePendingGameCreation();
        if (pendingCreation === "resumed") return;
        if (pendingCreation === "unavailable") {
            showConfigError("Your new lobby is still being confirmed. Try again in a moment.");
            return;
        }
        if (!await canStartAnotherQuiz($configError)) return;
        const config = readCreatedGameConfig(true);
        if (!config) return;
        submitted = true;
        setLoading("btn-create-game", true);
        const call = gameCreateCall(config);
        await sendWarmedTx(game, call.method, call.args);
        showConfigProgress("Game created — opening your lobby…");
        rememberPendingGameCreationMarker(call.nonce, config);
        const id = await resolveCreatedGame(call.nonce);
        if (id === null) {
            throw new Error("Your lobby is still being confirmed — it will reopen automatically in a moment.");
        }
        clearPendingGameCreationMarker();
        enterGame(id, createdLobbySnapshot(config));
    } catch (e) {
        showConfigError(friendlyError(e));
    } finally {
        if (submitted) {
            preparedGameCreationNonce = null;
            setLoading("btn-create-game", false);
        }
        busy = false;
    }
});

async function submitJoinGame(): Promise<void> {
    if (busy || !productAccount) return;
    $homeError.textContent = "";
    const raw = $joinGameId.value;
    if (raw === "") {
        $homeError.textContent = "Enter a game code.";
        return;
    }
    const id = parseGameCode(raw);
    if (id === null) {
        $homeError.textContent = "Enter a six-digit game code.";
        return;
    }
    setLoading("btn-join-game", true);
    try {
        await joinGameById(id, $homeError);
    } finally {
        setLoading("btn-join-game", false);
    }
}

getEl("btn-join-game").addEventListener("click", () => void submitJoinGame());

$joinGameId.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        void submitJoinGame();
    }
});

// ── Pack studio ──────────────────────────────────────────────────────

const $builderError = getEl("builder-error");
const $draftName = getEl<HTMLInputElement>("draft-name");
const $packEmoji = getEl<HTMLInputElement>("pack-emoji");
const $packJson = getEl<HTMLTextAreaElement>("pack-json");
const $draftSaveStatus = getEl("draft-save-status");
const $draftList = getEl("builder-draft-list");
const $builderPreview = getEl("builder-preview");
const $builderValidation = getEl("builder-validation");
const $builderPublishStatus = getEl("builder-publish-status");
const $btnPublishPack = getEl<HTMLButtonElement>("btn-publish-pack");
const $emojiPickerDialog = getEl<HTMLDialogElement>("emoji-picker-dialog");
const $emojiPickerHost = getEl("emoji-picker-host");
const MAX_IMPORT_BATCH_SIZE = 8;
const FINAL_DIFFICULTIES = ["easy", "medium", "hard"] as const;

type FinalDifficulty = (typeof FINAL_DIFFICULTIES)[number];
type PublishQuestion = { text: string; answers: string[]; is_final: boolean; difficulty: number };

function setPackStudioPublishing(publishing: boolean): void {
    packPublishInProgress = publishing;
    const controls = [
        $draftName,
        $packEmoji,
        $packJson,
        getEl<HTMLInputElement>("pack-file-input"),
        getEl<HTMLButtonElement>("btn-new-draft"),
        getEl<HTMLButtonElement>("btn-open-emoji-picker"),
        getEl<HTMLButtonElement>("btn-insert-pack-template"),
        getEl<HTMLButtonElement>("btn-export-pack-file"),
        getEl<HTMLButtonElement>("btn-export-draft"),
        getEl<HTMLButtonElement>("btn-builder-done"),
    ];
    for (const control of controls) control.disabled = publishing;
}

function setDraftSaveStatus(message: string): void {
    $draftSaveStatus.textContent = message;
}

function activeDraftOrThrow(): PackDraft {
    if (!activePackDraft) throw new Error("Open a pack draft first.");
    return activePackDraft;
}

function replaceActiveDraft(next: PackDraft, { save = true, paintInputs = false }: { save?: boolean; paintInputs?: boolean } = {}): void {
    activePackDraft = next;
    const index = packDrafts.findIndex((draft) => draft.metadata.id === next.metadata.id);
    if (index >= 0) packDrafts.splice(index, 1, next);
    else packDrafts.unshift(next);
    packDrafts.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);
    if (paintInputs) {
        $draftName.value = next.metadata.name;
        $packEmoji.value = next.metadata.emoji;
        $packJson.value = next.rawJson;
    }
    if (save) {
        setDraftSaveStatus("Saving locally…");
        packDraftSaver.schedule(next);
    }
    renderPackDraftList();
    renderPackDraftPreview();
}

function renderPackDraftList(): void {
    renderList(
        $draftList,
        packDrafts.map((draft) => {
            const item = li(span("draft-emoji", draft.metadata.emoji));
            const button = document.createElement("button");
            button.type = "button";
            button.disabled = packPublishInProgress;
            button.className = draft.metadata.id === activePackDraft?.metadata.id ? "draft-current" : "";
            button.setAttribute("aria-current", draft.metadata.id === activePackDraft?.metadata.id ? "true" : "false");
            const copy = document.createElement("span");
            copy.className = "draft-copy";
            const name = document.createElement("strong");
            name.textContent = draft.metadata.name;
            const meta = document.createElement("span");
            const validation = validatePackDraft(draft);
            meta.textContent = validation.valid
                ? `${validation.pack.questions.length} questions · ready`
                : "needs attention";
            copy.append(name, meta);
            button.append(copy);
            button.addEventListener("click", () => void openExistingPackDraft(draft.metadata.id));
            item.append(button);
            return item;
        }),
    );
}

function renderPackDraftPreview(): void {
    const draft = activePackDraft;
    if (!draft) {
        $builderPreview.hidden = true;
        $builderValidation.textContent = "";
        $btnPublishPack.disabled = true;
        return;
    }
    const validation = validatePackDraft(draft);
    packDraftValidation = validation;
    if (!validation.valid) {
        $builderPreview.hidden = true;
        const list = document.createElement("ul");
        for (const issue of validation.issues) {
            const item = document.createElement("li");
            item.textContent = issue.message;
            list.append(item);
        }
        $builderValidation.replaceChildren(list);
        $btnPublishPack.disabled = true;
        $builderPublishStatus.textContent = "Fix the draft before publishing.";
        return;
    }
    $builderPreview.hidden = false;
    getEl("builder-preview-emoji").textContent = validation.emoji;
    getEl("builder-preview-title").textContent = validation.pack.title;
    getEl("builder-preview-meta").textContent =
        `${validation.pack.questions.length} regular ${validation.pack.questions.length === 1 ? "question" : "questions"} · 3 finals · ${validation.emoji}`;
    $builderValidation.textContent = "";
    $btnPublishPack.disabled = busy;
    if (canResumePackPublish(draft, validation)) {
        $builderPublishStatus.textContent = "A previous publish is ready to resume.";
    } else {
        $builderPublishStatus.textContent = "Ready to publish.";
    }
}

async function ensurePackStudio(): Promise<void> {
    if (!packStudioLoaded) {
        setDraftSaveStatus("Loading local drafts…");
        try {
            packDrafts = await packDraftStore.list();
        } catch {
            packDrafts = [];
        }
        packStudioLoaded = true;
    }
    if (!activePackDraft) {
        const initial = packDrafts[0] ?? createPackDraft();
        if (packDrafts.length === 0) {
            packDrafts = [initial];
            try {
                await packDraftStore.save(initial);
            } catch {
                // The memory fallback still makes the studio usable.
            }
        }
        replaceActiveDraft(initial, { save: false, paintInputs: true });
    } else {
        replaceActiveDraft(activePackDraft, { save: false, paintInputs: true });
    }
    setDraftSaveStatus("Saved locally on this device.");
}

async function openExistingPackDraft(id: string): Promise<void> {
    if (packPublishInProgress) return;
    await packDraftSaver.flush();
    const draft = packDrafts.find((candidate) => candidate.metadata.id === id)
        ?? await packDraftStore.get(id);
    if (!draft) return;
    replaceActiveDraft(draft, { save: false, paintInputs: true });
    setDraftSaveStatus("Saved locally on this device.");
}

async function openPackBuilder(): Promise<void> {
    $builderError.textContent = "";
    showScreen("builder");
    await ensurePackStudio();
}

for (const id of ["btn-new-pack"]) {
    getEl(id).addEventListener("click", () => void openPackBuilder());
}

getEl("btn-new-draft").addEventListener("click", async () => {
    if (packPublishInProgress) return;
    await packDraftSaver.flush();
    const draft = createPackDraft();
    replaceActiveDraft(draft, { paintInputs: true });
    setDraftSaveStatus("New draft — saving locally…");
});

function updateActiveDraftFromEditor(change: Parameters<typeof updatePackDraft>[1]): void {
    if (packPublishInProgress) return;
    const draft = activeDraftOrThrow();
    replaceActiveDraft(updatePackDraft(draft, change));
}

$draftName.addEventListener("input", () => {
    if (activePackDraft) updateActiveDraftFromEditor({ name: $draftName.value });
});
$packEmoji.addEventListener("input", () => {
    if (activePackDraft) updateActiveDraftFromEditor({ emoji: $packEmoji.value });
});
$packJson.addEventListener("input", () => {
    if (activePackDraft) updateActiveDraftFromEditor({ rawJson: $packJson.value });
});

function downloadText(filename: string, text: string): void {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 0);
}

getEl("btn-insert-pack-template").addEventListener("click", () => {
    if (packPublishInProgress || !activePackDraft) return;
    updateActiveDraftFromEditor({ rawJson: EMPTY_PACK_JSON });
    $packJson.value = EMPTY_PACK_JSON;
    setDraftSaveStatus("Template inserted — saving locally…");
});

getEl("btn-export-pack-file").addEventListener("click", () => {
    if (!packDraftValidation?.valid) {
        $builderError.textContent = "Fix the draft before exporting a playable pack file.";
        return;
    }
    const fileName = `${packDraftValidation.pack.title.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "quizzler-pack"}.json`;
    downloadText(fileName, exportPackFile(packDraftValidation.pack, { emoji: packDraftValidation.emoji }));
});

getEl("btn-export-draft").addEventListener("click", () => {
    if (!activePackDraft) return;
    downloadText("quizzler-pack-draft.json", exportPackDraft(activePackDraft));
});

getEl<HTMLInputElement>("pack-file-input").addEventListener("change", async (event) => {
    if (packPublishInProgress) return;
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
        const imported = importPackDraft(await file.text(), { name: file.name.replace(/\.json$/i, "") || "Imported pack" });
        await packDraftSaver.flush();
        replaceActiveDraft(imported.draft, { paintInputs: true });
        setDraftSaveStatus(imported.validation.valid ? "Imported and saved locally." : "Imported locally — fix the highlighted issues.");
    } catch (error) {
        $builderError.textContent = `Couldn’t read that file: ${txError(error)}`;
    }
});

async function openEmojiPicker(): Promise<void> {
    if (packPublishInProgress) return;
    $builderError.textContent = "";
    if (!$emojiPickerDialog.open) $emojiPickerDialog.showModal();
    if ($emojiPickerHost.childElementCount > 0) return;
    $emojiPickerHost.textContent = "Loading the full emoji picker…";
    try {
        await import("emoji-picker-element");
        const picker = document.createElement("emoji-picker");
        picker.classList.add("dark");
        picker.addEventListener("emoji-click", (event) => {
            if (packPublishInProgress) return;
            const unicode = (event as unknown as CustomEvent<{ unicode?: unknown }>).detail?.unicode;
            if (typeof unicode !== "string") return;
            $packEmoji.value = unicode;
            if (activePackDraft) updateActiveDraftFromEditor({ emoji: unicode });
            $emojiPickerDialog.close();
        });
        $emojiPickerHost.replaceChildren(picker);
    } catch {
        $emojiPickerHost.textContent = "The emoji picker could not load here. You can still type or paste any emoji into the cover field.";
    }
}

getEl("btn-open-emoji-picker").addEventListener("click", () => void openEmojiPicker());
getEl("btn-close-emoji-picker").addEventListener("click", () => $emojiPickerDialog.close());

function publishQuestion(question: PackQuestion, isFinal: boolean, difficulty: number): PublishQuestion {
    return {
        text: question.text,
        // The registry rejects duplicate normalized answers. Preserve friendly
        // source variants in a draft, but emit one canonical value per match.
        answers: normalizeAcceptedAnswers(question.answers),
        is_final: isFinal,
        difficulty,
    };
}

function nextPublishResume(resume: PackPublishResume, patch: Partial<PackPublishResume>): PackPublishResume {
    return { ...resume, ...patch, updatedAt: Date.now() };
}

async function persistPublishResume(draftId: string, resume: PackPublishResume | null): Promise<PackDraft> {
    if (publishingDraftId !== draftId) {
        throw new Error("The active publish no longer matches this draft.");
    }
    const index = packDrafts.findIndex((draft) => draft.metadata.id === draftId);
    if (index < 0) throw new Error("The publishing draft is no longer available locally.");
    const next = updatePackDraft(packDrafts[index], { publishResume: resume });
    packDrafts.splice(index, 1, next);
    packDrafts.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);
    if (activePackDraft?.metadata.id === draftId) activePackDraft = next;
    renderPackDraftList();
    renderPackDraftPreview();
    // Publishing is locked to one draft, so save the exact updated record
    // rather than relying on whichever draft happens to be open later.
    await packDraftStore.save(next);
    return next;
}

function creationNonce(): bigint {
    const bytes = new Uint32Array(2);
    try {
        globalThis.crypto.getRandomValues(bytes);
        return (BigInt(bytes[0]) << 32n) | BigInt(bytes[1]);
    } catch {
        return (BigInt(Date.now()) << 16n) | BigInt(Math.floor(Math.random() * 0xffff));
    }
}

async function resolveCreatedPack(nonce: bigint, attempts = SESSION_STATE_CONFIRM_ATTEMPTS): Promise<number | null> {
    // Same finalized-view read lag budget as resolveCreatedGame. A fresh
    // nonce that has never been submitted passes `attempts: 1` — waiting the
    // full window for a pack that cannot exist would stall every publish.
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = await registry.getPackForCreation.query(myAddress, nonce);
        if (result.success) {
            const id = Number(result.value ?? NO_PACK);
            if (id !== NO_PACK) return id;
        }
        if (attempt + 1 < attempts) {
            await new Promise((resolve) => setTimeout(resolve, SESSION_STATE_CONFIRM_DELAY_MS));
        }
    }
    return null;
}

/** Reconcile a saved cursor against immutable registry state before resuming. */
async function reconcilePublishResume(
    resume: PackPublishResume,
    validation: Extract<PackDraftValidation, { valid: true }>,
): Promise<PackPublishResume> {
    if (resume.packId === null) {
        if (!resume.creationNonce) return resume;
        const packId = await resolveCreatedPack(BigInt(resume.creationNonce));
        return packId === null
            ? resume
            : nextPublishResume(resume, { packId, phase: "questions" });
    }
    const packResult = await registry.getPack.query(resume.packId);
    if (!packResult.success) throw new Error("The saved pack could not be read from this registry.");
    const pack = packResult.value as PackView;
    if (pack.creator.toLowerCase() !== myAddress) throw new Error("The saved pack belongs to another account.");
    if (pack.regular_count > validation.pack.questions.length) {
        throw new Error("The published pack has more questions than this draft, so it cannot be resumed safely.");
    }
    let completedFinals = resume.completedFinals;
    if (pack.finals_set_count === 3) {
        completedFinals = [...FINAL_DIFFICULTIES];
    } else if (pack.finals_set_count > 0) {
        const existing = await Promise.all(FINAL_DIFFICULTIES.map(async (difficulty) => {
            const result = await registry.getQuestion.query(resume.packId!, FINAL_SLOT_BASE + FINAL_DIFFICULTIES.indexOf(difficulty));
            return result.success ? difficulty : null;
        }));
        completedFinals = existing.filter((difficulty): difficulty is FinalDifficulty => difficulty !== null);
    }
    return nextPublishResume(resume, {
        phase: pack.sealed ? "seal" : pack.regular_count < validation.pack.questions.length ? "questions" : "finals",
        nextRegularQuestion: pack.regular_count,
        completedFinals,
    });
}

async function publishPackDraft(): Promise<void> {
    if (busy || !productAccount || !activePackDraft) return;
    const publishingDraft = activePackDraft;
    const draftId = publishingDraft.metadata.id;
    const validation = validatePackDraft(publishingDraft);
    if (!validation.valid) {
        renderPackDraftPreview();
        return;
    }
    busy = true;
    publishingDraftId = draftId;
    setPackStudioPublishing(true);
    $builderError.textContent = "";
    setLoading("btn-publish-pack", true);
    try {
        // Flush any edits already queued before we write durable publish
        // checkpoints. The studio stays locked until the sequence finishes.
        await packDraftSaver.flush();
        const persistedDraft = packDrafts.find((draft) => draft.metadata.id === draftId) ?? publishingDraft;
        let resume = canResumePackPublish(persistedDraft, validation)
            ? persistedDraft.publishResume!
            : createPackPublishResume({ contentHash: validation.contentHash });
        resume = await reconcilePublishResume(resume, validation);
        await persistPublishResume(draftId, resume);

        if (resume.packId === null) {
            $builderPublishStatus.textContent = "Creating the pack…";
            const nonce = resume.creationNonce ? BigInt(resume.creationNonce) : creationNonce();
            if (!resume.creationNonce) {
                resume = nextPublishResume(resume, { creationNonce: nonce.toString() });
                await persistPublishResume(draftId, resume);
            }
            // One quick probe covers "the create landed but the resume marker
            // didn't record it"; a nonce that was never submitted must not
            // wait out the full read-lag window before creating.
            let packId = await resolveCreatedPack(nonce, 1);
            if (packId === null) {
                await sendTx(registry, "createPackWithNonce", validation.pack.title, validation.emoji, nonce);
                packId = await resolveCreatedPack(nonce);
            }
            if (packId === null) throw new Error("Your pack is still being confirmed. Your draft is saved — tap Publish again to resume.");
            resume = nextPublishResume(resume, { packId, phase: "questions" });
            await persistPublishResume(draftId, resume);
        }

        const packId = resume.packId;
        if (packId === null) throw new Error("Couldn’t resolve the pack id.");
        while (resume.nextRegularQuestion < validation.pack.questions.length) {
            const start = resume.nextRegularQuestion;
            const batch = validation.pack.questions
                .slice(start, start + MAX_IMPORT_BATCH_SIZE)
                .map((question) => publishQuestion(question, false, 0));
            $builderPublishStatus.textContent = `Publishing questions ${start + 1}–${start + batch.length} of ${validation.pack.questions.length}…`;
            await sendTx(registry, "addQuestions", packId, batch);
            resume = await reconcilePublishResume(resume, validation);
            if (resume.nextRegularQuestion <= start) throw new Error("Still saving your questions. Tap Publish again in a moment to pick up where you left off.");
            await persistPublishResume(draftId, resume);
        }

        const remainingFinals = FINAL_DIFFICULTIES.filter((difficulty) => !resume.completedFinals.includes(difficulty));
        if (remainingFinals.length > 0) {
            $builderPublishStatus.textContent = "Publishing final questions…";
            const finals = remainingFinals.map((difficulty, index) =>
                publishQuestion(validation.pack.finals[difficulty], true, FINAL_DIFFICULTIES.indexOf(difficulty)),
            );
            await sendTx(registry, "addQuestions", packId, finals);
            resume = await reconcilePublishResume(resume, validation);
            if (resume.completedFinals.length < 3) throw new Error("Still saving your final questions. Tap Publish again in a moment to pick up where you left off.");
            await persistPublishResume(draftId, resume);
        }

        const finalState = await registry.getPack.query(packId);
        if (!finalState.success) throw new Error("Couldn’t verify the completed pack.");
        if (!(finalState.value as PackView).sealed) {
            $builderPublishStatus.textContent = "Sealing the pack…";
            await sendTx(registry, "sealPack", packId);
        }
        await persistPublishResume(draftId, null);
        const published: CatalogPack = {
            id: packId,
            creator: myAddress,
            title: validation.pack.title,
            emoji: validation.emoji,
            regular_count: validation.pack.questions.length,
            finals_set_count: 3,
            sealed: true,
        };
        mergeCatalogPacks([published]);
        selectedPackId = packId;
        selectedPack = published;
        updateSelectedPackSummary();
        $builderPublishStatus.textContent = "Published — now set up your game.";
        showScreen("configure");
        window.scrollTo(0, 0);
        scheduleCreateGamePreflight();
    } catch (error) {
        $builderError.textContent = friendlyError(error);
        $builderPublishStatus.textContent = "Publish paused. Your saved draft can resume from its last confirmed step.";
    } finally {
        publishingDraftId = null;
        setPackStudioPublishing(false);
        busy = false;
        setLoading("btn-publish-pack", false);
        renderPackDraftPreview();
    }
}

getEl("btn-publish-pack").addEventListener("click", () => void publishPackDraft());

getEl("btn-builder-done").addEventListener("click", async () => {
    if (packPublishInProgress) return;
    await packDraftSaver.flush();
    showScreen("home");
    renderKnownGames();
    refreshKnownGames();
});

window.addEventListener("pagehide", () => {
    // A final best-effort save turns a refresh during authoring into a normal
    // draft restore rather than relying solely on the debounce timer.
    void packDraftSaver.flush();
    // The room list is written immediately as well, so an accidental close
    // right after entering a lobby still leaves a visible route back in.
    flushKnownGames();
});

// ── Game loop ────────────────────────────────────────────────────────

function createdLobbySnapshot(config: CreatedGameConfig): Snapshot {
    const players = [myAddress];
    const playerNames = [myDisplayName];
    return {
        phase: {
            stage: STAGE_LOBBY,
            cursor: 0,
            deadline: 2n ** 64n - 1n,
            current_block: 0n,
            final_difficulty: 255,
            slot: NO_SLOT,
            submit_count: 0,
            continue_count: 0,
            final_wager_count: 0,
            easy_vote_count: 0,
            medium_vote_count: 0,
            hard_vote_count: 0,
            player_count: 1,
            active_player_count: 1,
        },
        game: {
            pack_id: config.packId,
            creator: myAddress,
            num_questions: config.numQuestions,
            answer_blocks: config.answerBlocks,
            review_blocks: config.reviewBlocks,
            max_players: MAX_LOBBY_PLAYERS,
            player_count: 1,
            active_player_count: 1,
        },
        players,
        playerNames,
        playerLabels: resolvePlayerLabels(players, playerNames),
        scores: [0],
        difficultyChoices: [0],
        difficultyVoteLocked: [false],
        finalWagers: [0],
        finalWagerLocked: [false],
        submissions: [],
        questionText: "",
        answerText: "",
    };
}

function stopGamePolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    blockPollSubscription?.unsubscribe();
    blockPollSubscription = null;
    lastBlockSignalAt = 0;
}

/**
 * Best-block notifications get a refresh underway as soon as the chain moves,
 * and an immediate read prevents a newly joined/reopened table from waiting
 * for the next block. A low-rate fallback keeps the table live if the host's
 * block subscription drops.
 */
function startGamePolling(): void {
    stopGamePolling();
    if (bestBlocks) {
        blockPollSubscription = bestBlocks.subscribe(() => {
            lastBlockSignalAt = Date.now();
            if (document.visibilityState === "visible") void poll();
        });
    }
    // Subscriptions only signal future blocks. Always reconcile once on entry
    // so join, refresh, and invite links have a snapshot straight away.
    void poll();
    pollTimer = setInterval(() => {
        if (document.visibilityState === "visible" && Date.now() - lastBlockSignalAt >= POLL_FALLBACK_MS) {
            void poll();
        }
    }, POLL_FALLBACK_MS);
}

function enterGame(id: bigint, initialSnapshot: Snapshot | null = null): void {
    gameSession += 1;
    gameId = id;
    gameSettingsOpen = false;
    gameEntryMark = performanceMark("game:entered");
    awaitingFirstGameSnapshot = true;
    pendingAbandonedForfeit = null;
    rememberGame(id);
    latest = initialSnapshot;
    actionKey = "";
    actionsSent.clear();
    actionSentAt.clear();
    wagerOutcomes = new Map();
    wagerHistoryLoadedUpTo = -1;
    selectedWager = null;
    selectedDifficulty = null;
    activeAnswerKey = "";
    activeFinalWagerKey = "";
    finalResultsPreviewOpen = false;
    optimisticAnswer = null;
    lastRank = -1;
    behindPhaseCandidate = null;
    latestObservedAt = initialSnapshot ? Date.now() : 0;
    getEl<HTMLInputElement>("answer-input").value = "";
    getEl<HTMLInputElement>("final-wager-input").value = "0";
    setGameControls("hidden");
    renderKnownGames();
    if (initialSnapshot) {
        recordFirstGameSnapshot();
        render(initialSnapshot);
    }
    startGamePolling();
    // Joining, creating, rejoining, and invite links all converge here. Set
    // up the reusable narrow session in the background without holding the
    // party flow hostage if the host cannot provide it.
    startDefaultInstantPlay();
}

function leaveGame({ preserveSavedGame = false }: { preserveSavedGame?: boolean } = {}): void {
    gameSession += 1;
    // Any allowance/setup work tied to the room we just left must not resume
    // into a later screen. A new room will queue its own attempt.
    pendingInstantPlayRequest = null;
    const departingGameId = gameId;
    gameId = null;
    gameSettingsOpen = false;
    pendingAbandonedForfeit = null;
    latest = null;
    selectedWager = null;
    selectedDifficulty = null;
    activeAnswerKey = "";
    activeFinalWagerKey = "";
    finalResultsPreviewOpen = false;
    optimisticAnswer = null;
    latestObservedAt = 0;
    gameEntryMark = null;
    awaitingFirstGameSnapshot = false;
    if (!preserveSavedGame && departingGameId !== null) forgetKnownGame(departingGameId);
    if ($forfeitDialog.open) $forfeitDialog.close();
    setTransactionStatus(null);
    setGameControls("hidden");
    stopGamePolling();
    void refreshPacks();
    showScreen("home");
    renderKnownGames();
    refreshKnownGames();
}

function isCurrentGame(id: bigint, session: number): boolean {
    return gameId === id && gameSession === session;
}

function recordFirstGameSnapshot(): void {
    if (!awaitingFirstGameSnapshot || gameEntryMark === null) return;
    const snapshotMark = performanceMark("game:first-snapshot");
    performanceMeasure("game:time-to-first-snapshot", gameEntryMark, snapshotMark);
    awaitingFirstGameSnapshot = false;
    gameEntryMark = null;
}

getEl("btn-back-home").addEventListener("click", () => {
    // A locally opened final scorecard is not yet a finished game. Preserve
    // it in the return list if the player heads home before everyone marks
    // ready, rather than making the preview a one-way exit.
    const preserveSavedGame = finalResultsPreviewOpen && latest?.phase.stage === STAGE_FINAL_REVIEW;
    leaveGame({ preserveSavedGame });
});
getEl("btn-abandoned-home").addEventListener("click", () => leaveGame());

function returnToCurrentGame(): void {
    if (!latest) return;
    gameSettingsOpen = false;
    render(latest);
}

function openGameSettings(): void {
    if (!latest || !isSettingsStage(latest.phase.stage)) return;
    if (busy) {
        setTransactionStatus("Finishing your last action…");
        return;
    }
    getEl("settings-action-error").textContent = "";
    gameSettingsOpen = true;
    render(latest);
}

function openForfeitDialog(): void {
    if (busy || gameId === null || !latest) return;
    getEl("forfeit-error").textContent = "";
    if (!$forfeitDialog.open) $forfeitDialog.showModal();
}

async function leaveLobby(buttonId: "btn-leave-lobby" | "btn-settings-leave-lobby"): Promise<void> {
    if (busy || gameId === null || !productAccount) return;
    busy = true;
    setLoading(buttonId, true);
    try {
        await sendTx(game, "leaveLobby", gameId);
        leaveGame();
    } catch (e) {
        const message = friendlyError(e);
        getEl("lobby-error").textContent = message;
        getEl("settings-action-error").textContent = message;
    } finally {
        busy = false;
        setLoading(buttonId, false);
    }
}

getEl("btn-leave-lobby").addEventListener("click", () => void leaveLobby("btn-leave-lobby"));
$btnGameSettings.addEventListener("click", openGameSettings);
getEl("btn-settings-return-top").addEventListener("click", returnToCurrentGame);
getEl("btn-settings-return").addEventListener("click", returnToCurrentGame);
getEl("btn-settings-back-home").addEventListener("click", () => {
    // Returning to the home screen is navigation, not a forfeit. The game
    // remains in the durable recovery list until the player truly leaves it.
    leaveGame({ preserveSavedGame: true });
});
getEl("btn-settings-leave-lobby").addEventListener("click", () => void leaveLobby("btn-settings-leave-lobby"));
getEl("btn-settings-forfeit").addEventListener("click", openForfeitDialog);

getEl("btn-cancel-forfeit").addEventListener("click", () => {
    if ($forfeitDialog.open) $forfeitDialog.close();
});

getEl("btn-confirm-forfeit").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount) return;
    const id = gameId;
    busy = true;
    setLoading("btn-confirm-forfeit", true);
    try {
        await sendTx(game, "forfeitGame", id);
        if ($forfeitDialog.open) $forfeitDialog.close();
        const phaseRes = await game.getPhase.query(id);
        if (phaseRes.success && (phaseRes.value as PhaseView).stage === STAGE_ABANDONED) {
            // This player was the last active participant. Their membership
            // is gone, but preserve the terminal scorecard for this view.
            pendingAbandonedForfeit = id;
            forgetKnownGame(id);
            gameSettingsOpen = false;
            setGameControls("hidden");
            void poll();
        } else {
            leaveGame();
            $homeError.textContent = "You forfeited this quiz. Your score remains on its scorecard.";
        }
    } catch (e) {
        getEl("forfeit-error").textContent = friendlyError(e);
    } finally {
        busy = false;
        setLoading("btn-confirm-forfeit", false);
    }
});

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && gameId !== null) void poll();
});
// Embedded mobile hosts do not always emit a visibility transition when a
// user returns to the app. Reconcile on the browser lifecycle signals too.
window.addEventListener("pageshow", () => {
    if (gameId !== null) void poll();
});
window.addEventListener("focus", () => {
    if (gameId !== null) void poll();
});

function questionKeyFor(phase: PhaseView): number {
    return phase.stage === STAGE_ANSWER || phase.stage === STAGE_REVIEW
        ? phase.cursor
        : FINAL_QKEY;
}

/** Total order over a game's forward progression, for stale-poll detection. */
function stageRank(phase: PhaseView): number {
    if (phase.stage === STAGE_LOBBY) return 0;
    if (phase.stage === STAGE_ANSWER || phase.stage === STAGE_REVIEW) {
        return 1 + phase.cursor * 2 + (phase.stage === STAGE_REVIEW ? 1 : 0);
    }
    return 1_000 + phase.stage; // vote → final answer → final review → finished
}

/**
 * Rebuild the used-wager map from past questions (rejoin/refresh safe),
 * then keep it current from the live snapshot (overturns can flip the
 * current question's outcome during review).
 */
async function syncWagerHistory(snap: Snapshot, id: bigint, session: number): Promise<void> {
    if (!isCurrentGame(id, session) || latest !== snap) return;
    const completedRegular = snap.phase.stage === STAGE_LOBBY
        ? 0
        : snap.phase.stage === STAGE_ANSWER
          ? snap.phase.cursor
          : snap.phase.stage === STAGE_REVIEW
            ? snap.phase.cursor + 1
            : snap.game.num_questions;
    const keys = Array.from(
        { length: Math.max(0, Math.min(completedRegular, snap.game.num_questions) - wagerHistoryLoadedUpTo - 1) },
        (_, i) => wagerHistoryLoadedUpTo + 1 + i,
    );
    const results = await Promise.all(
        keys.map((key) => retryChainRead<any>(() => game.getSubmissions.query(id, key))),
    );
    for (let i = 0; i < results.length; i++) {
        if (!isCurrentGame(id, session) || latest !== snap) return;
        const res = results[i];
        if (!res.success) return;
        const mine = (res.value as SubmissionView[]).find(
            (s) => s.player.toLowerCase() === myAddress,
        );
        if (mine?.submitted) wagerOutcomes.set(mine.wager, mine.correct);
        wagerHistoryLoadedUpTo = keys[i];
    }
    // live update for the question currently on the table (regular only)
    if (isCurrentGame(id, session) && latest === snap && (snap.phase.stage === STAGE_ANSWER || snap.phase.stage === STAGE_REVIEW)) {
        const mine = snap.submissions.find((s) => s.player.toLowerCase() === myAddress);
        if (mine?.submitted) wagerOutcomes.set(mine.wager, mine.correct);
    }
}

/** The finished scorecard needs the selected final prompt even without a live slot. */
function snapshotQuestionSlot(phase: PhaseView): number | null {
    if (phase.slot !== NO_SLOT) return phase.slot;
    return phase.stage === STAGE_FINISHED
        && phase.final_difficulty >= 0
        && phase.final_difficulty < DIFFICULTY_NAMES.length
        ? FINAL_SLOT_BASE + phase.final_difficulty
        : null;
}

function phaseNeedsCanonicalAnswer(stage: number): boolean {
    return stage === STAGE_REVIEW || stage === STAGE_FINAL_REVIEW || stage === STAGE_FINISHED;
}

/**
 * Phase data comes from one game-contract read and always wins the first
 * paint. Question wording is enriched after that render so an overloaded
 * registry cannot strand one player on an earlier multiplayer phase.
 */
function hydrateSnapshotContent(snap: Snapshot, id: bigint, session: number): void {
    const slot = snapshotQuestionSlot(snap.phase);
    if (slot === null) return;
    const needsAnswer = phaseNeedsCanonicalAnswer(snap.phase.stage);
    if (snap.questionText && (!needsAnswer || snap.answerText)) return;

    hydrateLiveSnapshotContent(
        snap,
        async () => {
            const [question, answer] = await Promise.all([
                snap.questionText || questionText(snap.game.pack_id, slot),
                needsAnswer
                    ? snap.answerText || canonicalAnswer(snap.game.pack_id, slot)
                    : Promise.resolve(""),
            ]);
            return { question, answer };
        },
        (candidate) => isCurrentGame(id, session) && latest === candidate,
        (candidate, content) => {
            if (candidate.questionText === content.question && candidate.answerText === content.answer) return;
            candidate.questionText = content.question;
            candidate.answerText = content.answer;
            render(candidate);
        },
        (error) => console.warn("quiz content lookup failed", error),
    );
}

async function poll(): Promise<void> {
    if (gameId === null || !game) return;
    if (pollInFlight) {
        // A tx inclusion or best-block notification that arrives while a
        // slower read is in flight must not be lost. Run one fresh poll as
        // soon as the old response has been discarded/applied.
        pollQueued = true;
        return;
    }
    const polledGameId = gameId;
    const polledSession = gameSession;
    const polledDisplayNameRevision = displayNameRevision;
    pollInFlight = true;
    try {
        const liveResult = await withTimeout(
            retryChainRead<any>(() => game.getLiveGame.query(polledGameId)),
            LIVE_GAME_READ_TIMEOUT_MS,
            "Timed out checking this quiz.",
        );
        if (!isCurrentGame(polledGameId, polledSession) || !liveResult.success) return;
        const live = liveResult.value as LiveGameView;
        const phase: PhaseView = {
            stage: Number(live.stage),
            cursor: Number(live.cursor),
            deadline: BigInt(live.deadline),
            current_block: BigInt(live.current_block),
            final_difficulty: Number(live.final_difficulty),
            slot: Number(live.slot),
            submit_count: Number(live.submit_count),
            continue_count: Number(live.continue_count),
            final_wager_count: Number(live.final_wager_count),
            easy_vote_count: Number(live.easy_vote_count),
            medium_vote_count: Number(live.medium_vote_count),
            hard_vote_count: Number(live.hard_vote_count),
            player_count: Number(live.player_count),
            active_player_count: Number(live.active_player_count),
        };
        const gameView: GameView = {
            pack_id: Number(live.pack_id),
            creator: String(live.creator).toLowerCase(),
            num_questions: Number(live.num_questions),
            answer_blocks: Number(live.answer_blocks),
            review_blocks: Number(live.review_blocks),
            max_players: Number(live.max_players),
            player_count: Number(live.player_count),
            active_player_count: Number(live.active_player_count),
        };
        const players = live.players.map((player) => String(player).toLowerCase());
        const playerNames = live.player_names.map((name) => String(name));
        const scores = live.scores.map(Number);
        const difficultyChoices = live.difficulty_choices.map(Number);
        const difficultyVoteLocked = live.difficulty_vote_locked.map(Boolean);
        const finalWagers = live.final_wagers.map(Number);
        const finalWagerLocked = live.final_wager_locked.map(Boolean);
        const submissions = live.submissions.map((submission) => ({
            ...submission,
            player: String(submission.player).toLowerCase(),
            wager: Number(submission.wager),
            overturn_votes: Number(submission.overturn_votes),
        }));

        // Game phases normally move forward. A slow follower can return an
        // older snapshot after another player has advanced the table, so do
        // not immediately pull this device back. A genuine reorg is allowed
        // through only after three advancing, matching observations at an
        // equally new (or newer) block.
        const rank = stageRank(phase);
        if (rank < lastRank) {
            const previousBlock = latest?.phase.current_block ?? 0n;
            const candidate = behindPhaseCandidate;
            const matchesCandidate = candidate !== null
                && candidate.rank === rank
                && candidate.stage === phase.stage
                && candidate.cursor === phase.cursor
                && phase.current_block > candidate.currentBlock;
            behindPhaseCandidate = matchesCandidate
                ? { ...candidate, currentBlock: phase.current_block, sightings: candidate.sightings + 1 }
                : {
                    rank,
                    stage: phase.stage,
                    cursor: phase.cursor,
                    currentBlock: phase.current_block,
                    sightings: 1,
                };
            if (behindPhaseCandidate.sightings < 3 || phase.current_block < previousBlock) return;
            lastRank = rank;
            behindPhaseCandidate = null;
        } else {
            behindPhaseCandidate = null;
            if (rank === lastRank && latest !== null && phase.current_block < latest.phase.current_block) return;
            lastRank = Math.max(lastRank, rank);
        }

        const normalizedPlayerNames = playerNames.length === players.length
            ? playerNames
            : Array.from({ length: players.length }, () => "");
        const myPlayerIndex = players.findIndex((player) => player.toLowerCase() === myAddress);
        if (myPlayerIndex >= 0 && normalizedPlayerNames[myPlayerIndex] !== undefined) {
            applyOnChainDisplayName(normalizedPlayerNames[myPlayerIndex], polledDisplayNameRevision);
        }
        // A read from just before a successful name save must not make the
        // table briefly revert to a generated name while the next block
        // catches up. Other players always retain their chain values.
        const visiblePlayerNames = [...normalizedPlayerNames];
        if (myPlayerIndex >= 0 && pendingDisplayName !== null) {
            visiblePlayerNames[myPlayerIndex] = myDisplayName;
        }
        const friendlyPlayerLabels = resolvePlayerLabels(players, visiblePlayerNames);

        const questionSlot = snapshotQuestionSlot(phase);
        const contentKey = questionSlot === null
            ? null
            : registryQuestionCacheKey(gameView.pack_id, questionSlot);
        const qText = contentKey === null ? "" : questionCache.get(contentKey) ?? "";
        const aText = contentKey === null || !phaseNeedsCanonicalAnswer(phase.stage)
            ? ""
            : answerCache.get(contentKey) ?? "";

        const snap: Snapshot = {
            phase,
            game: gameView,
            players,
            playerNames: visiblePlayerNames,
            playerLabels: friendlyPlayerLabels,
            scores,
            difficultyChoices,
            difficultyVoteLocked,
            finalWagers,
            finalWagerLocked,
            submissions,
            questionText: qText,
            answerText: aText,
        };
        const mine = snap.submissions.find((submission) => submission.player.toLowerCase() === myAddress);
        if (!players.includes(myAddress) || mine?.active === false) {
            if (phase.stage === STAGE_ABANDONED && pendingAbandonedForfeit === polledGameId) {
                latest = snap;
                latestObservedAt = Date.now();
                recordFirstGameSnapshot();
                renderAbandoned(snap);
                return;
            }
            // Another tab can submit a leave/forfeit transaction. Stop this
            // stale table immediately rather than letting it offer actions the
            // contract will correctly reject.
            leaveGame();
            $homeError.textContent = phase.stage === STAGE_ABANDONED
                ? "This quiz was abandoned."
                : "You are no longer an active player in this quiz.";
            return;
        }
        latest = snap;
        latestObservedAt = Date.now();
        consecutivePollFailures = 0;
        recordFirstGameSnapshot();
        // reset per-stage action guards when the stage changes
        const key = `${polledGameId}:${latest.phase.stage}:${latest.phase.cursor}`;
        if (key !== actionKey) {
            actionKey = key;
            actionsSent.clear();
            actionSentAt.clear();
            optimisticAnswer = null;
            selectedDifficulty = null;
            finalResultsPreviewOpen = false;
        }
        const isAnswerStage =
            latest.phase.stage === STAGE_ANSWER || latest.phase.stage === STAGE_FINAL_ANSWER;
        const answerKey = `${polledGameId}:${latest.phase.stage}:${questionKeyFor(latest.phase)}`;
        if (isAnswerStage && answerKey !== activeAnswerKey) {
            activeAnswerKey = answerKey;
            selectedWager = null;
            getEl<HTMLInputElement>("answer-input").value = "";
        }
        const finalWagerKey = `${polledGameId}:${latest.phase.stage}:${latest.phase.cursor}`;
        if (latest.phase.stage === STAGE_FINAL_WAGER && finalWagerKey !== activeFinalWagerKey) {
            activeFinalWagerKey = finalWagerKey;
            getEl<HTMLInputElement>("final-wager-input").value = "0";
        } else if (latest.phase.stage !== STAGE_FINAL_WAGER) {
            activeFinalWagerKey = "";
        }
        // chain caught up with the optimistic echo
        if (optimisticAnswer && mySubmission(latest)?.submitted) {
            optimisticAnswer = null;
        }
        reconcileActionGuards(latest);
        if (actionsSent.size === 0) setTransactionStatus(null);
        render(latest);
        hydrateSnapshotContent(snap, polledGameId, polledSession);
        // Historic wagers matter for controls, not for the first paint. On a
        // rejoin this used to delay the whole table by one serial RPC per
        // completed question.
        void syncWagerHistory(snap, polledGameId, polledSession)
            .then(() => {
                if (isCurrentGame(polledGameId, polledSession) && latest === snap) render(snap);
            })
            .catch((error) => console.warn("wager history sync failed", error));
    } catch (e) {
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= 2) {
            setTransactionStatus("Reconnecting…");
        }
        console.warn("poll failed", e);
    } finally {
        pollInFlight = false;
        // A new session may have started while this request was in flight.
        // Start its first/queued poll immediately instead of waiting for the
        // next block notification.
        if (gameId !== null && (gameSession !== polledSession || pollQueued)) {
            pollQueued = false;
            void poll();
        }
    }
}

function mySubmission(snap: Snapshot): SubmissionView | undefined {
    return snap.submissions.find((s) => s.player.toLowerCase() === myAddress);
}

function render(snap: Snapshot): void {
    if (gameSettingsOpen && isSettingsStage(snap.phase.stage)) {
        renderGameSettings(snap);
        return;
    }
    // A terminal chain transition wins over a locally open settings page.
    // Keeping this explicit avoids stranding a player on stale controls after
    // another participant ends the game.
    if (gameSettingsOpen) gameSettingsOpen = false;
    switch (snap.phase.stage) {
        case STAGE_LOBBY:
            void renderLobby(snap);
            break;
        case STAGE_ANSWER:
        case STAGE_FINAL_ANSWER:
            renderQuestion(snap);
            break;
        case STAGE_REVIEW:
            renderReview(snap);
            break;
        case STAGE_FINAL_REVIEW:
            if (finalResultsPreviewOpen) {
                renderResults(snap, true);
            } else {
                renderReview(snap);
            }
            break;
        case STAGE_VOTE:
            renderVote(snap);
            break;
        case STAGE_FINAL_WAGER:
            renderFinalWager(snap);
            break;
        case STAGE_FINISHED:
            renderResults(snap);
            break;
        case STAGE_ABANDONED:
            renderAbandoned(snap);
            break;
    }
}

function applyGameSettingsPack(packId: number, pack: PackView | null): void {
    const $art = getEl("settings-pack-emoji");
    const $title = getEl("settings-pack-title");
    const $meta = getEl("settings-pack-meta");
    if (!pack) {
        $art.className = "game-settings-pack-art";
        $art.textContent = "✨";
        $title.textContent = packTitleCache.get(registryPackCacheKey(packId)) ?? "Quiz pack";
        $meta.textContent = "Pack details will appear when they’re available.";
        return;
    }
    const presentation = packPresentation({ id: packId, ...pack });
    $art.className = `game-settings-pack-art tone-${presentation.tone}`;
    $art.textContent = presentation.emoji;
    $title.textContent = pack.title;
    $meta.textContent = `${questionCountLabel(pack)}${finalCountLabel(pack)} · ${presentation.category}`;
}

function renderGameSettings(snap: Snapshot): void {
    const currentGameId = gameId;
    if (currentGameId === null) {
        gameSettingsOpen = false;
        render(snap);
        return;
    }
    const isLobby = snap.phase.stage === STAGE_LOBBY;
    setGameControls(isLobby ? "lobby" : "active");
    getEl("settings-game-code").textContent = String(currentGameId);
    getEl("settings-progress").textContent = gameProgressLabel(
        snap.phase.stage,
        snap.phase.cursor,
        snap.game.num_questions,
    );
    getEl("settings-question-count").textContent = gameQuestionCountLabel(snap.game.num_questions);
    getEl("settings-answer-pace").textContent = gamePaceLabel(snap.game.answer_blocks, ANSWER_BLOCK_PRESETS);
    getEl("settings-review-pace").textContent = gamePaceLabel(snap.game.review_blocks, REVIEW_BLOCK_PRESETS);
    getEl("settings-player-count").textContent = playerCountLabel(
        snap.phase.active_player_count,
        snap.phase.player_count,
    );
    syncDisplayNameProfile();

    const $return = getEl<HTMLButtonElement>("btn-settings-return");
    const returnLabel = isLobby ? "Go to lobby" : "Return to game";
    $return.textContent = returnLabel;
    getEl("btn-settings-return-top").setAttribute("aria-label", returnLabel);
    getEl("btn-settings-return-top").setAttribute("title", returnLabel);
    getEl("btn-settings-leave-lobby").style.display = isLobby ? "" : "none";
    getEl("btn-settings-forfeit").style.display = isLobby ? "none" : "";
    getEl("settings-actions-hint").textContent = isLobby
        ? "Back home keeps your place. Leaving the lobby removes you from this game."
        : "Back home keeps your place. Forfeiting permanently removes you from this quiz.";

    const packId = snap.game.pack_id;
    const cached = sealedPackCache.get(registryPackCacheKey(packId));
    if (cached) {
        applyGameSettingsPack(packId, cached);
    } else {
        applyGameSettingsPack(packId, null);
        const sessionAtRequest = gameSession;
        void gameSettingsPack(packId).then((pack) => {
            if (
                gameSettingsOpen
                && isCurrentGame(currentGameId, sessionAtRequest)
                && latest === snap
            ) {
                applyGameSettingsPack(packId, pack);
            }
        }).catch(() => {
            // The useful game details above never depend on a cosmetic pack read.
        });
    }
    showScreen("game-settings");
    renderQuickPlayStatus();
}

// ── Lobby ────────────────────────────────────────────────────────────

let lastStartGameWarmPlayers = -1;

function renderLobby(snap: Snapshot): void {
    const lobbyGameId = gameId;
    const lobbySession = gameSession;
    if (lobbyGameId === null) return;
    getEl("lobby-game-id").textContent = String(lobbyGameId);
    // Never make the room wait on a cosmetic title lookup. Hosts normally
    // have it cached from the pack picker; joiners see a stable fallback for
    // one RPC round-trip and then the real title replaces it.
    getEl("lobby-title").textContent = packTitleCache.get(registryPackCacheKey(snap.game.pack_id)) ?? "Quiz night";
    const starter = snap.players[0] ?? "";
    renderList(
        getEl("lobby-players"),
        snap.players.map((p) =>
            li(
                span("", fmtPlayer(snap, p)),
                span("sub", p.toLowerCase() === starter.toLowerCase() ? "can start when ready" : ""),
            ),
        ),
    );
    const isStarter = starter.toLowerCase() === myAddress;
    getEl("btn-start-game").style.display = isStarter ? "" : "none";
    getEl("lobby-waiting").style.display = isStarter ? "none" : "";
    getEl("lobby-waiting").textContent = starter
        ? `Waiting for ${fmtPlayer(snap, starter)} to start…`
        : "Waiting for a player to start…";
    const activePlayers = snap.phase.active_player_count;
    getEl("lobby-occupancy").textContent = `${activePlayers} ${activePlayers === 1 ? "player" : "players"}`;
    setGameControls("lobby");
    showScreen("lobby");

    if (isStarter) {
        // A startGame estimate scales with the roster. Joining players would
        // otherwise reuse a stale small-lobby estimate for up to the warm
        // TTL, which under-sizes the padded limit.
        if (lastStartGameWarmPlayers !== snap.phase.player_count) {
            lastStartGameWarmPlayers = snap.phase.player_count;
            txPreflights.delete(preflightKey(transactionActor(game, "startGame"), "startGame", [lobbyGameId]));
        }
        void warmTx(game, "startGame", [lobbyGameId]);
    }

    void packTitle(snap.game.pack_id).then((title) => {
        // A title fetch can finish after the game advances or the player
        // leaves. Update only the still-current lobby, never regress screens.
        if (isCurrentGame(lobbyGameId, lobbySession) && latest === snap && snap.phase.stage === STAGE_LOBBY) {
            getEl("lobby-title").textContent = title;
        }
    }).catch(() => {
        // The fallback title is intentionally sufficient.
    });
}

async function shareLobbyInvite(): Promise<void> {
    if (gameId === null) return;
    const $button = getEl<HTMLButtonElement>("btn-share-lobby");
    const $feedback = getEl("lobby-share-feedback");
    const $shareLink = getEl<HTMLInputElement>("lobby-share-link");
    const packTitle = getEl("lobby-title").textContent?.trim() || "Quizzler";
    const url = sharedLobbyInviteUrl(window.location.href, gameId);
    const shareData = {
        title: "Join my Quizzler game",
        text: `Join my ${packTitle} quiz on Quizzler. Game code: ${gameId}.`,
        url,
    };

    $feedback.textContent = "";
    $shareLink.hidden = true;
    $button.disabled = true;
    try {
        if (typeof navigator.share === "function") {
            try {
                await navigator.share(shareData);
                $feedback.textContent = "Invite shared.";
                return;
            } catch (e) {
                // Cancelling the native share sheet is intentional, not an error.
                if (e instanceof DOMException && e.name === "AbortError") return;
            }
        }

        if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable");
        await navigator.clipboard.writeText(url);
        $feedback.textContent = "Invite link copied.";
    } catch {
        // Some embedded hosts block the Clipboard API. Leave a focused,
        // selected field so the player can still copy the exact public link.
        $shareLink.value = url;
        $shareLink.hidden = false;
        $shareLink.focus();
        $shareLink.select();
        $feedback.textContent = "Copy the selected invite link.";
    } finally {
        $button.disabled = false;
    }
}

getEl<HTMLButtonElement>("btn-share-lobby").addEventListener("click", () => {
    void shareLobbyInvite();
});

/**
 * `startGame` has just landed in a best block. The lobby snapshot already
 * contains enough information to leave the lobby, so switch screens now
 * instead of waiting for the reconciliation poll. The shuffled first slot is
 * chain-authoritative, so controls remain locked until that snapshot arrives.
 */
function showStartedGame(): void {
    if (gameId === null || latest?.phase.stage !== STAGE_LOBBY) return;
    const previous = latest;
    const phase: PhaseView = {
        ...previous.phase,
        stage: STAGE_ANSWER,
        cursor: 0,
        deadline: previous.phase.current_block + BigInt(previous.game.answer_blocks),
        slot: NO_SLOT,
        submit_count: 0,
        continue_count: 0,
    };
    const snap: Snapshot = {
        ...previous,
        phase,
        submissions: previous.players.map((player) => ({
            player,
            submitted: false,
            answer: "",
            wager: 0,
            correct: false,
            overturn_votes: 0,
            continue_ready: false,
            active: true,
        })),
        questionText: "",
        answerText: "",
    };
    latest = snap;
    latestObservedAt = Date.now();
    lastRank = Math.max(lastRank, stageRank(phase));
    render(snap);
}

getEl("btn-start-game").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount) return;
    busy = true;
    setLoading("btn-start-game", true);
    try {
        await sendWarmedTx(game, "startGame", [gameId]);
        showStartedGame();
        void poll();
    } catch (e) {
        getEl("lobby-error").textContent = friendlyError(e);
    } finally {
        busy = false;
        setLoading("btn-start-game", false);
    }
});

// ── Countdown (ticks between polls off the latest snapshot) ─────────

function countdownText(snap: Snapshot): string {
    return countdownLabel(
        snap.phase.deadline,
        snap.phase.current_block,
        latestObservedAt > 0 ? Date.now() - latestObservedAt : 0,
    );
}

function updateGameStageTimer(snap: Snapshot): void {
    const text = countdownText(snap);
    $gameStageTimer.textContent = text;
    $gameStageTimer.classList.toggle("urgent", text.startsWith("~") && Number.parseInt(text.slice(1)) <= 15);
}

setInterval(() => {
    if (!latest || gameSettingsOpen || !isActiveGameplayStage(latest.phase.stage)) return;
    updateGameStageTimer(latest);
}, 1_000);

// ── Question screen ──────────────────────────────────────────────────

let $wagerButtons: HTMLButtonElement[] = [];

/** Render exactly one regular-wager choice for every question in this game. */
function ensureWagerButtons(numQuestions: number): void {
    const count = Math.max(1, Math.min(MAX_GAME_QUESTIONS, Math.trunc(numQuestions)));
    if ($wagerButtons.length === count) return;

    if (selectedWager !== null && selectedWager > count) selectedWager = null;
    const buttons: HTMLButtonElement[] = [];
    for (let value = 1; value <= count; value += 1) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wager-btn";
        btn.dataset.wager = String(value);
        btn.dataset.testid = `wager-${value}`;
        btn.textContent = String(value);
        // On a phone this preserves the focused answer field while the wager
        // click lands, so a first tap cannot be swallowed by a blur/reflow.
        btn.addEventListener("pointerdown", (event) => {
            if (document.activeElement === $answerInput) event.preventDefault();
        });
        btn.addEventListener("click", () => {
            if (wagerOutcomes.has(value)) return; // already spent
            selectedWager = value;
            paintWagerGrid();
        });
        buttons.push(btn);
    }
    $wagerButtons = buttons;
    getEl("wager-grid").replaceChildren(...buttons);
}

function paintWagerGrid(): void {
    for (const btn of $wagerButtons) {
        const value = Number(btn.dataset.wager);
        const outcome = wagerOutcomes.get(value);
        const selected = selectedWager === value && outcome === undefined;
        btn.classList.toggle("used-correct", outcome === true);
        btn.classList.toggle("used-wrong", outcome === false);
        btn.classList.toggle("selected", selected);
        btn.disabled = outcome !== undefined;
        btn.setAttribute("aria-pressed", String(selected));
        btn.setAttribute(
            "aria-label",
            outcome === undefined
                ? `Wager ${value}${selected ? ", selected" : ""}`
                : `Wager ${value}, already used and ${outcome ? "correct" : "incorrect"}`,
        );
    }
}

function renderQuestion(snap: Snapshot): void {
    const isFinal = snap.phase.stage === STAGE_FINAL_ANSWER;
    getEl<HTMLButtonElement>("btn-submit-answer").textContent = isFinal ? "Submit final answer" : "Submit answer";
    const questionReady = snap.questionText.length > 0;
    getEl("question-number").textContent = isFinal
        ? `Final question · ${DIFFICULTY_NAMES[snap.phase.final_difficulty] ?? ""}`
        : `${snap.phase.cursor + 1} of ${snap.game.num_questions}`;
    // A shape-matching skeleton, not placeholder prose — the question arrives
    // within a poll or two and the swap should read as a reveal.
    const $questionText = getEl("question-text");
    $questionText.textContent = questionReady ? snap.questionText : "";
    $questionText.classList.toggle("skeleton", !questionReady);

    const mine = mySubmission(snap);
    const amActive = mine?.active ?? false;
    const optimistic =
        optimisticAnswer !== null && optimisticAnswer.qkey === questionKeyFor(snap.phase);
    const answered = (mine?.submitted ?? false) || optimistic;
    getEl("answer-form").style.display = answered || !questionReady || !amActive ? "none" : "";
    getEl("submitted-card").style.display = answered ? "" : "none";

    if (!answered && amActive) {
        getEl("wager-grid-block").style.display = isFinal ? "none" : "";
        getEl("final-wager-locked").style.display = isFinal ? "flex" : "none";
        if (isFinal) {
            const myIdx = snap.players.indexOf(myAddress);
            const finalWager = myIdx >= 0 ? snap.finalWagers[myIdx] ?? 0 : 0;
            getEl("final-wager-locked-value").textContent = String(finalWager);
        } else {
            ensureWagerButtons(snap.game.num_questions);
            paintWagerGrid();
        }
    } else {
        getEl("final-wager-locked").style.display = "none";
        // Sporcle Party-style live reveal: players can see answers and wagers
        // as teammates lock in, while correctness stays hidden until review.
        renderList(
            getEl("live-answers"),
            snap.submissions.map((s) => {
                const pendingMine =
                    s.player.toLowerCase() === myAddress && !s.submitted && optimistic;
                const text = !s.active
                    ? s.submitted
                        ? `“${s.answer}” · left quiz`
                        : "left quiz"
                    : s.submitted
                    ? `“${s.answer}” · wagered ${s.wager}`
                    : pendingMine
                      ? `“${optimisticAnswer?.answer}” · wagered ${optimisticAnswer?.wager} · confirming…`
                      : "…";
                const identity = document.createElement("span");
                identity.className = "answer-row-identity";
                identity.append(span("answer-row-player", fmtPlayer(snap, s.player)));
                const row = li(identity, span("live-answer-text", text));
                row.className = "live-answer-row";
                return row;
            }),
        );
    }
    setGameControls("active");
    updateGameStageTimer(snap);
    showScreen("question");
}

getEl("btn-submit-answer").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount || !latest) return;
    if (!mySubmission(latest)?.active) return;
    const $err = getEl("question-error");
    $err.textContent = "";
    const isFinal = latest.phase.stage === STAGE_FINAL_ANSWER;
    const answer = normalizeAnswer(getEl<HTMLInputElement>("answer-input").value);
    if (!answer) {
        $err.textContent = "Enter an answer using letters or numbers.";
        return;
    }
    let wager: number;
    if (isFinal) {
        const myIndex = latest.players.indexOf(myAddress);
        if (myIndex < 0 || !latest.finalWagerLocked[myIndex]) {
            $err.textContent = "Your final wager has not been locked yet.";
            return;
        }
        wager = latest.finalWagers[myIndex] ?? 0;
    } else {
        if (selectedWager === null) {
            $err.textContent = "Pick a wager first — each number can be used once per game.";
            return;
        }
        wager = selectedWager;
    }
    if (actionsSent.has("submit")) return;
    // Optimistic: flip to the submitted view immediately; roll back on error.
    markActionSent("submit");
    optimisticAnswer = { qkey: questionKeyFor(latest.phase), answer, wager };
    render(latest);
    busy = true;
    try {
        if (isFinal) {
            await sendTx(game, "submitFinalAnswer", gameId, answer);
        } else {
            await sendTx(game, "submitAnswer", gameId, answer, wager);
        }
        selectedWager = null;
        getEl<HTMLInputElement>("answer-input").value = "";
        void poll();
    } catch (e) {
        clearActionSent("submit");
        optimisticAnswer = null;
        $err.textContent = friendlyError(e);
        if (latest) render(latest);
    } finally {
        busy = false;
    }
});

getEl<HTMLInputElement>("answer-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        getEl<HTMLButtonElement>("btn-submit-answer").click();
    }
});

// Mobile browsers may scroll a focused text input into view after opening the
// software keyboard. Keep the one stable answer layout and only reset the
// internal question scroller; no focus-only content swap is needed.
const $answerInput = getEl<HTMLInputElement>("answer-input");
function keepQuestionVisibleForKeyboard(): void {
    if (document.activeElement !== $answerInput) return;
    getEl("screen-question").querySelector<HTMLElement>(".game-stage-content")
        ?.scrollTo({ top: 0, behavior: "auto" });
}
function scheduleQuestionVisibilityForKeyboard(): void {
    window.requestAnimationFrame(() => {
        keepQuestionVisibleForKeyboard();
        window.requestAnimationFrame(keepQuestionVisibleForKeyboard);
    });
}
$answerInput.addEventListener("focus", () => {
    if (!window.matchMedia("(max-width: 599px)").matches) return;
    scheduleQuestionVisibilityForKeyboard();
});
window.visualViewport?.addEventListener("resize", scheduleQuestionVisibilityForKeyboard);

// ── Final wager ─────────────────────────────────────────────────────

function renderFinalWager(snap: Snapshot): void {
    const myIndex = snap.players.indexOf(myAddress);
    const amActive = mySubmission(snap)?.active ?? false;
    const score = myIndex >= 0 ? snap.scores[myIndex] ?? 0 : 0;
    const wager = myIndex >= 0 ? snap.finalWagers[myIndex] ?? 0 : 0;
    const locked = myIndex >= 0 && Boolean(snap.finalWagerLocked[myIndex]);
    const $input = getEl<HTMLInputElement>("final-wager-input");
    const $button = getEl<HTMLButtonElement>("btn-confirm-final-wager");
    const $maxButton = getEl<HTMLButtonElement>("btn-max-final-wager");

    getEl("final-wager-difficulty-value").textContent =
        DIFFICULTY_NAMES[snap.phase.final_difficulty] ?? "—";
    getEl("final-wager-score").textContent = String(score);
    getEl("final-wager-max").textContent = String(score);
    $input.max = String(score);
    $input.disabled = locked || !amActive || busy;
    $maxButton.disabled = locked || !amActive || busy || actionsSent.has("final-wager");
    $maxButton.setAttribute("aria-label", `Set wager to the maximum: ${score} points`);
    if (locked) $input.value = String(wager);

    const waiting = `${snap.phase.final_wager_count}/${snap.phase.active_player_count} active players locked in`;
    getEl("final-wager-status").textContent = locked
        ? `Your wager is locked · ${waiting}`
        : actionsSent.has("final-wager")
          ? "Locking in your wager…"
          : waiting;
    $button.disabled = locked || !amActive || busy || actionsSent.has("final-wager");
    $button.textContent = !amActive
        ? "You left this quiz"
        : locked
          ? "Wager locked"
          : "Lock in wager";

    // Once this player has locked their own wager, warming the chosen prompt
    // removes the final-round loading beat without revealing it to anyone
    // who is still deciding their stake.
    if (locked && snap.phase.final_difficulty >= 0 && snap.phase.final_difficulty < 3) {
        void questionText(snap.game.pack_id, FINAL_SLOT_BASE + snap.phase.final_difficulty).catch(() => {
            // The final-answer snapshot remains the source of truth and will retry.
        });
    }

    renderLeaderboard(getEl("final-wager-leaderboard"), snap);
    setGameControls("active");
    updateGameStageTimer(snap);
    showScreen("final-wager");
}

getEl("btn-confirm-final-wager").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount || !latest) return;
    if (latest.phase.stage !== STAGE_FINAL_WAGER || !mySubmission(latest)?.active) return;
    if (actionsSent.has("final-wager")) return;

    const $error = getEl("final-wager-error");
    const myIndex = latest.players.indexOf(myAddress);
    const score = myIndex >= 0 ? latest.scores[myIndex] ?? 0 : 0;
    const wager = parseIntegerInRange(getEl<HTMLInputElement>("final-wager-input").value, 0, score);
    if (wager === null) {
        $error.textContent = `Choose a whole-number wager from 0 to ${score}.`;
        return;
    }

    $error.textContent = "";
    markActionSent("final-wager");
    busy = true;
    render(latest);
    try {
        await sendTx(game, "submitFinalWager", gameId, wager);
        void poll();
    } catch (e) {
        clearActionSent("final-wager");
        $error.textContent = friendlyError(e);
        if (latest) render(latest);
    } finally {
        busy = false;
        if (latest) render(latest);
    }
});

getEl("btn-max-final-wager").addEventListener("click", () => {
    if (!latest || latest.phase.stage !== STAGE_FINAL_WAGER || busy) return;
    if (!mySubmission(latest)?.active) return;
    const myIndex = latest.players.indexOf(myAddress);
    if (myIndex < 0 || latest.finalWagerLocked[myIndex]) return;
    const max = Math.max(0, latest.scores[myIndex] ?? 0);
    getEl<HTMLInputElement>("final-wager-input").value = String(max);
    getEl("final-wager-error").textContent = "";
});

// ── Review screen ────────────────────────────────────────────────────

function renderReview(snap: Snapshot): void {
    const isFinal = snap.phase.stage === STAGE_FINAL_REVIEW;
    getEl("review-number").textContent = isFinal
        ? "Final question — results"
        : `${snap.phase.cursor + 1} of ${snap.game.num_questions} — results`;
    getEl("review-question").textContent = snap.questionText;

    // The canonical answer comes from the registry (fetched only during
    // review) — never inferred from players' submissions.
    getEl("review-answer").textContent = snap.answerText || "—";
    getEl("review-difficulty").textContent = isFinal
        ? `Difficulty: ${DIFFICULTY_NAMES[snap.phase.final_difficulty] ?? ""}`
        : "";

    const mine = mySubmission(snap);
    const amActive = mine?.active ?? false;
    renderList(
        getEl("review-rows"),
        snap.submissions.map((s) => {
            const isMe = s.player.toLowerCase() === myAddress;
            const eligibleVoters = snap.phase.active_player_count - (s.active ? 1 : 0);
            const threshold = Math.floor(eligibleVoters / 2) + 1;
            const identity = document.createElement("span");
            identity.className = "answer-row-identity";
            identity.append(span("answer-row-player", fmtPlayer(snap, s.player)));
            const ready = s.active && (s.continue_ready || (isMe && actionsSent.has("continue")));
            if (ready) {
                const marker = span("answer-row-ready", "✓");
                marker.dataset.testid = `review-ready-${s.player.toLowerCase()}`;
                marker.setAttribute("aria-label", "Ready for the next question");
                marker.setAttribute("title", "Ready for the next question");
                identity.append(marker);
            }
            if (!s.active) identity.append(span("sub", "left quiz"));
            const row = li(identity);
            row.className = "answer-row";
            if (!s.submitted) {
                row.append(
                    span("player-answer wrong grow", "No answer"),
                    span("wager-badge wrong", "0"),
                );
                return row;
            }
            row.append(
                span("sr-only", s.correct ? "Correct answer. " : "Incorrect answer. "),
                span(`player-answer ${s.correct ? "correct" : "wrong"} grow`, s.answer || "—"),
            );
            if (!s.correct && !isMe && amActive) {
                const btn = document.createElement("button");
                btn.className = "vote-btn";
                btn.dataset.testid = `btn-vote-${s.player.toLowerCase()}`;
                const voted = actionsSent.has(`vote:${s.player.toLowerCase()}`);
                btn.textContent = voted
                    ? `voted (${s.overturn_votes}/${threshold})`
                    : `mark correct (${s.overturn_votes}/${threshold})`;
                btn.disabled = voted || busy;
                btn.addEventListener("click", () => void voteCorrect(s.player));
                row.classList.add("has-vote-action");
                row.append(btn);
            }
            row.append(span(`wager-badge ${s.correct ? "correct" : "wrong"}`, String(s.wager)));
            return row;
        }),
    );

    const continued = (mine?.continue_ready ?? false) || actionsSent.has("continue");
    const $btn = getEl<HTMLButtonElement>("btn-continue");
    const $viewResults = getEl<HTMLButtonElement>("btn-view-final-results");
    // The final answer has already settled everyone's score. Unlike a regular
    // review, it has no next party action to coordinate, so people can open
    // the results immediately rather than marking themselves ready first.
    $btn.style.display = isFinal ? "none" : "";
    $btn.disabled = isFinal || continued || !amActive;
    $btn.textContent = !amActive
        ? "You left this quiz"
        : continued
          ? "Waiting for others…"
          : reviewContinueLabel(snap.phase.stage, snap.phase.cursor, snap.game.num_questions);
    $btn.classList.toggle("primary", !isFinal);
    $btn.classList.toggle("quiet", isFinal);
    $viewResults.style.display = isFinal ? "" : "none";
    $viewResults.disabled = !isFinal;
    $viewResults.classList.toggle("primary", isFinal);
    $viewResults.classList.toggle("quiet", !isFinal);
    getEl("continue-status").style.display = isFinal ? "none" : "";
    getEl("continue-status").textContent = isFinal
        ? ""
        : `${snap.phase.continue_count}/${snap.phase.active_player_count} active players ready`;
    getEl("review-ready-legend").style.display = isFinal ? "none" : "";

    renderLeaderboard(getEl("review-leaderboard"), snap);
    setGameControls("active");
    updateGameStageTimer(snap);
    showScreen("review");
}

async function voteCorrect(target: string): Promise<void> {
    if (busy || gameId === null || !productAccount) return;
    if (!latest || !mySubmission(latest)?.active) return;
    const key = `vote:${target.toLowerCase()}`;
    if (actionsSent.has(key)) return;
    // optimistic: mark the vote instantly, roll back on error
    markActionSent(key);
    if (latest) render(latest);
    busy = true;
    try {
        await sendTx(game, "voteCorrect", gameId, target);
        void poll();
    } catch (e) {
        const message = txError(e);
        if (message.includes("AlreadyVoted")) {
            // A rejoined player has no local vote history, but this revert is
            // authoritative confirmation that their earlier vote is on-chain.
            getEl("review-error").textContent = "Your vote is already recorded.";
        } else {
            clearActionSent(key);
            getEl("review-error").textContent = friendlyError(e);
        }
        if (latest) render(latest);
    } finally {
        busy = false;
    }
}

getEl("btn-continue").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount || actionsSent.has("continue")) return;
    if (!latest || !mySubmission(latest)?.active) return;
    // optimistic: show "Waiting for others…" instantly, roll back on error
    markActionSent("continue");
    if (latest) render(latest);
    busy = true;
    try {
        await sendTx(game, "readyContinue", gameId);
        void poll();
    } catch (e) {
        clearActionSent("continue");
        getEl("review-error").textContent = friendlyError(e);
        if (latest) render(latest);
    } finally {
        busy = false;
    }
});

getEl("btn-view-final-results").addEventListener("click", () => {
    if (!latest || latest.phase.stage !== STAGE_FINAL_REVIEW) return;
    finalResultsPreviewOpen = true;
    render(latest);
});

getEl("btn-results-back-to-final-review").addEventListener("click", () => {
    if (!latest || latest.phase.stage !== STAGE_FINAL_REVIEW) return;
    finalResultsPreviewOpen = false;
    render(latest);
});

// ── Difficulty vote ──────────────────────────────────────────────────

function renderVote(snap: Snapshot): void {
    const amActive = mySubmission(snap)?.active ?? false;
    const myIndex = snap.players.indexOf(myAddress);
    const voteLocked = myIndex >= 0 && Boolean(snap.difficultyVoteLocked[myIndex]);
    const lockedChoice = myIndex >= 0 ? snap.difficultyChoices[myIndex] : null;
    const counts = [
        snap.phase.easy_vote_count,
        snap.phase.medium_vote_count,
        snap.phase.hard_vote_count,
    ];
    const countNames = ["easy", "medium", "hard"];
    const total = counts.reduce((sum, count) => sum + count, 0);
    const leading = Math.max(...counts);
    const denominator = Math.max(1, snap.phase.active_player_count);

    getEl("vote-status").textContent =
        `${total}/${snap.phase.active_player_count} active players voted` +
        (voteLocked || actionsSent.has("difficulty") ? " — your vote is in" : "");
    getEl("vote-distribution-total").textContent = `${total} ${total === 1 ? "vote" : "votes"}`;
    for (let difficulty = 0; difficulty < counts.length; difficulty += 1) {
        const count = counts[difficulty];
        const name = countNames[difficulty];
        const row = getEl(`vote-distribution-${name}`);
        const bar = getEl(`vote-distribution-${name}-bar`);
        const output = getEl(`vote-distribution-${name}-count`);
        row.classList.toggle("is-leading", total > 0 && count === leading);
        bar.style.width = `${Math.round((count / denominator) * 100)}%`;
        output.textContent = String(count);
        output.setAttribute("aria-label", `${DIFFICULTY_NAMES[difficulty]}: ${count} ${count === 1 ? "vote" : "votes"}`);
    }
    for (const btn of document.querySelectorAll<HTMLButtonElement>(".btn-difficulty")) {
        const difficulty = Number(btn.dataset.difficulty);
        const selected = voteLocked ? lockedChoice === difficulty : selectedDifficulty === difficulty;
        btn.disabled = voteLocked || actionsSent.has("difficulty") || !amActive || busy;
        btn.classList.toggle("is-selected", selected);
        btn.setAttribute("aria-pressed", String(selected));
    }
    // Keep the final prompt out of the client until the wager phase is over.
    // The normal final-answer snapshot fetches its chosen question just in
    // time, preserving the intended "wager before prompt" party flow.
    renderLeaderboard(getEl("vote-leaderboard"), snap, { showDifficultyChoices: true });
    setGameControls("active");
    updateGameStageTimer(snap);
    showScreen("vote");
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".btn-difficulty")) {
    btn.addEventListener("click", async () => {
        if (busy || gameId === null || !productAccount || actionsSent.has("difficulty")) return;
        if (!latest || !mySubmission(latest)?.active) return;
        const myIndex = latest.players.indexOf(myAddress);
        if (myIndex >= 0 && latest.difficultyVoteLocked[myIndex]) return;
        // optimistic: lock the vote in visually, roll back on error
        selectedDifficulty = Number(btn.dataset.difficulty);
        markActionSent("difficulty");
        if (latest) render(latest);
        busy = true;
        try {
            await sendTx(game, "voteDifficulty", gameId, Number(btn.dataset.difficulty));
            void poll();
        } catch (e) {
            const message = txError(e);
            if (message.includes("AlreadyVoted")) {
                getEl("vote-error").textContent = "Your vote is already recorded.";
                void poll();
            } else {
                clearActionSent("difficulty");
                selectedDifficulty = null;
                getEl("vote-error").textContent = friendlyError(e);
            }
            if (latest) render(latest);
        } finally {
            busy = false;
        }
    });
}

// ── Results ──────────────────────────────────────────────────────────

function renderLeaderboard(
    list: HTMLElement,
    snap: Snapshot,
    options: { showDifficultyChoices?: boolean } = {},
): void {
    const ranked = snap.players
        .map((p, i) => ({
            player: p,
            index: i,
            score: snap.scores[i],
            active: snap.submissions.find((submission) => submission.player.toLowerCase() === p.toLowerCase())?.active ?? true,
        }))
        // A forfeit is a permanent withdrawal, not a way to keep a leading
        // score and still win. Keep historical rows visible after finish.
        .sort((a, b) => Number(b.active) - Number(a.active) || b.score - a.score);
    renderList(
        list,
        ranked.map((r, i) => {
            const children: Node[] = [
                span("sub", `#${i + 1}`),
                span("", fmtPlayer(snap, r.player)),
                span("sub", r.active ? "" : "left quiz"),
            ];
            if (options.showDifficultyChoices && r.active) {
                const isMe = r.player.toLowerCase() === myAddress;
                const optimisticChoice = isMe && actionsSent.has("difficulty")
                    ? selectedDifficulty
                    : null;
                const choice = r.active && (snap.difficultyVoteLocked[r.index] || optimisticChoice !== null)
                    ? (snap.difficultyVoteLocked[r.index]
                        ? snap.difficultyChoices[r.index]
                        : optimisticChoice)
                    : null;
                const label = choice === null ? "Waiting" : DIFFICULTY_NAMES[choice] ?? "Waiting";
                const choiceBadge = span(
                    `vote-choice${choice === null ? " is-waiting" : ` difficulty-${choice}`}`,
                    label,
                );
                choiceBadge.setAttribute("aria-label", choice === null
                    ? `${fmtPlayer(snap, r.player)} has not voted yet`
                    : `${fmtPlayer(snap, r.player)} voted ${label}`);
                children.push(choiceBadge);
            }
            children.push(span("right pts", `${r.score}`));
            const row = li(...children);
            if (options.showDifficultyChoices && r.active) row.classList.add("vote-standing-row");
            return row;
        }),
    );
}

function applyFinalOutcomeStyle(element: HTMLElement, standing: FinalStanding): void {
    element.classList.toggle("is-won", standing.finalOutcome === "won");
    element.classList.toggle("is-lost", standing.finalOutcome === "lost");
    element.dataset.outcome = standing.finalOutcome;
}

function renderFinalStandings(standings: readonly FinalStanding[], snap: Snapshot): void {
    renderList(
        getEl("results-leaderboard"),
        standings.map((standing) => {
            const placement = standing.placement === null
                ? "—"
                : `${PLACEMENT_TROPHIES[standing.placement]?.emoji ?? ""} #${standing.placement}`.trim();
            const row = li(
                span("result-placement", placement),
                span("", fmtPlayer(snap, standing.player)),
                span("sub", standing.active ? "" : "left quiz"),
                span("right pts results-score", String(standing.score)),
            );
            row.setAttribute("aria-label", `${fmtPlayer(snap, standing.player)}, ${placementText(standing)}, ${standing.score} points`);
            return row;
        }),
    );

    const podium = standings.filter(
        (standing) => standing.active && standing.placement !== null && standing.placement <= 3,
    );
    renderList(
        getEl("results-podium"),
        podium.map((standing) => {
            const placement = standing.placement ?? 0;
            const trophy = PLACEMENT_TROPHIES[placement];
            const row = li(
                span("results-podium-trophy", trophy?.emoji ?? "🏅"),
                span("results-podium-rank", trophy?.label ?? `${ordinal(placement)} place`),
                span("results-podium-player", fmtPlayer(snap, standing.player)),
                span("results-podium-score", `${standing.score} points`),
            );
            row.className = "results-podium-place";
            row.dataset.placement = String(placement);
            row.setAttribute("aria-label", `${trophy?.label ?? `${ordinal(placement)} place`}: ${fmtPlayer(snap, standing.player)}, ${standing.score} points`);
            return row;
        }),
    );

    renderList(
        getEl("results-final-wagers"),
        standings.map((standing) => {
            const details = document.createElement("span");
            details.className = "results-final-wager-player";
            details.append(
                document.createTextNode(fmtPlayer(snap, standing.player)),
                span("results-final-wager-meta", ` · ${finalOutcomeText(standing)}${standing.active ? "" : " · left quiz"}`),
            );
            const value = span("results-wager-value results-final-wager-value", finalWagerValue(standing));
            const row = li(details, value);
            row.className = "results-final-wager-row";
            row.dataset.outcome = standing.finalOutcome;
            row.setAttribute("aria-label", `${fmtPlayer(snap, standing.player)}: ${finalOutcomeText(standing)}, ${finalWagerValue(standing)}`);
            return row;
        }),
    );
}

function renderResults(snap: Snapshot, preview = false): void {
    const standings = rankFinalStandings({
        players: snap.players,
        scores: snap.scores,
        finalWagers: snap.finalWagers,
        submissions: snap.submissions,
    });
    const winners = standings.filter((standing) => standing.active && standing.placement === 1);
    getEl("results-winner").textContent = winners.length > 0
        ? winners.map((standing) => fmtPlayer(snap, standing.player)).join(" & ")
        : "No active players";
    getEl("results-page-eyebrow").textContent = preview ? "Final standings" : "Quiz complete";
    getEl("results-winner-label").textContent = preview ? "Current winner" : "Winner";
    getEl("results-preview-controls").style.display = preview ? "" : "none";

    const mine = standings.find((standing) => standing.player.toLowerCase() === myAddress);
    const myFinalSubmission = snap.submissions.find((submission) => submission.player.toLowerCase() === myAddress);
    if (mine) {
        getEl("results-final-placement").textContent = placementText(mine);
        getEl("results-final-answer").textContent = mine.finalSubmitted
            ? myFinalSubmission?.answer || "—"
            : "No final answer";
        const $wager = getEl("results-final-wager");
        $wager.textContent = finalWagerValue(mine);
        applyFinalOutcomeStyle($wager, mine);
        const $wagerResult = getEl("results-final-wager-result");
        $wagerResult.textContent = finalOutcomeText(mine);
        applyFinalOutcomeStyle($wagerResult, mine);
        getEl("results-final-score").textContent = `${mine.score} points`;
    }
    getEl("results-final-question").textContent = snap.questionText || "Final question";
    getEl("results-final-correct-answer").textContent = snap.answerText || "—";
    renderFinalStandings(standings, snap);
    if (preview) {
        gameSettingsOpen = false;
        setGameControls("hidden");
        showScreen("results");
        return;
    }
    stopGamePolling();
    // A finished quiz is a scorecard, not a room a player can return to.
    // Keep it visible here, but remove it from future recovery choices.
    if (gameId !== null) forgetKnownGame(gameId);
    gameSettingsOpen = false;
    setGameControls("hidden");
    showScreen("results");
}

function renderAbandoned(snap: Snapshot): void {
    getEl("abandoned-message").textContent = "Everyone left this quiz before it finished.";
    renderLeaderboard(getEl("abandoned-leaderboard"), snap);
    stopGamePolling();
    if (gameId !== null) forgetKnownGame(gameId);
    gameSettingsOpen = false;
    setGameControls("hidden");
    showScreen("abandoned");
}

// ── Go ───────────────────────────────────────────────────────────────

init().catch((e) => {
    setConnectionStatus("not connected", "err");
    setBootHeadline("Couldn’t start — try reloading.", true);
    bootLog(`Unhandled init error: ${txError(e)}`, "err");
});
