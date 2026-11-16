package app.gugu.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.IBinder;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Owns the Node process. Neither the Pi loop nor its native tools need a WebView. */
public class GuguAgentService extends Service {
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private volatile Process node;
    private volatile BufferedWriter commands;
    private static final Object LOCK = new Object();
    private static JSObject snapshot = new JSObject();
    private static boolean running;
    private static String claimedOwner;
    private static java.util.concurrent.CompletableFuture<Void> exited = java.util.concurrent.CompletableFuture.completedFuture(null);
    private static volatile GuguAgentService active;
    private String owner;
    private volatile boolean cancelled;

    static SharedPreferences permissions(Context context) {
        GuguPhoneInstallation.identity(context);
        return context.getSharedPreferences("phone-agent-grants", MODE_PRIVATE);
    }
    static JSObject readState(Context context, String ownerId) throws Exception {
        synchronized (LOCK) {
            if (ownerId.equals(snapshot.optString("ownerId"))) {
                JSObject current = new JSObject(snapshot.toString());
                if (!running && "running".equals(current.optString("status"))) current.put("status", "interrupted");
                return current;
            }
            File file = stateFile(context, ownerId);
            if (!file.exists()) return new JSObject().put("status", "idle").put("events", new JSONArray());
            JSObject saved = new JSObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            if ("running".equals(saved.optString("status"))) saved.put("status", "interrupted");
            return saved;
        }
    }
    private static File stateFile(Context context, String ownerId) { return new File(context.getFilesDir(), "phone-agent/" + ownerId + "/state.json"); }
    static boolean claim(String owner) {
        synchronized (LOCK) { if (running) return false; running = true; claimedOwner = owner; exited = new java.util.concurrent.CompletableFuture<>(); return true; }
    }
    static boolean isRunning() { synchronized (LOCK) { return running; } }
    static void release() { finish(null); }
    private static void finish(Throwable failure) {
        java.util.concurrent.CompletableFuture<Void> completion;
        synchronized (LOCK) {
            completion = exited;
            if (failure == null) { running = false; claimedOwner = null; }
        }
        if (failure == null) completion.complete(null); else completion.completeExceptionally(failure);
    }
    static boolean ownerIsBusy(String owner) { synchronized (LOCK) { return running && owner.equals(claimedOwner); } }
    static java.util.concurrent.CompletableFuture<Void> stopOwnerAndWait(String owner) {
        java.util.concurrent.CompletableFuture<Void> completion;
        synchronized (LOCK) { if (!running || !owner.equals(claimedOwner)) return java.util.concurrent.CompletableFuture.completedFuture(null); completion = exited; }
        GuguAgentService service = active;
        if (service != null) {
            service.cancelled = true; service.send(new JSObject().put("type", "cancel"));
            Process child = service.node; if (child != null) child.destroy();
        }
        return completion;
    }
    static void forgetClosedOwner(String owner) { synchronized (LOCK) { if (owner.equals(snapshot.optString("ownerId"))) snapshot = new JSObject(); } }
    @Override public void onCreate() { super.onCreate(); active = this; }
    static void clearState(Context context, String ownerId) throws Exception {
        synchronized (LOCK) {
            if (running) throw new IllegalStateException("请先取消正在运行的任务");
            Files.deleteIfExists(stateFile(context, ownerId).toPath());
            if (ownerId.equals(snapshot.optString("ownerId"))) snapshot = new JSObject();
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        if ("cancel".equals(intent.getAction())) { cancelled = true; send(new JSObject().put("type", "cancel")); return START_NOT_STICKY; }
        cancelled = false;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("phone-agent", "手机任务", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        startForeground(7561, new Notification.Builder(this, "phone-agent").setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("咕咕正在这台手机上处理任务").setContentText("点此查看进度或取消").setContentIntent(open).build());
        String body = intent.getStringExtra("command");
        work.execute(() -> run(body, startId));
        return START_NOT_STICKY;
    }

    private void run(String body, int startId) {
        try {
            JSObject command = new JSObject(body);
            AccountClosurePreparation.requireOpen(this, command.getString("ownerId"));
            owner = command.getString("ownerId");
            synchronized (LOCK) { snapshot = new JSObject().put("ownerId", owner).put("sessionId", command.getString("sessionId"))
                .put("status", "running").put("text", "").put("events", new JSONArray()); }
            persist();
            node = GuguAgentRuntime.start(this, owner);
            commands = new BufferedWriter(new OutputStreamWriter(node.getOutputStream(), StandardCharsets.UTF_8));
            Thread stderr = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(node.getErrorStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) android.util.Log.w("GuguAgent", line);
                } catch (Exception ignored) { /* pipe closes when this service destroys its child */ }
            }, "phone-agent-stderr");
            stderr.start();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(node.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    JSObject event = new JSObject(line);
                    String type = event.optString("type");
                    if ("ready".equals(type)) { command.put("type", "run").put("cancelled", cancelled); send(command); }
                    else if ("native_tool".equals(type)) executeTool(event);
                    record(event);
                    if ("done".equals(type) || "failed".equals(type) || "cancelled".equals(type)) break;
                }
            }
            synchronized (LOCK) {
                if ("running".equals(snapshot.optString("status"))) record(new JSObject().put("type", "failed").put("message", "手机运行时意外退出，请检查设备日志"));
            }
        } catch (Exception error) {
            record(new JSObject().put("type", "failed").put("message", error.toString()));
        } finally {
            Throwable failure = null;
            Process child = node;
            if (child != null) {
                child.destroy();
                try {
                    if (!child.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                        child.destroyForcibly();
                        if (!child.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) failure = new IllegalStateException("Phone runtime has not exited");
                    }
                } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); failure = interrupted; }
            }
            if (failure == null) node = null;
            commands = null;
            finish(failure);
            stopSelf(startId);
        }
    }

    private void executeTool(JSObject event) {
        JSObject result;
        try {
            if (!"calendar.events.list".equals(event.getString("name"))) throw new IllegalArgumentException("未登记的手机工具");
            requireCalendarGrant();
            JSONObject args = event.getJSONObject("args");
            long[] range = CalendarReadRange.resolve(args.has("date") ? args.getString("date") : null,
                args.has("start") ? args.getString("start") : null, args.has("end") ? args.getString("end") : null,
                java.time.ZoneId.systemDefault(), java.time.Instant.now());
            JSObject data = PhoneCalendarReader.read(this, range[0], range[1], args.optInt("limit", 100));
            requireCalendarGrant();
            result = new JSObject().put("ok", true).put("data", data);
        } catch (Exception error) {
            result = new JSObject().put("ok", false).put("code", error instanceof ToolNotGranted ? "not_granted" : error instanceof SecurityException ? "os_permission" : "execution_failed").put("message", error.getMessage());
        }
        send(new JSObject().put("type", "tool_result").put("id", event.optString("id")).put("result", result));
    }
    private void requireCalendarGrant() {
        SharedPreferences prefs = permissions(this);
        if (!owner.equals(prefs.getString("owner", "")) || !prefs.getBoolean("calendar", false)) throw new ToolNotGranted();
    }
    private static class ToolNotGranted extends SecurityException {
        ToolNotGranted() { super("请在咕咕「我的 → 这台手机」开启日历授权"); }
    }
    private void send(JSObject value) {
        synchronized (this) {
            try { if (commands != null) { commands.write(value.toString()); commands.newLine(); commands.flush(); } }
            catch (Exception error) { record(new JSObject().put("type", "failed").put("message", error.toString())); }
        }
    }
    private void record(JSObject event) {
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            synchronized (LOCK) {
                try { if (owner != null) AccountClosurePreparation.requireWritableState(this, owner); }
                catch (Exception refused) { return; }
                String type = event.optString("type");
                if ("text".equals(type)) snapshot.put("text", snapshot.optString("text") + event.optString("text"));
                else {
                    if (!snapshot.has("events")) snapshot.put("events", new JSONArray());
                    snapshot.optJSONArray("events").put(event);
                }
                if ("done".equals(type) || "failed".equals(type) || "cancelled".equals(type)) snapshot.put("status", type);
                persist();
            }
        }
    }

    private void persist() {
        if (owner == null) return;
        try {
            File target = stateFile(this, owner);
            target.getParentFile().mkdirs();
            DurableFile.write(target, snapshot.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) { android.util.Log.e("GuguAgent", "Cannot persist local agent state", error); }
    }
    @Override public void onDestroy() {
        if (node != null) node.destroy();
        work.shutdown();
        if (active == this) active = null;
        // The worker acknowledges real process exit; onDestroy is not proof.
        super.onDestroy();
    }
}
