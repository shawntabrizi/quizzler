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

/// Validate the bounded artwork metadata the registry stores for each pack.
///
/// Full Unicode emoji classification would require a large, fast-moving
/// Unicode table in the contract. The client supplies an emoji picker; the
/// chain enforces the durable invariant needed by every valid modern sequence:
/// a non-empty, bounded UTF-8 string.
pub fn valid_pack_emoji(emoji: &str) -> bool {
    !emoji.trim().is_empty() && emoji.len() <= MAX_PACK_EMOJI_BYTES
}

// ── Stages ───────────────────────────────────────────────────────────
//
// A game moves through stages paced purely by block number:
//   Lobby → [Answer → Review] × num_questions → Vote → FinalAnswer →
//   FinalReview → Finished
// Early collapse (everyone submitted / voted / continued) is applied by the
// contract by resetting `anchor` and advancing the stage; `roll` only applies
// timeout transitions.

pub const STAGE_LOBBY: u8 = 0;
pub const STAGE_ANSWER: u8 = 1;
pub const STAGE_REVIEW: u8 = 2;
pub const STAGE_VOTE: u8 = 3;
pub const STAGE_FINAL_ANSWER: u8 = 4;
pub const STAGE_FINAL_REVIEW: u8 = 5;
pub const STAGE_FINISHED: u8 = 6;
/// Everyone explicitly left before the quiz could finish. Unlike Finished,
/// this is not a scored result, but it is equally terminal and untimed.
pub const STAGE_ABANDONED: u8 = 7;

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
/// (Lobby waits for the creator, Finished is terminal).
pub fn stage_duration(stage: u8, cfg: &PhaseConfig) -> Option<u64> {
    match stage {
        STAGE_ANSWER | STAGE_FINAL_ANSWER => Some(cfg.answer_blocks),
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
        STAGE_VOTE => (STAGE_FINAL_ANSWER, cursor),
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

#[cfg(test)]
mod tests;
