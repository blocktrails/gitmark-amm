# GitSat AMM: Unique Deposit Addresses

**Status:** Draft
**Issue:** #1
**Authors:** blocktrails

## Abstract

This specification defines a method for deriving unique Bitcoin deposit addresses for each user of the GitSat AMM. Addresses are derived from the AMM's base public key, tweaked with a hash of the user's identity URI.

## Motivation

For the AMM to function trustlessly, users need a way to deposit sats that:

1. Requires no coordination with the AMM operator
2. Unambiguously identifies the depositor
3. Allows the AMM to spend deposited funds
4. Supports multiple identity systems (DIDs, WebIDs)

## Specification

### Identity URIs

Users are identified by a URI. Supported formats:

| Type | Format | Example |
|------|--------|---------|
| did:nostr | `did:nostr:<pubkey-hex>` | `did:nostr:4ccef8c68cf...` |
| WebID | `https://<domain>/<path>#<fragment>` | `https://solid.social/mel/profile/card#me` |
| did:web | `did:web:<domain>:<path>` | `did:web:example.com:users:alice` |

The URI MUST be normalized before hashing:
- Lowercase scheme and host
- No trailing slashes (except root)
- UTF-8 encoded

### Address Derivation

Given:
- `P` = AMM public key (33 bytes, compressed)
- `uri` = User's identity URI (UTF-8 bytes)

The deposit address is derived as:

```
tag = SHA256("gitsat/deposit")
tweak = SHA256(tag || tag || P || uri)
Q = P + tweak * G
```

Where:
- `tag || tag` follows BIP340 tagged hash convention
- `G` is the secp256k1 generator point
- `Q` is the tweaked public key

The deposit address is the bech32m encoding of `Q` (P2TR, witness v1).

### Private Key Derivation

The AMM can derive the private key to spend from a deposit address:

```
d' = d + tweak (mod n)
```

Where:
- `d` = AMM private key (scalar)
- `tweak` = Same tweak computed above
- `n` = secp256k1 curve order

### Pseudocode

```javascript
function deriveDepositAddress(ammPubkey, userUri) {
  const tag = sha256("gitsat/deposit");
  const msg = concat(ammPubkey, utf8Encode(userUri));
  const tweak = taggedHash(tag, msg);

  const tweakedPubkey = pointAdd(ammPubkey, scalarMul(G, tweak));
  const xonly = tweakedPubkey.slice(1); // drop prefix byte

  return bech32mEncode("tb", 1, xonly); // testnet4
}

function deriveDepositPrivkey(ammPrivkey, userUri, ammPubkey) {
  const tag = sha256("gitsat/deposit");
  const msg = concat(ammPubkey, utf8Encode(userUri));
  const tweak = taggedHash(tag, msg);

  return scalarAdd(ammPrivkey, tweak); // mod n
}
```

### Example

```
AMM pubkey: 034e138880a395b71336ee922313f3b86abd0fc29ddc7a58c5efba9d82132f53ef
User URI:   did:nostr:4ccef8c68cf18f8f156a0bb017dfd6e0cc7ebf1672fa2d769e02e2efc700328b

Tag:        SHA256("gitsat/deposit") = <32 bytes>
Message:    <ammPubkey> || <userUri as UTF-8>
Tweak:      taggedHash(tag, message) = <32 bytes>

Deposit pubkey: <tweaked pubkey>
Deposit address: tb1p<...>
```

## Deposit Flow

```
┌─────────┐         ┌─────────┐         ┌─────────┐
│  User   │         │   UI    │         │   AMM   │
└────┬────┘         └────┬────┘         └────┬────┘
     │                   │                   │
     │  Enter URI        │                   │
     │──────────────────>│                   │
     │                   │                   │
     │  Deposit address  │                   │
     │<──────────────────│                   │
     │                   │                   │
     │  Send sats to addr│                   │
     │───────────────────────────────────────>
     │                   │                   │
     │                   │   Detect deposit  │
     │                   │<──────────────────│
     │                   │                   │
     │                   │   Update state    │
     │                   │<──────────────────│
     │                   │                   │
     │  Balance credited │                   │
     │<──────────────────│                   │
     └───────────────────┴───────────────────┘
```

## State Update

When a deposit is detected:

1. Identify user by scanning known URIs for matching address
2. Calculate GSAT output using AMM formula:
   ```
   gsat_out = (sats_in * 997 * tokenReserve) / (satsReserve * 1000 + sats_in * 997)
   ```
3. Update state.json:
   ```json
   {
     "balances": {
       "did:nostr:4ccef8c...": 1000  // +gsat_out
     },
     "amm": {
       "satsReserve": 1001000,       // +sats_in
       "tokenReserve": 999000,       // -gsat_out
       "k": 1000000000000            // unchanged
     }
   }
   ```
4. Anchor state to Bitcoin using blocktrails

## Security Considerations

1. **Tweak uniqueness**: The tagged hash ensures each URI produces a unique tweak
2. **URI normalization**: Prevents duplicate addresses from URI variations
3. **Minimum deposit**: Recommend minimum deposit to prevent dust spam
4. **Confirmation requirement**: Wait for 1+ confirmations before crediting

## Test Vectors

```
AMM privkey: afad07171c5bef640f07896cffbf9af419277d1dcacf44d4cf7e898cb08ad581
AMM pubkey:  034e138880a395b71336ee922313f3b86abd0fc29ddc7a58c5efba9d82132f53ef
AMM address: tb1pfcfc3q9rjkm3xdhwjg338uacd27sls5am3a93300h2wcyye020hsxy40ve

User URI:        did:nostr:4ccef8c68cf18f8f156a0bb017dfd6e0cc7ebf1672fa2d769e02e2efc700328b
Tweak:           edd718b8a975116448227013d7e6a453cabb4fbbc05ac8dfbe866e9fe8ab52ff
Deposit pubkey:  026902dada27054cf00a86f5c1d64ae90a16a9d57b7e50841a87f77a904e2e84db
Deposit address: tb1pdypd4k38q4x0qz5x7hqavjhfpgt2n4tm0egggx587aafqn3wsnds8gm3yf
Deposit privkey: 9d841fcfc5d100c85729f980d7a63f492933eff2dbe16d78ce32999fc8ffe73f

WebID URI:       https://solid.social/mel/profile/card#me
Deposit address: tb1pdlf02asd66kpg86u0f7r98fkesw37vhlksawrm2cp6ye52c3llfqqgewqs
```

## References

- [BIP340: Schnorr Signatures](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki)
- [BIP341: Taproot](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki)
- [BIP352: Silent Payments](https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki)
