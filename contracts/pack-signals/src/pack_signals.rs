//! Quizzler's fully on-chain pack discovery signals.
//!
//! The immutable pack registry owns content. This contract owns the social
//! relationship between product accounts and sealed packs: a player can save
//! or remove a pack, retrieve their own saved list, and read the exact
//! all-time Popular ranking without a backend or indexer.
//!
//! Popularity is maintained as score buckets instead of sorting every pack on
//! every read. A favorite changes one pack's score by exactly one, so that
//! pack moves only between neighbouring score buckets. Each bucket has a
//! doubly linked list of pack nodes; non-empty buckets are themselves linked
//! from highest score to lowest score. `get_popular` walks those links until
//! it has the requested bounded page, never scanning the entire catalog.
//!
//! As with the game contract, a currently live quick-action session resolves
//! to its main/product account through SessionRegistry. Therefore favorites
//! follow the player rather than a short-lived local session key.

#![cfg_attr(not(test), no_main)]
#![no_std]

// `#[pvm::contract]` emits these imports for the deployed target. The host
// ranking tests intentionally exclude the generated ABI dispatcher, so they
// provide their own standard-library test harness and alloc crate instead.
#[cfg(test)]
extern crate alloc;
#[cfg(test)]
extern crate std;

#[cfg(not(test))]
use pvm::HostFn;
use pvm::{Decode, Encode};
use pvm_contract as pvm;

type AccountId = [u8; 20];

#[cfg(not(test))]
const ZERO_ACCOUNT: AccountId = [0u8; 20];
/// A pack card view is deliberately bounded, matching the registry's own
/// catalog batch bound. It keeps direct chain reads predictable on mobile.
#[cfg(not(test))]
const MAX_SIGNAL_VIEW_BATCH: usize = 32;
/// The personal saved-pack rail and its full-screen view page in small chunks.
const MAX_FAVORITES_PAGE: u32 = 32;
/// The picker renders at most 24 popular cards initially. Tracking is not
/// capped: every saved pack participates in the ranking, only each read is.
#[cfg(not(test))]
const MAX_POPULAR_PAGE: u32 = 24;

/// The registry's fixed-size status view. Keeping this mirror small makes the
/// write-time validation fail loudly if this Signals deployment is linked to
/// an incompatible or codeless registry address.
#[cfg(not(test))]
#[derive(pvm::SolAbi)]
struct PackStatus {
    exists: bool,
    sealed: bool,
    regular_count: u8,
}

/// One saved-pack page for a player. `cursor` and `next_cursor` are a pack
/// node key (`pack_id + 1`), which lets the contract retain newest-first order
/// and remove any saved pack in constant work. Zero starts at the newest pack
/// and also means the end after the final page.
#[derive(pvm::SolAbi)]
struct FavoritePage {
    pack_ids: alloc::vec::Vec<u32>,
    next_cursor: u64,
    total: u32,
}

/// Per-card signal state, designed for one bounded catalog card batch.
#[cfg(not(test))]
#[derive(pvm::SolAbi)]
struct PackSignalView {
    pack_id: u32,
    favorite_count: u32,
    favorited: bool,
}

/// A ranked Popular entry. Equal-count entries are a genuine tie; their order
/// follows the contract's deterministic bucket-list order and clients may
/// apply a pack-id tie-breaker for presentation.
#[derive(pvm::SolAbi)]
struct PopularPackView {
    pack_id: u32,
    favorite_count: u32,
}

/// Cursor page for a full Popular browser. The small home rail can call
/// `get_popular(24)`, while a future "See all" view can traverse every ranked
/// pack without an indexer. A zero `(next_score, next_cursor)` pair is the
/// terminal cursor; changing popularity between pages invalidates a cursor,
/// so clients should simply restart from zero.
#[derive(pvm::SolAbi)]
struct PopularPage {
    packs: alloc::vec::Vec<PopularPackView>,
    next_score: u32,
    next_cursor: u64,
    total: u32,
}

/// A pack node in its current score bucket. Links use `pack_id + 1`, leaving
/// zero as an unambiguous null sentinel even for pack ID zero.
#[derive(Encode, Decode, Clone)]
struct RankNode {
    score: u32,
    prev: u64,
    next: u64,
}

/// A player's newest-first saved-pack list. Links use the same `pack_id + 1`
/// node representation as ranking nodes, so zero remains the null cursor.
#[derive(Encode, Decode, Clone)]
struct FavoriteLink {
    prev: u64,
    next: u64,
}

/// A non-empty favorite-count bucket. `higher` and `lower` are adjacent
/// *non-empty* scores, not necessarily arithmetic neighbours. That means an
/// unfavorite of the last pack at a very high score stays constant-work rather
/// than looping down through a large empty score range.
#[derive(Encode, Decode, Clone)]
struct ScoreBucket {
    higher: u32,
    lower: u32,
    head: u64,
    tail: u64,
}

#[pvm::storage]
struct Storage {
    /// Immutable quiz content registry whose sealed-pack status is checked
    /// before a new favorite is accepted.
    registry: AccountId,
    /// SessionRegistry resolving a direct caller or a live session key to the
    /// durable player identity that owns favorites.
    session_registry: AccountId,

