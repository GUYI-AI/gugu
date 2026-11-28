package app.gugu.chat;

import org.junit.Test;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.File;
import java.util.HashSet;
import java.util.Set;
import static org.junit.Assert.*;

/** Read actual Manifest-selected resources for both backup protocols. */
public class AuthBackupRulesTest {
    private static File appDirectory() {
        File directory = new File(System.getProperty("user.dir"));
        while (directory != null) {
            if (new File(directory, "src/main/AndroidManifest.xml").isFile()) return directory;
            File app = new File(directory, "apps/mobile/android/app");
            if (new File(app, "src/main/AndroidManifest.xml").isFile()) return app;
            directory = directory.getParentFile();
        }
        throw new AssertionError("Android source directory missing");
    }
    private static Element xml(File file) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance(); factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        return factory.newDocumentBuilder().parse(file).getDocumentElement();
    }
    private static Element rules(String attribute) throws Exception {
        Element manifest = xml(new File(appDirectory(), "src/main/AndroidManifest.xml"));
        Element application = (Element) manifest.getElementsByTagName("application").item(0);
        assertEquals("true", application.getAttributeNS("http://schemas.android.com/apk/res/android", "allowBackup"));
        String resource = application.getAttributeNS("http://schemas.android.com/apk/res/android", attribute);
        assertTrue(resource.startsWith("@xml/"));
        return xml(new File(appDirectory(), "src/main/res/xml/" + resource.substring(5) + ".xml"));
    }
    private static void exclusions(Element section) {
        Set<String> actual = new HashSet<>(); NodeList items = section.getElementsByTagName("exclude");
        for (int i = 0; i < items.getLength(); i++) {
            Element item = (Element) items.item(i); actual.add(item.getAttribute("domain") + "/" + item.getAttribute("path"));
        }
        assertTrue(actual.contains("sharedpref/gugu-auth-storage.xml"));
        assertTrue(actual.contains("root/shared_prefs/gugu-auth-storage.xml.bak"));
        assertTrue(actual.contains("sharedpref/phone-agent-grants.xml"));
        // No broad preference/file exclusion or include allow-list that loses ordinary user data.
        assertEquals(3, actual.size()); assertEquals(0, section.getElementsByTagName("include").getLength());
        assertFalse(actual.contains("sharedpref/.")); assertFalse(actual.contains("file/."));
    }
    @Test public void pre31BackupExcludesCredentialsAndRetainsOrdinaryUserData() throws Exception {
        Element root = rules("fullBackupContent"); assertEquals("full-backup-content", root.getTagName()); exclusions(root);
    }
    @Test public void api31CloudAndDeviceTransferBothExcludeCredentials() throws Exception {
        Element root = rules("dataExtractionRules"); assertEquals("data-extraction-rules", root.getTagName());
        for (String section : new String[] {"cloud-backup", "device-transfer"}) {
            NodeList sections = root.getElementsByTagName(section); assertEquals(1, sections.getLength());
            exclusions((Element) sections.item(0));
        }
    }
}
