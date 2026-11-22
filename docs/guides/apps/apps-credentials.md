# gugu.credentials — requests with the person's saved credential

For an App that calls a website's API as the person (manifest `apiVersion` 61; `typeof gugu.credentials` tells an older
gugu, a phone or a program: none of them has it). The person's credentials are kept in their password vault. Your App
names the website and the header, and gugu sends the request. Your code never sees the value.

```json
"permissions": {
  "network": ["api.github.com"],
  "credentials": [{ "site": "github.com", "header": "Authorization", "format": "Bearer {value}" }]
}
```

- `site`: the website the credential is saved for, as a bare hostname. `network` must name a host of it (the site or a
  subdomain): the request only ever goes there.
- `header`: `Authorization`, `X-API-Key`, `Private-Token` or `X-Auth-Token`. `format` names `{value}` once.
- Which saved credential is used is the person's choice, made in your App's permissions on each computer. Until they
  pick one, gugu uses the one behind the connected GitHub account (for `github.com`), or the only one saved for the site.

Calls, from a page only:

- `gugu.credentials.read(site, url, { headers? })` → `{ status, data, headers }`: a GET.
- `gugu.credentials.write(site, method, url, body?, { headers? })`: `POST`, `PUT`, `PATCH` or `DELETE`, inside the
  person's click. A body that is not a string goes as JSON.
- `url` is the full `https://` URL to a granted `network` host of `site`. A redirect is not followed: its 3xx comes back as
  the answer. `data` is parsed JSON when the answer says JSON, else its text. `headers` carries `content-type`, `link`,
  `etag`, `retry-after` and `x-ratelimit-*`.
- Extra request headers: `Accept`, `Content-Type`, `If-None-Match` or `X-…-Api-Version` only.
- On a page an agent works, a read is `unavailable` and a write is handed to the agent: the person's credential is used
  only on a page the person works.
- `unavailable` with a reason when none is chosen, the chosen one was deleted, or the vault cannot be read on this
  computer: say so, and point the person to your App's permissions.
