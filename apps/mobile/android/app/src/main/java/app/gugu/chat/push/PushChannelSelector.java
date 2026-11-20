package app.gugu.chat.push;

import java.util.Locale;
import java.util.Set;

public final class PushChannelSelector {
    private PushChannelSelector() {}
    public static String select(String manufacturer, Set<String> available, boolean googleServices) {
        String name = manufacturer == null ? "" : manufacturer.toLowerCase(Locale.ROOT);
        String preferred = switch (name) {
            case "huawei" -> "huawei";
            case "honor" -> "honor";
            case "xiaomi", "redmi" -> "xiaomi";
            case "oppo", "oneplus", "realme" -> "oppo";
            case "vivo", "iqoo" -> "vivo";
            default -> null;
        };
        if (preferred != null && available.contains(preferred)) return preferred;
        return googleServices && available.contains("fcm") ? "fcm" : null;
    }
}
