//! Quizzler — Sporcle Party-style social trivia, entirely on-chain.
//!
//! Quiz content lives in the separate registry contract (set at
//! construction) so this game contract can be redeployed freely without
//! re-uploading packs. Pack validation and answer matching read the
//! registry cross-contract; clients read question text and the canonical
//! answer from the registry directly.
//!
//! Casual trust model: answers are submitted in plaintext and scored at
//! submission time. The client decides what to *display* per phase; the
//! chain only enforces timing, scoring, and votes.
//!
//! Phase pacing is a pure function of block number (see `quizzler-logic`):
//! every mutating call first settles timeout transitions, then applies the
//! action, and the last-of-N submission collapses the phase early.

#![no_main]
#![no_std]

// `extern crate alloc` and `use alloc::vec::Vec` are emitted at file scope
// by the #[pvm::contract] macro expansion — declaring them here collides.
use alloc::string::String;

use logic::{DIFFICULTY_UNSET, GameClock, PhaseConfig};
use logic::{
    STAGE_ABANDONED, STAGE_ANSWER, STAGE_FINAL_ANSWER, STAGE_FINAL_REVIEW, STAGE_LOBBY,
    STAGE_REVIEW, STAGE_VOTE,
};
use pvm::{Decode, Encode, HostFn};
use pvm_contract as pvm;
use quizzler_logic as logic;

const MAX_ANSWER_BYTES: usize = 64;
/// Upper roster ceiling for this version of the game contract. The
/// player-facing app always uses this deployment's documented ceiling.
const MAX_PLAYERS: u8 = 24;
const MAX_STAGE_BLOCKS: u32 = 600;
const MAX_WAGER: u32 = 10;
/// Each wager value 1..=10 is usable once per game (Sporcle's system), so a
/// game holds at most 10 regular questions.
const MAX_GAME_QUESTIONS: u8 = 10;

/// Registry slot for a final question of the given difficulty (regular
/// questions occupy slots 0..regular_count).
const fn final_slot(difficulty: u8) -> u8 {
    0xf0 + difficulty
}

// ── Stored types (SCALE) ─────────────────────────────────────────────

#[derive(Encode, Decode, Clone)]
struct GameMeta {
    pack_id: u32,
    creator: [u8; 20],
    num_questions: u8,
    answer_blocks: u32,
    review_blocks: u32,
    max_players: u8,
    stage: u8,
    cursor: u8,
    anchor: u64,
    final_difficulty: u8,
}

#[derive(Encode, Decode, Clone)]
struct Submission {
    answer: String,
    wager: u32,
    correct: bool,
}

// ── ABI view types ───────────────────────────────────────────────────

#[derive(pvm::SolAbi)]
struct GameView {
    pack_id: u32,
    creator: pvm::Address,
    num_questions: u8,
    answer_blocks: u32,
    review_blocks: u32,
    max_players: u8,
    /// Historical roster size. It is fixed after the lobby starts so scores
    /// and submitted answers retain a stable order.
    player_count: u8,
    /// Players who have not permanently forfeited the running quiz.
    active_player_count: u8,
}

#[derive(pvm::SolAbi)]
struct PhaseView {
    stage: u8,
    cursor: u8,
    /// First block that is no longer part of this stage (u64::MAX if untimed).
    deadline: u64,
    current_block: u64,
    final_difficulty: u8,
    /// Registry slot of the active question (0xff when no question is live).
    /// Clients read question text — and, during review, the canonical
    /// answer — from the registry using (pack_id, slot).
    slot: u8,
    submit_count: u32,
    continue_count: u32,
    /// Historical roster size (all lobby players, or all participants after
    /// the game starts).
    player_count: u8,
    /// Current quorum size. UI progress and early-collapse rules must use
    /// this rather than the historical roster after somebody forfeits.
    active_player_count: u8,
}

#[derive(pvm::SolAbi)]
struct SubmissionView {
    player: pvm::Address,
    submitted: bool,
    answer: String,
    wager: u32,
    correct: bool,
    overturn_votes: u32,
    continue_ready: bool,
    /// False after a participant permanently forfeits. Their prior answer and
    /// score remain visible, but they no longer count toward future quorums.
    active: bool,
}

/// One bounded read model for a live game. It combines the game metadata,
/// settled phase, roster, scores, optional display names, and current-question
/// submissions that otherwise require several sequential RPC calls.
#[derive(pvm::SolAbi)]
struct LiveGameView {
    pack_id: u32,
    creator: pvm::Address,
    num_questions: u8,
    answer_blocks: u32,
    review_blocks: u32,
    max_players: u8,
    stage: u8,
    cursor: u8,
    deadline: u64,
    current_block: u64,
    final_difficulty: u8,
    slot: u8,
    submit_count: u32,
    continue_count: u32,
    player_count: u8,
    active_player_count: u8,
    players: alloc::vec::Vec<pvm::Address>,
    scores: alloc::vec::Vec<u32>,
    /// Parallel to `players`; an empty string means the client should fall
    /// back to its normal abbreviated address label.
    player_names: alloc::vec::Vec<String>,
    /// Current question (or final-question) submissions in roster order.
    submissions: alloc::vec::Vec<SubmissionView>,
}

/// Mirror of the registry's PackStatus view (cross-contract decode target).
#[derive(pvm::SolAbi)]
struct PackStatus {
    exists: bool,
    sealed: bool,
    regular_count: u8,
}

