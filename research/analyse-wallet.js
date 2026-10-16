// Analyse d'un portefeuille : bénéfice réel par token (SOL dépensés contre SOL récupérés), durée de détention,
// rythme, régularité, positions encore ouvertes. Usage : node analyse-wallet.js <adresse> [<adresse> …] [--n=300]
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Appels à la blockchain : serveur public et Tatum en alternance, avec nouvelles tentatives (le serveur public limite le débit)
const PUBLIC = 'https://api.mainnet-beta.solana.com', TATUM = 'https://solana-mainnet.gateway.tatum.io';
let KEY = '';
try { KEY = (fs.readFileSync(path.join(__dirname, '..', 'live', '.env'), 'utf8').match(/^TATUM_API_KEY=(.+)$/m) || [])[1].trim(); } catch { /* pas de clé */ }
let turn = 0;
async function rpc(method, params) {
  for (let k = 0; k < 7; k++) {
    const useTatum = KEY && (turn++ % 3 === 2 || k % 2 === 1);
    try {
      const r = await fetch(useTatum ? TATUM : PUBLIC, { method: 'POST', headers: { 'content-type': 'application/json', ...(useTatum ? { 'x-api-key': KEY } : {}) }, signal: AbortSignal.timeout(9000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (r.status === 429) { await sleep(700 * (k + 1)); continue; }
      const j = await r.json();
      if (j.error) { if (/429|Too many/i.test(j.error.message)) { await sleep(700 * (k + 1)); continue; } return null; }
      return j.result;
    } catch { await sleep(500); }
  }
  return null;
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

async function analyse(wallet, N) {
  let sigs = [], before;
  while (sigs.length < N) {
    const page = await rpc('getSignaturesForAddress', [wallet, { limit: Math.min(1000, N - sigs.length), before }]);
    if (!page || !page.length) break;
    sigs = sigs.concat(page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  sigs = sigs.filter((s) => !s.err);
  const txs = await pool(sigs.map((s) => s.signature), 5, (sig) => rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]));
  const per = {};
  for (const t of txs.filter(Boolean).sort((a, b) => a.blockTime - b.blockTime)) {
    const keys = t.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    if (keys[0] !== wallet) continue; // seulement ses propres ordres
    const i = keys.indexOf(wallet);
    const sol = (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9;
    const pre = {}, post = {};
    for (const b of t.meta.preTokenBalances || []) if (b.owner === wallet) pre[b.mint] = +b.uiTokenAmount.uiAmountString || 0;
    for (const b of t.meta.postTokenBalances || []) if (b.owner === wallet) post[b.mint] = +b.uiTokenAmount.uiAmountString || 0;
    const mints = [...new Set([...Object.keys(pre), ...Object.keys(post)])].filter((m) => m !== 'So11111111111111111111111111111111111111112' && Math.abs((post[m] || 0) - (pre[m] || 0)) > 1e-6);
    if (mints.length !== 1) continue; // un seul token par transaction : sinon on ne sait pas répartir les SOL
    const m = mints[0], d = (post[m] || 0) - (pre[m] || 0), t0 = t.blockTime * 1000;
    const x = (per[m] = per[m] || { solIn: 0, solOut: 0, bought: 0, sold: 0, first: t0, last: t0, buys: 0, sells: 0 });
    if (d > 0) { x.solIn += -sol; x.bought += d; x.buys++; } else { x.solOut += sol; x.sold += -d; x.sells++; }
    x.last = t0;
  }
  const all = Object.entries(per).filter(([, x]) => x.solIn > 0.01);
  const closed = all.filter(([, x]) => x.sold >= x.bought * 0.9);
  const open = all.filter(([, x]) => x.sold < x.bought * 0.9);
  const pnl = closed.map(([, x]) => x.solOut - x.solIn);
  const holds = closed.map(([, x]) => (x.last - x.first) / 60000).sort((a, b) => a - b);
  const median = (a) => (a.length ? a[a.length >> 1] : 0);
  const spanDays = sigs.length > 1 ? (sigs[0].blockTime - sigs[sigs.length - 1].blockTime) / 86400 : 0;
  const best = pnl.slice().sort((a, b) => b - a);
  return {
    wallet, transactions: sigs.length, jours: +spanDays.toFixed(2), txParJour: +(sigs.length / Math.max(spanDays, 0.04)).toFixed(0),
    dernierMouvementH: sigs.length ? +((Date.now() / 1000 - sigs[0].blockTime) / 3600).toFixed(1) : null,
    tokens: all.length, fermes: closed.length, gagnes: pnl.filter((x) => x > 0).length,
    beneficeSol: +pnl.reduce((a, x) => a + x, 0).toFixed(3), sansTop3Sol: +(pnl.reduce((a, x) => a + x, 0) - best.slice(0, 3).reduce((a, x) => a + x, 0)).toFixed(3),
    miseMoyenneSol: closed.length ? +(closed.reduce((a, [, x]) => a + x.solIn, 0) / closed.length).toFixed(3) : 0,
    detentionMedianeMin: +median(holds).toFixed(1), detentionMoyenneMin: holds.length ? +(holds.reduce((a, x) => a + x, 0) / holds.length).toFixed(1) : 0,
    detentionMaxMin: +(holds[holds.length - 1] || 0).toFixed(1), ouverts: open.length,
    meilleurs: closed.map(([m, x]) => ({ mint: m, pnl: +(x.solOut - x.solIn).toFixed(3), minutes: +((x.last - x.first) / 60000).toFixed(1) })).sort((a, b) => b.pnl - a.pnl).slice(0, 4),
  };
}
module.exports = { analyse };
if (require.main === module) {
  const args = process.argv.slice(2);
  const N = +((args.find((a) => a.startsWith('--n=')) || '--n=300').slice(4));
  (async () => {
    const out = [];
    for (const w of args.filter((a) => !a.startsWith('--'))) { const r = await analyse(w, N); out.push(r); console.log(JSON.stringify(r, null, 1)); }
    fs.writeFileSync(path.join(__dirname, 'analyse-wallet.json'), JSON.stringify(out, null, 1));
  })();
}
