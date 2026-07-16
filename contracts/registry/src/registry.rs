//! Quizzler pack registry — quiz content lives in its own contract so the
//! game contract can be redeployed freely without re-uploading packs.
//!
//! Packs hold up to 200 questions in ordinary sequential slots. Every
//! question declares its difficulty (easy, medium, or hard), including the
//! question that a game later reserves for its final round. Accepted answers
//! are stored normalized and are public: the game contract reads them
//! cross-contract for matching, and clients read them at review time.

#![no_main]
#![no_std]

// `extern crate alloc` and `use alloc::vec::Vec` are emitted at file scope
// by the #[pvm::contract] macro expansion — declaring them here collides.
use alloc::string::String;

use pvm::{Decode, Encode, HostFn};
use pvm_contract as pvm;
use quizzler_logic as logic;

const MAX_TITLE_BYTES: usize = 64;
const MAX_TEXT_BYTES: usize = 256;
const MAX_ANSWER_BYTES: usize = 64;
const MAX_ANSWERS: usize = 5;
/// A bounded authoring chunk keeps a large imported pack resumable without
/// asking the chain to decode or write all 200 questions in one call.
const MAX_QUESTIONS_PER_BATCH: usize = 8;
/// Catalog clients can replace many individual `get_pack` calls with a small
/// number of bounded read calls.
const MAX_PACKS_PER_VIEW_BATCH: usize = 32;
/// The catalog renders a small rail at a time. Keeping this bounded makes a
/// direct chain read predictable even when community packs become numerous.
const MAX_SEALED_PACKS_PER_VIEW_PAGE: usize = 24;
/// `get_sealed_packs` uses this cursor to request the newest page. Zero is
/// reserved for the terminal cursor returned after the oldest page.
const SEALED_PACK_CURSOR_LATEST: u32 = u32::MAX;
/// Questions occupy sequential u8 slots 0..200, sized for the starter
/// packs while leaving the sentinel values used by the game contract free.
const MAX_PACK_QUESTIONS: u8 = 200;

#[derive(Encode, Decode, Clone)]
struct PackMeta {
    creator: [u8; 20],
    title: String,
    /// Immutable display artwork selected when the pack is created. The
    /// contract deliberately stores the original UTF-8 string rather than a
    /// client-specific emoji ID, so every client can render the same artwork.
    emoji: String,
    question_count: u8,
    /// Counts for difficulty 0 (easy), 1 (medium), and 2 (hard). Keeping
    /// this alongside the per-difficulty slot index makes a game able to
    /// plan a balanced, non-repeating round without scanning all questions.
    difficulty_counts: [u8; 3],
    sealed: bool,
}

#[derive(Encode, Decode, Clone)]
struct Question {
    text: String,
    answer_count: u8,
    difficulty: u8,
}

#[derive(pvm::SolAbi)]
struct PackView {
    creator: pvm::Address,
    title: String,
    emoji: String,
    question_count: u8,
    easy_count: u8,
    medium_count: u8,
    hard_count: u8,
    sealed: bool,
}

/// A sealed pack together with its immutable id. This separate page view lets
/// a browser render a bounded catalog rail in one read.
#[derive(pvm::SolAbi)]
struct SealedPackView {
    pack_id: u32,
    creator: pvm::Address,
    title: String,
    emoji: String,
    question_count: u8,
    easy_count: u8,
    medium_count: u8,
    hard_count: u8,
    sealed: bool,
}

/// Newest-first sealed-pack page. `next_cursor == 0` means there are no older
/// sealed packs. The first request uses `u32::MAX` as `cursor`.
#[derive(pvm::SolAbi)]
struct SealedPackPage {
    packs: alloc::vec::Vec<SealedPackView>,
    next_cursor: u32,
}

/// Static-size view for the game contract's cross-contract validation.
#[derive(pvm::SolAbi)]
struct PackStatus {
    exists: bool,
    sealed: bool,
    question_count: u8,
    easy_count: u8,
    medium_count: u8,
    hard_count: u8,
}

/// One imported question. `add_questions` accepts a small array of these so a
/// pack publisher can checkpoint progress after each transaction.
#[derive(pvm::SolAbi)]
struct QuestionInput {
    text: String,
    answers: alloc::vec::Vec<String>,
    /// 0 = easy, 1 = medium, 2 = hard. Every question must declare one;
    /// games reserve normal unused questions for their final round.
    difficulty: u8,
}

