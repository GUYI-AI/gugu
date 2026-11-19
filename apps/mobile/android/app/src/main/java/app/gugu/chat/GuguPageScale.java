package app.gugu.chat;

import android.content.res.Configuration;
import android.net.Uri;
import android.webkit.WebView;

import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;

/**
 * @@@text-scale - The system font size reaches the page as a number, never as the WebView's own text zoom.
 *
 * Left alone, the WebView follows the system font size by enlarging text and px line heights while every box keeps its
 * size, and the transcript, which lays rows out from canvas measurements, cuts what it measured short. So text zoom
 * stays at 100% and the page gets the scale instead (`window.__guguFontScale`), which mobile/textScale.ts turns into the
 * text sizes of its type tokens and of the transcript's measurement config: text grows, boxes, icons and spacing stay.
 *
 * The value is there before the page's first script (a document-start script, added in load(), which runs before the
 * bridge loads the page). A change of the system setting arrives while the app runs (fontScale is in the activity's
 * configChanges): the script is replaced for later loads and the live page is told, which reloads itself.
 */
@CapacitorPlugin(name = "GuguPageScale")
public class GuguPageScale extends Plugin {
    static final String EVENT = "gugu:font-scale";
    private ScriptHandler startScript;
    private float applied = Float.NaN;

    @Override
    public void load() {
        WebView webView = getBridge().getWebView();
        webView.getSettings().setTextZoom(100);
        apply(getContext().getResources().getConfiguration().fontScale);
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        apply(newConfig.fontScale);
    }

    private void apply(float fontScale) {
        float scale = fontScale > 0 ? fontScale : 1f;
        if (scale == applied) return;
        applied = scale;
        String assign = "window.__guguFontScale=" + scale + ";";
        WebView webView = getBridge().getWebView();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            if (startScript != null) startScript.remove();
            String origin = Uri.parse(getBridge().getAppUrl()).buildUpon().path(null).fragment(null).clearQuery().build().toString();
            startScript = WebViewCompat.addDocumentStartJavaScript(webView, assign, Collections.singleton(origin));
        }
        getBridge().eval(assign + "window.dispatchEvent(new Event('" + EVENT + "'))", ignored -> { });
    }
}
