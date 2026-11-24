# Failed outgoing message positions (#2859)

Original screenshots from the application's real UI. Desktop screenshots show a native Electron window. Mobile screenshots show the web-target mobile shell in a visible, isolated Chromium window at 390 × 844; they are **not physical-phone evidence**. Images have not been edited.

The test sends `ORDER-01`, makes `ORDER-FAIL-02` fail through request interception, then successfully sends `ORDER-03`. The same failed message is subsequently resent through the existing failure control.

| Surface | Before | After failure | After resend |
| --- | --- | --- | --- |
| Desktop | [Before](before-desktop.png) | [Failed message stays between 01 and 03](after-desktop-failed.png) | [Resent and reopened](after-desktop-resent-reopened.png) |
| Mobile narrow window | [Before](before-mobile-narrow.png) | [Failed message stays between 01 and 03](after-mobile-narrow-failed.png) | [Resent message stays in place](after-mobile-narrow-resent.png) |

Before: `01 → 03 → failed 02`. After: `01 → failed 02 → 03`, then `01 → 02 → 03` after resending. Reopening retains that position on the sending device. The unrelated sidebar introduction in the desktop failure capture does not cover the message rows; the reopened capture has dismissed it through its normal Skip action.

Known limitation: another device displays the message at the time its resend succeeds. No physical mobile device or other-device ordering was tested here.

Superseded in part: a confirmed message is now ordered by its server sequence on every device, the sending device included. A failed message still holds its original slot until it is confirmed; a successful resend then moves to its sequence position, where other devices show it.