    /// owner → number of saved packs.
    favorite_count_of: pvm::storage::Mapping<AccountId, u32>,
    /// owner → newest saved pack node key, or zero.
    favorite_head: pvm::storage::Mapping<AccountId, u64>,
    /// owner → oldest saved pack node key, or zero. Keeping both ends makes
    /// arbitrary removal constant-work without sacrificing newest-first reads.
    favorite_tail: pvm::storage::Mapping<AccountId, u64>,
    /// (owner, pack) → list links. Its presence is the authoritative
    /// saved/not-saved state.
    favorite_link: pvm::storage::Mapping<(AccountId, u32), FavoriteLink>,

    /// Current unique-account favorite count for every pack with at least one
    /// saved relationship. A missing mapping is exactly zero.
    pack_favorite_count: pvm::storage::Mapping<u32, u32>,

    /// Every positive-score pack has exactly one node in exactly one bucket.
    rank_node: pvm::storage::Mapping<u32, RankNode>,
    /// Non-empty buckets only, linked from the highest to lowest score.
    score_bucket: pvm::storage::Mapping<u32, ScoreBucket>,
    highest_score: u32,
    lowest_score: u32,
    /// Number of packs with a positive favorite count; useful to decide
    /// whether the Popular section should render without fetching a page.
    ranked_pack_count: u32,
}

#[cfg(not(test))]
fn fail(message: &str) -> ! {
    pvm::api::return_value(pvm::ReturnFlags::REVERT, message.as_bytes())
}

#[cfg(test)]
fn fail(message: &str) -> ! {
    panic!("contract revert: {message}")
}

#[cfg(not(test))]
fn caller20() -> AccountId {
    let mut account = ZERO_ACCOUNT;
    pvm::api::caller(&mut account);
    account
}

#[cfg(not(test))]
fn abi_word_u32(value: u32) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[28..].copy_from_slice(&value.to_be_bytes());
    word
}

#[cfg(not(test))]
fn abi_word_address(address: AccountId) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(&address);
    word
}

/// Read-only EVM ABI call following the same convention as Quizzler's game
/// contract. Calls to a codeless/mislinked address return empty bytes in EVM;
/// reject those explicitly rather than letting ABI decoding trap ambiguously.
#[cfg(not(test))]
fn contract_view_call<T: pvm::SolAbi>(
    target: AccountId,
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
    for word in words {
        calldata.extend_from_slice(word);
    }

    let mut output_buf = alloc::vec![0u8; out_cap];
    let mut output_ref: &mut [u8] = &mut output_buf[..];
    let result = pvm::api::call_evm(
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
            if written < 32 || written == out_cap {
                fail(error);
            }
            T::abi_decode(&output_buf[..written], 0)
        }
        Err(_) => fail(error),
    }
}

#[cfg(not(test))]
fn registry_call<T: pvm::SolAbi>(
    name: &str,
    types: &[&str],
    words: &[[u8; 32]],
    out_cap: usize,
) -> T {
    contract_view_call(
        Storage::registry().get().unwrap_or(ZERO_ACCOUNT),
        name,
        types,
        words,
        out_cap,
        "RegistryCallFailed",
    )
}

#[cfg(not(test))]
fn session_registry_call<T: pvm::SolAbi>(
    name: &str,
    types: &[&str],
    words: &[[u8; 32]],
    out_cap: usize,
) -> T {
    contract_view_call(
        Storage::session_registry().get().unwrap_or(ZERO_ACCOUNT),
        name,
        types,
        words,
        out_cap,
        "SessionRegistryCallFailed",
    )
}

#[cfg(not(test))]
fn registry_pack_status(pack_id: u32) -> PackStatus {
    // PackStatus is three static ABI words. The extra headroom makes a reply
    // that fills the buffer reliably identify an incompatible oversized ABI.
    registry_call("getPackStatus", &["uint32"], &[abi_word_u32(pack_id)], 128)
}

/// Resolve a direct product-account caller or a live session key to the
/// durable identity that owns social state. Expired/revoked session keys
/// resolve to zero and are deliberately rejected instead of becoming a new
/// identity in this contract.
#[cfg(not(test))]
fn resolved_caller() -> AccountId {
    let caller = caller20();
    let resolved: pvm::Address =
        session_registry_call("resolve", &["address"], &[abi_word_address(caller)], 64);
    let owner = resolved.to_fixed_bytes();
    if owner == ZERO_ACCOUNT {
        fail("InactiveSession");
    }
    owner
}

fn pack_node_key(pack_id: u32) -> u64 {
    u64::from(pack_id) + 1
}

fn pack_id_from_node(node: u64) -> u32 {
    if node == 0 {
        fail("RankingInvariantBroken");
    }
    // `node` is created only by pack_node_key, so this conversion cannot
    // truncate. Keep the check implicit in the precise storage invariant.
    (node - 1) as u32
}

fn load_bucket(score: u32) -> ScoreBucket {
    match Storage::score_bucket().get(&score) {
        Some(bucket) => bucket,
        None => fail("RankingInvariantBroken"),
    }
}

