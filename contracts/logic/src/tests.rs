use super::*;
use alloc::string::ToString;
use alloc::vec;

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
fn difficulty_vote_flows_through_final_wager_before_revealing_final_question() {
    let (wager, crossed_vote) = roll(clock(STAGE_VOTE, 2, 200), &CFG, 205);
    assert!(crossed_vote);
    assert_eq!(wager, clock(STAGE_FINAL_WAGER, 2, 205));

    let (answer, crossed_vote) = roll(wager, &CFG, 215);
    assert!(!crossed_vote);
    assert_eq!(answer, clock(STAGE_FINAL_ANSWER, 2, 215));
}

#[test]
fn roll_across_many_stages_with_nobody_playing() {
    // From the start of question 0, elapse everything: 3×(10+5) answer/review
    // + 5 vote + 10 final wager + 10 final answer + 5 final review = 75 blocks
    // to Finished.
    let (c, crossed_vote) = roll(clock(STAGE_ANSWER, 0, 0), &CFG, 75);
    assert_eq!(c.stage, STAGE_FINISHED);
    assert!(crossed_vote, "roll must report crossing the vote stage");
    // one block earlier we are still in the final review
    let (c, _) = roll(clock(STAGE_ANSWER, 0, 0), &CFG, 74);
    assert_eq!(c, clock(STAGE_FINAL_REVIEW, 2, 70));
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
    assert_eq!(stage_deadline(&clock(STAGE_FINAL_WAGER, 2, 115), &CFG), 125);
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

// ── Question planner ────────────────────────────────────────────────

#[test]
fn planner_starts_with_easy_when_easy_slots_exist() {
    let easy_slots = [1u8, 2];
    let plan = plan_question_slots(
        [
            vec![easy_slots[0], easy_slots[1]],
            vec![10, 11, 12],
            vec![20, 21, 22],
        ],
        5,
        |_| 0,
    )
    .expect("enough slots for regular questions and a final");

    assert!(
        easy_slots.contains(&plan.regular_slots[0]),
        "the first regular question must be Easy when an Easy slot exists"
    );
}

#[test]
fn planner_never_uses_three_of_a_tier_while_another_tier_remains() {
    // Bias every random choice toward Hard. Once two Hard questions have
    // appeared, Medium must interrupt while it remains. A third Hard at the
    // end is permitted only after all alternate tiers are exhausted.
    let initial = [1, 1, 5];
    let sequence = planned_question_difficulty_sequence(initial, &mut |bound| bound - 1)
        .expect("each tier has enough candidates for a mixed regular round");
    assert_eq!(sequence, vec![0, 2, 2, 1, 2, 2, 2]);
    let mut remaining = initial;

    for (index, difficulty) in sequence.iter().copied().enumerate() {
        remaining[difficulty as usize] -= 1;
        if index < 2 || sequence[index - 2] != difficulty || sequence[index - 1] != difficulty {
            continue;
        }

        assert!(
            remaining
                .iter()
                .enumerate()
                .all(|(tier, count)| tier as u8 == difficulty || *count == 0),
            "tier {difficulty} appeared three times even though another tier remained"
        );
    }
}

#[test]
fn planner_never_reuses_regular_or_final_slots() {
    let plan = plan_question_slots(
        [vec![1, 2, 3], vec![10, 11, 12], vec![20, 21, 22]],
        5,
        |_| 0,
    )
    .expect("enough slots for regular questions and a final");

    for (index, slot) in plan.regular_slots.iter().enumerate() {
        assert!(
            !plan.regular_slots[..index].contains(slot),
            "regular slot {slot} was selected twice"
        );
    }
    let mut reserved = vec![];
    for slot in plan.final_slots.iter().filter_map(|slot| *slot) {
        assert!(
            !plan.regular_slots.contains(&slot),
            "final slot {slot} also appeared in the regular round"
        );
        assert!(
            !reserved.contains(&slot),
            "the same final slot was reserved for two difficulties"
        );
        reserved.push(slot);
    }
}

#[test]
fn all_easy_pack_exposes_only_easy_as_a_final_choice() {
    let plan = plan_question_slots([vec![0, 1, 2, 3, 4, 5], vec![], vec![]], 5, |_| 0)
        .expect("six Easy slots can play five regular questions plus a final");

    assert_eq!(plan.viable_final_difficulties, 0b001);
    assert!(plan.final_slots[0].is_some());
    assert_eq!(plan.final_slots[1], None);
    assert_eq!(plan.final_slots[2], None);
}

#[test]
fn sparse_tiers_expose_only_difficulties_left_after_regular_plan() {
    // Four regular questions target 2 Easy / 2 Medium. With one Easy, two
    // Medium, and two Hard candidates, the nearest-tier fallback consumes
    // one Hard regular question. Only the remaining Hard slot is eligible for
    // the final; offering Easy or Medium would repeat a regular question.
    let plan = plan_question_slots([vec![0], vec![10, 11], vec![20, 21]], 4, |_| 0)
        .expect("one unused Hard slot remains for the final");

    assert_eq!(plan.viable_final_difficulties, 0b100);
    assert_eq!(plan.final_slots[0], None);
    assert_eq!(plan.final_slots[1], None);
    assert!(plan.final_slots[2].is_some());
}
