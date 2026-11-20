package app.gugu.chat;

import android.content.Context;
import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * #3416 The bridge for chat notifications drawn as conversations (see ChatConversationNotifications). The renderer
 * sends one message with its conversation and author already resolved from the identity directory; names and faces
 * are never part of what a push provider is sent.
 */
@CapacitorPlugin(name = "GuguChatNotifications")
public final class GuguChatNotificationsPlugin extends Plugin {
    @Override public void load() { opened(getActivity().getIntent()); }

    @PluginMethod public void show(PluginCall call) {
        ChatConversationNotification notification;
        try {
            JSObject conversation = call.getObject("conversation", new JSObject());
            JSObject author = call.getObject("author", new JSObject());
            notification = ChatConversationNotification.parse(
                call.getString("accountId"), conversation.getString("id"), call.getString("messageId"),
                call.getData().optLong("sentAt", 0L), conversation.getString("kind"), conversation.getString("name"),
                call.getString("body", ""), author.getString("id"), author.getString("name", ""),
                conversation.getString("avatar"), author.getString("avatar"),
                Boolean.TRUE.equals(call.getBoolean("update", false)), Boolean.TRUE.equals(call.getBoolean("silent", false)));
        } catch (IllegalArgumentException invalid) {
            call.reject("Invalid chat notification");
            return;
        }
        String channelId = call.getString("channelId");
        if (channelId == null || channelId.isEmpty()) {
            call.reject("Notification channel is required");
            return;
        }
        boolean displayed = ChatConversationNotifications.show(getContext(), notification, channelId);
        call.resolve(new JSObject().put("displayed", displayed));
    }

    /** Sign-out: everything this device holds for the account. Called with the push revocation, in the same order. */
    static void clear(Context context, String accountId) {
        ChatConversationNotifications.clear(context, accountId);
    }

    private void opened(Intent intent) {
        if (intent == null || !ChatConversationNotifications.ACTION_OPEN.equals(intent.getAction())) return;
        String chatId = intent.getStringExtra(ChatConversationNotifications.EXTRA_CHAT_ID);
        String accountId = intent.getStringExtra(ChatConversationNotifications.EXTRA_ACCOUNT_ID);
        intent.removeExtra(ChatConversationNotifications.EXTRA_CHAT_ID);
        intent.removeExtra(ChatConversationNotifications.EXTRA_ACCOUNT_ID);
        intent.setAction(Intent.ACTION_MAIN);
        if (chatId == null || chatId.isEmpty() || chatId.length() > ChatConversationNotification.MAX_ID_CHARS) return;
        JSObject data = new JSObject().put("chatId", chatId);
        if (accountId != null && accountId.length() <= ChatConversationNotification.MAX_ID_CHARS) data.put("accountId", accountId);
        // Kept until the renderer first listens: a tap that cold-starts the app is not lost.
        notifyListeners("opened", data, true);
    }

    @Override protected void handleOnNewIntent(Intent intent) { opened(intent); }
}
