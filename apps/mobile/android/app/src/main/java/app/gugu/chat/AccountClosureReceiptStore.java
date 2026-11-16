package app.gugu.chat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Protected records capture local authority once. No network, logs or retry timers. */
final class AccountClosureReceiptStore {
    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super("Local account closure operation could not be completed"); this.code = code; }
    }
    static final class Scope {
        final String ownerId, localOperationId;
        Scope(String ownerId, String localOperationId) throws Failure {
            try {
                if (!UUID.fromString(ownerId).toString().equals(ownerId) || localOperationId == null
                    || localOperationId.isEmpty() || utf8(localOperationId).length > 256) throw new IllegalArgumentException();
            } catch (RuntimeException invalid) { throw new Failure("invalid_scope"); }
            this.ownerId = ownerId; this.localOperationId = localOperationId;
        }
    }
    interface Secrets { byte[] read(String key) throws Exception; void write(String key, byte[] bytes) throws Exception; }
    interface Installation { String read() throws Exception; }
    interface MainOwner { String read() throws Exception; }
    interface Preparation { boolean ready(Scope scope) throws Exception; }
    interface Generation { String read(Scope scope, boolean capturing) throws Exception; }
    interface Step { boolean run(Scope scope) throws Exception; }
    interface Retained { List<String> read() throws Exception; }
    static final class Outcome {
        final String status;
        final List<String> retainedUnattributed;
        Outcome(String status, List<String> names) { this.status = status; this.retainedUnattributed = new ArrayList<>(names); }
    }
    private static final class Record {
        String key, installation, receipt, generation;
        int nextStep;
        boolean complete;
        List<String> retained = new ArrayList<>();
    }
    private final Object authLock;
    private final Secrets secrets;
    private final Installation installation;
    private final MainOwner mainOwner;
    private final Preparation preparation;
    private final List<Step> steps;
    private final Retained retained;
    private final Generation generation;

    AccountClosureReceiptStore(Object authLock, Secrets secrets, Installation installation, MainOwner mainOwner,
                              Preparation preparation, List<Step> steps, Retained retained) {
        this(authLock, secrets, installation, mainOwner, preparation, steps, retained, (scope, capturing) -> "");
    }
    AccountClosureReceiptStore(Object authLock, Secrets secrets, Installation installation, MainOwner mainOwner,
                              Preparation preparation, List<Step> steps, Retained retained, Generation generation) {
        this.authLock = authLock; this.secrets = secrets; this.installation = installation; this.mainOwner = mainOwner;
        this.preparation = preparation; this.steps = new ArrayList<>(steps); this.retained = retained; this.generation = generation;
    }
    synchronized void put(Scope scope, String receipt) throws Failure {
        synchronized (authLock) {
            try {
                if (receipt == null || receipt.isEmpty() || utf8(receipt).length > 65536) throw new Failure("invalid_scope");
                requireOwner(scope, true);
                Record old = read(scope);
                if (old != null) {
                    if (!receipt.equals(old.receipt)) throw new Failure("scope_conflict");
                    return;
                }
                Record captured = new Record();
                captured.installation = installation.read(); captured.key = key(scope, captured.installation); captured.receipt = receipt;
                captured.generation = generation.read(scope, true);
                save(captured);
            } catch (Exception error) { throw publicFailure(error); }
        }
    }
    synchronized String get(Scope scope) throws Failure {
        synchronized (authLock) {
            try { requireOwner(scope, false); return require(scope).receipt; }
            catch (Exception error) { throw publicFailure(error); }
        }
    }
    synchronized void remove(Scope scope) throws Failure {
        synchronized (authLock) {
            try {
                requireOwner(scope, false);
                Record captured = require(scope); captured.receipt = null;
                // Keep the authenticated context tombstone for idempotent removal.
                save(captured);
            } catch (Exception error) { throw publicFailure(error); }
        }
    }
    synchronized Outcome eraseLocal(Scope scope) throws Failure {
        synchronized (authLock) {
            try {
                requireOwner(scope, false);
                Record captured = require(scope);
                if (captured.complete) return new Outcome("complete", captured.retained);
                if (captured.receipt == null) throw new Failure("receipt_missing");
                // Reject a stale bound scope before readiness can advance the fence.
                if (!captured.generation.isEmpty()) requireGeneration(scope, captured);
                // The platform rejects an absent preparation; false is reserved for
                // a still-draining, retryable preparation. Recheck after restart.
                if (!preparation.ready(scope)) return new Outcome("pending", retained.read());
                // put is authorized by local ownership alone, including before
                // preparation exists. Bind such a record on its first ready erase.
                if (captured.generation.isEmpty()) { captured.generation = generation.read(scope, false); save(captured); }
                requireGeneration(scope, captured);
                while (captured.nextStep < steps.size()) {
                    requireOwner(scope, false);
                    if (!steps.get(captured.nextStep).run(scope)) return new Outcome("pending", retained.read());
                    captured.nextStep++;
                    save(captured);
                }
                captured.retained = retained.read(); captured.complete = true; save(captured);
                return new Outcome("complete", captured.retained);
            } catch (Exception error) { throw publicFailure(error); }
        }
    }
    synchronized String requireCancelledReceipt(Scope scope) throws Failure {
        synchronized (authLock) {
            try {
                requireOwner(scope, true);
                Record captured = require(scope);
                if (captured.complete || captured.receipt != null) throw new Failure("scope_conflict");
                requireGeneration(scope, captured);
                return captured.generation;
            } catch (Exception error) { throw publicFailure(error); }
        }
    }
    private void requireGeneration(Scope scope, Record captured) throws Exception {
        if (!captured.generation.equals(generation.read(scope, false))) throw new Failure("scope_conflict");
    }
    private void requireOwner(Scope scope, boolean required) throws Exception {
        String owner = mainOwner.read();
        if ((required && !scope.ownerId.equals(owner)) || (owner != null && !scope.ownerId.equals(owner))) throw new Failure("wrong_local_owner");
    }
    private Record require(Scope scope) throws Exception {
        Record captured = read(scope);
        if (captured == null) throw new Failure("closure_context_missing");
        return captured;
    }
    private Record read(Scope scope) throws Exception {
        String install = installation.read(), key = key(scope, install);
        byte[] bytes = secrets.read(key);
        if (bytes == null) return null;
        if (bytes.length > 100000) throw new Failure("closure_storage_unavailable");
        Record captured = new Record();
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (input.readInt() != 2) throw new Failure("closure_storage_unavailable");
            captured.key = text(input, 64); captured.installation = text(input, 256); captured.generation = text(input, 128);
            captured.receipt = input.readBoolean() ? text(input, 65536) : null;
            captured.nextStep = input.readInt(); captured.complete = input.readBoolean();
            int count = input.readInt();
            if (count < 0 || count > 32) throw new Failure("closure_storage_unavailable");
            for (int i = 0; i < count; i++) captured.retained.add(text(input, 128));
            if (input.available() != 0 || !captured.key.equals(key) || !captured.installation.equals(install)
                || captured.nextStep < 0 || captured.nextStep > steps.size()
                || (captured.complete && captured.nextStep != steps.size())) throw new Failure("closure_storage_unavailable");
        }
        return captured;
    }
    private void save(Record captured) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream output = new DataOutputStream(bytes)) {
            output.writeInt(2); text(output, captured.key); text(output, captured.installation); text(output, captured.generation);
            output.writeBoolean(captured.receipt != null);
            if (captured.receipt != null) text(output, captured.receipt);
            output.writeInt(captured.nextStep); output.writeBoolean(captured.complete); output.writeInt(captured.retained.size());
            for (String item : captured.retained) {
                if (!item.matches("[a-z][a-z0-9-]{0,127}")) throw new Failure("closure_storage_unavailable");
                text(output, item);
            }
        }
        secrets.write(captured.key, bytes.toByteArray());
    }
    private static String text(DataInputStream input, int max) throws Exception {
        int count = input.readInt();
        if (count < 0 || count > max || count > input.available()) throw new Failure("closure_storage_unavailable");
        byte[] bytes = new byte[count]; input.readFully(bytes);
        String value = new String(bytes, StandardCharsets.UTF_8);
        if (!java.util.Arrays.equals(bytes, value.getBytes(StandardCharsets.UTF_8))) throw new Failure("closure_storage_unavailable");
        return value;
    }
    private static void text(DataOutputStream output, String value) throws Exception {
        byte[] bytes = utf8(value); output.writeInt(bytes.length); output.write(bytes);
    }
    private static byte[] utf8(String value) throws Failure {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (!new String(bytes, StandardCharsets.UTF_8).equals(value)) throw new Failure("invalid_scope");
        return bytes;
    }
    private static String key(Scope scope, String installation) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream output = new DataOutputStream(bytes)) {
            text(output, installation); text(output, scope.ownerId); text(output, scope.localOperationId);
        }
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray());
        StringBuilder hex = new StringBuilder(); for (byte value : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }
    private static Failure publicFailure(Exception error) {
        return error instanceof Failure ? (Failure) error : new Failure("closure_storage_unavailable");
    }
}
