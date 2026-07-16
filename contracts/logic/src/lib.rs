//! Pure game logic for the Quizzler contract: answer normalization and
//! matching, and the block-timer phase state machine. No storage, no host
//! calls — everything here is unit-testable on the host target.
//!
//! The client mirrors `normalize` in `app/src/normalize.ts`; both are pinned
//! by the shared vectors in `shared/answer-test-vectors.json`.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

/// Maximum UTF-8 byte length for a pack's creator-selected emoji artwork.
/// This accommodates common ZWJ, skin-tone, and flag sequences while keeping
/// display metadata's on-chain storage bounded.
pub const MAX_PACK_EMOJI_BYTES: usize = 32;

/// Maximum UTF-8 byte length for a player-selected display name. Names are
/// intentionally small: they travel with every live game snapshot and are a
/// convenience label, not user-generated profile content.
pub const MAX_PLAYER_NAME_BYTES: usize = 24;

/// Validate the bounded artwork metadata the registry stores for each pack.
///
/// Full Unicode emoji classification would require a large, fast-moving
/// Unicode table in the contract. The client supplies an emoji picker; the
/// chain enforces the durable invariant needed by every valid modern sequence:
/// a non-empty, bounded UTF-8 string.
pub fn valid_pack_emoji(emoji: &str) -> bool {
    !emoji.trim().is_empty()
        && emoji.len() <= MAX_PACK_EMOJI_BYTES
        && !emoji.chars().any(char::is_control)
}

/// Validate an optional player display name before it is kept in the global
/// account-to-name mapping. Empty is handled by the game contract as an
/// explicit request to clear a name; this helper validates stored values.
///
/// Requiring an already-trimmed value prevents a name that visually appears
/// blank or indistinguishable from another name in compact party UI. Control
/// characters are rejected so names are safe to place in one-line lobby and
/// results rows without surprising layout or assistive technology.
pub fn valid_player_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_PLAYER_NAME_BYTES
        && name == name.trim()
        && !name.chars().any(char::is_control)
}

// ── Stages ───────────────────────────────────────────────────────────
//
// A game moves through stages paced purely by block number:
//   Lobby → [Answer → Review] × num_questions → [Vote when there is a real
//   choice] → FinalWager → FinalAnswer → FinalReview → Finished
//
// An explicit lobby departure can also reach Abandoned (empty lobby), as can
// the last active participant forfeiting a running quiz.
// Early collapse (everyone submitted / voted / continued) is applied by the
// contract by resetting `anchor` and advancing the stage; `roll` only applies
// timeout transitions.

pub const STAGE_LOBBY: u8 = 0;
pub const STAGE_ANSWER: u8 = 1;
pub const STAGE_REVIEW: u8 = 2;
pub const STAGE_VOTE: u8 = 3;
/// Players lock their final wager before the final question is revealed.
pub const STAGE_FINAL_WAGER: u8 = 4;
pub const STAGE_FINAL_ANSWER: u8 = 5;
pub const STAGE_FINAL_REVIEW: u8 = 6;
pub const STAGE_FINISHED: u8 = 7;
/// Everyone explicitly left before the quiz could finish. Unlike Finished,
/// this is not a scored result, but it is equally terminal and untimed.
pub const STAGE_ABANDONED: u8 = 8;

/// Question-slot key used for the final question in per-question storage maps
/// (regular questions use their index 0..num_questions).
pub const FINAL_QUESTION_KEY: u8 = 0xff;

