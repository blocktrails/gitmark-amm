/**
 * GitSat AMM - Deposit Watcher
 *
 * Monitors deposit addresses for incoming sats and credits user balances.
 */

import { deriveDepositAddress, deriveDepositPrivkey } from './deposit.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import * as bt from '/home/melvin/remote/github.com/blocktrails/blocktrails/src/index.js';
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
  pollInterval: 30000, // 30 seconds
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
    const address = bt.pubkeyToAddress(wallet.pubkeyBase, CONFIG.network);

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

    // Build tx with OP_RETURN containing state hash
    const xonly = bt.p2trXonly(wallet.pubkeyBase);
    const opReturnData = new TextEncoder().encode('GSAT:' + stateHash.slice(0, 40));

    const tx = bt.buildTransaction({
      inputs: utxos.map(u => ({
        txid: u.txid,
        vout: u.vout,
        amount: u.amount,
        witnessProgram: xonly
      })),
      outputs: [
        { witnessProgram: xonly, value: change },
        { opReturn: opReturnData }
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

// Start HTTP server for sell API
function startApiServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/sell') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const request = JSON.parse(body);

          const verification = verifySignature(request);
          if (!verification.valid) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: verification.error }));
            return;
          }

          const result = await processSell(request);

          res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.success ? result : { error: result.error }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(CONFIG.apiPort, () => {
    console.log('[API] Sell endpoint: http://localhost:' + CONFIG.apiPort + '/sell');
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
