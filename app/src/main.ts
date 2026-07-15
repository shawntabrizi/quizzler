/**
 * Quizzler — social trivia on Polkadot.
 *
 * Two contracts: the pack REGISTRY (quiz content — packs, questions,
 * answers) and the GAME (lobby, phases, scoring, votes). Game state is
 * polled from the game contract; question text and the review-time
 * canonical answer are read from the registry by (pack_id, slot).
 *
 * Boot follows the product-sdk contracts-demo: SignerManager → product
 * account → chain client → contract handles → account mapping. Answers and
 * correctness are public on-chain. The client reveals submitted answers and
 * wagers after the local player locks in, while keeping correctness for review.
 */

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
import { ss58ToH160, truncateAddress } from "@parity/product-sdk-address";
import { encodeFunctionData, erc20Abi, hexToBytes } from "viem";

import registryAbi from "./abi-registry.json";
import gameAbi from "./abi-game.json";
import sessionRegistryAbi from "./abi-session-registry.json";
import contractInfo from "./contract-address.json";
import {
    ANSWER_BLOCK_PRESETS,
    BLOCK_SECONDS_ESTIMATE,
    isAllowedBlockPreset,
    MAX_LOBBY_PLAYERS,
    presetLabel,
    questionCountOptions,
    REVIEW_BLOCK_PRESETS,
} from "./game-config";
import { activeGameSessionKey, parseStoredGameId } from "./game-session";
import { parseGameCode, parseIntegerInRange, utf8ByteLength } from "./input";
import { consumeSharedLobbyInvite, sharedLobbyInviteUrl } from "./invite";
import { normalizeAnswer } from "./normalize";
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
    packPresentation,
    sectionPacks,
    STARTER_PACK_COUNT,
    type PackListItem,
} from "./pack-presentation";
import { appendLog, getEl, li, renderList, span } from "./ui";

