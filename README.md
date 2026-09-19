# zero-nonce-reader

Settle **"has this address ever been paid?"** from chain state alone — no indexer, no API key, no log range, nothing that can be silently truncated.

Two `eth_call`s and a `getCode`. MIT, zero dependencies, Node 18+.

```bash
node reader.cjs 0x480cd46e6fade651a0437deadda53d5c8e7d846a
node reader.cjs --json --block 0x31227d1 0xADDR 0xADDR
node selftest.cjs
```

## The argument

ERC-20 value can only leave an externally-owned account in a transaction sent **by** that account, and every such transaction increments its nonce.

So at **nonce 0**, the balance is monotonically non-decreasing — and `balanceOf` at head is therefore the **maximum the address has ever held**. A zero balance at nonce 0 is a zero balance at *every block in history*, established from state, with no index in the path.

## Why this exists

The usual instrument for "never paid" is paginated transfer logs from an indexer. That instrument **fails open**: a wrong field name, a capped page, or a pruned log horizon all return *"no transfers found"* — which reads identically to *"never paid"*.

This is not hypothetical. Three real instances from our own work:

- A Blockscout v2 response names the token field `address_hash`, not `address`. Reading `address` returns `null` on every row, the token filter matches nothing, and **every address reports zero inbound**. It produced a confident *"27 of 27 x402 sellers have never been paid."* True reading: 8 of 13 had multi-payer revenue.
- A page cap of 12 × 50 rows silently became a **count**: one address was published at 185 payers. Walking all 118 pages gives **2,360**.
- A public RPC pruning logs at roughly 1.3 days returns an **empty array**, not an error, for any range older than the horizon.

Every one of those is the same defect: an absence of evidence rendered as evidence of absence. A state read cannot fail that way — it either returns a value or it raises.

## Verdicts

| verdict | condition | meaning |
|---|---|---|
| `PAID` | balance > 0 | holds the asset at this height |
| `ZERO_OBSERVED` | balance == 0 **and** nonce == 0 | zero for all of history |
| `UNKNOWN` | balance == 0 **and** nonce > 0 | has sent transactions; the monotonic argument does not apply and this reader does not guess |
| `UNKNOWN` | account is a contract | a contract's nonce counts creations, not sends |

An instrument failure returns `UNKNOWN` with `instrument_failure: true`. **Our failure and their absence never share a verdict** — that distinction is the whole point.

## Residuals, named rather than implied shut

`ZERO_OBSERVED` means *"no value ever rested here"*, not *"no value ever accrued"*:

1. **EIP-3009** (`transferWithAuthorization`) lets a relayer move funds on a signed authorization **without the holder's nonce moving**.
2. An **atomic receive-and-forward** inside a single transaction is invisible to any state read, this one included.
3. Contract accounts are excluded, not settled.

If you need those closed, you need logs — and then you inherit every failure mode above, so canary your horizon and never treat an empty page as a zero.

## The control

`control()` reads a **known-funded** address before any run and refuses to proceed if it reports zero.

A reader that reports zero for everything is indistinguishable from a broken one. Proving the instrument can see a non-zero is what makes the zeros mean anything. `selftest.cjs` carries two **discrimination cases** that require the suite to *fail* — a bogus asset address and an unreachable RPC must both raise rather than resolve to `ZERO_OBSERVED`. A corpus that cannot fail proves nothing.

```
PASS  KA-01  control sees 5356912.154645 on a known-funded address
PASS  KA-02  untouched address -> ZERO_OBSERVED (nonce 0)
PASS  KA-03  funded address -> PAID
PASS  KA-04  contract -> is_contract=true, verdict=UNKNOWN
PASS  KA-05  bogus asset raised instead of reporting a zero
PASS  KA-06  unreachable RPC raises rather than returning a zero
PASS  KA-07  same height read twice is identical
```

## Any EVM chain, any ERC-20

Defaults are Base mainnet + USDC. Override:

```bash
node reader.cjs --rpc https://arb1.arbitrum.io/rpc \
                --asset 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
                --decimals 6 0xADDR
```

Pin `--block` so every address in a run is read at the same height.

## Provenance

The argument was first published in
[x402-foundation/tsc#4](https://github.com/x402-foundation/tsc/issues/4) and
[seancrecord/scvd-general-store-repo#622](https://github.com/seancrecord/scvd-general-store-repo/issues/622),
where it was used to settle eight all-time zeroes across 43 addresses that no log-based reader could reach. This repository is the instrument, so the argument can be **run** rather than merely cited.

MIT — StillOS
