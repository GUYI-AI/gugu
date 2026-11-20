package app.gugu.chat;

import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Strict native wire boundary. Fixed error categories only; no server bodies reach the bridge. */
final class AccountClosureV2Wire {
    static final String CONSENT = "immediate-forfeit-v1";
    private static final java.util.Set<String> ERRORS = new java.util.HashSet<>(Arrays.asList(
        "unauthorized", "unavailable", "invalid_request", "not_found", "scope_conflict", "operation_busy",
        "operation_active", "request_active", "state_conflict", "preparation_unavailable", "preparation_required", "preparation_cancelled",
        "verification_failed", "email_outcome_unknown", "outcome_unknown", "policy_unavailable", "feature_disabled",
        "account_ineligible", "consent_required", "challenge_expired", "challenge_required", "rate_limited"));
    static JSONObject policy(AccountClosureHttp.Reply reply) throws Exception {
        JSONObject body = successful(reply);
        if (reply.status != 200) throw failure("unavailable");
        JSONObject p = body.getJSONObject("policy");
        if (p.length() != 6 || integer(p, "protocol_version") != 2 || !(p.get("available") instanceof Boolean)
            || !"immediate".equals(p.get("deletion")) || !"forfeit_remaining".equals(p.get("credit_treatment"))
            || !CONSENT.equals(p.get("consent_version")) || !Boolean.TRUE.equals(p.get("device_preparation_required")))
            throw failure("unavailable");
        return p;
    }
    static boolean cancellationBlocked(AccountClosureHttp.Reply reply) {
        if (reply.status == 409) return true;
        try { return "request_active".equals(new JSONObject(reply.json()).opt("error")); }
        catch (Exception invalid) { return false; }
    }
    static AccountClosureV2Receiver.Reply operation(AccountClosureHttp.Reply http, String route) throws Exception {
        JSONObject body;
        if (http.status == 422 && "confirm".equals(route)) {
            body = new JSONObject(http.json());
            if (!"verification_failed".equals(body.opt("error"))) throw failure("unavailable");
        } else { body = successful(http); }
        JSONObject op = body.getJSONObject("operation");
        if (!Boolean.FALSE.equals(op.get("can_retry"))) throw failure("unavailable");
        AccountClosureV2Receiver.Reply result = new AccountClosureV2Receiver.Reply();
        result.httpStatus = http.status;
        result.operationId = string(op, "operation_id"); result.state = string(op, "state");
        result.revision = integer(op, "revision");
        long challenge = integer(op, "challenge_generation");
        if (challenge < 0 || challenge > Integer.MAX_VALUE) throw failure("unavailable");
        result.challengeGeneration = (int)challenge;
        result.requestId = nullableString(op, "request_id");
        if (op.opt("request") instanceof JSONObject) {
            JSONObject request = op.getJSONObject("request");
            if (result.requestId != null && result.requestId.equals(request.opt("request_id"))
                && "challenge".equals(request.opt("state")) && request.has("last_error") && request.isNull("last_error")
                && request.opt("can_retry") instanceof Boolean && request.opt("expires_at") instanceof String) {
                long expiry = expiry((String)request.get("expires_at"));
                if (expiry > 0) { result.knownSentRequest = true; result.challengeExpiresAt = expiry; }
            }
        }
        if ("open".equals(result.state) && ("confirm".equals(route) || "result".equals(route)) && op.opt("confirmation") instanceof JSONObject) {
            JSONObject confirmation = op.getJSONObject("confirmation");
            if ("rejected".equals(confirmation.opt("state"))) {
                if (!"verification_failed".equals(confirmation.opt("error_code"))) throw failure("unavailable");
                result.rejectedConfirmation = true;
                result.rejectedConfirmationId = string(confirmation, "confirmation_id");
                long generation = integer(confirmation, "challenge_generation");
                if (generation < 1 || generation > Integer.MAX_VALUE) throw failure("unavailable");
                result.rejectedChallengeGeneration = (int)generation;
            }
        }
        if (op.has("can_release_preparation")) {
            if (!(op.get("can_release_preparation") instanceof Boolean)) throw failure("unavailable");
            result.canReleasePreparation = op.getBoolean("can_release_preparation");
        }
        if (body.has("preparation")) {
            JSONObject p = body.getJSONObject("preparation");
            result.hasPreparation = true; result.nativeGeneration = string(p, "native_generation");
            result.serverGeneration = nullableString(p, "server_generation");
            if ("prepare_device".equals(route)) {
                if (!Boolean.TRUE.equals(p.get("prepared"))) throw failure("unavailable");
                result.prepared = true;
                if (p.has("cancelled") && !Boolean.FALSE.equals(p.get("cancelled"))) throw failure("unavailable");
            } else if ("cancel".equals(route)) {
                if (!Boolean.TRUE.equals(p.get("cancelled"))) throw failure("unavailable");
                result.cancelled = true;
                if (p.has("prepared") && !Boolean.FALSE.equals(p.get("prepared"))) throw failure("unavailable");
            } else {
                if (Boolean.TRUE.equals(p.opt("cancelled")) && !p.has("prepared")
                    && result.canReleasePreparation && "closed_before_confirm".equals(result.state)) {
                    // The persisted unprepared-cancel tombstone has the same explicit-null ACK as cancel.
                    result.cancelled = true;
                } else {
                    if (!(p.get("prepared") instanceof Boolean) || !(p.get("cancelled") instanceof Boolean)) throw failure("unavailable");
                    result.prepared = p.getBoolean("prepared"); result.cancelled = p.getBoolean("cancelled");
                }
            }
        }
        result.validate(); return result;
    }
    static byte[] body(AccountClosureOperationV2.Metadata operation, String receipt) throws Exception {
        return encode(new JSONObject().put("local_operation_id", operation.localOperationId).put("receipt_token", receipt));
    }
    static JSONObject binding(AccountClosureOperationV2.Metadata operation, String receipt) throws Exception {
        return new JSONObject().put("local_operation_id", operation.localOperationId).put("receipt_token", receipt);
    }
    static byte[] encode(JSONObject object) throws Exception {
        byte[] bytes = object.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > AccountClosureHttp.MAX_REQUEST_BYTES) throw failure("invalid_request");
        return bytes;
    }
    private static JSONObject successful(AccountClosureHttp.Reply reply) throws Exception {
        JSONObject body;
        try { body = new JSONObject(reply.json()); }
        catch (Exception invalid) { throw failure("unavailable"); }
        if (reply.status != 200 && reply.status != 201 && reply.status != 202) {
            Object error = body.opt("error");
            throw failure(error instanceof String && ERRORS.contains(error) ? (String)error : "unavailable");
        }
        return body;
    }
    private static long integer(JSONObject object, String key) throws Exception {
        Object raw = object.get(key);
        if (!(raw instanceof Number)) throw failure("unavailable");
        double number = ((Number)raw).doubleValue(); long integer = ((Number)raw).longValue();
        if (!Double.isFinite(number) || number != integer || integer > 9007199254740991L || integer < 0) throw failure("unavailable");
        return integer;
    }
    private static String string(JSONObject object, String key) throws Exception {
        Object value = object.get(key); if (!(value instanceof String)) throw failure("unavailable"); return (String)value;
    }
    private static String nullableString(JSONObject object, String key) throws Exception {
        if (object.isNull(key) && object.has(key)) return null;
        return string(object, key);
    }
    private static long expiry(String text) {
        // PostgreSQL's ISO offset timestamp, including microsecond fractions, on API 24+.
        java.util.regex.Matcher match = java.util.regex.Pattern.compile("([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})").matcher(text);
        if (!match.matches()) return 0;
        String fraction = ((match.group(2) == null ? "" : match.group(2)) + "000").substring(0, 3);
        String normalized = match.group(1) + "." + fraction + match.group(3);
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", java.util.Locale.ROOT);
        format.setLenient(false); java.text.ParsePosition position = new java.text.ParsePosition(0);
        java.util.Date parsed = format.parse(normalized, position);
        return parsed != null && position.getIndex() == normalized.length() ? parsed.getTime() : 0;
    }
    private static AccountClosureReceiptStore.Failure failure(String code) { return new AccountClosureReceiptStore.Failure(code); }
}
