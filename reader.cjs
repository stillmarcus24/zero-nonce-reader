#!/usr/bin/env node
'use strict';
/**
 * zero-nonce-reader — settle "has this address ever been paid?" from state alone.
 *
 * The argument, in one line: ERC-20 value can only leave an externally-owned
 * account in a transaction sent BY that account, and every such transaction
 * increments its nonce. So at nonce 0 the balance is monotonically
 * non-decreasing, and balanceOf at head is therefore the MAXIMUM the address
 * has ever held. A zero balance at nonce 0 is a zero balance at every block in
 * history — established by four JSON-RPC calls, with no indexer, no API key, no log
 * range, and nothing that can be silently truncated.
 *
 * This matters because the usual instrument — paginated transfer logs from an
 * indexer — fails open. A wrong field name, a capped page, or a pruned log
 * horizon all return "no transfers found", which reads identically to "never
 * paid". This reader cannot fail that way: a read either succeeds or throws.
 *
 * Verdicts:
 *   PAID           balance > 0 at head. It holds the asset now.
 *   ZERO_OBSERVED  balance == 0 AND nonce == 0. Zero for all of history.
 *   UNKNOWN        balance == 0 AND nonce > 0. The address has sent
 *                  transactions, so the monotonic argument does not apply and
 *                  this reader cannot settle it. Says so instead of guessing.
 *
 * Residuals, named rather than implied shut:
 *   - EIP-3009 (transferWithAuthorization) lets a relayer move funds on a
 *     signed authorization WITHOUT the holder's nonce moving. A ZERO_OBSERVED
 *     is therefore "no value ever rested here", not "no value ever accrued".
 *   - An atomic receive-and-forward inside one transaction is invisible to any
 *     state read, this one included.
 *   - A contract account's nonce counts contract creations, not sends. Do not
 *     apply the nonce argument to contracts; this reader flags them.
 *
 * MIT. Zero dependencies. Node 18+.
 *
 *   node reader.cjs 0xADDRESS [0xADDRESS...]
 *   node reader.cjs --rpc https://mainnet.base.org --asset 0x8335... 0xADDR
 */

const DEFAULTS = {
  // Base mainnet, USDC. Override with --rpc / --asset for any EVM chain+token.
  rpc: process.env.RPC_URL || 'https://mainnet.base.org',
  asset: process.env.ASSET || '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  decimals: 6,
};

const BALANCE_OF = '0x70a08231';   // balanceOf(address)
const PAID = 'PAID', ZERO_OBSERVED = 'ZERO_OBSERVED', UNKNOWN = 'UNKNOWN';

