
Android remote chat notifications are optional. Supplying a matching
`apps/mobile/android/app/google-services.json` includes the adapted MixPush FCM
module; an absent file leaves the provider unavailable and retains local
background reception. The JSON must match the selected production/Beta package.
Do not commit it. The native SDK initializes only after login and notification
permission. Firebase's SDK disclosure must be published before enabling the
configuration. See `apps/mobile/android/mixpush/NOTICE` for source and changes.

The backend registration overload adds `p_provider` before the opaque token.
Only a confirmed registration transfers chat/task notification authority away
from the local background outlet. Failed initial registration preserves local
reception. The existing Android task watcher is enabled while signed in; its
sound follows this device's chat sound setting. Foreground notifications retain
the existing local presentation and focus checks.

Token callbacks and preference changes serialize with retirement. Logout drains
registration work, calls the existing installation closure with the verified
session ID, validates its scoped fence, unregisters the SDK, and only then clears
credentials. A failed/unknown cleanup must remain visible. The process-cold path
uses a retained registration receipt for notification taps; a tap must match the
current owner/installation/registration/generation and pass the normal chat RLS
read before navigation.

CI compiles FCM with a synthetic Firebase project. It never supplies real service
account material. Real delivery acceptance additionally requires a signed Beta,
reviewed backend migration, supervised staging worker and owner-supplied Firebase
configuration. Distinguish provider acceptance from an actual system banner.
Test task-switcher dismissal and OS process death separately from Android Force
stop; FCM remains unavailable after Force stop until the app is opened again.