function isContractAddress(value: unknown): value is `0x${string}` {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function sessionRegistryConfigured(): boolean {
    return isContractAddress(activeContracts.sessionRegistry);
}

const configuredRegistry = import.meta.env.VITE_QUIZZLER_REGISTRY;
const configuredGame = import.meta.env.VITE_QUIZZLER_GAME;
const configuredSessionRegistry = import.meta.env.VITE_QUIZZLER_SESSION_REGISTRY;
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

// A test host can inject one isolated pair at build time. There is one active
// contract pair for this unreleased app; lobby links contain only a game code.
const hasContractOverride =
    configuredRegistry !== undefined
    || configuredGame !== undefined
    || configuredSessionRegistry !== undefined;
const activeContracts: {
    registry: string | undefined;
    game: string | undefined;
    sessionRegistry: string | undefined;
} = hasContractOverride
    ? {
        registry: configuredRegistry,
        game: configuredGame,
        sessionRegistry: configuredSessionRegistry,
    }
    : {
        registry: contractInfo.registry,
        game: contractInfo.game,
        sessionRegistry: (contractInfo as { sessionRegistry?: string }).sessionRegistry,
    };

// ── Constants ────────────────────────────────────────────────────────

const STAGE_LOBBY = 0;
const STAGE_ANSWER = 1;
const STAGE_REVIEW = 2;
const STAGE_VOTE = 3;
const STAGE_FINAL_ANSWER = 4;
const STAGE_FINAL_REVIEW = 5;
const STAGE_FINISHED = 6;
const STAGE_ABANDONED = 7;
const FINAL_QKEY = 255;
const FINAL_SLOT_BASE = 0xf0;
const NO_SLOT = 255;
const NO_PACK = 0xffffffff;
const MAX_GAME_QUESTIONS = 10;
const POLL_FALLBACK_MS = 8_000;
const PREFLIGHT_TTL_MS = 5 * 60_000;
const DIFFICULTY_NAMES = ["Easy", "Medium", "Hard"];
const PACK_VIEW_BATCH_SIZE = 32;
const PRODUCT_DERIVATION_INDEX = 0;

// Paseo Next Asset Hub's personhood-backed gas asset. The session setup
// keeps its batch entirely Revive calls (including this ERC-20 transfer), so
// the runtime can charge PGAS without requiring native tokens.
const PGAS_ASSET_ID = 2_000_000_000;
const PGAS_ERC20_PRECOMPILE = "0x7735940000000000000000000000000001200000" as const;
const SESSION_PGAS_BUDGET = 10_000_000_000n;
// Revive calls vary materially with the storage they touch. In particular,
// registering a session writes four mappings and is larger than a normal game
// move, so always dry-run it rather than relying on a static gas guess.
const REVIVE_GAS_MARGIN = 2n;
const REVIVE_STORAGE_MARGIN = 2n;
const MIN_REVIVE_STORAGE_HEADROOM = 1_000_000_000n;

// These are the only calls a session key may make on a Quizzler game. Pack
// authoring, profile changes, lobby management, forfeiting, and creation stay
// on the product account even when instant actions are enabled.
const SESSION_GAME_METHODS = new Set([
    "submitAnswer",
    "voteCorrect",
    "readyContinue",
    "voteDifficulty",
]);

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
    scores: number[];
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
let assetHub: any = null;
let unsafeAssetHub: any = null;
let myAddress = ""; // lowercase H160
let savedGameId: bigint | null = null;
const nextTxNonceByAddress = new Map<string, number>();
const nonceSyncByAddress = new Map<string, Promise<number | null>>();
let gameId: bigint | null = null;
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
    const now = Date.now();
    for (const [action, sentAt] of actionSentAt) {
        if (now - sentAt < 18_000) continue;
        clearActionSent(action);
        setTransactionStatus("Still checking chain state — you can retry safely if needed.");
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
let behindStreak = 0;
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
let activeAnswerKey = "";
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

// A dry-run is needed to size each contract call. Most game actions have
// plenty of think time, so warm the estimate in the background and let the
// wallet open immediately when the player taps the button.
const txPreflights = new Map<string, TxPreflight>();
let createGamePreflightTimer: ReturnType<typeof setTimeout> | null = null;
let preparedGameCreationNonce: bigint | null = null;

let myDisplayName = "";

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

const SCREENS = ["boot", "home", "pack-select", "configure", "builder", "lobby", "question", "review", "vote", "results", "abandoned"] as const;
type Screen = (typeof SCREENS)[number];
const $appShell = document.querySelector<HTMLElement>("main");
let visibleScreen: Screen | null = null;

function showScreen(name: Screen): void {
    for (const s of SCREENS) {
        getEl(`screen-${s}`).classList.toggle("active", s === name);
    }
    const isPackPicker = name === "pack-select";
    const isGameStage = name === "question" || name === "review" || name === "vote";
    document.body.classList.toggle("pack-picker-open", isPackPicker);
    document.body.classList.toggle("game-stage-open", isGameStage);
    if (name !== "question") document.body.classList.remove("answer-input-focused");
    $appShell?.classList.toggle("pack-picker-open", isPackPicker);
    $appShell?.classList.toggle("game-stage-open", isGameStage);
    const changed = visibleScreen !== name;
    visibleScreen = name;
    if (name === "home" || name === "lobby") renderQuickPlayStatus();
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

function gameSessionKey(): string | null {
    return myAddress && isContractAddress(activeContracts.game)
        ? activeGameSessionKey(activeContracts.game, myAddress)
        : null;
}

function readSavedGame(): bigint | null {
    const key = gameSessionKey();
    if (key === null) return null;
    try {
        const raw = window.sessionStorage.getItem(key);
        const id = parseStoredGameId(raw);
        // Corrupt storage should never create an invisible, repeatedly failing
        // resume loop. The contract still has the room if the player knows its
        // code and chooses to re-enter it manually.
        if (raw !== null && id === null) window.sessionStorage.removeItem(key);
        return id;
    } catch {
        return null;
    }
}

function rememberGame(id: bigint): void {
    savedGameId = id;
    const key = gameSessionKey();
    if (key === null) return;
    try {
        window.sessionStorage.setItem(key, id.toString());
    } catch {
        // Private browsing/storage policy must not prevent a player joining.
    }
}

function forgetSavedGame(): void {
    savedGameId = null;
    const key = gameSessionKey();
    if (key === null) return;
    try {
        window.sessionStorage.removeItem(key);
    } catch {
        // Best effort only; the next active-membership validation remains safe.
    }
}

const $bootLog = getEl("boot-log");
const $connPill = getEl("conn-pill");
const $chainStatus = getEl("chain-status");
const $chainAccount = getEl("chain-account");
const $chainBlock = getEl("chain-block");
const $gameActions = getEl("game-actions");
const $btnForfeitGame = getEl<HTMLButtonElement>("btn-forfeit-game");
const $forfeitDialog = getEl<HTMLDialogElement>("forfeit-dialog");
const $transactionStatus = getEl("transaction-status");

function setGameActions(mode: "hidden" | "lobby" | "active"): void {
    $gameActions.style.display = mode === "hidden" ? "none" : "flex";
    $btnForfeitGame.style.display = mode === "active" ? "" : "none";
}

function bootLog(msg: string, level: "info" | "ok" | "err" = "info"): void {
    appendLog($bootLog, msg, level);
}

function setConnectionStatus(label: string, state: "pending" | "ok" | "err"): void {
    $connPill.textContent = label;
    $connPill.className = state === "ok" ? "ok" : state === "err" ? "err" : "";
    $chainStatus.classList.toggle("is-live", state === "ok");
    $chainStatus.classList.toggle("has-error", state === "err");
}

function setTransactionStatus(message: string | null): void {
    $transactionStatus.hidden = !message;
    $transactionStatus.textContent = message ?? "";
}

function showActiveAccount(address: string): void {
    // Keep this compact enough for the phone header. CSS must not ellipsize an
    // already shortened value, otherwise it reads like two nested truncations.
    $chainAccount.textContent = truncateAddress(address, 4, 3);
    $chainAccount.title = `Active account: ${address}`;
    $chainAccount.setAttribute("aria-label", `Active account: ${address}`);
}

function updateLatestBlock(blocks: readonly BestBlock[]): void {
    const number = blocks[0]?.number;
    if (number === undefined) return;

    const formatted = number.toLocaleString();
    $chainBlock.textContent = `#${formatted}`;
    $chainBlock.title = `Latest chain block: ${formatted}`;
    $chainBlock.setAttribute("aria-label", `Latest chain block: ${formatted}`);
}

function subscribeChainStatus(): void {
    chainStatusSubscription?.unsubscribe();
    if (!bestBlocks) return;
    chainStatusSubscription = bestBlocks.subscribe(updateLatestBlock);
}

function fmtAddr(addr: string): string {
    return addr.toLowerCase() === myAddress ? "You" : truncateAddress(addr);
}

function fmtPlayer(snap: Pick<Snapshot, "players" | "playerNames">, addr: string): string {
    const index = snap.players.findIndex((player) => player.toLowerCase() === addr.toLowerCase());
    const name = index >= 0 ? snap.playerNames[index]?.trim() : "";
    return name || fmtAddr(addr);
}

/** In-flight tx feedback: spinner + disabled, cleared in the finally. */
function setLoading(id: string, on: boolean): void {
    const btn = getEl<HTMLButtonElement>(id);
    btn.classList.toggle("loading", on);
    btn.disabled = on;
    btn.setAttribute("aria-busy", String(on));
}

function txError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    // contract reverts carry the raw revert string (e.g. "AlreadyJoined")
    return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
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
        address: account.ss58Address,
        h160: account.h160Address.toLowerCase(),
        signer: account.signer,
        kind: "session",
    };
}

/** Resolve the narrow signer allowed for this exact UI action. */
function transactionActor(handle: any, method: string): TransactionActor {
    const session = handle === game && SESSION_GAME_METHODS.has(method) ? activeSessionActor() : null;
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
        ? "Instant actions could not cover this move. Your wallet will sign instead."
        : "Instant actions ended. Your wallet will sign this action instead.";
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
    } catch {
        return null;
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
): Promise<void> {
    setTransactionStatus(actor.kind === "session" ? "Submitting instant action…" : "Waiting for wallet signature…");
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
        const timer = setTimeout(() => finish(new Error("Transaction timed out waiting for a block.")), 90_000);
        try {
            const nextSubscription = transaction.signSubmitAndWatch(actor.signer, {
                ...(nonce === null ? {} : { nonce }),
                mortality: { mortal: true, period: 256 },
            }).subscribe({
                next: (event: any) => {
                    if (event.type !== "txBestBlocksState" || !event.found || event.ok === undefined) return;
                    if (!event.ok) {
                        finish(new Error(JSON.stringify(event.dispatchError)));
                    } else {
                        setTransactionStatus("Included — checking chain state…");
                        finish();
                    }
                },
                error: (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
            });
            subscription = nextSubscription;
            setTransactionStatus("Submitting to chain…");
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
            const initialStatus = actor.kind === "session" ? "Preparing instant action…" : "Checking transaction…";
            setTransactionStatus(attempt === 0 ? initialStatus : "Refreshing transaction details…");
            // A warmed estimate avoids an RPC on the tap path. On retries we
            // intentionally estimate again against current chain state.
            const overrides = attempt === 0 && initialOverrides !== null
                ? initialOverrides
                : await estimateTx(handle, method, args, actor);
            const nonce = await reserveTxNonce(actor);
            if (nonce === null) {
                // Degrade safely to the SDK's submission path if the account
                // nonce API is unavailable in a host implementation.
                setTransactionStatus(actor.kind === "session" ? "Submitting instant action…" : "Waiting for wallet signature…");
                const result = await handle[method].tx(...args, {
                    signer: actor.signer,
                    origin: actor.address,
                    ...(overrides ?? {}),
                });
                if (!result.ok) throw new Error(JSON.stringify(result.dispatchError));
                setTransactionStatus("Included — checking chain state…");
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
                setTransactionStatus("Refreshing chain state…");
                await new Promise((r) => setTimeout(r, 5_000));
                continue;
            }
            if (await fallBackFromUnavailableSession(actor, e)) {
                setTransactionStatus("Instant actions unavailable — waiting for wallet signature…");
                // Drop the session-specific warm estimate and let the product
                // account dry-run/sign this one action normally.
                return submitTx(handle, method, args);
            }
            setTransactionStatus("Transaction was not confirmed. Check your wallet and try again.");
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
    // Contract addresses are chain-specific, so this isolates a session from
    // future deployments without putting any secret in browser storage.
    return `${registryAddress.toLowerCase()}:${myAddress}`;
}

async function getSessionKeyManager(): Promise<SessionKeyManager> {
    if (sessionKeyManager) return sessionKeyManager;
    // Keep the established secret-store namespace so a player who already
    // completed setup keeps their live seven-day session after this UI rename.
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
    if (!registered.success) throw new Error("Could not verify the instant-action session on-chain.");
    return String(registered.value).toLowerCase() === candidate.h160Address.toLowerCase();
}

async function sessionActivationPending(candidate: SessionAccount): Promise<boolean> {
    if (!sessionRegistry || !productAccount) throw new Error("Instant-action registry is unavailable.");
    const pending = await sessionRegistry.pendingOwnerOf.query(candidate.h160Address, {
        origin: productAccount.address,
    });
    if (!pending.success) throw new Error("Could not verify the instant-action setup on-chain.");
    return String(pending.value).toLowerCase() === myAddress;
}

/** A fresh, unbound key resolves to itself; used or tombstoned keys resolve to zero. */
async function sessionKeyCanBeRequested(candidate: SessionAccount): Promise<boolean> {
    if (!sessionRegistry || !productAccount) throw new Error("Instant-action registry is unavailable.");
    const resolved = await sessionRegistry.resolve.query(candidate.h160Address, { origin: productAccount.address });
    if (!resolved.success) throw new Error("Could not verify the saved instant-action key on-chain.");
    return String(resolved.value).toLowerCase() === candidate.h160Address.toLowerCase();
}

async function pgasBalance(address: string): Promise<bigint> {
    if (!assetHub) return 0n;
    const account = await assetHub.query.Assets.Account.getValue(PGAS_ASSET_ID, address);
    const balance = account?.balance;
    return typeof balance === "bigint" ? balance : balance === undefined ? 0n : BigInt(balance);
}

async function ensureQuickPlayAllowance(): Promise<void> {
    // This is a setup request, not a passive balance query. The host may show
    // an allocation prompt (and may increase an existing allowance), so the
    // automatic lifecycle calls it only once when no valid session exists.
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
                : "This wallet does not support instant actions right now.",
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

async function submitStandaloneTx(transaction: any, actor: TransactionActor): Promise<void> {
    const nonce = await reserveTxNonce(actor);
    try {
        await submitPreparedTx(transaction, actor, nonce);
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
        quickPlayMessage = "Instant actions could not be checked. Normal signing is ready.";
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
    const activation = await estimatedReviveCall(sessionRegistryAddress, activationData, actor);
    assertInstantPlaySetupCurrent(canContinue);
    await submitStandaloneTx(activation, actor);
    assertInstantPlaySetupCurrent(canContinue);
    if (!await sessionIsRegistered(session)) {
        throw new Error("Instant actions were not confirmed on-chain. Please try again.");
    }
    assertInstantPlaySetupCurrent(canContinue);
    sessionAccount = session;
    instantPlayFallback = false;
    quickPlayPending = false;
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
    const fundData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [candidate.account.h160Address, SESSION_PGAS_BUDGET],
    });
    const requestData = encodeFunctionData({
        abi: sessionRegistryAbi,
        functionName: "requestSession",
        args: [candidate.account.h160Address],
    });
    quickPlayMessage = "Preparing instant actions…";
    renderQuickPlayStatus();
    const [fund, request] = await Promise.all([
        estimatedReviveCall(PGAS_ERC20_PRECOMPILE, fundData, product),
        estimatedReviveCall(sessionRegistryAddress, requestData, product),
    ]);
    assertInstantPlaySetupCurrent(canContinue);
    const setup = assetHub.tx.Utility.batch_all({
        // Keep the batch pure Revive calls. A native Assets transfer or any
        // other outer call would lose the PGAS fee path.
        calls: [fund.decodedCall, request.decodedCall],
    });

    quickPlayMessage = "Confirm once to turn on instant actions…";
    renderQuickPlayStatus();
    try {
        await submitStandaloneTx(setup, product);
        quickPlayPending = true;
        assertInstantPlaySetupCurrent(canContinue);
        await activatePendingQuickPlay(candidate.account, canContinue);
    } catch (error) {
        if (error instanceof InstantPlaySetupCancelled) throw error;
        // A watch timeout can occur after inclusion. Preserve the key either
        // way; when the chain can confirm the pending request, also expose the
        // explicit cancel/retry controls immediately.
        if (await sessionIsRegistered(candidate.account).catch(() => false)) {
            sessionAccount = candidate.account;
            instantPlayFallback = false;
            quickPlayPending = false;
            quickPlayMessage = "Instant actions are ready.";
            return;
        }
        quickPlayPending = await sessionActivationPending(candidate.account).catch(() => false);
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
            quickPlayMessage = "Instant actions could not be verified. Normal signing is ready.";
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
            ? "Playing with normal wallet approvals."
            : "Instant actions are unavailable right now. Normal signing is ready.";
        renderQuickPlayStatus();
        return;
    }

    automaticInstantPlayAttempted = true;
    instantPlayFallback = false;
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
        const useManualSigning = instantPlayUsesManualSigning(error);
        if (!canContinue() && !useManualSigning) {
            automaticInstantPlayAttempted = false;
            return;
        }
        if (quickPlayPending) {
            // The product-approved batch landed. A later retry will use the
            // stored pending key and only repeat its silent activation call,
            // never the allowance request or product-signed setup batch.
            quickPlayPending = false;
            instantPlayFallback = true;
            quickPlayMessage = "Instant actions are still finishing. Playing with normal wallet approvals meanwhile.";
        } else {
            instantPlayFallback = true;
            await saveInstantPlayPreference(
                useManualSigning ? { mode: "manual" } : temporaryInstantPlayFailure(),
            );
            quickPlayMessage = useManualSigning
                ? "Playing with normal wallet approvals."
                : "Instant actions are unavailable right now. Normal signing is ready.";
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
    if (balance > 0n) {
        const drainData = encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [productTransactionActor().h160 as `0x${string}`, balance],
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
    quickPlayMessage = "Playing with normal wallet approvals.";
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
    const request = (async () => {
        const res = await registryAtRequest.getQuestion.query(packId, slot);
        if (!res.success) return "";
        const text = res.value as string;
        questionCache.set(key, text);
        return text;
    })().finally(() => questionRequests.delete(key));
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
    const request = (async () => {
        const res = await registryAtRequest.getAnswers.query(packId, slot);
        if (!res.success) return "";
        const answers = res.value as string[];
        const canonical = answers[0] ?? "";
        answerCache.set(key, canonical);
        return canonical;
    })().finally(() => answerRequests.delete(key));
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
        const res = await registryAtRequest.getPack.query(packId);
        if (!res.success) return `pack #${packId}`;
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
                const result = await registryAtRequest.getPacks.query(batch);
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

// ── Boot ─────────────────────────────────────────────────────────────

function createContractHandles(client: any, descriptor: any): void {
    if (!isContractAddress(activeContracts.registry) || !isContractAddress(activeContracts.game)) {
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
}

async function verifyActiveContractPair(): Promise<boolean> {
    try {
        const linkedRegistry = await game.registry.query();
        if (!linkedRegistry.success) return false;
        if (String(linkedRegistry.value).toLowerCase() !== activeContracts.registry?.toLowerCase()) return false;
        if (!sessionRegistryConfigured()) return true;
        if (!sessionRegistry) return false;
        const linkedSessionRegistry = await game.sessionRegistry.query();
        return linkedSessionRegistry.success
            && String(linkedSessionRegistry.value).toLowerCase() === activeContracts.sessionRegistry?.toLowerCase();
    } catch {
        return false;
    }
}

async function init(): Promise<void> {
    const bootStartMark = performanceMark("boot:start");
    showScreen("boot");
    if (!isContractAddress(activeContracts.registry) || !isContractAddress(activeContracts.game)) {
        setConnectionStatus("no contract", "err");
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
        setConnectionStatus("offline", "err");
        bootLog(`Signer connect failed: ${connectRes.error.message}`, "err");
        return;
    }
    bootLog("Signer connected", "ok");
    const signerConnectedMark = performanceMark("signer:connected");
    performanceMeasure("signer:connect", bootStartMark, signerConnectedMark);

    bootLog("Requesting product account quizzler.dot/0…");
    const productRes = await manager.getProductAccount("quizzler.dot", 0);
    if (!productRes.ok) {
        setConnectionStatus("account unavailable", "err");
        bootLog(`getProductAccount failed: ${productRes.error.message}`, "err");
        return;
    }
    productAccount = productRes.value;
    myAddress = ss58ToH160(productAccount.address).toLowerCase();
    savedGameId = readSavedGame();
    showActiveAccount(productAccount.address);
    bootLog(`Account ready: ${truncateAddress(productAccount.address)}`, "ok");

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
        setConnectionStatus("account setup failed", "err");
        bootLog(`Account mapping failed: ${txError(e)}`, "err");
        return;
    }

    createContractHandles(client, paseo_asset_hub);
    bootLog(sessionRegistry ? "Contract handles ready (registry + game + sessions)" : "Contract handles ready (registry + game)", "ok");

    if (!await verifyActiveContractPair()) {
        setConnectionStatus("contract mismatch", "err");
        bootLog("The game contract is not linked to this registry deployment.", "err");
        return;
    }

    // Sealed packs are immutable. Restore their last known metadata for an
    // instant picker on a return visit, then reconcile the current registry
    // window in the background below.
    hydratePackCatalogCache();
    void refreshPacks();

    // A stored session is trusted only after its on-chain owner mapping is
    // checked. This is intentionally best-effort: a storage/host outage must
    // never block normal product-account play.
    if (sessionRegistry) void hydrateQuickPlay();

    // Prime the best-block nonce without holding up the home screen. It is
    // shared with the first action if the player gets there before it returns.
    void syncTxNonce(productTransactionActor());

    setConnectionStatus("connected", "ok");
    const resume = await resumeSavedGame();
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
        } else if (savedGameId === null) {
            getEl<HTMLInputElement>("join-game-id").value = sharedLobbyInvite.gameId.toString();
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
    renderResumeCard();
    if (inviteError) {
        $homeError.textContent = inviteError;
    } else if (resume === "unavailable") {
        $homeError.textContent = "Couldn’t reopen your saved quiz yet. Try Resume when the connection recovers.";
    }
}

// ── Home: pack selection & game setup ─────────────────────────────────

const $packList = getEl("pack-list");
const $packSearch = getEl<HTMLInputElement>("pack-search");
const $packCatalogStatus = getEl("pack-catalog-status");
const $selectedPackSummary = getEl("selected-pack-summary");
const $homeError = getEl("home-error");
const $packSelectionError = getEl("pack-selection-error");
const $configError = getEl("config-error");
const $btnCreateGame = getEl<HTMLButtonElement>("btn-create-game");
const $btnPackContinue = getEl<HTMLButtonElement>("btn-pack-continue");
const $questionCount = getEl<HTMLSelectElement>("cfg-questions");
const $answerBlocks = getEl<HTMLSelectElement>("cfg-answer-blocks");
const $reviewBlocks = getEl<HTMLSelectElement>("cfg-review-blocks");
const $configPackArt = getEl("config-pack-art");
const $configPackTitle = getEl("config-pack-title");
const $configPackMeta = getEl("config-pack-meta");
const $resumeGameCard = getEl("resume-game-card");
const $resumeGameCode = getEl("resume-game-code");
const $displayName = getEl<HTMLInputElement>("display-name");
const $displayNameStatus = getEl("display-name-status");
const $instantPlayCard = getEl("instant-play-card");
const $instantPlayStatus = getEl("instant-play-status");
const $instantPlayError = getEl("instant-play-error");
const $btnTurnOffInstantPlay = getEl<HTMLButtonElement>("btn-turn-off-instant-play");
const $lobbyInstantPlay = getEl("lobby-instant-play");
const $lobbyInstantPlayStatus = getEl("lobby-instant-play-status");
const $btnRetryInstantPlay = getEl<HTMLButtonElement>("btn-retry-instant-play");

function renderQuickPlayStatus(): void {
    const configured = sessionRegistryConfigured();
    const enabled = sessionAccount !== null;
    const pending = !enabled && quickPlayPending;
    const settingUp = quickPlaySetup !== null || automaticInstantPlaySetup !== null || pending;
    $instantPlayCard.style.display = configured && enabled ? "" : "none";
    if (!configured) {
        $lobbyInstantPlay.style.display = "none";
        return;
    }

    $instantPlayStatus.textContent = "Instant actions are on for this account. Ending them revokes the current session, including on any other device.";
    $btnTurnOffInstantPlay.disabled = busy;

    const inLobby = visibleScreen === "lobby";
    const showLobbyStatus = inLobby && !enabled;
    $lobbyInstantPlay.style.display = showLobbyStatus ? "" : "none";
    if (!showLobbyStatus) return;

    $lobbyInstantPlayStatus.textContent = settingUp
        ? quickPlayMessage || "Setting up instant actions…"
        : quickPlayMessage || "Playing with normal wallet approvals.";
    const canRetry = !settingUp && instantPlayFallback;
    $btnRetryInstantPlay.style.display = canRetry ? "" : "none";
    $btnRetryInstantPlay.disabled = !canRetry || busy;
}

$btnRetryInstantPlay.addEventListener("click", () => {
    if (busy || quickPlaySetup || automaticInstantPlaySetup) return;
    void (async () => {
        automaticInstantPlayAttempted = false;
        instantPlayFallback = false;
        await saveInstantPlayPreference(null);
        startDefaultInstantPlay(true);
        renderQuickPlayStatus();
    })();
});

$btnTurnOffInstantPlay.addEventListener("click", async () => {
    if (busy || !sessionAccount) return;
    busy = true;
    $instantPlayError.textContent = "";
    setLoading("btn-turn-off-instant-play", true);
    renderQuickPlayStatus();
    try {
        await endQuickPlay();
    } catch (cause) {
        $instantPlayError.textContent = txError(cause);
    } finally {
        busy = false;
        setLoading("btn-turn-off-instant-play", false);
        renderQuickPlayStatus();
    }
});

getEl<HTMLButtonElement>("btn-save-display-name").addEventListener("click", async () => {
    if (busy || !productAccount) return;
    const name = $displayName.value;
    if (name !== "" && (name !== name.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(name) || utf8ByteLength(name) > 24)) {
        $displayNameStatus.textContent = "Use a trimmed one-line name of up to 24 bytes.";
        return;
    }
    busy = true;
    $displayNameStatus.textContent = "";
    setLoading("btn-save-display-name", true);
    try {
        await sendTx(game, "setDisplayName", name);
        myDisplayName = name;
        $displayNameStatus.textContent = name ? "Name saved for your next lobby refresh." : "Name cleared.";
    } catch (error) {
        $displayNameStatus.textContent = txError(error);
    } finally {
        busy = false;
        setLoading("btn-save-display-name", false);
    }
});

function renderResumeCard(): void {
    const shouldShow = savedGameId !== null && gameId === null;
    $resumeGameCard.style.display = shouldShow ? "" : "none";
    $resumeGameCode.textContent = shouldShow ? String(savedGameId) : "";
}

interface SelectOption {
    value: number;
    label: string;
}

function replaceSelectOptions(
    select: HTMLSelectElement,
    options: readonly SelectOption[],
    preferredValue: number,
): void {
    const previous = Number(select.value);
    const target = options.some((option) => option.value === previous)
        ? previous
        : options.some((option) => option.value === preferredValue)
            ? preferredValue
            : options[0]?.value;
    select.replaceChildren(
        ...options.map((option) => {
            const node = document.createElement("option");
            node.value = String(option.value);
            node.textContent = option.label;
            return node;
        }),
    );
    if (target !== undefined) select.value = String(target);
}

function renderQuestionCountOptions(maxQuestions: number): void {
    const options = questionCountOptions(maxQuestions).map((value) => ({
        value,
        label: `${value} ${value === 1 ? "question" : "questions"}`,
    }));
    replaceSelectOptions($questionCount, options, Math.min(5, maxQuestions));
}

function configureGameControls(): void {
    replaceSelectOptions(
        $answerBlocks,
        ANSWER_BLOCK_PRESETS.map((preset) => ({ value: preset.blocks, label: presetLabel(preset) })),
        30,
    );
    replaceSelectOptions(
        $reviewBlocks,
        REVIEW_BLOCK_PRESETS.map((preset) => ({ value: preset.blocks, label: presetLabel(preset) })),
        18,
    );
    renderQuestionCountOptions(MAX_GAME_QUESTIONS);
}

configureGameControls();

type CatalogPack = PackView & PackListItem;

let refreshingPacks: Promise<void> | null = null;
let communityRefresh: Promise<void> | null = null;
let lastPackListSignature: string | null = null;
let catalogPacks: CatalogPack[] = [];
let packSearch = "";
let knownPackCount = 0;
let starterPacksLoading = false;
let communityPacksLoading = false;
let communityPacksRequested = false;
let lastCommunityRequestAt = 0;
// E2E runs can opt in to their disposable packs without exposing them to
// players on the normal home screen.
const showE2ETestPacks = import.meta.env.VITE_SHOW_E2E_PACKS === "1"
    || new URLSearchParams(window.location.search).get("show-test-packs") === "1";
// Fetch the stable starter IDs as well as recent community packs. This keeps
// the curated catalog available even after a long-lived registry accumulates
// lots of new packs, without making home-screen refreshes unbounded.
const PACK_RECENT_LIST_LIMIT = 100;
const PACK_CATALOG_CACHE_VERSION = 1;
const PACK_CATALOG_CACHE_LIMIT = STARTER_PACK_COUNT + PACK_RECENT_LIST_LIMIT;

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
        && (pack.emoji === undefined || typeof pack.emoji === "string")
        && Number.isSafeInteger(pack.regular_count)
        && (pack.regular_count as number) >= 0
        && Number.isSafeInteger(pack.finals_set_count)
        && (pack.finals_set_count as number) >= 0
        && pack.sealed === true;
}

/** A sealed pack is immutable, so a validated local metadata cache is safe. */
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
            const key = registryPackCacheKey(pack.id);
            sealedPackCache.set(key, pack);
            packTitleCache.set(key, pack.title);
        }
        renderPackList();
        performanceMark("catalog:cache-restored");
    } catch {
        // Storage can be blocked or stale/corrupt. The registry remains the
        // source of truth, so simply continue without the cache.
    }
}

function persistPackCatalog(): void {
    const key = packCatalogCacheKey();
    if (key === null) return;
    try {
        window.localStorage.setItem(key, JSON.stringify({
            version: PACK_CATALOG_CACHE_VERSION,
            packs: catalogPacks.filter((pack) => pack.sealed).slice(0, PACK_CATALOG_CACHE_LIMIT),
        }));
    } catch {
        // Private mode and quota limits should not affect normal browsing.
    }
}

function starterPackIds(count: number): number[] {
    return Array.from({ length: Math.min(count, STARTER_PACK_COUNT) }, (_, id) => id);
}

function communityPackIds(count: number): number[] {
    return Array.from(
        { length: Math.min(count, PACK_RECENT_LIST_LIMIT) },
        (_, offset) => count - 1 - offset,
    ).filter((id) => id >= STARTER_PACK_COUNT);
}

function retainCatalogWindow(count: number): void {
    const allowed = new Set([...starterPackIds(count), ...communityPackIds(count)]);
    const next = catalogPacks.filter((pack) => allowed.has(pack.id));
    if (next.length === catalogPacks.length) return;
    catalogPacks = next;
    persistPackCatalog();
    renderPackList();
}

function mergeCatalogPacks(packs: readonly CatalogPack[]): void {
    const byId = new Map(catalogPacks.map((pack) => [pack.id, pack]));
    let changed = false;
    for (const pack of packs) {
        if (byId.get(pack.id) !== pack) changed = true;
        byId.set(pack.id, pack);
    }
    if (!changed) return;
    catalogPacks = [...byId.values()];
    persistPackCatalog();
    renderPackList();
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

function refreshPacks({ includeCommunity = getEl("screen-pack-select").classList.contains("active") }: {
    includeCommunity?: boolean;
} = {}): Promise<void> {
    if (includeCommunity) communityPacksRequested = true;
    if (refreshingPacks) return refreshingPacks;
    starterPacksLoading = true;
    renderPackList();
    const error = getEl("screen-pack-select").classList.contains("active")
        ? $packSelectionError
        : $homeError;
    let request: Promise<void>;
    request = refreshStarterPacks()
        .then(() => {
            error.textContent = "";
        })
        .catch(() => {
            error.textContent = "Couldn’t refresh quiz packs. Retrying…";
        })
        .finally(() => {
            if (refreshingPacks !== request) return;
            starterPacksLoading = false;
            refreshingPacks = null;
            renderPackList();
            if (communityPacksRequested) {
                communityPacksRequested = false;
                requestCommunityPacks(knownPackCount);
            }
        });
    refreshingPacks = request;
    return request;
}

async function refreshStarterPacks(): Promise<void> {
    const startMark = performanceMark("catalog:starters:start");
    const registryAtRequest = registry;
    const scope = registryCacheScope();
    const countRes = await registryAtRequest.packCount.query();
    if (!countRes.success) throw new Error("pack count query failed");
    const count = Number(countRes.value);
    knownPackCount = count;
    retainCatalogWindow(count);
    const ids = starterPackIds(count);
    const packs = await sealedPacks(ids, registryAtRequest, scope);
    mergeCatalogPacks(packs.flatMap((pack, index) => pack === null ? [] : [{ id: ids[index], ...pack }]));
    const readyMark = performanceMark("catalog:starters:ready");
    performanceMeasure("catalog:starters", startMark, readyMark);
}

/** Load the larger community window only after someone opens the picker. */
function requestCommunityPacks(count: number): void {
    if (count <= STARTER_PACK_COUNT || communityRefresh) return;
    const registryAtRequest = registry;
    const scope = registryCacheScope();
    const ids = communityPackIds(count);
    if (ids.length === 0) return;
    lastCommunityRequestAt = Date.now();
    communityPacksLoading = true;
    renderPackList();
    let request: Promise<void>;
    request = (async () => {
        const startMark = performanceMark("catalog:community:start");
        const packs = await sealedPacks(ids, registryAtRequest, scope);
        mergeCatalogPacks(packs.flatMap((pack, index) => pack === null ? [] : [{ id: ids[index], ...pack }]));
        const readyMark = performanceMark("catalog:community:ready");
        performanceMeasure("catalog:community", startMark, readyMark);
    })().catch(() => {
        // Keep the starter packs usable if a larger background refresh fails.
        if (getEl("screen-pack-select").classList.contains("active")) {
            $packSelectionError.textContent = "Couldn’t load more community packs yet.";
        }
    }).finally(() => {
        if (communityRefresh !== request) return;
        communityPacksLoading = false;
        communityRefresh = null;
        renderPackList();
        // If a newer count landed during this batch, fetch just its current
        // recent window next rather than waiting for another picker visit.
        if (knownPackCount > count) requestCommunityPacks(knownPackCount);
    });
    communityRefresh = request;
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
        card.classList.toggle("selected", card.htmlFor === `pack-${id}-choice`);
    }
    updateSelectedPackSummary();
    $packSelectionError.textContent = "";
    preparedGameCreationNonce = null;
    scheduleCreateGamePreflight();
}

function packCard(pack: CatalogPack): HTMLLIElement {
    const presentation = packPresentation(pack);
    const item = document.createElement("li");
    const choice = document.createElement("input");
    choice.className = "pack-card-input";
    choice.type = "radio";
    choice.name = "pack-choice";
    choice.id = `pack-${pack.id}-choice`;
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
    copy.append(
        heading,
        span("pack-card-title", pack.title),
        span("pack-card-description", presentation.description),
        span("pack-card-meta", `${questionCountLabel(pack)}${finalCountLabel(pack)}`),
    );
    card.append(art, copy);
    item.append(choice, card);
    return item;
}

function packGrid(packs: readonly CatalogPack[]): HTMLUListElement {
    const grid = document.createElement("ul");
    grid.className = "pack-grid";
    grid.append(...packs.map(packCard));
    return grid;
}

function packSection(title: string, packs: readonly CatalogPack[]): HTMLElement {
    const section = document.createElement("section");
    section.className = "pack-section";
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.append(heading, packGrid(packs));
    return section;
}

function updatePackCatalogStatus(featured: readonly CatalogPack[], community: readonly CatalogPack[]): void {
    const total = featured.length + community.length;
    if (total === 0) {
        $packCatalogStatus.textContent = starterPacksLoading || communityPacksLoading
            ? "Loading quiz packs…"
            : "";
        return;
    }
    const parts: string[] = [];
    if (featured.length > 0) parts.push(`${featured.length} featured`);
    if (community.length > 0) parts.push(`${community.length} community`);
    const status = `${parts.join(" · ")} ${total === 1 ? "pack" : "packs"}`;
    $packCatalogStatus.textContent = communityPacksLoading ? `${status} · loading more…` : status;
}

function renderPackList(): void {
    const { featured, community } = sectionPacks(catalogPacks, packSearch, showE2ETestPacks);
    const total = featured.length + community.length;
    const signature = JSON.stringify(
        {
            packs: catalogPacks.map((pack) => [
                pack.id,
                pack.title,
                pack.emoji ?? "",
                pack.regular_count,
                pack.finals_set_count,
            ]),
            search: packSearch,
            showE2ETestPacks,
        },
    );
    // Avoid replacing identical DOM nodes every five seconds: it preserves
    // keyboard focus and prevents needless layout work on a static catalog.
    if (signature === lastPackListSignature) {
        updatePackCatalogStatus(featured, community);
        return;
    }
    const communityWasOpen = $packList.querySelector<HTMLDetailsElement>(".community-packs")?.open ?? false;
    lastPackListSignature = signature;
    if (total === 0) {
        const empty = document.createElement("p");
        empty.className = "pack-empty";
        empty.textContent = packSearch.trim()
            ? `No packs match “${packSearch.trim()}”.`
            : "No sealed packs yet — create one!";
        $packList.replaceChildren(empty);
        updatePackCatalogStatus(featured, community);
        return;
    }

    const content = document.createDocumentFragment();
    if (featured.length > 0) content.append(packSection("Featured packs", featured));
    if (community.length > 0) {
        const details = document.createElement("details");
        details.className = "community-packs";
        // Test hosts opt into a disposable namespace and need its newly
        // created pack immediately visible; players still see community
        // content as an intentional secondary section.
        details.open = communityWasOpen || packSearch.trim() !== "" || showE2ETestPacks;
        const summary = document.createElement("summary");
        summary.textContent = `Community packs (${community.length})`;
        details.append(summary, packGrid(community));
        content.append(details);
    }
    $packList.replaceChildren(content);
    updatePackCatalogStatus(featured, community);
}

$packSearch.addEventListener("input", () => {
    packSearch = $packSearch.value;
    renderPackList();
});

function showPackSelection(): void {
    $homeError.textContent = "";
    $packSelectionError.textContent = "";
    showScreen("pack-select");
    window.scrollTo(0, 0);
    void refreshPacks({ includeCommunity: true });
}

getEl("btn-host-game").addEventListener("click", showPackSelection);

getEl("btn-pack-back").addEventListener("click", () => {
    showScreen("home");
    renderResumeCard();
});

getEl("btn-pack-continue").addEventListener("click", () => {
    if (selectedPackId === null || selectedPack === null) {
        $packSelectionError.textContent = "Choose a pack before continuing.";
        return;
    }
    $configError.textContent = "";
    updateSelectedPackSummary();
    showScreen("configure");
    scheduleCreateGamePreflight();
});

for (const id of ["btn-config-back", "btn-config-back-bottom"]) {
    getEl(id).addEventListener("click", () => {
        $configError.textContent = "";
        showScreen("pack-select");
    });
}

// Keep the browse list fresh while the player compares packs — packs
// published by others should show up without a reload.
setInterval(() => {
    if (registry && getEl("screen-pack-select").classList.contains("active") && !busy) {
        // Featured packs remain fresh frequently; the much larger community
        // window only needs a gentle refresh while someone is comparing.
        void refreshPacks({ includeCommunity: Date.now() - lastCommunityRequestAt > 60_000 });
    }
}, 5_000);

function readCreatedGameConfig(showErrors = false): CreatedGameConfig | null {
    if (selectedPackId === null || selectedPack === null) return null;
    const fail = (message: string): null => {
        if (showErrors) $configError.textContent = message;
        return null;
    };
    const maxQuestions = Math.min(selectedPack.regular_count, MAX_GAME_QUESTIONS);
    const numQuestions = parseIntegerInRange(
        $questionCount.value,
        1,
        maxQuestions,
    );
    if (numQuestions === null) {
        return fail(`Choose between 1 and ${maxQuestions} questions.`);
    }
    const answerBlocks = Number($answerBlocks.value);
    if (!Number.isInteger(answerBlocks) || !isAllowedBlockPreset(answerBlocks, ANSWER_BLOCK_PRESETS)) {
        return fail("Choose one of the listed answer-time options.");
    }
    const reviewBlocks = Number($reviewBlocks.value);
    if (!Number.isInteger(reviewBlocks) || !isAllowedBlockPreset(reviewBlocks, REVIEW_BLOCK_PRESETS)) {
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await game.getGameForCreation.query(myAddress, nonce);
        if (res.success) {
            const id = BigInt(res.value);
            if (id !== 0n) return id;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
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
        const res = await game.isPlayerActive.query(id, myAddress);
        // A failed contract read is not evidence that the player left. Keep
        // the saved room so a temporary RPC/fork error cannot erase their
        // ability to resume it on the next attempt.
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

type ResumeResult = "none" | "resumed" | "not-active" | "unavailable";

/** Restore a browser's current room only after the new contract confirms it. */
async function resumeSavedGame(): Promise<ResumeResult> {
    const id = savedGameId ?? readSavedGame();
    if (id === null || !game || !myAddress) return "none";
    savedGameId = id;
    const active = await activePlayerStatus(id);
    if (active === null) {
        // Keep the pointer so the explicit Resume button and a later refresh
        // can retry after a transient RPC outage.
        return "unavailable";
    }
    if (!active) {
        forgetSavedGame();
        return "not-active";
    }
    bootLog(`Reopening game ${id}…`, "ok");
    enterGame(id);
    return "resumed";
}

/**
 * A party is deliberately one current table per browser session. The
 * contract remains permissive — it does not maintain a costly global
 * account-to-game index — but never silently replace the room a player can
 * resume locally.
 */
function canStartAnotherQuiz(error = $homeError): boolean {
    if (pendingGameCreation()) {
        error.textContent = "Your new lobby is still being confirmed. Give it a moment, then try again to reopen it.";
        return false;
    }
    if (savedGameId === null) return true;
    error.textContent = "You already have a quiz in progress. Resume it, leave its lobby, or forfeit it before starting another.";
    return false;
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
        if (savedGameId !== null) {
            if (savedGameId === id) {
                const result = await resumeSavedGame();
                if (result === "resumed") return true;
                error.textContent = result === "not-active"
                    ? "You are no longer an active player in that quiz."
                    : "Couldn’t reopen that quiz yet. Try again when the connection recovers.";
                return false;
            }
            canStartAnotherQuiz(error);
            return false;
        }

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
        error.textContent = msg.includes("GameAlreadyStarted")
            ? "This game has already started."
            : msg.includes("GameFull")
                ? "This lobby is full."
            : msg;
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
    const pendingCreation = await resumePendingGameCreation();
    if (pendingCreation === "resumed") return;
    if (pendingCreation === "unavailable") {
        $configError.textContent = "Your new lobby is still being confirmed. Try again in a moment.";
        return;
    }
    if (!canStartAnotherQuiz($configError)) return;
    const config = readCreatedGameConfig(true);
    if (!config) return;
    busy = true;
    setLoading("btn-create-game", true);
    try {
        const call = gameCreateCall(config);
        await sendWarmedTx(game, call.method, call.args);
        $configError.textContent = "Game created — opening your lobby…";
        rememberPendingGameCreationMarker(call.nonce, config);
        const id = await resolveCreatedGame(call.nonce);
        if (id === null) throw new Error("could not locate the created game");
        clearPendingGameCreationMarker();
        enterGame(id, createdLobbySnapshot(config));
    } catch (e) {
        $configError.textContent = txError(e);
    } finally {
        preparedGameCreationNonce = null;
        busy = false;
        setLoading("btn-create-game", false);
    }
});

for (const select of [$questionCount, $answerBlocks, $reviewBlocks]) {
    select.addEventListener("change", () => {
        $configError.textContent = "";
        preparedGameCreationNonce = null;
        scheduleCreateGamePreflight();
    });
}

getEl("btn-join-game").addEventListener("click", async () => {
    if (busy || !productAccount) return;
    $homeError.textContent = "";
    const raw = getEl<HTMLInputElement>("join-game-id").value;
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
});

getEl<HTMLInputElement>("join-game-id").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        getEl<HTMLButtonElement>("btn-join-game").click();
    }
});

getEl<HTMLButtonElement>("btn-resume-game").addEventListener("click", async () => {
    const result = await resumeSavedGame();
    if (result === "resumed") return;
    renderResumeCard();
    $homeError.textContent = result === "not-active"
        ? "You are no longer an active player in that quiz."
        : "Couldn’t reopen that quiz yet. Try again when the connection recovers.";
});

getEl<HTMLButtonElement>("btn-forget-saved-game").addEventListener("click", () => {
    forgetSavedGame();
    renderResumeCard();
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
        $builderPublishStatus.textContent = "Ready to publish in bounded batches.";
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

for (const id of ["btn-new-pack", "btn-new-pack-from-picker"]) {
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

async function resolveCreatedPack(nonce: bigint): Promise<number | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await registry.getPackForCreation.query(myAddress, nonce);
        if (result.success) {
            const id = Number(result.value);
            if (id !== NO_PACK) return id;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
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
        throw new Error("The on-chain pack has more questions than this draft, so it cannot be resumed safely.");
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
            let packId = await resolveCreatedPack(nonce);
            if (packId === null) {
                await sendTx(registry, "createPackWithNonce", validation.pack.title, validation.emoji, nonce);
                packId = await resolveCreatedPack(nonce);
            }
            if (packId === null) throw new Error("Couldn’t locate the created pack. Your draft is saved; try Publish again to resume.");
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
            if (resume.nextRegularQuestion <= start) throw new Error("The question batch is not visible on-chain yet. Try Publish again to resume safely.");
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
            if (resume.completedFinals.length < 3) throw new Error("The final-question batch is not visible on-chain yet. Try Publish again to resume safely.");
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
        scheduleCreateGamePreflight();
    } catch (error) {
        $builderError.textContent = txError(error);
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
    renderResumeCard();
});

window.addEventListener("pagehide", () => {
    // A final best-effort save turns a refresh during authoring into a normal
    // draft restore rather than relying solely on the debounce timer.
    void packDraftSaver.flush();
});

// ── Game loop ────────────────────────────────────────────────────────

function createdLobbySnapshot(config: CreatedGameConfig): Snapshot {
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
        players: [myAddress],
        playerNames: [myDisplayName],
        scores: [0],
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
    activeAnswerKey = "";
    optimisticAnswer = null;
    lastRank = -1;
    behindStreak = 0;
    latestObservedAt = initialSnapshot ? Date.now() : 0;
    getEl<HTMLInputElement>("answer-input").value = "";
    getEl<HTMLInputElement>("wager-final").value = "0";
    setGameActions("hidden");
    renderResumeCard();
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
    gameId = null;
    pendingAbandonedForfeit = null;
    latest = null;
    selectedWager = null;
    activeAnswerKey = "";
    optimisticAnswer = null;
    latestObservedAt = 0;
    gameEntryMark = null;
    awaitingFirstGameSnapshot = false;
    if (!preserveSavedGame) forgetSavedGame();
    if ($forfeitDialog.open) $forfeitDialog.close();
    setTransactionStatus(null);
    setGameActions("hidden");
    stopGamePolling();
    void refreshPacks();
    showScreen("home");
    renderResumeCard();
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

getEl("btn-back-home").addEventListener("click", () => leaveGame());
getEl("btn-abandoned-home").addEventListener("click", () => leaveGame());

getEl("btn-leave-screen").addEventListener("click", () => {
    // Navigation is deliberately not a forfeit: the player can resume from
    // this browser session or by re-entering the game code later.
    leaveGame({ preserveSavedGame: true });
});

getEl("btn-leave-lobby").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount) return;
    busy = true;
    setLoading("btn-leave-lobby", true);
    try {
        await sendTx(game, "leaveLobby", gameId);
        leaveGame();
    } catch (e) {
        getEl("lobby-error").textContent = txError(e);
    } finally {
        busy = false;
        setLoading("btn-leave-lobby", false);
    }
});

$btnForfeitGame.addEventListener("click", () => {
    if (busy || gameId === null || !latest) return;
    getEl("forfeit-error").textContent = "";
    if (!$forfeitDialog.open) $forfeitDialog.showModal();
});

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
            forgetSavedGame();
            setGameActions("hidden");
            void poll();
        } else {
            leaveGame();
            $homeError.textContent = "You forfeited this quiz. Your score remains on its scorecard.";
        }
    } catch (e) {
        getEl("forfeit-error").textContent = txError(e);
    } finally {
        busy = false;
        setLoading("btn-confirm-forfeit", false);
    }
});

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && gameId !== null) void poll();
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
    const results = await Promise.all(keys.map((key) => game.getSubmissions.query(id, key)));
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
    pollInFlight = true;
    try {
        const liveResult = await game.getLiveGame.query(polledGameId);
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
        const submissions = live.submissions.map((submission) => ({
            ...submission,
            player: String(submission.player).toLowerCase(),
            wager: Number(submission.wager),
            overturn_votes: Number(submission.overturn_votes),
        }));

        // Drop snapshots that move the game BACKWARDS unless they persist —
        // a slow read resolving late must not yank the table back a round.
        const rank = stageRank(phase);
        if (rank < lastRank) {
            behindStreak += 1;
            if (behindStreak < 3) return;
        } else {
            behindStreak = 0;
        }
        lastRank = rank;

        const normalizedPlayerNames = playerNames.length === players.length
            ? playerNames
            : Array.from({ length: players.length }, () => "");
        const myPlayerIndex = players.indexOf(myAddress);
        if (myPlayerIndex >= 0 && normalizedPlayerNames[myPlayerIndex] !== undefined) {
            myDisplayName = normalizedPlayerNames[myPlayerIndex];
            $displayName.value = myDisplayName;
        }

        let qText = "";
        let aText = "";
        if (phase.slot !== NO_SLOT) {
            const [question, answer] = await Promise.all([
                questionText(gameView.pack_id, phase.slot),
                phase.stage === STAGE_REVIEW || phase.stage === STAGE_FINAL_REVIEW
                    ? canonicalAnswer(gameView.pack_id, phase.slot)
                    : Promise.resolve(""),
            ]);
            qText = question;
            aText = answer;
            if (!isCurrentGame(polledGameId, polledSession)) return;
        }

        const snap: Snapshot = {
            phase,
            game: gameView,
            players,
            playerNames: normalizedPlayerNames,
            scores,
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
        }
        const isAnswerStage =
            latest.phase.stage === STAGE_ANSWER || latest.phase.stage === STAGE_FINAL_ANSWER;
        const answerKey = `${polledGameId}:${latest.phase.stage}:${questionKeyFor(latest.phase)}`;
        if (isAnswerStage && answerKey !== activeAnswerKey) {
            activeAnswerKey = answerKey;
            selectedWager = null;
            getEl<HTMLInputElement>("answer-input").value = "";
            getEl<HTMLInputElement>("wager-final").value = "0";
        }
        // chain caught up with the optimistic echo
        if (optimisticAnswer && mySubmission(latest)?.submitted) {
            optimisticAnswer = null;
        }
        reconcileActionGuards(latest);
        if (actionsSent.size === 0) setTransactionStatus(null);
        render(latest);
        // Historic wagers matter for controls, not for the first paint. On a
        // rejoin this used to delay the whole table by one serial RPC per
        // completed question.
        void syncWagerHistory(snap, polledGameId, polledSession).then(() => {
            if (isCurrentGame(polledGameId, polledSession) && latest === snap) render(snap);
        });
    } catch (e) {
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= 2) {
            setTransactionStatus("Reconnecting to chain state…");
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
    switch (snap.phase.stage) {
        case STAGE_LOBBY:
            void renderLobby(snap);
            break;
        case STAGE_ANSWER:
        case STAGE_FINAL_ANSWER:
            renderQuestion(snap);
            break;
        case STAGE_REVIEW:
        case STAGE_FINAL_REVIEW:
            renderReview(snap);
            break;
        case STAGE_VOTE:
            renderVote(snap);
            break;
        case STAGE_FINISHED:
            renderResults(snap);
            break;
        case STAGE_ABANDONED:
            renderAbandoned(snap);
            break;
    }
}