// ── Storage ──────────────────────────────────────────────────────────

#[pvm::storage]
struct Storage {
    // pack registry contract this game reads content from
    registry: [u8; 20],
    game_count: u64,
    game_meta: pvm::storage::Mapping<u64, GameMeta>,
    players: pvm::storage::Mapping<u64, Vec<[u8; 20]>>,
    scores: pvm::storage::Mapping<(u64, [u8; 20]), u32>,
    // A lobby roster is physically mutable. Once a quiz starts the roster is
    // historical, and this flag excludes a forfeiter from future quorums
    // without erasing their score or submitted answers.
    forfeited: pvm::storage::Mapping<(u64, [u8; 20]), bool>,
    // (game, question_key, player)
    submissions: pvm::storage::Mapping<(u64, u8, [u8; 20]), Submission>,
    continue_flags: pvm::storage::Mapping<(u64, u8, [u8; 20]), bool>,
    // (game, question_key, target) → votes to overturn target's wrong answer
    overturn_voted: pvm::storage::Mapping<(u64, u8, [u8; 20], [u8; 20]), bool>,
    // The individual choice lets a later forfeit remove an already-cast vote
    // from both the live quorum and the final difficulty resolution.
    difficulty_choice: pvm::storage::Mapping<(u64, [u8; 20]), u8>,
    // bitmask of wager values (bits 1..=10) already spent by a player
    used_wagers: pvm::storage::Mapping<(u64, [u8; 20]), u16>,
    // (creator, client-selected nonce) → game code. This stays stable under
    // concurrent creation from the same account.
    created_game_of: pvm::storage::Mapping<([u8; 20], u64), u64>,
    // Optional, global social label for an account. A blank mapping value is
    // intentionally represented by an absent entry so legacy UI can retain
    // address labels as a safe fallback.
    display_names: pvm::storage::Mapping<[u8; 20], String>,
}

// ── Host helpers ─────────────────────────────────────────────────────

fn fail(msg: &str) -> ! {
    pvm::api::return_value(pvm::ReturnFlags::REVERT, msg.as_bytes())
}

fn caller20() -> [u8; 20] {
    let mut a = [0u8; 20];
    pvm::api::caller(&mut a);
    a
}

fn current_block() -> u64 {
    // pallet-revive 256-bit numeric host buffers are little-endian
    let mut buf = [0u8; 32];
    pvm::api::block_number(&mut buf);
    u64::from_le_bytes(buf[0..8].try_into().unwrap())
}

/// A 6-digit join code that isn't enumerable like a sequential counter, so
/// strangers don't stumble into (or grief) games by guessing ids. Derived
/// from keccak(creator ‖ seq ‖ attempt), bumping `attempt` on collision.
fn gen_game_code(creator: &[u8; 20], seq: u64) -> u64 {
    for attempt in 0..=u8::MAX {
        let mut input = [0u8; 29];
        input[..20].copy_from_slice(creator);
        input[20..28].copy_from_slice(&seq.to_le_bytes());
        input[28] = attempt;
        let mut h = [0u8; 32];
        pvm::api::hash_keccak_256(&input, &mut h);
        let code = 100_000 + (u64::from_le_bytes(h[..8].try_into().unwrap()) % 900_000);
        if !Storage::game_meta().contains(&code) {
            return code;
        }
    }
    // The six-digit code space has been exhausted for this deterministic
    // sequence. Never spin forever if a pathological collision set occurs.
    fail("GameCodeSpaceExhausted")
}

fn indexed_address(address: [u8; 20]) -> [u8; 32] {
    let mut topic = [0u8; 32];
    topic[12..].copy_from_slice(&address);
    topic
}

fn indexed_u64(value: u64) -> [u8; 32] {
    let mut topic = [0u8; 32];
    topic[24..].copy_from_slice(&value.to_be_bytes());
    topic
}

/// Emit the code with the creator in indexed topics for party clients and
/// indexers that want to observe game creation.
/// The currently locked contract SDK exposes raw logs but does not include
/// event declarations in generated ABI JSON, so this intentionally follows
/// the standard `GameCreated(address,uint64)` EVM wire format directly.
fn emit_game_created(creator: [u8; 20], game_id: u64) {
    let mut signature = [0u8; 32];
    pvm::api::hash_keccak_256(b"GameCreated(address,uint64)", &mut signature);
    let topics = [signature, indexed_address(creator), indexed_u64(game_id)];
    pvm::api::deposit_event(&topics, &[]);
}

// ── Registry cross-contract calls ────────────────────────────────────

fn abi_word_u32(v: u32) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[28..].copy_from_slice(&v.to_be_bytes());
    w
}

fn abi_word_u8(v: u8) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[31] = v;
    w
}

