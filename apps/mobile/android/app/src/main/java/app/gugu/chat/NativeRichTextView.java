package app.gugu.chat;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.text.Layout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Code block decoration only. Selection highlighting and drag handles remain Android's. */
final class NativeRichTextView extends TextView {
    private final Paint blockPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final List<Block> blocks = new ArrayList<>();
    NativeRichTextView(Context context) { super(context); }

    void setCodeBlocks(JSONArray values, float scale) throws JSONException {
        blocks.clear();
        for (int index = 0; index < values.length(); index++) blocks.add(new Block(values.getJSONObject(index), scale));
        invalidate();
    }

    @Override protected void onDraw(Canvas canvas) {
        Layout layout = getLayout();
        if (layout != null) {
            int saved = canvas.save();
            canvas.translate(getTotalPaddingLeft(), getTotalPaddingTop());
            for (Block block : blocks) {
                int first = layout.getLineForOffset(block.start), last = layout.getLineForOffset(block.end - 1);
                float top = layout.getLineTop(first) - block.top;
                float bottom = layout.getLineBottom(last) - block.spacing + block.bottom;
                blockPaint.setColor(block.color);
                canvas.drawRoundRect(block.left, top, getWidth() - getTotalPaddingLeft() - getTotalPaddingRight() - block.right,
                        bottom, block.radius, block.radius, blockPaint);
            }
            canvas.restoreToCount(saved);
        }
        super.onDraw(canvas);
    }

    private static final class Block {
        final int start, end, color;
        final float left, right, top, bottom, radius, spacing;
        Block(JSONObject value, float scale) throws JSONException {
            start = value.getInt("start"); end = value.getInt("end"); color = NativeRichText.color(value.getJSONObject("background"));
            left = NativeRichText.nonnegative(value, "insetLeft") * scale; right = NativeRichText.nonnegative(value, "insetRight") * scale;
            top = NativeRichText.nonnegative(value, "paddingTop") * scale; bottom = NativeRichText.nonnegative(value, "paddingBottom") * scale;
            radius = NativeRichText.nonnegative(value, "radius") * scale; spacing = NativeRichText.nonnegative(value, "trailingSpacing") * scale;
        }
    }
}
