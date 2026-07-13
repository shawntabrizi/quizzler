/**
 * Quizzler — social trivia on Polkadot.
 *
 * Boot sequence follows the product-sdk contracts-demo: SignerManager →
 * product account → chain client → ad-hoc contract handle → account mapping.
 * Game state lives entirely in the contract; the app polls `getPhase` (and
 * friends) every few seconds and renders whichever screen the chain says
 * we're in. Answers and correctness are public on-chain — this client just
 * chooses not to show them before the review phase, like a deck of cards
 * lying face-down on the table.
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

import abi from "./abi.json";
import contractInfo from "./contract-address.json";
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
const SECONDS_PER_BLOCK = 2; // measured on Paseo Asset Hub Next (2026-07)
const POLL_MS = 3_000;
const DIFFICULTY_NAMES = ["Easy", "Medium", "Hard"];

// ── Chain-facing types (viem decodes named tuples to objects) ───────

interface PhaseView {
    stage: number;
    cursor: number;
    deadline: bigint;
    current_block: bigint;
    final_difficulty: number;
    question: string;
    /** Canonical answer, revealed by the contract only during review stages. */
    answer?: string;
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
}

// ── App state ────────────────────────────────────────────────────────

const manager = new SignerManager({ ss58Prefix: 0, dappName: "quizzler" });

