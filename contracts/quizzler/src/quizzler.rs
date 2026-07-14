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
    STAGE_ANSWER, STAGE_FINAL_ANSWER, STAGE_FINAL_REVIEW, STAGE_LOBBY, STAGE_REVIEW, STAGE_VOTE,
};
use pvm::{Decode, Encode, HostFn};
use pvm_contract as pvm;
use quizzler_logic as logic;

const MAX_ANSWER_BYTES: usize = 64;
const MAX_PLAYERS: u8 = 16;
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
    player_count: u8,
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
    player_count: u8,
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
    // (game, question_key, player)
    submissions: pvm::storage::Mapping<(u64, u8, [u8; 20]), Submission>,
    submit_count: pvm::storage::Mapping<(u64, u8), u32>,
    continue_flags: pvm::storage::Mapping<(u64, u8, [u8; 20]), bool>,
    continue_count: pvm::storage::Mapping<(u64, u8), u32>,
    // (game, question_key, target) → votes to overturn target's wrong answer
    overturn_votes: pvm::storage::Mapping<(u64, u8, [u8; 20]), u32>,
    overturn_voted: pvm::storage::Mapping<(u64, u8, [u8; 20], [u8; 20]), bool>,
    difficulty_voted: pvm::storage::Mapping<(u64, [u8; 20]), bool>,
    difficulty_counts: pvm::storage::Mapping<(u64, u8), u32>,
    difficulty_total: pvm::storage::Mapping<u64, u32>,
    // bitmask of wager values (bits 1..=10) already spent by a player
    used_wagers: pvm::storage::Mapping<(u64, [u8; 20]), u16>,
    // creator → newest game they created (codes shift under reorgs, so
    // clients resolve through this instead of scanning)
    latest_game_of: pvm::storage::Mapping<[u8; 20], u64>,
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
    let mut attempt: u8 = 0;
    loop {
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
        attempt = attempt.wrapping_add(1);
    }
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

fn require_player(game_id: u64, who: &[u8; 20]) -> u32 {
    let players = load_players(game_id);
    if !players.iter().any(|p| p == who) {
        fail("NotAPlayer");
    }
    players.len() as u32
}

fn stored_difficulty_counts(game_id: u64) -> [u32; 3] {
    [
        Storage::difficulty_counts().get(&(game_id, 0)).unwrap_or(0),
        Storage::difficulty_counts().get(&(game_id, 1)).unwrap_or(0),
        Storage::difficulty_counts().get(&(game_id, 2)).unwrap_or(0),
    ]
}

/// Apply timeout transitions to the stored clock; resolves the final
/// difficulty if the roll crossed the end of the Vote stage.
fn settle(game_id: u64, m: &mut GameMeta) {
    let (clock, crossed_vote) = logic::roll(clock_of(m), &cfg_of(m), current_block());
    if crossed_vote && m.final_difficulty == DIFFICULTY_UNSET {
        m.final_difficulty = logic::resolve_difficulty(stored_difficulty_counts(game_id));
    }
    m.stage = clock.stage;
    m.cursor = clock.cursor;
    m.anchor = clock.anchor;
}