let rpcCalls = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpc(url, method, params, attempt = 0) {
  rpcCalls++;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcCalls, method, params }),
    });
  } catch (e) {
    // Network-level failure. Retry, then surface it -- never swallow.
    if (attempt < 4) { await sleep(400 * 2 ** attempt); return rpc(url, method, params, attempt + 1); }
    throw new Error(`${method}: ${e.message}`);
  }
  // A throttled read is NOT a zero. Back off and retry rather than let a 429
  // become an empty result somewhere downstream.
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(500 * 2 ** attempt);
    return rpc(url, method, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} after ${attempt + 1} attempt(s)`);
  const j = await res.json();
  // Fail LOUD. An error that becomes a falsy value is how a false zero is born.
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  if (j.result === undefined || j.result === null) throw new Error(`${method}: empty result`);
  return j.result;
}

function pad32(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function fmt(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Ask the endpoint which chain it actually is, rather than trusting the URL.
 * A rail is a claim until something answers eth_chainId.
 */
async function chainIdOf(url) {
  return Number(BigInt(await rpc(url, 'eth_chainId', [])));
}

/** Read one address at a pinned block height. */
async function readAddress(address, opts = {}) {
  const { rpc: url = DEFAULTS.rpc, asset = DEFAULTS.asset,
          decimals = DEFAULTS.decimals, block = 'latest',
          claimedRail = null, chainId = null } = opts;

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`not an address: ${address}`);
  }

  // Rail coverage. Every EVM chain shares one address format, so a cross-chain
  // read SUCCEEDS and looks like a reading: query a door's Polygon payTo
  // against Base's USDC contract and you get a well-formed PAID about a rail
  // nobody checked. No format validator catches a well-formed wrong value.
  // A rail is read ONLY by a run that covers it.
  const observedChain = chainId !== null ? chainId : await chainIdOf(url);
  if (claimedRail !== null) {
    const want = typeof claimedRail === 'string'
      ? Number(claimedRail.replace(/^eip155:/, ''))
      : claimedRail;
    if (!Number.isFinite(want)) {
      return { address, verdict: UNKNOWN, claimed_rail: claimedRail,
        observed_chain_id: observedChain, rail_covered: false,
        because: `claimed rail "${claimedRail}" is not an eip155 chain this run can cover`,
        instrument_failure: false };
    }
    if (want !== observedChain) {
      return { address, verdict: UNKNOWN, claimed_rail: claimedRail,
        observed_chain_id: observedChain, rail_covered: false,
        because: `door claims eip155:${want}; this run covers eip155:${observedChain}. ` +
                 'Reading it here would relabel one rail as another, so it is not read.',
        instrument_failure: false };
    }
  }

  const [balHex, nonceHex, code] = await Promise.all([
    rpc(url, 'eth_call', [{ to: asset, data: BALANCE_OF + pad32(address) }, block]),
    rpc(url, 'eth_getTransactionCount', [address, block]),
    rpc(url, 'eth_getCode', [address, block]),
  ]);

  const balance = BigInt(balHex);
  const nonce = Number(BigInt(nonceHex));
  const isContract = code !== '0x';

  let verdict, because;
  if (balance > 0n) {
    verdict = PAID;
    because = 'holds a non-zero balance of the in-scope asset at this height';
  } else if (isContract) {
    verdict = UNKNOWN;
    because = 'contract account: its nonce counts contract creations, not sends, ' +
              'so the monotonic argument does not apply';
  } else if (nonce === 0) {
    verdict = ZERO_OBSERVED;
    because = 'balance is zero and the account has never sent a transaction, so ' +
              'the balance is monotonically non-decreasing and zero at head is ' +
              'zero at every block in history';
  } else {
    verdict = UNKNOWN;
    because = `balance is zero but the account has sent ${nonce} transaction(s), ` +
              'so value may have been received and moved out; this instrument ' +
              'cannot settle it and does not guess';
  }

  return {
    address, verdict, because,
    balance_raw: balance.toString(),
    balance: fmt(balance, decimals),
    nonce, is_contract: isContract,
    block, asset,
    // rail is the chain the endpoint ANSWERED as, not the URL we were handed.
    rail: `eip155:${observedChain}`,
    observed_chain_id: observedChain,
    claimed_rail: claimedRail,
    rail_covered: claimedRail === null ? null : true,
    endpoint: url,
    rpc_calls: 4,
    residuals: verdict === ZERO_OBSERVED
      ? ['EIP-3009 relayed transfer does not move the holder nonce',
         'atomic receive-and-forward in one transaction is invisible to state reads']
      : [],
  };
}

/**
 * Discrimination control. A reader that reports zero for everything is
 * indistinguishable from a broken one, so before trusting ANY zero we prove the
 * instrument can see a non-zero on a known-funded address. If this fails, every
 * zero in the run is void.
 */
async function control(opts = {}) {
  // Base USDC on Coinbase's own well-known funded address. Any address with a
  // durable non-zero balance works; swap it if this one ever empties.
  const KNOWN_FUNDED = opts.knownFunded ||
    process.env.KNOWN_FUNDED || '0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A';
  const r = await readAddress(KNOWN_FUNDED, opts);
  return {
    ok: r.balance_raw !== '0',
    address: KNOWN_FUNDED,
    observed: r.balance,
    note: r.balance_raw !== '0'
      ? 'instrument can see a non-zero balance; zeros in this run are meaningful'
      : 'CONTROL FAILED: the instrument reported zero for a known-funded address. ' +
        'Every zero in this run is void. Check the asset address and the RPC.',
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { ...DEFAULTS };
  const addrs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rpc') opts.rpc = argv[++i];
    else if (argv[i] === '--asset') opts.asset = argv[++i];
    else if (argv[i] === '--decimals') opts.decimals = Number(argv[++i]);
    else if (argv[i] === '--block') opts.block = argv[++i];
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--no-control') opts.skipControl = true;
    else addrs.push(argv[i]);
  }

  if (!addrs.length) {
    console.error('usage: node reader.cjs [--rpc URL] [--asset 0x..] [--block N] [--json] 0xADDR...');
    process.exit(2);
  }

  // Pin the height once so every address in the run is read at the same block.
  if (!opts.block || opts.block === 'latest') {
    opts.block = await rpc(opts.rpc, 'eth_blockNumber', []);
  }

  let ctrl = null;
  if (!opts.skipControl) {
    ctrl = await control(opts);
    if (!ctrl.ok) {
      console.error('CONTROL FAILED — ' + ctrl.note);
      process.exit(1);
    }
  }

  const rows = [];
  for (const a of addrs) {
    try {
      rows.push(await readAddress(a, opts));
    } catch (e) {
      // An instrument failure is never a statement about the address.
      rows.push({ address: a, verdict: UNKNOWN, because: 'READ_FAILED: ' + e.message,
                  instrument_failure: true });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      instrument: 'zero-nonce-reader v1',
      block: opts.block, asset: opts.asset, rail: opts.rpc,
      control: ctrl, results: rows,
    }, null, 2));
  } else {
    console.log(`block ${opts.block}  asset ${opts.asset}`);
    if (ctrl) console.log(`control: ${ctrl.address} = ${ctrl.observed} (non-zero, instrument live)\n`);
    for (const r of rows) {
      console.log(`${r.verdict.padEnd(14)} ${r.address}  bal=${r.balance ?? '-'}  nonce=${r.nonce ?? '-'}`);
      console.log(`               ${r.because}`);
    }
  }
}

module.exports = { readAddress, control, PAID, ZERO_OBSERVED, UNKNOWN };

if (require.main === module) {
  main().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
}
