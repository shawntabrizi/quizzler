import { describe, expect, it } from "vitest";

import { hydrateLiveSnapshotContent } from "./live-snapshot-content";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("live snapshot content hydration", () => {
    it("does not block a newer phase or let late content overwrite it", async () => {
        const firstContent = deferred<string>();
        const review = { phase: "review", question: "" };
        const finalWager = { phase: "final-wager", question: "" };
        let current = review;

        hydrateLiveSnapshotContent(
            review,
            () => firstContent.promise,
            (snapshot) => current === snapshot,
            (snapshot, question) => { snapshot.question = question; },
        );

        // A subsequent live-game read can render the next state immediately;
        // it does not wait for the review question/answer request above.
        current = finalWager;
        expect(current.phase).toBe("final-wager");

        firstContent.resolve("Late review question");
        await Promise.resolve();
        await Promise.resolve();

        expect(review.question).toBe("");
        expect(current).toEqual({ phase: "final-wager", question: "" });
    });

    it("applies content when its snapshot remains current", async () => {
        const snapshot = { phase: "question", question: "" };

        hydrateLiveSnapshotContent(
            snapshot,
            async () => "Ready question",
            (candidate) => candidate === snapshot,
            (candidate, question) => { candidate.question = question; },
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(snapshot.question).toBe("Ready question");
    });
});