/// Difficulty sentinel meaning "not resolved yet".
pub const DIFFICULTY_UNSET: u8 = 0xff;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct GameClock {
    pub stage: u8,
    pub cursor: u8,
    /// Block at which the current stage started. A stage covers blocks
    /// `[anchor, anchor + duration)` — the boundary block belongs to the
    /// next stage.
    pub anchor: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct PhaseConfig {
    pub num_questions: u8,
    pub answer_blocks: u64,
    pub review_blocks: u64,
}

/// Duration of a stage in blocks. `None` for stages that do not expire
/// (the lobby waits for its current starter; terminal stages do not roll).
pub fn stage_duration(stage: u8, cfg: &PhaseConfig) -> Option<u64> {
    match stage {
        STAGE_ANSWER | STAGE_FINAL_WAGER | STAGE_FINAL_ANSWER => Some(cfg.answer_blocks),
        STAGE_REVIEW | STAGE_VOTE | STAGE_FINAL_REVIEW => Some(cfg.review_blocks),
        _ => None,
    }
}

/// The stage/cursor that follows `(stage, cursor)`, whether by timeout or by
/// early collapse.
pub fn next_stage(stage: u8, cursor: u8, num_questions: u8) -> (u8, u8) {
    match stage {
        STAGE_ANSWER => (STAGE_REVIEW, cursor),
        STAGE_REVIEW => {
            if cursor + 1 < num_questions {
                (STAGE_ANSWER, cursor + 1)
            } else {
                (STAGE_VOTE, cursor)
            }
        }
        STAGE_VOTE => (STAGE_FINAL_WAGER, cursor),
        STAGE_FINAL_WAGER => (STAGE_FINAL_ANSWER, cursor),
        STAGE_FINAL_ANSWER => (STAGE_FINAL_REVIEW, cursor),
        STAGE_FINAL_REVIEW => (STAGE_FINISHED, cursor),
        other => (other, cursor),
    }
}

/// Apply timeout transitions: roll the clock forward to the stage that
/// contains block `now`. Returns the settled clock and whether the roll
/// crossed the end of the Vote stage (the caller must then resolve the
/// final-question difficulty from the votes cast so far).
pub fn roll(clock: GameClock, cfg: &PhaseConfig, now: u64) -> (GameClock, bool) {
    let mut c = clock;
    let mut crossed_vote = false;
    loop {
        let Some(dur) = stage_duration(c.stage, cfg) else {
            return (c, crossed_vote);
        };
        let end = c.anchor.saturating_add(dur);
        if now < end {
            return (c, crossed_vote);
        }
        if c.stage == STAGE_VOTE {
            crossed_vote = true;
        }
        let (stage, cursor) = next_stage(c.stage, c.cursor, cfg.num_questions);
        c = GameClock {
            stage,
            cursor,
            anchor: end,
        };
    }
}

/// First block that is no longer part of the current stage.
/// `u64::MAX` for stages without a timer.
pub fn stage_deadline(clock: &GameClock, cfg: &PhaseConfig) -> u64 {
    match stage_duration(clock.stage, cfg) {
        Some(dur) => clock.anchor.saturating_add(dur),
        None => u64::MAX,
    }
}

/// Storage key slot for the question being played at this clock.
pub fn question_key(clock: &GameClock) -> u8 {
    match clock.stage {
        STAGE_ANSWER | STAGE_REVIEW => clock.cursor,
        _ => FINAL_QUESTION_KEY,
    }
}

// ── Answer normalization & matching ──────────────────────────────────

/// Canonical answer form: ASCII-lowercase, alphanumerics and single spaces
/// only, trimmed. Everything else (punctuation, non-ASCII) is dropped —
/// the client is responsible for folding diacritics to ASCII first.
pub fn normalize(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(c.to_ascii_lowercase());
        } else if c.is_whitespace() {
            pending_space = true;
        }
        // anything else: dropped, does not break a word
    }
    out
}

