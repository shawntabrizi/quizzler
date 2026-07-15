//! SessionRegistry maps a short-lived session key back to the product account
//! that authorized it. Game contracts use `resolve` before they read or write
//! player state, so a silently signed session transaction acts for its owner.
//!
//! This registry deliberately has a small, fixed policy surface:
//! - one active session per owner;
//! - session-key possession is proven before a link becomes active;
//! - a key can be activated only once, ever;
//! - a session key can never manage another session; and
//! - every registration expires after seven days.
//!
//! Expired, revoked, and otherwise consumed session keys resolve to the zero
//! address. That lets consuming contracts fail closed instead of accidentally
//! treating a former session key as an independent player account.

#![no_main]
#![no_std]

use pvm_contract::{self as pvm, Address, Decode, Encode, HostFn};

type AccountId = [u8; 20];

const ZERO_ACCOUNT: AccountId = [0u8; 20];
/// Paseo's current block cadence is six seconds. This is intentionally an
/// internal policy, not caller-configurable session authority.
const SESSION_LIFETIME_BLOCKS: u64 = (7 * 24 * 60 * 60) / 6;
/// A requested key must activate promptly. Keeping the pending window short
/// limits stale state while still allowing the funded local key to send its
/// first silent transaction after the product-signed setup batch lands.
const PENDING_LIFETIME_BLOCKS: u64 = (15 * 60) / 6;

/// A link in either direction of the owner ↔ session relationship. Both
/// mappings carry the same deadline so every view can independently verify
/// the relationship and fail closed if storage is incomplete or inconsistent.
#[derive(Encode, Decode, Clone)]
struct Binding {
    counterpart: AccountId,
    expires_at: u64,
}

#[pvm::storage]
struct Storage {
    /// owner → active session key
    session_of: pvm::storage::Mapping<AccountId, Binding>,
    /// session key → owner
    owner_of: pvm::storage::Mapping<AccountId, Binding>,
    /// owner → proposed session key. This is deliberately not trusted by
    /// `resolve`: the proposed key must call `activate_session` itself.
    pending_session_of: pvm::storage::Mapping<AccountId, Binding>,
    /// proposed session key → owner, so activation can prove the relationship
    /// in both directions without scanning storage.
    pending_owner_of: pvm::storage::Mapping<AccountId, Binding>,
    /// Permanent tombstone. It prevents key reuse and lets `resolve` reject a
    /// revoked/expired session rather than treating it as a fresh main key.
    used_session_key: pvm::storage::Mapping<AccountId, bool>,
}

fn fail(message: &str) -> ! {
    pvm::api::return_value(pvm::ReturnFlags::REVERT, message.as_bytes())
}

fn caller() -> AccountId {
    let mut account = ZERO_ACCOUNT;
    pvm::api::caller(&mut account);
    account
}

fn current_block() -> u64 {
    // pallet-revive's u256 host buffers are little-endian.
    let mut encoded = [0u8; 32];
    let mut low = [0u8; 8];
    pvm::api::block_number(&mut encoded);
    low.copy_from_slice(&encoded[..8]);
    u64::from_le_bytes(low)
}

fn as_address(account: AccountId) -> Address {
    Address::from(account)
}

fn live(binding: &Binding, now: u64) -> bool {
    now < binding.expires_at
}

fn deadline_from(now: u64, lifetime: u64) -> u64 {
    match now.checked_add(lifetime) {
        Some(deadline) => deadline,
        None => fail("BlockNumberOverflow"),
    }
}

/// Returns the current owner for `session` only if *both* mappings still agree
/// and the shared deadline has not elapsed.
fn live_owner_for(session: &AccountId, now: u64) -> Option<Binding> {
    let owner_link = Storage::owner_of().get(session)?;
    if !live(&owner_link, now) {
        return None;
    }

    let owner_session = Storage::session_of().get(&owner_link.counterpart)?;
    if owner_session.counterpart != *session
        || owner_session.expires_at != owner_link.expires_at
        || !live(&owner_session, now)
    {
        return None;
    }

    Some(owner_link)
}

/// Returns the owner's current session only if the reverse mapping confirms
/// it. This makes a partially cleared or malformed link invalid everywhere.
fn live_session_for(owner: &AccountId, now: u64) -> Option<Binding> {
    let session_link = Storage::session_of().get(owner)?;
    if !live(&session_link, now) {
        return None;
    }

    let session_owner = Storage::owner_of().get(&session_link.counterpart)?;
    if session_owner.counterpart != *owner
        || session_owner.expires_at != session_link.expires_at
        || !live(&session_owner, now)
    {
        return None;
    }

    Some(session_link)
}

