package app.gugu.chat;

import android.annotation.SuppressLint;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Shader;
import android.net.Uri;
import android.os.Build;
import android.os.PersistableBundle;
import android.service.notification.StatusBarNotification;
import android.util.Base64;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.content.LocusIdCompat;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import java.util.ArrayList;
import java.util.List;

/**
 * #3416 Posts a chat message as an Android conversation notification: MessagingStyle with the real author as a Person
 * per message, backed by a long-lived conversation shortcut whose icon is the conversation's face (the other person
 * for a direct chat, the group's picture for a group). Faces arrive drawn by the renderer from the identity
 * directory; this class only shows them. A face that is missing or unreadable is shown as the unavailable state,
 * never as another identity's picture.
 */
final class ChatConversationNotifications {
    static final String ACTION_OPEN = "app.gugu.chat.OPEN_CHAT_NOTIFICATION";
    static final String EXTRA_CHAT_ID = "chatId";
    static final String EXTRA_ACCOUNT_ID = "accountId";
    private static final String EXTRA_OWNER = "gugu_owner";
    private static final String TAG = "GuguChatNotifications";
    /** The notification's tag is the identity; one fixed id. */
    private static final int NOTIFICATION_ID = 0x6767;
    private static final int UNAVAILABLE_FACE_PX = 192;
    /** A drawn face is at most a few hundred px; larger is not one. */
    private static final int MAX_FACE_PX = 1024;

    private ChatConversationNotifications() {}

    /** True when the notification is showing (or was refreshed in place). */
    @SuppressLint("MissingPermission") // areNotificationsEnabled() is checked first; a denial still surfaces as SecurityException below.
    static boolean show(Context context, ChatConversationNotification n, String channelId) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return false;
        // A late picture refreshes the notification that is still up: it never brings back one the person dismissed.
        if (n.update && !isShowing(context, n.tag())) return false;

        Bitmap conversationFace = decodeFace(n.conversationImage());
        Bitmap authorFace = decodeFace(n.authorImage());
        IconCompat conversationIcon = IconCompat.createWithBitmap(conversationFace != null ? conversationFace : unavailableFace());
        IconCompat authorIcon = IconCompat.createWithBitmap(authorFace != null ? authorFace : unavailableFace());

        Person self = new Person.Builder()
            .setName(context.getApplicationInfo().loadLabel(context.getPackageManager()))
            .setKey("gugu-self-" + n.ownerKey())
            .build();
        Person author = new Person.Builder()
            .setName(n.authorName)
            .setKey(n.personKey())
            .setIcon(authorIcon)
            .build();

        Intent open = openIntent(context, n);
        boolean conversation = publishShortcut(context, n, conversationIcon, author, open);

        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(self);
        if (n.group) style.setConversationTitle(n.title).setGroupConversation(true);
        style.addMessage(new NotificationCompat.MessagingStyle.Message(n.body, n.sentAt, author));

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setSmallIcon(smallIcon(context))
            .setStyle(style)
            .setContentText(n.body)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setWhen(n.sentAt)
            .setShowWhen(true)
            .setAutoCancel(true)
            // The first alert is the only one: a refreshed face never rings or vibrates again.
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            // Before Android 9 the conversation's face is the large icon; later versions draw it from the shortcut.
            .setLargeIcon(conversationFace != null ? conversationFace : unavailableFace())
            .setContentIntent(PendingIntent.getActivity(context, n.tag().hashCode(), open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        if (conversation) builder.setShortcutId(n.shortcutId()).setLocusId(new LocusIdCompat(n.shortcutId()));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Before channels existed, sound and vibration are the notification's own.
            builder.setDefaults(n.silent ? NotificationCompat.DEFAULT_VIBRATE : NotificationCompat.DEFAULT_ALL);
        }
        try {
            manager.notify(n.tag(), NOTIFICATION_ID, builder.build());
            return true;
        } catch (SecurityException denied) {
            return false;
        }
    }

