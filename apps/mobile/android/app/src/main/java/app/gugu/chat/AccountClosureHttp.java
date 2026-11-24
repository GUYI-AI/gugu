package app.gugu.chat;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Private transport. Its origin is packaged, never supplied by a bridge call. */
final class AccountClosureHttp {
    static final int MAX_REQUEST_BYTES = 4096, MAX_RESPONSE_BYTES = 65536;
    private static final Set<String> ROUTES = new HashSet<>(Arrays.asList(
        "status", "register", "challenge", "prepare_device", "read_preparation",
        "cancel_preparation", "confirm", "result", "cancel"));
    interface Connections { HttpURLConnection open(URL url) throws Exception; }
    static final class Configuration {
        final URI backend;
        final String anonKey;
        Configuration(String address, String key) throws Exception {
            URI candidate;
            try { candidate = new URI(address); }
            catch (Exception invalid) { throw failure(); }
            if (!"https".equals(candidate.getScheme()) || candidate.getHost() == null
                || candidate.getRawUserInfo() != null || candidate.getRawQuery() != null
                || candidate.getRawFragment() != null || !candidate.normalize().equals(candidate)
                || key == null || key.isEmpty() || key.length() > 16384 || hasLineBreak(key)) throw failure();
            backend = candidate; anonKey = key;
        }
        URI endpoint(String route) throws Exception {
            if (!ROUTES.contains(route)) throw failure();
            String path = backend.getPath();
            while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
            return new URI(backend.getScheme(), null, backend.getHost(), backend.getPort(),
                path + "/functions/v1/account-deletion/v2/" + route, null, null);
        }
    }
    static final class Reply {
        final int status;
        private final byte[] bytes;
        Reply(int status, byte[] bytes) { this.status = status; this.bytes = bytes.clone(); }
        String json() throws Exception {
            try { return StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString(); }
            catch (Exception invalid) { throw failure(); }
        }
    }
    private final Configuration configuration;
    private final Connections connections;
    AccountClosureHttp(Configuration configuration) {
        this(configuration, url -> (HttpURLConnection) url.openConnection());
    }
    AccountClosureHttp(Configuration configuration, Connections connections) {
        this.configuration = configuration; this.connections = connections;
    }
    String backendIdentity() { return configuration.backend.toASCIIString(); }

    /** No retries or redirects: a timeout cannot authorize another confirmation. */
    Reply request(String route, String bearer, byte[] body) throws Exception {
        boolean policy = "status".equals(route), result = "result".equals(route);
        URI endpoint = configuration.endpoint(route);
        if ((policy && body != null) || (!policy && (body == null || body.length > MAX_REQUEST_BYTES))
            || ((!result || bearer != null) && (bearer == null || bearer.isEmpty()
                || bearer.length() > 8192 || hasLineBreak(bearer)))) throw failure();
        HttpURLConnection connection = null;
        try {
            connection = connections.open(endpoint.toURL());
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setRequestMethod(policy ? "GET" : "POST");
            connection.setRequestProperty("apikey", configuration.anonKey);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cache-Control", "no-store");
            if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
            if (!policy) {
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw failure();
            String contentType = connection.getContentType();
            if (contentType == null || !contentType.toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) throw failure();
            if (connection.getContentLengthLong() > MAX_RESPONSE_BYTES) throw failure();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) throw failure();
            try (InputStream input = stream; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (bytes.size() + count > MAX_RESPONSE_BYTES) throw failure();
                    bytes.write(buffer, 0, count);
                }
                return new Reply(status, bytes.toByteArray());
            }
        } catch (Exception unavailable) {
            // Request bodies contain OTP/receipt and network exception messages can contain URLs.
            throw failure();
        } finally { if (connection != null) connection.disconnect(); }
    }
    private static boolean hasLineBreak(String value) { return value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0; }
    private static AccountClosureReceiptStore.Failure failure() { return new AccountClosureReceiptStore.Failure("unavailable"); }
}
