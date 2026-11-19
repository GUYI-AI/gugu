package app.gugu.chat.push;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Collections;
import org.junit.Test;
import static org.junit.Assert.*;

public class PushChannelSelectorTest {
    @Test public void prefersExactlyOneAvailableVendor() {
        for (String[] pair : new String[][] { {"HUAWEI","huawei"}, {"HONOR","honor"}, {"Xiaomi","xiaomi"},
            {"Redmi","xiaomi"}, {"OPPO","oppo"}, {"OnePlus","oppo"}, {"realme","oppo"}, {"vivo","vivo"}, {"iQOO","vivo"} }) {
            assertEquals(pair[1], PushChannelSelector.select(pair[0], new HashSet<>(Arrays.asList(pair[1], "fcm")), true));
            assertEquals("fcm", PushChannelSelector.select(pair[0], Collections.singleton("fcm"), true));
            assertNull(PushChannelSelector.select(pair[0], Collections.singleton("fcm"), false));
        }
    }
    @Test public void noConfiguredChannelStaysUnavailable() {
        assertNull(PushChannelSelector.select("OnePlus", Collections.emptySet(), true));
        assertEquals("fcm", PushChannelSelector.select("Google", Collections.singleton("fcm"), true));
    }
}