/// Call a registry view and ABI-decode its return. Mirrors the calling
/// convention of the macro-generated cross-contract `Reference` methods.
fn registry_call<T: pvm::SolAbi>(
    name: &str,
    types: &[&str],
    words: &[[u8; 32]],
    out_cap: usize,
) -> T {
    extern crate alloc;
    let registry = Storage::registry().get().unwrap_or([0u8; 20]);
    let selector = pvm::compute_selector(name, types);
    let mut calldata = alloc::vec::Vec::with_capacity(4 + words.len() * 32);
    calldata.extend_from_slice(&selector);
    for w in words {
        calldata.extend_from_slice(w);
    }
    let mut output_buf = alloc::vec![0u8; out_cap];
    let mut output_ref: &mut [u8] = &mut output_buf[..];
    let result = pvm::api::call_evm(
        // Registry methods are pure reads. Keep the runtime's reentrancy
        // guard in place and prevent a configured registry from changing
        // state while the game is mid-transition.
        pvm::CallFlags::READ_ONLY,
        &registry,
        u64::MAX,
        &[0u8; 32],
        &calldata,
        Some(&mut output_ref),
    );
    match result {
        Ok(()) => {
            let written = output_ref.len();
            T::abi_decode(&output_buf[..written], 0)
        }
        Err(_) => fail("RegistryCallFailed"),
    }
}

fn registry_pack_status(pack_id: u32) -> PackStatus {
    registry_call("getPackStatus", &["uint32"], &[abi_word_u32(pack_id)], 128)
}

fn registry_answers(pack_id: u32, slot: u8) -> Vec<String> {
    registry_call(
        "getAnswers",
        &["uint32", "uint8"],
        &[abi_word_u32(pack_id), abi_word_u8(slot)],
        1024,
    )
}

// ── Game helpers ─────────────────────────────────────────────────────

fn clock_of(m: &GameMeta) -> GameClock {
    GameClock {
        stage: m.stage,
        cursor: m.cursor,
        anchor: m.anchor,
    }
}

fn cfg_of(m: &GameMeta) -> PhaseConfig {
    PhaseConfig {
        num_questions: m.num_questions,
        answer_blocks: m.answer_blocks as u64,
        review_blocks: m.review_blocks as u64,
    }
}

fn load_game(game_id: u64) -> GameMeta {
    match Storage::game_meta().get(&game_id) {
        Some(m) => m,
        None => fail("NoSuchGame"),
    }
}

fn load_players(game_id: u64) -> Vec<[u8; 20]> {
    Storage::players().get(&game_id).unwrap_or_default()
}

fn is_active_in_players(game_id: u64, who: &[u8; 20], players: &[[u8; 20]]) -> bool {
    players.iter().any(|player| player == who)
        && !Storage::forfeited().get(&(game_id, *who)).unwrap_or(false)
}

fn active_player_count_in(game_id: u64, players: &[[u8; 20]]) -> u32 {
    players
        .iter()
        .filter(|player| {
            !Storage::forfeited()
                .get(&(game_id, **player))
                .unwrap_or(false)
        })
        .count() as u32
}

fn active_submission_count_in(game_id: u64, question_key: u8, players: &[[u8; 20]]) -> u32 {
    players
        .iter()
        .filter(|player| {
            !Storage::forfeited()
                .get(&(game_id, **player))
                .unwrap_or(false)
        })
        .filter(|player| Storage::submissions().contains(&(game_id, question_key, **player)))
        .count() as u32
}

fn active_continue_count_in(game_id: u64, question_key: u8, players: &[[u8; 20]]) -> u32 {
    players
        .iter()
        .filter(|player| {
            !Storage::forfeited()
                .get(&(game_id, **player))
                .unwrap_or(false)
        })
        .filter(|player| Storage::continue_flags().contains(&(game_id, question_key, **player)))
        .count() as u32
}

fn active_difficulty_counts_in(game_id: u64, players: &[[u8; 20]]) -> [u32; 3] {
    let mut counts = [0; 3];
    for player in players.iter().filter(|player| {
        !Storage::forfeited()
            .get(&(game_id, **player))
            .unwrap_or(false)
    }) {
        if let Some(difficulty) = Storage::difficulty_choice().get(&(game_id, *player)) {
            if difficulty < 3 {
                counts[difficulty as usize] += 1;
            }
        }
    }
    counts
}

fn active_difficulty_total_in(game_id: u64, players: &[[u8; 20]]) -> u32 {
    active_difficulty_counts_in(game_id, players).iter().sum()
}

fn active_overturn_votes_in(
    game_id: u64,
    question_key: u8,
    target: &[u8; 20],
    players: &[[u8; 20]],
) -> u32 {
    players
        .iter()
        .filter(|player| {
            !Storage::forfeited()
                .get(&(game_id, **player))
                .unwrap_or(false)
        })
        .filter(|player| {
            Storage::overturn_voted().contains(&(game_id, question_key, *target, **player))
        })
        .count() as u32
}

fn is_roster_player(game_id: u64, who: &[u8; 20]) -> bool {
    load_players(game_id).iter().any(|p| p == who)
}

/// A lobby roster contains only current members. Once play begins, the roster
/// becomes historical and a forfeited flag controls future participation.
fn is_active_player(game_id: u64, who: &[u8; 20]) -> bool {
    is_active_in_players(game_id, who, &load_players(game_id))
}

fn active_player_count(game_id: u64) -> u32 {
    let players = load_players(game_id);
    active_player_count_in(game_id, &players)
}

fn require_active_player(game_id: u64, who: &[u8; 20]) -> u32 {
    let players = load_players(game_id);
    if !players.iter().any(|p| p == who) {
        fail("NotAPlayer");
    }
    if Storage::forfeited().get(&(game_id, *who)).unwrap_or(false) {
        fail("PlayerForfeited");
    }
    active_player_count_in(game_id, &players)
}

