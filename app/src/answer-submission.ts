/**
 * A local signing/submission attempt is not evidence that an answer exists on
 * chain. In particular, a player can reject the wallet prompt. Keep the
 * answer form visible until the live snapshot records the submission.
 */
export interface AnswerSubmissionScreenState {
    showAnswerForm: boolean;
    lockAnswerForm: boolean;
    showLiveAnswers: boolean;
}

export function answerSubmissionScreenState(
    submittedOnChain: boolean,
    submissionPending: boolean,
): AnswerSubmissionScreenState {
    return {
        showAnswerForm: !submittedOnChain,
        lockAnswerForm: !submittedOnChain && submissionPending,
        showLiveAnswers: submittedOnChain,
    };
}