#[pvm::storage]
struct Storage {
    pack_count: u32,
    pack_meta: pvm::storage::Mapping<u32, PackMeta>,
    // (pack, slot) — every question occupies one ordinary sequential slot.
    questions: pvm::storage::Mapping<(u32, u8), Question>,
    // (pack, slot, i) — normalized accepted answers
    accepted: pvm::storage::Mapping<(u32, u8, u8), String>,
    // (pack, difficulty, index) → ordinary question slot. This is a compact
    // on-chain index, not a centralized service: the game reads the three
    // bounded lists once when it creates a deterministic question plan.
    question_slot_by_difficulty: pvm::storage::Mapping<(u32, u8, u8), u8>,
    // (creator, client-selected nonce) → pack id. The nonce makes a creation
    // durable and unambiguous when one account publishes from multiple tabs.
    created_pack_of: pvm::storage::Mapping<([u8; 20], u64), u32>,
    /// Append-only sequence of pack ids in the order they were sealed. A
    /// separate sequence is essential: creation ids include incomplete
    /// drafts, while catalog pages must contain playable packs only. These are
    /// deliberately appended so all pre-existing storage slots remain stable.
    sealed_pack_count: u32,
    sealed_pack_at: pvm::storage::Mapping<u32, u32>,
}

fn fail(msg: &str) -> ! {
    pvm::api::return_value(pvm::ReturnFlags::REVERT, msg.as_bytes())
}

fn caller20() -> [u8; 20] {
    let mut a = [0u8; 20];
    pvm::api::caller(&mut a);
    a
}

#[pvm::contract]
mod registry {
    use super::{
        MAX_ANSWER_BYTES, MAX_ANSWERS, MAX_PACK_QUESTIONS, MAX_PACKS_PER_VIEW_BATCH,
        MAX_QUESTIONS_PER_BATCH, MAX_SEALED_PACKS_PER_VIEW_PAGE, MAX_TEXT_BYTES, MAX_TITLE_BYTES,
        PackMeta, PackStatus, PackView, Question, QuestionInput, SEALED_PACK_CURSOR_LATEST,
        SealedPackPage, SealedPackView, Storage, caller20, fail, logic, pvm,
    };
    use alloc::string::String;
    use alloc::vec::Vec;

    fn valid_display_text(text: &str, max_bytes: usize) -> bool {
        !text.trim().is_empty() && text.len() <= max_bytes && !text.chars().any(char::is_control)
    }

    fn indexed_address(address: [u8; 20]) -> [u8; 32] {
        let mut topic = [0u8; 32];
        topic[12..].copy_from_slice(&address);
        topic
    }

    fn indexed_u32(value: u32) -> [u8; 32] {
        let mut topic = [0u8; 32];
        topic[28..].copy_from_slice(&value.to_be_bytes());
        topic
    }

    /// Raw EVM-compatible event emission is available in the locked contract
    /// SDK. Its older ABI generator cannot yet describe events, so keep this
    /// static two-topic event deliberately simple for indexers.
    fn emit_pack_created(creator: [u8; 20], pack_id: u32) {
        let mut signature = [0u8; 32];
        pvm::api::hash_keccak_256(b"PackCreated(address,uint32)", &mut signature);
        let topics = [signature, indexed_address(creator), indexed_u32(pack_id)];
        pvm::api::deposit_event(&topics, &[]);
    }

    fn editable_pack(pack_id: u32) -> PackMeta {
        let meta = match Storage::pack_meta().get(&pack_id) {
            Some(m) => m,
            None => fail("NoSuchPack"),
        };
        if meta.creator != caller20() {
            fail("NotPackCreator");
        }
        if meta.sealed {
            fail("PackSealed");
        }
        meta
    }