    /** Removes what this device holds for one account: its notifications and its conversation shortcuts. */
    static void clear(Context context, String accountId) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            for (StatusBarNotification shown : manager.getActiveNotifications()) {
                if (ChatConversationNotification.ownsTag(shown.getTag(), accountId)) manager.cancel(shown.getTag(), shown.getId());
            }
        }
        try {
            String owner = ChatConversationNotification.ownerKey(accountId);
            List<String> ids = new ArrayList<>();
            for (ShortcutInfoCompat shortcut : ShortcutManagerCompat.getShortcuts(context,
                    ShortcutManagerCompat.FLAG_MATCH_DYNAMIC | ShortcutManagerCompat.FLAG_MATCH_CACHED)) {
                PersistableBundle extras = shortcut.getExtras();
                if (extras != null && owner.equals(extras.getString(EXTRA_OWNER))) ids.add(shortcut.getId());
            }
            if (!ids.isEmpty()) ShortcutManagerCompat.removeLongLivedShortcuts(context, ids);
        } catch (RuntimeException failure) {
            Log.w(TAG, "Cannot remove conversation shortcuts", failure);
        }
    }

    static Intent openIntent(Context context, ChatConversationNotification n) {
        return new Intent(context, MainActivity.class)
            .setAction(ACTION_OPEN)
            // Unique per notification: PendingIntents match on action and data, not on extras.
            .setData(Uri.parse("gugu-chat-notification:" + n.tag()))
            .putExtra(EXTRA_CHAT_ID, n.chatId)
            .putExtra(EXTRA_ACCOUNT_ID, n.accountId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    private static boolean publishShortcut(Context context, ChatConversationNotification n, IconCompat icon, Person author, Intent open) {
        try {
            PersistableBundle extras = new PersistableBundle();
            extras.putString(EXTRA_OWNER, n.ownerKey());
            ShortcutInfoCompat.Builder shortcut = new ShortcutInfoCompat.Builder(context, n.shortcutId())
                .setShortLabel(n.title)
                .setLongLived(true)
                .setIsConversation()
                .setIcon(icon)
                .setIntent(open)
                .setLocusId(new LocusIdCompat(n.shortcutId()))
                .setExtras(extras);
            // A direct conversation is about one person; a group's members are not listed here.
            if (!n.group) shortcut.setPerson(author);
            return ShortcutManagerCompat.pushDynamicShortcut(context, shortcut.build());
        } catch (RuntimeException failure) {
            // Locked user or a shortcut limit: the message is still shown, as a plain notification.
            Log.w(TAG, "Cannot publish the conversation shortcut", failure);
            return false;
        }
    }

    private static boolean isShowing(Context context, String tag) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;
        for (StatusBarNotification shown : manager.getActiveNotifications()) {
            if (tag.equals(shown.getTag()) && shown.getId() == NOTIFICATION_ID) return true;
        }
        return false;
    }

    private static int smallIcon(Context context) {
        int icon = context.getResources().getIdentifier("ic_stat_gugu", "drawable", context.getPackageName());
        return icon != 0 ? icon : context.getApplicationInfo().icon;
    }

    /** A drawn face as a round bitmap; null when it is absent, malformed or not the size of a face. */
    private static Bitmap decodeFace(String base64) {
        if (base64 == null) return null;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > MAX_FACE_PX || bounds.outHeight > MAX_FACE_PX) return null;
            Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            return decoded == null ? null : round(decoded);
        } catch (IllegalArgumentException | OutOfMemoryError malformed) {
            return null;
        }
    }

    private static Bitmap round(Bitmap square) {
        int side = Math.min(square.getWidth(), square.getHeight());
        Bitmap out = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new BitmapShader(Bitmap.createBitmap(square, (square.getWidth() - side) / 2, (square.getHeight() - side) / 2, side, side),
            Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        new Canvas(out).drawCircle(side / 2f, side / 2f, side / 2f, paint);
        return out;
    }

    /** The explicit "picture unavailable" face: a neutral disc, never another identity's picture. */
    private static Bitmap unavailableFace() {
        Bitmap out = Bitmap.createBitmap(UNAVAILABLE_FACE_PX, UNAVAILABLE_FACE_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        float half = UNAVAILABLE_FACE_PX / 2f;
        paint.setColor(0xFF8E8E93);
        canvas.drawCircle(half, half, half, paint);
        paint.setColor(0xFFC7C7CC);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(6f);
        canvas.drawCircle(half, half, half - 3f, paint);
        return out;
    }
}
