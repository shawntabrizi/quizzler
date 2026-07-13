/**
 * Client-side answer normalization. MUST stay in lockstep with
 * `contracts/logic/src/lib.rs::normalize` — both are pinned by
 * `shared/answer-test-vectors.json`.
 *
 * The client additionally folds diacritics to ASCII before applying the
 * shared algorithm (the contract drops non-ASCII outright, so folding
 * client-side preserves answers like "café" → "cafe" instead of "caf").
 */
export function normalizeAnswer(input: string): string {
    const folded = input.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    let out = "";
    let pendingSpace = false;
    for (const c of folded) {
        if (/[a-zA-Z0-9]/.test(c)) {
            if (pendingSpace && out.length > 0) out += " ";
            pendingSpace = false;
            out += c.toLowerCase();
        } else if (/\s/.test(c)) {
            pendingSpace = true;
        }
        // anything else: dropped, does not break a word
    }
    return out;
}
