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
import {
    createContractFromClient,
    createContractRuntimeFromClient,
    ensureContractAccountMapped,
} from "@parity/product-sdk-contracts";
import { ss58ToH160, truncateAddress } from "@parity/product-sdk-address";

import registryAbi from "./abi-registry.json";
import gameAbi from "./abi-game.json";
import contractInfo from "./contract-address.json";
import {
    ANSWER_BLOCK_PRESETS,
    BLOCK_SECONDS_ESTIMATE,
    isAllowedBlockPreset,
    PLAYER_CAP_PRESETS,
    presetLabel,
    questionCountOptions,
    REVIEW_BLOCK_PRESETS,
} from "./game-config";
import { activeGameSessionKey, parseStoredGameId } from "./game-session";
import { parseGameCode, parseIntegerInRange, utf8ByteLength } from "./input";
import { normalizeAnswer } from "./normalize";
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

const configuredRegistry = import.meta.env.VITE_QUIZZLER_REGISTRY;
const configuredGame = import.meta.env.VITE_QUIZZLER_GAME;
// A test host may inject an isolated registry/game pair at build time. Normal
// players always use the tracked deployment, and a partial/malformed override
// is rejected during boot rather than mixing contracts from different pairs.
const activeContracts = configuredRegistry || configuredGame
    ? { registry: configuredRegistry, game: configuredGame }
    : contractInfo;

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
const MAX_TITLE_BYTES = 64;
const MAX_EMOJI_BYTES = 32;
const MAX_QUESTION_BYTES = 256;
const MAX_ANSWER_BYTES = 64;
const POLL_FALLBACK_MS = 8_000;
const PREFLIGHT_TTL_MS = 5 * 60_000;
const DIFFICULTY_NAMES = ["Easy", "Medium", "Hard"];

const registrySupportsPackEmoji = (registryAbi as Array<{
    type?: string;
    name?: string;
    inputs?: unknown[];
}>).some((entry) => entry.type === "function" && entry.name === "createPack" && entry.inputs?.length === 2);

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

interface PackView {
    creator: string;
    title: string;
    /** Present on the fresh registry; optional while a staged migration is live. */
    emoji?: string;
    regular_count: number;
    finals_set_count: number;
    sealed: boolean;
}

interface Snapshot {
    phase: PhaseView;
    game: GameView;
    players: string[];
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
    maxPlayers: number;
}

// ── App state ────────────────────────────────────────────────────────

const manager = new SignerManager({ ss58Prefix: 0, dappName: "quizzler" });

let productAccount: SignerAccount | null = null;
let registry: any = null;
let game: any = null;
let assetHub: any = null;
let myAddress = ""; // lowercase H160
let savedGameId: bigint | null = null;
let nextTxNonce: number | null = null;
let nonceSync: Promise<number | null> | null = null;
let gameId: bigint | null = null;
// A final forfeit can make the game Abandoned. Keep that one terminal
// snapshot long enough to show its scorecard, even though this account is no
// longer active and therefore cannot resume it later.
let pendingAbandonedForfeit: bigint | null = null;
let latest: Snapshot | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let blockPollSubscription: { unsubscribe(): void } | null = null;
let bestBlocks: { subscribe: (next: () => void) => { unsubscribe(): void } } | null = null;
let lastBlockSignalAt = 0;
let selectedPackId: number | null = null;
let selectedPack: PackView | null = null;
let busy = false;

// Local per-stage action guards (cleared when the stage key changes) so we
// don't re-send txs the chain would reject anyway.
let actionKey = "";
const actionsSent = new Set<string>();

// Poll ordering guards: polls are skipped while one is in flight, and a
// snapshot that is BEHIND the one on screen is dropped unless it persists
// (a stale read or transient fork view resolves out of order; a genuine
// reorg keeps reporting the earlier phase and wins after a few polls).
let pollInFlight = false;
let pollQueued = false;
let lastRank = -1;
let behindStreak = 0;
let latestObservedAt = 0;
// Incremented whenever a game is entered or left. This distinguishes a new
// session from a stale request even when the player re-enters the same game.
let gameSession = 0;

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
const packTitleCache = new Map<number, string>();
// A sealed pack is immutable, so its metadata never needs another RPC read.
const sealedPackCache = new Map<number, PackView>();
const questionRequests = new Map<string, Promise<string>>();
const answerRequests = new Map<string, Promise<string>>();
const packTitleRequests = new Map<number, Promise<string>>();

// A dry-run is needed to size each contract call. Most game actions have
// plenty of think time, so warm the estimate in the background and let the
// wallet open immediately when the player taps the button.
const txPreflights = new Map<string, TxPreflight>();
let createGamePreflightTimer: ReturnType<typeof setTimeout> | null = null;

// Game configuration and player membership are immutable once the game has
// started. Keeping those values avoids two contract reads on every block.
let cachedGame: GameView | null = null;
let cachedPlayers: string[] | null = null;
let preferredQuestionKey: number | null = null;

// Pack-builder state
let builderPackId: number | null = null;
let builderRegular = 0;
const builderFinals = [false, false, false];

