package app.gugu.chat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;

import org.junit.Test;
import org.junit.runner.RunWith;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

@RunWith(AndroidJUnit4.class)
@SdkSuppress(minSdkVersion = Build.VERSION_CODES.O)
public class NotificationChannelsTest {
    @Test
    public void soundOffKeepsAnInterruptiveVibratingChannel() {
        NotificationChannel channel = GuguNotificationChannelsPlugin.quietChannel("Silent alerts");

        assertNotEquals("gugu-alerts-quiet", channel.getId());
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.getImportance());
        assertTrue(channel.shouldVibrate());
        assertNull(channel.getSound());
    }
}