fn active_submission_count(game_id: u64, question_key: u8) -> u32 {
    let players = load_players(game_id);
    active_submission_count_in(game_id, question_key, &players)
}

fn active_continue_count(game_id: u64, question_key: u8) -> u32 {
    let players = load_players(game_id);
    active_continue_count_in(game_id, question_key, &players)
}

fn active_difficulty_counts(game_id: u64) -> [u32; 3] {
    let players = load_players(game_id);
    active_difficulty_counts_in(game_id, &players)
}

fn active_difficulty_total(game_id: u64) -> u32 {
    let players = load_players(game_id);
    active_difficulty_total_in(game_id, &players)
}

fn active_overturn_votes(game_id: u64, question_key: u8, target: &[u8; 20]) -> u32 {
    let players = load_players(game_id);
    active_overturn_votes_in(game_id, question_key, target, &players)
}

fn active_overturn_voters(game_id: u64, target: &[u8; 20]) -> u32 {
    let players = load_players(game_id);
    let active = active_player_count_in(game_id, &players);
    if is_active_in_players(game_id, target, &players) {
        active.saturating_sub(1)
    } else {
        active
    }
}

/// Apply an overturn once its currently active jury reaches quorum. The
/// `Submission::correct` guard makes this idempotent: it is safe to call when
/// a new vote arrives and again when a later forfeit changes the quorum.
/// Returns whether this call changed the answer and score.
fn apply_overturn_if_quorum(
    game_id: u64,
    question_key: u8,
    target: &[u8; 20],
    is_final_review: bool,
) -> bool {
    let mut sub = match Storage::submissions().get(&(game_id, question_key, *target)) {
        Some(submission) => submission,
        None => return false,
    };
    if sub.correct {
        return false;
    }

    let votes = active_overturn_votes(game_id, question_key, target);
    let eligible_voters = active_overturn_voters(game_id, target);
    if !logic::overturn_passes(votes, eligible_voters) {
        return false;
    }

    sub.correct = true;
    Storage::submissions().insert(&(game_id, question_key, *target), &sub);
    let score = Storage::scores().get(&(game_id, *target)).unwrap_or(0);
    // Regular: grant the wager. Final: refund the original loss and grant it.
    let delta = if is_final_review {
        sub.wager.saturating_mul(2)
    } else {
        sub.wager
    };
    Storage::scores().insert(&(game_id, *target), &score.saturating_add(delta));
    true
}

/// A forfeit changes every pending jury's electorate, not just the forfeiter's
/// own answer. Re-check all submissions for the live review question so prior
/// votes that now meet quorum take effect without waiting for another vote.
fn reconcile_overturns_after_forfeit(game_id: u64, m: &GameMeta) {
    let is_final_review = match m.stage {
        STAGE_REVIEW => false,
        STAGE_FINAL_REVIEW => true,
        _ => return,
    };
    let question_key = logic::question_key(&clock_of(m));
    for player in load_players(game_id) {
        apply_overturn_if_quorum(game_id, question_key, &player, is_final_review);
    }
}

/// Apply timeout transitions at a known block; resolves the final difficulty
/// if the roll crossed the end of the Vote stage. View methods pass one block
/// through their whole snapshot so deadline/current-block data cannot be
/// internally inconsistent.
fn settle_at(game_id: u64, m: &mut GameMeta, now: u64) {
    let (clock, crossed_vote) = logic::roll(clock_of(m), &cfg_of(m), now);
    if crossed_vote && m.final_difficulty == DIFFICULTY_UNSET {
        m.final_difficulty = logic::resolve_difficulty(active_difficulty_counts(game_id));
    }
    m.stage = clock.stage;
    m.cursor = clock.cursor;
    m.anchor = clock.anchor;
}

/// Apply timeout transitions to the stored clock at the current block.
fn settle(game_id: u64, m: &mut GameMeta) {
    settle_at(game_id, m, current_block());
}

fn game_view_from(game_id: u64, m: &GameMeta, players: &[[u8; 20]]) -> GameView {
    GameView {
        pack_id: m.pack_id,
        creator: pvm::Address::from(m.creator),
        num_questions: m.num_questions,
        answer_blocks: m.answer_blocks,
        review_blocks: m.review_blocks,
        max_players: m.max_players,
        player_count: players.len() as u8,
        active_player_count: active_player_count_in(game_id, players) as u8,
    }
}

fn phase_view_from(game_id: u64, m: &GameMeta, now: u64, players: &[[u8; 20]]) -> PhaseView {
    let clock = clock_of(m);
    let question_key = logic::question_key(&clock);
    let slot = match m.stage {
        STAGE_ANSWER | STAGE_REVIEW | STAGE_FINAL_ANSWER | STAGE_FINAL_REVIEW => active_slot(m),
        _ => 0xff,
    };
    let submit_count = if m.stage == STAGE_VOTE {
        active_difficulty_total_in(game_id, players)
    } else {
        active_submission_count_in(game_id, question_key, players)
    };
    PhaseView {
        stage: m.stage,
        cursor: m.cursor,
        deadline: logic::stage_deadline(&clock, &cfg_of(m)),
        current_block: now,
        final_difficulty: m.final_difficulty,
        slot,
        submit_count,
        continue_count: active_continue_count_in(game_id, question_key, players),
        player_count: players.len() as u8,
        active_player_count: active_player_count_in(game_id, players) as u8,
    }
}

