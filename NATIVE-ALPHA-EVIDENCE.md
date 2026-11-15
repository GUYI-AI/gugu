# Pi alpha PNG evidence

The four phone117 images are unmodified full screenshots from the same physical Android 14 phone, at 360 CSS pixels wide and devicePixelRatio 3. The baseline was recorded on November 15 at 22:44 from 421e54e14c70ab51633816d53a32de8c69da02c4. The replacement was recorded on November 16 at 03:14 from 43e6b533ecc751a30a893b12f95c64fee5b52233.

The actual WebView package was com.google.android.webview 117.0.5938.60. Both themes render the image at 14 by 14 CSS pixels. The replacement image decodes with corner RGBA 0,0,0,0 and 11180 fully transparent pixels; its opaque pixels are white in dark mode and black in light mode. CSS mask-mode:luminance is unsupported and no mask element exists. The black plate is absent in both replacement screenshots.

The existing QA task directory is an isolated, locally supplied snapshot because its host was offline. Network requests and model selection are not validated by these screenshots. The two Chromium images separately show the unchanged original asset and the real EngineIcon component using the transparent PNG, at 14px and an 8-times pixel enlargement.

The first two captures from 02:46 were rejected because first-run setup covered the task; those images are not included here.
