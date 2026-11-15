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
 * @@@page-scale - The system font size is the page's zoom, never a text-only zoom.
 *
 * Left alone, the WebView follows the system font size by enlarging text and px line heights while every box keeps its
 * size (measured at font_scale 1.3: text ×1.3, root font 20.8px, canvas measureText unchanged): toolbars and one-line
 * boxes overflow, and the transcript, which lays rows out from canvas measurements, cuts what it measured short.
 * So text zoom stays at 100% and the page gets the scale instead (`window.__guguFontScale`), which it turns into the
 * width of its viewport (pageScale.ts): a 412 px screen at 1.3 lays out as 317 px and is drawn 1.3 times larger, text
 * and boxes alike.
 *
 * The value is there before the page's first script (a document-start script, added in load(), which runs before the
 * bridge loads the page), and a change of the system setting arrives while the app runs (fontScale is in the
 * activity's configChanges, so the page is not reloaded): the script is replaced for later loads and the live page is told.
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
