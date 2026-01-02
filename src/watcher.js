/**
 * GitSat AMM - Deposit Watcher
 *
 * Monitors deposit addresses for incoming sats and credits user balances.
 */

import { deriveDepositAddress, deriveDepositPrivkey } from './deposit.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import fs from 'fs/promises';
import path from 'path';

// Configuration
const CONFIG = {
  stateFile: path.join(process.cwd(), 'state.json'),
  usersFile: path.join(process.cwd(), 'users.json'),
  ammPubkey: '034e138880a395b71336ee922313f3b86abd0fc29ddc7a58c5efba9d82132f53ef',
  ammPrivkey: process.env.AMM_PRIVKEY || '',
  network: 'tbtc4',
  pollInterval: 30000, // 30 seconds
  minConfirmations: 0,
  mempoolApi: 'https://mempool.space/testnet4/api'
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

// Main loop
async function main() {
  console.log('=== GitSat AMM Deposit Watcher ===');
  console.log('AMM Pubkey:', CONFIG.ammPubkey);
  console.log('Network:', CONFIG.network);
  console.log('Poll interval:', CONFIG.pollInterval / 1000, 'seconds');
  console.log('');

  await loadState();
  await loadUsers();

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