fn load_node(pack_id: u32) -> RankNode {
    match Storage::rank_node().get(&pack_id) {
        Some(node) => node,
        None => fail("RankingInvariantBroken"),
    }
}

/// Create the first and only score bucket.
fn insert_first_bucket(score: u32) {
    if score == 0 || Storage::score_bucket().contains(&score) {
        fail("RankingInvariantBroken");
    }
    if Storage::highest_score().get().unwrap_or(0) != 0
        || Storage::lowest_score().get().unwrap_or(0) != 0
    {
        fail("RankingInvariantBroken");
    }
    Storage::score_bucket().insert(
        &score,
        &ScoreBucket {
            higher: 0,
            lower: 0,
            head: 0,
            tail: 0,
        },
    );
    Storage::highest_score().set(&score);
    Storage::lowest_score().set(&score);
}

/// Insert a new empty bucket immediately above `lower_score`. Scores are
/// arithmetic neighbours when this is called, but linked neighbours are what
/// matters for avoiding scans through absent scores.
fn insert_bucket_above(score: u32, lower_score: u32) {
    if score == 0 || Storage::score_bucket().contains(&score) {
        fail("RankingInvariantBroken");
    }
    let mut lower = load_bucket(lower_score);
    let higher_score = lower.higher;
    Storage::score_bucket().insert(
        &score,
        &ScoreBucket {
            higher: higher_score,
            lower: lower_score,
            head: 0,
            tail: 0,
        },
    );
    lower.higher = score;
    Storage::score_bucket().insert(&lower_score, &lower);
    if higher_score == 0 {
        Storage::highest_score().set(&score);
    } else {
        let mut higher = load_bucket(higher_score);
        higher.lower = score;
        Storage::score_bucket().insert(&higher_score, &higher);
    }
}

/// Insert a new empty bucket immediately below `higher_score`.
fn insert_bucket_below(score: u32, higher_score: u32) {
    if score == 0 || Storage::score_bucket().contains(&score) {
        fail("RankingInvariantBroken");
    }
    let mut higher = load_bucket(higher_score);
    let lower_score = higher.lower;
    Storage::score_bucket().insert(
        &score,
        &ScoreBucket {
            higher: higher_score,
            lower: lower_score,
            head: 0,
            tail: 0,
        },
    );
    higher.lower = score;
    Storage::score_bucket().insert(&higher_score, &higher);
    if lower_score == 0 {
        Storage::lowest_score().set(&score);
    } else {
        let mut lower = load_bucket(lower_score);
        lower.higher = score;
        Storage::score_bucket().insert(&lower_score, &lower);
    }
}

/// Add score one beneath the current lowest non-empty score, or initialize
/// the ranking if this is the first positive favorite anywhere.
fn ensure_score_one_bucket() {
    if Storage::score_bucket().contains(&1) {
        return;
    }
    let lowest = Storage::lowest_score().get().unwrap_or(0);
    if lowest == 0 {
        insert_first_bucket(1);
    } else {
        insert_bucket_below(1, lowest);
    }
}

/// Remove an empty score bucket and splice adjacent non-empty buckets.
fn remove_empty_bucket(score: u32) {
    let bucket = load_bucket(score);
    if bucket.head != 0 || bucket.tail != 0 {
        fail("RankingInvariantBroken");
    }
    if bucket.higher == 0 {
        Storage::highest_score().set(&bucket.lower);
    } else {
        let mut higher = load_bucket(bucket.higher);
        higher.lower = bucket.lower;
        Storage::score_bucket().insert(&bucket.higher, &higher);
    }
    if bucket.lower == 0 {
        Storage::lowest_score().set(&bucket.higher);
    } else {
        let mut lower = load_bucket(bucket.lower);
        lower.higher = bucket.higher;
        Storage::score_bucket().insert(&bucket.lower, &lower);
    }
    Storage::score_bucket().remove(&score);
}

/// Append `pack_id` to a non-empty score's node list. Appending preserves a
/// deterministic contract order among equal-count ties without requiring an
/// O(bucket-size) sorted insertion on every favorite action.
fn add_rank_node(pack_id: u32, score: u32) {
    if Storage::rank_node().contains(&pack_id) {
        fail("RankingInvariantBroken");
    }
    let mut bucket = load_bucket(score);
    let node_key = pack_node_key(pack_id);
    let previous_tail = bucket.tail;
    Storage::rank_node().insert(
        &pack_id,
        &RankNode {
            score,
            prev: previous_tail,
            next: 0,
        },
    );
    if previous_tail == 0 {
        if bucket.head != 0 {
            fail("RankingInvariantBroken");
        }
        bucket.head = node_key;
    } else {
        let previous_pack = pack_id_from_node(previous_tail);
        let mut previous = load_node(previous_pack);
        if previous.score != score || previous.next != 0 {
            fail("RankingInvariantBroken");
        }
        previous.next = node_key;
        Storage::rank_node().insert(&previous_pack, &previous);
    }
    bucket.tail = node_key;
    Storage::score_bucket().insert(&score, &bucket);
}