    fn add_question_to_pack(
        pack_id: u32,
        meta: &mut PackMeta,
        text: String,
        answers: Vec<String>,
        difficulty: u8,
    ) {
        if !valid_display_text(&text, MAX_TEXT_BYTES) {
            fail("BadQuestionText");
        }
        if answers.is_empty() || answers.len() > MAX_ANSWERS {
            fail("BadAnswerCount");
        }

        if difficulty > 2 {
            fail("BadDifficulty");
        }
        if meta.question_count >= MAX_PACK_QUESTIONS {
            fail("PackFull");
        }
        let slot = meta.question_count;
        let difficulty_index = meta.difficulty_counts[difficulty as usize];
        meta.question_count += 1;
        meta.difficulty_counts[difficulty as usize] = match difficulty_index.checked_add(1) {
            Some(next) => next,
            None => fail("DifficultyCountOverflow"),
        };

        // Validate and normalize the full answer set before storing any of
        // it. Duplicate normalized answers waste permanent storage and make
        // imported source look more expressive than it actually is.
        let mut normalized = Vec::with_capacity(answers.len());
        for raw in answers {
            // Bound the raw input before normalization. Otherwise a large
            // punctuation-only string could force a disproportionate
            // allocation while normalizing to an empty answer.
            if raw.len() > MAX_ANSWER_BYTES {
                fail("BadAnswer");
            }
            let answer = logic::normalize(&raw);
            if answer.is_empty() || answer.len() > MAX_ANSWER_BYTES {
                fail("BadAnswer");
            }
            if normalized.iter().any(|existing| existing == &answer) {
                fail("DuplicateAnswer");
            }
            normalized.push(answer);
        }

        for (index, answer) in normalized.iter().enumerate() {
            Storage::accepted().insert(&(pack_id, slot, index as u8), answer);
        }
        Storage::questions().insert(
            &(pack_id, slot),
            &Question {
                text,
                answer_count: normalized.len() as u8,
                difficulty,
            },
        );
        Storage::question_slot_by_difficulty()
            .insert(&(pack_id, difficulty, difficulty_index), &slot);
    }

    fn pack_view(pack_id: u32) -> PackView {
        let m = match Storage::pack_meta().get(&pack_id) {
            Some(m) => m,
            None => fail("NoSuchPack"),
        };
        PackView {
            creator: pvm::Address::from(m.creator),
            title: m.title,
            emoji: m.emoji,
            question_count: m.question_count,
            easy_count: m.difficulty_counts[0],
            medium_count: m.difficulty_counts[1],
            hard_count: m.difficulty_counts[2],
            sealed: m.sealed,
        }
    }

    fn sealed_pack_view(pack_id: u32) -> SealedPackView {
        let m = match Storage::pack_meta().get(&pack_id) {
            Some(m) => m,
            // Every `sealed_pack_at` entry is written only after the pack is
            // present. A loud failure makes a broken storage invariant visible
            // instead of silently dropping a catalog card.
            None => fail("SealedIndexCorrupt"),
        };
        if !m.sealed {
            fail("SealedIndexCorrupt");
        }
        SealedPackView {
            pack_id,
            creator: pvm::Address::from(m.creator),
            title: m.title,
            emoji: m.emoji,
            question_count: m.question_count,
            easy_count: m.difficulty_counts[0],
            medium_count: m.difficulty_counts[1],
            hard_count: m.difficulty_counts[2],
            sealed: true,
        }
    }

    fn create_pack_record(title: String, emoji: String, creation_nonce: u64) {
        if !valid_display_text(&title, MAX_TITLE_BYTES) {
            fail("BadTitle");
        }
        if !logic::valid_pack_emoji(&emoji) {
            fail("BadEmoji");
        }
        let creator = caller20();
        if Storage::created_pack_of().contains(&(creator, creation_nonce)) {
            fail("CreationNonceUsed");
        }
        let id = Storage::pack_count().get().unwrap_or(0);
        Storage::pack_meta().insert(
            &id,
            &PackMeta {
                creator,
                title,
                emoji,
                question_count: 0,
                difficulty_counts: [0; 3],
                sealed: false,
            },
        );
        Storage::created_pack_of().insert(&(creator, creation_nonce), &id);
        let next_id = match id.checked_add(1) {
            Some(next) => next,
            None => fail("PackIdExhausted"),
        };
        Storage::pack_count().set(&next_id);
        emit_pack_created(creator, id);
    }

    #[pvm::constructor]
    pub fn new() -> Result<(), Error> {
        Storage::pack_count().set(&0);
        Storage::sealed_pack_count().set(&0);
        Ok(())
    }