fn submission_views_from(
    game_id: u64,
    question_key: u8,
    players: &[[u8; 20]],
) -> Vec<SubmissionView> {
    players
        .iter()
        .map(
            |player| match Storage::submissions().get(&(game_id, question_key, *player)) {
                Some(submission) => SubmissionView {
                    player: pvm::Address::from(*player),
                    submitted: true,
                    answer: submission.answer,
                    wager: submission.wager,
                    correct: submission.correct,
                    overturn_votes: active_overturn_votes_in(
                        game_id,
                        question_key,
                        player,
                        players,
                    ),
                    continue_ready: Storage::continue_flags().contains(&(
                        game_id,
                        question_key,
                        *player,
                    )),
                    active: is_active_in_players(game_id, player, players),
                },
                None => SubmissionView {
                    player: pvm::Address::from(*player),
                    submitted: false,
                    answer: String::new(),
                    wager: 0,
                    correct: false,
                    overturn_votes: 0,
                    continue_ready: Storage::continue_flags().contains(&(
                        game_id,
                        question_key,
                        *player,
                    )),
                    active: is_active_in_players(game_id, player, players),
                },
            },
        )
        .collect()
}

fn player_names_from(players: &[[u8; 20]]) -> Vec<String> {
    players
        .iter()
        .map(|player| Storage::display_names().get(player).unwrap_or_default())
        .collect()
}

fn live_game_view_from(game_id: u64, m: &GameMeta, now: u64, players: &[[u8; 20]]) -> LiveGameView {
    let phase = phase_view_from(game_id, m, now, players);
    let question_key = logic::question_key(&clock_of(m));
    LiveGameView {
        pack_id: m.pack_id,
        creator: pvm::Address::from(m.creator),
        num_questions: m.num_questions,
        answer_blocks: m.answer_blocks,
        review_blocks: m.review_blocks,
        max_players: m.max_players,
        stage: phase.stage,
        cursor: phase.cursor,
        deadline: phase.deadline,
        current_block: phase.current_block,
        final_difficulty: phase.final_difficulty,
        slot: phase.slot,
        submit_count: phase.submit_count,
        continue_count: phase.continue_count,
        player_count: phase.player_count,
        active_player_count: phase.active_player_count,
        players: players
            .iter()
            .map(|player| pvm::Address::from(*player))
            .collect(),
        scores: players
            .iter()
            .map(|player| Storage::scores().get(&(game_id, *player)).unwrap_or(0))
            .collect(),
        player_names: player_names_from(players),
        submissions: submission_views_from(game_id, question_key, players),
    }
}

/// Early collapse: everyone has acted, advance one stage right now.
fn collapse(game_id: u64, m: &mut GameMeta) {
    if m.stage == STAGE_VOTE && m.final_difficulty == DIFFICULTY_UNSET {
        m.final_difficulty = logic::resolve_difficulty(active_difficulty_counts(game_id));
    }
    let (stage, cursor) = logic::next_stage(m.stage, m.cursor, m.num_questions);
    m.stage = stage;
    m.cursor = cursor;
    m.anchor = current_block();
}

/// A forfeit can reduce the current quorum. Re-evaluate exactly the action
/// that is live, counting only active players rather than stale aggregates.
fn collapse_if_everyone_ready(game_id: u64, m: &mut GameMeta) {
    let active = active_player_count(game_id);
    if active == 0 {
        m.stage = STAGE_ABANDONED;
        m.anchor = current_block();
        return;
    }
    let question_key = logic::question_key(&clock_of(m));
    let ready = match m.stage {
        STAGE_ANSWER | STAGE_FINAL_ANSWER => active_submission_count(game_id, question_key),
        STAGE_REVIEW | STAGE_FINAL_REVIEW => active_continue_count(game_id, question_key),
        STAGE_VOTE => active_difficulty_total(game_id),
        _ => return,
    };
    if ready >= active {
        collapse(game_id, m);
    }
}

fn save_game(game_id: u64, m: &GameMeta) {
    Storage::game_meta().insert(&game_id, m);
}

/// The registry slot answered during this stage. Only valid in
/// answer/review stages (final difficulty must be resolved by then).
fn active_slot(m: &GameMeta) -> u8 {
    match m.stage {
        STAGE_ANSWER | STAGE_REVIEW => m.cursor,
        STAGE_FINAL_ANSWER | STAGE_FINAL_REVIEW => {
            if m.final_difficulty == DIFFICULTY_UNSET {
                fail("DifficultyUnresolved");
            }
            final_slot(m.final_difficulty)
        }
        _ => fail("NoActiveQuestion"),
    }
}

// ── Contract ─────────────────────────────────────────────────────────

#[pvm::contract]
mod quizzler {
    // NOTE: no glob import — #[pvm::contract] injects its own String/Vec
    // imports into the module, which a `use super::*` would collide with.
    use super::{
        DIFFICULTY_UNSET, GameMeta, GameView, LiveGameView, MAX_ANSWER_BYTES, MAX_GAME_QUESTIONS,
        MAX_PLAYERS, MAX_STAGE_BLOCKS, MAX_WAGER, PhaseView, STAGE_ABANDONED, STAGE_ANSWER,
        STAGE_FINAL_ANSWER, STAGE_FINAL_REVIEW, STAGE_LOBBY, STAGE_REVIEW, STAGE_VOTE, Storage,
        Submission, SubmissionView, active_continue_count, active_difficulty_total, active_slot,
        active_submission_count, apply_overturn_if_quorum, caller20, clock_of, collapse,
        collapse_if_everyone_ready, current_block, emit_game_created, fail, game_view_from,
        gen_game_code, is_active_player, is_roster_player, live_game_view_from, load_game,
        load_players, logic, phase_view_from, player_names_from, pvm,
        reconcile_overturns_after_forfeit, registry_answers, registry_pack_status,
        require_active_player, save_game, settle, settle_at, submission_views_from,
    };
    use alloc::string::String;
    use alloc::vec::Vec;

