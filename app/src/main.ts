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
 * correctness are public on-chain — this client just chooses not to show
 * them before the review phase, like cards lying face-down on the table.
 */

import { SignerManager, type SignerAccount } from "@parity/product-sdk-signer";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import {
    createContractFromClient,
    createContractRuntimeFromClient,
    ensureContractAccountMapped,
} from "@parity/product-sdk-contracts";
import { ss58ToH160, truncateAddress } from "@parity/product-sdk-address";

import registryAbi from "./abi-registry.json";
import gameAbi from "./abi-game.json";
import contractInfo from "./contract-address.json";
import { parseGameCode, parseIntegerInRange, utf8ByteLength } from "./input";
import { normalizeAnswer } from "./normalize";
import { appendLog, getEl, li, renderList, span } from "./ui";

// ── Constants ────────────────────────────────────────────────────────

const STAGE_LOBBY = 0;
const STAGE_ANSWER = 1;
const STAGE_REVIEW = 2;
const STAGE_VOTE = 3;
const STAGE_FINAL_ANSWER = 4;
const STAGE_FINAL_REVIEW = 5;
const STAGE_FINISHED = 6;
const FINAL_QKEY = 255;
const NO_SLOT = 255;
const NO_PACK = 0xffffffff;
const MAX_STAGE_BLOCKS = 600;
const MAX_STAGE_SECONDS = MAX_STAGE_BLOCKS * 2;
const MAX_GAME_QUESTIONS = 10;
const MAX_PLAYERS = 16;
const MAX_TITLE_BYTES = 64;
const MAX_QUESTION_BYTES = 256;
const MAX_ANSWER_BYTES = 64;
const SECONDS_PER_BLOCK = 2; // measured on Paseo Asset Hub Next (2026-07)
const POLL_MS = 2_000; // one poll per block
const DIFFICULTY_NAMES = ["Easy", "Medium", "Hard"];

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
    player_count: number;
}

interface SubmissionView {
    player: string;
    submitted: boolean;
    answer: string;
    wager: number;
    correct: boolean;
    overturn_votes: number;
    continue_ready: boolean;
}

interface GameView {
    pack_id: number;
    creator: string;
    num_questions: number;
    answer_blocks: number;
    review_blocks: number;
    max_players: number;
    player_count: number;
}

interface PackView {
    creator: string;
    title: string;
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

// ── App state ────────────────────────────────────────────────────────

const manager = new SignerManager({ ss58Prefix: 0, dappName: "quizzler" });

let productAccount: SignerAccount | null = null;
let registry: any = null;
let game: any = null;
let myAddress = ""; // lowercase H160
let gameId: bigint | null = null;
let latest: Snapshot | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
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
let lastRank = -1;
let behindStreak = 0;
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

// Pack-builder state
let builderPackId: number | null = null;
let builderRegular = 0;
const builderFinals = [false, false, false];

// ── Screen switching ─────────────────────────────────────────────────

const SCREENS = ["boot", "home", "builder", "lobby", "question", "review", "vote", "results"] as const;
type Screen = (typeof SCREENS)[number];

function showScreen(name: Screen): void {
    for (const s of SCREENS) {
        getEl(`screen-${s}`).classList.toggle("active", s === name);
    }
}

const $bootLog = getEl("boot-log");
const $connPill = getEl("conn-pill");

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
}

function txError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    // contract reverts carry the raw revert string (e.g. "AlreadyJoined")
    return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/**
 * Submit a contract tx, retrying once on `Invalid: Stale`. PAPI derives
 * nonces from finalized state, so a tap that closely follows the player's
 * previous transaction (vote → continue) can race finality and pick an
 * already-spent nonce; a short pause and one retry absorbs it.
 */
