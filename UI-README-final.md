# Phone own-message and theme-scope regression originals

测试环境渲染，未经真机验证，原因：无真机

Twelve unmodified PNGs: phone ACP own-message contrast and email link, task own-message contrast, and the real project waiting badge, each before/after in light and dark mode. Product components/styles are imported directly. Inputs are synthetic; no account, real owner email or cloud delivery was used. This is headless Chromium test rendering, not native or physical-device validation.

Final fixed source: 3a1c7b3a575b91c4f95fc53ce171b46666e0defc.

The first two baseline images observe 9f633292116b452e6523627c0cba5b6dc785f904. Four follow-up baseline images observe b5ec8c1936dfe287d1299b2e7f61a499707d4ed8 (original two fixes present, task/badge fixes absent). Each image displays its actual full source; no baseline is relabelled.

All twelve originals were inspected individually. Dark/light own messages now use existing shell foreground; email remains intact. The project waiting dot changes from transparent to the existing needs-user color and stays 8px. Related parser/browser/palette cases: 54 passed, no unhandled test errors. Full CI is reported separately in PR #2246.
