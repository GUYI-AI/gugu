# Password vault sync (end-to-end encrypted) — #2481

Decided 2026-11-11: the cloud holds only ciphertext; a new device is approved once on a device that already has the
key; removing a device rotates the key. Afternoon revision: an optional recovery code; it works only with the account
signed in **and** the code typed in. Evening revision (owner: 「用户不用主动感知」): approval happens when a device signs in,
not on a settings page; the recovery code lives in 设置 → 账户.

## What the person sees

- No passwords anywhere: no vault, nothing to approve. The device that keeps the first entry creates the vault.
- A device signs in while the account has passwords: devices that have them pop 「允许「X」用你的密码吗？」 with the
  6 digits and 允许 / 不是我 (plus a system notification when the window is in the background). The new device shows the
  same digits in a corner card that blocks nothing. Either can be put aside; the notification list brings it back.
- The code is opened on the machine the person is at: at once where they used it in the last 30 s, after 8 s where the
  screen is merely unlocked, never where it is locked. An active machine takes over a request opened elsewhere (it drops
  it; the device asks again with a fresh round).
- 不是我 sticks: the request stays refused for that device key and does not come back by itself; the refused device
  offers 重新申请 (a new key, a new request) in case it was a slip.
- Removing a device is 设置 → 设备; the deleted row marks the vault for re-keying, and the next full device re-keys.
- A reinstalled device (its key gone) simply asks again; the vault is re-keyed because the old key may still exist.

## Keys

- **Vault key** `VK` (32 random bytes) per `epoch`. Only devices with full scope hold it.
- **Item key** `IK` per credential. `wrapped = AES-256-GCM(VK, IK, aad = item-key|owner|item|epoch)`.
- **Item ciphertext** `AES-256-GCM(IK, json, aad = item|owner|item|version)`. The JSON holds origin, account, password,
  named fields and the grant list; the cloud sees only id, version, epoch and timestamps.
- **Device key pair** X25519 (`crypto_box_keypair`, libsodium-wrappers, already a dependency). The secret never leaves
  the device; it is stored through the platform key protector (macOS Keychain via safeStorage).
- **Shares** `crypto_box_seal(VK‖epoch, device_pk)` for full-scope devices; `crypto_box_seal(IK, device_pk)` per granted
  item for limited-scope devices (servers, Windows, Linux — pending owner decision 2).

## Joining: commit–reveal short code

A server that can swap the new device's public key could grind key pairs until a 6-digit code matches, so the code is
not derived from the key alone (Bluetooth numeric-comparison shape):

1. New device `N` registers `pk_N` and `commit = SHA-256(pk_N‖nonce_N)` (status `pending`).
2. Approver `A` records the `pk_N` and `commit` it sees, then posts `nonce_A` (once per request).
3. `N` records `nonce_A`, then reveals `nonce_N`. `A` checks `nonce_N` against the commitment it recorded.
4. Both show `code = SHA-256("gugu-vault-sas-v1"‖pk_N‖nonce_N‖nonce_A) mod 10^6`. The person compares and taps 允许 on
   `A`, which seals `VK` to `pk_N`. A mismatch is refused on `A`; nothing is sealed.

Both sides compute the code only from what they recorded before their own nonce went out: were `A` to read the
commitment later, or `N` to take whatever `nonce_A` the cloud shows after `nonce_N` is out, the cloud could choose the
other half after seeing ours and make the codes agree on its own key. Anything else than the recorded round starts a new
round with fresh nonces. Each attempt then matches with probability 10⁻⁶ and needs a visible request. Servers added through SSH skip the code: the desktop reads `pk` over SSH and seals directly.

## Cloud (identity schema, gugu-supabase)

`password_vault_heads` (epoch, revision) · `password_vault_devices` (device, pk, commit, nonces, scope, status) ·
`password_vault_shares` · `password_vault_items` (id, version, epoch, wrapped key, ciphertext, tombstone, revision).
Tables are closed to API roles; owner-checked `SECURITY DEFINER` RPCs only. Saves carry `expected_version`; a mismatch
is refused (`40001`) and the client pulls before the person retries. Every write (each joining step included) bumps the
head revision; clients poll it every 5 s (3 s while a code is on screen) and fetch what changed since their revision.

## Local

The existing local vault stays the working copy that Agents use (offline reads and logins keep working). Writes go to
the cloud first and are applied locally only after the RPC succeeds; offline devices cannot edit. A pull applies remote
items through the same revocation path as a local edit, so in-flight uses of a changed credential are invalidated.
First sync on a device with an existing local vault uploads it (same origin + account merge into one item).

## Recovery code

A device on paper: 25 Crockford base32 symbols (~125 bits, not chosen by the person). `seed = H("recovery-seed", code)`
gives an X25519 pair the vault key is sealed to; `proof = H("recovery-proof", code)`, and the cloud keeps only
`SHA-256(proof)`. A device with the account and the proof receives the sealed key, joins as a full member, and the code
is used up; a new one is issued and shown once. Re-keying re-seals to it; replacing or removing it re-keys, so an old
code opens nothing. Reset is refused while a code exists. Offered once after the first saved password (skippable); kept
in 设置 → 账户; 「用恢复码」 sits in the new device's corner card.

## Removing a device

The removing device generates `VK'` (epoch+1), new item keys, re-encrypts every item and re-seals shares for the devices
that remain, in one RPC that also revokes the device. A removed device keeps whatever it already decrypted; it cannot
read anything written afterwards.

## Not defended

A compromised server can withhold or roll back ciphertext (availability), and can see item counts and timing. Root on a
device that holds a key can read what that device can read.

Open (2026-11-11): an **actively malicious** server can still (a) hand a device a vault key of its own, since shares are
anonymous sealed boxes, so that device's later writes are readable; (b) list a device nobody approved, so the next
re-key seals the new key to it. Closing both needs signed membership (devices sign approvals and re-keys; members verify
the chain from the device that approved them). A passive leak of the database reads nothing.
