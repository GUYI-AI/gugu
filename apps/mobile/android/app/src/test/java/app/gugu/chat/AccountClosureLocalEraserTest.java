package app.gugu.chat;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class AccountClosureLocalEraserTest {
    private static String read(java.nio.file.Path path) throws java.io.IOException { return new String(Files.readAllBytes(path), java.nio.charset.StandardCharsets.UTF_8); }
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final String A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
    private File write(File root, String path, String body) throws Exception {
        File file = new File(root, path); assertTrue(file.getParentFile().isDirectory() || file.getParentFile().mkdirs());
        Files.write(file.toPath(), body.getBytes(StandardCharsets.UTF_8)); return file;
    }
    @Test public void exactOwnerRootsAreErasedWhileBAndSharedInstallationBytesRemainUnchanged() throws Exception {
        File files = temporary.newFolder("files"), backup = temporary.newFolder("no-backup");
        File a = write(files, "phone-agent/" + A + "/state.json", "A"), b = write(files, "phone-agent/" + B + "/state.json", "B");
        File bh = write(backup, "phone-agent-host/" + B + "/config.enc", "B encrypted");
        write(backup, "phone-agent-host/" + A + "/config.enc", "A encrypted");
        File br = write(backup, "phone-agent-runtime/" + B + "/hosts/host.json", "B running state");
        write(backup, "phone-agent-runtime/" + A + "/hosts/host.json", "A running state");
        File install = write(backup,"phone-installation/identity","unchanged identity"), binary = write(files,"embedded-node/shared","unchanged runtime");
        AccountClosureLocalEraser eraser = new AccountClosureLocalEraser(files, backup, directory -> {});
        for (int step=0;step<3;step++) { eraser.erase(step,A); eraser.erase(step,A); }
        assertFalse(a.exists()); assertEquals("B", read(b.toPath())); assertEquals("B encrypted", read(bh.toPath()));
        assertEquals("B running state", read(br.toPath())); assertEquals("unchanged identity",read(install.toPath())); assertEquals("unchanged runtime",read(binary.toPath()));
    }
    @Test public void internalLinksAreUnlinkedWithoutTraversingAnotherOwner() throws Exception {
        File files=temporary.newFolder("files"),backup=temporary.newFolder("no-backup");
        File b=write(files,"phone-agent/"+B+"/private","B"); File own=write(files,"phone-agent/"+A+"/own","A");
        Files.createSymbolicLink(new File(own.getParentFile(),"other").toPath(),b.getParentFile().toPath());
        new AccountClosureLocalEraser(files,backup,directory->{}).erase(0,A);
        assertFalse(own.exists()); assertEquals("B",read(b.toPath()));
    }
    @Test public void aliasedOwnerRootIsRefusedBeforeTouchingB() throws Exception {
        File files=temporary.newFolder("files"),backup=temporary.newFolder("no-backup");
        File b=write(files,"phone-agent/"+B+"/private","B");
        Files.createSymbolicLink(new File(b.getParentFile().getParentFile(),A).toPath(),b.getParentFile().toPath());
        try { new AccountClosureLocalEraser(files,backup,directory->{}).erase(0,A); fail("Expected refusal"); }
        catch(java.io.IOException expected) { assertEquals("B",read(b.toPath())); }
    }
}
