# Starter-pack editorial records

This directory is the review trail for Quizzler's built-in packs. It is deliberately
**not** part of a pack's deployable JSON and is never sent to a contract. Runtime remains
chain-only: `shared/packs/*.json` contains only the game prompt and accepted answers.

Each `*.sources.json` file has the same basename as its pack, is versioned with
`"version": 1`, and is keyed to the pack's exact prompt plus normalized accepted answer
variants. The separate stable `id` is permanent: retain it when rewriting wording or
answer variants so editorial history remains traceable. The included
[`schema.json`](./schema.json) is useful for JSON-editor validation.

## Staged workflow

Every built-in pack starts as `"status": "draft"`. Draft manifests may be empty or may
contain only these scaffold fields:

```json
{
  "id": "qz-geography-q001",
  "question": "Which city is the capital of France?",
  "answers": ["Paris"]
}
```

This keeps a rewrite in progress from breaking the runtime pack check or CI. Scaffold a
pack after its content is in a useful shape:

```sh
cd app
pnpm scaffold:editorial -- 05-geography.json
pnpm validate:editorial
```

The scaffold writes permanent IDs for all 200 regular prompts and three finals. It refuses
to overwrite a manifest that already has entries, so manually preserve IDs once review has
begun.

`pnpm validate:editorial` is a non-blocking draft lint. It reports editorial-record coverage plus useful
warnings for duplicated normalized prompts, explicit current/latest wording, unscoped
superlatives, and basic/very short prompts. It deliberately does not make inherited draft
content fail the build.

When a pack is ready to ship as curated content, complete every entry and change only that
manifest to `"status": "release-ready"`. Then run:

```sh
pnpm audit:editorial
```

The strict audit blocks every `release-ready` pack unless all 203 items are covered and
passes any still-draft packs untouched. Once the whole library is curated, use
`pnpm audit:editorial -- --all` to make every built-in pack strict.

## Release-ready entry

```json
{
  "id": "qz-geography-q001",
  "question": "Which city is the capital of France?",
  "answers": ["Paris"],
  "sources": [
    {
      "url": "https://www.wikidata.org/wiki/Q90",
      "rights": "CC0-1.0",
      "use": "fact-verification"
    }
  ],
  "verified_on": "2026-07-16",
  "stability": "stable",
  "difficulty": "easy",
  "reviewers": [
    {
      "handle": "mira",
      "role": "fact-check",
      "status": "approved",
      "reviewed_on": "2026-07-16"
    },
    {
      "handle": "sam",
      "role": "editorial",
      "status": "approved",
      "reviewed_on": "2026-07-16"
    }
  ]
}
```

The strict audit requires all of the following:

- A unique stable ID across every supplied manifest; exact prompt/answer alignment with
  the pack; and no likely duplicate normalized prompt among release-ready packs.
- At least one HTTPS source, an explicit source-rights classification, and a declaration that
  it was used for fact verification rather than copied wording. Allowed `rights` values are
  `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `public-domain`, `US-government-work`,
  and `Open-Government-Licence-3.0`. CC-BY sources also need a
  concise attribution. The required `use: "fact-verification"` declaration means the team
  checked factual claims but wrote original trivia wording rather than copying expression.
- A real `verified_on` date, a `stable` or `dynamic` classification, and an
  `easy`/`medium`/`hard` difficulty. Final entries must use their final-round difficulty.
- Separate approved `fact-check` and `editorial` reviewers, from different handles.
- A `scope` for a superlative or record claim (for example, “above sea level” or “by
  land area”). This keeps facts with contested definitions defensible.

Do not copy a source's prose or an existing commercial trivia bank. Use sources to verify
facts, then write short original prompts and answer variants. Prefer primary or openly
licensed reference material; save enough provenance here for another editor to re-check it.

## Source policy

Use a source to check a fact, never as a bank of wording to copy. In particular, do **not**
copy questions, explanations, answer lists, or distinctive phrasing from Sporcle, Quizlet,
publishers, fan wikis, or any other commercial/community quiz bank. Every Quizzler prompt
must be newly written in plain language after the fact check.

Good starting points for fact research include:

- [Wikidata's structured data](https://www.wikidata.org/wiki/Wikidata:Licensing), which is
  CC0. Use the data, not prose from other Wikimedia namespaces.
- [Smithsonian Open Access](https://www.si.edu/openaccess/faq) and [The Met Open
  Access](https://www.metmuseum.org/hubs/open-access), but only assets/data explicitly
  marked CC0 or public domain. Record the actual item URL, not just the collection home page.
- [NASA's media guidance](https://www.nasa.gov/nasa-brand-center/images-and-media/) for
  science facts and media: NASA says its content is generally not subject to U.S. copyright,
  but flags third-party material and protects identifiers/logos. Treat the individual item's
  rights notice as authoritative and credit NASA where its policy asks.
- Official public-sector or primary institutional sources for stable facts. Use the
  `US-government-work` classification only when that source's own usage policy supports it;
  it is not a blanket claim about every page or embedded asset. The CIA World Factbook has
  been sunset, so its archived material is suitable only for clearly dated historical facts,
  never a current ranking or statistic.

For sources under CC-BY or CC-BY-SA, put the required credit in `attribution`. Every source
record uses `"use": "fact-verification"`: record the URL and rights status, then write a
new prompt. When in doubt, find a better open or primary source rather than relying on
fair-use assumptions.

## Dynamic facts

Any wording such as “currently”, “as of”, “latest”, or “most recent” must use
`"stability": "dynamic"` and include a review schedule:

```json
{
  "stability": "dynamic",
  "scope": "United Nations population estimate",
  "dynamic_review": {
    "reviewed_on": "2026-07-16",
    "review_due": "2027-01-16",
    "reason": "Population rankings can change after new estimates."
  }
}
```

The audit rejects time-sensitive language without this metadata. In general, prefer
rewriting a transient claim into a stable, dated fact where that makes a better party-game
question.