    #[pvm::constructor]
    pub fn new(registry: pvm::Address) -> Result<(), Error> {
        Storage::registry().set(&registry.to_fixed_bytes());
        Storage::game_count().set(&0);
        Ok(())
    }

    /// The pack registry this game reads content from.
    #[pvm::method]
    pub fn registry() -> pvm::Address {
        pvm::Address::from(Storage::registry().get().unwrap_or([0u8; 20]))
    }

    /// Set the optional social label shown next to this account in every
    /// lobby, review, and scorecard. Sending an empty string clears it;
    /// clients then fall back to their standard abbreviated address.
    #[pvm::method]
    pub fn set_display_name(name: String) {
        let who = caller20();
        if name.is_empty() {
            Storage::display_names().remove(&who);
            return;
        }
        if !logic::valid_player_name(&name) {
            fail("BadDisplayName");
        }
        Storage::display_names().insert(&who, &name);
    }

    fn create_game_record(
        pack_id: u32,
        num_questions: u8,
        answer_blocks: u32,
        review_blocks: u32,
        max_players: u8,
        creation_nonce: u64,
    ) {
        let pack = registry_pack_status(pack_id);
        if !pack.exists || !pack.sealed {
            fail("PackNotSealed");
        }
        if num_questions == 0
            || num_questions > pack.regular_count
            || num_questions > MAX_GAME_QUESTIONS
        {
            fail("BadQuestionCount");
        }
        if answer_blocks < 2 || answer_blocks > MAX_STAGE_BLOCKS {
            fail("BadAnswerBlocks");
        }
        if review_blocks < 2 || review_blocks > MAX_STAGE_BLOCKS {
            fail("BadReviewBlocks");
        }
        if max_players == 0 || max_players > MAX_PLAYERS {
            fail("BadMaxPlayers");
        }

        let creator = caller20();
        if Storage::created_game_of().contains(&(creator, creation_nonce)) {
            fail("CreationNonceUsed");
        }
        let seq = Storage::game_count().get().unwrap_or(0);
        let next_seq = match seq.checked_add(1) {
            Some(next) => next,
            None => fail("GameIdExhausted"),
        };
        let id = gen_game_code(&creator, seq);
        let meta = GameMeta {
            pack_id,
            creator,
            num_questions,
            answer_blocks,
            review_blocks,
            max_players,
            stage: STAGE_LOBBY,
            cursor: 0,
            anchor: 0,
            final_difficulty: DIFFICULTY_UNSET,
        };
        save_game(id, &meta);
        let players: Vec<[u8; 20]> = alloc::vec![creator];
        Storage::players().insert(&id, &players);
        Storage::scores().insert(&(id, creator), &0);
        Storage::created_game_of().insert(&(creator, creation_nonce), &id);
        Storage::game_count().set(&next_seq);
        emit_game_created(creator, id);
    }

    // ── Game lifecycle ───────────────────────────────────────────

    /// Concurrent tabs can use a unique nonce and resolve the durable join
    /// code with `get_game_for_creation` after the transaction is included.
    #[pvm::method]
    pub fn create_game_with_nonce(
        pack_id: u32,
        num_questions: u8,
        answer_blocks: u32,
        review_blocks: u32,
        max_players: u8,
        creation_nonce: u64,
    ) {
        create_game_record(
            pack_id,
            num_questions,
            answer_blocks,
            review_blocks,
            max_players,
            creation_nonce,
        );
    }

    #[pvm::method]
    pub fn join_game(game_id: u64) {
        let meta = load_game(game_id);
        if meta.stage != STAGE_LOBBY {
            fail("GameAlreadyStarted");
        }
        let who = caller20();
        let mut players = load_players(game_id);
        if players.iter().any(|p| *p == who) {
            fail("AlreadyJoined");
        }
        if players.len() >= meta.max_players as usize {
            fail("GameFull");
        }
        players.push(who);
        Storage::players().insert(&game_id, &players);
        Storage::scores().insert(&(game_id, who), &0);
    }

    /// Leave an unstarted lobby. The roster remains ordered by arrival, so if
    /// the current starter leaves the next-longest-waiting player inherits the
    /// one temporary lobby privilege: starting the quiz.
    #[pvm::method]
    pub fn leave_lobby(game_id: u64) {
        let mut meta = load_game(game_id);
        if meta.stage != STAGE_LOBBY {
            fail("LobbyClosed");
        }
        let who = caller20();
        let mut players = load_players(game_id);
        let Some(index) = players.iter().position(|player| *player == who) else {
            fail("NotAPlayer");
        };
        players.remove(index);
        // A later rejoin is a fresh lobby arrival, even if a future contract
        // version wrote this flag before the lobby began.
        Storage::forfeited().remove(&(game_id, who));
        Storage::players().insert(&game_id, &players);
        if players.is_empty() {
            meta.stage = STAGE_ABANDONED;
            meta.anchor = current_block();
        }
        save_game(game_id, &meta);
    }

