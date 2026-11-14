package app.gugu.chat;

import android.app.Dialog;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
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
        if (id == null || id.isEmpty() || title == null || closeLabel == null || start == null || end == null
                || !NativeTextRange.valid(text, start, end)) { call.reject("Invalid text selection"); return; }
        getActivity().runOnUiThread(() -> {
            if (dialog != null) { call.reject("Text selection is already open"); return; }
            boolean dark = Boolean.TRUE.equals(call.getBoolean("dark"));
            Dialog page = new Dialog(getActivity(), dark ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
            dialog = page; pending = call; selectionId = id;
            LinearLayout root = new LinearLayout(page.getContext());
            root.setOrientation(LinearLayout.VERTICAL);
            root.setBackgroundColor(dark ? Color.rgb(24, 24, 24) : Color.WHITE);
            LinearLayout header = new LinearLayout(page.getContext());
            header.setGravity(android.view.Gravity.CENTER_VERTICAL);
            header.setPadding(dp(16), 0, dp(8), 0);
            TextView heading = new TextView(page.getContext());
            heading.setText(title); heading.setTextSize(18);
            header.addView(heading, new LinearLayout.LayoutParams(0, dp(56), 1));
            heading.setGravity(android.view.Gravity.CENTER_VERTICAL);
            Button back = new Button(page.getContext());
            back.setText(closeLabel); back.setOnClickListener(view -> page.dismiss());
            header.addView(back);
            root.addView(header, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            ScrollView scroll = new ScrollView(page.getContext());
            scroll.setFillViewport(true);
            TextView body = new TextView(page.getContext());
            body.setTextIsSelectable(true);
            body.setText(text, TextView.BufferType.SPANNABLE);
            body.setTextSize(16);
            body.setTextDirection(View.TEXT_DIRECTION_FIRST_STRONG);
            body.setPadding(dp(16), dp(16), dp(16), dp(24));
            scroll.addView(body, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
            ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
            page.setContentView(root);
            page.setOnDismissListener(ignored -> finish(id));
            body.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
                @Override public void onGlobalLayout() {
                    if (body.getLayout() == null || !page.isShowing()) return;
                    body.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                    body.requestFocus();
                    body.bringPointIntoView(start);
                    Bundle arguments = new Bundle();
                    arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start);
                    arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end);
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
                WindowInsetsControllerCompat bars = new WindowInsetsControllerCompat(window, root);
                bars.setAppearanceLightStatusBars(!dark);
                bars.setAppearanceLightNavigationBars(!dark);
            }
            ViewCompat.requestApplyInsets(root);
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

    private int dp(int size) { return Math.round(size * getContext().getResources().getDisplayMetrics().density); }

    @Override protected void handleOnDestroy() {
        if (dialog != null) getActivity().runOnUiThread(() -> { if (dialog != null) dialog.dismiss(); });
        super.handleOnDestroy();
    }
}