async function sendTx(handle: any, method: string, ...args: unknown[]): Promise<void> {
    if (!productAccount) throw new Error("Account not ready");
    for (let attempt = 0; ; attempt++) {
        try {
            // Pre-size the weight with our own margin: the SDK submits with
            // the dry-run weight exactly, which OutOfGas-es methods that make
            // cross-contract registry calls. Query errors fall through — the
            // tx's own dry-run surfaces them with a proper revert reason.
            let overrides: Record<string, unknown> = {};
            try {
                const q = await handle[method].query(...args, { origin: productAccount.address });
                if (q?.gasRequired) {
                    overrides = {
                        gasLimit: {
                            ref_time: (q.gasRequired.ref_time * 3n) / 2n,
                            proof_size: (q.gasRequired.proof_size * 3n) / 2n,
                        },
                        // Providing both overrides makes the SDK skip its own
                        // dry-run entirely (we just did one) — saves a full
                        // RPC round-trip per tap. The deposit is a cap, not a
                        // cost, so a generous constant is safe.
                        storageDepositLimit: 20_000_000_000n,
                    };
                }
            } catch {
                // ignored — see above
            }
            const result = await handle[method].tx(...args, {
                signer: productAccount.getSigner(),
                ...overrides,
            });
            if (!result.ok) throw new Error(JSON.stringify(result.dispatchError));
            return;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt === 0 && msg.includes("Stale")) {
                await new Promise((r) => setTimeout(r, 5_000));
                continue;
            }
            throw e;
        }
    }
}

// ── Registry content lookups (cached) ────────────────────────────────

async function questionText(packId: number, slot: number): Promise<string> {
    const key = `${packId}:${slot}`;
    const cached = questionCache.get(key);
    if (cached !== undefined) return cached;
    const res = await registry.getQuestion.query(packId, slot);
    if (!res.success) return "";
    questionCache.set(key, res.value as string);
    return res.value as string;
}

async function canonicalAnswer(packId: number, slot: number): Promise<string> {
    const key = `${packId}:${slot}`;
    const cached = answerCache.get(key);
    if (cached !== undefined) return cached;
    const res = await registry.getAnswers.query(packId, slot);
    if (!res.success) return "";
    const answers = res.value as string[];
    const canonical = answers[0] ?? "";
    answerCache.set(key, canonical);
    return canonical;
}

async function packTitle(packId: number): Promise<string> {
    const cached = packTitleCache.get(packId);
    if (cached !== undefined) return cached;
    const res = await registry.getPack.query(packId);
    if (!res.success) return `pack #${packId}`;
    const title = (res.value as PackView).title;
    packTitleCache.set(packId, title);
    return title;
}