/// Remove one pack node from its current score bucket. If it was the last
/// member, cleanly remove the now-empty score bucket in constant work.
fn remove_rank_node(pack_id: u32, score: u32) {
    let node = load_node(pack_id);
    if node.score != score {
        fail("RankingInvariantBroken");
    }
    let mut bucket = load_bucket(score);
    let node_key = pack_node_key(pack_id);
    if node.prev == 0 {
        if bucket.head != node_key {
            fail("RankingInvariantBroken");
        }
        bucket.head = node.next;
    } else {
        let previous_pack = pack_id_from_node(node.prev);
        let mut previous = load_node(previous_pack);
        if previous.score != score || previous.next != node_key {
            fail("RankingInvariantBroken");
        }
        previous.next = node.next;
        Storage::rank_node().insert(&previous_pack, &previous);
    }
    if node.next == 0 {
        if bucket.tail != node_key {
            fail("RankingInvariantBroken");
        }
        bucket.tail = node.prev;
    } else {
        let next_pack = pack_id_from_node(node.next);
        let mut next = load_node(next_pack);
        if next.score != score || next.prev != node_key {
            fail("RankingInvariantBroken");
        }
        next.prev = node.prev;
        Storage::rank_node().insert(&next_pack, &next);
    }
    Storage::rank_node().remove(&pack_id);
    let empty = bucket.head == 0;
    if empty != (bucket.tail == 0) {
        fail("RankingInvariantBroken");
    }
    Storage::score_bucket().insert(&score, &bucket);
    if empty {
        remove_empty_bucket(score);
    }
}

fn increase_pack_score(pack_id: u32) {
    let old_score = Storage::pack_favorite_count().get(&pack_id).unwrap_or(0);
    let new_score = match old_score.checked_add(1) {
        Some(score) => score,
        None => fail("FavoriteCountExhausted"),
    };

    if old_score == 0 {
        ensure_score_one_bucket();
        add_rank_node(pack_id, new_score);
        let old_ranked = Storage::ranked_pack_count().get().unwrap_or(0);
        let next_ranked = match old_ranked.checked_add(1) {
            Some(count) => count,
            None => fail("RankedPackCountExhausted"),
        };
        Storage::ranked_pack_count().set(&next_ranked);
    } else {
        // Before removing the old node, insert the adjacent new-score bucket
        // if needed. This preserves the score-list links even if the old
        // bucket becomes empty as part of the move.
        if !Storage::score_bucket().contains(&new_score) {
            insert_bucket_above(new_score, old_score);
        }
        remove_rank_node(pack_id, old_score);
        add_rank_node(pack_id, new_score);
    }
    Storage::pack_favorite_count().insert(&pack_id, &new_score);
}

fn decrease_pack_score(pack_id: u32) {
    let old_score = Storage::pack_favorite_count().get(&pack_id).unwrap_or(0);
    if old_score == 0 {
        fail("RankingInvariantBroken");
    }
    let new_score = old_score - 1;
    if new_score != 0 && !Storage::score_bucket().contains(&new_score) {
        // As above, create the destination before removal so an empty old
        // bucket can safely splice itself out afterwards.
        insert_bucket_below(new_score, old_score);
    }
    remove_rank_node(pack_id, old_score);
    if new_score == 0 {
        Storage::pack_favorite_count().remove(&pack_id);
        let old_ranked = Storage::ranked_pack_count().get().unwrap_or(0);
        let next_ranked = match old_ranked.checked_sub(1) {
            Some(count) => count,
            None => fail("RankingInvariantBroken"),
        };
        Storage::ranked_pack_count().set(&next_ranked);
    } else {
        add_rank_node(pack_id, new_score);
        Storage::pack_favorite_count().insert(&pack_id, &new_score);
    }
}

fn is_favorited(owner: AccountId, pack_id: u32) -> bool {
    Storage::favorite_link().contains(&(owner, pack_id))
}

fn add_favorite(owner: AccountId, pack_id: u32) {
    if is_favorited(owner, pack_id) {
        fail("FavoriteInvariantBroken");
    }
    let count = Storage::favorite_count_of().get(&owner).unwrap_or(0);
    let next_count = match count.checked_add(1) {
        Some(next) => next,
        None => fail("FavoriteListExhausted"),
    };
    let previous_head = Storage::favorite_head().get(&owner).unwrap_or(0);
    let node_key = pack_node_key(pack_id);
    Storage::favorite_link().insert(
        &(owner, pack_id),
        &FavoriteLink {
            prev: 0,
            next: previous_head,
        },
    );
    if previous_head == 0 {
        if Storage::favorite_tail().get(&owner).unwrap_or(0) != 0 {
            fail("FavoriteInvariantBroken");
        }
        Storage::favorite_tail().insert(&owner, &node_key);
    } else {
        let previous_pack = pack_id_from_node(previous_head);
        let mut previous = match Storage::favorite_link().get(&(owner, previous_pack)) {
            Some(link) => link,
            None => fail("FavoriteInvariantBroken"),
        };
        if previous.prev != 0 {
            fail("FavoriteInvariantBroken");
        }
        previous.prev = node_key;
        Storage::favorite_link().insert(&(owner, previous_pack), &previous);
    }
    Storage::favorite_head().insert(&owner, &node_key);
    Storage::favorite_count_of().insert(&owner, &next_count);
    increase_pack_score(pack_id);
}

