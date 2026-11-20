package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class ChatConversationNotificationTest {
    private static final String PNG = "data:image/png;base64,iVBORw0KGgo=";

    private static ChatConversationNotification dm() {
        return ChatConversationNotification.parse("account-1", "chat-1", "message-1", 1_767_225_600_000L, "dm",
            "Peer", "hello", "peer-1", "Peer", PNG, PNG, false, false);
    }

    private static ChatConversationNotification group(String authorId, String authorName) {
        return ChatConversationNotification.parse("account-1", "group-1", "message-2", 1_767_225_600_000L, "group",
            "Team", "hi all", authorId, authorName, PNG, PNG, false, true);
    }

    @Test public void aDirectConversationIsNotAGroup() {
        assertFalse(dm().group);
        assertTrue(group("ann", "Ann").group);
    }

    @Test public void theConversationShortcutIsStablePerAccountAndChat() {
        ChatConversationNotification first = dm();
        ChatConversationNotification second = ChatConversationNotification.parse("account-1", "chat-1", "message-9", 1L, "dm",
            "Renamed", "later", "peer-1", "Peer", null, null, false, false);
        assertEquals(first.shortcutId(), second.shortcutId());
        ChatConversationNotification otherChat = ChatConversationNotification.parse("account-1", "chat-2", "message-1", 1L, "dm",
            "Peer", "hello", "peer-1", "Peer", null, null, false, false);
        ChatConversationNotification otherAccount = ChatConversationNotification.parse("account-2", "chat-1", "message-1", 1L, "dm",
            "Peer", "hello", "peer-1", "Peer", null, null, false, false);
        assertNotEquals(first.shortcutId(), otherChat.shortcutId());
        assertNotEquals(first.shortcutId(), otherAccount.shortcutId());
        assertFalse("ids are opaque: no raw account or chat id", first.shortcutId().contains("account-1") || first.shortcutId().contains("chat-1"));
    }

    @Test public void accountIdsAreKeyedWithoutRegardToCase() {
        ChatConversationNotification upper = ChatConversationNotification.parse("66A943DD-7452-412C-BFCA-1B4F74346C46", "chat-1", "m", 1L, "dm",
            "Peer", "hello", null, "", null, null, false, false);
        assertTrue(ChatConversationNotification.ownsTag(upper.tag(), "66a943dd-7452-412c-bfca-1b4f74346c46"));
        assertEquals(upper.shortcutId(), ChatConversationNotification.parse("66a943dd-7452-412c-bfca-1b4f74346c46", "chat-1", "m", 1L, "dm",
            "Peer", "hello", null, "", null, null, false, false).shortcutId());
    }

    @Test public void oneNotificationPerMessageSoALatePictureRefreshesTheSameOne() {
        ChatConversationNotification shown = dm();
        ChatConversationNotification refreshed = ChatConversationNotification.parse("account-1", "chat-1", "message-1", 1_767_225_600_000L, "dm",
            "Peer", "hello", "peer-1", "Peer", PNG, PNG, true, false);
        ChatConversationNotification next = ChatConversationNotification.parse("account-1", "chat-1", "message-2", 1L, "dm",
            "Peer", "again", "peer-1", "Peer", null, null, false, false);
        assertEquals(shown.tag(), refreshed.tag());
        assertTrue(refreshed.update);
        assertNotEquals(shown.tag(), next.tag());
    }

    @Test public void signOutOwnsOnlyThatAccountsNotifications() {
        ChatConversationNotification mine = dm();
        assertTrue(ChatConversationNotification.ownsTag(mine.tag(), "account-1"));
        assertFalse(ChatConversationNotification.ownsTag(mine.tag(), "account-2"));
        assertFalse(ChatConversationNotification.ownsTag(null, "account-1"));
        assertFalse(ChatConversationNotification.ownsTag("13226587-813a-4e58-a023-dc419aeab890", "account-1"));
    }

    @Test public void eachAuthorIsAPersonOfTheirOwnAndAnUnknownOneIsNeverInvented() {
        assertNotEquals(group("ann", "Ann").personKey(), group("bob", "Bob").personKey());
        assertEquals(group("ann", "Ann").personKey(), group("ann", "Ann (renamed)").personKey());
        // Unknown or deleted author: the conversation's own name stands in; nothing is made up.
        assertEquals("Team", group("ghost", "").shownAuthorName());
        assertEquals("Team", group(null, "").shownAuthorName());
        assertEquals("Ann", group("ann", "Ann").shownAuthorName());
        assertNotEquals(group("ghost", "").personKey(), group(null, "").personKey());
    }

    @Test public void onlyADrawnImageIsAcceptedAndAnythingElseCountsAsUnavailable() {
        assertEquals("iVBORw0KGgo=", dm().conversationImage());
        assertNull(ChatConversationNotification.parse("account-1", "chat-1", "message-1", 1L, "dm", "Peer", "hello", "peer-1", "Peer",
            null, "https://cdn.example/a.png", false, false).authorImage());
        assertNull(ChatConversationNotification.parse("account-1", "chat-1", "message-1", 1L, "dm", "Peer", "hello", "peer-1", "Peer",
            "data:image/svg+xml;utf8,%3Csvg", "data:text/html;base64,AAAA", false, false).conversationImage());
        assertNull(ChatConversationNotification.parse("account-1", "chat-1", "message-1", 1L, "dm", "Peer", "hello", "peer-1", "Peer",
            "data:image/png;base64,", null, false, false).conversationImage());
    }

    @Test public void anOversizedImageIsDroppedRatherThanRejectingTheNotification() {
        StringBuilder huge = new StringBuilder("data:image/webp;base64,");
        for (int i = 0; i <= ChatConversationNotification.MAX_IMAGE_CHARS; i++) huge.append('A');
        ChatConversationNotification big = ChatConversationNotification.parse("account-1", "chat-1", "message-1", 1L, "dm", "Peer", "hello",
            "peer-1", "Peer", huge.toString(), PNG, false, false);
        assertNull(big.conversationImage());
        assertEquals("iVBORw0KGgo=", big.authorImage());
    }

    @Test public void malformedRequestsAreRefusedBeforeAnythingIsShown() {
        assertThrows(IllegalArgumentException.class, () -> ChatConversationNotification.parse("", "chat-1", "m", 1L, "dm", "t", "b", null, "", null, null, false, false));
        assertThrows(IllegalArgumentException.class, () -> ChatConversationNotification.parse("a", "", "m", 1L, "dm", "t", "b", null, "", null, null, false, false));
        assertThrows(IllegalArgumentException.class, () -> ChatConversationNotification.parse("a", "c", "", 1L, "dm", "t", "b", null, "", null, null, false, false));
        assertThrows(IllegalArgumentException.class, () -> ChatConversationNotification.parse("a", "c", "m", 1L, "topic", "t", "b", null, "", null, null, false, false));
        assertThrows(IllegalArgumentException.class, () -> ChatConversationNotification.parse("a", "c", "m", 1L, "dm", " ", "b", null, "", null, null, false, false));
        char[] longId = new char[ChatConversationNotification.MAX_ID_CHARS + 1];
        java.util.Arrays.fill(longId, 'x');
        assertThrows(IllegalArgumentException.class, () -> ChatConversationNotification.parse("a", new String(longId), "m", 1L, "dm", "t", "b", null, "", null, null, false, false));
    }

    @Test public void aMissingTimeFallsBackToTheNowAndTextIsBounded() {
        ChatConversationNotification now = ChatConversationNotification.parse("a", "c", "m", 0L, "dm", "t", "b", null, "", null, null, false, false);
        assertTrue(now.sentAt > 0);
        StringBuilder long_ = new StringBuilder();
        for (int i = 0; i < ChatConversationNotification.MAX_BODY_CHARS + 50; i++) long_.append('x');
        assertEquals(ChatConversationNotification.MAX_BODY_CHARS,
            ChatConversationNotification.parse("a", "c", "m", 1L, "dm", "t", long_.toString(), null, "", null, null, false, false).body.length());
    }

    @Test public void silentOnlyMutesTheSound() {
        assertTrue(group("ann", "Ann").silent);
        assertFalse(dm().silent);
    }
}
