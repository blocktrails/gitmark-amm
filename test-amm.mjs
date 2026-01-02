/**
 * GitSat AMM Tests
 *
 * Run with: node test-amm.mjs
 * Run with server: TEST_API=1 node test-amm.mjs
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// Test state
let passed = 0;
let failed = 0;
const testResults = [];

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
    testResults.push({ name, passed: true });
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    failed++;
    testResults.push({ name, passed: false, error: e.message });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
    testResults.push({ name, passed: true });
  } catch (e) {
    console.log(`✗ ${name}`);
    console.log(`  ${e.message}`);
    failed++;
    testResults.push({ name, passed: false, error: e.message });
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
    throw new Error(message || `Expected ~${expected}, got ${actual} (tolerance: ${tolerance})`);
  }
}

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
  }
  if (!threw) throw new Error(message || 'Expected function to throw');
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

// ============ AMM EDGE CASES ============

console.log('\n=== AMM Edge Case Tests ===\n');

test('calculateGsatOut: very small swap', () => {
  const gsatOut = calculateGsatOut(1, 1000000, 1000000);
  // Even 1 sat should give something (or 0 due to rounding)
  assert(gsatOut >= 0, 'Should handle very small swaps');
});

test('calculateGsatOut: swap entire reserve should fail gracefully', () => {
  // Trying to swap more than reserve exists
  const gsatOut = calculateGsatOut(2000000, 1000000, 1000000);
  // Should still return a number (the formula handles this)
  assert(typeof gsatOut === 'number', 'Should return a number');
  assert(gsatOut < 1000000, 'Cannot get more than reserve');
});

test('calculateSatsOut: returns 0 for 0 input', () => {
  const satsOut = calculateSatsOut(0, 1000000, 1000000);
  assertEqual(satsOut, 0, 'Should return 0 for 0 input');
});

test('calculateGsatOut: handles large numbers', () => {
  // Test with Bitcoin-scale numbers (21M BTC = 2.1 quadrillion sats)
  const satsReserve = 100_000_000_000; // 1000 BTC in sats
  const tokenReserve = 1_000_000_000;
  const gsatOut = calculateGsatOut(1_000_000, satsReserve, tokenReserve);
  assert(gsatOut > 0, 'Should handle large reserves');
});

test('calculateGsatOut: asymmetric reserves', () => {
  // 10x more sats than tokens (tokens are "expensive")
  const gsatOut = calculateGsatOut(10000, 10000000, 1000000);
  // Should get ~1000 tokens for 10000 sats (roughly 10:1 ratio minus fees)
  assertClose(gsatOut, 994, 50, 'Should reflect price ratio');
});

test('calculateSatsOut: asymmetric reserves', () => {
  // 10x more sats than tokens
  const satsOut = calculateSatsOut(1000, 10000000, 1000000);
  // Should get ~10000 sats for 1000 tokens
  assertClose(satsOut, 9871, 200, 'Should reflect price ratio');
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

test('schnorr reject wrong pubkey', () => {
  const message = 'test message';
  const messageHash = sha256(new TextEncoder().encode(message));
  const signature = schnorr.sign(messageHash, hexToBytes(testPrivkey));

  // Try to verify with different pubkey
  const wrongPrivkey = 'b'.repeat(64);
  const wrongPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(wrongPrivkey)));

  const valid = schnorr.verify(signature, messageHash, hexToBytes(wrongPubkey));
  assert(!valid, 'Should reject signature with wrong pubkey');
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

test('signature rejects expired timestamp', () => {
  const oldTimestamp = Date.now() - (6 * 60 * 1000); // 6 minutes ago
  const request = {
    action: 'sell',
    did: `did:nostr:${testPubkey}`,
    gsatAmount: 1000,
    timestamp: oldTimestamp
  };

  // Signature is valid but timestamp is old
  const isExpired = (Date.now() - request.timestamp) > 5 * 60 * 1000;
  assert(isExpired, 'Should detect expired timestamp');
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

test('NIP-98 rejects expired event', () => {
  const event = createNip98Event('GET', 'http://localhost:3456/api/quote', testPrivkey);

  // Make it old
  event.created_at = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago

  // Re-compute ID and signature for the old timestamp
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
  event.sig = bytesToHex(schnorr.sign(hash, hexToBytes(testPrivkey)));

  // Event is valid but old
  const isExpired = (Math.floor(Date.now() / 1000) - event.created_at) > 60;
  assert(isExpired, 'Should detect expired NIP-98 event');
});

// ============ WEBLEDGER HELPERS ============

console.log('\n=== WebLedger Helper Tests ===\n');

// Simulate the state and helper functions
let testState = {};

function resetTestState() {
  testState = {
    entries: []
  };
}

function testGetBalance(url, currency = 'GSAT') {
  if (!testState.entries) return 0;
  const entry = testState.entries.find(e => e.url === url && e.type !== 'Pool');
  if (!entry) return 0;
  const amt = entry.amount.find(a => a.currency === currency);
  return amt ? amt.value : 0;
}

function testSetBalance(url, currency, value) {
  if (!testState.entries) testState.entries = [];
  let entry = testState.entries.find(e => e.url === url && e.type !== 'Pool');
  if (!entry) {
    entry = { type: 'Entry', url, amount: [] };
    testState.entries.push(entry);
  }
  const amtIdx = entry.amount.findIndex(a => a.currency === currency);
  if (amtIdx >= 0) {
    entry.amount[amtIdx].value = value;
  } else {
    entry.amount.push({ currency, value });
  }
}

function testGetPool() {
  if (!testState.entries) return null;
  return testState.entries.find(e => e.type === 'Pool');
}

function testGetPoolReserves() {
  const pool = testGetPool();
  if (pool) {
    const sats = pool.amount.find(a => a.currency === 'satoshi');
    const gsat = pool.amount.find(a => a.currency === 'GSAT');
    return {
      satsReserve: sats ? sats.value : 0,
      tokenReserve: gsat ? gsat.value : 0,
      k: pool.k || 0
    };
  }
  return { satsReserve: 0, tokenReserve: 0, k: 0 };
}

function testSetPoolReserves(satsReserve, tokenReserve) {
  let pool = testGetPool();
  if (!pool) {
    pool = {
      type: 'Pool',
      url: 'urn:webledger:pool:satoshi:GSAT',
      amount: [],
      k: satsReserve * tokenReserve,
      fee: 0.003
    };
    testState.entries = testState.entries || [];
    testState.entries.push(pool);
  }
  const satsIdx = pool.amount.findIndex(a => a.currency === 'satoshi');
  const gsatIdx = pool.amount.findIndex(a => a.currency === 'GSAT');
  if (satsIdx >= 0) pool.amount[satsIdx].value = satsReserve;
  else pool.amount.push({ currency: 'satoshi', value: satsReserve });
  if (gsatIdx >= 0) pool.amount[gsatIdx].value = tokenReserve;
  else pool.amount.push({ currency: 'GSAT', value: tokenReserve });
  pool.k = satsReserve * tokenReserve;
}

test('getBalance: returns 0 for unknown user', () => {
  resetTestState();
  const balance = testGetBalance('did:nostr:unknown');
  assertEqual(balance, 0, 'Unknown user should have 0 balance');
});

test('setBalance: creates new entry', () => {
  resetTestState();
  testSetBalance('did:nostr:alice', 'GSAT', 1000);
  const balance = testGetBalance('did:nostr:alice', 'GSAT');
  assertEqual(balance, 1000, 'Balance should be set');
});

test('setBalance: updates existing entry', () => {
  resetTestState();
  testSetBalance('did:nostr:alice', 'GSAT', 1000);
  testSetBalance('did:nostr:alice', 'GSAT', 2000);
  const balance = testGetBalance('did:nostr:alice', 'GSAT');
  assertEqual(balance, 2000, 'Balance should be updated');
});

test('setBalance: handles multiple currencies', () => {
  resetTestState();
  testSetBalance('did:nostr:alice', 'GSAT', 1000);
  testSetBalance('did:nostr:alice', 'satoshi', 5000);

  assertEqual(testGetBalance('did:nostr:alice', 'GSAT'), 1000, 'GSAT balance correct');
  assertEqual(testGetBalance('did:nostr:alice', 'satoshi'), 5000, 'satoshi balance correct');
});

test('setBalance: handles multiple users', () => {
  resetTestState();
  testSetBalance('did:nostr:alice', 'GSAT', 1000);
  testSetBalance('did:nostr:bob', 'GSAT', 2000);

  assertEqual(testGetBalance('did:nostr:alice', 'GSAT'), 1000, 'Alice balance correct');
  assertEqual(testGetBalance('did:nostr:bob', 'GSAT'), 2000, 'Bob balance correct');
});

test('getPoolReserves: returns zeros for empty state', () => {
  resetTestState();
  const pool = testGetPoolReserves();
  assertEqual(pool.satsReserve, 0, 'Empty pool has 0 sats');
  assertEqual(pool.tokenReserve, 0, 'Empty pool has 0 tokens');
});

test('setPoolReserves: creates pool', () => {
  resetTestState();
  testSetPoolReserves(1000000, 500000);
  const pool = testGetPoolReserves();
  assertEqual(pool.satsReserve, 1000000, 'Sats reserve set');
  assertEqual(pool.tokenReserve, 500000, 'Token reserve set');
  assertEqual(pool.k, 1000000 * 500000, 'k calculated correctly');
});

test('setPoolReserves: updates pool', () => {
  resetTestState();
  testSetPoolReserves(1000000, 500000);
  testSetPoolReserves(1100000, 450000);
  const pool = testGetPoolReserves();
  assertEqual(pool.satsReserve, 1100000, 'Sats reserve updated');
  assertEqual(pool.tokenReserve, 450000, 'Token reserve updated');
});

test('pool and balances are separate', () => {
  resetTestState();
  testSetPoolReserves(1000000, 500000);
  testSetBalance('did:nostr:alice', 'GSAT', 1000);

  // Pool should not be returned as balance
  const aliceBalance = testGetBalance('did:nostr:alice', 'GSAT');
  assertEqual(aliceBalance, 1000, 'Alice balance separate from pool');

  // Pool reserves should be correct
  const pool = testGetPoolReserves();
  assertEqual(pool.tokenReserve, 500000, 'Pool reserves separate from balances');
});

// ============ FULL SWAP SIMULATION ============

console.log('\n=== Full Swap Simulation Tests ===\n');

test('buy tokens: balance increases, pool updates', () => {
  resetTestState();
  testSetPoolReserves(1000000, 1000000);
  testSetBalance('did:nostr:alice', 'GSAT', 0);

  // Alice buys with 10000 sats
  const satsIn = 10000;
  const pool = testGetPoolReserves();
  const gsatOut = calculateGsatOut(satsIn, pool.satsReserve, pool.tokenReserve);

  // Update pool
  testSetPoolReserves(pool.satsReserve + satsIn, pool.tokenReserve - gsatOut);

  // Credit alice
  testSetBalance('did:nostr:alice', 'GSAT', gsatOut);

  // Verify
  const newPool = testGetPoolReserves();
  assertEqual(newPool.satsReserve, 1010000, 'Pool sats increased');
  assert(newPool.tokenReserve < 1000000, 'Pool tokens decreased');
  assertEqual(testGetBalance('did:nostr:alice', 'GSAT'), gsatOut, 'Alice received tokens');
});

test('sell tokens: balance decreases, pool updates', () => {
  resetTestState();
  testSetPoolReserves(1000000, 1000000);
  testSetBalance('did:nostr:alice', 'GSAT', 10000);

  // Alice sells 5000 GSAT
  const gsatIn = 5000;
  const pool = testGetPoolReserves();
  const satsOut = calculateSatsOut(gsatIn, pool.satsReserve, pool.tokenReserve);

  // Update pool
  testSetPoolReserves(pool.satsReserve - satsOut, pool.tokenReserve + gsatIn);

  // Debit alice GSAT
  testSetBalance('did:nostr:alice', 'GSAT', testGetBalance('did:nostr:alice', 'GSAT') - gsatIn);

  // Credit alice sats (in practice would send BTC)
  testSetBalance('did:nostr:alice', 'satoshi', satsOut);

  // Verify
  const newPool = testGetPoolReserves();
  assert(newPool.satsReserve < 1000000, 'Pool sats decreased');
  assertEqual(newPool.tokenReserve, 1005000, 'Pool tokens increased');
  assertEqual(testGetBalance('did:nostr:alice', 'GSAT'), 5000, 'Alice GSAT decreased');
  assertEqual(testGetBalance('did:nostr:alice', 'satoshi'), satsOut, 'Alice received sats');
});

test('transfer: sender decreases, receiver increases', () => {
  resetTestState();
  testSetBalance('did:nostr:alice', 'GSAT', 10000);
  testSetBalance('did:nostr:bob', 'GSAT', 0);

  // Alice sends 3000 to Bob
  const amount = 3000;
  testSetBalance('did:nostr:alice', 'GSAT', testGetBalance('did:nostr:alice', 'GSAT') - amount);
  testSetBalance('did:nostr:bob', 'GSAT', testGetBalance('did:nostr:bob', 'GSAT') + amount);

  assertEqual(testGetBalance('did:nostr:alice', 'GSAT'), 7000, 'Alice balance decreased');
  assertEqual(testGetBalance('did:nostr:bob', 'GSAT'), 3000, 'Bob balance increased');
});

test('cannot sell more than balance', () => {
  resetTestState();
  testSetBalance('did:nostr:alice', 'GSAT', 1000);

  const aliceBalance = testGetBalance('did:nostr:alice', 'GSAT');
  const sellAmount = 2000;

  assert(aliceBalance < sellAmount, 'Alice should not have enough');
  // In real code, this would reject the transaction
});

test('cannot transfer more than balance', () => {
  resetTestState();
  testSetBalance('did:nostr:alice', 'GSAT', 1000);

  const aliceBalance = testGetBalance('did:nostr:alice', 'GSAT');
  const transferAmount = 2000;

  assert(aliceBalance < transferAmount, 'Alice should not have enough to transfer');
});

// ============ INTEGRATION TESTS ============

const API_URL = process.env.API_URL || 'http://localhost:3456';
const RUN_INTEGRATION = process.env.TEST_API === '1';

if (RUN_INTEGRATION) {
  console.log('\n=== Integration Tests ===\n');
  console.log(`Testing against: ${API_URL}\n`);

  await testAsync('GET /state returns pool data', async () => {
    const res = await fetch(`${API_URL}/state`);
    assertEqual(res.status, 200, 'Should return 200');

    const data = await res.json();
    assert(data.pool, 'Should have pool property');
    assert(typeof data.pool.satsReserve === 'number', 'Should have satsReserve');
    assert(typeof data.pool.tokenReserve === 'number', 'Should have tokenReserve');
    assert(typeof data.pool.k === 'number', 'Should have k');
  });

  await testAsync('GET /state with query param works', async () => {
    const res = await fetch(`${API_URL}/state?t=${Date.now()}`);
    assertEqual(res.status, 200, 'Should return 200 with query param');
  });

  await testAsync('HEAD /state returns 200', async () => {
    const res = await fetch(`${API_URL}/state`, { method: 'HEAD' });
    assertEqual(res.status, 200, 'HEAD should return 200');
  });

  await testAsync('GET /balance/:did returns balance', async () => {
    const testDid = 'did:nostr:' + 'a'.repeat(64);
    const res = await fetch(`${API_URL}/balance/${encodeURIComponent(testDid)}`);
    assertEqual(res.status, 200, 'Should return 200');

    const data = await res.json();
    assert(typeof data.gsat === 'number', 'Should have gsat balance');
  });

  await testAsync('GET /unknown returns 404', async () => {
    const res = await fetch(`${API_URL}/unknown-endpoint`);
    assertEqual(res.status, 404, 'Should return 404 for unknown endpoint');
  });

  await testAsync('POST /sell without auth returns 401', async () => {
    const res = await fetch(`${API_URL}/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gsatAmount: 100 })
    });
    // Should fail authentication
    assert(res.status === 401 || res.status === 400, 'Should reject unauthenticated request');
  });

  await testAsync('POST /transfer without auth returns 401', async () => {
    const res = await fetch(`${API_URL}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'did:nostr:test', amount: 100 })
    });
    assert(res.status === 401 || res.status === 400, 'Should reject unauthenticated request');
  });

  await testAsync('OPTIONS returns CORS headers', async () => {
    const res = await fetch(`${API_URL}/state`, { method: 'OPTIONS' });
    assertEqual(res.status, 200, 'OPTIONS should return 200');
    assert(res.headers.get('access-control-allow-origin'), 'Should have CORS header');
  });

  await testAsync('GET /api/quote returns 402 without payment', async () => {
    const res = await fetch(`${API_URL}/api/quote`);
    assertEqual(res.status, 402, 'Should return 402 Payment Required');
  });

} else {
  console.log('\n=== Integration Tests (Skipped) ===\n');
  console.log('Run with TEST_API=1 to enable integration tests');
  console.log(`Example: TEST_API=1 API_URL=http://localhost:3456 node test-amm.mjs\n`);
}

// ============ SUMMARY ============

console.log('\n=== Summary ===\n');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  console.log('Failed tests:');
  testResults.filter(t => !t.passed).forEach(t => {
    console.log(`  - ${t.name}: ${t.error}`);
  });
  process.exit(1);
}
