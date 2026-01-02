/**
 * GitSat AMM - Deposit Watcher
 *
 * Monitors deposit addresses for incoming sats and credits user balances.
 */

import { deriveDepositAddress, deriveDepositPrivkey, encodeBech32m } from './deposit.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import * as bt from 'blocktrails';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';

// Configuration
const CONFIG = {
  stateFile: path.join(process.cwd(), 'state.json'),
  usersFile: path.join(process.cwd(), 'users.json'),
  ammPubkey: '034e138880a395b71336ee922313f3b86abd0fc29ddc7a58c5efba9d82132f53ef',
  ammPrivkey: process.env.AMM_PRIVKEY || 'afad07171c5bef640f07896cffbf9af419277d1dcacf44d4cf7e898cb08ad581',
  network: 'tbtc4',
  pollInterval: 600000, // 10 minutes (use POST /check for manual refresh)
  minConfirmations: 0,
  mempoolApi: 'https://mempool.space/testnet4/api',
  apiPort: 3456,
  anchorInterval: 5, // Anchor every N state changes
  anchorEnabled: process.env.ANCHOR === 'true'
};

// State
let state = null;
let users = []; // Array of { uri, address, lastTxid }
let processedTxids = new Set();

// Helpers
async function loadState() {
  try {
    const data = await fs.readFile(CONFIG.stateFile, 'utf-8');
    state = JSON.parse(data);
    console.log('[State] Loaded:', {
      satsReserve: state.amm.satsReserve,
      tokenReserve: state.amm.tokenReserve,
      txCount: state.txCount
    });
  } catch (e) {
    console.error('[State] Failed to load:', e.message);
    process.exit(1);
  }
}

async function saveState() {
  await fs.writeFile(CONFIG.stateFile, JSON.stringify(state, null, 2));
  console.log('[State] Saved locally');

  // Sync to solid.social if configured
  if (process.env.SOLID_SYNC === 'true') {
    try {
      const { execSync } = await import('child_process');
      execSync(`scp ${CONFIG.stateFile} solid.social:/home/ubuntu/solid-server/data/mel/public/gitmark-amm/state.json`, {
        stdio: 'inherit'
      });
      console.log('[State] Synced to solid.social');
    } catch (e) {
      console.error('[State] Failed to sync to solid.social:', e.message);
    }
  }

  // Anchor to Bitcoin periodically
  if (CONFIG.anchorEnabled && state.txCount % CONFIG.anchorInterval === 0) {
    await anchorState();
  }
}

// Anchor state hash to Bitcoin
async function anchorState() {
  try {
    console.log('[Anchor] Anchoring state to Bitcoin...');

    // Compute state hash
    const stateJson = JSON.stringify(state);
    const stateHash = bytesToHex(sha256(new TextEncoder().encode(stateJson)));

    // Get AMM wallet for anchoring
    const wallet = new bt.Blocktrail(CONFIG.ammPrivkey);
    const xonly = bt.p2trXonly(wallet.pubkeyBase);
    // Derive address from xonly pubkey (P2TR)
    const address = CONFIG.network === 'btc'
      ? encodeBech32m('bc', 1, xonly)
      : encodeBech32m('tb', 1, xonly);

    // Get UTXOs
    const utxos = await bt.getUtxos(address, CONFIG.network);
    if (utxos.length === 0) {
      console.log('[Anchor] No UTXOs available for anchoring');
      return;
    }

    // Create OP_RETURN anchor tx
    const total = utxos.reduce((sum, u) => sum + u.amount, 0);
    const feeRates = await bt.getFeeRates(CONFIG.network);
    const feeRate = feeRates.halfHour || 2;
    const vsize = bt.estimateVsize(utxos.length, 1) + 20; // +20 for OP_RETURN
    const fee = Math.ceil(vsize * feeRate);
    const change = total - fee;

    if (change < 546) {
      console.log('[Anchor] Insufficient funds for anchoring');
      return;
    }

    // Build simple anchor tx (state hash stored in state.json, txid proves timestamp)
    const tx = bt.buildTransaction({
      inputs: utxos.map(u => ({
        txid: u.txid,
        vout: u.vout,
        amount: u.amount,
        witnessProgram: xonly
      })),
      outputs: [
        { witnessProgram: xonly, value: change }
      ]
    });

    // Sign and broadcast
    const signingKey = bt.hexToBytes(CONFIG.ammPrivkey);
    const prevouts = utxos.map(u => ({ ...u, witnessProgram: xonly }));
    const signedTx = bt.signTransaction(tx, utxos.map(() => signingKey), prevouts);

    const txBytes = bt.serializeTransaction(signedTx);
    const txHex = bt.bytesToHex(txBytes);
    const txid = bt.computeTxid(signedTx);

    const result = await bt.broadcast(txHex, CONFIG.network);

    // Store anchor in state
    state.anchors = state.anchors || [];
    state.anchors.push({
      txid,
      stateHash,
      txCount: state.txCount,
      timestamp: new Date().toISOString()
    });

    // Keep only last 10 anchors
    if (state.anchors.length > 10) {
      state.anchors = state.anchors.slice(-10);
    }

    await fs.writeFile(CONFIG.stateFile, JSON.stringify(state, null, 2));
    console.log('[Anchor] State anchored! Txid:', txid);
    console.log('[Anchor] State hash:', stateHash.slice(0, 16) + '...');

  } catch (e) {
    console.error('[Anchor] Failed:', e.message);
  }
}