/// Returns a proposed owner only when the short-lived request remains
/// bidirectionally consistent. Pending links never affect `resolve`.
fn live_pending_owner_for(session: &AccountId, now: u64) -> Option<Binding> {
    let owner_link = Storage::pending_owner_of().get(session)?;
    if !live(&owner_link, now) {
        return None;
    }

    let owner_session = Storage::pending_session_of().get(&owner_link.counterpart)?;
    if owner_session.counterpart != *session
        || owner_session.expires_at != owner_link.expires_at
        || !live(&owner_session, now)
    {
        return None;
    }

    Some(owner_link)
}

fn live_pending_session_for(owner: &AccountId, now: u64) -> Option<Binding> {
    let session_link = Storage::pending_session_of().get(owner)?;
    if !live(&session_link, now) {
        return None;
    }

    let session_owner = Storage::pending_owner_of().get(&session_link.counterpart)?;
    if session_owner.counterpart != *owner
        || session_owner.expires_at != session_link.expires_at
        || !live(&session_owner, now)
    {
        return None;
    }

    Some(session_link)
}

/// Clears the active relation while retaining the permanent key tombstone.
/// The reverse link is removed only when it still points back at `owner` so a
/// corrupted record cannot delete another account's relationship.
fn clear_session_for(owner: &AccountId) {
    let previous = Storage::session_of().get(owner);
    Storage::session_of().remove(owner);

    if let Some(previous) = previous {
        if let Some(reverse) = Storage::owner_of().get(&previous.counterpart)
            && reverse.counterpart == *owner
        {
            Storage::owner_of().remove(&previous.counterpart);
        }
    }
}

/// Clears a pending request from its owner side. The candidate side is only
/// removed if it still points back, so replacing a stale proposal cannot erase
/// a newer request for the same key.
fn clear_pending_for(owner: &AccountId) {
    let previous = Storage::pending_session_of().get(owner);
    Storage::pending_session_of().remove(owner);

    if let Some(previous) = previous {
        if let Some(reverse) = Storage::pending_owner_of().get(&previous.counterpart)
            && reverse.counterpart == *owner
        {
            Storage::pending_owner_of().remove(&previous.counterpart);
        }
    }
}

/// Removes an expired or otherwise invalid candidate-side proposal before a
/// new request is written. Live candidates are protected by `request_session`
/// so a mempool observer cannot replace a valid setup between its two phases.
fn clear_pending_candidate(session: &AccountId) {
    let previous = Storage::pending_owner_of().get(session);
    Storage::pending_owner_of().remove(session);

    if let Some(previous) = previous {
        if let Some(reverse) = Storage::pending_session_of().get(&previous.counterpart)
            && reverse.counterpart == *session
        {
            Storage::pending_session_of().remove(&previous.counterpart);
        }
    }
}

// The locked 0.3 macro emits its own picoalloc allocator for the entry crate.
// Keeping the default dispatch mode avoids relying on the newer SDK's
// stack-only contract surface while preserving this contract's fixed-size ABI.
#[pvm::contract]
mod session_registry {
    use super::{
        AccountId, Address, Binding, PENDING_LIFETIME_BLOCKS, SESSION_LIFETIME_BLOCKS, Storage,
        ZERO_ACCOUNT, as_address, caller, clear_pending_candidate, clear_pending_for,
        clear_session_for, current_block, deadline_from, fail, live_owner_for,
        live_pending_owner_for, live_pending_session_for, live_session_for,
    };

    #[pvm::constructor]
    pub fn new() -> Result<(), Error> {
        Ok(())
    }

    /// Requests `session` for the caller. This alone grants no authority: the
    /// candidate key must later call `activate_session(owner)` itself. That
    /// proof prevents a third party from burning or redirecting a known H160.
    #[pvm::method]
    pub fn request_session(session: Address) {
        let owner = caller();
        let session: AccountId = session.to_fixed_bytes();

        // A session is never allowed to become an owner. Checking the
        // tombstone also covers an expired or revoked session key, which
        // keeps a formerly delegated key from gaining fresh authority.
        if Storage::used_session_key().contains(&owner) || Storage::owner_of().contains(&owner) {
            fail("SessionKeyCannotManageSessions");
        }
        if session == ZERO_ACCOUNT || session == owner {
            fail("InvalidSessionKey");
        }
        // A fresh session key cannot already participate in either side of
        // the registry. In particular, do not turn another player's primary
        // account (an owner with its own session) into a delegated key.
        if Storage::used_session_key().contains(&session)
            || Storage::owner_of().contains(&session)
            || Storage::session_of().contains(&session)
        {
            fail("SessionKeyInUse");
        }

        let now = current_block();
        if let Some(pending) = live_pending_owner_for(&session, now)
            && pending.counterpart != owner
        {
            fail("SessionRequestInUse");
        }
        let expires_at = deadline_from(now, PENDING_LIFETIME_BLOCKS);

        // Only the same owner may refresh its own live proposal. A possession
        // proof is the only event that permanently consumes a session key.
        clear_pending_for(&owner);
        clear_pending_candidate(&session);
        Storage::pending_session_of().insert(
            &owner,
            &Binding {
                counterpart: session,
                expires_at,
            },
        );
        Storage::pending_owner_of().insert(
            &session,
            &Binding {
                counterpart: owner,
                expires_at,
            },
        );
    }

