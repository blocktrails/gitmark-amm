/**
 * GitSat AMM - Deposit Address Derivation
 *
 * Derives unique deposit addresses per user by tweaking the AMM pubkey
 * with a hash of the user's identity URI.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// Tagged hash per BIP340
function taggedHash(tag, ...data) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  // Concatenate all byte arrays
  const totalLen = data.reduce((sum, arr) => sum + arr.length, 0);
  const combined = new Uint8Array(tagHash.length * 2 + totalLen);
  combined.set(tagHash, 0);
  combined.set(tagHash, tagHash.length);
  let offset = tagHash.length * 2;
  for (const arr of data) {
    combined.set(arr, offset);
    offset += arr.length;
  }
  return sha256(combined);
}

// Normalize URI for consistent hashing
function normalizeUri(uri) {
  try {
    // For URLs, normalize using URL API
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      const url = new URL(uri);
      return url.href.replace(/\/$/, ''); // remove trailing slash
    }
    // For DIDs, lowercase and trim
    return uri.toLowerCase().trim();
  } catch {
    return uri.toLowerCase().trim();
  }
}

/**
 * Derive a unique deposit address for a user
 *
 * @param {Uint8Array|string} ammPubkey - AMM public key (33 bytes compressed, or hex)
 * @param {string} userUri - User's identity URI (did:nostr:..., WebID, etc.)
 * @param {string} network - 'tbtc4' for testnet4, 'btc' for mainnet
 * @returns {object} { address, tweakedPubkey, tweak }
 */
export function deriveDepositAddress(ammPubkey, userUri, network = 'tbtc4') {
  // Normalize inputs
  const pubkeyBytes = typeof ammPubkey === 'string' ? hexToBytes(ammPubkey) : ammPubkey;
  const normalizedUri = normalizeUri(userUri);
  const uriBytes = new TextEncoder().encode(normalizedUri);

  // Compute tweak: H("gitsat/deposit", ammPubkey || userUri)
  const tweak = taggedHash('gitsat/deposit', pubkeyBytes, uriBytes);

  // Tweak the public key: Q = P + tweak*G
  const pubkeyHex = typeof ammPubkey === 'string' ? ammPubkey : bytesToHex(pubkeyBytes);
  const P = secp256k1.Point.fromHex(pubkeyHex);
  const tweakScalar = BigInt('0x' + bytesToHex(tweak));
  const tweakPoint = secp256k1.Point.BASE.multiply(tweakScalar);
  const Q = P.add(tweakPoint);

  // Get x-only pubkey (drop prefix byte from compressed pubkey)
  const tweakedPubkey = Q.toBytes(); // 33 bytes compressed
  const xonly = tweakedPubkey.slice(1); // 32 bytes x-only

  // Encode as bech32m address
  const address = encodeBech32m(network === 'btc' ? 'bc' : 'tb', 1, xonly);

  return {
    address,
    tweakedPubkey: bytesToHex(tweakedPubkey),
    xonly: bytesToHex(xonly),
    tweak: bytesToHex(tweak),
    userUri: normalizedUri
  };
}

/**
 * Derive the private key to spend from a deposit address
 *
 * @param {Uint8Array|string} ammPrivkey - AMM private key (32 bytes, or hex)
 * @param {string} userUri - User's identity URI
 * @param {Uint8Array|string} ammPubkey - AMM public key (for tweak computation)
 * @returns {Uint8Array} Derived private key (32 bytes)
 */
export function deriveDepositPrivkey(ammPrivkey, userUri, ammPubkey) {
  const privkeyBytes = typeof ammPrivkey === 'string' ? hexToBytes(ammPrivkey) : ammPrivkey;
  const pubkeyBytes = typeof ammPubkey === 'string' ? hexToBytes(ammPubkey) : ammPubkey;
  const normalizedUri = normalizeUri(userUri);
  const uriBytes = new TextEncoder().encode(normalizedUri);

  // Same tweak as address derivation
  const tweak = taggedHash('gitsat/deposit', pubkeyBytes, uriBytes);

  // d' = d + tweak (mod n)
  const d = BigInt('0x' + bytesToHex(privkeyBytes));
  const t = BigInt('0x' + bytesToHex(tweak));
  const n = secp256k1.Point.Fn.ORDER; // curve order
  const dPrime = (d + t) % n;

  // Convert back to bytes
  const dPrimeHex = dPrime.toString(16).padStart(64, '0');
  return hexToBytes(dPrimeHex);
}

/**
 * Check if an address belongs to a user
 *
 * @param {string} address - Bitcoin address to check
 * @param {Uint8Array|string} ammPubkey - AMM public key
 * @param {string} userUri - User's identity URI
 * @returns {boolean}
 */
export function isUserDepositAddress(address, ammPubkey, userUri) {
  const derived = deriveDepositAddress(ammPubkey, userUri);
  return derived.address === address;
}

/**
 * Find which user deposited to an address
 *
 * @param {string} address - Bitcoin address
 * @param {Uint8Array|string} ammPubkey - AMM public key
 * @param {string[]} knownUris - List of known user URIs
 * @returns {string|null} Matching URI or null
 */
export function findUserByAddress(address, ammPubkey, knownUris) {
  for (const uri of knownUris) {
    if (isUserDepositAddress(address, ammPubkey, uri)) {
      return uri;
    }
  }
  return null;
}

// Bech32m encoding
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
  ret.push(0);
  for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
  return ret;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [], maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

function encodeBech32m(hrp, witnessVersion, data) {
  const converted = convertBits(data, 8, 5, true);
  const values = [witnessVersion, ...converted];
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const checksum = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymod >> (5 * (5 - i))) & 31);
  }
  return hrp + '1' + [...values, ...checksum].map(d => CHARSET[d]).join('');
}

// Export for testing
export { taggedHash, normalizeUri, encodeBech32m };
