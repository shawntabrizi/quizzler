# Building a high-quality quiz pack

A practical guide for humans and AI agents writing Quizzler packs. It distills
the hard limits enforced by the contracts and validators, how the game engine
actually consumes your questions, and the editorial lessons from auditing and
rewriting the ten starter packs (~2,000 questions).

The one-sentence bar: **every question should be fun for a mixed group of ~6
casual players typing free-text answers on their phones under time pressure.**
When in doubt, optimize for that table, not for trivia rigor.

## 1. Pack file shape

A pack is a single JSON file:

```json
{
  "title": "Music",
  "questions": [
    {
      "text": "Who was the lead singer of Queen?",
      "answers": ["Freddie Mercury", "Mercury", "Freddy Mercury"],
      "difficulty": "easy"
    }
  ]
}
```

Hard limits (enforced by `app/src/pack-validation.ts` and the on-chain
registry — a pack that violates these will not validate or seed):

| Field | Limit |
|---|---|
| `title` | 1–64 UTF-8 bytes, no control characters |
| `questions` | 2–255 questions (registry slots are `u8`, 0–254; 2 is only the technical floor — see §2 for the real recommended minimum) |
| `text` | 1–256 UTF-8 bytes, no control characters |
| `answers` | 1–5 **distinct normalized** answers; each ≤64 bytes; none may normalize to empty |
| `difficulty` | exactly `"easy"`, `"medium"`, or `"hard"` — required on every question |

Two answers that normalize to the same string ("Mercury" and "mercury")
count once against the five-answer cap, so case/punctuation variants are free
but pointless — see §3 before spending answer slots.

Validate locally before anything else:

```sh
cd app
pnpm validate:packs       # structural limits above
pnpm validate:editorial   # draft lint: duplicate prompts, unscoped superlatives, time-sensitive wording
```

## 2. How the game uses your questions (why difficulty labels matter)

The game engine plans rounds from your `difficulty` labels
(`contracts/logic/src/lib.rs`):

- A game's regular round targets a **40% easy / 40% medium / 20% hard** mix
  (5 questions → 2/2/1, 10 → 4/4/2, 15 → 6/6/3, 20 → 8/8/4), falling back to
  adjacent tiers only when a tier runs out.
- Games **open with the easiest available question** as a warm-up, and never
  play more than two of the same tier back-to-back.
- The **final question is voted on by players** (easy/medium/hard, majority,
  ties break harder). A tier is only offered if a distinct *unused* question
  of that tier remains after the regular round.

Practical consequences:

- The validator's floor of 2 questions is a technical minimum, not a
  recommendation. Hosts pick game lengths of 5/10/15/20 (capped by pack
  size), so treat **21 questions as the practical minimum** — a full
  20-question game plus one unused question for the final. And since a
  20-question round consumes 8 easy / 8 medium / 4 hard, keep spares in
  *every* tier (**25+ questions in a 2:2:1 spread**) so all three
  final-round difficulties stay on the players' ballot.
- Keep roughly a **2:2:1 easy:medium:hard spread** so every game length and
  final-round vote works. A 150–255 question pack gives good replay variety;
  the starter packs run ~180–200. **Quality beats count** — 180 great
  questions is a better pack than 200 with 20 filler questions.
