import * as bt from '/home/melvin/remote/github.com/blocktrails/blocktrails/src/index.js';
import { deriveDepositAddress } from './src/deposit.js';

const FAUCET_KEY = 'f502f06c1d7553f4b7159e8d57a1e14819dc3053b59399e080882cc8e6bb62ad';
const AMM_PUBKEY = '034e138880a395b71336ee922313f3b86abd0fc29ddc7a58c5efba9d82132f53ef';
const USER_DID = 'did:nostr:4ccef8c68cf18f8f156a0bb017dfd6e0cc7ebf1672fa2d769e02e2efc700328b';
const AMOUNT = 10000; // 10k sats test deposit

async function main() {
  const faucet = new bt.Blocktrail(FAUCET_KEY);
  const faucetXonly = bt.p2trXonly(faucet.pubkeyBase);
  const faucetAddress = 'tb1p0xr32dmn2uqrdqae0x6pchvecqcjumnc34uf7r2a7ugyv4yr4glq9rtjhr';

  // Derive deposit address using the same function as watcher
  const depositResult = deriveDepositAddress(AMM_PUBKEY, USER_DID, 'tbtc4');
  const depositXonly = bt.hexToBytes(depositResult.xonly);

  console.log('Faucet:', faucetAddress);
  console.log('Deposit to:', depositResult.address);
  console.log('Deposit x-only:', depositResult.xonly);
  console.log('Amount:', AMOUNT, 'sats');

  // Get UTXOs
  const utxos = await bt.getUtxos(faucetAddress, 'tbtc4');
  if (utxos.length === 0) {
    console.log('No UTXOs');
    return;
  }

  const total = utxos.reduce((sum, u) => sum + u.amount, 0);
  console.log('Available:', total, 'sats');

  const feeRates = await bt.getFeeRates('tbtc4');
  const feeRate = feeRates.halfHour || 2;
  const vsize = bt.estimateVsize(utxos.length, 2);
  const fee = Math.ceil(vsize * feeRate);
  const change = total - AMOUNT - fee;

  if (change < 546) {
    console.log('Not enough funds');
    return;
  }

  console.log('Fee:', fee, 'sats');
  console.log('Change:', change, 'sats');

  // Build tx
  const tx = bt.buildTransaction({
    inputs: utxos.map(u => ({
      txid: u.txid,
      vout: u.vout,
      amount: u.amount,
      witnessProgram: faucetXonly
    })),
    outputs: [
      { witnessProgram: depositXonly, value: AMOUNT },
      { witnessProgram: faucetXonly, value: change }
    ]
  });

  // Sign
  const signingKey = bt.hexToBytes(FAUCET_KEY);
  const prevouts = utxos.map(u => ({ ...u, witnessProgram: faucetXonly }));
  const signedTx = bt.signTransaction(tx, utxos.map(() => signingKey), prevouts);

  // Broadcast
  const txBytes = bt.serializeTransaction(signedTx);
  const txHex = bt.bytesToHex(txBytes);
  const txid = bt.computeTxid(signedTx);

  console.log('Txid:', txid);
  console.log('Broadcasting...');

  const result = await bt.broadcast(txHex, 'tbtc4');
  console.log('Result:', result);
}

main().catch(console.error);