/// Early collapse: everyone has acted, advance one stage right now.
fn collapse(game_id: u64, m: &mut GameMeta) {
    if m.stage == STAGE_VOTE && m.final_difficulty == DIFFICULTY_UNSET {
        m.final_difficulty = logic::resolve_difficulty(stored_difficulty_counts(game_id));
    }
    let (stage, cursor) = logic::next_stage(m.stage, m.cursor, m.num_questions);
    m.stage = stage;
    m.cursor = cursor;
    m.anchor = current_block();
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
        DIFFICULTY_UNSET, GameMeta, GameView, MAX_ANSWER_BYTES, MAX_GAME_QUESTIONS, MAX_PLAYERS,
        MAX_STAGE_BLOCKS, MAX_WAGER, PhaseView, STAGE_ANSWER, STAGE_FINAL_ANSWER,
        STAGE_FINAL_REVIEW, STAGE_LOBBY, STAGE_REVIEW, STAGE_VOTE, Storage, Submission,
        SubmissionView, active_slot, caller20, cfg_of, clock_of, collapse, current_block, fail,
        gen_game_code, load_game, load_players, logic, pvm, registry_answers, registry_pack_status,
        require_player, save_game, settle,
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

    // ── Game lifecycle ───────────────────────────────────────────

    #[pvm::method]
    pub fn create_game(
        pack_id: u32,
        num_questions: u8,
        answer_blocks: u32,
        review_blocks: u32,
        max_players: u8,
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
        let seq = Storage::game_count().get().unwrap_or(0);
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
        Storage::latest_game_of().insert(&creator, &id);
        Storage::game_count().set(&(seq + 1));
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

    #[pvm::method]
    pub fn start_game(game_id: u64) {
        let mut meta = load_game(game_id);
        if meta.stage != STAGE_LOBBY {
            fail("GameAlreadyStarted");
        }
        if meta.creator != caller20() {
            fail("NotGameCreator");
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
        let player_count = require_player(game_id, &who);
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
        let submitted = Storage::submit_count().get(&(game_id, qkey)).unwrap_or(0) + 1;
        Storage::submit_count().insert(&(game_id, qkey), &submitted);
        if submitted >= player_count {
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
        let player_count = require_player(game_id, &voter);
        let target20: [u8; 20] = target.to_fixed_bytes();
        if voter == target20 {
            fail("CannotVoteForSelf");
        }
        let qkey = logic::question_key(&clock_of(&meta));

        let mut sub = match Storage::submissions().get(&(game_id, qkey, target20)) {
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
        let votes = Storage::overturn_votes()
            .get(&(game_id, qkey, target20))
            .unwrap_or(0)
            + 1;
        Storage::overturn_votes().insert(&(game_id, qkey, target20), &votes);

        if votes >= logic::overturn_threshold(player_count) {
            sub.correct = true;
            Storage::submissions().insert(&(game_id, qkey, target20), &sub);
            let score = Storage::scores().get(&(game_id, target20)).unwrap_or(0);
            // regular: grant the wager; final: refund the loss AND grant it
            let delta = if meta.stage == STAGE_FINAL_REVIEW {
                sub.wager.saturating_mul(2)
            } else {
                sub.wager
            };
            Storage::scores().insert(&(game_id, target20), &score.saturating_add(delta));
        }
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
        let player_count = require_player(game_id, &who);
        let qkey = logic::question_key(&clock_of(&meta));
        if Storage::continue_flags().contains(&(game_id, qkey, who)) {
            fail("AlreadyContinued");
        }
        Storage::continue_flags().insert(&(game_id, qkey, who), &true);
        let count = Storage::continue_count().get(&(game_id, qkey)).unwrap_or(0) + 1;
        Storage::continue_count().insert(&(game_id, qkey), &count);
        if count >= player_count {
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
        let player_count = require_player(game_id, &who);
        if Storage::difficulty_voted().contains(&(game_id, who)) {
            fail("AlreadyVoted");
        }
        Storage::difficulty_voted().insert(&(game_id, who), &true);
        let count = Storage::difficulty_counts()
            .get(&(game_id, difficulty))
            .unwrap_or(0)
            + 1;
        Storage::difficulty_counts().insert(&(game_id, difficulty), &count);
        let total = Storage::difficulty_total().get(&game_id).unwrap_or(0) + 1;
        Storage::difficulty_total().insert(&game_id, &total);
        if total >= player_count {
            collapse(game_id, &mut meta);
        }
        save_game(game_id, &meta);
    }

    // ── Views ────────────────────────────────────────────────────

    #[pvm::method]
    pub fn game_count() -> u64 {
        Storage::game_count().get().unwrap_or(0)
    }

    /// Newest game created by `who` (0 when none — codes are never 0).
    /// Codes are assigned at execution time, so clients resolve their own
    /// creations through this view.
    #[pvm::method]
    pub fn my_latest_game(who: pvm::Address) -> u64 {
        Storage::latest_game_of()
            .get(&who.to_fixed_bytes())
            .unwrap_or(0)
    }

    #[pvm::method]
    pub fn get_game(game_id: u64) -> GameView {
        let m = load_game(game_id);
        GameView {
            pack_id: m.pack_id,
            creator: pvm::Address::from(m.creator),
            num_questions: m.num_questions,
            answer_blocks: m.answer_blocks,
            review_blocks: m.review_blocks,
            max_players: m.max_players,
            player_count: load_players(game_id).len() as u8,
        }
    }

    /// Everything the client needs each poll tick, settled to `current_block`
    /// (read-only — storage is not updated here). Question text and the
    /// review-time canonical answer are read from the registry by clients
    /// using (get_game.pack_id, slot).
    #[pvm::method]
    pub fn get_phase(game_id: u64) -> PhaseView {
        let mut m = load_game(game_id);
        settle(game_id, &mut m);
        let clock = clock_of(&m);
        let qkey = logic::question_key(&clock);
        let slot = match m.stage {
            STAGE_ANSWER | STAGE_REVIEW | STAGE_FINAL_ANSWER | STAGE_FINAL_REVIEW => {
                active_slot(&m)
            }
            _ => 0xff,
        };
        // During the difficulty vote there is no per-question submit counter;
        // surface the vote tally in its place so the client sees progress.
        let submit_count = if m.stage == STAGE_VOTE {
            Storage::difficulty_total().get(&game_id).unwrap_or(0)
        } else {
            Storage::submit_count().get(&(game_id, qkey)).unwrap_or(0)
        };
        PhaseView {
            stage: m.stage,
            cursor: m.cursor,
            deadline: logic::stage_deadline(&clock, &cfg_of(&m)),
            current_block: current_block(),
            final_difficulty: m.final_difficulty,
            slot,
            submit_count,
            continue_count: Storage::continue_count().get(&(game_id, qkey)).unwrap_or(0),
            player_count: load_players(game_id).len() as u8,
        }
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

    /// Per-player submission state for a question key (question index, or
    /// 0xff for the final question), in `get_players` order.
    #[pvm::method]
    pub fn get_submissions(game_id: u64, question_key: u8) -> Vec<SubmissionView> {
        load_game(game_id); // reverts on unknown game
        load_players(game_id)
            .iter()
            .map(
                |p| match Storage::submissions().get(&(game_id, question_key, *p)) {
                    Some(s) => SubmissionView {
                        player: pvm::Address::from(*p),
                        submitted: true,
                        answer: s.answer,
                        wager: s.wager,
                        correct: s.correct,
                        overturn_votes: Storage::overturn_votes()
                            .get(&(game_id, question_key, *p))
                            .unwrap_or(0),
                        continue_ready: Storage::continue_flags().contains(&(
                            game_id,
                            question_key,
                            *p,
                        )),
                    },
                    None => SubmissionView {
                        player: pvm::Address::from(*p),
                        submitted: false,
                        answer: String::new(),
                        wager: 0,
                        correct: false,
                        overturn_votes: 0,
                        continue_ready: Storage::continue_flags().contains(&(
                            game_id,
                            question_key,
                            *p,
                        )),
                    },
                },
            )
            .collect()
    }
}
