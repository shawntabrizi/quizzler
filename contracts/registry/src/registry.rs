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

/// Static-size view for the game contract's cross-contract validation.
#[derive(pvm::SolAbi)]
struct PackStatus {
    exists: bool,
    sealed: bool,
    regular_count: u8,
}

#[pvm::storage]
struct Storage {
    pack_count: u32,
    pack_meta: pvm::storage::Mapping<u32, PackMeta>,
    // (pack, slot) — regular slots 0.., finals at final_slot(d)
    questions: pvm::storage::Mapping<(u32, u8), Question>,
    // (pack, slot, i) — normalized accepted answers
    accepted: pvm::storage::Mapping<(u32, u8, u8), String>,
    latest_pack_of: pvm::storage::Mapping<[u8; 20], u32>,
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
        MAX_ANSWER_BYTES, MAX_ANSWERS, MAX_REGULAR_QUESTIONS, MAX_TEXT_BYTES, MAX_TITLE_BYTES,
        PackMeta, PackStatus, PackView, Question, Storage, caller20, fail, final_slot, logic, pvm,
    };
    use alloc::string::String;
    use alloc::vec::Vec;

    #[pvm::constructor]
    pub fn new() -> Result<(), Error> {
        Storage::pack_count().set(&0);
        Ok(())
    }

    /// Create a pack with immutable, creator-selected display artwork.
    ///
    /// `emoji` is intentionally stored as raw UTF-8 rather than an artwork
    /// enum. That keeps pack identity portable between clients and supports
    /// multi-codepoint emoji such as flags and skin-tone/ZWJ sequences.
    #[pvm::method]
    pub fn create_pack(title: String, emoji: String) {
        if title.is_empty() || title.len() > MAX_TITLE_BYTES {
            fail("BadTitle");
        }
        if !logic::valid_pack_emoji(&emoji) {
            fail("BadEmoji");
        }
        let creator = caller20();
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
        Storage::latest_pack_of().insert(&creator, &id);
        Storage::pack_count().set(&(id + 1));
    }

    #[pvm::method]
    pub fn add_question(
        pack_id: u32,
        text: String,
        answers: Vec<String>,
        is_final: bool,
        difficulty: u8,
    ) {
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
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
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
            if meta.regular_count >= MAX_REGULAR_QUESTIONS {
                fail("PackFull");
            }
            let s = meta.regular_count;
            meta.regular_count += 1;
            s
        };

        let mut count: u8 = 0;
        for raw in &answers {
            let norm = logic::normalize(raw);
            if norm.is_empty() || norm.len() > MAX_ANSWER_BYTES {
                fail("BadAnswer");
            }
            Storage::accepted().insert(&(pack_id, slot, count), &norm);
            count += 1;
        }
        Storage::questions().insert(
            &(pack_id, slot),
            &Question {
                text,
                answer_count: count,
            },
        );
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
    }

    #[pvm::method]
    pub fn pack_count() -> u32 {
        Storage::pack_count().get().unwrap_or(0)
    }

    #[pvm::method]
    pub fn get_pack(pack_id: u32) -> PackView {
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
            if let Some(a) = Storage::accepted().get(&(pack_id, slot, i)) {
                out.push(a);
            }
        }
        out
    }

    /// Newest pack created by `who` (u32::MAX when none) — ids are assigned
    /// at execution time, so clients resolve their own creations here.
    #[pvm::method]
    pub fn my_latest_pack(who: pvm::Address) -> u32 {
        Storage::latest_pack_of()
            .get(&who.to_fixed_bytes())
            .unwrap_or(u32::MAX)
    }
}
