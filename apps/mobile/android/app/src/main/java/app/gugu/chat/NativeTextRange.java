package app.gugu.chat;

/** The web/native bridge indexes text in UTF-16 on both sides. */
final class NativeTextRange {
    private NativeTextRange() {}

    static boolean valid(String text, int start, int end) {
        return text != null && start >= 0 && start < end && end <= text.length()
                && boundary(text, start) && boundary(text, end);
    }

    private static boolean boundary(String text, int at) {
        return at == 0 || at == text.length()
                || !Character.isHighSurrogate(text.charAt(at - 1))
                || !Character.isLowSurrogate(text.charAt(at));
    }
}
