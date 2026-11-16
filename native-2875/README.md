# Android native keyboard-dismissal verification

Normal native App, synthetic test accounts and content only. No offline fixture or model requests.

Baseline: c95b6359b8f737614ff719a3666909771d9b11b0. Fixed: 74cb58ba5bb59476962390ea32a1bed0b7f11b64. The three raw frames for each source are idle, focused empty editor with native keyboard open, and Android Back with the keyboard hidden. The baseline menu remains at zero height; the fixed menu returns to 48 CSS px. Both retain the focused empty editor. Native IME visibility changes true to false; viewport returns from 455 to 766.

iOS has no native visibility observation here and retains the focus fallback; this evidence does not claim an iOS keyboard-dismissal fix.

Additional four-conversation native after captures use the fixed source and a 390 CSS px viewport (physical display 1080x2400). Agent directory data are published synthetic sessions; no running host or model response is asserted.
