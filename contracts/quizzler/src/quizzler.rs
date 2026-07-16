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
//! A dedicated session registry resolves short-lived local game keys back to
//! their product-account owner for the reversible in-game actions (answers,
//! wagers, votes, continues) — never for membership or identity changes.
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
    STAGE_ABANDONED, STAGE_ANSWER, STAGE_FINAL_ANSWER, STAGE_FINAL_REVIEW, STAGE_FINAL_WAGER,
    STAGE_LOBBY, STAGE_REVIEW, STAGE_VOTE,
};
use pvm::{Decode, Encode, HostFn};
use pvm_contract as pvm;
use quizzler_logic as logic;

const MAX_ANSWER_BYTES: usize = 64;
/// Upper roster ceiling for this version of the game contract. The
/// player-facing app always uses this deployment's documented ceiling.
const MAX_PLAYERS: u8 = 24;
const MAX_STAGE_BLOCKS: u32 = 600;
/// Each regular wager value 1..=num_questions is usable exactly once. The
/// u32 mask below therefore supports this deployment's 20-question ceiling.
const MAX_GAME_QUESTIONS: u8 = 20;
/// A registry pack is capped at 200 ordinary question slots. Keeping this
/// bound here lets the game validate a foreign registry response before it
/// turns that response into durable per-game state.
const MAX_PACK_QUESTIONS: u8 = 200;
/// Ordinary pack slots occupy 0..200, so this sentinel is never a valid
/// selected final question.
const FINAL_SLOT_UNSET: u8 = 0xff;
const DIFFICULTY_MASK_ALL: u8 = 0b111;

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
    /// Difficulty selected by the player vote. `DIFFICULTY_UNSET` only
    /// exists before a multi-choice vote resolves.
    final_difficulty: u8,
    /// Ordinary registry slot reserved for the selected final question.
    /// Kept in game metadata so clients can still render the final answer on
    /// the terminal score screen.
    final_slot: u8,
    /// Bit `d` means an unused question of difficulty `d` was reserved at
    /// game creation and can be offered in the final-round vote.
    viable_final_difficulties: u8,
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
    /// Selected final-question slot, including after the game has finished.
    /// `0xff` means the final difficulty has not been resolved yet.
    final_slot: u8,
    /// Bitmask of final-round difficulties that are actually selectable:
    /// bit 0 easy, bit 1 medium, bit 2 hard.
    viable_final_difficulties: u8,
    /// Registry slot of the active question (0xff when no question is live).
    /// Clients read question text — and, during review, the canonical
    /// answer — from the registry using (pack_id, slot).
    slot: u8,
    submit_count: u32,
    continue_count: u32,
    /// Number of active players that have explicitly locked a final wager.
    /// This is non-zero only during `STAGE_FINAL_WAGER`.
    final_wager_count: u32,
    /// Live difficulty-vote totals. They are zero outside `STAGE_VOTE` so a
    /// client never renders stale choices after the final question is set.
    easy_vote_count: u32,
    medium_vote_count: u32,
    hard_vote_count: u32,
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
    final_slot: u8,
    viable_final_difficulties: u8,
    slot: u8,
    submit_count: u32,
    continue_count: u32,
    final_wager_count: u32,
    easy_vote_count: u32,
    medium_vote_count: u32,
    hard_vote_count: u32,
    player_count: u8,
    active_player_count: u8,
    players: alloc::vec::Vec<pvm::Address>,
    scores: alloc::vec::Vec<u32>,
    /// Parallel to `players`; an empty string means the client should use its
    /// deterministic friendly fallback label.
    player_names: alloc::vec::Vec<String>,
    /// Parallel to `players`. A zero is meaningful only when the matching
    /// `difficulty_vote_locked` entry is true; otherwise the player has not
    /// voted yet. This lets a refreshed client keep its own vote disabled.
    difficulty_choices: alloc::vec::Vec<u8>,
    /// Parallel to `players`; true after that player has cast a difficulty
    /// vote. It is intentionally included in the live snapshot so a client
    /// never has to infer personal state from aggregate vote totals.
    difficulty_vote_locked: alloc::vec::Vec<bool>,
    /// Parallel to `players`. An unselected wager is zero; `final_wager_locked`
    /// distinguishes a still-selectable zero from an explicit or timed-out
    /// locked zero.
    final_wagers: alloc::vec::Vec<u32>,
    /// Parallel to `players`. The timer closing logically locks every missing
    /// final wager at zero, without requiring a write from every player.
    final_wager_locked: alloc::vec::Vec<bool>,
    /// Current question (or final-question) submissions in roster order.
    submissions: alloc::vec::Vec<SubmissionView>,
}

/// Mirror of the registry's PackStatus view (cross-contract decode target).
#[derive(pvm::SolAbi)]
struct PackStatus {
    exists: bool,
    sealed: bool,
    question_count: u8,
    easy_count: u8,
    medium_count: u8,
    hard_count: u8,
}

/// Immutable per-game question plan. At creation the game reserves one
/// unused final candidate for every bit in `viable_final_difficulties`, then
/// stores the regular question order and these candidate slots separately.
struct QuestionPlan {
    regular_slots: alloc::vec::Vec<u8>,
    final_slots: [u8; 3],
    viable_final_difficulties: u8,
}

// ── Storage ──────────────────────────────────────────────────────────

