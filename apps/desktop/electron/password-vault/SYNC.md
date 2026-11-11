# Password vault sync (end-to-end encrypted) — #2481

Decided 2026-11-11: the cloud holds only ciphertext; a new device is approved once on a device that already has the
key; removing a device rotates the key; losing every approved device loses the vault (no recovery).

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
2. Approver `A` opens the request and posts `nonce_A` (once per request).
3. `N` reveals `nonce_N`. `A` checks the commitment.
4. Both show `code = SHA-256("gugu-vault-sas-v1"‖pk_N‖nonce_N‖nonce_A) mod 10^6`. The person compares and taps 允许 on
   `A`, which seals `VK` to `pk_N`. A mismatch is refused on `A`; nothing is sealed.

A substituted key must be committed before `nonce_A` is known, so each attempt matches with probability 10⁻⁶ and needs
a visible request. Servers added through SSH skip the code: the desktop reads `pk` over SSH and seals directly.

## Cloud (identity schema, gugu-supabase)

`password_vault_heads` (epoch, revision) · `password_vault_devices` (device, pk, commit, nonces, scope, status) ·
`password_vault_shares` · `password_vault_items` (id, version, epoch, wrapped key, ciphertext, tombstone, revision).
Tables are closed to API roles; owner-checked `SECURITY DEFINER` RPCs only. Saves carry `expected_version`; a mismatch
is refused (`40001`) and the client pulls before the person retries. Every write bumps the head revision; clients poll
the head cheaply and fetch items changed since their revision.

## Local

The existing local vault stays the working copy that Agents use (offline reads and logins keep working). Writes go to
the cloud first and are applied locally only after the RPC succeeds; offline devices cannot edit. A pull applies remote
items through the same revocation path as a local edit, so in-flight uses of a changed credential are invalidated.
First sync on a device with an existing local vault uploads it (same origin + account merge into one item).

## Removing a device

The removing device generates `VK'` (epoch+1), new item keys, re-encrypts every item and re-seals shares for the devices
that remain, in one RPC that also revokes the device. A removed device keeps whatever it already decrypted; it cannot
read anything written afterwards.

## Not defended

A compromised server can withhold or roll back ciphertext (availability), and can see item counts and timing. Root on a
device that holds a key can read what that device can read.