fn remove_favorite(owner: AccountId, pack_id: u32) {
    let link = match Storage::favorite_link().get(&(owner, pack_id)) {
        Some(link) => link,
        _ => fail("FavoriteInvariantBroken"),
    };
    let count = Storage::favorite_count_of().get(&owner).unwrap_or(0);
    if count == 0 {
        fail("FavoriteInvariantBroken");
    }
    let node_key = pack_node_key(pack_id);
    if link.prev == 0 {
        if Storage::favorite_head().get(&owner).unwrap_or(0) != node_key {
            fail("FavoriteInvariantBroken");
        }
        Storage::favorite_head().insert(&owner, &link.next);
    } else {
        let previous_pack = pack_id_from_node(link.prev);
        let mut previous = match Storage::favorite_link().get(&(owner, previous_pack)) {
            Some(value) => value,
            None => fail("FavoriteInvariantBroken"),
        };
        if previous.next != node_key {
            fail("FavoriteInvariantBroken");
        }
        previous.next = link.next;
        Storage::favorite_link().insert(&(owner, previous_pack), &previous);
    }
    if link.next == 0 {
        if Storage::favorite_tail().get(&owner).unwrap_or(0) != node_key {
            fail("FavoriteInvariantBroken");
        }
        Storage::favorite_tail().insert(&owner, &link.prev);
    } else {
        let next_pack = pack_id_from_node(link.next);
        let mut next = match Storage::favorite_link().get(&(owner, next_pack)) {
            Some(value) => value,
            None => fail("FavoriteInvariantBroken"),
        };
        if next.prev != node_key {
            fail("FavoriteInvariantBroken");
        }
        next.prev = link.prev;
        Storage::favorite_link().insert(&(owner, next_pack), &next);
    }
    Storage::favorite_link().remove(&(owner, pack_id));
    let next_count = count - 1;
    if next_count == 0 {
        if Storage::favorite_head().get(&owner).unwrap_or(0) != 0
            || Storage::favorite_tail().get(&owner).unwrap_or(0) != 0
        {
            fail("FavoriteInvariantBroken");
        }
        Storage::favorite_count_of().remove(&owner);
    } else {
        Storage::favorite_count_of().insert(&owner, &next_count);
    }
    decrease_pack_score(pack_id);
}

/// Read a newest-first page from one player's linked saved-pack list. Keeping
/// this outside the generated ABI module lets the exact storage traversal be
/// regression-tested against pvm_contract's host storage backend.
fn favorite_page(owner: AccountId, cursor: u64, limit: u32) -> FavoritePage {
    // A zero-size page would return the same non-zero cursor forever, which
    // is an easy client-side pagination footgun. Reject it rather than make a
    // caller appear to have more pages without progress.
    if limit == 0 || limit > MAX_FAVORITES_PAGE {
        fail("FavoritePageTooLarge");
    }
    let total = Storage::favorite_count_of().get(&owner).unwrap_or(0);
    let mut node_key = if cursor == 0 {
        Storage::favorite_head().get(&owner).unwrap_or(0)
    } else {
        let cursor_pack = pack_id_from_node(cursor);
        if !Storage::favorite_link().contains(&(owner, cursor_pack)) {
            fail("FavoriteCursorOutOfRange");
        }
        cursor
    };
    let mut pack_ids = alloc::vec::Vec::with_capacity(limit as usize);
    while node_key != 0 && (pack_ids.len() as u32) < limit {
        let pack_id = pack_id_from_node(node_key);
        let link = match Storage::favorite_link().get(&(owner, pack_id)) {
            Some(link) => link,
            None => fail("FavoriteInvariantBroken"),
        };
        pack_ids.push(pack_id);
        node_key = link.next;
    }
    FavoritePage {
        pack_ids,
        next_cursor: node_key,
        total,
    }
}

/// Collect an exact bounded Popular page by walking only non-empty score
/// buckets and the nodes returned to the caller. It never scans unranked
/// packs, and it is shared with the host regression tests below.
fn popular_page(cursor_score: u32, cursor: u64, limit: u32) -> PopularPage {
    let total = Storage::ranked_pack_count().get().unwrap_or(0);
    let mut score = if cursor_score == 0 {
        if cursor != 0 {
            fail("PopularCursorOutOfRange");
        }
        Storage::highest_score().get().unwrap_or(0)
    } else {
        if cursor == 0 {
            fail("PopularCursorOutOfRange");
        }
        cursor_score
    };
    let mut node_key = if score == 0 {
        0
    } else if cursor_score == 0 {
        let bucket = load_bucket(score);
        if bucket.head == 0 || bucket.tail == 0 {
            fail("RankingInvariantBroken");
        }
        bucket.head
    } else {
        let pack_id = pack_id_from_node(cursor);
        let node = load_node(pack_id);
        if node.score != score {
            fail("PopularCursorOutOfRange");
        }
        cursor
    };

    let mut packs = alloc::vec::Vec::with_capacity(limit as usize);
    while node_key != 0 && (packs.len() as u32) < limit {
        let bucket = load_bucket(score);
        let pack_id = pack_id_from_node(node_key);
        let node = load_node(pack_id);
        if node.score != score {
            fail("RankingInvariantBroken");
        }
        let favorite_count = Storage::pack_favorite_count().get(&pack_id).unwrap_or(0);
        if favorite_count != score {
            fail("RankingInvariantBroken");
        }
        packs.push(PopularPackView {
            pack_id,
            favorite_count,
        });

        if node.next == 0 {
            score = bucket.lower;
            node_key = if score == 0 {
                0
            } else {
                let next_bucket = load_bucket(score);
                if next_bucket.head == 0 || next_bucket.tail == 0 {
                    fail("RankingInvariantBroken");
                }
                next_bucket.head
            };
        } else {
            node_key = node.next;
        }
    }
    PopularPage {
        packs,
        next_score: score,
        next_cursor: node_key,
        total,
    }
}