    /// Create a pack with a caller-chosen nonce, then resolve its assigned id
    /// through `get_pack_for_creation`. `emoji` is stored as raw UTF-8 so
    /// every client can render the same artwork, including multi-codepoint
    /// emoji such as flags and skin-tone/ZWJ sequences.
    #[pvm::method]
    pub fn create_pack_with_nonce(title: String, emoji: String, creation_nonce: u64) {
        create_pack_record(title, emoji, creation_nonce);
    }

    /// Append a small, atomic import chunk. A publisher can safely resume a
    /// long pack after any network failure by reading `get_pack.question_count`
    /// and sending the next chunk; no partly-written question can escape a
    /// reverted transaction.
    #[pvm::method]
    pub fn add_questions(pack_id: u32, questions: Vec<QuestionInput>) {
        if questions.is_empty() || questions.len() > MAX_QUESTIONS_PER_BATCH {
            fail("BadBatchSize");
        }
        let mut meta = editable_pack(pack_id);
        for question in questions {
            add_question_to_pack(
                pack_id,
                &mut meta,
                question.text,
                question.answers,
                question.difficulty,
            );
        }
        Storage::pack_meta().insert(&pack_id, &meta);
    }

    #[pvm::method]
    pub fn seal_pack(pack_id: u32) {
        let mut meta = match Storage::pack_meta().get(&pack_id) {
            Some(m) => m,
            None => fail("NoSuchPack"),
        };
        if meta.creator != caller20() {
            fail("NotPackCreator");
        }
        if meta.sealed {
            fail("PackSealed");
        }
        // A playable game needs at least one ordinary question and a
        // distinct unused candidate for the final round. Difficulty may be
        // sparse (an all-easy pack is valid); the game contract exposes only
        // the final choices for which it successfully reserves a candidate.
        if meta.question_count < 2 {
            fail("NotEnoughQuestions");
        }
        meta.sealed = true;
        Storage::pack_meta().insert(&pack_id, &meta);

        // Store the catalog sequence only after all validity checks succeed.
        // A pack can be sealed once, so it can enter this append-only list once.
        let sequence = Storage::sealed_pack_count().get().unwrap_or(0);
        Storage::sealed_pack_at().insert(&sequence, &pack_id);
        let next_sequence = match sequence.checked_add(1) {
            Some(next) => next,
            None => fail("SealedPackIndexExhausted"),
        };
        Storage::sealed_pack_count().set(&next_sequence);
    }

    #[pvm::method]
    pub fn pack_count() -> u32 {
        Storage::pack_count().get().unwrap_or(0)
    }

    /// Number of playable packs in the append-only sealed catalog. Unlike
    /// `pack_count`, this excludes unfinished author drafts.
    #[pvm::method]
    pub fn sealed_pack_count() -> u32 {
        Storage::sealed_pack_count().get().unwrap_or(0)
    }

    #[pvm::method]
    pub fn get_pack(pack_id: u32) -> PackView {
        pack_view(pack_id)
    }

    /// Bounded catalog read for the pack browser. The caller chooses ids so
    /// it can page newest-first without one RPC round trip per card.
    #[pvm::method]
    pub fn get_packs(pack_ids: Vec<u32>) -> Vec<PackView> {
        if pack_ids.len() > MAX_PACKS_PER_VIEW_BATCH {
            fail("ViewBatchTooLarge");
        }
        pack_ids.into_iter().map(pack_view).collect()
    }

    /// Bounded newest-first page of sealed packs for a serverless catalog.
    ///
    /// Pass `u32::MAX` for the first (newest) page. For a later page, pass the
    /// preceding response's `next_cursor`. A returned `next_cursor` of zero
    /// means the caller has reached the oldest sealed pack. `limit` must be
    /// between one and 24, so an untrusted client cannot force an unbounded
    /// contract read or ABI response.
    #[pvm::method]
    pub fn get_sealed_packs(cursor: u32, limit: u8) -> SealedPackPage {
        let limit = limit as usize;
        if limit == 0 || limit > MAX_SEALED_PACKS_PER_VIEW_PAGE {
            fail("BadViewLimit");
        }

        let sealed_count = Storage::sealed_pack_count().get().unwrap_or(0);
        let mut upper_exclusive = if cursor == SEALED_PACK_CURSOR_LATEST {
            sealed_count
        } else {
            // A cursor is an append-only sequence boundary, not a pack id.
            // Reject an invented future boundary rather than treating it as a
            // partial page, which makes malformed client state obvious.
            if cursor > sealed_count {
                fail("BadSealedPackCursor");
            }
            cursor
        };

        let mut packs = Vec::with_capacity(core::cmp::min(limit, upper_exclusive as usize));
        while upper_exclusive > 0 && packs.len() < limit {
            upper_exclusive -= 1;
            let pack_id = match Storage::sealed_pack_at().get(&upper_exclusive) {
                Some(pack_id) => pack_id,
                None => fail("SealedIndexCorrupt"),
            };
            packs.push(sealed_pack_view(pack_id));
        }

        SealedPackPage {
            packs,
            next_cursor: upper_exclusive,
        }
    }

