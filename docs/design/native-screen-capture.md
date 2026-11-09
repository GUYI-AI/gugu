# Host screen capture

`screen.capture` adds generic Electron screen capture on macOS, Windows and Linux. It uses the existing `screen` grant, per-action denial and Deny All, independently of the Computer Use switch and driver. The result contains a JPEG in `pictures`, actual image dimensions and the display count. The longest image edge is at most 1568 pixels.

If the existing picture transport resizes a large capture further, the new action reports the delivered image's dimensions. If no picture fits the transport limit, the action fails explicitly. Legacy actions retain their existing result handling.

Capture selects the primary display by `display_id`. One source without an id may represent a system-selected screen, including a Linux PipeWire portal. Multiple unidentified sources, a missing primary source and empty images fail instead of selecting another monitor. The dimensions come from the actual thumbnail, which may differ from Electron's requested size.

On macOS, capture reads Electron's Screen Recording status before and after acquiring the image. It does not request permission or wait for a person. Missing permission returns `os_permission` with the System Settings path and possible restart requirement. Its OS status is separate from the legacy screen group's Accessibility status: neither failure nor success changes the other actions' permission state.

The existing `screen.get`, `screen.elements.find` and screen Connect behavior are unchanged. In particular, macOS `screen.get` still accepts `max_length`, returns AX text/window metadata and refuses the host's own windows. Windows/Linux `screen.get` retains its existing capture implementation. This additive prerequisite does not migrate the legacy Connect path, remove CUA, change App manifests or introduce an App API version.

API references: [Electron 44 desktopCapturer](https://github.com/electron/electron/blob/v44.0.0/docs/api/desktop-capturer.md), [source identity and thumbnail dimensions](https://github.com/electron/electron/blob/v44.0.0/docs/api/structures/desktop-capturer-source.md), [macOS media access status](https://github.com/electron/electron/blob/v44.0.0/docs/api/system-preferences.md).