- A specialist pack may calibrate difficulty to its own audience (a chess
  pack's "easy" is easy *for people who chose a chess pack*), but the tiers
  must still be honest relative to each other.
- Sealed packs are immutable. Once sealed on-chain, content cannot be
  edited — get it right before sealing.

## 3. How answer matching works (design your answer lists around this)

Matching is on-chain (`contracts/logic/src/lib.rs`), mirrored client-side
(`app/src/normalize.ts`), pinned by `shared/answer-test-vectors.json`:

1. **Normalization**: diacritics folded to ASCII ("Söze" → "soze"), lowercased,
   punctuation dropped *without splitting words* ("Dexy's" → "dexys",
   "Spider-Man" → "spiderman" and "Spider Man" → "spider man" — list both if
   both are common), whitespace collapsed.
2. **Fuzzy tolerance**: a submission matches an accepted answer of 5+
   characters within a Levenshtein distance of ~1 typo per 6 characters
   (minimum 1). Accepted answers under 5 characters and **all digit-only
   answers require an exact match**.
3. **Human backstop**: after reveal, a majority of the *other* players can
   vote to overturn a wrong mark. This catches "close enough" cases — don't
   rely on it for answers you can predict.

So **do not** spend answer slots on single-typo misspellings of 5+ character
answers ("Dalmation", "Chumbawumba", "Reykjavic" all match automatically).
**Do** spend your five slots on:

- **Different forms of the answer**: surname alone plus full name
  ("Mercury", "Freddie Mercury"); article variants only when players will
  really type them ("The Covenant" / "Covenant").
- **Genuinely different correct answers**: if the question asks "which
  author?", accept "F. Scott Fitzgerald", not only "Zelda Fitzgerald".
- **Word forms of small numbers**: digits are exact-match, so accept both
  `"4"` and `"four"` for anything 0–20. Years and large numbers can stay
  digit-only — nobody types "nineteen eighty-five".
- **Common misspellings beyond one typo**: "Kaiser Soze" (for Keyser Söze),
  "Ulanbatar" (for Ulaanbaatar). These are real player inputs the fuzzy
  matcher cannot reach.
- **Number + unit phrasing**: "9.58" normalizes to "958", so "9.58 seconds"
  does NOT match it — accept the unit form too, or avoid unit answers.

Never write a question whose natural answer defeats normalization or typing:

- **Pure punctuation/symbols**: "@" normalizes to an empty string and can
  never match. (This shipped in a starter pack. It was unanswerable.)
- **Chemical formulas and long codes**: "C6H12O6" on a phone under a timer
  is a typing test, not trivia.
- **Compound answers**: requiring "Denmark and Norway" fails everyone who
  types "Denmark". Ask so a single word wins, or accept each part.

## 4. Editorial principles (from auditing 2,000 starter questions)

### The foothold principle

Every question should give every player at the table a way in. The single
biggest fun-killer found in the audit was **dead rounds**: "hard" questions
where a table of six casual players all score zero and stare at an answer
they've never heard of.

- Fun-hard = a famous subject approached from an angle only one or two
  people will get: *"What cocktail does the Dude sip throughout The Big
  Lebowski?"*, *"Which 2015-16 Premier League team won at 5000-1 odds?"*,
  *"The first computer mouse was made mostly of which material?"*
- Dead-round-hard = obscure proper names, exact years, record-book stats,
  production jargon: silent-film directors, Byzantine generals, first UN
  Secretaries-General, video-game composers, wine-making byproducts, protocol
  internals. If the answer is a person only specialists can name, cut it.

The same bar, inverted, applies to easy: **easy must still be satisfying**.
"What is the opposite of day?" and "What do you call a baby dog?" give a
table of adults nothing. An easy question should make someone smile when
they get it ("Which honey-loving bear lives in the Hundred Acre Wood?"), not
insult them.

### One defensible answer

- If two answers are defensible, accept both or reword until only one is.
  Audit examples: a "white cross on red" flag question where both Switzerland
  and Denmark qualify (fix: "red **square** flag"); "homograph" where most
  players will type the equally-defensible "homonym".
- **Scope every superlative**: "largest desert **by area**", "highest
  mountain **above sea level**", "best-selling console **of all time**".
  Unscoped records invite disputes the jury shouldn't have to settle.
- If everyone will confidently give a *different* term, signal what you want:
  "What is the **Italian** collective term for cured meats…" — otherwise the
  whole table types "charcuterie" and feels robbed.
- **Gotchas must be signaled.** "Largest desert → Antarctica" is only fun if
  the question hints at the twist ("counting freezing polar deserts…").
  An unsignaled gotcha marks the whole table wrong and feels unfair.
- **No myths, no disputes, no moving targets.** The "Civilization Gandhi
  nuke bug" is a debunked legend; "last Western Roman emperor" is disputed by
  historians; "current tallest building" expires. Prefer stable, dated,
  checkable facts. (Time-sensitive wording is flagged by the editorial lint
  and requires review metadata — see §6.)

### No leaks, no repeats

- **Never put the answer in the question**: "Which country hosts the Tour de
  France?", "The Sydney Opera House is in which country?" — both shipped,
  both pointless.
- **Scan for same-pack leak pairs**: one question's text revealing another's
  answer ("…set in 9.58 seconds" next to "what is the 100m record?";
  "attacked Pearl Harbor in 1941" alongside "in which year was Pearl Harbor
  attacked?"). A game can draw both.
- **No duplicate questions** within a pack, and check other packs before
  writing a "classic" — the audit found the same Parasite, Donkey Kong,
  Nepal-flag, and Nokia-Snake questions written twice independently.

### Honest difficulty

Label by **what a casual player can actually produce**, not by how academic
the topic sounds. Real mislabels from the audit: "Synecdoche", "Karst", and
"Kintsugi" labeled *easy*; "which 1981 arcade game introduced Mario" labeled
*hard* (it's Donkey Kong — everyone knows). A typed answer also raises
difficulty: a fact everyone knows with a hard-to-produce answer is not easy.

### Variety and audience

- **Avoid format fatigue**: 120 consecutive "What is the capital of X?" or 28
  "chemical symbol for X" questions turn the game into flashcards. Rotate
  formats: landmarks, flags, borders, quotes, "name the thing from its
  description", collective nouns, complete-the-line.
- **Write for an international table** unless the pack theme says otherwise:
  US state nicknames, county cricket stats, and AFL venues alienate most of
  a mixed group. Country-specific facts are fine when world-famous (Eiffel
  Tower, samurai) — not when they're domestic schooling.
- Keep it light. A party game is the wrong place for tragedies-as-trivia
  (the audit cut a "what year was 9/11" question — grim *and* trivially easy).

## 5. Per-question checklist

Before a question goes in, check:

- [ ] Would all six players at least have a guess? Would one of them enjoy
      getting it right?
- [ ] Is the canonical answer short, unambiguous, and typeable on a phone?
- [ ] Are all genuinely-correct answers and natural forms accepted
      (≤5 distinct normalized)? Small numbers in both digit and word form?
- [ ] Is any answer under 5 characters or digit-only spelled exactly the way
      players will type it? (No fuzz applies there.)
- [ ] Is the fact stable, undisputed, and scoped if it's a superlative?
- [ ] Does the difficulty label reflect a casual player's real recall —
      including typing difficulty?
- [ ] Does the question text avoid containing its own answer, or the answer
      to any other question in the pack?
- [ ] Is it original wording (never copied from Sporcle, Quizlet, or any quiz
      bank — see the source policy in
      [`../pack-sources/README.md`](../pack-sources/README.md))?

## 6. Pack-level checklist and workflow

- [ ] At least 21 questions (a 20-question game plus its final) — 25+ in a
      2:2:1 spread keeps every final-round difficulty viable; aim 150+ for
      replay value; 255 max; never pad — cut instead.
- [ ] Roughly 2:2:1 easy:medium:hard so game planning and final votes work.
- [ ] No duplicate normalized question texts; no leak pairs.
- [ ] Formats varied; no long single-format runs.
- [ ] `pnpm validate:packs` and `pnpm validate:editorial` pass.
- [ ] For repository (starter) packs: an editorial manifest in
      `shared/pack-sources/` stays in exact sync with the pack — same
      question text, answers, and difficulty per stable `id`. Scaffold with
      `pnpm scaffold:editorial -- <pack>.json`; sourcing, licensing, and
      release requirements are documented in
      [`../pack-sources/README.md`](../pack-sources/README.md).
- [ ] Remember sealing is final: a sealed pack's content is immutable
      on-chain, and the seeder will not update a sealed pack (it skips
      matching titles and errors on content mismatches). Fix content first,
      seal last.

## 7. Worked examples (bad → good, all from the starter-pack audit)

| Problem | Before | After |
|---|---|---|
| Answer in question | "Which country hosts the Tour de France?" | "In football, what is it called when a player scores three goals in one match?" (hat-trick) |
| Dead-round hard | "Which programmer hid his name in Atari's Adventure…?" (Warren Robinett) | "Which console, released in 2000, is still the best-selling of all time?" (PlayStation 2) |
| Zero-satisfaction easy | "What is the opposite of day?" | "Which green ogre lives in a swamp in a series of DreamWorks films?" (Shrek) |
| Unanswerable as typed | "Which symbol separates the username from the domain in an email address?" (@ normalizes to nothing) | "What do you call a '#' label, like #ThrowbackThursday, used to tag topics on social media?" (hashtag) |
| Ambiguous | "Which country's flag is a white cross on a red background?" (Switzerland *and* Denmark) | "Which country's flag is a red **square** with a white cross in the middle?" |
| Unsignaled gotcha | "What is the largest desert in the world by area?" (everyone types Sahara, marked wrong) | "**Counting freezing polar deserts**, what is the largest desert on Earth?" (Antarctic) |
| Strict answer list | "The Usual Suspects" villain accepting only "Keyser Soze/Söze" | …also accepts "Kaiser Soze" — the dominant misspelling, 2 edits beyond fuzzy reach |
| Compound answer | Bluetooth king of "which two countries?" (only "Denmark and Norway" accepted) | "…king of which country?" accepting "Denmark" or "Norway" |
| Myth as fact | "Which peaceful leader is notorious in Civilization for nukes?" (debunked legend) | "Which 1982 Atari game was famously buried in a New Mexico landfill?" (E.T.) |