// ── Lobby ────────────────────────────────────────────────────────────

function prefetchQuestion(packId: number, slot: number): void {
    const key = registryQuestionCacheKey(packId, slot);
    if (questionCache.has(key)) return;
    void questionText(packId, slot).catch(() => {
        // The normal poll remains the source of truth and will retry later.
    });
}

function renderLobby(snap: Snapshot): void {
    const lobbyGameId = gameId;
    const lobbySession = gameSession;
    if (lobbyGameId === null) return;
    getEl("lobby-game-id").textContent = String(lobbyGameId);
    // Never make the room wait on a cosmetic title lookup. Hosts normally
    // have it cached from the pack picker; joiners see a stable fallback for
    // one RPC round-trip and then the real title replaces it.
    getEl("lobby-title").textContent = packTitleCache.get(registryPackCacheKey(snap.game.pack_id)) ?? `pack #${snap.game.pack_id}`;
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
    setGameActions("lobby");
    showScreen("lobby");

    if (isStarter) void warmTx(game, "startGame", [lobbyGameId]);

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
        getEl("lobby-error").textContent = txError(e);
    } finally {
        busy = false;
        setLoading("btn-start-game", false);
    }
});

// ── Countdown (ticks between polls off the latest snapshot) ─────────

function countdownText(snap: Snapshot): string {
    if (snap.phase.deadline >= 2n ** 63n) return "";
    // `current_block` is a snapshot, not a live clock. Estimate intervening
    // blocks locally so the countdown feels continuous between RPC updates.
    const elapsedBlocks = latestObservedAt > 0
        ? Math.floor((Date.now() - latestObservedAt) / (BLOCK_SECONDS_ESTIMATE * 1_000))
        : 0;
    const blocksLeft = Number(snap.phase.deadline - snap.phase.current_block) - elapsedBlocks;
    if (blocksLeft <= 0) return "time's up";
    return `~${blocksLeft * BLOCK_SECONDS_ESTIMATE}s`;
}

