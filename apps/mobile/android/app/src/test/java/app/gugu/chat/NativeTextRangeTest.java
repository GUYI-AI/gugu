package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeTextRangeTest {
    @Test public void acceptsThePressedWordAfterAnEmoji() {
        String text = "🌅 harbor opens";
        assertTrue(NativeTextRange.valid(text, 3, 9));
        assertEquals("harbor", text.substring(3, 9));
    }
    @Test public void rejectsASelectionInsideASurrogatePair() {
        assertFalse(NativeTextRange.valid("🌅 harbor", 1, 2));
        assertFalse(NativeTextRange.valid("🌅 harbor", 0, 1));
        assertTrue(NativeTextRange.valid("🌅 harbor", 0, 2));
    }
    @Test public void rejectsMissingEmptyReversedAndOutOfBoundsRanges() {
        assertFalse(NativeTextRange.valid(null, 0, 1));
        assertFalse(NativeTextRange.valid("word", 0, 0));
        assertFalse(NativeTextRange.valid("word", 2, 1));
        assertFalse(NativeTextRange.valid("word", -1, 2));
        assertFalse(NativeTextRange.valid("word", 0, 5));
    }
}