// ── Screen switching ─────────────────────────────────────────────────

const SCREENS = ["boot", "home", "pack-select", "configure", "builder", "lobby", "question", "review", "vote", "results", "abandoned"] as const;
type Screen = (typeof SCREENS)[number];

function showScreen(name: Screen): void {
    for (const s of SCREENS) {
        getEl(`screen-${s}`).classList.toggle("active", s === name);
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
const $gameActions = getEl("game-actions");
const $btnForfeitGame = getEl<HTMLButtonElement>("btn-forfeit-game");
const $forfeitDialog = getEl<HTMLDialogElement>("forfeit-dialog");

function setGameActions(mode: "hidden" | "lobby" | "active"): void {
    $gameActions.style.display = mode === "hidden" ? "none" : "flex";
    $btnForfeitGame.style.display = mode === "active" ? "" : "none";
}

function bootLog(msg: string, level: "info" | "ok" | "err" = "info"): void {
    appendLog($bootLog, msg, level);
}

function fmtAddr(addr: string): string {
    return addr.toLowerCase() === myAddress ? "You" : truncateAddress(addr);
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
function preflightKey(method: string, args: readonly unknown[]): string {
    return `${myAddress}:${method}:${args.map((arg) => String(arg)).join(":")}`;
}

/** Dry-run once to validate a call and produce the safely padded gas limit. */
async function estimateTx(handle: any, method: string, args: readonly unknown[]): Promise<TxOverrides | null> {
    if (!productAccount) return null;
    try {
        const q = await handle[method].query(...args, { origin: productAccount.address });
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
    const key = preflightKey(method, args);
    const existing = txPreflights.get(key);
    if (existing && existing.expiresAt > Date.now()) return key;
    const preflight: TxPreflight = {
        expiresAt: Date.now() + PREFLIGHT_TTL_MS,
        overrides: null,
        pending: Promise.resolve(null),
    };
    preflight.pending = estimateTx(handle, method, args).then((overrides) => {
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

async function reserveTxNonce(): Promise<number | null> {
    if (!productAccount || !assetHub) return null;
    if (nextTxNonce === null) {
        await syncNextTxNonce();
    }
    if (nextTxNonce === null) return null;
    const nonce = nextTxNonce;
    nextTxNonce += 1;
    return nonce;
}

/** Fetch best-block nonce once, shared by boot and the first transaction. */
function syncNextTxNonce(): Promise<number | null> {
    if (!productAccount || !assetHub) return Promise.resolve(null);
    if (nonceSync) return nonceSync;
    const request: Promise<number | null> = assetHub.apis.AccountNonceApi.account_nonce(productAccount.address, { at: "best" })
        .then((nonce: number | bigint) => {
            nextTxNonce = Number(nonce);
            return nextTxNonce;
        })
        .catch(() => null)
        .finally(() => {
            nonceSync = null;
        });
    nonceSync = request;
    return request;
}

/**
 * The contracts helper deliberately hides nonce selection. For interactive
 * games, however, finalized-state nonces turn Create → Start into a frequent
 * stale transaction. Submit its prepared Revive call with our best-block
 * nonce, resolving at inclusion just like the helper does.
 */
async function submitPreparedTx(transaction: any, nonce: number): Promise<void> {
    if (!productAccount) throw new Error("Account not ready");
    const signer = productAccount.getSigner();
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
            const nextSubscription = transaction.signSubmitAndWatch(signer, {
                nonce,
                mortality: { mortal: true, period: 256 },
            }).subscribe({
                next: (event: any) => {
                    if (event.type !== "txBestBlocksState" || !event.found || event.ok === undefined) return;
                    if (!event.ok) {
                        finish(new Error(JSON.stringify(event.dispatchError)));
                    } else {
                        finish();
                    }
                },
                error: (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
            });
            subscription = nextSubscription;
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
    if (!productAccount) throw new Error("Account not ready");
    for (let attempt = 0; ; attempt++) {
        try {
            // A warmed estimate avoids an RPC on the tap path. On retries we
            // intentionally estimate again against current chain state.
            const overrides = attempt === 0 && initialOverrides !== null
                ? initialOverrides
                : await estimateTx(handle, method, args);
            const nonce = await reserveTxNonce();
            if (nonce === null) {
                // Degrade safely to the SDK's submission path if the account
                // nonce API is unavailable in a host implementation.
                const result = await handle[method].tx(...args, {
                    signer: productAccount.getSigner(),
                    ...(overrides ?? {}),
                });
                if (!result.ok) throw new Error(JSON.stringify(result.dispatchError));
            } else {
                const transaction = await handle[method].prepare(...args, {
                    origin: productAccount.address,
                    ...(overrides ?? {}),
                });
                await submitPreparedTx(transaction, nonce);
            }
            return;
        } catch (e) {
            // The tx may or may not have reached a best block. Re-read before
            // another action/retry instead of assuming a nonce is still free.
            nextTxNonce = null;
            nonceSync = null;
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt === 0 && msg.includes("Stale")) {
                await new Promise((r) => setTimeout(r, 5_000));
                continue;
            }
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

// ── Registry content lookups (cached) ────────────────────────────────

async function questionText(packId: number, slot: number): Promise<string> {
    const key = `${packId}:${slot}`;
    const cached = questionCache.get(key);
    if (cached !== undefined) return cached;
    const pending = questionRequests.get(key);
    if (pending) return pending;
    const request = (async () => {
        const res = await registry.getQuestion.query(packId, slot);
        if (!res.success) return "";
        const text = res.value as string;
        questionCache.set(key, text);
        return text;
    })().finally(() => questionRequests.delete(key));
    questionRequests.set(key, request);
    return request;
}

async function canonicalAnswer(packId: number, slot: number): Promise<string> {
    const key = `${packId}:${slot}`;
    const cached = answerCache.get(key);
    if (cached !== undefined) return cached;
    const pending = answerRequests.get(key);
    if (pending) return pending;
    const request = (async () => {
        const res = await registry.getAnswers.query(packId, slot);
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
    const sealedPack = sealedPackCache.get(packId);
    if (sealedPack) return sealedPack.title;
    const cached = packTitleCache.get(packId);
    if (cached !== undefined) return cached;
    const pending = packTitleRequests.get(packId);
    if (pending) return pending;
    const request = (async () => {
        const res = await registry.getPack.query(packId);
        if (!res.success) return `pack #${packId}`;
        const pack = res.value as PackView;
        if (pack.sealed) sealedPackCache.set(packId, pack);
        const title = pack.title;
        packTitleCache.set(packId, title);
        return title;
    })().finally(() => packTitleRequests.delete(packId));
    packTitleRequests.set(packId, request);
    return request;
}

async function sealedPack(packId: number): Promise<PackView | null> {
    const cached = sealedPackCache.get(packId);
    if (cached) return cached;
    try {
        const res = await registry.getPack.query(packId);
        if (!res.success) return null;
        const pack = res.value as PackView;
        if (pack.sealed) {
            sealedPackCache.set(packId, pack);
            packTitleCache.set(packId, pack.title);
            return pack;
        }
    } catch {
        // A transient query failure should not discard the currently rendered list.
    }
    return null;
}

// ── Boot ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
    showScreen("boot");
    if (!isContractAddress(activeContracts.registry) || !isContractAddress(activeContracts.game)) {
        $connPill.textContent = "no contract";
        $connPill.className = "err";
        bootLog("Contract addresses not configured.", "err");
        bootLog("Run `pnpm deploy:contract` and rebuild.", "err");
        return;
    }

    bootLog("Connecting signer…");
    const connectRes = await manager.connect();
    if (!connectRes.ok) {
        $connPill.textContent = "offline";
        $connPill.className = "err";
        bootLog(`Signer connect failed: ${connectRes.error.message}`, "err");
        return;
    }
    bootLog("Signer connected", "ok");

    bootLog("Requesting product account quizzler.dot/0…");
    const productRes = await manager.getProductAccount("quizzler.dot", 0);
    if (!productRes.ok) {
        bootLog(`getProductAccount failed: ${productRes.error.message}`, "err");
        return;
    }
    productAccount = productRes.value;
    myAddress = ss58ToH160(productAccount.address).toLowerCase();
    savedGameId = readSavedGame();
    bootLog(`Account ready: ${truncateAddress(productAccount.address)}`, "ok");

    bootLog("Opening chain client…");
    // The chain descriptor carries substantial runtime metadata. Load it only
    // once the visible boot flow reaches the chain step so first paint is not
    // blocked by parsing it with the rest of the app bundle.
    const { paseo_asset_hub } = await import("@parity/product-sdk-descriptors/paseo-asset-hub");
    const client = await createChainClient({ chains: { assetHub: paseo_asset_hub } });
    assetHub = client.assetHub;
    bestBlocks = client.raw.assetHub.bestBlocks$;
    bootLog("Chain client ready", "ok");

    registry = createContractFromClient(
        client.raw.assetHub,
        paseo_asset_hub,
        activeContracts.registry,
        registryAbi as never,
        { signerManager: manager },
    );
    game = createContractFromClient(
        client.raw.assetHub,
        paseo_asset_hub,
        activeContracts.game,
        gameAbi as never,
        { signerManager: manager },
    );
    bootLog("Contract handles ready (registry + game)", "ok");

    // One-time SS58 → H160 mapping required by pallet-revive for .tx().
    // Idempotent: costs one signature the first time, free afterwards.
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
        bootLog(`Account mapping failed: ${txError(e)}`, "err");
        return;
    }

    // Prime the best-block nonce without holding up the home screen. It is
    // shared with the first action if the player gets there before it returns.
    void syncNextTxNonce();

    $connPill.textContent = "connected";
    $connPill.className = "ok";
    // Pack browsing is unrelated to reopening a live room. Start it in the
    // background so a refresh can return a player to the table without first
    // waiting for catalog RPCs.
    const packsReady = refreshPacks();
    const resume = await resumeSavedGame();
    if (resume === "resumed") return;
    await packsReady;
    showScreen("home");
    renderResumeCard();
    if (resume === "unavailable") {
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
const $maxPlayers = getEl<HTMLSelectElement>("cfg-max-players");
const $configPackArt = getEl("config-pack-art");
const $configPackTitle = getEl("config-pack-title");
const $configPackMeta = getEl("config-pack-meta");
const $resumeGameCard = getEl("resume-game-card");
const $resumeGameCode = getEl("resume-game-code");

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
    replaceSelectOptions(
        $maxPlayers,
        PLAYER_CAP_PRESETS.map((value) => ({
            value,
            label: `${value} ${value === 1 ? "player" : "players"}`,
        })),
        8,
    );
    renderQuestionCountOptions(MAX_GAME_QUESTIONS);
}

configureGameControls();

type CatalogPack = PackView & PackListItem;

let refreshingPacks = false;
let lastPackListSignature: string | null = null;
let catalogPacks: CatalogPack[] = [];
let packSearch = "";
// E2E runs can opt in to their disposable packs without exposing them to
// players on the normal home screen.
const showE2ETestPacks = import.meta.env.VITE_SHOW_E2E_PACKS === "1"
    || new URLSearchParams(window.location.search).get("show-test-packs") === "1";
// Fetch the stable starter IDs as well as recent community packs. This keeps
// the curated catalog available even after a long-lived registry accumulates
// lots of new packs, without making home-screen refreshes unbounded.
const PACK_RECENT_LIST_LIMIT = 100;
const PACK_FETCH_CONCURRENCY = 6;

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

async function refreshPacks(): Promise<void> {
    if (refreshingPacks) return;
    refreshingPacks = true;
    const error = getEl("screen-pack-select").classList.contains("active")
        ? $packSelectionError
        : $homeError;
    try {
        await refreshPacksInner();
        error.textContent = "";
    } catch {
        error.textContent = "Couldn’t refresh quiz packs. Retrying…";
    } finally {
        refreshingPacks = false;
    }
}

async function refreshPacksInner(): Promise<void> {
    const countRes = await registry.packCount.query();
    if (!countRes.success) throw new Error("pack count query failed");
    const count = Number(countRes.value);
    const starterIds = Array.from({ length: Math.min(count, STARTER_PACK_COUNT) }, (_, id) => id);
    const recentIds = Array.from(
        { length: Math.min(count, PACK_RECENT_LIST_LIMIT) },
        (_, offset) => count - 1 - offset,
    );
    const ids = [...new Set([...starterIds, ...recentIds])];
    const packs = await mapWithConcurrency(ids, PACK_FETCH_CONCURRENCY, sealedPack);
    catalogPacks = packs.flatMap((pack, index) => pack === null ? [] : [{ id: ids[index], ...pack }]);
    renderPackList();
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

function renderPackList(): void {
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
    if (signature === lastPackListSignature) return;
    const communityWasOpen = $packList.querySelector<HTMLDetailsElement>(".community-packs")?.open ?? false;
    lastPackListSignature = signature;
    const { featured, community } = sectionPacks(catalogPacks, packSearch, showE2ETestPacks);
    const total = featured.length + community.length;
    if (total === 0) {
        const empty = document.createElement("p");
        empty.className = "pack-empty";
        empty.textContent = packSearch.trim()
            ? `No packs match “${packSearch.trim()}”.`
            : "No sealed packs yet — create one!";
        $packList.replaceChildren(empty);
        $packCatalogStatus.textContent = "";
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

    const parts: string[] = [];
    if (featured.length > 0) parts.push(`${featured.length} featured`);
    if (community.length > 0) parts.push(`${community.length} community`);
    $packCatalogStatus.textContent = `${parts.join(" · ")} ${total === 1 ? "pack" : "packs"}`;
}

$packSearch.addEventListener("input", () => {
    packSearch = $packSearch.value;
    renderPackList();
});

function showPackSelection(): void {
    $homeError.textContent = "";
    $packSelectionError.textContent = "";
    showScreen("pack-select");
    void refreshPacks();
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
        void refreshPacks();
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
    const maxPlayers = Number($maxPlayers.value);
    if (!Number.isInteger(maxPlayers) || !PLAYER_CAP_PRESETS.some((cap) => cap === maxPlayers)) {
        return fail("Choose one of the listed player limits.");
    }
    return {
        packId: selectedPackId,
        numQuestions,
        answerBlocks,
        reviewBlocks,
        maxPlayers,
    };
}

function gameConfigArgs(config: CreatedGameConfig): readonly unknown[] {
    return [
        config.packId,
        config.numQuestions,
        config.answerBlocks,
        config.reviewBlocks,
        config.maxPlayers,
    ];
}

/** Debounce form edits, then use the player's think time to size createGame. */
function scheduleCreateGamePreflight(): void {
    if (createGamePreflightTimer) clearTimeout(createGamePreflightTimer);
    createGamePreflightTimer = setTimeout(() => {
        createGamePreflightTimer = null;
        if (!game || !productAccount) return;
        const config = readCreatedGameConfig();
        if (config) void warmTx(game, "createGame", gameConfigArgs(config));
    }, 250);
}

async function myLatestPackId(): Promise<number | null> {
    const res = await registry.myLatestPack.query(myAddress);
    if (!res.success) return null;
    const id = Number(res.value);
    return id === NO_PACK ? null : id;
}

async function myLatestGameId(): Promise<bigint | null> {
    const res = await game.myLatestGame.query(myAddress);
    if (!res.success) return null;
    const id = BigInt(res.value);
    return id === 0n ? null : id;
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
    if (savedGameId === null) return true;
    error.textContent = "You already have a quiz in progress. Resume it, leave its lobby, or forfeit it before starting another.";
    return false;
}

getEl("btn-create-game").addEventListener("click", async () => {
    if (busy || selectedPackId === null || selectedPack === null || !productAccount) return;
    if (createGamePreflightTimer) {
        clearTimeout(createGamePreflightTimer);
        createGamePreflightTimer = null;
    }
    $configError.textContent = "";
    if (!canStartAnotherQuiz($configError)) return;
    const config = readCreatedGameConfig(true);
    if (!config) return;
    busy = true;
    setLoading("btn-create-game", true);
    try {
        await sendWarmedTx(game, "createGame", gameConfigArgs(config));
        $configError.textContent = "Game created — opening your lobby…";
        const id = await myLatestGameId();
        if (id === null) throw new Error("could not locate the created game");
        enterGame(id, createdLobbySnapshot(config));
    } catch (e) {
        $configError.textContent = txError(e);
    } finally {
        busy = false;
        setLoading("btn-create-game", false);
    }
});

for (const select of [$questionCount, $answerBlocks, $reviewBlocks, $maxPlayers]) {
    select.addEventListener("change", () => {
        $configError.textContent = "";
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
    if (savedGameId !== null) {
        if (savedGameId === id) {
            void resumeSavedGame();
            return;
        }
        canStartAnotherQuiz();
        return;
    }
    busy = true;
    setLoading("btn-join-game", true);
    try {
        await sendTx(game, "joinGame", id);
        enterGame(id);
    } catch (e) {
        const msg = txError(e);
        // Rejoining from the lobby is always safe. Once a game starts,
        // `GameAlreadyStarted` is also returned to strangers, so verify that
        // this account already belongs to the game before entering its UI.
        if (msg.includes("AlreadyJoined")) {
            enterGame(id);
        } else if (msg.includes("GameAlreadyStarted") && await amActivePlayerInGame(id)) {
            enterGame(id);
        } else if (msg.includes("GameAlreadyStarted")) {
            $homeError.textContent = "This game has already started.";
        } else {
            $homeError.textContent = msg;
        }
    } finally {
        busy = false;
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

// ── Pack builder ─────────────────────────────────────────────────────

const $builderError = getEl("builder-error");
const $builderProgress = getEl("builder-progress");
const $btnSeal = getEl<HTMLButtonElement>("btn-seal-pack");
const $builderAnswerInputs = [...document.querySelectorAll<HTMLInputElement>(".q-answer")];

function openPackBuilder(): void {
    builderPackId = null;
    builderRegular = 0;
    builderFinals.fill(false);
    getEl<HTMLInputElement>("pack-title").value = "";
    getEl<HTMLInputElement>("pack-emoji").value = "✨";
    getEl<HTMLInputElement>("q-text").value = "";
    for (const input of $builderAnswerInputs) input.value = "";
    getEl<HTMLSelectElement>("q-kind").value = "regular";
    getEl("builder-title").textContent = "New pack";
    getEl("builder-create-row").style.display = "";
    getEl("builder-question-form").style.display = "none";
    renderList(getEl("builder-questions"), []);
    $builderError.textContent = "";
    showScreen("builder");
}

for (const id of ["btn-new-pack", "btn-new-pack-from-picker"]) {
    getEl(id).addEventListener("click", openPackBuilder);
}

getEl("btn-create-pack").addEventListener("click", async () => {
    if (busy || !productAccount) return;
    $builderError.textContent = "";
    const title = getEl<HTMLInputElement>("pack-title").value.trim();
    const emoji = getEl<HTMLInputElement>("pack-emoji").value.trim();
    if (!title) {
        $builderError.textContent = "Give the pack a title.";
        return;
    }
    if (utf8ByteLength(title) > MAX_TITLE_BYTES) {
        $builderError.textContent = `Pack titles can be at most ${MAX_TITLE_BYTES} bytes.`;
        return;
    }
    if (!emoji) {
        $builderError.textContent = "Choose an emoji for the pack cover.";
        return;
    }
    if (utf8ByteLength(emoji) > MAX_EMOJI_BYTES) {
        $builderError.textContent = `Pack emojis can be at most ${MAX_EMOJI_BYTES} bytes.`;
        return;
    }
    busy = true;
    setLoading("btn-create-pack", true);
    try {
        // Keep the staged migration non-breaking: the old registry ABI has no
        // emoji argument, while the promoted fresh registry stores it forever.
        await sendTx(registry, "createPack", ...(registrySupportsPackEmoji ? [title, emoji] : [title]));
        const id = await myLatestPackId();
        if (id === null) throw new Error("could not locate the created pack");
        builderPackId = id;
        getEl("builder-title").textContent = `${registrySupportsPackEmoji ? `${emoji} ` : ""}${title} (pack #${builderPackId})`;
        getEl("builder-create-row").style.display = "none";
        getEl("builder-question-form").style.display = "";
        updateBuilderProgress();
    } catch (e) {
        $builderError.textContent = txError(e);
    } finally {
        busy = false;
        setLoading("btn-create-pack", false);
    }
});

function updateBuilderProgress(): void {
    const finals = ["easy", "medium", "hard"]
        .map((n, i) => `${n} ${builderFinals[i] ? "✓" : "✗"}`)
        .join(" · ");
    $builderProgress.textContent = `${builderRegular} regular question(s) · finals: ${finals}`;
    $btnSeal.disabled = !(builderRegular >= 1 && builderFinals.every(Boolean));
}

getEl("btn-add-question").addEventListener("click", async () => {
    if (busy || builderPackId === null || !productAccount) return;
    $builderError.textContent = "";
    const text = getEl<HTMLInputElement>("q-text").value.trim();
    const enteredAnswers = $builderAnswerInputs.map((input) => input.value.trim()).filter(Boolean);
    const kind = getEl<HTMLSelectElement>("q-kind").value;
    if (!text || enteredAnswers.length === 0) {
        $builderError.textContent = "A question needs text and at least one answer.";
        return;
    }
    if (utf8ByteLength(text) > MAX_QUESTION_BYTES) {
        $builderError.textContent = `Questions can be at most ${MAX_QUESTION_BYTES} bytes.`;
        return;
    }
    const answers: string[] = [];
    const normalizedAnswers = new Set<string>();
    for (const answer of enteredAnswers) {
        const normalized = normalizeAnswer(answer);
        if (!normalized) {
            $builderError.textContent = "Each accepted answer needs at least one letter or number.";
            return;
        }
        if (normalized.length > MAX_ANSWER_BYTES) {
            $builderError.textContent = `Accepted answers can be at most ${MAX_ANSWER_BYTES} bytes.`;
            return;
        }
        if (!normalizedAnswers.has(normalized)) {
            normalizedAnswers.add(normalized);
            // The contract's no_std normalizer intentionally only handles
            // ASCII. Send the same folded value a player will submit so
            // answers such as “café” remain matchable end-to-end.
            answers.push(normalized);
        }
    }
    if (answers.length > 5) {
        $builderError.textContent = "At most 5 accepted answers.";
        return;
    }
    const isFinal = kind !== "regular";
    const difficulty = isFinal ? Number(kind) : 0;
    busy = true;
    setLoading("btn-add-question", true);
    try {
        try {
            await sendTx(registry, "addQuestion", builderPackId, text, answers, isFinal, difficulty);
        } catch (e) {
            // Pack ids are assigned at execution time, so a best-block reorg
            // can shift them between resolution and dispatch — the tx then
            // hits someone else's pack and reverts. Re-resolve and retry once.
            if (!/revert/i.test(txError(e))) throw e;
            const id = await myLatestPackId();
            if (id === null) throw e;
            builderPackId = id;
            await sendTx(registry, "addQuestion", builderPackId, text, answers, isFinal, difficulty);
        }
        if (isFinal) builderFinals[difficulty] = true;
        else builderRegular += 1;
        const tag = isFinal ? `final · ${DIFFICULTY_NAMES[difficulty]}` : `Q${builderRegular}`;
        getEl("builder-questions").appendChild(
            li(span("sub", tag), span("", ` ${text}`)),
        );
        getEl<HTMLInputElement>("q-text").value = "";
        for (const input of $builderAnswerInputs) input.value = "";
        updateBuilderProgress();
    } catch (e) {
        $builderError.textContent = txError(e);
    } finally {
        busy = false;
        setLoading("btn-add-question", false);
    }
});

getEl("btn-seal-pack").addEventListener("click", async () => {
    if (busy || builderPackId === null || !productAccount) return;
    busy = true;
    setLoading("btn-seal-pack", true);
    try {
        try {
            await sendTx(registry, "sealPack", builderPackId);
        } catch (e) {
            // same reorg id-shift heal as addQuestion
            if (!/revert/i.test(txError(e))) throw e;
            const id = await myLatestPackId();
            if (id === null) throw e;
            builderPackId = id;
            await sendTx(registry, "sealPack", builderPackId);
        }
        await refreshPacks();
        showScreen("home");
        renderResumeCard();
    } catch (e) {
        $builderError.textContent = txError(e);
    } finally {
        busy = false;
        setLoading("btn-seal-pack", false);
    }
});

getEl("btn-builder-done").addEventListener("click", async () => {
    await refreshPacks();
    showScreen("home");
    renderResumeCard();
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
            max_players: config.maxPlayers,
            player_count: 1,
            active_player_count: 1,
        },
        players: [myAddress],
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
 * instead of waiting for the next arbitrary two-second interval. A low-rate
 * fallback keeps the table live if the host's block subscription drops.
 */
function startGamePolling(): void {
    stopGamePolling();
    if (bestBlocks) {
        blockPollSubscription = bestBlocks.subscribe(() => {
            lastBlockSignalAt = Date.now();
            if (document.visibilityState === "visible") void poll();
        });
    } else {
        void poll();
    }
    pollTimer = setInterval(() => {
        if (document.visibilityState === "visible" && Date.now() - lastBlockSignalAt >= POLL_FALLBACK_MS) {
            void poll();
        }
    }, POLL_FALLBACK_MS);
}

function enterGame(id: bigint, initialSnapshot: Snapshot | null = null): void {
    gameSession += 1;
    gameId = id;
    pendingAbandonedForfeit = null;
    rememberGame(id);
    latest = initialSnapshot;
    actionKey = "";
    actionsSent.clear();
    wagerOutcomes = new Map();
    wagerHistoryLoadedUpTo = -1;
    selectedWager = null;
    activeAnswerKey = "";
    optimisticAnswer = null;
    lastRank = -1;
    behindStreak = 0;
    latestObservedAt = initialSnapshot ? Date.now() : 0;
    cachedGame = initialSnapshot?.game ?? null;
    cachedPlayers = initialSnapshot?.players ?? null;
    preferredQuestionKey = null;
    getEl<HTMLInputElement>("answer-input").value = "";
    getEl<HTMLInputElement>("wager-final").value = "0";
    setGameActions("hidden");
    renderResumeCard();
    if (initialSnapshot) render(initialSnapshot);
    startGamePolling();
}

function leaveGame({ preserveSavedGame = false }: { preserveSavedGame?: boolean } = {}): void {
    gameSession += 1;
    gameId = null;
    pendingAbandonedForfeit = null;
    latest = null;
    selectedWager = null;
    activeAnswerKey = "";
    optimisticAnswer = null;
    cachedGame = null;
    cachedPlayers = null;
    preferredQuestionKey = null;
    latestObservedAt = 0;
    if (!preserveSavedGame) forgetSavedGame();
    if ($forfeitDialog.open) $forfeitDialog.close();
    setGameActions("hidden");
    stopGamePolling();
    void refreshPacks();
    showScreen("home");
    renderResumeCard();
}

function isCurrentGame(id: bigint, session: number): boolean {
    return gameId === id && gameSession === session;
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
        const wasLobby = latest?.phase.stage === STAGE_LOBBY;
        const needGame = cachedGame === null || wasLobby;
        const needPlayers = cachedPlayers === null || wasLobby;
        // On the normal path the active slot is unchanged, so all five reads
        // can start together. A stage transition only needs one corrective
        // submissions read, rather than forcing every poll into two waves.
        const expectedQuestionKey = preferredQuestionKey ?? (latest ? questionKeyFor(latest.phase) : FINAL_QKEY);
        const [phaseRes, maybeGameRes, maybePlayersRes, scoresRes, initialSubsRes] = await Promise.all([
            game.getPhase.query(polledGameId),
            needGame ? game.getGame.query(polledGameId) : Promise.resolve(null),
            needPlayers ? game.getPlayers.query(polledGameId) : Promise.resolve(null),
            game.getScores.query(polledGameId),
            game.getSubmissions.query(polledGameId, expectedQuestionKey),
        ]);
        if (!isCurrentGame(polledGameId, polledSession)) return;
        if (!phaseRes.success) return;
        const phase = phaseRes.value as PhaseView;
        const qkey = questionKeyFor(phase);

        let gameRes = maybeGameRes;
        let playersRes = maybePlayersRes;
        // A reorg can be the one case where our previous non-lobby cache is
        // no longer valid. Fall back to fresh lobby membership in that case.
        if (phase.stage === STAGE_LOBBY && !needGame) {
            [gameRes, playersRes] = await Promise.all([
                game.getGame.query(polledGameId),
                game.getPlayers.query(polledGameId),
            ]);
        }
        if (!isCurrentGame(polledGameId, polledSession)) return;
        if (!scoresRes.success || !initialSubsRes.success) return;

        let gameView: GameView;
        if (gameRes) {
            if (!gameRes.success) return;
            gameView = gameRes.value as GameView;
        } else if (cachedGame) {
            gameView = cachedGame;
        } else {
            return;
        }

        let players: string[];
        const needFreshPlayers = cachedPlayers === null || cachedPlayers.length !== phase.player_count;
        if (needFreshPlayers && !playersRes) {
            playersRes = await game.getPlayers.query(polledGameId);
            if (!isCurrentGame(polledGameId, polledSession)) return;
        }
        if (playersRes) {
            if (!playersRes.success) return;
            players = (playersRes.value as string[]).map((p) => p.toLowerCase());
        } else if (cachedPlayers) {
            players = cachedPlayers;
        } else {
            return;
        }

        let subsRes = initialSubsRes;
        if (qkey !== expectedQuestionKey) {
            subsRes = await game.getSubmissions.query(polledGameId, qkey);
            if (!isCurrentGame(polledGameId, polledSession)) return;
            if (!subsRes.success) return;
        }
        if (qkey === expectedQuestionKey || phase.stage !== STAGE_LOBBY) {
            preferredQuestionKey = null;
        }

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

        // `getGame` and `getPlayers` only mutate while a lobby is open. Once
        // play starts this saves two RPCs per block for every player.
        cachedGame = gameView;
        cachedPlayers = players;

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
            scores: (scoresRes.value as (number | bigint)[]).map(Number),
            submissions: subsRes.value as SubmissionView[],
            questionText: qText,
            answerText: aText,
        };
        const mine = snap.submissions.find((submission) => submission.player.toLowerCase() === myAddress);
        if (!players.includes(myAddress) || mine?.active === false) {
            if (phase.stage === STAGE_ABANDONED && pendingAbandonedForfeit === polledGameId) {
                latest = snap;
                latestObservedAt = Date.now();
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
        // reset per-stage action guards when the stage changes
        const key = `${polledGameId}:${latest.phase.stage}:${latest.phase.cursor}`;
        if (key !== actionKey) {
            actionKey = key;
            actionsSent.clear();
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
        render(latest);
        // Historic wagers matter for controls, not for the first paint. On a
        // rejoin this used to delay the whole table by one serial RPC per
        // completed question.
        void syncWagerHistory(snap, polledGameId, polledSession).then(() => {
            if (isCurrentGame(polledGameId, polledSession) && latest === snap) render(snap);
        });
    } catch (e) {
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
    const key = `${packId}:${slot}`;
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
    getEl("lobby-title").textContent = packTitleCache.get(snap.game.pack_id) ?? `pack #${snap.game.pack_id}`;
    const starter = snap.players[0] ?? "";
    renderList(
        getEl("lobby-players"),
        snap.players.map((p) =>
            li(
                span("", fmtAddr(p)),
                span("sub", p.toLowerCase() === starter.toLowerCase() ? "starts when ready" : ""),
            ),
        ),
    );
    const isStarter = starter.toLowerCase() === myAddress;
    getEl("btn-start-game").style.display = isStarter ? "" : "none";
    getEl("lobby-waiting").style.display = isStarter ? "none" : "";
    getEl("lobby-waiting").textContent = starter
        ? `Waiting for ${fmtAddr(starter)} to start…`
        : "Waiting for a player to start…";
    setGameActions("lobby");
    showScreen("lobby");

    // First regular question is always slot zero. Fetch it while everyone is
    // joining so the answer screen does not need another network round-trip.
    prefetchQuestion(snap.game.pack_id, 0);
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

/**
 * `startGame` has just landed in a best block. The lobby snapshot already
 * contains every immutable value needed for the first card, so switch screens
 * now instead of waiting for the reconciliation poll. Controls remain locked
 * until its real question text arrives.
 */
function showStartedGame(): void {
    if (gameId === null || latest?.phase.stage !== STAGE_LOBBY) return;
    const previous = latest;
    const phase: PhaseView = {
        ...previous.phase,
        stage: STAGE_ANSWER,
        cursor: 0,
        deadline: previous.phase.current_block + BigInt(previous.game.answer_blocks),
        slot: 0,
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
        questionText: questionCache.get(`${previous.game.pack_id}:0`) ?? "",
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
        preferredQuestionKey = 0;
        await sendWarmedTx(game, "startGame", [gameId]);
        showStartedGame();
        void poll();
    } catch (e) {
        preferredQuestionKey = null;
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
                return li(span("", fmtAddr(s.player)), span("right sub", text));
            }),
        );
    }
    if (!isFinal && snap.phase.cursor + 1 < snap.game.num_questions) {
        prefetchQuestion(snap.game.pack_id, snap.phase.cursor + 1);
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
    actionsSent.add("submit");
    optimisticAnswer = { qkey: questionKeyFor(latest.phase), answer, wager };
    render(latest);
    busy = true;
    try {
        await sendTx(game, "submitAnswer", gameId, answer, wager);
        selectedWager = null;
        getEl<HTMLInputElement>("answer-input").value = "";
        void poll();
    } catch (e) {
        actionsSent.delete("submit");
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
                span("", fmtAddr(s.player)),
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
    $btn.textContent = !amActive ? "You left this quiz" : continued ? "Waiting for others…" : "Continue";
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
    actionsSent.add(key);
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
            actionsSent.delete(key);
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
    actionsSent.add("continue");
    if (latest) render(latest);
    busy = true;
    try {
        await sendTx(game, "readyContinue", gameId);
        void poll();
    } catch (e) {
        actionsSent.delete("continue");
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
        actionsSent.add("difficulty");
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
                actionsSent.delete("difficulty");
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
                span("", fmtAddr(r.player)),
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
    getEl("results-winner").textContent = winners.map(fmtAddr).join(" & ");
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
    $connPill.textContent = "error";
    $connPill.className = "err";
    bootLog(`Unhandled init error: ${txError(e)}`, "err");
});