setInterval(() => {
    if (!latest) return;
    const text = countdownText(latest);
    for (const id of ["question-countdown", "review-countdown", "vote-countdown"]) {
        const el = getEl(id);
        el.textContent = text;
        el.classList.toggle("urgent", text !== "" && text !== "time's up" && Number.parseInt(text.slice(1)) <= 15);
    }
}, 1_000);

// ── Question screen ──────────────────────────────────────────────────

const $wagerButtons = [...document.querySelectorAll<HTMLButtonElement>(".wager-btn")];
for (const btn of $wagerButtons) {
    btn.addEventListener("click", () => {
        const value = Number(btn.dataset.wager);
        if (wagerOutcomes.has(value)) return; // already spent
        selectedWager = value;
        paintWagerGrid();
    });
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
    const questionReady = snap.questionText.length > 0;
    getEl("question-number").textContent = isFinal
        ? `Final question · ${DIFFICULTY_NAMES[snap.phase.final_difficulty] ?? ""}`
        : `${snap.phase.cursor + 1} of ${snap.game.num_questions}`;
    getEl("question-text").textContent = questionReady ? snap.questionText : "Loading question…";
    getEl("question-countdown").textContent = countdownText(snap);

    const mine = mySubmission(snap);
    const amActive = mine?.active ?? false;
    const optimistic =
        optimisticAnswer !== null && optimisticAnswer.qkey === questionKeyFor(snap.phase);
    const answered = (mine?.submitted ?? false) || optimistic;
    getEl("answer-form").style.display = answered || !questionReady || !amActive ? "none" : "";
    getEl("submitted-card").style.display = answered ? "" : "none";

    if (!answered && amActive) {
        getEl("wager-grid-block").style.display = isFinal ? "none" : "";
        getEl("wager-final-row").style.display = isFinal ? "" : "none";
        if (isFinal) {
            const myIdx = snap.players.indexOf(myAddress);
            const myScore = myIdx >= 0 ? snap.scores[myIdx] : 0;
            getEl("wager-final-max").textContent = String(myScore);
            getEl<HTMLInputElement>("wager-final").max = String(myScore);
        } else {
            paintWagerGrid();
        }
    } else {
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
                return li(span("", fmtPlayer(snap, s.player)), span("right sub", text));
            }),
        );
    }
    setGameActions("active");
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
        const maxWager = myIndex >= 0 ? latest.scores[myIndex] : 0;
        const parsedWager = parseIntegerInRange(
            getEl<HTMLInputElement>("wager-final").value,
            0,
            maxWager,
        );
        if (parsedWager === null) {
            $err.textContent = `Final wager must be a whole number from 0 to ${maxWager}.`;
            return;
        }
        wager = parsedWager;
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
        await sendTx(game, "submitAnswer", gameId, answer, wager);
        selectedWager = null;
        getEl<HTMLInputElement>("answer-input").value = "";
        void poll();
    } catch (e) {
        clearActionSent("submit");
        optimisticAnswer = null;
        $err.textContent = txError(e);
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
// software keyboard. The answer dock is already within the visual viewport;
// reset only its internal scroll region so the question stays above it. Use a
// class rather than :has() for older mobile engines, then repeat after the
// viewport animation finishes (some Android/iOS browsers resize late).
const $answerInput = getEl<HTMLInputElement>("answer-input");
function keepQuestionVisibleForKeyboard(): void {
    if (!document.body.classList.contains("answer-input-focused")) return;
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
    document.body.classList.add("answer-input-focused");
    scheduleQuestionVisibilityForKeyboard();
});
$answerInput.addEventListener("blur", () => {
    document.body.classList.remove("answer-input-focused");
});
window.visualViewport?.addEventListener("resize", scheduleQuestionVisibilityForKeyboard);