fn popular_entries(limit: u32) -> alloc::vec::Vec<PopularPackView> {
    popular_page(0, 0, limit).packs
}

#[cfg(not(test))]
#[pvm::contract]
mod pack_signals {
    // Avoid glob imports: the contract macro injects alloc imports into this
    // module and a glob can collide with those generated bindings.
    use super::{
        FavoritePage, MAX_POPULAR_PAGE, MAX_SIGNAL_VIEW_BATCH, PackSignalView, PopularPackView,
        PopularPage, Storage, ZERO_ACCOUNT, add_favorite, fail, favorite_page, is_favorited,
        popular_entries, popular_page, registry_pack_status, remove_favorite, resolved_caller,
    };
    use alloc::vec::Vec;
    use pvm_contract as pvm;

    #[pvm::constructor]
    pub fn new(registry: pvm::Address, session_registry: pvm::Address) -> Result<(), Error> {
        let registry = registry.to_fixed_bytes();
        let session_registry = session_registry.to_fixed_bytes();
        if registry == ZERO_ACCOUNT {
            fail("InvalidRegistry");
        }
        if session_registry == ZERO_ACCOUNT {
            fail("InvalidSessionRegistry");
        }
        Storage::registry().set(&registry);
        Storage::session_registry().set(&session_registry);
        Storage::highest_score().set(&0);
        Storage::lowest_score().set(&0);
        Storage::ranked_pack_count().set(&0);
        Ok(())
    }

    /// The immutable pack registry that this Signals deployment validates
    /// against. Clients use this linkage to reject mismatched app config.
    #[pvm::method]
    pub fn registry() -> pvm::Address {
        pvm::Address::from(Storage::registry().get().unwrap_or(ZERO_ACCOUNT))
    }

    /// The SessionRegistry that resolves silent quick-action keys back to the
    /// owning product account for `set_favorite`.
    #[pvm::method]
    pub fn session_registry() -> pvm::Address {
        pvm::Address::from(Storage::session_registry().get().unwrap_or(ZERO_ACCOUNT))
    }

    /// Idempotently save or remove a pack for the direct caller's product
    /// account. A `true` request validates that the registry pack exists and
    /// is sealed; a `false` request deliberately needs no registry call, so a
    /// player can always clean up an old favorite even if a linked registry is
    /// temporarily unavailable to RPC clients.
    #[pvm::method]
    pub fn set_favorite(pack_id: u32, saved: bool) {
        let owner = resolved_caller();
        let already_saved = is_favorited(owner, pack_id);
        if already_saved == saved {
            return;
        }
        if saved {
            let status = registry_pack_status(pack_id);
            if !status.exists {
                fail("NoSuchPack");
            }
            if !status.sealed {
                fail("PackNotSealed");
            }
            add_favorite(owner, pack_id);
        } else {
            remove_favorite(owner, pack_id);
        }
    }

    /// A bounded newest-first page of a player's saved pack IDs. `cursor` is
    /// the node key returned by the preceding call; zero starts at the newest
    /// saved pack and `next_cursor == 0` ends paging. If the saved list changes
    /// between pages, callers should restart at zero rather than reuse a
    /// removed cursor.
    #[pvm::method]
    pub fn get_favorites(account: pvm::Address, cursor: u64, limit: u32) -> FavoritePage {
        favorite_page(account.to_fixed_bytes(), cursor, limit)
    }

    /// Current favorite state and count for one bounded card batch. This is
    /// preferable to one chain read per visible pack tile.
    #[pvm::method]
    pub fn get_pack_signals(account: pvm::Address, pack_ids: Vec<u32>) -> Vec<PackSignalView> {
        if pack_ids.len() > MAX_SIGNAL_VIEW_BATCH {
            fail("SignalViewBatchTooLarge");
        }
        let owner = account.to_fixed_bytes();
        pack_ids
            .into_iter()
            .map(|pack_id| PackSignalView {
                pack_id,
                favorite_count: Storage::pack_favorite_count().get(&pack_id).unwrap_or(0),
                favorited: is_favorited(owner, pack_id),
            })
            .collect()
    }

    /// Whether `account` currently saved one pack. The batch view above is
    /// more efficient for the picker; this small view is useful to other
    /// direct-contract clients.
    #[pvm::method]
    pub fn is_favorite(account: pvm::Address, pack_id: u32) -> bool {
        is_favorited(account.to_fixed_bytes(), pack_id)
    }