    #[pvm::method]
    pub fn start_game(game_id: u64) {
        let mut meta = load_game(game_id);
        if meta.stage != STAGE_LOBBY {
            fail("GameAlreadyStarted");
        }
        let starter = match load_players(game_id).first() {
            Some(player) => *player,
            None => fail("LobbyEmpty"),
        };
        if starter != caller20() {
            fail("NotLobbyStarter");
        }
        meta.stage = STAGE_ANSWER;
        meta.cursor = 0;
        meta.anchor = current_block();
        save_game(game_id, &meta);
    }

    // ── Playing ──────────────────────────────────────────────────

    #[pvm::method]
    pub fn submit_answer(game_id: u64, answer: String, wager: u32) {
        let mut meta = load_game(game_id);
        settle(game_id, &mut meta);
        if meta.stage != STAGE_ANSWER && meta.stage != STAGE_FINAL_ANSWER {
            fail("NotAcceptingAnswers");
        }
        let who = caller20();
        let active_count = require_active_player(game_id, &who);
        let qkey = logic::question_key(&clock_of(&meta));

        if Storage::submissions().contains(&(game_id, qkey, who)) {
            fail("AlreadyAnswered");
        }

        let score = Storage::scores().get(&(game_id, who)).unwrap_or(0);
        let is_final = meta.stage == STAGE_FINAL_ANSWER;
        if is_final {
            if wager > score {
                fail("WagerExceedsScore");
            }
        } else {
            if wager == 0 || wager > MAX_WAGER {
                fail("BadWager");
            }
            // Sporcle's wager system: each value 1..=10 is spent once per game
            let mask = Storage::used_wagers().get(&(game_id, who)).unwrap_or(0);
            let bit = 1u16 << wager;
            if mask & bit != 0 {
                fail("WagerAlreadyUsed");
            }
            Storage::used_wagers().insert(&(game_id, who), &(mask | bit));
        }

        // Bound raw input before normalization. This preserves the casual
        // plaintext model while preventing a punctuation-only payload from
        // allocating far more memory than the durable normalized answer.
        if answer.len() > MAX_ANSWER_BYTES {
            fail("AnswerTooLong");
        }
        let norm = logic::normalize(&answer);
        if norm.len() > MAX_ANSWER_BYTES {
            fail("AnswerTooLong");
        }
        let accepted = registry_answers(meta.pack_id, active_slot(&meta));
        let correct = !norm.is_empty() && logic::answer_matches(&norm, &accepted);

        if correct {
            Storage::scores().insert(&(game_id, who), &(score.saturating_add(wager)));
        } else if is_final {
            // wager ≤ score was checked above, so this cannot underflow
            Storage::scores().insert(&(game_id, who), &(score - wager));
        }

        Storage::submissions().insert(
            &(game_id, qkey, who),
            &Submission {
                answer: norm,
                wager,
                correct,
            },
        );
        if active_submission_count(game_id, qkey) >= active_count {
            collapse(game_id, &mut meta);
        }
        save_game(game_id, &meta);
    }

    /// Vote to flip a wrong answer to correct during review. Flips when a
    /// majority of the *other* players agree; flips are one-way.
    #[pvm::method]
    pub fn vote_correct(game_id: u64, target: pvm::Address) {
        let mut meta = load_game(game_id);
        settle(game_id, &mut meta);
        if meta.stage != STAGE_REVIEW && meta.stage != STAGE_FINAL_REVIEW {
            fail("NotInReview");
        }
        let voter = caller20();
        require_active_player(game_id, &voter);
        let target20: [u8; 20] = target.to_fixed_bytes();
        if voter == target20 {
            fail("CannotVoteForSelf");
        }
        if !is_roster_player(game_id, &target20) {
            fail("NotAPlayer");
        }
        let qkey = logic::question_key(&clock_of(&meta));

        let sub = match Storage::submissions().get(&(game_id, qkey, target20)) {
            Some(s) => s,
            None => fail("NoSubmission"),
        };
        if sub.correct {
            fail("AlreadyCorrect");
        }
        if Storage::overturn_voted().contains(&(game_id, qkey, target20, voter)) {
            fail("AlreadyVoted");
        }
        Storage::overturn_voted().insert(&(game_id, qkey, target20, voter), &true);
        apply_overturn_if_quorum(game_id, qkey, &target20, meta.stage == STAGE_FINAL_REVIEW);
        save_game(game_id, &meta);
    }

    /// Ready to move on from the review screen; when everyone is ready the
    /// game advances immediately.
    #[pvm::method]
    pub fn ready_continue(game_id: u64) {
        let mut meta = load_game(game_id);
        settle(game_id, &mut meta);
        if meta.stage != STAGE_REVIEW && meta.stage != STAGE_FINAL_REVIEW {
            fail("NotInReview");
        }
        let who = caller20();
        let active_count = require_active_player(game_id, &who);
        let qkey = logic::question_key(&clock_of(&meta));
        if Storage::continue_flags().contains(&(game_id, qkey, who)) {
            fail("AlreadyContinued");
        }
        Storage::continue_flags().insert(&(game_id, qkey, who), &true);
        if active_continue_count(game_id, qkey) >= active_count {
            collapse(game_id, &mut meta);
        }
        save_game(game_id, &meta);
    }