// ── Review screen ────────────────────────────────────────────────────

function renderReview(snap: Snapshot): void {
    const isFinal = snap.phase.stage === STAGE_FINAL_REVIEW;
    getEl("review-number").textContent = isFinal
        ? "Final question — results"
        : `${snap.phase.cursor + 1} of ${snap.game.num_questions} — results`;
    getEl("review-question").textContent = snap.questionText;
    getEl("review-countdown").textContent = countdownText(snap);

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
            const row = li(
                span("", fmtPlayer(snap, s.player)),
                span("sub", s.active ? "" : "left quiz"),
            );
            row.className = "answer-row";
            if (!s.submitted) {
                row.append(
                    span("player-answer wrong grow", "NO ANSWER GIVEN"),
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
                row.append(btn);
            }
            row.append(span(`wager-badge ${s.correct ? "correct" : "wrong"}`, String(s.wager)));
            return row;
        }),
    );

    const continued = (mine?.continue_ready ?? false) || actionsSent.has("continue");
    const $btn = getEl<HTMLButtonElement>("btn-continue");
    $btn.disabled = continued || !amActive;
    $btn.textContent = !amActive ? "You left this quiz" : continued ? "Waiting for others…" : "Ready for next question";
    getEl("continue-status").textContent =
        `${snap.phase.continue_count}/${snap.phase.active_player_count} active players ready`;

    renderLeaderboard(getEl("review-leaderboard"), snap);
    setGameActions("active");
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
            getEl("review-error").textContent = message;
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
        getEl("review-error").textContent = txError(e);
        if (latest) render(latest);
    } finally {
        busy = false;
    }
});