// ── Boot ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
    showScreen("boot");
    if (!contractInfo.registry || !contractInfo.game) {
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
    bootLog(`Account ready: ${truncateAddress(productAccount.address)}`, "ok");

    bootLog("Opening chain client…");
    const client = await createChainClient({ chains: { assetHub: paseo_asset_hub } });
    bootLog("Chain client ready", "ok");

    registry = createContractFromClient(
        client.raw.assetHub,
        paseo_asset_hub,
        contractInfo.registry as `0x${string}`,
        registryAbi as never,
        { signerManager: manager },
    );
    game = createContractFromClient(
        client.raw.assetHub,
        paseo_asset_hub,
        contractInfo.game as `0x${string}`,
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

    $connPill.textContent = "connected";
    $connPill.className = "ok";
    await refreshPacks();
    showScreen("home");
}

// ── Home: packs & games ──────────────────────────────────────────────

const $packList = getEl("pack-list");
const $homeError = getEl("home-error");
const $btnCreateGame = getEl<HTMLButtonElement>("btn-create-game");

let refreshingPacks = false;

async function refreshPacks(): Promise<void> {
    if (refreshingPacks) return;
    refreshingPacks = true;
    try {
        await refreshPacksInner();
    } finally {
        refreshingPacks = false;
    }
}

async function refreshPacksInner(): Promise<void> {
    const countRes = await registry.packCount.query();
    if (!countRes.success) return;
    const count = Number(countRes.value);
    const from = Math.max(0, count - 50);
    const rows: HTMLLIElement[] = [];
    for (let id = count - 1; id >= from; id--) {
        const res = await registry.getPack.query(id);
        if (!res.success) continue;
        const pack = res.value as PackView;
        if (!pack.sealed) continue;
        const row = li(
            span("", `${pack.title}`),
            span("sub", `#${id} · ${pack.regular_count} questions`),
        );
        row.className = "clickable";
        row.dataset.testid = `pack-${id}`;
        if (selectedPackId === id) row.classList.add("selected");
        row.addEventListener("click", () => {
            selectedPackId = id;
            selectedPack = pack;
            $btnCreateGame.disabled = false;
            const qInput = getEl<HTMLInputElement>("cfg-questions");
            const maxQ = Math.min(pack.regular_count, 10);
            qInput.max = String(maxQ);
            if (Number(qInput.value) > maxQ) qInput.value = String(maxQ);
            for (const el of $packList.children) el.classList.remove("selected");
            row.classList.add("selected");
        });
        rows.push(row);
    }
    if (rows.length === 0) {
        rows.push(li(span("sub", "No sealed packs yet — create one!")));
    }
    renderList($packList, rows);
}

// Keep the browse list fresh while the player sits on the home screen —
// packs published by others should show up without a reload.
setInterval(() => {
    if (registry && getEl("screen-home").classList.contains("active") && !busy) {
        void refreshPacks();
    }
}, 5_000);

function secondsToBlocks(seconds: number): number {
    return Math.max(2, Math.round(seconds / SECONDS_PER_BLOCK));
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

/** A started game is rejoinable only by an existing player. */
async function amPlayerInGame(id: bigint): Promise<boolean> {
    try {
        const res = await game.getPlayers.query(id);
        return res.success && (res.value as string[]).some((p) => p.toLowerCase() === myAddress);
    } catch {
        return false;
    }
}

getEl("btn-create-game").addEventListener("click", async () => {
    if (busy || selectedPackId === null || selectedPack === null || !productAccount) return;
    $homeError.textContent = "";
    const maxQuestions = Math.min(selectedPack.regular_count, MAX_GAME_QUESTIONS);
    const numQuestions = parseIntegerInRange(
        getEl<HTMLInputElement>("cfg-questions").value,
        1,
        maxQuestions,
    );
    if (numQuestions === null) {
        $homeError.textContent = `Choose between 1 and ${maxQuestions} questions.`;
        return;
    }
    const answerSeconds = parseIntegerInRange(
        getEl<HTMLInputElement>("cfg-answer-secs").value,
        12,
        MAX_STAGE_SECONDS,
    );
    if (answerSeconds === null) {
        $homeError.textContent = `Answer time must be a whole number from 12 to ${MAX_STAGE_SECONDS} seconds.`;
        return;
    }
    const reviewSeconds = parseIntegerInRange(
        getEl<HTMLInputElement>("cfg-review-secs").value,
        12,
        MAX_STAGE_SECONDS,
    );
    if (reviewSeconds === null) {
        $homeError.textContent = `Review time must be a whole number from 12 to ${MAX_STAGE_SECONDS} seconds.`;
        return;
    }
    const maxPlayers = parseIntegerInRange(
        getEl<HTMLInputElement>("cfg-max-players").value,
        1,
        MAX_PLAYERS,
    );
    if (maxPlayers === null) {
        $homeError.textContent = `Max players must be a whole number from 1 to ${MAX_PLAYERS}.`;
        return;
    }
    const answerBlocks = secondsToBlocks(answerSeconds);
    const reviewBlocks = secondsToBlocks(reviewSeconds);
    busy = true;
    setLoading("btn-create-game", true);
    try {
        await sendTx(game, "createGame", selectedPackId, numQuestions, answerBlocks, reviewBlocks, maxPlayers);
        const id = await myLatestGameId();
        if (id === null) throw new Error("could not locate the created game");
        enterGame(id);
    } catch (e) {
        $homeError.textContent = txError(e);
    } finally {
        busy = false;
        setLoading("btn-create-game", false);
    }
});

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
        } else if (msg.includes("GameAlreadyStarted") && await amPlayerInGame(id)) {
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

// ── Pack builder ─────────────────────────────────────────────────────

const $builderError = getEl("builder-error");
const $builderProgress = getEl("builder-progress");
const $btnSeal = getEl<HTMLButtonElement>("btn-seal-pack");

getEl("btn-new-pack").addEventListener("click", () => {
    builderPackId = null;
    builderRegular = 0;
    builderFinals.fill(false);
    getEl<HTMLInputElement>("pack-title").value = "";
    getEl<HTMLInputElement>("q-text").value = "";
    getEl<HTMLInputElement>("q-answers").value = "";
    getEl<HTMLSelectElement>("q-kind").value = "regular";
    getEl("builder-title").textContent = "New pack";
    getEl("builder-create-row").style.display = "";
    getEl("builder-question-form").style.display = "none";
    renderList(getEl("builder-questions"), []);
    $builderError.textContent = "";
    showScreen("builder");
});

getEl("btn-create-pack").addEventListener("click", async () => {
    if (busy || !productAccount) return;
    $builderError.textContent = "";
    const title = getEl<HTMLInputElement>("pack-title").value.trim();
    if (!title) {
        $builderError.textContent = "Give the pack a title.";
        return;
    }
    if (utf8ByteLength(title) > MAX_TITLE_BYTES) {
        $builderError.textContent = `Pack titles can be at most ${MAX_TITLE_BYTES} bytes.`;
        return;
    }
    busy = true;
    setLoading("btn-create-pack", true);
    try {
        await sendTx(registry, "createPack", title);
        const id = await myLatestPackId();
        if (id === null) throw new Error("could not locate the created pack");
        builderPackId = id;
        getEl("builder-title").textContent = `${title} (pack #${builderPackId})`;
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
    const enteredAnswers = getEl<HTMLInputElement>("q-answers").value
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
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
        getEl<HTMLInputElement>("q-answers").value = "";
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
});

// ── Game loop ────────────────────────────────────────────────────────

function enterGame(id: bigint): void {
    gameSession += 1;
    gameId = id;
    latest = null;
    actionKey = "";
    actionsSent.clear();
    wagerOutcomes = new Map();
    wagerHistoryLoadedUpTo = -1;
    selectedWager = null;
    activeAnswerKey = "";
    optimisticAnswer = null;
    lastRank = -1;
    behindStreak = 0;
    getEl<HTMLInputElement>("answer-input").value = "";
    getEl<HTMLInputElement>("wager-final").value = "0";
    if (pollTimer) clearInterval(pollTimer);
    void poll();
    pollTimer = setInterval(() => void poll(), POLL_MS);
}

function leaveGame(): void {
    gameSession += 1;
    gameId = null;
    latest = null;
    selectedWager = null;
    activeAnswerKey = "";
    optimisticAnswer = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    void refreshPacks();
    showScreen("home");
}

function isCurrentGame(id: bigint, session: number): boolean {
    return gameId === id && gameSession === session;
}

getEl("btn-back-home").addEventListener("click", leaveGame);

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
    if (!isCurrentGame(id, session)) return;
    const uptoCursor =
        snap.phase.stage === STAGE_ANSWER ? snap.phase.cursor : snap.phase.cursor + 1;
    for (let k = wagerHistoryLoadedUpTo + 1; k < Math.min(uptoCursor, snap.game.num_questions); k++) {
        const res = await game.getSubmissions.query(id, k);
        if (!isCurrentGame(id, session)) return;
        if (!res.success) return;
        const mine = (res.value as SubmissionView[]).find(
            (s) => s.player.toLowerCase() === myAddress,
        );
        if (mine?.submitted) wagerOutcomes.set(mine.wager, mine.correct);
        wagerHistoryLoadedUpTo = k;
    }
    // live update for the question currently on the table (regular only)
    if (isCurrentGame(id, session) && (snap.phase.stage === STAGE_ANSWER || snap.phase.stage === STAGE_REVIEW)) {
        const mine = snap.submissions.find((s) => s.player.toLowerCase() === myAddress);
        if (mine?.submitted) wagerOutcomes.set(mine.wager, mine.correct);
    }
}

async function poll(): Promise<void> {
    if (gameId === null || !game || pollInFlight) return;
    const polledGameId = gameId;
    const polledSession = gameSession;
    pollInFlight = true;
    try {
        const phaseRes = await game.getPhase.query(polledGameId);
        if (!isCurrentGame(polledGameId, polledSession)) return;
        if (!phaseRes.success) return;
        const phase = phaseRes.value as PhaseView;
        const qkey = questionKeyFor(phase);
        const [gameRes, playersRes, scoresRes, subsRes] = await Promise.all([
            game.getGame.query(polledGameId),
            game.getPlayers.query(polledGameId),
            game.getScores.query(polledGameId),
            game.getSubmissions.query(polledGameId, qkey),
        ]);
        if (!isCurrentGame(polledGameId, polledSession)) return;
        if (!gameRes.success || !playersRes.success || !scoresRes.success || !subsRes.success) return;

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

        const gameView = gameRes.value as GameView;

        let qText = "";
        let aText = "";
        if (phase.slot !== NO_SLOT) {
            qText = await questionText(gameView.pack_id, phase.slot);
            if (!isCurrentGame(polledGameId, polledSession)) return;
            if (phase.stage === STAGE_REVIEW || phase.stage === STAGE_FINAL_REVIEW) {
                aText = await canonicalAnswer(gameView.pack_id, phase.slot);
                if (!isCurrentGame(polledGameId, polledSession)) return;
            }
        }

        const snap: Snapshot = {
            phase,
            game: gameView,
            players: (playersRes.value as string[]).map((p) => p.toLowerCase()),
            scores: (scoresRes.value as (number | bigint)[]).map(Number),
            submissions: subsRes.value as SubmissionView[],
            questionText: qText,
            answerText: aText,
        };
        await syncWagerHistory(snap, polledGameId, polledSession);
        if (!isCurrentGame(polledGameId, polledSession)) return;
        latest = snap;
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
    } catch (e) {
        console.warn("poll failed", e);
    } finally {
        pollInFlight = false;
        // A new session may have started while this request was in flight.
        // Start its first poll immediately instead of waiting for its interval.
        if (gameId !== null && gameSession !== polledSession) void poll();
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
    }
}

// ── Lobby ────────────────────────────────────────────────────────────

async function renderLobby(snap: Snapshot): Promise<void> {
    const lobbyGameId = gameId;
    const lobbySession = gameSession;
    if (lobbyGameId === null) return;
    let title: string;
    try {
        title = await packTitle(snap.game.pack_id);
    } catch {
        title = `pack #${snap.game.pack_id}`;
    }
    // A title fetch can finish after the game advances or the player leaves.
    // Do not let that old asynchronous render take the UI back to the lobby.
    if (!isCurrentGame(lobbyGameId, lobbySession) || latest !== snap || snap.phase.stage !== STAGE_LOBBY) {
        return;
    }
    getEl("lobby-game-id").textContent = String(lobbyGameId);
    getEl("lobby-title").textContent = title;
    renderList(
        getEl("lobby-players"),
        snap.players.map((p, i) =>
            li(
                span("", fmtAddr(p)),
                span("sub", i === 0 ? "host" : ""),
            ),
        ),
    );
    const isCreator = snap.game.creator.toLowerCase() === myAddress;
    getEl("btn-start-game").style.display = isCreator ? "" : "none";
    getEl("lobby-waiting").style.display = isCreator ? "none" : "";
    showScreen("lobby");
}

getEl("btn-start-game").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount) return;
    busy = true;
    setLoading("btn-start-game", true);
    try {
        await sendTx(game, "startGame", gameId);
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
    const blocksLeft = Number(snap.phase.deadline - snap.phase.current_block);
    if (blocksLeft <= 0) return "time's up";
    return `~${blocksLeft * SECONDS_PER_BLOCK}s`;
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
        btn.classList.toggle("used-correct", outcome === true);
        btn.classList.toggle("used-wrong", outcome === false);
        btn.classList.toggle("selected", selectedWager === value && outcome === undefined);
        btn.disabled = outcome !== undefined;
    }
}

