The original Pi PNG is the unchanged artwork previously embedded in `../icon.ts`.
`pi-light.png` and `pi-dark.png` preserve its 128×128 geometry and derive alpha from
weighted sRGB brightness multiplied by original alpha, normalized against the unchanged
corner background (RGB 9/9/11) so the near-black plate becomes fully transparent. The light theme uses a black mark;
the dark theme uses a white mark. No shape was redrawn, and no CSS mask is needed.

From the repository root, run:

```
python3 packages/session-plugins/tooling/generate-pi-icons.py
python3 packages/session-plugins/tooling/generate-pi-icons.py --check
```

The generator uses only Python's standard library and embeds the same generated
PNGs into the icon registry, so Node and browser consumers need no PNG loader.
