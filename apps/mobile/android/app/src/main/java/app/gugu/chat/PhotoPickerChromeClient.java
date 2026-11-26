package app.gugu.chat;

import android.content.ContentResolver;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Keeps the system picker, then gives WebView a private copy of each selected photo. */
final class PhotoPickerChromeClient extends BridgeWebChromeClient {
    private static final String TAG = "GuguPhotoPicker";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private static boolean previousProcessCacheCleared; // Only accessed on IO.
    private final Context context;
    private File cache; // Only accessed on IO.
    private boolean copying;
    private volatile boolean closed;

    PhotoPickerChromeClient(Bridge bridge) {
        super(bridge);
        context = bridge.getContext().getApplicationContext();
    }

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        String[] types = params.getAcceptTypes();
        if (params.getMode() != FileChooserParams.MODE_OPEN_MULTIPLE || params.isCaptureEnabled()
                || types.length != 1 || !"image/*".equals(types[0])) {
            return super.onShowFileChooser(view, callback, params);
        }
        return super.onShowFileChooser(view, selected -> {
            if (selected == null || Arrays.stream(selected).noneMatch(PhotoPickerChromeClient::isPickerPhoto)) {
                callback.onReceiveValue(selected);
                return;
            }
            copying = true;
            IO.execute(() -> deliverPhotos(view, callback, selected));
        }, params);
    }

    private static boolean isPickerPhoto(Uri uri) {
        if (uri == null || !ContentResolver.SCHEME_CONTENT.equals(uri.getScheme()) || !"media".equals(uri.getAuthority())) {
            return false;
        }
        List<String> path = uri.getPathSegments();
        return path.size() == 5 && "picker_get_content".equals(path.get(0)) && "media".equals(path.get(3));
    }

    private void deliverPhotos(WebView view, ValueCallback<Uri[]> callback, Uri[] selected) {
        List<Uri> ready = new ArrayList<>(selected.length);
        for (Uri uri : selected) {
            if (closed) return;
            try {
                ready.add(isPickerPhoto(uri) ? copyPhoto(uri) : uri);
            } catch (IOException | RuntimeException failure) {
                Log.w(TAG, "Could not read a selected photo: " + failure.getClass().getSimpleName());
            }
        }
        view.post(() -> {
            if (closed) return;
            if (ready.size() != selected.length) {
                Toast.makeText(context, R.string.photo_picker_read_failed, Toast.LENGTH_LONG).show();
            }
            callback.onReceiveValue(ready.isEmpty() ? null : ready.toArray(new Uri[0]));
        });
    }

    private Uri copyPhoto(Uri uri) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        File directory = Files.createTempDirectory(activityCache().toPath(), "photo-").toFile();
        try {
            String name = GuguSharePlugin.safeName(displayName(resolver, uri), "photo");
            if (name.lastIndexOf('.') < 0) {
                String type = resolver.getType(uri);
                String extension = type == null ? null : MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
                if (extension != null) name += "." + extension;
            }
            File target = new File(directory, name);
            // Chromium can open the picker URI more than once for the draft, preview and upload.
            // Read it once while the chooser's grant is live, then hand off the same bytes.
            try (AssetFileDescriptor descriptor = resolver.openAssetFileDescriptor(uri, "r")) {
                if (descriptor == null) throw new IOException("Photo picker returned no descriptor");
                try (InputStream input = descriptor.createInputStream()) {
                    if (Files.copy(input, target.toPath()) == 0) throw new IOException("Photo picker returned no bytes");
                }
            }
            return FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", target);
        } catch (IOException | RuntimeException failure) {
            GuguSharePlugin.deleteTree(directory);
            throw failure;
        }
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        }
        return uri.getLastPathSegment();
    }

    private File activityCache() throws IOException {
        if (cache == null) {
            File root = new File(context.getCacheDir(), "photo-picker");
            if (!previousProcessCacheCleared) {
                GuguSharePlugin.deleteTree(root);
                previousProcessCacheCleared = true;
            }
            Files.createDirectories(root.toPath());
            cache = Files.createTempDirectory(root.toPath(), "webview-").toFile();
        }
        return cache;
    }

    void close() {
        closed = true;
        if (copying) IO.execute(() -> {
            if (cache != null) GuguSharePlugin.deleteTree(cache);
        });
    }
}
