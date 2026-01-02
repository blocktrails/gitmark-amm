import { deriveDepositAddress, deriveDepositPrivkey } from './src/deposit.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// Test vectors
const AMM_PRIVKEY = 'afad07171c5bef640f07896cffbf9af419277d1dcacf44d4cf7e898cb08ad581';
const AMM_PUBKEY = '034e138880a395b71336ee922313f3b86abd0fc29ddc7a58c5efba9d82132f53ef';
const AMM_ADDRESS = 'tb1pfcfc3q9rjkm3xdhwjg338uacd27sls5am3a93300h2wcyye020hsxy40ve';

const USER_URI = 'did:nostr:4ccef8c68cf18f8f156a0bb017dfd6e0cc7ebf1672fa2d769e02e2efc700328b';

console.log('=== GitSat Deposit Address Derivation Test ===\n');

// Verify AMM pubkey matches privkey
const computedPubkey = secp256k1.getPublicKey(hexToBytes(AMM_PRIVKEY), true);
console.log('AMM privkey:', AMM_PRIVKEY);
console.log('AMM pubkey (expected):', AMM_PUBKEY);
console.log('AMM pubkey (computed):', bytesToHex(computedPubkey));
console.log('Match:', bytesToHex(computedPubkey) === AMM_PUBKEY);
console.log('');

// Derive deposit address
console.log('User URI:', USER_URI);
const result = deriveDepositAddress(AMM_PUBKEY, USER_URI, 'tbtc4');
console.log('\nDeposit address:', result.address);
console.log('Tweaked pubkey:', result.tweakedPubkey);
console.log('X-only:', result.xonly);
console.log('Tweak:', result.tweak);
console.log('');

// Derive deposit private key
const depositPrivkey = deriveDepositPrivkey(AMM_PRIVKEY, USER_URI, AMM_PUBKEY);
console.log('Deposit privkey:', bytesToHex(depositPrivkey));

// Verify: derived privkey should produce the tweaked pubkey
const verifyPubkey = secp256k1.getPublicKey(depositPrivkey, true);
console.log('Verify pubkey:', bytesToHex(verifyPubkey));
console.log('Match:', bytesToHex(verifyPubkey) === result.tweakedPubkey);
console.log('');

// Test with WebID
const WEBID = 'https://solid.social/mel/profile/card#me';
console.log('=== WebID Test ===');
console.log('WebID:', WEBID);
const webidResult = deriveDepositAddress(AMM_PUBKEY, WEBID, 'tbtc4');
console.log('Deposit address:', webidResult.address);
console.log('');

// Test different URIs produce different addresses
console.log('=== Uniqueness Test ===');
const uris = [
  'did:nostr:0000000000000000000000000000000000000000000000000000000000000001',
  'did:nostr:0000000000000000000000000000000000000000000000000000000000000002',
  'did:nostr:0000000000000000000000000000000000000000000000000000000000000003',
];
for (const uri of uris) {
  const addr = deriveDepositAddress(AMM_PUBKEY, uri, 'tbtc4');
  console.log(`${uri.slice(-8)}: ${addr.address}`);
}

console.log('\n=== Test Vectors for Spec ===');
console.log('```');
console.log(`AMM privkey: ${AMM_PRIVKEY}`);
console.log(`AMM pubkey:  ${AMM_PUBKEY}`);
console.log(`AMM address: ${AMM_ADDRESS}`);
console.log('');
console.log(`User URI:        ${USER_URI}`);
console.log(`Tweak:           ${result.tweak}`);
console.log(`Deposit pubkey:  ${result.tweakedPubkey}`);
console.log(`Deposit address: ${result.address}`);
console.log(`Deposit privkey: ${bytesToHex(depositPrivkey)}`);
console.log('```');