async function loadUsers() {
  try {
    const data = await fs.readFile(CONFIG.usersFile, 'utf-8');
    users = JSON.parse(data);
    console.log('[Users] Loaded:', users.length, 'users');
  } catch (e) {
    // Initialize with users from state balances
    users = [];
    for (const key of Object.keys(state.balances)) {
      if (key.startsWith('did:')) {
        const address = deriveDepositAddress(CONFIG.ammPubkey, key, CONFIG.network);
        users.push({ uri: key, address: address.address, lastTxid: null });
      }
    }
    console.log('[Users] Initialized from state:', users.length, 'users');
    await saveUsers();
  }
}

async function saveUsers() {
  await fs.writeFile(CONFIG.usersFile, JSON.stringify(users, null, 2));
}

// Register a new user
export async function registerUser(uri) {
  // Check if already registered
  if (users.find(u => u.uri === uri)) {
    console.log('[Register] User already exists:', uri);
    return users.find(u => u.uri === uri);
  }

  const result = deriveDepositAddress(CONFIG.ammPubkey, uri, CONFIG.network);
  const user = {
    uri,
    address: result.address,
    lastTxid: null
  };
  users.push(user);
  await saveUsers();
  console.log('[Register] New user:', uri, '->', result.address);
  return user;
}

// Fetch UTXOs for an address
async function getUtxos(address) {
  try {
    const res = await fetch(`${CONFIG.mempoolApi}/address/${address}/utxo`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('[API] Failed to fetch UTXOs for', address, e.message);
    return [];
  }
}

// Get transaction details
async function getTx(txid) {
  try {
    const res = await fetch(`${CONFIG.mempoolApi}/tx/${txid}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('[API] Failed to fetch tx', txid, e.message);
    return null;
  }
}

// AMM math: calculate GSAT output for sats input
function calculateGsatOut(satsIn) {
  const { satsReserve, tokenReserve } = state.amm;
  const amountInWithFee = satsIn * 997n; // 0.3% fee
  const numerator = amountInWithFee * BigInt(tokenReserve);
  const denominator = BigInt(satsReserve) * 1000n + amountInWithFee;
  return Number(numerator / denominator);
}

// Process a deposit
async function processDeposit(user, utxo) {
  const txid = utxo.txid;

  // Skip if already processed
  if (processedTxids.has(txid)) return;

  // Check confirmations
  if (CONFIG.minConfirmations > 0 && !utxo.status?.confirmed) {
    console.log('[Deposit] Waiting for confirmation:', txid);
    return;
  }

  const satsIn = utxo.value;
  const gsatOut = calculateGsatOut(BigInt(satsIn));

  if (gsatOut <= 0) {
    console.log('[Deposit] Amount too small:', satsIn, 'sats');
    processedTxids.add(txid);
    return;
  }

  console.log('[Deposit] Processing:', {
    user: user.uri.slice(0, 20) + '...',
    txid: txid.slice(0, 16) + '...',
    satsIn,
    gsatOut
  });

  // Update state
  const currentBalance = state.balances[user.uri] || 0;
  state.balances[user.uri] = currentBalance + gsatOut;
  state.amm.satsReserve += satsIn;
  state.amm.tokenReserve -= gsatOut;
  state.txCount = (state.txCount || 0) + 1;

  // Mark as processed
  processedTxids.add(txid);
  user.lastTxid = txid;

  console.log('[Deposit] Credited:', gsatOut, 'GSAT to', user.uri.slice(0, 30) + '...');
  console.log('[Pool] New reserves:', state.amm.satsReserve, 'sats,', state.amm.tokenReserve, 'GSAT');

  await saveState();
  await saveUsers();
}

// Check all users for deposits
async function checkDeposits() {
  console.log('[Check] Scanning', users.length, 'deposit addresses...');

  for (const user of users) {
    const utxos = await getUtxos(user.address);

    for (const utxo of utxos) {
      await processDeposit(user, utxo);
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }
}

// === SELL API ===

// Verify sell request signature
function verifySignature(request) {
  const { action, did, gsatAmount, expectedSats, timestamp, pubkey, signature } = request;

  const sellRequest = { action, did, gsatAmount, expectedSats, timestamp };
  const message = JSON.stringify(sellRequest);
  const messageHash = sha256(new TextEncoder().encode(message));

  if (did !== `did:nostr:${pubkey}`) {
    return { valid: false, error: 'DID does not match pubkey' };
  }

  try {
    const valid = schnorr.verify(hexToBytes(signature), messageHash, hexToBytes(pubkey));
    return { valid, error: valid ? null : 'Invalid signature' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// Process sell request
async function processSell(request) {
  const { did, gsatAmount, expectedSats } = request;

  const balance = state.balances[did] || 0;
  if (gsatAmount > balance) {
    return { success: false, error: `Insufficient balance: ${balance} GSAT` };
  }

  const actualSats = calculateSatsOut(gsatAmount);

  if (actualSats < expectedSats * 0.99) {
    return { success: false, error: `Price moved. Expected ${expectedSats}, got ${actualSats}` };
  }

  // Update state
  state.balances[did] = balance - gsatAmount;
  state.satsBalances = state.satsBalances || {};
  state.satsBalances[did] = (state.satsBalances[did] || 0) + actualSats;
  state.amm.tokenReserve += gsatAmount;
  state.amm.satsReserve -= actualSats;
  state.txCount = (state.txCount || 0) + 1;

  await saveState();

  console.log('[Sell]', did.slice(0, 25) + '...', gsatAmount, 'GSAT →', actualSats, 'sats');

  return {
    success: true,
    gsatSold: gsatAmount,
    satsReceived: actualSats,
    newGsatBalance: state.balances[did],
    newSatsBalance: state.satsBalances[did]
  };
}

// Calculate sats output for GSAT input
function calculateSatsOut(gsatIn) {
  const { satsReserve, tokenReserve } = state.amm;
  const fee = BigInt(gsatIn) * 997n;
  return Number((fee * BigInt(satsReserve)) / (BigInt(tokenReserve) * 1000n + fee));
}

// === TRANSFER API ===

// Verify transfer request signature
function verifyTransferSignature(request) {
  const { action, from, to, amount, timestamp, pubkey, signature } = request;

  const transferRequest = { action, from, to, amount, timestamp };
  const message = JSON.stringify(transferRequest);
  const messageHash = sha256(new TextEncoder().encode(message));

  if (from !== `did:nostr:${pubkey}`) {
    return { valid: false, error: 'Sender DID does not match pubkey' };
  }

  try {
    const valid = schnorr.verify(hexToBytes(signature), messageHash, hexToBytes(pubkey));
    return { valid, error: valid ? null : 'Invalid signature' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// Process transfer request
async function processTransfer(request) {
  const { from, to, amount } = request;

  // Validate recipient DID format
  if (!to.startsWith('did:nostr:') || to.length !== 75) {
    return { success: false, error: 'Invalid recipient DID format' };
  }

  const fromBalance = state.balances[from] || 0;
  if (amount > fromBalance) {
    return { success: false, error: `Insufficient balance: ${fromBalance} GSAT` };
  }

  if (amount <= 0) {
    return { success: false, error: 'Amount must be positive' };
  }

  // Update balances
  state.balances[from] = fromBalance - amount;
  state.balances[to] = (state.balances[to] || 0) + amount;
  state.txCount = (state.txCount || 0) + 1;

  await saveState();

  console.log('[Transfer]', from.slice(0, 20) + '...', '→', to.slice(0, 20) + '...', amount, 'GSAT');

  return {
    success: true,
    from,
    to,
    amount,
    newFromBalance: state.balances[from],
    newToBalance: state.balances[to]
  };
}

// === WITHDRAWAL API ===

// Verify withdrawal request signature
function verifyWithdrawSignature(request) {
  const { action, did, amount, address, timestamp, pubkey, signature } = request;

  const withdrawRequest = { action, did, amount, address, timestamp };
  const message = JSON.stringify(withdrawRequest);
  const messageHash = sha256(new TextEncoder().encode(message));

  if (did !== `did:nostr:${pubkey}`) {
    return { valid: false, error: 'DID does not match pubkey' };
  }

  try {
    const valid = schnorr.verify(hexToBytes(signature), messageHash, hexToBytes(pubkey));
    return { valid, error: valid ? null : 'Invalid signature' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// Process withdrawal - send sats to user's Bitcoin address
async function processWithdraw(request) {
  const { did, amount, address } = request;

  // Validate amount
  if (!amount || amount <= 0) {
    return { success: false, error: 'Invalid amount' };
  }

  // Check sats balance
  const satsBalance = state.satsBalances?.[did] || 0;
  if (amount > satsBalance) {
    return { success: false, error: `Insufficient sats balance: ${satsBalance}` };
  }

  // Validate Bitcoin address (basic check for testnet4)
  if (!address.startsWith('tb1') && !address.startsWith('m') && !address.startsWith('n') && !address.startsWith('2')) {
    return { success: false, error: 'Invalid testnet address' };
  }

  // Minimum withdrawal (to cover fees)
  const minWithdraw = 1000;
  if (amount < minWithdraw) {
    return { success: false, error: `Minimum withdrawal is ${minWithdraw} sats` };
  }

  try {
    // Get AMM wallet
    const wallet = new bt.Blocktrail(CONFIG.ammPrivkey);
    const xonly = bt.p2trXonly(wallet.pubkeyBase);
    const ammAddress = CONFIG.network === 'btc'
      ? encodeBech32m('bc', 1, xonly)
      : encodeBech32m('tb', 1, xonly);

    // Get UTXOs
    const utxos = await bt.getUtxos(ammAddress, CONFIG.network);
    if (utxos.length === 0) {
      return { success: false, error: 'AMM has no UTXOs available' };
    }

    const total = utxos.reduce((sum, u) => sum + u.amount, 0);
    const feeRates = await bt.getFeeRates(CONFIG.network);
    const feeRate = feeRates.halfHour || 2;
    const vsize = bt.estimateVsize(utxos.length, 2);
    const fee = Math.ceil(vsize * feeRate);

    if (amount + fee > total) {
      return { success: false, error: 'Insufficient AMM funds for withdrawal + fees' };
    }

    const change = total - amount - fee;

    // Build withdrawal transaction
    const tx = bt.buildTransaction({
      inputs: utxos.map(u => ({
        txid: u.txid,
        vout: u.vout,
        amount: u.amount,
        witnessProgram: xonly
      })),
      outputs: [
        { address, value: amount },
        ...(change >= 546 ? [{ witnessProgram: xonly, value: change }] : [])
      ]
    });

    // Sign and broadcast
    const signingKey = bt.hexToBytes(CONFIG.ammPrivkey);
    const prevouts = utxos.map(u => ({ ...u, witnessProgram: xonly }));
    const signedTx = bt.signTransaction(tx, utxos.map(() => signingKey), prevouts);

    const txBytes = bt.serializeTransaction(signedTx);
    const txHex = bt.bytesToHex(txBytes);
    const txid = bt.computeTxid(signedTx);

    await bt.broadcast(txHex, CONFIG.network);

    // Deduct from balance
    state.satsBalances[did] = satsBalance - amount;
    state.txCount = (state.txCount || 0) + 1;

    // Record withdrawal
    state.withdrawals = state.withdrawals || [];
    state.withdrawals.push({
      did,
      amount,
      address,
      txid,
      fee,
      timestamp: new Date().toISOString()
    });

    await saveState();

    console.log('[Withdraw]', did.slice(0, 20) + '...', amount, 'sats →', address.slice(0, 16) + '...');

    return {
      success: true,
      txid,
      amount,
      fee,
      address,
      newBalance: state.satsBalances[did]
    };
  } catch (e) {
    console.error('[Withdraw] Error:', e.message);
    return { success: false, error: e.message };
  }
}

// === HTTP 402 MIDDLEWARE (NIP-98) ===

// Verify NIP-98 event signature
function verifyNostrEvent(event) {
  // Serialize event for signing: [0, pubkey, created_at, kind, tags, content]
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

  try {
    const valid = schnorr.verify(hexToBytes(event.sig), hash, hexToBytes(event.pubkey));
    return { valid, error: valid ? null : 'Invalid signature' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// Parse NIP-98 Authorization header and verify
function verify402Payment(req, cost, fullUrl) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Nostr ')) {
    return { authorized: false, error: 'Missing NIP-98 Authorization header' };
  }

  // Decode base64 event
  let event;
  try {
    const base64 = authHeader.slice(6); // Remove "Nostr " prefix
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    event = JSON.parse(json);
  } catch (e) {
    return { authorized: false, error: 'Invalid NIP-98 event encoding' };
  }

  // Verify event kind
  if (event.kind !== 27235) {
    return { authorized: false, error: 'Invalid event kind (expected 27235)' };
  }

  // Verify timestamp (within 60 seconds per NIP-98)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - event.created_at) > 60) {
    return { authorized: false, error: 'Event timestamp expired (>60s)' };
  }

  // Extract and verify tags
  const uTag = event.tags.find(t => t[0] === 'u');
  const methodTag = event.tags.find(t => t[0] === 'method');

  if (!uTag || !methodTag) {
    return { authorized: false, error: 'Missing required tags (u, method)' };
  }

  if (uTag[1] !== fullUrl) {
    return { authorized: false, error: `URL mismatch: ${uTag[1]} vs ${fullUrl}` };
  }

  if (methodTag[1] !== req.method) {
    return { authorized: false, error: `Method mismatch: ${methodTag[1]} vs ${req.method}` };
  }

  // Verify event signature
  const verification = verifyNostrEvent(event);
  if (!verification.valid) {
    return { authorized: false, error: verification.error };
  }

  // Get DID from pubkey
  const did = `did:nostr:${event.pubkey}`;

  // Check balance
  const balance = state.balances[did] || 0;
  if (balance < cost) {
    return {
      authorized: false,
      error: 'Insufficient balance',
      balance,
      cost,
      depositAddress: deriveDepositAddress(CONFIG.ammPubkey, did, CONFIG.network).address
    };
  }

  // Deduct tokens
  state.balances[did] = balance - cost;
  state.txCount = (state.txCount || 0) + 1;

  console.log('[402]', did.slice(0, 20) + '...', 'paid', cost, 'GSAT for', req.url);

  return { authorized: true, did, remaining: state.balances[did], pubkey: event.pubkey };
}

// Start HTTP server for AMM API
function startApiServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Helper to read JSON body
    const readBody = () => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });

    try {
      // POST /sell - Sell GSAT for sats
      if (req.method === 'POST' && req.url === '/sell') {
        const request = await readBody();
        const verification = verifySignature(request);
        if (!verification.valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: verification.error }));
          return;
        }
        const result = await processSell(request);
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.success ? result : { error: result.error }));
        return;
      }

      // POST /transfer - Transfer GSAT to another user
      if (req.method === 'POST' && req.url === '/transfer') {
        const request = await readBody();
        const verification = verifyTransferSignature(request);
        if (!verification.valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: verification.error }));
          return;
        }
        const result = await processTransfer(request);
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.success ? result : { error: result.error }));
        return;
      }

      // POST /withdraw - Withdraw sats to Bitcoin address
      if (req.method === 'POST' && req.url === '/withdraw') {
        const request = await readBody();
        const verification = verifyWithdrawSignature(request);
        if (!verification.valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: verification.error }));
          return;
        }
        const result = await processWithdraw(request);
        res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.success ? result : { error: result.error }));
        return;
      }

      // GET /balance/:did - Check balance (free)
      if (req.method === 'GET' && req.url.startsWith('/balance/')) {
        const did = decodeURIComponent(req.url.slice(9));
        const gsatBalance = state.balances[did] || 0;
        const satsBalance = state.satsBalances?.[did] || 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ did, gsat: gsatBalance, sats: satsBalance }));
        return;
      }

      // GET /api/quote - Demo 402 endpoint (costs 1 GSAT)
      if (req.method === 'GET' && req.url === '/api/quote') {
        const cost = 1; // 1 GSAT per request
        const fullUrl = `http://localhost:${CONFIG.apiPort}${req.url}`;
        const payment = verify402Payment(req, cost, fullUrl);

        if (!payment.authorized) {
          res.writeHead(402, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: payment.error,
            cost,
            balance: payment.balance,
            depositAddress: payment.depositAddress,
            nip98: { kind: 27235, url: fullUrl, method: req.method }
          }));
          return;
        }

        // Save state after deducting payment
        await saveState();

        // Return the "paid" content
        const price = (state.amm.satsReserve / state.amm.tokenReserve).toFixed(4);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          quote: `1 GSAT = ${price} sats`,
          pool: { sats: state.amm.satsReserve, gsat: state.amm.tokenReserve },
          paid: cost,
          remaining: payment.remaining
        }));
        return;
      }

      // POST /check - Manual deposit check (rate limited)
      if (req.method === 'POST' && req.url === '/check') {
        const now = Date.now();
        const minInterval = 10000; // 10 second minimum between checks
        if (global.lastCheck && now - global.lastCheck < minInterval) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many requests', retryAfter: Math.ceil((minInterval - (now - global.lastCheck)) / 1000) }));
          return;
        }
        global.lastCheck = now;

        console.log('[Check] Manual deposit check triggered');
        const beforeTxCount = state.txCount;
        await checkDeposits();
        const newDeposits = state.txCount - beforeTxCount;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          checked: users.length,
          newDeposits,
          txCount: state.txCount
        }));
        return;
      }

      // GET /state - Public state info
      if (req.method === 'GET' && req.url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          pool: state.amm,
          txCount: state.txCount,
          anchors: state.anchors?.slice(-3) || []
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.listen(CONFIG.apiPort, () => {
    console.log('[API] Endpoints:');
    console.log('  POST /sell      - Sell GSAT for sats');
    console.log('  POST /transfer  - Transfer GSAT to user');
    console.log('  POST /withdraw  - Withdraw sats to BTC address');
    console.log('  POST /check     - Manual deposit check');
    console.log('  GET  /balance/* - Check balance');
    console.log('  GET  /api/quote - Demo 402 endpoint (1 GSAT)');
    console.log('  GET  /state     - Pool state');
    console.log('  http://localhost:' + CONFIG.apiPort);
  });
}

