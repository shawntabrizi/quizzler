/**
 * Enrich an already-rendered live-game snapshot without holding up the
 * authoritative phase update. Registry content is cosmetic relative to the
 * state machine: a delayed question or canonical-answer lookup must never
 * keep a player in an earlier phase.
 */
export function hydrateLiveSnapshotContent<TSnapshot, TContent>(
    snapshot: TSnapshot,
    load: () => Promise<TContent>,
    isCurrent: (snapshot: TSnapshot) => boolean,
    apply: (snapshot: TSnapshot, content: TContent) => void,
    onError: (error: unknown) => void = () => undefined,
): void {
    void load()
        .then((content) => {
            // A newer phase may have rendered while this content query was
            // in flight. Never let a late result paint an older question.
            if (isCurrent(snapshot)) apply(snapshot, content);
        })
        .catch(onError);
}
