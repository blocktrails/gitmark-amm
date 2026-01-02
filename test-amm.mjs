/**
 * GitSat AMM Tests
 *
 * Run with: node test-amm.mjs
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// Test state
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(message || `Expected ~${expected}, got ${actual}`);
  }
}

// ============ AMM MATH ============

console.log('\n=== AMM Math Tests ===\n');

// Replicate the AMM math from watcher.js
function calculateGsatOut(satsIn, satsReserve, tokenReserve) {
  const amountInWithFee = BigInt(satsIn) * 997n; // 0.3% fee
  const numerator = amountInWithFee * BigInt(tokenReserve);
  const denominator = BigInt(satsReserve) * 1000n + amountInWithFee;
  return Number(numerator / denominator);
}

function calculateSatsOut(gsatIn, satsReserve, tokenReserve) {
  const fee = BigInt(gsatIn) * 997n;
  return Number((fee * BigInt(satsReserve)) / (BigInt(tokenReserve) * 1000n + fee));
}

test('calculateGsatOut: basic swap', () => {
  // 1M sats reserve, 1M tokens reserve, swap 10000 sats
  const gsatOut = calculateGsatOut(10000, 1000000, 1000000);
  // Should get slightly less than 10000 due to fee and slippage
  assert(gsatOut > 0, 'Should return positive amount');
  assert(gsatOut < 10000, 'Should be less than input due to fee');
  assertClose(gsatOut, 9940, 100, 'Should be approximately 9940');
});

test('calculateGsatOut: large swap has more slippage', () => {
  const small = calculateGsatOut(1000, 1000000, 1000000);
  const large = calculateGsatOut(100000, 1000000, 1000000);

  // Small swap: ~0.997x (mostly fee)
  // Large swap: less than 0.997x (fee + slippage)
  const smallRatio = small / 1000;
  const largeRatio = large / 100000;

  assert(largeRatio < smallRatio, 'Large swaps should have more slippage');
});

test('calculateGsatOut: returns 0 for 0 input', () => {
  const gsatOut = calculateGsatOut(0, 1000000, 1000000);
  assertEqual(gsatOut, 0, 'Should return 0 for 0 input');
});

test('calculateSatsOut: basic swap', () => {
  // 1M sats reserve, 1M tokens reserve, sell 10000 tokens
  const satsOut = calculateSatsOut(10000, 1000000, 1000000);
  assert(satsOut > 0, 'Should return positive amount');
  assert(satsOut < 10000, 'Should be less than input due to fee');
  assertClose(satsOut, 9871, 100, 'Should be approximately 9871');
});

test('calculateSatsOut: inverse of calculateGsatOut', () => {
  const satsReserve = 1000000;
  const tokenReserve = 1000000;

  // Buy tokens
  const gsatOut = calculateGsatOut(10000, satsReserve, tokenReserve);

  // Sell them back (with new reserves)
  const newSatsReserve = satsReserve + 10000;
  const newTokenReserve = tokenReserve - gsatOut;
  const satsBack = calculateSatsOut(gsatOut, newSatsReserve, newTokenReserve);

  // Should get less than original due to fees on both sides
  assert(satsBack < 10000, 'Round trip should lose to fees');
  assert(satsBack > 9800, 'Should not lose more than ~2%');
});

test('calculateGsatOut: constant product k preserved', () => {
  const satsReserve = 1000000;
  const tokenReserve = 500000;
  const k = satsReserve * tokenReserve;

  const satsIn = 50000;
  const gsatOut = calculateGsatOut(satsIn, satsReserve, tokenReserve);

  const newSatsReserve = satsReserve + satsIn;
  const newTokenReserve = tokenReserve - gsatOut;
  const newK = newSatsReserve * newTokenReserve;

  // k should increase slightly due to fees
  assert(newK >= k, 'k should not decrease');
});

// ============ SIGNATURE VERIFICATION ============

console.log('\n=== Signature Verification Tests ===\n');

// Generate test keypair
const testPrivkey = 'a'.repeat(64); // Simple test key
const testPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(testPrivkey)));

test('schnorr sign and verify', () => {
  const message = 'test message';
  const messageHash = sha256(new TextEncoder().encode(message));

  const signature = schnorr.sign(messageHash, hexToBytes(testPrivkey));
  const valid = schnorr.verify(signature, messageHash, hexToBytes(testPubkey));

  assert(valid, 'Signature should be valid');
});

test('schnorr reject invalid signature', () => {
  const message = 'test message';
  const messageHash = sha256(new TextEncoder().encode(message));

  const signature = schnorr.sign(messageHash, hexToBytes(testPrivkey));

  // Tamper with message
  const wrongHash = sha256(new TextEncoder().encode('wrong message'));
  const valid = schnorr.verify(signature, wrongHash, hexToBytes(testPubkey));

  assert(!valid, 'Should reject signature for wrong message');
});

test('sell request signature format', () => {
  const sellRequest = {
    action: 'sell',
    did: `did:nostr:${testPubkey}`,
    gsatAmount: 1000,
    expectedSats: 990,
    timestamp: Date.now()
  };

  const message = JSON.stringify(sellRequest);
  const messageHash = sha256(new TextEncoder().encode(message));
  const signature = schnorr.sign(messageHash, hexToBytes(testPrivkey));

  // Verify
  const valid = schnorr.verify(hexToBytes(bytesToHex(signature)), messageHash, hexToBytes(testPubkey));
  assert(valid, 'Sell request signature should verify');
});

test('transfer request signature format', () => {
  const transferRequest = {
    action: 'transfer',
    from: `did:nostr:${testPubkey}`,
    to: 'did:nostr:' + 'b'.repeat(64),
    amount: 100,
    timestamp: Date.now()
  };

  const message = JSON.stringify(transferRequest);
  const messageHash = sha256(new TextEncoder().encode(message));
  const signature = schnorr.sign(messageHash, hexToBytes(testPrivkey));

  const valid = schnorr.verify(signature, messageHash, hexToBytes(testPubkey));
  assert(valid, 'Transfer request signature should verify');
});

test('withdraw request signature format', () => {
  const withdrawRequest = {
    action: 'withdraw',
    did: `did:nostr:${testPubkey}`,
    amount: 5000,
    address: 'tb1qtest',
    timestamp: Date.now()
  };

  const message = JSON.stringify(withdrawRequest);
  const messageHash = sha256(new TextEncoder().encode(message));
  const signature = schnorr.sign(messageHash, hexToBytes(testPrivkey));

  const valid = schnorr.verify(signature, messageHash, hexToBytes(testPubkey));
  assert(valid, 'Withdraw request signature should verify');
});

// ============ NIP-98 VERIFICATION ============

console.log('\n=== NIP-98 Tests ===\n');

function createNip98Event(method, url, privkey) {
  const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(privkey)));

  const event = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', url],
      ['method', method]
    ],
    content: '',
    pubkey: pubkey
  };

  // Compute event ID
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  const hash = sha256(new TextEncoder().encode(serialized));
  event.id = bytesToHex(hash);

  // Sign event
  const sig = schnorr.sign(hash, hexToBytes(privkey));
  event.sig = bytesToHex(sig);

  return event;
}

function verifyNip98Event(event) {
  // Verify event ID
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  const hash = sha256(new TextEncoder().encode(serialized));
  const expectedId = bytesToHex(hash);

  if (event.id !== expectedId) {
    return { valid: false, error: 'Event ID mismatch' };
  }

  // Verify signature
  try {
    const valid = schnorr.verify(hexToBytes(event.sig), hash, hexToBytes(event.pubkey));
    return { valid, error: valid ? null : 'Invalid signature' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

test('NIP-98 event creation and verification', () => {
  const event = createNip98Event('GET', 'http://localhost:3456/api/quote', testPrivkey);

  assertEqual(event.kind, 27235, 'Kind should be 27235');
  assert(event.id.length === 64, 'ID should be 64 hex chars');
  assert(event.sig.length === 128, 'Signature should be 128 hex chars');

  const result = verifyNip98Event(event);
  assert(result.valid, 'Event should verify');
});

test('NIP-98 event has correct tags', () => {
  const url = 'http://localhost:3456/api/quote';
  const method = 'GET';
  const event = createNip98Event(method, url, testPrivkey);

  const uTag = event.tags.find(t => t[0] === 'u');
  const methodTag = event.tags.find(t => t[0] === 'method');

  assert(uTag, 'Should have u tag');
  assert(methodTag, 'Should have method tag');
  assertEqual(uTag[1], url, 'URL should match');
  assertEqual(methodTag[1], method, 'Method should match');
});

test('NIP-98 rejects tampered event', () => {
  const event = createNip98Event('GET', 'http://localhost:3456/api/quote', testPrivkey);

  // Tamper with URL
  event.tags[0][1] = 'http://evil.com/hack';

  const result = verifyNip98Event(event);
  assert(!result.valid, 'Should reject tampered event');
});

test('NIP-98 base64 encoding', () => {
  const event = createNip98Event('GET', 'http://localhost:3456/api/quote', testPrivkey);

  // Encode as base64 (like Authorization header)
  const base64 = Buffer.from(JSON.stringify(event)).toString('base64');

  // Decode and verify
  const decoded = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  assertEqual(decoded.kind, event.kind, 'Kind should survive encoding');
  assertEqual(decoded.id, event.id, 'ID should survive encoding');

  const result = verifyNip98Event(decoded);
  assert(result.valid, 'Decoded event should verify');
});

// ============ SUMMARY ============

console.log('\n=== Summary ===\n');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
}