    /// Activates a pending request. The caller must be the requested session
    /// key, which proves its holder agreed to the relationship. Rotation is
    /// atomic: only after this proof do we retire the owner's old session and
    /// permanently tombstone the newly active key.
    #[pvm::method]
    pub fn activate_session(owner: Address) {
        let session = caller();
        let owner: AccountId = owner.to_fixed_bytes();
        if owner == ZERO_ACCOUNT || session == ZERO_ACCOUNT || session == owner {
            fail("InvalidSessionKey");
        }
        if Storage::used_session_key().contains(&owner) || Storage::owner_of().contains(&owner) {
            fail("SessionKeyCannotManageSessions");
        }
        if Storage::used_session_key().contains(&session)
            || Storage::owner_of().contains(&session)
            || Storage::session_of().contains(&session)
        {
            fail("SessionKeyInUse");
        }

        let now = current_block();
        let pending_owner = match live_pending_owner_for(&session, now) {
            Some(pending) => pending,
            None => fail("NoPendingSession"),
        };
        let pending_session = match live_pending_session_for(&owner, now) {
            Some(pending) => pending,
            None => fail("NoPendingSession"),
        };
        if pending_owner.counterpart != owner
            || pending_session.counterpart != session
            || pending_owner.expires_at != pending_session.expires_at
        {
            fail("NoPendingSession");
        }

        clear_pending_for(&owner);
        // This removes an expired active record too. Its tombstone remains, so
        // a formerly delegated key cannot gain fresh authority.
        if Storage::session_of().contains(&owner) {
            clear_session_for(&owner);
        }

        let expires_at = deadline_from(now, SESSION_LIFETIME_BLOCKS);
        Storage::session_of().insert(
            &owner,
            &Binding {
                counterpart: session,
                expires_at,
            },
        );
        Storage::owner_of().insert(
            &session,
            &Binding {
                counterpart: owner,
                expires_at,
            },
        );
        Storage::used_session_key().insert(&session, &true);
    }

    /// Revokes the caller's active or pending session. Only a main/product
    /// account may manage sessions; a session key, even a previously expired
    /// one, is rejected before it can alter another account's delegation.
    #[pvm::method]
    pub fn revoke_session() {
        let owner = caller();
        if Storage::used_session_key().contains(&owner) || Storage::owner_of().contains(&owner) {
            fail("SessionKeyCannotManageSessions");
        }

        let now = current_block();
        let active = live_session_for(&owner, now).is_some();
        let pending = live_pending_session_for(&owner, now).is_some();
        if !active && !pending {
            fail("NoActiveSession");
        }
        if active {
            clear_session_for(&owner);
        }
        clear_pending_for(&owner);
    }

    /// Resolves an account to the player it currently acts for. Main accounts
    /// resolve to themselves. A key that was ever a session but is no longer
    /// live resolves to zero, allowing game contracts to reject it explicitly.
    #[pvm::method]
    pub fn resolve(account: Address) -> Address {
        let account = account.to_fixed_bytes();
        if account == ZERO_ACCOUNT {
            return as_address(ZERO_ACCOUNT);
        }

        if let Some(owner) = live_owner_for(&account, current_block()) {
            return as_address(owner.counterpart);
        }
        if Storage::used_session_key().contains(&account) {
            return as_address(ZERO_ACCOUNT);
        }

        as_address(account)
    }

    /// Returns the owner's currently live session key, or the zero address.
    #[pvm::method]
    pub fn session_of(owner: Address) -> Address {
        let owner = owner.to_fixed_bytes();
        match live_session_for(&owner, current_block()) {
            Some(session) => as_address(session.counterpart),
            None => as_address(ZERO_ACCOUNT),
        }
    }

    /// Returns the session's current owner, or the zero address.
    #[pvm::method]
    pub fn owner_of(session: Address) -> Address {
        let session = session.to_fixed_bytes();
        match live_owner_for(&session, current_block()) {
            Some(owner) => as_address(owner.counterpart),
            None => as_address(ZERO_ACCOUNT),
        }
    }

    /// Returns the owner that a candidate session key is waiting to activate
    /// for, or zero. This is a recovery aid for clients that finish the
    /// product-signed request but temporarily lose their first silent call.
    #[pvm::method]
    pub fn pending_owner_of(session: Address) -> Address {
        let session = session.to_fixed_bytes();
        match live_pending_owner_for(&session, current_block()) {
            Some(owner) => as_address(owner.counterpart),
            None => as_address(ZERO_ACCOUNT),
        }
    }

    /// True only for a currently live, bidirectionally valid session key.
    #[pvm::method]
    pub fn is_session_key(account: Address) -> bool {
        let account = account.to_fixed_bytes();
        live_owner_for(&account, current_block()).is_some()
    }
}
