# Host screen capture

`screen.get` is the host's one screen action on macOS, Windows and Linux. It captures the primary display through Electron's `desktopCapturer` and returns a JPEG in `pictures`, the actual image dimensions and the display count. The longest image edge is at most 1568 pixels. It does not read an accessibility tree. Existing `screen` grants, per-action denial and Deny All apply.

This changes macOS `screen.get` from accessibility text (app name, window title, visible text, `max_length`) to the same picture the other desktops already returned. The short-lived additive `screen.capture` action is removed; `screen.get` is the single name. See issue #1607: operating desktop apps belongs only to the Computer Use App, which brings its own driver; generic screenshots stay in the host.

If the existing picture transport resizes a large capture further, the action reports the delivered image's dimensions. If no picture fits the transport limit, the action fails explicitly.

Capture selects the primary display by `display_id`. One source without an id may represent a system-selected screen, including a Linux PipeWire portal. Multiple unidentified sources, a missing primary source and empty images fail instead of selecting another monitor. The dimensions come from the actual thumbnail, which may differ from Electron's requested size.

On macOS the `screen` group needs Screen Recording, not Accessibility. Ordinary calls read Electron's Screen Recording status before and after acquiring the image; they never request permission or wait for a person, and missing permission returns `os_permission`. Only the person's Connect action requests Screen Recording through the permission helper, then verifies it with a real capture; helper success alone does not connect the group. A refused or still-blank capture keeps the group disconnected and reports that 咕咕 may need a restart. On Windows and Linux, Connect verifies with a real capture and asks nothing.

`screen.elements.find`, an accessibility-tree lookup whose `element_token` only the former `computer.*` device actions consumed, is gone with them: the host no longer has a `computer` device group. Operating desktop apps is the Computer Use App's, through its own program.

API references: [Electron 44 desktopCapturer](https://github.com/electron/electron/blob/v44.0.0/docs/api/desktop-capturer.md), [source identity and thumbnail dimensions](https://github.com/electron/electron/blob/v44.0.0/docs/api/structures/desktop-capturer-source.md), [macOS media access status](https://github.com/electron/electron/blob/v44.0.0/docs/api/system-preferences.md).
