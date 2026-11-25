package app.gugu.chat;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

/** Protected native protocol facts, not renderer commands or a second UI controller. */
final class AccountClosureProtocolRecord {
    String serverOperationId, serverState, serverGeneration, requestId, confirmationId, pendingRoute;
    long serverRevision, challengeExpiresAt;
    int challengeGeneration, attemptedChallengeGeneration, cleanupStep;
    boolean codeSent, cancelled, finalized, confirmationRejected, resumeRequired;
    boolean cancelRequested, confirmCancellationBlocked;
    List<String> retained = new ArrayList<>();

    AccountClosureProtocolRecord copy() {
        AccountClosureProtocolRecord copy = new AccountClosureProtocolRecord();
        copy.serverOperationId = serverOperationId; copy.serverState = serverState; copy.serverGeneration = serverGeneration;
        copy.requestId = requestId; copy.confirmationId = confirmationId; copy.pendingRoute = pendingRoute;
        copy.serverRevision = serverRevision; copy.challengeGeneration = challengeGeneration;
        copy.challengeExpiresAt = challengeExpiresAt;
        copy.attemptedChallengeGeneration = attemptedChallengeGeneration; copy.cleanupStep = cleanupStep;
        copy.codeSent = codeSent; copy.cancelled = cancelled; copy.finalized = finalized; copy.confirmationRejected = confirmationRejected;
        copy.resumeRequired = resumeRequired;
        copy.cancelRequested = cancelRequested; copy.confirmCancellationBlocked = confirmCancellationBlocked;
        copy.retained = new ArrayList<>(retained); return copy;
    }
    boolean released() { return cancelled || finalized; }
    boolean deleted() { return "deleted".equals(serverState); }
    void requestCancellation() throws Exception {
        if (released() || deleted() || confirmCancellationBlocked) throw new AccountClosureReceiptStore.Failure("recovery_required");
        cancelRequested = true;
        // A cancel has its own durable intent. It must never replace the original confirm nonce or pending effect.
        if (!"confirm".equals(pendingRoute)) pendingRoute = "cancel";
    }
    void blockCancellation() throws Exception {
        if (!cancelRequested) throw failure();
        confirmCancellationBlocked = true;
    }
    void validate() throws Exception {
        for (String id : new String[]{serverOperationId, serverGeneration, requestId, confirmationId}) {
            if (id != null && !UUID.fromString(id).toString().equals(id)) throw failure();
        }
        if (serverOperationId == null ? serverState != null || serverRevision != 0 :
            serverRevision < 1 || serverRevision > 9007199254740991L || !Arrays.asList("open", "confirming", "processing", "deleted", "closed_before_confirm").contains(serverState)) throw failure();
        if (challengeGeneration < 0 || attemptedChallengeGeneration < 0 || challengeExpiresAt < 0 || challengeExpiresAt > 9007199254740991L || cleanupStep < 0 || cleanupStep > 4
            || (cleanupStep > 0 && !deleted()) || (finalized && cleanupStep != 4)
            || (cancelled && !"closed_before_confirm".equals(serverState)) || (confirmationRejected && confirmationId == null)) throw failure();
        if (pendingRoute != null && !Arrays.asList("register", "challenge", "prepare_device", "confirm", "cancel").contains(pendingRoute)) throw failure();
        if ((cancelRequested && !Arrays.asList("confirm", "cancel").contains(pendingRoute))
            || (confirmCancellationBlocked && !cancelRequested)) throw failure();
        for (String name : retained) {
            if (!Arrays.asList("auth-code-verifier", "auth-oauth-pending", "shared-incoming-file-cache",
                "shared-outgoing-file-cache", "shared-runtime-temp-cache").contains(name)) throw failure();
        }
    }
    void write(DataOutputStream out) throws Exception {
        validate();
        for (String value : new String[]{serverOperationId, serverState, serverGeneration, requestId, confirmationId, pendingRoute}) {
            out.writeBoolean(value != null); if (value != null) out.writeUTF(value);
        }
        out.writeLong(serverRevision); out.writeInt(challengeGeneration); out.writeInt(attemptedChallengeGeneration); out.writeLong(challengeExpiresAt);
        out.writeInt(cleanupStep); out.writeBoolean(codeSent); out.writeBoolean(cancelled); out.writeBoolean(finalized); out.writeBoolean(confirmationRejected); out.writeBoolean(resumeRequired);
        out.writeBoolean(cancelRequested); out.writeBoolean(confirmCancellationBlocked);
        out.writeInt(retained.size()); for (String name : retained) out.writeUTF(name);
    }
    static AccountClosureProtocolRecord read(DataInputStream in) throws Exception {
        AccountClosureProtocolRecord value = new AccountClosureProtocolRecord();
        String[] fields = new String[6];
        for (int i = 0; i < fields.length; i++) fields[i] = in.readBoolean() ? in.readUTF() : null;
        value.serverOperationId = fields[0]; value.serverState = fields[1]; value.serverGeneration = fields[2];
        value.requestId = fields[3]; value.confirmationId = fields[4]; value.pendingRoute = fields[5];
        value.serverRevision = in.readLong(); value.challengeGeneration = in.readInt(); value.attemptedChallengeGeneration = in.readInt(); value.challengeExpiresAt = in.readLong();
        value.cleanupStep = in.readInt(); value.codeSent = in.readBoolean(); value.cancelled = in.readBoolean(); value.finalized = in.readBoolean(); value.confirmationRejected = in.readBoolean(); value.resumeRequired = in.readBoolean();
        value.cancelRequested = in.readBoolean(); value.confirmCancellationBlocked = in.readBoolean();
        int count = in.readInt(); if (count < 0 || count > 5) throw failure();
        for (int i = 0; i < count; i++) value.retained.add(in.readUTF());
        value.validate(); return value;
    }
    private static AccountClosureReceiptStore.Failure failure() { return new AccountClosureReceiptStore.Failure("closure_storage_unavailable"); }
}