    /// The current number of distinct product accounts that saved this pack.
    #[pvm::method]
    pub fn favorite_count(pack_id: u32) -> u32 {
        Storage::pack_favorite_count().get(&pack_id).unwrap_or(0)
    }

    /// Number of packs that currently have a positive favorite count. This is
    /// the direct, cheap condition for whether the Popular section should be
    /// visible; it is not a cap on the ranking.
    #[pvm::method]
    pub fn popular_pack_count() -> u32 {
        Storage::ranked_pack_count().get().unwrap_or(0)
    }

    /// Return the exact highest-ranked packs directly from on-chain score
    /// buckets. At most 24 cards may be requested in one view; all packs with
    /// a positive score remain tracked even when they are outside this page.
    #[pvm::method]
    pub fn get_popular(limit: u32) -> Vec<PopularPackView> {
        if limit > MAX_POPULAR_PAGE {
            fail("PopularPageTooLarge");
        }
        popular_entries(limit)
    }

    /// Cursor-paginated Popular ranking for a full discovery screen. The
    /// first request uses `(0, 0)` and each following request uses the
    /// returned `(next_score, next_cursor)`. Pages are bounded to the same 24
    /// cards as the home rail, while the contract keeps every ranked pack.
    #[pvm::method]
    pub fn get_popular_page(cursor_score: u32, cursor: u64, limit: u32) -> PopularPage {
        if limit == 0 || limit > MAX_POPULAR_PAGE {
            fail("PopularPageTooLarge");
        }
        popular_page(cursor_score, cursor, limit)
    }
}

/// These tests execute the exact linked-list and score-bucket helpers against
/// `pvm_contract`'s host storage shim. The ABI dispatcher and cross-contract
/// syscalls remain target-only; chain-level tests exercise those boundaries.
#[cfg(test)]
mod tests {
    use super::*;
    use pvm_contract::storage::host_storage_reset;
    use std::collections::{BTreeMap, BTreeSet};

    const ALICE: AccountId = [1u8; 20];
    const BOB: AccountId = [2u8; 20];
    const CAROL: AccountId = [3u8; 20];
    const DAVE: AccountId = [4u8; 20];

    fn reset() {
        host_storage_reset();
    }

    fn popular_pairs(limit: u32) -> alloc::vec::Vec<(u32, u32)> {
        let mut pairs: alloc::vec::Vec<_> = popular_entries(limit)
            .into_iter()
            .map(|entry| (entry.pack_id, entry.favorite_count))
            .collect();
        // Ties are intentionally unordered by the contract's O(1) mutation
        // structure, so make assertions independent of tie presentation.
        pairs.sort_unstable();
        pairs
    }

    #[test]
    fn saved_pack_pages_are_newest_first_and_removal_keeps_the_list_sound() {
        reset();
        add_favorite(ALICE, 7);
        add_favorite(ALICE, 8);
        add_favorite(ALICE, 9);

        let first = favorite_page(ALICE, 0, 2);
        assert_eq!(first.pack_ids, alloc::vec![9, 8]);
        assert_eq!(first.total, 3);
        assert_ne!(first.next_cursor, 0);

        let second = favorite_page(ALICE, first.next_cursor, 2);
        assert_eq!(second.pack_ids, alloc::vec![7]);
        assert_eq!(second.next_cursor, 0);
        assert_eq!(second.total, 3);

        // Remove the middle element: the doubly linked personal list must
        // retain its exact newest-first order without rebuilding an array.
        remove_favorite(ALICE, 8);
        let after_removal = favorite_page(ALICE, 0, 32);
        assert_eq!(after_removal.pack_ids, alloc::vec![9, 7]);
        assert_eq!(after_removal.total, 2);
        assert_eq!(after_removal.next_cursor, 0);
    }

    #[test]
    fn score_buckets_move_packs_up_and_down_without_losing_the_top_rank() {
        reset();
        add_favorite(ALICE, 11);
        add_favorite(BOB, 11);
        add_favorite(CAROL, 22);
        assert_eq!(popular_pairs(24), alloc::vec![(11, 2), (22, 1)]);
        assert_eq!(Storage::ranked_pack_count().get(), Some(2));

        // Pack 11 leaves a one-pack score-two bucket and joins the existing
        // score-one bucket. The empty score-two bucket must disappear.
        remove_favorite(BOB, 11);
        assert_eq!(popular_pairs(24), alloc::vec![(11, 1), (22, 1)]);

        // Its final unstar removes it from ranking altogether; Pack 22 stays
        // visible and remains the exact top result.
        remove_favorite(ALICE, 11);
        assert_eq!(popular_pairs(24), alloc::vec![(22, 1)]);
        assert_eq!(Storage::ranked_pack_count().get(), Some(1));

        remove_favorite(CAROL, 22);
        assert!(popular_entries(24).is_empty());
        assert_eq!(Storage::ranked_pack_count().get(), Some(0));
        assert_eq!(Storage::highest_score().get(), Some(0));
        assert_eq!(Storage::lowest_score().get(), Some(0));
    }