#[pvm::storage]
struct Storage {
    // pack registry contract this game reads content from
    registry: [u8; 20],
    // session-key registry consulted only for narrow, in-game interactions
    session_registry: [u8; 20],
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
    // (game, regular-question cursor) → registry slot. Chosen once when the
    // game is created, so every participant observes the same planned pack
    // subset with no repeats.
    regular_slots: pvm::storage::Mapping<(u64, u8), u8>,
    // (game, difficulty) → reserved ordinary registry slot for a possible
    // final. Only difficulties flagged in GameMeta are stored.
    final_slots: pvm::storage::Mapping<(u64, u8), u8>,
    continue_flags: pvm::storage::Mapping<(u64, u8, [u8; 20]), bool>,
    // (game, question_key, target) → votes to overturn target's wrong answer
    overturn_voted: pvm::storage::Mapping<(u64, u8, [u8; 20], [u8; 20]), bool>,
    // The individual choice lets a later forfeit remove an already-cast vote
    // from both the live quorum and the final difficulty resolution.
    difficulty_choice: pvm::storage::Mapping<(u64, [u8; 20]), u8>,
    // Explicit final-wager selections. An absent entry is a durable logical
    // zero after the final-wager timer closes, so a player who times out can
    // still submit a final answer without another transaction.
    final_wagers: pvm::storage::Mapping<(u64, [u8; 20]), u32>,
    // Bitmask of regular wager values (bits 1..=num_questions) already spent
    // by a player. MAX_GAME_QUESTIONS is 20, so a u32 is sufficient.
    used_wagers: pvm::storage::Mapping<(u64, [u8; 20]), u32>,
    // (creator, client-selected nonce) → game code. This stays stable under
    // concurrent creation from the same account.
    created_game_of: pvm::storage::Mapping<([u8; 20], u64), u64>,
    // Optional, global social label for an account. A blank mapping value is
    // intentionally represented by an absent entry so clients can generate a
    // stable friendly fallback without storing extra profile data.
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

/// Build a deterministic per-game seed. Quiz content and answers are public
/// in Quizzler's casual party model, so this is deliberately varied rather
/// than secret. Persisting the resulting plan ensures every participant sees
/// exactly the same questions even after a refresh.
fn question_plan_seed(
    creator: &[u8; 20],
    game_id: u64,
    sequence: u64,
    creation_nonce: u64,
    creation_block: u64,
    pack_id: u32,
) -> [u8; 32] {
    // Domain-separate this seed from join-code generation and include every
    // stable piece of game-creation context. The hash is not a security
    // boundary; it simply provides evenly spread planner choices.
    let mut seed_input = [0u8; 72];
    seed_input[..16].copy_from_slice(b"quizzler.plan.v1");
    seed_input[16..36].copy_from_slice(creator);
    seed_input[36..44].copy_from_slice(&game_id.to_le_bytes());
    seed_input[44..52].copy_from_slice(&sequence.to_le_bytes());
    seed_input[52..60].copy_from_slice(&creation_nonce.to_le_bytes());
    seed_input[60..64].copy_from_slice(&pack_id.to_le_bytes());
    seed_input[64..72].copy_from_slice(&creation_block.to_le_bytes());
    let mut seed = [0u8; 32];
    pvm::api::hash_keccak_256(&seed_input, &mut seed);
    seed
}

/// Take the next deterministic bounded random value from a plan seed.
fn plan_random_index(seed: &mut [u8; 32], round: &mut u16, bound: usize) -> usize {
    if bound == 0 {
        fail("PlannerEmptyCandidateSet");
    }
    let mut input = [0u8; 34];
    input[..32].copy_from_slice(seed);
    input[32..34].copy_from_slice(&round.to_le_bytes());
    let mut hash = [0u8; 32];
    pvm::api::hash_keccak_256(&input, &mut hash);
    *seed = hash;
    *round = match round.checked_add(1) {
        Some(next) => next,
        None => fail("PlannerRoundOverflow"),
    };
    (u64::from_le_bytes(hash[..8].try_into().unwrap()) % bound as u64) as usize
}

fn difficulty_bit(difficulty: u8) -> u8 {
    if difficulty > 2 {
        fail("BadDifficulty");
    }
    1u8 << difficulty
}

fn mask_has_one_difficulty(mask: u8) -> bool {
    let mask = mask & DIFFICULTY_MASK_ALL;
    mask != 0 && (mask & (mask - 1)) == 0
}

/// Fixed regular-round target: 40% easy, 40% medium, 20% hard. This gives
/// the supported game lengths the intentional mixes 5 = 2/2/1, 10 = 4/4/2,
/// 15 = 6/6/3, and 20 = 8/8/4. Sparse packs fall back to nearby available
/// tiers in `planned_difficulty_counts` rather than becoming unplayable.
fn desired_difficulty_counts(num_questions: u8) -> [u8; 3] {
    let hard = num_questions / 5;
    let non_hard = num_questions - hard;
    let medium = non_hard / 2;
    let easy = non_hard - medium;
    [easy, medium, hard]
}

fn fallback_order(difficulty: usize) -> [usize; 3] {
    match difficulty {
        // If an easy target is unavailable, medium is the gentlest fallback.
        0 => [1, 2, 0],
        // For a missing middle tier, prefer an easier question over a harder
        // one so a sparse community pack does not accidentally become brutal.
        1 => [0, 2, 1],
        // A missing hard target falls back to medium before easy.
        2 => [1, 0, 2],
        _ => fail("BadDifficulty"),
    }
}

/// Allocate the intended regular-round mix within the candidates that remain
/// after final candidates were reserved. The explicit fallback order keeps a
/// pack with incomplete metadata useful while still putting the first
/// available question at the easiest tier later in the schedule builder.
fn planned_difficulty_counts(capacity: [u8; 3], num_questions: u8) -> [u8; 3] {
    let desired = desired_difficulty_counts(num_questions);
    let mut planned = [0u8; 3];
    for difficulty in 0..3 {
        planned[difficulty] = core::cmp::min(desired[difficulty], capacity[difficulty]);
    }

    for difficulty in 0..3 {
        let missing = desired[difficulty].saturating_sub(planned[difficulty]);
        for _ in 0..missing {
            let mut filled = false;
            for fallback in fallback_order(difficulty) {
                if planned[fallback] < capacity[fallback] {
                    planned[fallback] += 1;
                    filled = true;
                    break;
                }
            }
            if !filled {
                fail("QuestionPlanImpossible");
            }
        }
    }

    let allocated: u8 = planned.iter().sum();
    if allocated != num_questions {
        // This indicates a malformed registry response or an arithmetic
        // mistake in the planner. Never start a game that could later miss a
        // promised question.
        fail("QuestionPlanImpossible");
    }
    planned
}

/// Choose a difficulty sequence with the desired count of each tier. The
/// first question is always the easiest tier available for regular play, and
/// later picks are weighted by what remains while avoiding a third identical
/// difficulty in a row whenever another tier is available.
fn planned_difficulty_sequence(
    mut remaining: [u8; 3],
    seed: &mut [u8; 32],
    round: &mut u16,
) -> alloc::vec::Vec<u8> {
    let total: usize = remaining.iter().map(|count| usize::from(*count)).sum();
    let mut sequence = alloc::vec::Vec::with_capacity(total);
    if total == 0 {
        return sequence;
    }

    for difficulty in 0..3 {
        if remaining[difficulty] > 0 {
            sequence.push(difficulty as u8);
            remaining[difficulty] -= 1;
            break;
        }
    }

    while sequence.len() < total {
        let previous = *sequence.last().unwrap_or(&DIFFICULTY_UNSET);
        let before_previous = if sequence.len() >= 2 {
            sequence[sequence.len() - 2]
        } else {
            DIFFICULTY_UNSET
        };
        let prohibit_repeat = previous == before_previous
            && remaining
                .iter()
                .enumerate()
                .any(|(difficulty, count)| *count > 0 && difficulty as u8 != previous);

        let eligible_total: usize = remaining
            .iter()
            .enumerate()
            .filter(|(difficulty, count)| {
                **count > 0 && (!prohibit_repeat || *difficulty as u8 != previous)
            })
            .map(|(_, count)| usize::from(*count))
            .sum();
        let mut choice = plan_random_index(seed, round, eligible_total);
        let mut selected = None;
        for difficulty in 0..3 {
            if remaining[difficulty] == 0 || (prohibit_repeat && difficulty as u8 == previous) {
                continue;
            }
            let weight = remaining[difficulty] as usize;
            if choice < weight {
                selected = Some(difficulty);
                break;
            }
            choice -= weight;
        }
        let difficulty = match selected {
            Some(difficulty) => difficulty,
            None => fail("QuestionPlanImpossible"),
        };
        sequence.push(difficulty as u8);
        remaining[difficulty] -= 1;
    }
    sequence
}

/// Build the regular order, then reserve one final candidate for every
/// difficulty represented by the *leftover* slots. Planning the regular game
/// first is important: a pack with exactly one Easy question must use that as
/// the opening warm-up rather than hide it behind an Easy final choice.
fn build_question_plan(
    creator: &[u8; 20],
    game_id: u64,
    sequence: u64,
    creation_nonce: u64,
    creation_block: u64,
    pack_id: u32,
    num_questions: u8,
    mut slots_by_difficulty: [alloc::vec::Vec<u8>; 3],
) -> QuestionPlan {
    let total_candidates: usize = slots_by_difficulty.iter().map(|slots| slots.len()).sum();
    if total_candidates <= num_questions as usize {
        fail("NotEnoughQuestionsForFinal");
    }

    let mut seed = question_plan_seed(
        creator,
        game_id,
        sequence,
        creation_nonce,
        creation_block,
        pack_id,
    );
    let mut round = 0u16;

    let capacity = [
        slots_by_difficulty[0].len() as u8,
        slots_by_difficulty[1].len() as u8,
        slots_by_difficulty[2].len() as u8,
    ];
    let planned = planned_difficulty_counts(capacity, num_questions);
    let sequence = planned_difficulty_sequence(planned, &mut seed, &mut round);
    let mut regular_slots = alloc::vec::Vec::with_capacity(num_questions as usize);
    for difficulty in sequence {
        let candidates = &mut slots_by_difficulty[difficulty as usize];
        let index = plan_random_index(&mut seed, &mut round, candidates.len());
        regular_slots.push(candidates.swap_remove(index));
    }
    if regular_slots.len() != num_questions as usize {
        fail("QuestionPlanImpossible");
    }

    // Only difficulties with an unused candidate after the regular plan are
    // valid final-vote controls. This naturally adapts an all-easy pack (one
    // Easy choice, no vote) and never promises a tier that would repeat a
    // regular question.
    let mut final_slots = [FINAL_SLOT_UNSET; 3];
    let mut viable_final_difficulties = 0u8;
    for difficulty in 0..3 {
        let candidates = &mut slots_by_difficulty[difficulty];
        if candidates.is_empty() {
            continue;
        }
        let index = plan_random_index(&mut seed, &mut round, candidates.len());
        final_slots[difficulty] = candidates.swap_remove(index);
        viable_final_difficulties |= difficulty_bit(difficulty as u8);
    }
    if viable_final_difficulties == 0 {
        fail("NotEnoughQuestionsForFinal");
    }

    QuestionPlan {
        regular_slots,
        final_slots,
        viable_final_difficulties,
    }
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

fn abi_word_address(address: [u8; 20]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(&address);
    word
}

/// Call a registry view and ABI-decode its return. Mirrors the calling
/// convention of the macro-generated cross-contract `Reference` methods.
fn contract_view_call<T: pvm::SolAbi>(
    target: [u8; 20],
    name: &str,
    types: &[&str],
    words: &[[u8; 32]],
    out_cap: usize,
    error: &str,
) -> T {
    extern crate alloc;
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
        &target,
        u64::MAX,
        &[0u8; 32],
        &calldata,
        Some(&mut output_ref),
    );
    match result {
        Ok(()) => {
            let written = output_ref.len();
            // In EVM semantics a call to a codeless (mis-configured) address
            // SUCCEEDS with empty output, and `abi_decode` has no error
            // return — feeding it short data traps with an undiagnosable
            // "contract trapped" instead of this typed revert. Every shape
            // decoded here is at least one 32-byte word. A reply that fills
            // the buffer exactly was clipped by `out_cap`; decoding a
            // truncated prefix must also fail loud.
            if written < 32 || written == out_cap {
                fail(error);
            }
            T::abi_decode(&output_buf[..written], 0)
        }
        Err(_) => fail(error),
    }
}

fn registry_call<T: pvm::SolAbi>(
    name: &str,
    types: &[&str],
    words: &[[u8; 32]],
    out_cap: usize,
) -> T {
    contract_view_call(
        Storage::registry().get().unwrap_or([0u8; 20]),
        name,
        types,
        words,
        out_cap,
        "RegistryCallFailed",
    )
}

fn session_registry_call<T: pvm::SolAbi>(
    name: &str,
    types: &[&str],
    words: &[[u8; 32]],
    out_cap: usize,
) -> T {
    contract_view_call(
        Storage::session_registry().get().unwrap_or([0u8; 20]),
        name,
        types,
        words,
        out_cap,
        "SessionRegistryCallFailed",
    )
}

fn registry_pack_status(pack_id: u32) -> PackStatus {
    // PackStatus is 6 static words = 192 bytes; 256 leaves headroom so a
    // full reply is never mistaken for truncation by the out_cap guard above.
    registry_call("getPackStatus", &["uint32"], &[abi_word_u32(pack_id)], 256)
}

fn registry_question_slots_for_difficulty(pack_id: u32, difficulty: u8) -> Vec<u8> {
    // ABI encoding for the registry's bounded `uint8[]`: one offset word,
    // one length word, and at most 200 element words = 6,464 bytes. Keep a
    // comfortable but finite cap so a malformed registry cannot make game
    // creation allocate an unbounded response.
    registry_call(
        "getQuestionSlotsForDifficulty",
        &["uint32", "uint8"],
        &[abi_word_u32(pack_id), abi_word_u8(difficulty)],
        8192,
    )
}

fn registry_answers(pack_id: u32, slot: u8) -> Vec<String> {
    // Worst case against the registry's bounds (5 answers × 64 bytes):
    // head offset 32 + length 32 + 5 × (offset 32 + length 32 + padded 64)
    // = 704 bytes. A registry configured with more/longer answers hits the
    // out_cap guard and reverts as RegistryCallFailed instead of silently
    // scoring against a truncated answer set.
    registry_call(
        "getAnswers",
        &["uint32", "uint8"],
        &[abi_word_u32(pack_id), abi_word_u8(slot)],
        1024,
    )
}

/// Resolve a direct product-account caller or a registered session key to the
/// player address persisted by the game. A former/expired session resolves to
/// zero in the registry, so fail before it can be treated as a new player.
fn resolved_caller() -> [u8; 20] {
    let caller = caller20();
    let resolved: pvm::Address =
        session_registry_call("resolve", &["address"], &[abi_word_address(caller)], 64);
    let player = resolved.to_fixed_bytes();
    if player == [0u8; 20] {
        fail("InactiveSession");
    }
    player
}

/// Return the roster identity for a reversible in-game action. This is the
/// intentionally narrow path through which a local session key may act.
fn player_for_caller() -> [u8; 20] {
    resolved_caller()
}

/// Operations that change a player's durable party membership or identity
/// must be signed by that product account itself. Merely refusing to find a
/// session key in the roster would leave a session key able to create its own
/// lobby, profile, or pack-adjacent state by calling the contract directly.
fn main_caller() -> [u8; 20] {
    let caller = caller20();
    if resolved_caller() != caller {
        fail("MainKeyRequired");
    }
    caller
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

/// Read the registry's three immutable difficulty indexes and verify every
/// count, range, and uniqueness invariant before storing a plan. The game is
/// intentionally compatible only with the matching registry ABI; a bad
/// deployment should fail at creation rather than produce a game that gets
/// stuck at its final round.
fn validated_question_slots(pack_id: u32, status: &PackStatus) -> [Vec<u8>; 3] {
    let slots_by_difficulty = [
        registry_question_slots_for_difficulty(pack_id, 0),
        registry_question_slots_for_difficulty(pack_id, 1),
        registry_question_slots_for_difficulty(pack_id, 2),
    ];
    let expected = [status.easy_count, status.medium_count, status.hard_count];
    let total: u16 = expected.iter().map(|count| u16::from(*count)).sum();
    if total != u16::from(status.question_count) {
        fail("RegistryDifficultyCountsInvalid");
    }

    let mut seen = [false; MAX_PACK_QUESTIONS as usize];
    for difficulty in 0..3 {
        if slots_by_difficulty[difficulty].len() != expected[difficulty] as usize {
            fail("RegistryDifficultyIndexInvalid");
        }
        for slot in &slots_by_difficulty[difficulty] {
            if *slot >= status.question_count || seen[*slot as usize] {
                fail("RegistryDifficultyIndexInvalid");
            }
            seen[*slot as usize] = true;
        }
    }
    slots_by_difficulty
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

fn active_final_wager_count_in(game_id: u64, players: &[[u8; 20]]) -> u32 {
    players
        .iter()
        .filter(|player| {
            !Storage::forfeited()
                .get(&(game_id, **player))
                .unwrap_or(false)
        })
        .filter(|player| Storage::final_wagers().contains(&(game_id, **player)))
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

fn active_final_wager_count(game_id: u64) -> u32 {
    let players = load_players(game_id);
    active_final_wager_count_in(game_id, &players)
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

fn resolve_final_selection(game_id: u64, m: &mut GameMeta, counts: [u32; 3]) {
    if m.final_difficulty != DIFFICULTY_UNSET {
        if m.final_slot == FINAL_SLOT_UNSET {
            fail("FinalSlotMissing");
        }
        return;
    }

    let mask = m.viable_final_difficulties;
    if mask == 0 || mask & !DIFFICULTY_MASK_ALL != 0 {
        fail("NoViableFinalDifficulty");
    }
    let has_votes = counts.iter().any(|count| *count > 0);
    let difficulty = if !has_votes {
        // Preserve the old no-vote intent (medium) where it is actually a
        // valid option. Sparse packs fall back to easy, then hard.
        if mask & difficulty_bit(1) != 0 {
            1
        } else if mask & difficulty_bit(0) != 0 {
            0
        } else {
            2
        }
    } else {
        let mut selected = None;
        for difficulty in 0..3u8 {
            if mask & difficulty_bit(difficulty) == 0 {
                continue;
            }
            match selected {
                // `>=` keeps the party game's intentional harder-tier
                // tiebreak, but only among choices the pack can honor.
                Some(current) if counts[difficulty as usize] < counts[current as usize] => {}
                _ => selected = Some(difficulty),
            }
        }
        match selected {
            Some(difficulty) => difficulty,
            None => fail("NoViableFinalDifficulty"),
        }
    };
    let slot = match Storage::final_slots().get(&(game_id, difficulty)) {
        Some(slot) if slot != FINAL_SLOT_UNSET => slot,
        _ => fail("FinalSlotMissing"),
    };
    m.final_difficulty = difficulty;
    m.final_slot = slot;
}

/// Advance exactly one timed phase at a known boundary. When a pack has only
/// one viable final tier, its last regular review routes directly into final
/// wagering instead of presenting a meaningless one-button vote.
fn advance_timed_stage(game_id: u64, m: &mut GameMeta, next_anchor: u64) {
    if m.stage == STAGE_VOTE {
        resolve_final_selection(game_id, m, active_difficulty_counts(game_id));
    }
    let (mut stage, cursor) = logic::next_stage(m.stage, m.cursor, m.num_questions);
    if stage == STAGE_VOTE && mask_has_one_difficulty(m.viable_final_difficulties) {
        resolve_final_selection(game_id, m, [0u32; 3]);
        stage = STAGE_FINAL_WAGER;
    }
    m.stage = stage;
    m.cursor = cursor;
    m.anchor = next_anchor;
}

/// Apply timeout transitions at a known block. The loop deliberately handles
/// the one-viable-tier shortcut during the review → final transition, rather
/// than rolling through a hidden vote timer. View methods pass one block
/// through their whole snapshot so deadline/current-block data cannot be
/// internally inconsistent.
fn settle_at(game_id: u64, m: &mut GameMeta, now: u64) {
    loop {
        let clock = clock_of(m);
        let Some(duration) = logic::stage_duration(clock.stage, &cfg_of(m)) else {
            return;
        };
        let deadline = clock.anchor.saturating_add(duration);
        if now < deadline {
            return;
        }
        advance_timed_stage(game_id, m, deadline);
    }
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

/// Once this stage has closed, missing final-wager selections are permanently
/// interpreted as zero. Keeping that default implicit avoids a storage write
/// for every player merely because the timer elapsed, while preserving the
/// same result across refreshes and later final-answer submissions.
fn final_wager_stage_closed(stage: u8) -> bool {
    matches!(
        stage,
        STAGE_FINAL_ANSWER | STAGE_FINAL_REVIEW | logic::STAGE_FINISHED
    )
}

fn difficulty_choices_from(game_id: u64, players: &[[u8; 20]]) -> (Vec<u8>, Vec<bool>) {
    let mut choices = Vec::with_capacity(players.len());
    let mut locked = Vec::with_capacity(players.len());
    for player in players {
        match Storage::difficulty_choice().get(&(game_id, *player)) {
            Some(choice) => {
                choices.push(choice);
                locked.push(true);
            }
            None => {
                choices.push(0);
                locked.push(false);
            }
        }
    }
    (choices, locked)
}

fn final_wagers_from(game_id: u64, m: &GameMeta, players: &[[u8; 20]]) -> (Vec<u32>, Vec<bool>) {
    let default_locked = final_wager_stage_closed(m.stage);
    let mut wagers = Vec::with_capacity(players.len());
    let mut locked = Vec::with_capacity(players.len());
    for player in players {
        match Storage::final_wagers().get(&(game_id, *player)) {
            Some(wager) => {
                wagers.push(wager);
                locked.push(true);
            }
            None => {
                wagers.push(0);
                locked.push(default_locked);
            }
        }
    }
    (wagers, locked)
}

fn phase_view_from(game_id: u64, m: &GameMeta, now: u64, players: &[[u8; 20]]) -> PhaseView {
    let clock = clock_of(m);
    let question_key = logic::question_key(&clock);
    let slot = match m.stage {
        STAGE_ANSWER | STAGE_REVIEW | STAGE_FINAL_ANSWER | STAGE_FINAL_REVIEW => {
            active_slot(game_id, m)
        }
        _ => 0xff,
    };
    let difficulty_counts = if m.stage == STAGE_VOTE {
        active_difficulty_counts_in(game_id, players)
    } else {
        [0; 3]
    };
    let submit_count = match m.stage {
        STAGE_VOTE => difficulty_counts.iter().sum(),
        STAGE_FINAL_WAGER => active_final_wager_count_in(game_id, players),
        _ => active_submission_count_in(game_id, question_key, players),
    };
    PhaseView {
        stage: m.stage,
        cursor: m.cursor,
        deadline: logic::stage_deadline(&clock, &cfg_of(m)),
        current_block: now,
        final_difficulty: m.final_difficulty,
        final_slot: m.final_slot,
        viable_final_difficulties: m.viable_final_difficulties,
        slot,
        submit_count,
        continue_count: active_continue_count_in(game_id, question_key, players),
        final_wager_count: if m.stage == STAGE_FINAL_WAGER {
            active_final_wager_count_in(game_id, players)
        } else {
            0
        },
        easy_vote_count: difficulty_counts[0],
        medium_vote_count: difficulty_counts[1],
        hard_vote_count: difficulty_counts[2],
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
    let (difficulty_choices, difficulty_vote_locked) = difficulty_choices_from(game_id, players);
    let (final_wagers, final_wager_locked) = final_wagers_from(game_id, m, players);
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
        final_slot: phase.final_slot,
        viable_final_difficulties: phase.viable_final_difficulties,
        slot: phase.slot,
        submit_count: phase.submit_count,
        continue_count: phase.continue_count,
        final_wager_count: phase.final_wager_count,
        easy_vote_count: phase.easy_vote_count,
        medium_vote_count: phase.medium_vote_count,
        hard_vote_count: phase.hard_vote_count,
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
        difficulty_choices,
        difficulty_vote_locked,
        final_wagers,
        final_wager_locked,
        submissions: submission_views_from(game_id, question_key, players),
    }
}

/// Early collapse: everyone has acted, advance one stage right now.
fn collapse(game_id: u64, m: &mut GameMeta) {
    advance_timed_stage(game_id, m, current_block());
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
        STAGE_FINAL_WAGER => active_final_wager_count(game_id),
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
fn active_slot(game_id: u64, m: &GameMeta) -> u8 {
    match m.stage {
        STAGE_ANSWER | STAGE_REVIEW => match Storage::regular_slots().get(&(game_id, m.cursor)) {
            Some(slot) => slot,
            None => fail("QuestionSlotMissing"),
        },
        STAGE_FINAL_ANSWER | STAGE_FINAL_REVIEW => {
            if m.final_difficulty == DIFFICULTY_UNSET || m.final_slot == FINAL_SLOT_UNSET {
                fail("FinalQuestionUnresolved");
            }
            m.final_slot
        }
        _ => fail("NoActiveQuestion"),
    }
}

/// Validate, normalize, and score-match a plaintext answer for the currently
/// active question. The game intentionally keeps this public and casual; the
/// bounds simply keep a malformed payload from consuming unbounded storage.
fn evaluate_answer(game_id: u64, m: &GameMeta, answer: &str) -> (String, bool) {
    if answer.len() > MAX_ANSWER_BYTES {
        fail("AnswerTooLong");
    }
    let normalized = logic::normalize(answer);
    if normalized.len() > MAX_ANSWER_BYTES {
        fail("AnswerTooLong");
    }
    let accepted = registry_answers(m.pack_id, active_slot(game_id, m));
    let correct = !normalized.is_empty() && logic::answer_matches(&normalized, &accepted);
    (normalized, correct)
}

// ── Contract ─────────────────────────────────────────────────────────

#[pvm::contract]
mod quizzler {
    // NOTE: no glob import — #[pvm::contract] injects its own String/Vec
    // imports into the module, which a `use super::*` would collide with.
    use super::{
        DIFFICULTY_UNSET, FINAL_SLOT_UNSET, GameMeta, GameView, LiveGameView, MAX_GAME_QUESTIONS,
        MAX_PACK_QUESTIONS, MAX_PLAYERS, MAX_STAGE_BLOCKS, PhaseView, STAGE_ABANDONED,
        STAGE_ANSWER, STAGE_FINAL_ANSWER, STAGE_FINAL_REVIEW, STAGE_FINAL_WAGER, STAGE_LOBBY,
        STAGE_REVIEW, STAGE_VOTE, Storage, Submission, SubmissionView, active_continue_count,
        active_difficulty_total, active_final_wager_count, active_submission_count,
        apply_overturn_if_quorum, build_question_plan, clock_of, collapse,
        collapse_if_everyone_ready, current_block, difficulty_bit, emit_game_created,
        evaluate_answer, fail, game_view_from, gen_game_code, is_active_player, is_roster_player,
        live_game_view_from, load_game, load_players, logic, main_caller, phase_view_from,
        player_for_caller, player_names_from, pvm, reconcile_overturns_after_forfeit,
        registry_pack_status, require_active_player, save_game, settle, settle_at,
        submission_views_from, validated_question_slots,
    };
    use alloc::string::String;
    use alloc::vec::Vec;

    #[pvm::constructor]
    pub fn new(registry: pvm::Address, session_registry: pvm::Address) -> Result<(), Error> {
        Storage::registry().set(&registry.to_fixed_bytes());
        Storage::session_registry().set(&session_registry.to_fixed_bytes());
        Storage::game_count().set(&0);
        Ok(())
    }

    /// The pack registry this game reads content from.
    #[pvm::method]
    pub fn registry() -> pvm::Address {
        pvm::Address::from(Storage::registry().get().unwrap_or([0u8; 20]))
    }

    /// The narrow session-key registry used for silent in-game actions.
    #[pvm::method]
    pub fn session_registry() -> pvm::Address {
        pvm::Address::from(Storage::session_registry().get().unwrap_or([0u8; 20]))
    }

    /// Set the optional social label shown next to this account in every
    /// lobby, review, and scorecard. Sending an empty string clears it;
    /// clients then fall back to a deterministic friendly identity.
    #[pvm::method]
    pub fn set_display_name(name: String) {
        let who = main_caller();
        if name.is_empty() {
            Storage::display_names().remove(&who);
            return;
        }
        if !logic::valid_player_name(&name) {
            fail("BadDisplayName");
        }
        Storage::display_names().insert(&who, &name);
    }

    /// The optional global social label for an account. This lets a returning
    /// player hydrate their Home profile before they join a lobby. An empty
    /// result means no custom label has been saved.
    #[pvm::method]
    pub fn get_display_name(who: pvm::Address) -> String {
        Storage::display_names()
            .get(&who.to_fixed_bytes())
            .unwrap_or_default()
    }

    fn create_game_record(
        pack_id: u32,
        num_questions: u8,
        answer_blocks: u32,
        review_blocks: u32,
        max_players: u8,
        creation_nonce: u64,
    ) {
        // Pack-independent bounds first: they are pure and must not cost a
        // cross-contract registry read before rejecting bad input.
        if answer_blocks < 2 || answer_blocks > MAX_STAGE_BLOCKS {
            fail("BadAnswerBlocks");
        }
        if review_blocks < 2 || review_blocks > MAX_STAGE_BLOCKS {
            fail("BadReviewBlocks");
        }
        if max_players == 0 || max_players > MAX_PLAYERS {
            fail("BadMaxPlayers");
        }
        if num_questions == 0 || num_questions > MAX_GAME_QUESTIONS {
            fail("BadQuestionCount");
        }
        let pack = registry_pack_status(pack_id);
        if !pack.exists || !pack.sealed {
            fail("PackNotSealed");
        }
        // Reserve one distinct unused question for the final. A pack with
        // exactly `num_questions` questions is therefore not a valid game of
        // that length; the client can offer only safe lengths from its count.
        if pack.question_count > MAX_PACK_QUESTIONS || num_questions >= pack.question_count {
            fail("BadQuestionCount");
        }

        let creator = main_caller();
        if Storage::created_game_of().contains(&(creator, creation_nonce)) {
            fail("CreationNonceUsed");
        }
        let seq = Storage::game_count().get().unwrap_or(0);
        let next_seq = match seq.checked_add(1) {
            Some(next) => next,
            None => fail("GameIdExhausted"),
        };
        let id = gen_game_code(&creator, seq);
        let creation_block = current_block();
        let slots_by_difficulty = validated_question_slots(pack_id, &pack);
        let plan = build_question_plan(
            &creator,
            id,
            seq,
            creation_nonce,
            creation_block,
            pack_id,
            num_questions,
            slots_by_difficulty,
        );
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
            final_slot: FINAL_SLOT_UNSET,
            viable_final_difficulties: plan.viable_final_difficulties,
        };
        save_game(id, &meta);
        for (cursor, slot) in plan.regular_slots.into_iter().enumerate() {
            Storage::regular_slots().insert(&(id, cursor as u8), &slot);
        }
        for difficulty in 0..3u8 {
            if plan.viable_final_difficulties & (1u8 << difficulty) != 0 {
                Storage::final_slots()
                    .insert(&(id, difficulty), &plan.final_slots[difficulty as usize]);
            }
        }
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
        let who = main_caller();
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
        let who = main_caller();
        let mut players = load_players(game_id);
        let Some(index) = players.iter().position(|player| *player == who) else {
            fail("NotAPlayer");
        };
        players.remove(index);
        // A later rejoin is a fresh lobby arrival, even if a future contract
        // version wrote this flag before the lobby began.
        Storage::forfeited().remove(&(game_id, who));
        // The roster is authoritative; a departed seat's zero score entry
        // would otherwise be permanent orphaned storage.
        Storage::scores().remove(&(game_id, who));
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
        if starter != main_caller() {
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
        if meta.stage != STAGE_ANSWER {
            fail("NotAcceptingAnswers");
        }
        let who = player_for_caller();
        let active_count = require_active_player(game_id, &who);
        let qkey = logic::question_key(&clock_of(&meta));

        if Storage::submissions().contains(&(game_id, qkey, who)) {
            fail("AlreadyAnswered");
        }

        if wager == 0 || wager > u32::from(meta.num_questions) {
            fail("BadWager");
        }
        // Each regular wager value is usable exactly once. The game accepts
        // 1..=num_questions, rather than a global set unrelated to the pack.
        let mask = Storage::used_wagers().get(&(game_id, who)).unwrap_or(0);
        let bit = 1u32 << wager;
        if mask & bit != 0 {
            fail("WagerAlreadyUsed");
        }
        Storage::used_wagers().insert(&(game_id, who), &(mask | bit));

        let score = Storage::scores().get(&(game_id, who)).unwrap_or(0);
        let (answer, correct) = evaluate_answer(game_id, &meta, &answer);

        if correct {
            Storage::scores().insert(&(game_id, who), &(score.saturating_add(wager)));
        }

        Storage::submissions().insert(
            &(game_id, qkey, who),
            &Submission {
                answer,
                wager,
                correct,
            },
        );
        if active_submission_count(game_id, qkey) >= active_count {
            collapse(game_id, &mut meta);
        }
        save_game(game_id, &meta);
    }

    /// Lock the wager for the final question before its text is revealed.
    /// Zero is a valid no-risk choice; a missing selection becomes that same
    /// zero when the timer closes.
    #[pvm::method]
    pub fn submit_final_wager(game_id: u64, wager: u32) {
        let mut meta = load_game(game_id);
        settle(game_id, &mut meta);
        if meta.stage != STAGE_FINAL_WAGER {
            fail("NotInFinalWager");
        }
        let who = player_for_caller();
        let active_count = require_active_player(game_id, &who);
        if Storage::final_wagers().contains(&(game_id, who)) {
            fail("FinalWagerLocked");
        }
        let score = Storage::scores().get(&(game_id, who)).unwrap_or(0);
        if wager > score {
            fail("WagerExceedsScore");
        }
        Storage::final_wagers().insert(&(game_id, who), &wager);
        if active_final_wager_count(game_id) >= active_count {
            collapse(game_id, &mut meta);
        }
        save_game(game_id, &meta);
    }

    /// Submit the final answer using the wager already locked in the prior
    /// stage. A player who did not choose in time uses the durable zero
    /// default, so this call never asks them to recreate a past choice.
    #[pvm::method]
    pub fn submit_final_answer(game_id: u64, answer: String) {
        let mut meta = load_game(game_id);
        settle(game_id, &mut meta);
        if meta.stage != STAGE_FINAL_ANSWER {
            fail("NotAcceptingFinalAnswer");
        }
        let who = player_for_caller();
        let active_count = require_active_player(game_id, &who);
        let qkey = logic::question_key(&clock_of(&meta));
        if Storage::submissions().contains(&(game_id, qkey, who)) {
            fail("AlreadyAnswered");
        }

        let wager = Storage::final_wagers().get(&(game_id, who)).unwrap_or(0);
        let score = Storage::scores().get(&(game_id, who)).unwrap_or(0);
        // A selected wager was checked against this score in the prior phase.
        // Keep the guard for storage-level safety if an invariant ever changes.
        if wager > score {
            fail("WagerExceedsScore");
        }
        let (answer, correct) = evaluate_answer(game_id, &meta, &answer);
        if correct {
            Storage::scores().insert(&(game_id, who), &(score.saturating_add(wager)));
        } else {
            // Guarded by the check above; saturate anyway — this build sets
            // overflow-checks = false, and a silent wrap here would corrupt
            // the scorecard rather than trap.
            Storage::scores().insert(&(game_id, who), &(score.saturating_sub(wager)));
        }

        Storage::submissions().insert(
            &(game_id, qkey, who),
            &Submission {
                answer,
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
        let voter = player_for_caller();
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
        let who = player_for_caller();
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

    /// Vote for one of the final question difficulties this pack can actually
    /// honor (0 easy, 1 medium, 2 hard). Majority wins, ties break harder;
    /// no votes prefer medium when it is a viable choice. Single-choice packs
    /// skip this stage and enter final wagering directly.
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
        if meta.viable_final_difficulties & difficulty_bit(difficulty) == 0 {
            fail("DifficultyUnavailable");
        }
        let who = player_for_caller();
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
            STAGE_ANSWER | STAGE_REVIEW | STAGE_VOTE | STAGE_FINAL_WAGER | STAGE_FINAL_ANSWER
            | STAGE_FINAL_REVIEW => {}
            STAGE_LOBBY => fail("UseLeaveLobby"),
            _ => fail("GameNotActive"),
        }
        let who = main_caller();
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
    /// no name has been set and clients should render their friendly fallback.
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
