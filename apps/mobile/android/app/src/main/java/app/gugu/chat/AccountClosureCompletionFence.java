package app.gugu.chat;

/** Native generation fence shared by the Android composition and portable tests. */
final class AccountClosureCompletionFence {
    static final int STOPPING = 1, STOPPED = 2, RETIRED = 3;
    interface Check { void run() throws Exception; }
    static void complete(int expectedState, String expectedGeneration, int currentState, String currentGeneration,
                         Check fence, Check commit) throws Exception {
        fence.run();
        if (expectedState < STOPPING || expectedState > RETIRED || expectedState != currentState
            || expectedGeneration == null || expectedGeneration.isEmpty() || !expectedGeneration.equals(currentGeneration))
            throw new AccountClosureReceiptStore.Failure("scope_conflict");
        if (expectedState == STOPPING) commit.run();
    }
}