let productAccount: SignerAccount | null = null;
let contract: any = null;
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
async function sendTx(method: string, ...args: unknown[]): Promise<void> {
    if (!productAccount) throw new Error("Account not ready");
    for (let attempt = 0; ; attempt++) {
        try {
            const result = await contract[method].tx(...args, {
                signer: productAccount.getSigner(),
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

// ── Boot ─────────────────────────────────────────────────────────────

async function init(): Promise<void> {
    showScreen("boot");
    if (!contractInfo.address) {
        $connPill.textContent = "no contract";
        $connPill.className = "err";
        bootLog("No contract address configured.", "err");
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

    contract = createContractFromClient(
        client.raw.assetHub,
        paseo_asset_hub,
        contractInfo.address as `0x${string}`,
        abi as never,
        { signerManager: manager },
    );
    bootLog("Contract handle ready", "ok");

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
    const countRes = await contract.packCount.query();
    if (!countRes.success) return;
    const count = Number(countRes.value);
    const from = Math.max(0, count - 10);
    const rows: HTMLLIElement[] = [];
    for (let id = count - 1; id >= from; id--) {
        const res = await contract.getPack.query(id);
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
            qInput.max = String(pack.regular_count);
            if (Number(qInput.value) > pack.regular_count) qInput.value = String(pack.regular_count);
            for (const el of $packList.children) el.classList.remove("selected");
            row.classList.add("selected");
        });
        rows.push(row);
    }
    if (rows.length === 0) {
        const empty = li(span("sub", "No sealed packs yet — create one!"));
        rows.push(empty);
    }
    renderList($packList, rows);
}

function secondsToBlocks(seconds: number): number {
    return Math.max(2, Math.round(seconds / SECONDS_PER_BLOCK));
}

/**
 * Ids are sequential, but reading the counter before submitting races with
 * other users creating packs/games concurrently. Instead, after our tx
 * lands, walk back from the top for the newest entry we created.
 */
async function findMyLatest(
    countMethod: "packCount" | "gameCount",
    getMethod: "getPack" | "getGame",
    accept: (v: { creator: string }) => boolean,
): Promise<bigint | null> {
    const countRes = await contract[countMethod].query();
    if (!countRes.success) return null;
    const count = BigInt(countRes.value);
    const floor = count > 30n ? count - 30n : 0n;
    for (let id = count - 1n; id >= floor; id--) {
        const res = await contract[getMethod].query(id); // viem accepts bigint for any uint width
        if (res.success) {
            const v = res.value as { creator: string };
            if (v.creator.toLowerCase() === myAddress && accept(v)) return id;
        }
        if (id === 0n) break;
    }
    return null;
}

// Keep the browse list fresh while the player sits on the home screen —
// packs published by others should show up without a reload.
setInterval(() => {
    if (contract && getEl("screen-home").classList.contains("active") && !busy) {
        void refreshPacks();
    }
}, 5_000);

getEl("btn-create-game").addEventListener("click", async () => {
    if (busy || selectedPackId === null || selectedPack === null || !productAccount) return;
    $homeError.textContent = "";
    const numQuestions = Math.min(
        Number(getEl<HTMLInputElement>("cfg-questions").value) || 5,
        selectedPack.regular_count,
    );
    const answerBlocks = secondsToBlocks(Number(getEl<HTMLInputElement>("cfg-answer-secs").value) || 60);
    const reviewBlocks = secondsToBlocks(Number(getEl<HTMLInputElement>("cfg-review-secs").value) || 45);
    const maxPlayers = Number(getEl<HTMLInputElement>("cfg-max-players").value) || 8;
    busy = true;
    try {
        await sendTx("createGame", selectedPackId, numQuestions, answerBlocks, reviewBlocks, maxPlayers);
        const id = await findMyLatest("gameCount", "getGame", () => true);
        if (id === null) throw new Error("could not locate the created game");
        enterGame(id);
    } catch (e) {
        $homeError.textContent = txError(e);
    } finally {
        busy = false;
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
    const id = BigInt(raw);
    busy = true;
    try {
        await sendTx("joinGame", id);
        enterGame(id);
    } catch (e) {
        const msg = txError(e);
        // Rejoining a game you're already in is fine — just re-enter it.
        if (msg.includes("AlreadyJoined") || msg.includes("GameAlreadyStarted")) {
            enterGame(id);
        } else {
            $homeError.textContent = msg;
        }
    } finally {
        busy = false;
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
    busy = true;
    try {
        await sendTx("createPack", title);
        const id = await findMyLatest(
            "packCount", "getPack",
            (v) => !(v as unknown as PackView).sealed,
        );
        if (id === null) throw new Error("could not locate the created pack");
        builderPackId = Number(id);
        getEl("builder-title").textContent = `${title} (pack #${builderPackId})`;
        getEl("builder-create-row").style.display = "none";
        getEl("builder-question-form").style.display = "";
        updateBuilderProgress();
    } catch (e) {
        $builderError.textContent = txError(e);
    } finally {
        busy = false;
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
    const answers = getEl<HTMLInputElement>("q-answers").value
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
    const kind = getEl<HTMLSelectElement>("q-kind").value;
    if (!text || answers.length === 0) {
        $builderError.textContent = "A question needs text and at least one answer.";
        return;
    }
    if (answers.length > 5) {
        $builderError.textContent = "At most 5 accepted answers.";
        return;
    }
    const isFinal = kind !== "regular";
    const difficulty = isFinal ? Number(kind) : 0;
    busy = true;
    try {
        try {
            await sendTx("addQuestion", builderPackId, text, answers, isFinal, difficulty);
        } catch (e) {
            // Pack ids are assigned at execution time from a global counter,
            // so a best-block reorg can shift them between resolution and
            // dispatch — the tx then hits someone else's pack and reverts.
            // Re-resolve our pack and retry once.
            if (!/revert/i.test(txError(e))) throw e;
            const id = await findMyLatest("packCount", "getPack", (v) => !(v as unknown as PackView).sealed);
            if (id === null) throw e;
            builderPackId = Number(id);
            await sendTx("addQuestion", builderPackId, text, answers, isFinal, difficulty);
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
    }
});

getEl("btn-seal-pack").addEventListener("click", async () => {
    if (busy || builderPackId === null || !productAccount) return;
    busy = true;
    try {
        try {
            await sendTx("sealPack", builderPackId);
        } catch (e) {
            // same reorg id-shift heal as addQuestion
            if (!/revert/i.test(txError(e))) throw e;
            const id = await findMyLatest("packCount", "getPack", (v) => !(v as unknown as PackView).sealed);
            if (id === null) throw e;
            builderPackId = Number(id);
            await sendTx("sealPack", builderPackId);
        }
        await refreshPacks();
        showScreen("home");
    } catch (e) {
        $builderError.textContent = txError(e);
    } finally {
        busy = false;
    }
});

getEl("btn-builder-done").addEventListener("click", async () => {
    await refreshPacks();
    showScreen("home");
});

// ── Game loop ────────────────────────────────────────────────────────

function enterGame(id: bigint): void {
    gameId = id;
    latest = null;
    actionsSent.clear();
    if (pollTimer) clearInterval(pollTimer);
    void poll();
    pollTimer = setInterval(() => void poll(), POLL_MS);
}

function leaveGame(): void {
    gameId = null;
    latest = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    void refreshPacks();
    showScreen("home");
}

getEl("btn-back-home").addEventListener("click", leaveGame);

function questionKeyFor(phase: PhaseView): number {
    return phase.stage === STAGE_ANSWER || phase.stage === STAGE_REVIEW
        ? phase.cursor
        : FINAL_QKEY;
}

async function poll(): Promise<void> {
    if (gameId === null || !contract) return;
    try {
        const phaseRes = await contract.getPhase.query(gameId);
        if (!phaseRes.success) return;
        const phase = phaseRes.value as PhaseView;
        const qkey = questionKeyFor(phase);
        const [gameRes, playersRes, scoresRes, subsRes] = await Promise.all([
            contract.getGame.query(gameId),
            contract.getPlayers.query(gameId),
            contract.getScores.query(gameId),
            contract.getSubmissions.query(gameId, qkey),
        ]);
        if (!gameRes.success || !playersRes.success || !scoresRes.success || !subsRes.success) return;
        latest = {
            phase,
            game: gameRes.value as GameView,
            players: (playersRes.value as string[]).map((p) => p.toLowerCase()),
            scores: (scoresRes.value as (number | bigint)[]).map(Number),
            submissions: subsRes.value as SubmissionView[],
        };
        // reset per-stage action guards when the stage changes
        const key = `${gameId}:${latest.phase.stage}:${latest.phase.cursor}`;
        if (key !== actionKey) {
            actionKey = key;
            actionsSent.clear();
        }
        render(latest);
    } catch (e) {
        console.warn("poll failed", e);
    }
}

function mySubmission(snap: Snapshot): SubmissionView | undefined {
    return snap.submissions.find((s) => s.player.toLowerCase() === myAddress);
}

function render(snap: Snapshot): void {
    switch (snap.phase.stage) {
        case STAGE_LOBBY:
            renderLobby(snap);
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

function renderLobby(snap: Snapshot): void {
    getEl("lobby-game-id").textContent = String(gameId);
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
    try {
        await sendTx("startGame", gameId);
        void poll();
    } catch (e) {
        getEl("lobby-error").textContent = txError(e);
    } finally {
        busy = false;
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

const $wagerSlider = getEl<HTMLInputElement>("wager-slider");
$wagerSlider.addEventListener("input", () => {
    getEl("wager-value").textContent = $wagerSlider.value;
});

function renderQuestion(snap: Snapshot): void {
    const isFinal = snap.phase.stage === STAGE_FINAL_ANSWER;
    getEl("question-number").textContent = isFinal
        ? `Final question · ${DIFFICULTY_NAMES[snap.phase.final_difficulty] ?? ""}`
        : `Question ${snap.phase.cursor + 1} of ${snap.game.num_questions}`;
    getEl("question-text").textContent = snap.phase.question;
    getEl("question-countdown").textContent = countdownText(snap);

    const mine = mySubmission(snap);
    const answered = mine?.submitted ?? false;
    getEl("answer-form").style.display = answered ? "none" : "";
    getEl("submitted-card").style.display = answered ? "" : "none";

    if (!answered) {
        getEl("wager-slider-row").style.display = isFinal ? "none" : "";
        getEl("wager-final-row").style.display = isFinal ? "" : "none";
        if (isFinal) {
            const myIdx = snap.players.indexOf(myAddress);
            const myScore = myIdx >= 0 ? snap.scores[myIdx] : 0;
            getEl("wager-final-max").textContent = String(myScore);
            getEl<HTMLInputElement>("wager-final").max = String(myScore);
        }
    } else {
        // Others' answers, face-down until review: show submitted text for
        // everyone who locked in, "…" for players still thinking.
        renderList(
            getEl("live-answers"),
            snap.submissions.map((s) =>
                li(
                    span("", fmtAddr(s.player)),
                    span(
                        "right sub",
                        s.submitted ? `“${s.answer}” · wagered ${s.wager}` : "…",
                    ),
                ),
            ),
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
    const wager = isFinal
        ? Number(getEl<HTMLInputElement>("wager-final").value) || 0
        : Number($wagerSlider.value);
    if (actionsSent.has("submit")) return;
    busy = true;
    try {
        await sendTx("submitAnswer", gameId, answer, wager);
        actionsSent.add("submit");
        getEl<HTMLInputElement>("answer-input").value = "";
        void poll();
    } catch (e) {
        $err.textContent = txError(e);
    } finally {
        busy = false;
    }
});

// ── Review screen ────────────────────────────────────────────────────

let reviewAnswerShown = ""; // cache the canonical answer per stage

function renderReview(snap: Snapshot): void {
    const isFinal = snap.phase.stage === STAGE_FINAL_REVIEW;
    getEl("review-number").textContent = isFinal
        ? "Final question — results"
        : `Question ${snap.phase.cursor + 1} — results`;
    getEl("review-question").textContent = snap.phase.question;
    getEl("review-countdown").textContent = countdownText(snap);

    // The canonical answer comes from the contract (revealed only during
    // review) — never inferred from players' submissions.
    reviewAnswerShown = snap.phase.answer || "—";
    getEl("review-answer").textContent = reviewAnswerShown;

    const threshold = Math.floor((snap.players.length - 1) / 2) + 1;
    renderList(
        getEl("review-rows"),
        snap.submissions.map((s) => {
            const isMe = s.player.toLowerCase() === myAddress;
            const row = li(span("", fmtAddr(s.player)));
            row.className = "answer-row";
            if (!s.submitted) {
                row.append(span("sub", "no answer"), span("mark wrong right", "✗"));
                return row;
            }
            const delta = s.correct ? `+${s.wager}` : isFinal ? `−${s.wager}` : "0";
            row.append(
                span("sub", `“${s.answer}” · wagered ${s.wager}`),
                span(`right pts mark ${s.correct ? "correct" : "wrong"}`, `${s.correct ? "✓" : "✗"} ${delta}`),
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
            return row;
        }),
    );

    const mine = mySubmission(snap);
    const continued = mine?.continue_ready ?? actionsSent.has("continue");
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
    busy = true;
    try {
        await sendTx("voteCorrect", gameId, target);
        actionsSent.add(key);
        void poll();
    } catch (e) {
        getEl("review-error").textContent = txError(e);
    } finally {
        busy = false;
    }
}

getEl("btn-continue").addEventListener("click", async () => {
    if (busy || gameId === null || !productAccount || actionsSent.has("continue")) return;
    busy = true;
    try {
        await sendTx("readyContinue", gameId);
        actionsSent.add("continue");
        void poll();
    } catch (e) {
        getEl("review-error").textContent = txError(e);
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
        busy = true;
        try {
            await sendTx("voteDifficulty", gameId, Number(btn.dataset.difficulty));
            actionsSent.add("difficulty");
            void poll();
        } catch (e) {
            getEl("vote-error").textContent = txError(e);
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
