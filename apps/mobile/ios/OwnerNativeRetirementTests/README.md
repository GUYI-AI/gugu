# Native owner cleanup composition

`main.swift` composes the production OwnerSession, durable retirement store,
four-operation authorization projection and B2 cleanup runner. Identity, HTTP,
stored credentials and local lifecycle completion are injected. The test uses
private APFS state and makes no real network, model, Keychain or App calls.

The 28 checks cover bounded original-scope authority, local-stop ordering,
ordinary-publication cleanup, cold retry, a same-session refresh and replacement
by a new Auth session. An ordinary stop persists `publicationOnly` custody and
does not invoke permanent push close. A credential write first settles pending
ordinary cleanup, then applies its existing session-replacement rules. The store
does not treat publication cleanup as a committed credential write.

The App assembly shares one cached native service and waits for both push and
native cleanup before allowing a credential write. Plugins and product flags are
still disabled. SDK type checking and real App/Keychain/HTTP cleanup require
separate evidence. Expired or unverifiable original credentials remain blocked;
the cleanup capability cannot refresh them or borrow another login.

Compile all production `Host/*.swift`, OwnerSession, retirement store, native
retirement projection, backend configuration and this entry with the macOS SDK,
`-parse-as-library`, and an external module cache. Pass a fresh private APFS root
to the executable. Run through `gugu-heavy --build` and record exact source hashes,
exit status and stderr. The existing OwnerSession, credential-retirement and cold
retirement drivers remain separate regression groups.