    /// Vote for the final question's difficulty (0 easy, 1 medium, 2 hard).
    /// Majority wins, ties break harder, no votes at all → medium.
    #[pvm::method]
    pub fn vote_difficulty(game_id: u64, difficulty: u8) {
        let mut meta = load_game(game_id);
        settle(game_id, &mut meta);
        if meta.stage != STAGE_VOTE {
            fail("NotInDifficultyVote");
        }
        if difficulty > 2 {
            fail("BadDifficulty");
        }
        let who = caller20();
        let active_count = require_active_player(game_id, &who);
        if Storage::difficulty_choice().contains(&(game_id, who)) {
            fail("AlreadyVoted");
        }
        Storage::difficulty_choice().insert(&(game_id, who), &difficulty);
        if active_difficulty_total(game_id) >= active_count {
            collapse(game_id, &mut meta);
        }
        save_game(game_id, &meta);
    }

    /// Permanently stop participating in a running quiz. Historic answers and
    /// scores remain readable, but the player no longer blocks later answer,
    /// review, or difficulty-vote quorums.
    #[pvm::method]
    pub fn forfeit_game(game_id: u64) {
        let mut meta = load_game(game_id);
        settle(game_id, &mut meta);
        match meta.stage {
            STAGE_ANSWER | STAGE_REVIEW | STAGE_VOTE | STAGE_FINAL_ANSWER | STAGE_FINAL_REVIEW => {}
            STAGE_LOBBY => fail("UseLeaveLobby"),
            _ => fail("GameNotActive"),
        }
        let who = caller20();
        require_active_player(game_id, &who);
        Storage::forfeited().insert(&(game_id, who), &true);
        reconcile_overturns_after_forfeit(game_id, &meta);
        collapse_if_everyone_ready(game_id, &mut meta);
        save_game(game_id, &meta);
    }

    // ── Views ────────────────────────────────────────────────────

    #[pvm::method]
    pub fn game_count() -> u64 {
        Storage::game_count().get().unwrap_or(0)
    }

    /// Resolve a game created with `create_game_with_nonce`; 0 means this
    /// creator/nonce pair has not been used (valid join codes are six digits).
    #[pvm::method]
    pub fn get_game_for_creation(who: pvm::Address, creation_nonce: u64) -> u64 {
        Storage::created_game_of()
            .get(&(who.to_fixed_bytes(), creation_nonce))
            .unwrap_or(0)
    }

    #[pvm::method]
    pub fn get_game(game_id: u64) -> GameView {
        let m = load_game(game_id);
        let players = load_players(game_id);
        game_view_from(game_id, &m, &players)
    }

    /// Everything the client needs each poll tick, settled to `current_block`
    /// (read-only — storage is not updated here). Question text and the
    /// review-time canonical answer are read from the registry by clients
    /// using (get_game.pack_id, slot).
    #[pvm::method]
    pub fn get_phase(game_id: u64) -> PhaseView {
        let now = current_block();
        let mut m = load_game(game_id);
        settle_at(game_id, &mut m, now);
        let players = load_players(game_id);
        phase_view_from(game_id, &m, now, &players)
    }

    #[pvm::method]
    pub fn get_players(game_id: u64) -> Vec<pvm::Address> {
        load_players(game_id)
            .iter()
            .map(|p| pvm::Address::from(*p))
            .collect()
    }

    /// Scores parallel to `get_players` order.
    #[pvm::method]
    pub fn get_scores(game_id: u64) -> Vec<u32> {
        load_players(game_id)
            .iter()
            .map(|p| Storage::scores().get(&(game_id, *p)).unwrap_or(0))
            .collect()
    }

    /// Optional display names parallel to `get_players`; an empty entry means
    /// no name has been set and clients should render their address fallback.
    #[pvm::method]
    pub fn get_player_names(game_id: u64) -> Vec<String> {
        load_game(game_id);
        let players = load_players(game_id);
        player_names_from(&players)
    }

    /// Consolidated live game snapshot for low-latency polling. It is settled
    /// to one `current_block` in memory (without mutating storage) and keeps
    /// plaintext submitted answers public, matching Quizzler's party model.
    /// Question text and canonical review answers remain in the registry and
    /// are fetched separately by the returned `(pack_id, slot)`.
    #[pvm::method]
    pub fn get_live_game(game_id: u64) -> LiveGameView {
        let now = current_block();
        let mut m = load_game(game_id);
        settle_at(game_id, &mut m, now);
        let players = load_players(game_id);
        live_game_view_from(game_id, &m, now, &players)
    }

    /// Whether `who` is still an active participant. This is deliberately
    /// narrower than `get_players`: after a forfeit, the address remains in
    /// the historical scorecard but may not re-enter or act in the quiz.
    #[pvm::method]
    pub fn is_player_active(game_id: u64, who: pvm::Address) -> bool {
        load_game(game_id);
        is_active_player(game_id, &who.to_fixed_bytes())
    }

    /// Per-player submission state for a question key (question index, or
    /// 0xff for the final question), in `get_players` order.
    #[pvm::method]
    pub fn get_submissions(game_id: u64, question_key: u8) -> Vec<SubmissionView> {
        load_game(game_id); // reverts on unknown game
        let players = load_players(game_id);
        submission_views_from(game_id, question_key, &players)
    }
}
