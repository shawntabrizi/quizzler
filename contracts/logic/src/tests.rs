use super::*;
use alloc::string::ToString;

// ── Shared vectors (parity with app/src/normalize.ts) ────────────────

#[derive(serde::Deserialize)]
struct Vectors {
    normalize: Vec<NormalizeCase>,
    matching: Vec<MatchCase>,
}

#[derive(serde::Deserialize)]
struct NormalizeCase {
    raw: String,
    normalized: String,
}

#[derive(serde::Deserialize)]
struct MatchCase {
    submitted: String,
    accepted: Vec<String>,
    #[serde(rename = "match")]
    matches: bool,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!("../../../shared/answer-test-vectors.json")).unwrap()
}

#[test]
fn normalize_vectors() {
    for case in vectors().normalize {
        assert_eq!(normalize(&case.raw), case.normalized, "raw: {:?}", case.raw);
    }
}

#[test]
fn matching_vectors() {
    for case in vectors().matching {
        assert_eq!(
            answer_matches(&case.submitted, &case.accepted),
            case.matches,
            "submitted: {:?} vs {:?}",
            case.submitted,
            case.accepted,
        );
    }
}

// ── Matching internals ───────────────────────────────────────────────

#[test]
fn levenshtein_basics() {
    assert_eq!(levenshtein("", ""), 0);
    assert_eq!(levenshtein("abc", ""), 3);
    assert_eq!(levenshtein("", "abc"), 3);
    assert_eq!(levenshtein("kitten", "sitting"), 3);
    assert_eq!(levenshtein("paris", "paris"), 0);
}

#[test]
fn numbers_and_short_answers_require_exact_match() {
    assert_eq!(fuzz_allowance("1912"), 0);
    assert_eq!(fuzz_allowance("care"), 0);
    assert_eq!(fuzz_allowance("paris"), 1);
    assert_eq!(fuzz_allowance("leonardo dicaprio"), 2);
}

// ── Pack metadata ───────────────────────────────────────────────────

