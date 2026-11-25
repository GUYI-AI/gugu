package app.gugu.chat;

import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class AccountClosureHttpTest {
    interface Attempt { void run() throws Exception; }
    private static void refused(Attempt action) throws Exception {
        try { action.run(); fail("Expected fixed native transport rejection"); }
        catch (AccountClosureReceiptStore.Failure error) { assertEquals("unavailable", error.code); }
    }
    static final class Connection extends HttpURLConnection {
        final ByteArrayOutputStream written = new ByteArrayOutputStream();
        byte[] response = "{\"operation\":{}}".getBytes(StandardCharsets.UTF_8);
        String contentType = "application/json; charset=utf-8";
        int status = 200, calls;
        boolean disconnected;
        Connection() throws Exception { super(new URL("https://native.example.invalid")); }
        @Override public void connect() {}
        @Override public void disconnect() { disconnected = true; }
        @Override public boolean usingProxy() { return false; }
        @Override public OutputStream getOutputStream() { return written; }
        @Override public InputStream getInputStream() { calls++; return new ByteArrayInputStream(response); }
        @Override public InputStream getErrorStream() { calls++; return new ByteArrayInputStream(response); }
        @Override public int getResponseCode() { return status; }
        @Override public String getContentType() { return contentType; }
        @Override public long getContentLengthLong() { return -1; }
    }
    static AccountClosureHttp client(Connection connection) throws Exception {
        return new AccountClosureHttp(new AccountClosureHttp.Configuration("https://native.example.invalid/", "public-anon"),
            target -> { assertEquals("native.example.invalid", target.getHost()); return connection; });
    }
    @Test public void policyUsesOnlyItsPackagedTargetAndNativeBearer() throws Exception {
        Connection c = new Connection(); client(c).request("status", "native-bearer", null);
        assertEquals("GET", c.getRequestMethod()); assertEquals("public-anon", c.getRequestProperty("apikey"));
        assertEquals("Bearer native-bearer", c.getRequestProperty("Authorization"));
        assertEquals(0, c.written.size()); assertFalse(c.getInstanceFollowRedirects()); assertFalse(c.getUseCaches());
        assertEquals(15000, c.getReadTimeout()); assertTrue(c.disconnected);
    }
    @Test public void originalResultCanUseOnlyReceiptCustodyAfterAuthDeletion() throws Exception {
        Connection c = new Connection(); byte[] body = "{\"receipt_token\":\"fixture\"}".getBytes(StandardCharsets.UTF_8);
        client(c).request("result", null, body);
        assertEquals("POST", c.getRequestMethod()); assertNull(c.getRequestProperty("Authorization"));
        assertArrayEquals(body, c.written.toByteArray());
        refused(() -> client(new Connection()).request("confirm", null, body));
    }
    @Test public void targetsAndRoutesCannotRedirectNativeSecrets() throws Exception {
        for (String target : new String[]{"http://native.example.invalid", "https://user@native.example.invalid", "https://native.example.invalid?q=1", "https://native.example.invalid/#fragment", "https://native.example.invalid/a/../b"})
            refused(() -> new AccountClosureHttp.Configuration(target, "public-anon"));
        Connection c = new Connection();
        refused(() -> client(c).request("https://other.example.invalid/confirm", "native-bearer", new byte[0]));
        assertEquals(0, c.calls); assertEquals(0, c.written.size());
    }
    @Test public void redirectResponseNeverReadsOrFollowsItsTarget() throws Exception {
        Connection c = new Connection(); c.status = 302;
        refused(() -> client(c).request("confirm", "native-bearer", new byte[0]));
        assertFalse(c.getInstanceFollowRedirects()); assertEquals(0, c.calls); assertTrue(c.disconnected);
    }
    @Test public void transportDoesNotRetryAnUnknownConfirmation() throws Exception {
        int[] calls = {0};
        AccountClosureHttp http = new AccountClosureHttp(new AccountClosureHttp.Configuration("https://native.example.invalid", "public-anon"), target -> {
            calls[0]++; throw new java.io.IOException("a sensitive URL or receipt must not escape");
        });
        refused(() -> http.request("confirm", "native-bearer", "secret-code".getBytes(StandardCharsets.UTF_8)));
        assertEquals(1, calls[0]);
    }
    @Test public void malformedOrOversizedResponsesDoNotBecomeAuthoritativeResults() throws Exception {
        Connection html = new Connection(); html.contentType = "text/html";
        refused(() -> client(html).request("result", null, new byte[0])); assertEquals(0, html.calls);
        Connection large = new Connection(); large.response = new byte[AccountClosureHttp.MAX_RESPONSE_BYTES + 1];
        refused(() -> client(large).request("result", null, new byte[0]));
        Connection encoding = new Connection(); encoding.response = new byte[]{(byte)0xc3, (byte)0x28};
        refused(() -> client(encoding).request("result", null, new byte[0]).json());
    }
    @Test public void invalidHeadersOrBodyRejectBeforeOpeningAConnection() throws Exception {
        refused(() -> client(new Connection()).request("status", "native-bearer\r\nInjected: bad", null));
        refused(() -> new AccountClosureHttp.Configuration("https://native.example.invalid", "key\nInjected: bad"));
        refused(() -> client(new Connection()).request("confirm", "native-bearer", new byte[4097]));
        refused(() -> client(new Connection()).request("status", "native-bearer", new byte[0]));
    }
    @Test public void fixedServerErrorsRemainErrorsAndAreNotConvertedToPolicyFalse() throws Exception {
        Connection c = new Connection(); c.status = 503;
        c.response = "{\"error\":\"unavailable\"}".getBytes(StandardCharsets.UTF_8);
        AccountClosureHttp.Reply reply = client(c).request("status", "native-bearer", null);
        assertEquals(503, reply.status); assertEquals("{\"error\":\"unavailable\"}", reply.json());
    }
}
