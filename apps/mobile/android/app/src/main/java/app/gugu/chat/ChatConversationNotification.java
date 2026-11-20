package app.gugu.chat;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/**
 * #3416 One chat message as the system shows it: a conversation (the other person, or a group) and the message's own
 * author as a person. The renderer resolves names and draws the faces from the identity directory; nothing here
 * decides whose face it is. Pure: validation, bounds and the identifiers that keep accounts and conversations apart.
 */
final class ChatConversationNotification {
    static final int MAX_ID_CHARS = 256;
    static final int MAX_TITLE_CHARS = 120;
    static final int MAX_BODY_CHARS = 1000;
    /** A drawn face is a few KB; anything this large is not one, and is dropped rather than decoded. */
    static final int MAX_IMAGE_CHARS = 400_000;
    private static final String TAG_PREFIX = "gugu-chat:";
    private static final String SHORTCUT_PREFIX = "gugu-chat-";
    private static final String[] IMAGE_PREFIXES = {
        "data:image/png;base64,", "data:image/webp;base64,", "data:image/jpeg;base64,",
    };

    final String accountId;
    final String chatId;
    final String messageId;
    final long sentAt;
    final boolean group;
    final String title;
    final String body;
    /** Null for a deleted account. */
    final String authorId;
    /** As the renderer named the author: the chat's own unknown-member label when it is not known. Never the conversation. */
    final String authorName;
    private final String conversationImage;
    private final String authorImage;
    /** A refresh of the notification already showing for this message: never alerts again, never brings it back. */
    final boolean update;
    final boolean silent;

    private ChatConversationNotification(String accountId, String chatId, String messageId, long sentAt, boolean group,
            String title, String body, String authorId, String authorName, String conversationImage, String authorImage,
            boolean update, boolean silent) {
        this.accountId = accountId;
        this.chatId = chatId;
        this.messageId = messageId;
        this.sentAt = sentAt;
        this.group = group;
        this.title = title;
        this.body = body;
        this.authorId = authorId;
        this.authorName = authorName;
        this.conversationImage = conversationImage;
        this.authorImage = authorImage;
        this.update = update;
        this.silent = silent;
    }

    static ChatConversationNotification parse(String accountId, String chatId, String messageId, long sentAt, String kind,
            String title, String body, String authorId, String authorName, String conversationImage, String authorImage,
            boolean update, boolean silent) {
        requireId(accountId);
        requireId(chatId);
        requireId(messageId);
        if (!"dm".equals(kind) && !"group".equals(kind)) throw new IllegalArgumentException("Unknown conversation kind");
        if (title == null || title.trim().isEmpty()) throw new IllegalArgumentException("A conversation needs a name");
        if (authorId != null && authorId.length() > MAX_ID_CHARS) throw new IllegalArgumentException("Author id is too long");
        return new ChatConversationNotification(accountId, chatId, messageId,
            sentAt > 0 ? sentAt : System.currentTimeMillis(), "group".equals(kind),
            bounded(title.trim(), MAX_TITLE_CHARS), bounded(body == null ? "" : body, MAX_BODY_CHARS),
            authorId == null || authorId.isEmpty() ? null : authorId, authorName == null ? "" : bounded(authorName.trim(), MAX_TITLE_CHARS),
            base64Of(conversationImage), base64Of(authorImage), update, silent);
    }

    private static void requireId(String id) {
        if (id == null || id.isEmpty() || id.length() > MAX_ID_CHARS) throw new IllegalArgumentException("Invalid identifier");
    }

    private static String bounded(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max);
    }

    /** The base64 of a drawn PNG/WebP/JPEG data URL; null for anything else (a remote URL, SVG, empty, or too large). */
    private static String base64Of(String dataUrl) {
        if (dataUrl == null || dataUrl.length() > MAX_IMAGE_CHARS + IMAGE_PREFIXES[1].length()) return null;
        for (String prefix : IMAGE_PREFIXES) {
            if (dataUrl.startsWith(prefix)) {
                String base64 = dataUrl.substring(prefix.length());
                return base64.isEmpty() || base64.length() > MAX_IMAGE_CHARS ? null : base64;
            }
        }
        return null;
    }

    String conversationImage() { return conversationImage; }

    String authorImage() { return authorImage; }

    /** Everything this device keeps about one account is keyed by this, never by the raw account id. */
    String ownerKey() { return ownerKey(accountId); }

    /** Account ids are UUIDs; the push plugin hands them over lower-cased, so the key must not depend on case. */
    static String ownerKey(String accountId) { return hash(accountId.toLowerCase(Locale.ROOT), 16); }

    /** The long-lived conversation shortcut: stable per account and chat, so the system keeps one conversation. */
    String shortcutId() { return SHORTCUT_PREFIX + hash(ownerKey() + "\n" + chatId, 32); }

    /** One notification per message: a late picture refreshes this one in place. */
    String tag() { return TAG_PREFIX + ownerKey() + ":" + hash(chatId + "\n" + messageId, 16); }

    static boolean ownsTag(String tag, String accountId) {
        return tag != null && accountId != null && tag.startsWith(TAG_PREFIX + ownerKey(accountId) + ":");
    }

    /** The author as a person: stable per account and author, so a rename or a new picture is the same person. */
    String personKey() {
        return "gugu-person-" + ownerKey() + "-" + (authorId == null ? "deleted" : hash(authorId, 16));
    }

    private static String hash(String value, int hexChars) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format("%02x", b));
            return hex.substring(0, hexChars);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is required", error);
        }
    }
}
