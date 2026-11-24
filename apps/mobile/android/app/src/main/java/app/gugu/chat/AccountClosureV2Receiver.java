package app.gugu.chat;

import java.util.Arrays;
import java.util.UUID;

/** Only the private native HTTP receiver constructs these replies. No bridge accepts one. */
final class AccountClosureV2Receiver {
    static final class Reply {
        String operationId, state, requestId, nativeGeneration, serverGeneration, rejectedConfirmationId;
        long revision, challengeExpiresAt;
        int challengeGeneration, httpStatus, rejectedChallengeGeneration;
        boolean hasPreparation, prepared, cancelled, canReleasePreparation, rejectedConfirmation, knownSentRequest;
        void validate() throws Exception {
            canonical(operationId);
            if (requestId != null) canonical(requestId);
            if ((httpStatus != 200 && httpStatus != 201 && httpStatus != 202 && !(httpStatus == 422 && rejectedConfirmation))
                || revision < 1 || revision > 9007199254740991L || challengeGeneration < 0
                || !Arrays.asList("open", "confirming", "processing", "deleted", "closed_before_confirm").contains(state)) throw failure();
            if (hasPreparation) {
                canonical(nativeGeneration);
                if (serverGeneration != null) canonical(serverGeneration);
                if (prepared == cancelled || (prepared && serverGeneration == null)) throw failure();
            }
            if (canReleasePreparation && !"closed_before_confirm".equals(state)) throw failure();
            if (rejectedConfirmation) {
                canonical(rejectedConfirmationId);
                if (!"open".equals(state) || rejectedChallengeGeneration < 1) throw failure();
            }
            if (knownSentRequest && (requestId == null || challengeExpiresAt <= 0 || challengeExpiresAt > 9007199254740991L)) throw failure();
        }
    }
    static AccountClosureOperationV2.Metadata accept(AccountClosureOperationV2 store, AccountClosureReceiptStore.Scope scope,
                                                     AccountClosureOperationV2.Metadata request, String route,
                                                     String backend, Reply reply) throws Exception {
        reply.validate();
        if (!request.backendIdentity.equals(backend) || !request.ownerId.equals(scope.ownerId)
            || !request.localOperationId.equals(scope.localOperationId)
            || (request.serverOperationId != null && !request.serverOperationId.equals(reply.operationId))
            || (request.operationRevision != null && reply.revision < request.operationRevision)
            || reply.challengeGeneration < request.challengeGeneration) throw failure();
        if (request.operationRevision != null && reply.revision == request.operationRevision
            && (!reply.state.equals(request.protocol.serverState) || reply.challengeGeneration != request.challengeGeneration
                || !java.util.Objects.equals(reply.requestId, request.requestId))) throw failure();
        if (("deleted".equals(request.protocol.serverState) && !"deleted".equals(reply.state))
            || ("closed_before_confirm".equals(request.protocol.serverState) && !"closed_before_confirm".equals(reply.state))) throw failure();
        if (reply.hasPreparation && (!request.nativeGeneration.equals(reply.nativeGeneration)
            || (request.serverGeneration != null && !request.serverGeneration.equals(reply.serverGeneration)))) throw failure();
        if (!"result".equals(route) && !route.equals(request.protocol.pendingRoute)
            && !("cancel".equals(route) && request.protocol.cancelRequested && "confirm".equals(request.protocol.pendingRoute))) throw failure();
        boolean acceptsRejection = reply.rejectedConfirmation && "confirm".equals(request.protocol.pendingRoute);
        if (acceptsRejection && (request.serverOperationId == null || !Arrays.asList("confirm", "result").contains(route)
            || !java.util.Objects.equals(request.confirmationId, reply.rejectedConfirmationId)
            || request.challengeGeneration != reply.rejectedChallengeGeneration
            || request.challengeGeneration != reply.challengeGeneration)) throw failure();
        return store.updateProtocol(scope, request.localRevision, request.nativeGeneration, "result".equals(route), state -> {
            state.serverOperationId = reply.operationId; state.serverState = reply.state; state.serverRevision = reply.revision;
            state.challengeGeneration = reply.challengeGeneration; state.requestId = reply.requestId;
            if (reply.hasPreparation) state.serverGeneration = reply.serverGeneration;
            if ("register".equals(route) || ("result".equals(route) && "register".equals(state.pendingRoute))) state.pendingRoute = null;
            if ("challenge".equals(state.pendingRoute) && Arrays.asList("challenge", "result").contains(route)
                && reply.knownSentRequest && "open".equals(reply.state)
                && reply.challengeGeneration == state.attemptedChallengeGeneration) {
                state.codeSent = true; state.challengeExpiresAt = reply.challengeExpiresAt; state.pendingRoute = null;
            }
            if (reply.hasPreparation && reply.prepared && "prepare_device".equals(state.pendingRoute)) state.pendingRoute = null;
            if (reply.hasPreparation && reply.cancelled) {
                if (!"closed_before_confirm".equals(reply.state) || !reply.canReleasePreparation) throw failure();
                state.cancelled = true; state.pendingRoute = null;
                state.cancelRequested = false; state.confirmCancellationBlocked = false;
            }
            if ("deleted".equals(reply.state)) {
                state.pendingRoute = null; state.cancelRequested = false; state.confirmCancellationBlocked = false;
            }
            if (acceptsRejection) {
                state.confirmationRejected = true;
                if ("confirm".equals(state.pendingRoute)) state.pendingRoute = null;
                state.cancelRequested = false; state.confirmCancellationBlocked = false;
            }
            // An open result cannot prove that an earlier in-flight confirmation will never arrive.
            // It therefore never clears an unknown confirmation intent or dispatches another one.
        });
    }
    private static void canonical(String value) throws Exception {
        try { if (!UUID.fromString(value).toString().equals(value)) throw failure(); }
        catch (RuntimeException invalid) { throw failure(); }
    }
    private static AccountClosureReceiptStore.Failure failure() { return new AccountClosureReceiptStore.Failure("unavailable"); }
}