    #[test]
    fn sparse_score_gaps_do_not_hide_lower_ranked_packs() {
        reset();
        // Create buckets at scores three and one, then walk the first pack
        // down through the missing score-two bucket to zero.
        add_favorite(ALICE, 1);
        add_favorite(BOB, 1);
        add_favorite(CAROL, 1);
        add_favorite(DAVE, 2);
        assert_eq!(popular_pairs(24), alloc::vec![(1, 3), (2, 1)]);

        remove_favorite(CAROL, 1);
        assert_eq!(popular_pairs(24), alloc::vec![(1, 2), (2, 1)]);
        remove_favorite(BOB, 1);
        assert_eq!(popular_pairs(24), alloc::vec![(1, 1), (2, 1)]);
        remove_favorite(ALICE, 1);
        assert_eq!(popular_pairs(24), alloc::vec![(2, 1)]);
    }

    #[test]
    fn ranking_tracks_more_than_the_visible_top_twenty_four() {
        reset();
        for pack_id in 100..130 {
            add_favorite(ALICE, pack_id);
        }
        assert_eq!(Storage::ranked_pack_count().get(), Some(30));
        let first_page = popular_page(0, 0, 24);
        assert_eq!(first_page.packs.len(), 24);
        assert_eq!(first_page.total, 30);
        assert_ne!(first_page.next_score, 0);
        assert_ne!(first_page.next_cursor, 0);
        assert!(
            first_page
                .packs
                .iter()
                .all(|entry| entry.favorite_count == 1)
        );

        let second_page = popular_page(first_page.next_score, first_page.next_cursor, 24);
        assert_eq!(second_page.packs.len(), 6);
        assert_eq!(second_page.total, 30);
        assert_eq!(second_page.next_score, 0);
        assert_eq!(second_page.next_cursor, 0);
        let mut all_ids: alloc::vec::Vec<_> = first_page
            .packs
            .into_iter()
            .chain(second_page.packs)
            .map(|entry| entry.pack_id)
            .collect();
        all_ids.sort_unstable();
        assert_eq!(all_ids, (100..130).collect::<alloc::vec::Vec<_>>());

        // Removing a visible or non-visible pack updates the total exactly;
        // no storage policy silently caps tracked popularity at 24.
        remove_favorite(ALICE, 100);
        remove_favorite(ALICE, 129);
        assert_eq!(Storage::ranked_pack_count().get(), Some(28));
        assert_eq!(popular_entries(24).len(), 24);
    }

    #[test]
    fn many_save_remove_sequences_match_a_simple_reference_model() {
        reset();
        let owners = [ALICE, BOB, CAROL, DAVE];
        let packs: alloc::vec::Vec<u32> = (50..58).collect();
        let mut saved: BTreeSet<(usize, u32)> = BTreeSet::new();
        let mut expected_counts: BTreeMap<u32, u32> = BTreeMap::new();
        // A deterministic stream makes this a reproducible regression test
        // while exercising adjacent bucket creation/removal in many orders.
        let mut entropy = 0x9e37_79b9_u64;

        for _ in 0..400 {
            entropy = entropy
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let owner_index = (entropy as usize) % owners.len();
            let pack_id = packs[((entropy >> 16) as usize) % packs.len()];
            if saved.remove(&(owner_index, pack_id)) {
                remove_favorite(owners[owner_index], pack_id);
                let count = expected_counts
                    .get_mut(&pack_id)
                    .expect("reference count exists for a saved pack");
                *count -= 1;
                if *count == 0 {
                    expected_counts.remove(&pack_id);
                }
            } else {
                saved.insert((owner_index, pack_id));
                add_favorite(owners[owner_index], pack_id);
                *expected_counts.entry(pack_id).or_insert(0) += 1;
            }

            let actual = popular_entries(24);
            assert_eq!(actual.len(), expected_counts.len());
            assert!(
                actual
                    .windows(2)
                    .all(|pair| pair[0].favorite_count >= pair[1].favorite_count)
            );
            let actual_counts: BTreeMap<_, _> = actual
                .into_iter()
                .map(|entry| (entry.pack_id, entry.favorite_count))
                .collect();
            assert_eq!(actual_counts, expected_counts);
            assert_eq!(
                Storage::ranked_pack_count().get(),
                Some(expected_counts.len() as u32)
            );

            for (owner_index, owner) in owners.into_iter().enumerate() {
                let mut cursor = 0;
                let mut actual_saved = alloc::vec::Vec::new();
                loop {
                    let page = favorite_page(owner, cursor, 3);
                    actual_saved.extend(page.pack_ids);
                    if page.next_cursor == 0 {
                        break;
                    }
                    cursor = page.next_cursor;
                }
                actual_saved.sort_unstable();
                let expected_saved: alloc::vec::Vec<_> = saved
                    .iter()
                    .filter_map(|(saved_owner, pack_id)| {
                        (*saved_owner == owner_index).then_some(*pack_id)
                    })
                    .collect();
                assert_eq!(actual_saved, expected_saved);
            }
        }
    }

    #[test]
    #[should_panic(expected = "FavoritePageTooLarge")]
    fn zero_size_favorite_page_is_rejected_before_it_can_stall_pagination() {
        reset();
        let _ = favorite_page(ALICE, 0, 0);
    }
}
