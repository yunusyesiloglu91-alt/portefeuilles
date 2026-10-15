// Recherche : et si on avait acheté au bloc 1, 2, 3 ou 4 après la création ?
// Pour chaque token réellement tradé par les Éclair (prix réels), on reconstitue sur la blockchain
// l'état de la courbe pump.fun au début de chaque bloc, puis on recalcule le résultat du trade
// avec ce prix d'entrée (même sortie, même mise, mêmes frais).
const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const Courbe = require('../live/courbe.js');

const RPC = 'https://api.mainnet-beta.solana.com';
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const V_TOKENS0 = 1073000000, REAL_TOKENS0 = 793100000, K = 30 * 1073000000; // courbe pump.fun au départ
const BLOCS = [0, 1, 2, 3, 4];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let k = 0; k < 5; k++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (r.status === 429) { await sleep(2000 * (k + 1)); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { if (k === 4) throw e; await sleep(1000); }
  }
}

// Réserves virtuelles de jetons de la courbe juste après une transaction
async function vTokensAfter(sig, curve) {
  const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (!tx) return null;
  const bal = (tx.meta.postTokenBalances || []).find((b) => b.owner === curve);
  if (!bal) return null;
  const real = +bal.uiTokenAmount.uiAmountString;
  // Le compte de la courbe détient tous les jetons pas encore vendus (1 milliard au départ)
  return V_TOKENS0 - (1e9 - real);
}

async function main() {
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'live', 'sniper-rt-state.json'), 'utf8'));
  const sol = +(await (await fetch('https://data-api.binance.vision/api/v3/ticker/price?symbol=SOLUSDT')).json()).price;
  // Trades fermés depuis le passage aux prix réels (une ligne par token et par variante)
  const trades = [];
  for (const [id, v] of Object.entries(st.variants)) {
    if (!['eclair', 'eclairQ', 'eclairS', 'eclairQ04', 'eclairQ3'].includes(id)) continue;
    const buys = {};
    for (const t of v.trades) if (t.side === 'achat' && t.t >= st.realStart) buys[t.mint] = t;
    for (const t of v.trades) if (t.side === 'vente' && !/moitié/.test(t.reason || '') && buys[t.mint]) trades.push({ id, mint: t.mint, name: t.name, ret: t.ret, buy: buys[t.mint] });
  }
  // Échantillon : les 40 tokens les plus récents (suffisant pour mesurer, sans attendre des heures)
  const LIMIT = +(process.argv[2] || 40);
  const mints = [...new Set(trades.slice().sort((a, b) => b.buy.t - a.buy.t).map((t) => t.mint))].slice(0, LIMIT);
  trades.splice(0, trades.length, ...trades.filter((t) => mints.includes(t.mint)));
  console.log(`${trades.length} trades fermés, ${mints.length} tokens différents. Reconstitution bloc par bloc…`);
  const price = {}; // mint -> { bloc: vT au début de ce bloc }
  let n = 0;
  for (const mint of mints) {
    try {
      const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP)[0].toBase58();
      // Toutes les signatures de la courbe (les plus anciennes en dernier) : on remonte jusqu'à la création
      let sigs = [], before;
      for (let k = 0; k < 10; k++) {
        const page = await rpc('getSignaturesForAddress', [curve, { limit: 1000, before, commitment: 'confirmed' }]);
        sigs = sigs.concat(page);
        if (page.length < 1000) break;
        before = page[page.length - 1].signature;
      }
      sigs = sigs.filter((s) => !s.err).reverse();
      if (!sigs.length) continue;
      const s0 = sigs[0].slot;
      const res = {};
      for (const b of BLOCS) {
        // État au début du bloc s0+b = après la dernière transaction des blocs précédents
        // Bloc 0 = juste après la transaction de création (l'achat du créateur est déjà passé)
        const prev = b === 0 ? [sigs[0]] : sigs.filter((s) => s.slot < s0 + b);
        const vT = await vTokensAfter(prev[prev.length - 1].signature, curve);
        if (vT) res[b] = vT;
        await sleep(150);
      }
      price[mint] = res;
    } catch (e) { /* token ignoré */ }
    if (++n % 10 === 0) console.log(`  ${n}/${mints.length}`);
  }

  // Résultat de chaque trade si l'entrée avait eu lieu au début du bloc b
  console.log('\nBloc d\'entrée | trades | gagnés | moyenne par trade | sans les 3 meilleurs | valeur pour 100 $ (mises de 10 $)');
  const table = {};
  for (const b of BLOCS) {
    const r = [];
    for (const t of trades) {
      const p = price[t.mint];
      if (!p || !p[b]) continue;
      const stake = t.buy.usd;
      const solIn = stake / sol - 0.000205;
      const vT = p[b], vS = K / vT;
      const tokensB = Courbe.buyQuote({ vT, vS }, solIn).tokens;
      const tokensReal = stake / t.buy.price;
      r.push((1 + t.ret) * (tokensB / tokensReal) - 1);
    }
    const s = r.slice().sort((a, b2) => b2 - a);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    table[b] = { n: r.length, win: r.filter((x) => x > 0).length, avg: avg(r), sansTop3: avg(s.slice(3)) };
    console.log(`bloc ${b} (${b === 0 ? 'création, comme le créateur' : `~${(b * 0.4).toFixed(1)} s`}) | ${r.length} | ${table[b].win} | ${(table[b].avg * 100).toFixed(1)} % | ${(table[b].sansTop3 * 100).toFixed(1)} %`);
  }
  const real = trades.map((t) => t.ret);
  console.log(`réel (moteur actuel, ~1,2 s + latence) | ${real.length} | ${real.filter((x) => x > 0).length} | ${(real.reduce((a, b) => a + b, 0) / real.length * 100).toFixed(1)} %`);
  fs.writeFileSync(path.join(__dirname, 'blocs-resultats.json'), JSON.stringify({ date: new Date().toISOString(), sol, table, tokens: Object.keys(price).length }, null, 1));
}
main();
