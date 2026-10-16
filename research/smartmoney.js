// Recherche des portefeuilles qui gagnent vraiment sur pump.fun (« smart money »), à partir de la blockchain.
// 1. Tokens pump.fun qui ont le mieux marché ces 48 h (PumpSwap, GeckoTerminal) ;
// 2. leurs premiers acheteurs (premières transactions de la courbe) ;
// 3. pour les portefeuilles qui reviennent sur plusieurs gagnants : bénéfice RÉEL sur leurs derniers trades
//    (SOL dépensés à l'achat contre SOL récupérés à la vente, frais compris), taux de réussite, durée de détention.
const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUBLIC = 'https://api.mainnet-beta.solana.com';
const TATUM = 'https://solana-mainnet.gateway.tatum.io';
let KEY = '';
try { KEY = (fs.readFileSync(path.join(__dirname, '..', 'live', '.env'), 'utf8').match(/^TATUM_API_KEY=(.+)$/m) || [])[1].trim(); } catch { /* pas de clé */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turn = 0;
async function rpc(method, params) {
  for (let k = 0; k < 6; k++) {
    const useTatum = KEY && (turn++ % 3 === 2 || k % 2 === 1); // 1 appel sur 3 via Tatum, et en secours
    try {
      const r = await fetch(useTatum ? TATUM : PUBLIC, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(useTatum ? { 'x-api-key': KEY } : {}) },
        signal: AbortSignal.timeout(8000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (r.status === 429) { await sleep(800 * (k + 1)); continue; }
      const j = await r.json();
      if (j.error) { if (/429|Too many/i.test(j.error.message)) { await sleep(800 * (k + 1)); continue; } return null; }
      return j.result;
    } catch { await sleep(500); }
  }
  return null;
}
const tx = (sig) => rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

// Variation de SOL et de jetons pump d'un portefeuille dans une transaction
function deltas(t, wallet) {
  const keys = t.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(wallet);
  const sol = i >= 0 ? (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9 : 0;
  const tok = {};
  for (const b of t.meta.preTokenBalances || []) if (b.owner === wallet) tok[b.mint] = (tok[b.mint] || 0) - (+b.uiTokenAmount.uiAmountString || 0);
  for (const b of t.meta.postTokenBalances || []) if (b.owner === wallet) tok[b.mint] = (tok[b.mint] || 0) + (+b.uiTokenAmount.uiAmountString || 0);
  return { sol, tok, signer: keys[0], time: t.blockTime * 1000 };
}

async function main() {
  // 1. Tokens gagnants récents
  const winners = [];
  // PumpSwap (tokens sortis de la courbe) + pump.fun (tokens encore sur la courbe), triés par volume 24 h
  for (const [dex, page] of [['pumpswap', 1], ['pumpswap', 2], ['pumpswap', 3], ['pump-fun', 1], ['pump-fun', 2], ['pump-fun', 3]]) {
    const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/${dex}/pools?page=${page}&sort=h24_volume_usd_desc`)).json();
    for (const x of j.data || []) {
      const mint = x.relationships.base_token.data.id.replace('solana_', '');
      const age = (Date.now() - Date.parse(x.attributes.pool_created_at)) / 3600000;
      const mcap = +(x.attributes.market_cap_usd || x.attributes.fdv_usd || 0);
      if (age <= 48 && mcap >= 30e3 && mcap < 1e9 && !winners.some((w) => w.mint === mint)) winners.push({ mint, name: x.attributes.name });
    }
    await sleep(3500);
  }
  // Garder ceux qui sont vraiment nés sur pump.fun : leur courbe existe sur la blockchain
  for (const w of winners) w.curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(w.mint).toBuffer()], PUMP)[0].toBase58();
  const accs = (await rpc('getMultipleAccounts', [winners.map((w) => w.curve), { encoding: 'base64' }])) || { value: [] };
  const top = winners.filter((w, i) => accs.value[i] && accs.value[i].owner === PUMP.toBase58()).slice(0, 25);
  console.log(`${top.length} tokens gagnants récents : ${top.map((w) => w.name.split(' ')[0]).join(', ')}`);

  // 2. Premiers acheteurs de chaque gagnant
  const early = {}; // portefeuille -> { tokens: Set, creatorOf: Set }
  let done = 0;
  for (const w of top) {
    const curve = w.curve;
    let sigs = [], before;
    for (let k = 0; k < 25; k++) { // on remonte jusqu'à la création (la courbe ne sert plus après la migration)
      const page = await rpc('getSignaturesForAddress', [curve, { limit: 1000, before }]);
      if (!page || !page.length) break;
      sigs = sigs.concat(page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    const first = sigs.filter((s) => !s.err).reverse().slice(0, 300);
    const txs = await pool(first.map((s) => s.signature), 4, tx);
    // Bénéfice de chaque portefeuille sur CE token (pendant la phase de courbe)
    const pnl = {};
    txs.forEach((t, k) => {
      if (!t) return;
      const signer = t.transaction.message.accountKeys.map((x) => (typeof x === 'string' ? x : x.pubkey))[0];
      const dd = deltas(t, signer);
      if (!(Math.abs(dd.tok[w.mint] || 0) > 0)) return;
      const p = (pnl[signer] = pnl[signer] || { sol: 0, creator: k === 0 });
      p.sol += dd.sol;
    });
    // Les 6 portefeuilles qui ont le plus gagné sur ce token
    for (const [signer, p] of Object.entries(pnl).filter(([, p]) => p.sol > 0.2).sort((a, b) => b[1].sol - a[1].sol).slice(0, 6)) {
      const e = (early[signer] = early[signer] || { tokens: new Set(), creatorOf: new Set() });
      e.tokens.add(w.mint);
      if (p.creator) e.creatorOf.add(w.mint);
    }
    console.log(`  ${++done}/${top.length} ${w.name}`);
  }

  // 3. Bénéfice réel des portefeuilles qui reviennent sur plusieurs gagnants
  const cands = Object.entries(early).sort((a, b) => b[1].tokens.size - a[1].tokens.size).slice(0, 40);
  console.log(`\n${cands.length} portefeuilles présents tôt sur au moins 2 gagnants. Calcul de leurs vrais résultats…`);
  const results = [];
  for (const [wallet, e] of cands) {
    const sigs = (await rpc('getSignaturesForAddress', [wallet, { limit: 80 }])) || [];
    const ok = sigs.filter((s) => !s.err);
    const span = ok.length > 1 ? (ok[0].blockTime - ok[ok.length - 1].blockTime) / 60 : 0; // minutes couvertes par ces transactions
    const txs = await pool(ok.map((s) => s.signature), 4, tx);
    const per = {};
    for (const t of txs) {
      if (!t) continue;
      const d = deltas(t, wallet);
      for (const [mint, q] of Object.entries(d.tok)) {
        if (!/pump$/.test(mint) || Math.abs(q) < 1e-6) continue;
        const m = (per[mint] = per[mint] || { solIn: 0, solOut: 0, bought: 0, sold: 0, t0: Infinity, t1: 0 });
        if (q > 0) { m.solIn += -d.sol; m.bought += q; m.t0 = Math.min(m.t0, d.time); } else { m.solOut += d.sol; m.sold += -q; m.t1 = Math.max(m.t1, d.time); }
      }
    }
    const closed = Object.values(per).filter((m) => m.bought > 0 && m.sold >= m.bought * 0.95 && m.solIn > 0);
    if (!closed.length) continue;
    const pnl = closed.map((m) => m.solOut - m.solIn);
    const holds = closed.map((m) => (m.t1 - m.t0) / 60000).filter((x) => x >= 0).sort((a, b) => a - b);
    results.push({
      wallet, earlyOn: e.tokens.size, creator: e.creatorOf.size > 0,
      closed: closed.length, wins: pnl.filter((x) => x > 0).length, pnlSol: +pnl.reduce((a, x) => a + x, 0).toFixed(3),
      medianHoldMin: +(holds[holds.length >> 1] || 0).toFixed(1), avgBuySol: +(closed.reduce((a, m) => a + m.solIn, 0) / closed.length).toFixed(3),
      txPerHour: span > 0 ? +(ok.length / (span / 60)).toFixed(1) : null,
    });
  }
  results.sort((a, b) => b.pnlSol - a.pnlSol);
  console.log('\nPortefeuille | sur gagnants | trades fermés | gagnés | bénéfice (SOL) | durée médiane | mise moyenne | trades/h');
  for (const r of results) console.log(`${r.wallet.slice(0, 8)}…${r.creator ? ' (créateur)' : ''} | ${r.earlyOn} | ${r.closed} | ${r.wins} | ${r.pnlSol} | ${r.medianHoldMin} min | ${r.avgBuySol} SOL | ${r.txPerHour}`);
  // Sélection : bénéfice ≥ 0,5 SOL, au moins 3 trades fermés, au moins la moitié gagnants, pas un robot hyperactif
  const good = results.filter((r) => r.pnlSol >= 0.5 && r.closed >= 3 && r.wins / r.closed >= 0.5 && (r.txPerHour === null || r.txPerHour < 120));
  const court = good.filter((r) => r.medianHoldMin < 20).slice(0, 3);
  const moyen = good.filter((r) => r.medianHoldMin >= 20).slice(0, 3);
  console.log(`\nCourt terme : ${court.map((r) => r.wallet).join(', ') || 'aucun'}`);
  console.log(`Moyen terme : ${moyen.map((r) => r.wallet).join(', ') || 'aucun'}`);
  fs.writeFileSync(path.join(__dirname, 'smartmoney.json'), JSON.stringify({ date: new Date().toISOString(), winners: top, results, court, moyen }, null, 1));
}
main();