    /// Fixed-size status for cross-contract validation by the game contract.
    #[pvm::method]
    pub fn get_pack_status(pack_id: u32) -> PackStatus {
        match Storage::pack_meta().get(&pack_id) {
            Some(m) => PackStatus {
                exists: true,
                sealed: m.sealed,
                question_count: m.question_count,
                easy_count: m.difficulty_counts[0],
                medium_count: m.difficulty_counts[1],
                hard_count: m.difficulty_counts[2],
            },
            None => PackStatus {
                exists: false,
                sealed: false,
                question_count: 0,
                easy_count: 0,
                medium_count: 0,
                hard_count: 0,
            },
        }
    }

    /// Question text by its ordinary pack slot.
    #[pvm::method]
    pub fn get_question(pack_id: u32, slot: u8) -> String {
        match Storage::questions().get(&(pack_id, slot)) {
            Some(q) => q.text,
            None => fail("NoSuchQuestion"),
        }
    }

    /// Difficulty for one ordinary question slot: 0 easy, 1 medium, 2 hard.
    /// This is mainly useful for direct pack inspection; the game itself uses
    /// the bounded per-difficulty slot index when it creates a plan.
    #[pvm::method]
    pub fn get_question_difficulty(pack_id: u32, slot: u8) -> u8 {
        match Storage::questions().get(&(pack_id, slot)) {
            Some(q) => q.difficulty,
            None => fail("NoSuchQuestion"),
        }
    }

    /// Normalized accepted answers for a slot. Read cross-contract by the
    /// game for matching, and by clients at review time (first entry is the
    /// canonical display answer).
    #[pvm::method]
    pub fn get_answers(pack_id: u32, slot: u8) -> Vec<String> {
        let q = match Storage::questions().get(&(pack_id, slot)) {
            Some(q) => q,
            None => fail("NoSuchQuestion"),
        };
        let mut out = Vec::with_capacity(q.answer_count as usize);
        for i in 0..q.answer_count {
            match Storage::accepted().get(&(pack_id, slot, i)) {
                Some(a) => out.push(a),
                // The answer_count/accepted invariant broke. Failing loud is
                // strictly better than the game silently scoring against a
                // shorter answer set.
                None => fail("AnswerMissing"),
            }
        }
        out
    }

    /// All ordinary slots for one difficulty (0 easy, 1 medium, 2 hard), in
    /// immutable authoring order. The list is bounded by the pack's 200
    /// question ceiling and lets the game reserve final candidates and plan
    /// its regular-round distribution without a centralized indexer.
    #[pvm::method]
    pub fn get_question_slots_for_difficulty(pack_id: u32, difficulty: u8) -> Vec<u8> {
        if difficulty > 2 {
            fail("BadDifficulty");
        }
        let meta = match Storage::pack_meta().get(&pack_id) {
            Some(meta) => meta,
            None => fail("NoSuchPack"),
        };
        let count = meta.difficulty_counts[difficulty as usize];
        let mut slots = Vec::with_capacity(count as usize);
        for index in 0..count {
            match Storage::question_slot_by_difficulty().get(&(pack_id, difficulty, index)) {
                Some(slot) => slots.push(slot),
                None => fail("DifficultyIndexCorrupt"),
            }
        }
        slots
    }

    /// Resolve a pack created with `create_pack_with_nonce`; `u32::MAX` means
    /// the creator/nonce pair has not been used.
    #[pvm::method]
    pub fn get_pack_for_creation(who: pvm::Address, creation_nonce: u64) -> u32 {
        Storage::created_pack_of()
            .get(&(who.to_fixed_bytes(), creation_nonce))
            .unwrap_or(u32::MAX)
    }
}
