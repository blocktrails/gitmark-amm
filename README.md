# GitSat AMM

A git-native Automated Market Maker (AMM) for swapping testnet4 sats ↔ GSAT tokens.

**[Try the Demo](https://blocktrails.github.io/gitmark-amm/demo.html)**

## How It Works

1. **Token**: 21 million GSAT tokens (like Bitcoin's supply)
2. **AMM**: Constant product formula (x × y = k) like Uniswap
3. **Identity**: `did:nostr:` keys (your Nostr pubkey)
4. **State**: Stored in git, anchored to Bitcoin testnet4
5. **Validation**: Client-side validation of state transitions

## Architecture

```
state.json          - Current balances and AMM reserves
├── token           - Token metadata (name, symbol, supply)
├── balances        - Map of did:nostr:pubkey → balance
└── amm             - Pool reserves and k constant
```

## AMM Formula

```
x × y = k

Where:
- x = sats reserve
- y = token reserve
- k = constant product

Output = (input × 997 × reserveOut) / (reserveIn × 1000 + input × 997)
(0.3% fee)
```

## Operations

| Action | Description |
|--------|-------------|
| `buy(sats)` | Swap sats for GSAT tokens |
| `sell(tokens)` | Swap GSAT for sats |
| `transfer(to, amount)` | Send tokens to another did |

## Trust Model

| Layer | Provides |
|-------|----------|
| Bitcoin UTXO | Ordering, single-spend protection |
| Git repo | State storage, history, data availability |
| Nostr | Identity (did:nostr:), discovery |
| AMM math | Deterministic pricing |

## Initial State

- **Total Supply**: 21,000,000 GSAT
- **AMM Pool**: 20,000,000 GSAT + 1,000,000 sats
- **Initial Price**: 0.05 sats/GSAT

## License

MIT
