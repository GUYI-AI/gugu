package app.gugu.chat;

import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.Build;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.LeadingMarginSpan;
import android.text.style.LineHeightSpan;
import android.text.style.MetricAffectingSpan;
import android.text.style.TabStopSpan;
import android.text.style.UnderlineSpan;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Style a real TextView; Android still owns its selection, handles, menu and clipboard. */
final class NativeRichText {
    final String text;
    final JSONArray runs, paragraphs, blocks;

    NativeRichText(String text, JSONArray runs, JSONArray paragraphs, JSONArray blocks) throws JSONException {
        if (text == null || runs == null || paragraphs == null || blocks == null || runs.length() == 0) throw new JSONException("Missing rich text");
        this.text = text; this.runs = runs; this.paragraphs = paragraphs; this.blocks = blocks;
        for (int index = 0; index < runs.length(); index++) {
            JSONObject run = runs.getJSONObject(index);
            range(run); positive(run, "fontSize");
            if (positive(run, "weight") > 1000) throw new JSONException("Invalid font weight");
            color(run.getJSONObject("color"));
            run.getBoolean("italic"); run.getBoolean("monospace");
            if (run.has("background")) color(run.getJSONObject("background"));
        }
        for (int index = 0; index < paragraphs.length(); index++) {
            JSONObject paragraph = paragraphs.getJSONObject(index);
            range(paragraph); positive(paragraph, "lineHeight");
            for (String key : new String[]{"before", "after", "indent", "firstLineIndent"}) nonnegative(paragraph, key);
        }
        for (int index = 0; index < blocks.length(); index++) {
            JSONObject block = blocks.getJSONObject(index);
            range(block); color(block.getJSONObject("background"));
            for (String key : new String[]{"insetLeft", "insetRight", "paddingTop", "paddingBottom", "radius", "trailingSpacing"}) nonnegative(block, key);
        }
    }

    private void range(JSONObject value) throws JSONException {
        if (!NativeTextRange.valid(text, value.getInt("start"), value.getInt("end"))) throw new JSONException("Invalid rich text range");
    }

    static float nonnegative(JSONObject value, String key) throws JSONException {
        double number = value.getDouble(key);
        if (!Double.isFinite(number) || number < 0) throw new JSONException("Invalid text dimension");
        return (float) number;
    }

    private static float positive(JSONObject value, String key) throws JSONException {
        float number = nonnegative(value, key);
        if (number == 0) throw new JSONException("Empty text dimension");
        return number;
    }

    static int color(JSONObject value) throws JSONException {
        double red = value.getDouble("red"), green = value.getDouble("green"), blue = value.getDouble("blue"), alpha = value.getDouble("alpha");
        if (!Double.isFinite(red) || !Double.isFinite(green) || !Double.isFinite(blue) || !Double.isFinite(alpha)
                || red < 0 || red > 255 || green < 0 || green > 255 || blue < 0 || blue > 255 || alpha < 0 || alpha > 1) throw new JSONException("Invalid text color");
        return Color.argb((int) Math.round(alpha * 255), (int) Math.round(red), (int) Math.round(green), (int) Math.round(blue));
    }

    void apply(NativeRichTextView body, float scale) throws JSONException {
        SpannableString styled = new SpannableString(text);
        for (int index = 0; index < runs.length(); index++) {
            JSONObject run = runs.getJSONObject(index);
            int start = run.getInt("start"), end = run.getInt("end");
            styled.setSpan(new Font(run.getBoolean("monospace"), Math.round(positive(run, "weight")), run.getBoolean("italic"), positive(run, "fontSize") * scale), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            styled.setSpan(new ForegroundColorSpan(color(run.getJSONObject("color"))), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (run.optBoolean("underline")) styled.setSpan(new UnderlineSpan(), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (run.has("background")) styled.setSpan(new BackgroundColorSpan(color(run.getJSONObject("background"))), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        for (int index = 0; index < paragraphs.length(); index++) {
            JSONObject paragraph = paragraphs.getJSONObject(index);
            int start = paragraph.getInt("start"), end = paragraph.getInt("end");
            int indent = Math.round(nonnegative(paragraph, "indent") * scale);
            int first = Math.round(nonnegative(paragraph, "firstLineIndent") * scale);
            styled.setSpan(new LeadingMarginSpan.Standard(first, indent), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (paragraph.has("marker")) styled.setSpan(new TabStopSpan.Standard(indent), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            styled.setSpan(new Height(start, end, Math.max(1, Math.round(positive(paragraph, "lineHeight") * scale)),
                    Math.round(nonnegative(paragraph, "before") * scale), Math.round(nonnegative(paragraph, "after") * scale)), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        body.setText(styled, TextView.BufferType.SPANNABLE);
        body.setCodeBlocks(blocks, scale);
    }

    private static final class Font extends MetricAffectingSpan {
        private final Typeface face;
        private final float size;
        Font(boolean mono, int weight, boolean italic, float size) {
            this.size = size;
            Typeface family = mono ? Typeface.MONOSPACE : Typeface.DEFAULT;
            face = Build.VERSION.SDK_INT >= 28 ? Typeface.create(family, weight, italic)
                    : Typeface.create(family, (weight >= 600 ? Typeface.BOLD : Typeface.NORMAL) | (italic ? Typeface.ITALIC : 0));
        }
        @Override public void updateMeasureState(TextPaint paint) { paint.setTypeface(face); paint.setTextSize(size); }
        @Override public void updateDrawState(TextPaint paint) { paint.setTypeface(face); paint.setTextSize(size); }
    }

    private static final class Height implements LineHeightSpan {
        final int from, to, height, before, after;
        Height(int from, int to, int height, int before, int after) { this.from = from; this.to = to; this.height = height; this.before = before; this.after = after; }
        @Override public void chooseHeight(CharSequence text, int start, int end, int spanstartv, int v, Paint.FontMetricsInt metrics) {
            int natural = metrics.descent - metrics.ascent;
            if (natural <= 0) return;
            int ascent = height >= natural ? metrics.ascent - (height - natural) / 2 : Math.round(metrics.ascent * height / (float) natural);
            metrics.ascent = ascent - (start <= from ? before : 0);
            metrics.descent = ascent + height + (end >= to ? after : 0);
            metrics.top = metrics.ascent; metrics.bottom = metrics.descent;
        }
    }
}
