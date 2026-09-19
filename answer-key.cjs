#!/usr/bin/env node
'use strict';
/**
 * Answer a blind key with zero-nonce-reader, applying the agreed rules:
 *
 *   - Pinned height per rail from the key's observation_boundary.
 *   - A rail is read ONLY by a run that covers it (eth_chainId verified).
 *     Everything else is named and returned UNKNOWN, never silently skipped.
 *   - Door aggregation: PAID is monotone (one observed settlement stands even
 *     if other rails were unreachable). ZERO_OBSERVED requires EVERY advertised
 *     rail to resolve empty. Any rail out of reach otherwise makes the door
 *     UNKNOWN.
 *
 *   node answer-key.cjs <key.json> [--rpc URL]
 */
const { readAddress, PAID, ZERO_OBSERVED, UNKNOWN } = require('./reader.cjs');
const fs = require('fs');

const BASE = process.env.RPC_URL || 'https://mainnet.base.org';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const COVERED = { 8453: { rpc: BASE, asset: USDC_BASE, decimals: 6 } };

async function main() {
  const key = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const pinned = key.observation_boundary?.['eip155:8453']?.base_block;
  const blockHex = '0x' + Number(pinned).toString(16);

  const out = { answered_by: 'stillos', instrument: 'zero-nonce-reader v1.1',
                key: key.posed_by + ' ' + key.round, pinned_block: pinned,
                covered_rails: ['eip155:8453'], doors: [] };

  for (const door of key.doors) {
    const rails = [];
    for (const r of door.rails) {
      const m = /^eip155:(\d+)$/.exec(r.rail);
      const cid = m ? Number(m[1]) : null;
      if (!cid || !COVERED[cid]) {
        rails.push({ rail: r.rail, payTo: r.payTo, verdict: UNKNOWN,
          because: 'rail not covered by any run we committed to; naming it ' +
                   'rather than reading it on a chain that is not it' });
        continue;
      }
      try {
        const res = await readAddress(r.payTo, {
          ...COVERED[cid], block: blockHex, claimedRail: r.rail });
        rails.push({ rail: r.rail, payTo: r.payTo, verdict: res.verdict,
          balance: res.balance, nonce: res.nonce, rail_covered: res.rail_covered,
          because: res.because });
      } catch (e) {
        rails.push({ rail: r.rail, payTo: r.payTo, verdict: UNKNOWN,
          instrument_failure: true, because: 'READ_FAILED: ' + e.message });
      }
    }

    // Aggregate.
    let verdict, why;
    if (rails.some(r => r.verdict === PAID)) {
      verdict = PAID;
      why = 'at least one advertised rail shows an observed settlement; PAID is monotone';
    } else if (rails.every(r => r.verdict === ZERO_OBSERVED)) {
      verdict = ZERO_OBSERVED;
      why = 'every advertised rail was read and every one is empty for all of history';
    } else {
      const un = rails.filter(r => r.verdict === UNKNOWN).length;
      verdict = UNKNOWN;
      why = `${un} of ${rails.length} advertised rail(s) out of reach, so the ` +
            'door cannot be called empty';
    }
    out.doors.push({ door: door.name, verdict: verdict, why, rails });
  }

  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