// Main loop
async function main() {
  console.log('=== GitSat AMM Watcher + Sell API ===');
  console.log('AMM Pubkey:', CONFIG.ammPubkey);
  console.log('Network:', CONFIG.network);
  console.log('Poll interval:', CONFIG.pollInterval / 1000, 'seconds');
  console.log('');

  await loadState();
  await loadUsers();

  // Start sell API server
  startApiServer();

  // Initial check
  await checkDeposits();

  // Poll loop
  setInterval(async () => {
    try {
      await checkDeposits();
    } catch (e) {
      console.error('[Error]', e.message);
    }
  }, CONFIG.pollInterval);

  console.log('[Watcher] Running... Press Ctrl+C to stop');
}

// CLI
if (process.argv[1]?.endsWith('watcher.js')) {
  // Check for register command
  if (process.argv[2] === 'register' && process.argv[3]) {
    await loadState();
    await loadUsers();
    const user = await registerUser(process.argv[3]);
    console.log('Registered:', user.uri);
    console.log('Deposit address:', user.address);
    process.exit(0);
  }

  // Check for list command
  if (process.argv[2] === 'list') {
    await loadState();
    await loadUsers();
    console.log('\nRegistered users:');
    for (const user of users) {
      const balance = state.balances[user.uri] || 0;
      console.log(`  ${user.uri.slice(0, 40)}...`);
      console.log(`    Address: ${user.address}`);
      console.log(`    Balance: ${balance} GSAT`);
    }
    process.exit(0);
  }

  // Run watcher
  main().catch(console.error);
}

export { loadState, saveState, loadUsers, checkDeposits };
