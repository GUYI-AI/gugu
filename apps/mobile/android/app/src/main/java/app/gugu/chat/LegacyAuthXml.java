package app.gugu.chat;

import android.util.Xml;
import java.io.ByteArrayInputStream;
import java.util.LinkedHashMap;
import java.util.Map;
import org.xmlpull.v1.XmlPullParser;

/** SharedPreferences may return an empty map on XML errors. Validate before trusting that result. */
final class LegacyAuthXml {
    private LegacyAuthXml() {}
    static Map<String, String> read(byte[] bytes) throws AuthStorageFailure {
        Map<String, String> values = new LinkedHashMap<>();
        if (bytes == null) return values;
        try {
            XmlPullParser parser = Xml.newPullParser();
            parser.setInput(new ByteArrayInputStream(bytes), "UTF-8");
            boolean opened = false, closed = false;
            String key = null; StringBuilder text = new StringBuilder();
            for (int event = parser.nextToken(); event != XmlPullParser.END_DOCUMENT; event = parser.nextToken()) {
                if (event == XmlPullParser.DOCDECL) throw new IllegalArgumentException();
                if (event == XmlPullParser.START_TAG) {
                    if (parser.getDepth() == 1 && !opened && "map".equals(parser.getName()) && parser.getAttributeCount() == 0) opened = true;
                    else if (parser.getDepth() == 2 && opened && !closed && key == null && "string".equals(parser.getName())
                        && parser.getAttributeCount() == 1 && "name".equals(parser.getAttributeName(0))) {
                        key = parser.getAttributeValue(0);
                        if (!AuthStorageKeys.isAllowed(key) || values.containsKey(key)) throw new IllegalArgumentException();
                        text.setLength(0);
                    } else throw new IllegalArgumentException();
                } else if (event == XmlPullParser.END_TAG) {
                    if (parser.getDepth() == 2 && key != null) { values.put(key, text.toString()); key = null; }
                    else if (parser.getDepth() == 1 && opened && !closed && key == null) closed = true;
                    else throw new IllegalArgumentException();
                } else if (event == XmlPullParser.TEXT || event == XmlPullParser.CDSECT || event == XmlPullParser.ENTITY_REF) {
                    String part = parser.getText();
                    if (part == null) throw new IllegalArgumentException();
                    if (key != null) text.append(part);
                    else if (!part.trim().isEmpty()) throw new IllegalArgumentException();
                }
            }
            if (!opened || !closed || key != null) throw new IllegalArgumentException();
            return values;
        } catch (Exception invalid) { throw new AuthStorageFailure("legacy_xml_invalid", true); }
    }
}