#[test]
fn pack_emoji_metadata_accepts_modern_sequences_with_bounded_storage() {
    assert!(valid_pack_emoji("🎬"));
    assert!(valid_pack_emoji("🇵🇹"), "flag sequence");
    assert!(valid_pack_emoji("👩🏽‍🚀"), "skin-tone + ZWJ sequence");
    assert!(valid_pack_emoji("👨‍👩‍👧‍👦"), "family ZWJ sequence");
    assert!(!valid_pack_emoji(""));
    assert!(!valid_pack_emoji("   "));
    assert!(valid_pack_emoji("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
    assert!(
        !valid_pack_emoji("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
        "33 UTF-8 bytes must be rejected"
    );
    assert_eq!(MAX_PACK_EMOJI_BYTES, 32);
}

#[test]
fn player_names_are_compact_single_line_labels() {
    assert!(valid_player_name("Alex"));
    assert!(valid_player_name("João 🎲"));
    assert!(valid_player_name("123456789012345678901234"));
    assert!(!valid_player_name(""));
    assert!(!valid_player_name(" Alex"));
    assert!(!valid_player_name("Alex "));
    assert!(!valid_player_name("Alex\nBob"));
    assert!(!valid_player_name("1234567890123456789012345"));
    assert_eq!(MAX_PLAYER_NAME_BYTES, 24);
}

// ── Phase machine ────────────────────────────────────────────────────

const CFG: PhaseConfig = PhaseConfig {
    num_questions: 3,
    answer_blocks: 10,
    review_blocks: 5,
};

fn clock(stage: u8, cursor: u8, anchor: u64) -> GameClock {
    GameClock {
        stage,
        cursor,
        anchor,
    }
}

#[test]
fn stage_holds_until_deadline() {
    let c = clock(STAGE_ANSWER, 0, 100);
    // boundary block belongs to the NEXT stage: [100, 110)
    assert_eq!(roll(c, &CFG, 100).0, c);
    assert_eq!(roll(c, &CFG, 109).0, c);
    assert_eq!(roll(c, &CFG, 110).0, clock(STAGE_REVIEW, 0, 110));
}

#[test]
fn review_advances_to_next_question_or_vote() {
    let (c, _) = roll(clock(STAGE_REVIEW, 0, 110), &CFG, 115);
    assert_eq!(c, clock(STAGE_ANSWER, 1, 115));
    // last question's review goes to the difficulty vote
    let (c, crossed) = roll(clock(STAGE_REVIEW, 2, 200), &CFG, 205);
    assert_eq!(c, clock(STAGE_VOTE, 2, 205));
    assert!(!crossed);
}

#[test]
fn roll_across_many_stages_with_nobody_playing() {
    // From the start of question 0, elapse everything: 3×(10+5) answer/review
    // + 5 vote + 10 final answer + 5 final review = 65 blocks to Finished.
    let (c, crossed_vote) = roll(clock(STAGE_ANSWER, 0, 0), &CFG, 65);
    assert_eq!(c.stage, STAGE_FINISHED);
    assert!(crossed_vote, "roll must report crossing the vote stage");
    // one block earlier we are still in the final review
    let (c, _) = roll(clock(STAGE_ANSWER, 0, 0), &CFG, 64);
    assert_eq!(c, clock(STAGE_FINAL_REVIEW, 2, 60));
}

#[test]
fn lobby_and_finished_do_not_roll() {
    let lobby = clock(STAGE_LOBBY, 0, 0);
    assert_eq!(roll(lobby, &CFG, 1_000_000).0, lobby);
    let done = clock(STAGE_FINISHED, 2, 65);
    assert_eq!(roll(done, &CFG, 1_000_000).0, done);
    let abandoned = clock(STAGE_ABANDONED, 0, 12);
    assert_eq!(roll(abandoned, &CFG, 1_000_000).0, abandoned);
}

#[test]
fn deadlines() {
    assert_eq!(stage_deadline(&clock(STAGE_ANSWER, 0, 100), &CFG), 110);
    assert_eq!(stage_deadline(&clock(STAGE_REVIEW, 0, 110), &CFG), 115);
    assert_eq!(stage_deadline(&clock(STAGE_LOBBY, 0, 0), &CFG), u64::MAX);
    assert_eq!(stage_deadline(&clock(STAGE_FINISHED, 0, 0), &CFG), u64::MAX);
}

#[test]
fn question_keys() {
    assert_eq!(question_key(&clock(STAGE_ANSWER, 1, 0)), 1);
    assert_eq!(question_key(&clock(STAGE_REVIEW, 2, 0)), 2);
    assert_eq!(
        question_key(&clock(STAGE_FINAL_ANSWER, 2, 0)),
        FINAL_QUESTION_KEY
    );
    assert_eq!(
        question_key(&clock(STAGE_FINAL_REVIEW, 2, 0)),
        FINAL_QUESTION_KEY
    );
}

// ── Voting ───────────────────────────────────────────────────────────

#[test]
fn overturn_thresholds() {
    // majority of the OTHER players
    assert_eq!(overturn_threshold(2), 1);
    assert_eq!(overturn_threshold(3), 2);
    assert_eq!(overturn_threshold(4), 2);
    assert_eq!(overturn_threshold(5), 3);
    assert_eq!(overturn_threshold(10), 5);
}

#[test]
fn eligible_voter_majorities_cover_forfeited_targets() {
    assert_eq!(majority_threshold(1), 1);
    assert_eq!(majority_threshold(2), 2);
    assert_eq!(majority_threshold(3), 2);
    assert_eq!(majority_threshold(4), 3);
}

#[test]
fn pending_overturn_votes_can_cross_the_reduced_quorum_after_a_forfeit() {
    // Five active players, including the answer owner, leave four eligible
    // jurors. Two existing votes are not enough. If a non-voting juror
    // forfeits, there are three eligible jurors and the same two votes must
    // immediately overturn the answer when the contract re-checks it.
    assert!(!overturn_passes(2, 4));
    assert!(overturn_passes(2, 3));

    // A reduced roster must still contain an actual vote; an empty jury does
    // not auto-correct an answer.
    assert!(!overturn_passes(0, 0));
}

#[test]
fn difficulty_resolution() {
    assert_eq!(resolve_difficulty([0, 0, 0]), 1, "no votes → medium");
    assert_eq!(resolve_difficulty([3, 1, 1]), 0);
    assert_eq!(resolve_difficulty([1, 1, 3]), 2);
    assert_eq!(resolve_difficulty([2, 2, 0]), 1, "tie breaks harder");
    assert_eq!(resolve_difficulty([2, 0, 2]), 2, "tie breaks harder");
    assert_eq!(
        resolve_difficulty([1, 1, 1]),
        2,
        "three-way tie breaks hardest"
    );
}

#[test]
fn to_string_is_available_in_no_std_alloc() {
    // guards the alloc-only build: String/ToString must come from alloc
    assert_eq!(1912u32.to_string(), "1912");
}