// ── Difficulty vote ──────────────────────────────────────────────────

function renderVote(snap: Snapshot): void {
    const amActive = mySubmission(snap)?.active ?? false;
    getEl("vote-countdown").textContent = countdownText(snap);
    getEl("vote-status").textContent =
        `${snap.phase.submit_count}/${snap.phase.active_player_count} active players voted` +
        (actionsSent.has("difficulty") ? " — your vote is in" : "");
    for (const btn of document.querySelectorAll<HTMLButtonElement>(".btn-difficulty")) {
        btn.disabled = actionsSent.has("difficulty") || !amActive;
    }
    // The winning difficulty is not known yet, but all three final cards are
    // immutable and tiny. Fetching them during the vote removes a visible
    // delay from the final reveal without exposing any canonical answer.
    for (let difficulty = 0; difficulty < 3; difficulty++) {
        prefetchQuestion(snap.game.pack_id, FINAL_SLOT_BASE + difficulty);
    }
    setGameActions("active");
    showScreen("vote");
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".btn-difficulty")) {
    btn.addEventListener("click", async () => {
        if (busy || gameId === null || !productAccount || actionsSent.has("difficulty")) return;
        if (!latest || !mySubmission(latest)?.active) return;
        // optimistic: lock the vote in visually, roll back on error
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
            } else {
                clearActionSent("difficulty");
                getEl("vote-error").textContent = message;
            }
            if (latest) render(latest);
        } finally {
            busy = false;
        }
    });
}

