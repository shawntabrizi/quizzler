//! Quizzler pack registry — quiz content lives in its own contract so the
//! game contract can be redeployed freely without re-uploading packs.
//!
//! Packs hold up to 200 regular questions (slots 0..) plus exactly one
//! final question per difficulty (slots 0xf0 + difficulty). Accepted
//! answers are stored normalized and are public: the game contract reads
//! them cross-contract for matching, and clients read them at review time.

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
// Regular questions occupy u8 slots 0..=0xef (finals live at 0xf0+),
// sized for the ~200-question starter packs.
const MAX_REGULAR_QUESTIONS: u8 = 200;

/// Storage slot for a final question of the given difficulty.
const fn final_slot(difficulty: u8) -> u8 {
    0xf0 + difficulty
}

#[derive(Encode, Decode, Clone)]
struct PackMeta {
    creator: [u8; 20],
    title: String,
    /// Immutable display artwork selected when the pack is created. The
    /// contract deliberately stores the original UTF-8 string rather than a
    /// client-specific emoji ID, so every client can render the same artwork.
    emoji: String,
    regular_count: u8,
    finals_set: [bool; 3],
    sealed: bool,
}

#[derive(Encode, Decode, Clone)]
struct Question {
    text: String,
    answer_count: u8,
}

#[derive(pvm::SolAbi)]
struct PackView {
    creator: pvm::Address,
    title: String,
    emoji: String,
    regular_count: u8,
    finals_set_count: u8,
    sealed: bool,
}

/// A sealed pack together with its immutable id. `PackView` deliberately
/// predates catalog paging and therefore has no id field; keeping this as a
/// separate view preserves the existing `get_pack` / `get_packs` ABI while
/// giving a browser everything it needs to render a page in one read.
#[derive(pvm::SolAbi)]
struct SealedPackView {
    pack_id: u32,
    creator: pvm::Address,
    title: String,
    emoji: String,
    regular_count: u8,
    finals_set_count: u8,
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
    regular_count: u8,
}

/// One imported question. `add_questions` accepts a small array of these so a
/// pack publisher can checkpoint progress after each transaction.
#[derive(pvm::SolAbi)]
struct QuestionInput {
    text: String,
    answers: alloc::vec::Vec<String>,
    is_final: bool,
    difficulty: u8,
}

#[pvm::storage]
struct Storage {
    pack_count: u32,
    pack_meta: pvm::storage::Mapping<u32, PackMeta>,
    // (pack, slot) — regular slots 0.., finals at final_slot(d)
    questions: pvm::storage::Mapping<(u32, u8), Question>,
    // (pack, slot, i) — normalized accepted answers
    accepted: pvm::storage::Mapping<(u32, u8, u8), String>,
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
        MAX_ANSWER_BYTES, MAX_ANSWERS, MAX_PACKS_PER_VIEW_BATCH, MAX_QUESTIONS_PER_BATCH,
        MAX_REGULAR_QUESTIONS, MAX_SEALED_PACKS_PER_VIEW_PAGE, MAX_TEXT_BYTES, MAX_TITLE_BYTES,
        PackMeta, PackStatus, PackView, Question, QuestionInput, SEALED_PACK_CURSOR_LATEST,
        SealedPackPage, SealedPackView, Storage, caller20, fail, final_slot, logic, pvm,
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
        is_final: bool,
        difficulty: u8,
    ) {
        if !valid_display_text(&text, MAX_TEXT_BYTES) {
            fail("BadQuestionText");
        }
        if answers.is_empty() || answers.len() > MAX_ANSWERS {
            fail("BadAnswerCount");
        }

        let slot = if is_final {
            if difficulty > 2 {
                fail("BadDifficulty");
            }
            if meta.finals_set[difficulty as usize] {
                fail("FinalAlreadySet");
            }
            meta.finals_set[difficulty as usize] = true;
            final_slot(difficulty)
        } else {
            // The field has no meaning for a regular question. Rejecting a
            // stray value catches malformed imports rather than silently
            // accepting metadata that cannot later be reconstructed.
            if difficulty != 0 {
                fail("BadDifficulty");
            }
            if meta.regular_count >= MAX_REGULAR_QUESTIONS {
                fail("PackFull");
            }
            let slot = meta.regular_count;
            meta.regular_count += 1;
            slot
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
            },
        );
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
            regular_count: m.regular_count,
            finals_set_count: m.finals_set.iter().filter(|&&s| s).count() as u8,
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
            regular_count: m.regular_count,
            finals_set_count: m.finals_set.iter().filter(|&&s| s).count() as u8,
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
                regular_count: 0,
                finals_set: [false; 3],
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
    /// long pack after any network failure by reading `get_pack.regular_count`
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
                question.is_final,
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
        if meta.regular_count == 0 {
            fail("NoQuestions");
        }
        if !meta.finals_set.iter().all(|&s| s) {
            fail("MissingFinalQuestions");
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
                regular_count: m.regular_count,
            },
            None => PackStatus {
                exists: false,
                sealed: false,
                regular_count: 0,
            },
        }
    }

    /// Question text by pack slot: regular questions at 0..regular_count,
    /// final questions at 0xf0 + difficulty.
    #[pvm::method]
    pub fn get_question(pack_id: u32, slot: u8) -> String {
        match Storage::questions().get(&(pack_id, slot)) {
            Some(q) => q.text,
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

    /// Resolve a pack created with `create_pack_with_nonce`; `u32::MAX` means
    /// the creator/nonce pair has not been used.
    #[pvm::method]
    pub fn get_pack_for_creation(who: pvm::Address, creation_nonce: u64) -> u32 {
        Storage::created_pack_of()
            .get(&(who.to_fixed_bytes(), creation_nonce))
            .unwrap_or(u32::MAX)
    }
}