pub fn is_numeric(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

pub fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<u8> = a.bytes().collect();
    let b: Vec<u8> = b.bytes().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];
    for (i, &ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            curr[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(curr[j] + 1);
        }
        core::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

/// Fuzzy tolerance for an accepted answer: none for numbers or short
/// answers, otherwise ~1 typo per 6 characters (at least 1).
pub fn fuzz_allowance(accepted: &str) -> usize {
    if accepted.len() < 5 || is_numeric(accepted) {
        return 0;
    }
    (accepted.len() / 6).max(1)
}

/// `submitted` must already be normalized; `accepted` entries are stored
/// normalized. Numbers must match exactly.
pub fn answer_matches(submitted: &str, accepted: &[String]) -> bool {
    accepted.iter().any(|acc| {
        if submitted == acc {
            return true;
        }
        if is_numeric(submitted) {
            return false;
        }
        let allowance = fuzz_allowance(acc);
        allowance > 0 && levenshtein(submitted, acc) <= allowance
    })
}

// ── Voting ───────────────────────────────────────────────────────────

/// Votes needed to overturn a wrong answer: a majority of the *other*
/// players. With fewer than 3 players there is no jury (threshold 1 with
/// 2 players means the single opponent decides — which is the fun outcome).
pub fn overturn_threshold(player_count: u32) -> u32 {
    majority_threshold(player_count.saturating_sub(1))
}

/// Strict majority needed from a known set of eligible voters.
///
/// The regular overturn helper removes the answer's owner first. A player
/// who has forfeited is no longer eligible, however, so historical answers
/// can have every active player as an eligible voter. Keep that case explicit
/// rather than smuggling it through a misleading total-player count.
pub fn majority_threshold(eligible_voters: u32) -> u32 {
    eligible_voters / 2 + 1
}

/// Whether the already-cast votes are enough to overturn an answer.
///
/// Keeping this comparison alongside the quorum calculation makes it safe for
/// callers to re-check a pending vote when the eligible set changes (for
/// example, when somebody leaves a review by forfeiting).
pub fn overturn_passes(votes: u32, eligible_voters: u32) -> bool {
    votes >= majority_threshold(eligible_voters)
}

/// Majority difficulty, ties broken toward harder; no votes at all → medium.
pub fn resolve_difficulty(counts: [u32; 3]) -> u8 {
    if counts.iter().all(|&c| c == 0) {
        return 1;
    }
    let mut best: u8 = 0;
    for d in 1..3u8 {
        if counts[d as usize] >= counts[best as usize] {
            best = d;
        }
    }
    best
}

// ── Question planning ───────────────────────────────────────────────

/// A deterministic game-local selection of ordinary pack slots. The final
/// candidate for each tier is deliberately chosen from slots left unused by
/// the regular round, so no question can appear twice in a game.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionSlotPlan {
    pub regular_slots: Vec<u8>,
    pub final_slots: [Option<u8>; 3],
    /// Bit 0 = easy, bit 1 = medium, bit 2 = hard. A bit is set only when a
    /// distinct unused candidate of that difficulty remains after planning
    /// the regular round.
    pub viable_final_difficulties: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuestionPlanError {
    /// A final question must be distinct from the requested regular round.
    NotEnoughQuestionsForFinal,
    /// The advertised candidate sets cannot satisfy the requested plan.
    Impossible,
    /// The caller-supplied deterministic selector returned an out-of-range
    /// index. Treat this as an invariant failure rather than risking a trap.
    InvalidRandomIndex,
}

/// Fixed regular-round target: 40% easy, 40% medium, 20% hard. This gives
/// the supported game lengths the intended mixes 5 = 2/2/1, 10 = 4/4/2,
/// 15 = 6/6/3, and 20 = 8/8/4.
fn desired_question_difficulty_counts(num_questions: u8) -> [u8; 3] {
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
        // A missing middle tier favors easier questions over harder ones.
        1 => [0, 2, 1],
        // A missing hard target falls back to medium before easy.
        2 => [1, 0, 2],
        _ => unreachable!("difficulty is always in 0..3"),
    }
}

fn planned_question_difficulty_counts(
    capacity: [u8; 3],
    num_questions: u8,
) -> Result<[u8; 3], QuestionPlanError> {
    let desired = desired_question_difficulty_counts(num_questions);
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
                return Err(QuestionPlanError::Impossible);
            }
        }
    }

    // The three per-tier counters are u8 because a pack has at most 255
    // questions, but their aggregate can exceed u8 in host-side callers.
    // Keep this invariant check wide so it reports an impossible plan rather
    // than overflowing in a debug build.
    if planned.iter().map(|count| u16::from(*count)).sum::<u16>() != u16::from(num_questions) {
        return Err(QuestionPlanError::Impossible);
    }
    Ok(planned)
}

