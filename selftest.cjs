#!/usr/bin/env node
'use strict';
/**
 * Known-answer tests for zero-nonce-reader.
 *
 * Two kinds of case, and the second kind is the point:
 *
 *  - LIVE cases read real addresses on Base and assert a verdict that must
 *    hold for a structural reason, not a transient one.
 *  - DISCRIMINATION cases deliberately break the instrument and require the
 *    suite to FAIL. A suite that cannot fail proves nothing: if pointing the
 *    reader at a non-existent token still yields "ZERO_OBSERVED" for every
 *    address, the reader is a zero generator, not a measurement.
 *
 *   node selftest.cjs
 */
const { readAddress, control, PAID, ZERO_OBSERVED, UNKNOWN } = require('./reader.cjs');

const BASE = 'https://mainnet.base.org';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NOT_A_TOKEN = '0x00000000000000000000000000000000deadbeef';

let pass = 0, fail = 0;
function check(id, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
  ok ? pass++ : fail++;
}

async function main() {
  // ---- KA-01: the control must see a non-zero, or nothing below is meaningful
  const c = await control({ rpc: BASE, asset: USDC });
  check('KA-01', c.ok, `control sees ${c.observed} on a known-funded address`);
  if (!c.ok) { console.error('control failed; aborting'); process.exit(1); }

  // ---- KA-02: a freshly-derived address nobody has ever touched
  // Deterministic, unfunded, nonce 0. Must be ZERO_OBSERVED, not UNKNOWN.
  const virgin = '0x' + 'a1b2c3d4'.repeat(5);
  const v = await readAddress(virgin, { rpc: BASE, asset: USDC });
  check('KA-02', v.verdict === ZERO_OBSERVED && v.nonce === 0,
    `untouched address -> ${v.verdict} (nonce ${v.nonce})`);

  // ---- KA-03: a high-nonce funded address is PAID, and balance beats nonce
  const funded = c.address;
  const f = await readAddress(funded, { rpc: BASE, asset: USDC });
  check('KA-03', f.verdict === PAID, `funded address -> ${f.verdict}`);

  // ---- KA-04: a CONTRACT must never be settled by the nonce argument.
  // USDC itself is a contract. Its nonce means contract-creations, not sends.
  const ct = await readAddress(USDC, { rpc: BASE, asset: USDC });
  check('KA-04', ct.is_contract === true && ct.verdict !== ZERO_OBSERVED,
    `contract -> is_contract=${ct.is_contract}, verdict=${ct.verdict}`);

  // ---- KA-05 DISCRIMINATION: point at an address that is not a token.
  // eth_call to a non-contract returns "0x" -> BigInt('0x') throws. The reader
  // must raise, NOT quietly report zero. If this "passes" cleanly with a
  // ZERO_OBSERVED, every zero this tool has ever printed is void.
  let threw = false, got = null;
  try {
    got = await readAddress(virgin, { rpc: BASE, asset: NOT_A_TOKEN });
  } catch (e) { threw = true; }
  check('KA-05', threw || got.verdict !== ZERO_OBSERVED,
    threw ? 'bogus asset raised instead of reporting a zero'
          : `bogus asset returned ${got.verdict} (must not be ZERO_OBSERVED)`);

  // ---- KA-06 DISCRIMINATION: a dead RPC must raise, never resolve to zero.
  let rpcThrew = false;
  try {
    await readAddress(virgin, { rpc: 'https://127.0.0.1:9/nope', asset: USDC });
  } catch (e) { rpcThrew = true; }
  check('KA-06', rpcThrew, 'unreachable RPC raises rather than returning a zero');

  // ---- KA-07: reading at a pinned historical block is supported and stable
  const h = await readAddress(funded, { rpc: BASE, asset: USDC, block: '0x3000000' });
  const h2 = await readAddress(funded, { rpc: BASE, asset: USDC, block: '0x3000000' });
  check('KA-07', h.balance_raw === h2.balance_raw,
    `same height read twice is identical (${h.balance})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
