/**
 * GitSat AMM - Sell API
 *
 * Handles signed sell requests from the UI.
 * Verifies nostr signatures and updates state.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';

const CONFIG = {
  port: 3456,
  stateFile: path.join(process.cwd(), 'state.json'),
  syncToSolid: process.env.SOLID_SYNC === 'true'
};

// Load state
async function loadState() {
  const data = await fs.readFile(CONFIG.stateFile, 'utf-8');
  return JSON.parse(data);
}

// Save state
async function saveState(state) {
  await fs.writeFile(CONFIG.stateFile, JSON.stringify(state, null, 2));

  if (CONFIG.syncToSolid) {
    try {
      const { execSync } = await import('child_process');
      execSync(`scp ${CONFIG.stateFile} solid.social:/home/ubuntu/solid-server/data/mel/public/gitmark-amm/state.json`, {
        stdio: 'inherit'
      });
      console.log('[State] Synced to solid.social');
    } catch (e) {
      console.error('[State] Sync failed:', e.message);
    }
  }
}

// Verify sell request signature
function verifySignature(request) {
  const { action, did, gsatAmount, expectedSats, timestamp, pubkey, signature } = request;

  // Reconstruct the message that was signed
  const sellRequest = { action, did, gsatAmount, expectedSats, timestamp };
  const message = JSON.stringify(sellRequest);
  const messageHash = sha256(new TextEncoder().encode(message));

  // Verify the did matches the pubkey
  if (did !== `did:nostr:${pubkey}`) {
    return { valid: false, error: 'DID does not match pubkey' };
  }

  // Verify signature
  try {
    const valid = schnorr.verify(hexToBytes(signature), messageHash, hexToBytes(pubkey));
    return { valid, error: valid ? null : 'Invalid signature' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// Calculate sats output for GSAT input (constant product AMM)
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const fee = BigInt(amountIn) * 997n; // 0.3% fee
  return Number((fee * BigInt(reserveOut)) / (BigInt(reserveIn) * 1000n + fee));
}

// Process sell request
async function processSell(request) {
  const state = await loadState();
  const { did, gsatAmount, expectedSats } = request;

  // Check balance
  const balance = state.balances[did] || 0;
  if (gsatAmount > balance) {
    return { success: false, error: `Insufficient balance: ${balance} GSAT` };
  }

  // Calculate actual output
  const actualSats = getAmountOut(gsatAmount, state.amm.tokenReserve, state.amm.satsReserve);

  // Allow 1% slippage
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

  await saveState(state);

  console.log('[Sell] Processed:', {
    did: did.slice(0, 30) + '...',
    gsatIn: gsatAmount,
    satsOut: actualSats
  });

  return {
    success: true,
    gsatSold: gsatAmount,
    satsReceived: actualSats,
    newGsatBalance: state.balances[did],
    newSatsBalance: state.satsBalances[did]
  };
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // CORS headers
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

        // Verify signature
        const verification = verifySignature(request);
        if (!verification.valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: verification.error }));
          return;
        }

        // Process sell
        const result = await processSell(request);

        if (result.success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error }));
        }
      } catch (e) {
        console.error('[Error]', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(CONFIG.port, () => {
  console.log(`[Sell API] Running on http://localhost:${CONFIG.port}`);
  console.log('[Sell API] SOLID_SYNC:', CONFIG.syncToSolid);
});