// ── Results ──────────────────────────────────────────────────────────

function renderLeaderboard(list: HTMLElement, snap: Snapshot): void {
    const ranked = snap.players
        .map((p, i) => ({
            player: p,
            score: snap.scores[i],
            active: snap.submissions.find((submission) => submission.player.toLowerCase() === p.toLowerCase())?.active ?? true,
        }))
        // A forfeit is a permanent withdrawal, not a way to keep a leading
        // score and still win. Keep historical rows visible after finish.
        .sort((a, b) => Number(b.active) - Number(a.active) || b.score - a.score);
    renderList(
        list,
        ranked.map((r, i) =>
            li(
                span("sub", `#${i + 1}`),
                span("", fmtPlayer(snap, r.player)),
                span("sub", r.active ? "" : "left quiz"),
                span("right pts", `${r.score}`),
            ),
        ),
    );
}

function renderResults(snap: Snapshot): void {
    const activePlayers = snap.players.filter((player) =>
        snap.submissions.find((submission) => submission.player.toLowerCase() === player.toLowerCase())?.active ?? true,
    );
    const top = Math.max(...activePlayers.map((player) => snap.scores[snap.players.indexOf(player)]));
    const winners = activePlayers.filter((player) => snap.scores[snap.players.indexOf(player)] === top);
    getEl("results-winner").textContent = winners.map((player) => fmtPlayer(snap, player)).join(" & ");
    renderLeaderboard(getEl("results-leaderboard"), snap);
    stopGamePolling();
    setGameActions("hidden");
    showScreen("results");
}

function renderAbandoned(snap: Snapshot): void {
    getEl("abandoned-message").textContent = "Everyone left this quiz before it finished.";
    renderLeaderboard(getEl("abandoned-leaderboard"), snap);
    stopGamePolling();
    forgetSavedGame();
    setGameActions("hidden");
    showScreen("abandoned");
}

// ── Go ───────────────────────────────────────────────────────────────

init().catch((e) => {
    setConnectionStatus("error", "err");
    bootLog(`Unhandled init error: ${txError(e)}`, "err");
});
