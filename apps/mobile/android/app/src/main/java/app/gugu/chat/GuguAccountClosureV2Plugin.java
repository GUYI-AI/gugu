package app.gugu.chat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Independent V2 bridge: no receipt, owner/SID, target URL or server fact setters. */
@CapacitorPlugin(name = "GuguAccountClosureV2")
public class GuguAccountClosureV2Plugin extends Plugin {
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private AndroidAccountClosureV2Facade facade;
    private interface Action { JSObject run(AndroidAccountClosureV2Facade service) throws Exception; }
    private void perform(PluginCall call, Action action, String... allowed) {
        work.execute(() -> {
            try {
                exactKeys(call.getData(), allowed);
                if (facade == null) facade = new AndroidAccountClosureV2Facade(getContext());
                JSObject reply = action.run(facade);
                // Capacitor's resolve(null) means an empty response, so discovery uses an explicit wrapper.
                call.resolve(reply);
            } catch (Exception error) {
                Throwable failure = error;
                while ((failure instanceof java.util.concurrent.ExecutionException || failure instanceof java.util.concurrent.CompletionException)
                    && failure.getCause() != null) failure = failure.getCause();
                String code = failure instanceof AccountClosureReceiptStore.Failure ? ((AccountClosureReceiptStore.Failure)failure).code : "closure_unavailable";
                call.reject("Account closure could not be completed", publicCode(code));
            }
        });
    }
    private static String publicCode(String code) {
        if ("closure_v2_unavailable".equals(code)) return "closure_not_available";
        if ("closure_v2_pending".equals(code) || "recovery_required".equals(code)) return "closure_recovery_required";
        if ("challenge_required".equals(code)) return "closure_not_prepared";
        return new HashSet<>(Arrays.asList("closure_context_missing", "closure_not_prepared", "wrong_local_owner", "scope_conflict",
            "receipt_missing", "invalid_scope", "closure_storage_unavailable", "unauthorized", "invalid_request", "verification_failed",
            "rate_limited", "operation_busy", "request_active", "state_conflict", "not_found", "preparation_unavailable",
            "outcome_unknown", "email_outcome_unknown")).contains(code) ? code : "closure_unavailable";
    }
    private static void exactKeys(JSONObject object, String... allowed) throws Exception {
        Set<String> keys = new HashSet<>(Arrays.asList(allowed));
        if (object.length() != keys.size()) throw new AccountClosureReceiptStore.Failure("invalid_request");
        java.util.Iterator<String> found = object.keys();
        while (found.hasNext()) if (!keys.contains(found.next())) throw new AccountClosureReceiptStore.Failure("invalid_request");
    }
    private static AndroidAccountClosureV2Facade.Handle handle(PluginCall call) throws Exception {
        JSONObject h = call.getData().getJSONObject("handle");
        exactKeys(h, "localOperationId", "nativeGeneration", "localRevision");
        Object revision = h.get("localRevision"), operation = h.get("localOperationId"), generation = h.get("nativeGeneration");
        if (!(revision instanceof Number) || !(operation instanceof String) || !(generation instanceof String)
            || ((Number)revision).doubleValue() != ((Number)revision).longValue()) throw new AccountClosureReceiptStore.Failure("invalid_request");
        return new AndroidAccountClosureV2Facade.Handle((String)operation, (String)generation, ((Number)revision).longValue());
    }
    @PluginMethod public void readPolicy(PluginCall call) { perform(call, AndroidAccountClosureV2Facade::readPolicy); }
    @PluginMethod public void discover(PluginCall call) {
        perform(call, service -> {
            JSObject snapshot = service.discover();
            return new JSObject().put("snapshot", snapshot == null ? JSONObject.NULL : snapshot);
        });
    }
    @PluginMethod public void capture(PluginCall call) { perform(call, AndroidAccountClosureV2Facade::capture); }
    @PluginMethod public void sendCode(PluginCall call) { perform(call, service -> service.sendCode(handle(call)), "handle"); }
    @PluginMethod public void prepare(PluginCall call) { perform(call, service -> service.prepare(handle(call)), "handle"); }
    @PluginMethod public void recover(PluginCall call) { perform(call, service -> service.recover(handle(call)), "handle"); }
    @PluginMethod public void cancel(PluginCall call) { perform(call, service -> service.cancel(handle(call)), "handle"); }
    @PluginMethod public void finalizeOperation(PluginCall call) { perform(call, service -> service.finalizeOperation(handle(call)), "handle"); }
    @PluginMethod public void confirm(PluginCall call) {
        perform(call, service -> {
            Object code = call.getData().get("code"), consent = call.getData().get("acknowledgeForfeit");
            if (!(code instanceof String) || !Boolean.TRUE.equals(consent)) throw new AccountClosureReceiptStore.Failure("invalid_request");
            return service.confirm(handle(call), (String)code, true);
        }, "handle", "code", "acknowledgeForfeit");
    }
    @Override protected void handleOnDestroy() { work.shutdown(); }
}