fn pick_slot<F>(slots: &mut Vec<u8>, choose_index: &mut F) -> Result<u8, QuestionPlanError>
where
    F: FnMut(usize) -> usize,
{
    if slots.is_empty() {
        return Err(QuestionPlanError::Impossible);
    }
    let index = choose_index(slots.len());
    if index >= slots.len() {
        return Err(QuestionPlanError::InvalidRandomIndex);
    }
    Ok(slots.swap_remove(index))
}

fn planned_question_difficulty_sequence<F>(
    mut remaining: [u8; 3],
    choose_index: &mut F,
) -> Result<Vec<u8>, QuestionPlanError>
where
    F: FnMut(usize) -> usize,
{
    let total: usize = remaining.iter().map(|count| usize::from(*count)).sum();
    let mut sequence = Vec::with_capacity(total);
    if total == 0 {
        return Ok(sequence);
    }

    // This is the intentional warm-up rule: use the easiest available
    // regular tier first, rather than putting a lone Easy question aside for
    // a possible final-round option.
    for difficulty in 0..3 {
        if remaining[difficulty] > 0 {
            sequence.push(difficulty as u8);
            remaining[difficulty] -= 1;
            break;
        }
    }

    while sequence.len() < total {
        let previous = *sequence.last().unwrap_or(&u8::MAX);
        let before_previous = if sequence.len() >= 2 {
            sequence[sequence.len() - 2]
        } else {
            u8::MAX
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
        if eligible_total == 0 {
            return Err(QuestionPlanError::Impossible);
        }
        let mut choice = choose_index(eligible_total);
        if choice >= eligible_total {
            return Err(QuestionPlanError::InvalidRandomIndex);
        }
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
        let difficulty = selected.ok_or(QuestionPlanError::Impossible)?;
        sequence.push(difficulty as u8);
        remaining[difficulty] -= 1;
    }
    Ok(sequence)
}

/// Plan the regular round from per-difficulty ordinary pack slots, then
/// reserve one final candidate for every difficulty that has a remaining
/// unused slot. `choose_index` is supplied by the caller: the contract uses
/// a deterministic hash stream, while tests use a fixed selector.
pub fn plan_question_slots<F>(
    mut slots_by_difficulty: [Vec<u8>; 3],
    num_questions: u8,
    mut choose_index: F,
) -> Result<QuestionSlotPlan, QuestionPlanError>
where
    F: FnMut(usize) -> usize,
{
    let total_candidates: usize = slots_by_difficulty.iter().map(|slots| slots.len()).sum();
    if total_candidates <= num_questions as usize {
        return Err(QuestionPlanError::NotEnoughQuestionsForFinal);
    }

    let capacity = [
        slots_by_difficulty[0].len() as u8,
        slots_by_difficulty[1].len() as u8,
        slots_by_difficulty[2].len() as u8,
    ];
    let planned = planned_question_difficulty_counts(capacity, num_questions)?;
    let sequence = planned_question_difficulty_sequence(planned, &mut choose_index)?;
    let mut regular_slots = Vec::with_capacity(num_questions as usize);
    for difficulty in sequence {
        regular_slots.push(pick_slot(
            &mut slots_by_difficulty[difficulty as usize],
            &mut choose_index,
        )?);
    }
    if regular_slots.len() != num_questions as usize {
        return Err(QuestionPlanError::Impossible);
    }

    let mut final_slots = [None; 3];
    let mut viable_final_difficulties = 0u8;
    for difficulty in 0..3 {
        if slots_by_difficulty[difficulty].is_empty() {
            continue;
        }
        final_slots[difficulty] = Some(pick_slot(
            &mut slots_by_difficulty[difficulty],
            &mut choose_index,
        )?);
        viable_final_difficulties |= 1u8 << difficulty;
    }
    if viable_final_difficulties == 0 {
        return Err(QuestionPlanError::NotEnoughQuestionsForFinal);
    }

    Ok(QuestionSlotPlan {
        regular_slots,
        final_slots,
        viable_final_difficulties,
    })
}

#[cfg(test)]
mod tests;
