// Recherche de portefeuilles « long terme » sur les memecoins pump.fun :
// tokens nés sur pump.fun il y a 2 à 30 jours qui valent encore ≥ 300 k$ (des survivants),
// leurs premiers acheteurs, et parmi eux ceux qui détiennent ENCORE au moins la moitié de leurs jetons.
// Puis on garde ceux qui tradent à un rythme humain (pas des robots) et qui sont encore actifs.
const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUBLIC = 'https://api.mainnet-beta.solana.com', TATUM = 'https://solana-mainnet.gateway.tatum.io';
let KEY = '';
try { KEY = (fs.readFileSync(path.join(__dirname, '..', 'live', '.env'), 'utf8').match(/^TATUM_API_KEY=(.+)$/m) || [])[1].trim(); } catch { /* pas de clé */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turn = 0;
async function rpc(method, params) {
  for (let k = 0; k < 6; k++) {
    const t = KEY && (turn++ % 3 === 2 || k % 2 === 1);
    try {
      const r = await fetch(t ? TATUM : PUBLIC, { method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { 'x-api-key': KEY } : {}) }, signal: AbortSignal.timeout(8000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (r.status === 429) { await sleep(800 * (k + 1)); continue; }
      const j = await r.json();
      if (j.error) { if (/429|Too many/i.test(j.error.message)) { await sleep(800 * (k + 1)); continue; } return null; }
      return j.result;
    } catch { await sleep(500); }
  }
  return null;
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

async function main() {
  // 1. Survivants nés sur pump.fun
  const cands = [];
  for (const page of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?page=${page}&sort=h24_volume_usd_desc`)).json().catch(() => ({}));
    for (const x of j.data || []) {
      const mint = x.relationships.base_token.data.id.replace('solana_', '');
      const age = (Date.now() - Date.parse(x.attributes.pool_created_at)) / 86400000;
      const mcap = +(x.attributes.market_cap_usd || x.attributes.fdv_usd || 0);
      if (age >= 1 && age <= 30 && mcap >= 300e3 && mcap < 2e9 && !cands.some((c) => c.mint === mint)) cands.push({ mint, name: x.attributes.name.split(' ')[0], age, mcap });
    }
    await sleep(3500);
  }
  for (const c of cands) c.curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(c.mint).toBuffer()], PUMP)[0].toBase58();
  const accs = (await rpc('getMultipleAccounts', [cands.map((c) => c.curve), { encoding: 'base64' }])) || { value: [] };
  const surv = cands.filter((c, i) => accs.value[i] && accs.value[i].owner === PUMP.toBase58()).slice(0, 15);
  console.log(`${surv.length} survivants pump.fun : ${surv.map((s) => `${s.name} (${s.age.toFixed(0)} j, ${(s.mcap / 1e6).toFixed(1)} M$)`).join(', ')}`);

  // 2. Plus gros détenteurs actuels de chaque survivant. Les pools et la courbe sont des adresses de programme
  //    (hors de la courbe ed25519) : on ne garde que les adresses de personnes, entre 0,3 % et 5 % de l'offre.
  const holders = {};
  for (const sv of surv) {
    const big = await rpc('getTokenLargestAccounts', [sv.mint]);
    const accts = ((big && big.value) || []).slice(0, 20);
    if (!accts.length) continue;
    const info = (await rpc('getMultipleAccounts', [accts.map((x) => x.address), { encoding: 'jsonParsed' }])) || { value: [] };
    const supply = 1e9;
    let n = 0;
    info.value.forEach((acc, i) => {
      const owner = acc && acc.data && acc.data.parsed && acc.data.parsed.info.owner;
      if (!owner || !PublicKey.isOnCurve(new PublicKey(owner).toBytes())) return; // contrat (pool, courbe…)
      const share = (+accts[i].uiAmountString || +accts[i].uiAmount || 0) / supply;
      if (share < 0.003 || share > 0.05) return;
      (holders[owner] = holders[owner] || []).push({ mint: sv.mint, name: sv.name, share: +(share * 100).toFixed(2) });
      n++;
    });
    console.log(`  ${sv.name} : ${n} gros détenteurs (personnes)`);
    await sleep(300);
  }

  // 3. Rythme et activité récente de ces « mains solides »
  const res = [];
  for (const [w, toks] of Object.entries(holders).sort((a, b) => b[1].length - a[1].length).slice(0, 40)) {
    const sigs = ((await rpc('getSignaturesForAddress', [w, { limit: 100 }])) || []).filter((x) => !x.err);
    if (sigs.length < 3) continue;
    const spanH = (sigs[0].blockTime - sigs[sigs.length - 1].blockTime) / 3600;
    const lastDays = (Date.now() / 1000 - sigs[0].blockTime) / 86400;
    res.push({ wallet: w, survivants: toks.length, tokens: toks.map((t) => t.name).join(', '), txPerDay: +(sigs.length / Math.max(spanH / 24, 0.01)).toFixed(1), lastActiveDays: +lastDays.toFixed(1) });
  }
  // Rythme humain (≤ 60 transactions / jour), actif dans les 3 derniers jours
  const good = res.filter((r) => r.txPerDay <= 60 && r.lastActiveDays <= 3).sort((a, b) => b.survivants - a.survivants || a.txPerDay - b.txPerDay);
  console.log('\nPortefeuille | survivants gardés | lesquels | transactions/jour | dernière activité');
  for (const r of res.sort((a, b) => b.survivants - a.survivants)) console.log(`${r.wallet.slice(0, 8)}… | ${r.survivants} | ${r.tokens} | ${r.txPerDay} | il y a ${r.lastActiveDays} j`);
  const long = good.slice(0, 4);
  console.log(`\nLong terme retenus : ${long.map((r) => r.wallet).join(', ') || 'aucun'}`);
  fs.writeFileSync(path.join(__dirname, 'longterme.json'), JSON.stringify({ date: new Date().toISOString(), survivants: surv, res, long }, null, 1));
}
main();