function renderQuestion(snap: Snapshot): void {
    const isFinal = snap.phase.stage === STAGE_FINAL_ANSWER;
    getEl("question-number").textContent = isFinal
        ? `Final question · ${DIFFICULTY_NAMES[snap.phase.final_difficulty] ?? ""}`
        : `${snap.phase.cursor + 1} of ${snap.game.num_questions}`;
    getEl("question-text").textContent = snap.questionText;
    getEl("question-countdown").textContent = countdownText(snap);

    const mine = mySubmission(snap);
    const optimistic =
        optimisticAnswer !== null && optimisticAnswer.qkey === questionKeyFor(snap.phase);
    const answered = (mine?.submitted ?? false) || optimistic;
    getEl("answer-form").style.display = answered ? "none" : "";
    getEl("submitted-card").style.display = answered ? "" : "none";

    if (!answered) {
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
                const text = s.submitted
                    ? `“${s.answer}” · wagered ${s.wager}`
                    : pendingMine
                      ? `“${optimisticAnswer?.answer}” · wagered ${optimisticAnswer?.wager} · confirming…`
                      : "…";
                return li(span("", fmtAddr(s.player)), span("right sub", text));
            }),
        );
    }
    showScreen("question");
}

getEl("btn-submit-answer").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount || !latest) return;
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

    const threshold = Math.floor((snap.players.length - 1) / 2) + 1;
    renderList(
        getEl("review-rows"),
        snap.submissions.map((s) => {
            const isMe = s.player.toLowerCase() === myAddress;
            const row = li(span("", fmtAddr(s.player)));
            row.className = "answer-row";
            if (!s.submitted) {
                row.append(
                    span("player-answer wrong grow", "NO ANSWER GIVEN"),
                    span("wager-badge wrong", "0"),
                );
                return row;
            }
            row.append(
                span(`player-answer ${s.correct ? "correct" : "wrong"} grow`, s.answer || "—"),
            );
            if (!s.correct && !isMe) {
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

    const mine = mySubmission(snap);
    const continued = (mine?.continue_ready ?? false) || actionsSent.has("continue");
    const $btn = getEl<HTMLButtonElement>("btn-continue");
    $btn.disabled = continued;
    $btn.textContent = continued ? "Waiting for others…" : "Continue";
    getEl("continue-status").textContent =
        `${snap.phase.continue_count}/${snap.phase.player_count} ready`;

    renderLeaderboard(getEl("review-leaderboard"), snap);
    showScreen("review");
}

async function voteCorrect(target: string): Promise<void> {
    if (busy || gameId === null || !productAccount) return;
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
        actionsSent.delete(key);
        getEl("review-error").textContent = txError(e);
        if (latest) render(latest);
    } finally {
        busy = false;
    }
}

getEl("btn-continue").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount || actionsSent.has("continue")) return;
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
    getEl("vote-countdown").textContent = countdownText(snap);
    getEl("vote-status").textContent =
        `${snap.phase.submit_count}/${snap.phase.player_count} voted` +
        (actionsSent.has("difficulty") ? " — your vote is in" : "");
    for (const btn of document.querySelectorAll<HTMLButtonElement>(".btn-difficulty")) {
        btn.disabled = actionsSent.has("difficulty");
    }
    showScreen("vote");
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".btn-difficulty")) {
    btn.addEventListener("click", async () => {
        if (busy || gameId === null || !productAccount || actionsSent.has("difficulty")) return;
        // optimistic: lock the vote in visually, roll back on error
        actionsSent.add("difficulty");
        if (latest) render(latest);
        busy = true;
        try {
            await sendTx(game, "voteDifficulty", gameId, Number(btn.dataset.difficulty));
            void poll();
        } catch (e) {
            actionsSent.delete("difficulty");
            getEl("vote-error").textContent = txError(e);
            if (latest) render(latest);
        } finally {
            busy = false;
        }
    });
}

// ── Results ──────────────────────────────────────────────────────────

function renderLeaderboard(list: HTMLElement, snap: Snapshot): void {
    const ranked = snap.players
        .map((p, i) => ({ player: p, score: snap.scores[i] }))
        .sort((a, b) => b.score - a.score);
    renderList(
        list,
        ranked.map((r, i) =>
            li(
                span("sub", `#${i + 1}`),
                span("", fmtAddr(r.player)),
                span("right pts", `${r.score}`),
            ),
        ),
    );
}

function renderResults(snap: Snapshot): void {
    const top = Math.max(...snap.scores);
    const winners = snap.players.filter((_, i) => snap.scores[i] === top);
    getEl("results-winner").textContent = winners.map(fmtAddr).join(" & ");
    renderLeaderboard(getEl("results-leaderboard"), snap);
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    showScreen("results");
}

// ── Go ───────────────────────────────────────────────────────────────

init().catch((e) => {
    $connPill.textContent = "error";
    $connPill.className = "err";
    bootLog(`Unhandled init error: ${txError(e)}`, "err");
});
