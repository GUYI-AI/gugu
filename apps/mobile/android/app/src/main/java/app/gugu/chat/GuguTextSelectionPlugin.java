package app.gugu.chat;

import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.icu.text.BreakIterator;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.FrameLayout;
import org.json.JSONException;

import com.getcapacitor.Plugin;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** A real selectable TextView owns the highlight, handles, action mode and clipboard. */
@CapacitorPlugin(name = "GuguTextSelection")
public class GuguTextSelectionPlugin extends Plugin {
    private Dialog dialog;
    private PluginCall pending;
    private String selectionId;

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("id"), text = call.getString("text");
        Integer start = call.getInt("start"), end = call.getInt("end");
        String title = call.getString("title"), closeLabel = call.getString("closeLabel");
        JSObject appearance = call.getObject("appearance");
        final NativeRichText rich;
        try { rich = new NativeRichText(text, call.getArray("runs"), call.getArray("paragraphs"), call.getArray("blocks")); }
        catch (JSONException error) { call.reject("Invalid rich text selection", error); return; }
        if (id == null || id.isEmpty() || title == null || closeLabel == null || start == null || end == null
                || !NativeTextRange.valid(text, start, end) || appearance == null
                || appearance.optDouble("viewportWidth", 0) <= 0 || appearance.optDouble("width", 0) <= 0
                || appearance.optDouble("height", 0) <= 0) { call.reject("Invalid text selection"); return; }
        getActivity().runOnUiThread(() -> {
            if (dialog != null) { call.reject("Text selection is already open"); return; }
            boolean dark = Boolean.TRUE.equals(call.getBoolean("dark"));
            Dialog page = new Dialog(getActivity(), dark ? R.style.GuguTextSelectionOverlayDark : R.style.GuguTextSelectionOverlay);
            dialog = page; pending = call; selectionId = id;
            FrameLayout root = new FrameLayout(page.getContext());
            root.setOnClickListener(view -> page.dismiss());
            float scale = getBridge().getWebView().getWidth() / (float) appearance.optDouble("viewportWidth");
            NativeRichTextView body = new NativeRichTextView(page.getContext());
            body.setTextIsSelectable(true);
            body.setTextSize(TypedValue.COMPLEX_UNIT_PX, (float) appearance.optDouble("fontSize", 16) * scale);
            body.setTextColor(Color.parseColor(appearance.optString("color", dark ? "#ffffff" : "#181818")));
            body.setIncludeFontPadding(false);
            body.setTextDirection(View.TEXT_DIRECTION_FIRST_STRONG);
            body.setPadding(0, 0, 0, 0);
            try { rich.apply(body, scale); }
            catch (JSONException error) {
                dialog = null; pending = null; selectionId = null;
                call.reject("Cannot style native text selection", error); return;
            }
            body.setCustomSelectionActionModeCallback(new ActionMode.Callback() {
                @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) { return true; }
                @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) { return false; }
                @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) { return false; }
                @Override public void onDestroyActionMode(ActionMode mode) { body.post(page::dismiss); }
            });
            FrameLayout.LayoutParams placement = new FrameLayout.LayoutParams(
                    Math.round((float) appearance.optDouble("width") * scale),
                    Math.max(1, Math.round((float) appearance.optDouble("height") * scale)));
            body.setVerticalScrollBarEnabled(true);
            placement.leftMargin = Math.round((float) appearance.optDouble("x") * scale);
            placement.topMargin = Math.round((float) appearance.optDouble("y") * scale);
            root.addView(body, placement);
            page.setContentView(root);
            page.setOnDismissListener(ignored -> finish(id));
            body.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
                private boolean positioned;
                @Override public void onGlobalLayout() {
                    if (body.getLayout() == null || !page.isShowing()) return;
                    if (!positioned) {
                        int[] webOrigin = new int[2], nativeOrigin = new int[2];
                        getBridge().getWebView().getLocationOnScreen(webOrigin);
                        root.getLocationOnScreen(nativeOrigin);
                        placement.leftMargin += webOrigin[0] - nativeOrigin[0];
                        placement.topMargin += webOrigin[1] - nativeOrigin[1];
                        positioned = true;
                        body.setLayoutParams(placement);
                        return;
                    }
                    body.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                    body.requestFocus();
                    int selectionStart = start;
                    int selectionEnd = end;
                    // Some Android WebViews segment Han words one character at a time. Use the system dictionary.
                    if (text.codePointCount(start, end) == 1 && Character.UnicodeScript.of(text.codePointAt(start)) == Character.UnicodeScript.HAN) {
                        BreakIterator words = BreakIterator.getWordInstance(body.getTextLocale());
                        words.setText(text);
                        int wordStart = words.preceding(end);
                        int wordEnd = words.following(start);
                        if (wordStart <= start && wordEnd >= end && NativeTextRange.valid(text, wordStart, wordEnd)) {
                            selectionStart = wordStart;
                            selectionEnd = wordEnd;
                        }
                    }
                    body.bringPointIntoView(selectionStart);
                    Bundle arguments = new Bundle();
                    arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, selectionStart);
                    arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, selectionEnd);
                    // This public TextView action starts the system selection action mode as well as setting its range.
                    if (!body.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, arguments)) {
                        pending = null;
                        call.reject("Native text selection unavailable");
                        page.dismiss();
                    }
                }
            });
            page.show();
            Window window = page.getWindow();
            if (window != null) {
                window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND);
                window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS | android.view.WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
                window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                window.setWindowAnimations(0);
                MobileShellChrome.applyTo(window, dark);
                window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (dialog != null && selectionId != null && selectionId.equals(call.getString("id"))) dialog.dismiss();
            call.resolve();
        });
    }

    private void finish(String id) {
        if (!id.equals(selectionId)) return;
        PluginCall completion = pending;
        dialog = null; pending = null; selectionId = null;
        if (completion != null) completion.resolve();
    }

    @Override protected void handleOnDestroy() {
        if (dialog != null) getActivity().runOnUiThread(() -> { if (dialog != null) dialog.dismiss(); });
        super.handleOnDestroy();
    }
}
