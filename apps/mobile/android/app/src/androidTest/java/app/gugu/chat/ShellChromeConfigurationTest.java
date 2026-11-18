package app.gugu.chat;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Exercises Capacitor's real configuration dispatch, including its built-in SystemBars plugin. */
@RunWith(AndroidJUnit4.class)
public class ShellChromeConfigurationTest {
    @Test public void configurationCallbacksKeepTheLastAppliedPageTone() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        StartupPreferences preferences = new StartupPreferences(context);
        String previous = preferences.read();
        assertTrue(preferences.write("disabled-v1"));
        MainActivity activity = null;
        try {
            activity = (MainActivity) instrumentation.startActivitySync(new Intent(context, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            MainActivity target = activity;
            instrumentation.runOnMainSync(() -> {
                assertFalse("the test must use the compatibility startup path", target.startup().enabled());
                target.getBridge().getWebView().stopLoading();
                for (String tone : new String[] { "dark", "light", "dark" }) {
                    target.startup().syncTone(null, tone);
                    assertEquals("tone before configuration callback", "dark".equals(tone) ? Color.rgb(15, 15, 15) : Color.WHITE,
                            ((ColorDrawable) target.getWindow().getDecorView().getBackground()).getColor());
                    for (int round = 0; round < 3; round++) {
                        for (int orientation : new int[] { Configuration.ORIENTATION_LANDSCAPE, Configuration.ORIENTATION_PORTRAIT }) {
                            Configuration changed = new Configuration(target.getResources().getConfiguration());
                            changed.orientation = orientation;
                            target.onConfigurationChanged(changed);
                            boolean dark = "dark".equals(tone);
                            assertTrue(target.getWindow().getDecorView().getBackground() instanceof ColorDrawable);
                            assertEquals("system-bar background after configuration callback", dark ? Color.rgb(15, 15, 15) : Color.WHITE,
                                    ((ColorDrawable) target.getWindow().getDecorView().getBackground()).getColor());
                            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(target.getWindow(), target.getWindow().getDecorView());
                            assertEquals("status icon contrast", !dark, bars.isAppearanceLightStatusBars());
                            assertEquals("navigation icon contrast", !dark, bars.isAppearanceLightNavigationBars());
                        }
                    }
                }
            });
        } finally {
            if (activity != null) {
                MainActivity target = activity;
                instrumentation.runOnMainSync(target::finish);
            }
            if (previous == null) context.getSharedPreferences("gugu-startup-policy", Context.MODE_PRIVATE).edit().remove("mode").commit();
            else assertTrue(preferences.write(previous));
        }
    }
}
