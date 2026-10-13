// Recherche : teste des stratégies d'entrée / sortie sur l'historique minute réel des tokens suivis par le cerveau.
// Prudence contre le hasard : on choisit sur la première partie des données (« apprentissage »)
// et on vérifie sur la seconde (« test »), jamais vue pendant le choix. Frais réels inclus.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'ohlcv');
const STAKE = 5, PCT = 0.018, FIXED = 0.03; // frais par ordre : outil 1 % + DEX 0,3 % + glissement 0,5 % + réseau 0,03 $
const MIN = 60000;

const toks = fs.readdirSync(DIR).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
  .sort((a, b) => a.t - b.t);
// Prudence : un token sans historique exploitable est le plus souvent mort (arnaque) : compté comme une perte de 95 %
for (const x of toks) x.dead = x.rows.length < 20;
const cut = Math.floor(toks.length * 0.6);
const train = toks.slice(0, cut), test = toks.slice(cut);

// Une stratégie de sortie sur une suite de bougies minute. Prudence : si la bougie touche le stop et l'objectif, on compte le stop.
function trade(tok, X) {
  if (tok.dead) return -0.95;
  const rows = tok.rows;
  let i = rows.findIndex((r) => r[0] >= Math.floor(tok.t / MIN) * MIN);
  if (i < 0) return null;
  // Entrée retardée de X.delay minutes, seulement si le token a confirmé (variation depuis l'observation)
  if (X.delay) {
    const j = rows.findIndex((r) => r[0] >= rows[i][0] + X.delay * MIN);
    if (j < 0) return null;
    const move = rows[j][1] / rows[i][1] - 1;
    if (move < X.confirmMin || move > X.confirmMax) return null;
    // Encore vivant : des échanges dans les 10 dernières minutes et pas déjà effondré de 80 %
    if (rows[j][0] - rows[j - 1 >= 0 ? j - 1 : j][0] > 10 * MIN || rows[j][1] < rows[i][1] * 0.2) return null;
    i = j;
  }
  const entry = rows[i][1];
  let qty = (STAKE * (1 - PCT) - FIXED) / entry, got = 0, peak = entry, half = false;
  const sell = (part, price) => { const q = qty * part; got += Math.max(0, q * price * (1 - PCT) - FIXED * part); qty -= q; };
  const end = rows[i][0] + X.maxH * 60 * MIN;
  for (let k = i; k < rows.length; k++) {
    const [ts, o, h, l, c] = rows[k];
    const stop = half && X.trail ? peak * (1 - X.trail) : entry * (1 - X.sl);
    if (l <= stop) { sell(1, Math.min(o, stop)); return got / STAKE - 1; }
    if (!half && h >= entry * (1 + X.tp)) {
      sell(X.part, Math.max(o, entry * (1 + X.tp)));
      if (X.part >= 1) return got / STAKE - 1;
      half = true;
    }
    peak = Math.max(peak, h);
    if (ts >= end || k === rows.length - 1) { sell(1, c); return got / STAKE - 1; }
  }
  return got / STAKE - 1;
}

const FILTERS = {
  tout: () => true,
  twitterOui: (f) => f.twitter, twitterNon: (f) => !f.twitter,
  detenteursMoins100: (f) => f.holders != null && f.holders < 100, detenteurs100plus: (f) => f.holders >= 100,
  sansInsiders: (f) => f.insiders === 0,
  top10Max30: (f) => f.top10 != null && f.top10 <= 30, top10Max50: (f) => f.top10 != null && f.top10 <= 50,
  acheteurs: (f) => f.buys > f.sells, acheteurs13: (f) => f.buys > f.sells * 1.3,
  mcapMoins100k: (f) => f.mcap < 100e3, mcap100kPlus: (f) => f.mcap >= 100e3,
  jeuneMoins60min: (f) => f.ageMin < 60, age60plus: (f) => f.ageMin >= 60,
  liqFaible: (f) => f.liq / f.mcap < 0.15, liqForte: (f) => f.liq / f.mcap >= 0.3,
  actif: (f) => f.buys + f.sells >= 1000, calme: (f) => f.buys + f.sells < 200,
  createur0: (f) => f.creatorPct === 0,
};

function score(set, X, filt) {
  const r = [];
  for (const tok of set) if (filt(tok.f)) { const x = trade(tok, X); if (x != null) r.push(x); }
  if (!r.length) return { n: 0 };
  const s = r.slice().sort((a, b) => b - a);
  const mean = r.reduce((a, x) => a + x, 0) / r.length;
  const sansTop3 = s.length > 3 ? s.slice(3).reduce((a, x) => a + x, 0) / (s.length - 3) : -1;
  return { n: r.length, mean, win: r.filter((x) => x > 0).length / r.length, med: s[s.length >> 1], sansTop3 };
}

// 1. Toutes les sorties et entrées sur tous les tokens (apprentissage)
const exits = [];
for (const delay of [0, 10, 30, 60, 120]) for (const [confirmMin, confirmMax] of delay ? [[-1, 99], [0, 99], [0.3, 99], [1, 99], [-0.5, 0]] : [[-1, 99]])
  for (const sl of [0.25, 0.4, 0.6, 0.95]) for (const tp of [0.3, 0.5, 1, 2, 4]) for (const part of [0.5, 1])
    for (const trail of part < 1 ? [0.3, 0.5] : [0]) for (const maxH of [1, 4, 12])
      exits.push({ delay, confirmMin, confirmMax, sl, tp, part, trail, maxH });
const label = (X) => `${X.delay ? `attend ${X.delay} min (${X.confirmMin === -1 ? 'sans condition' : `variation ${Math.round(X.confirmMin * 100)} à ${X.confirmMax > 9 ? '∞' : Math.round(X.confirmMax * 100)} %`})` : 'achat immédiat'} · stop −${X.sl * 100} % · ${X.part < 1 ? `½ à +${X.tp * 100} %, reste suivi −${X.trail * 100} %` : `tout à +${X.tp * 100} %`} · max ${X.maxH} h`;

console.log(`Tokens avec historique : ${toks.length} (apprentissage ${train.length}, test ${test.length})`);
const res = exits.map((X) => ({ X, tr: score(train, X, FILTERS.tout) })).filter((x) => x.tr.n >= 30).sort((a, b) => b.tr.mean - a.tr.mean);
console.log('\n== Meilleures sorties sur l’apprentissage, vérifiées sur le test (tous les tokens) ==');
for (const r of res.slice(0, 12)) {
  const te = score(test, r.X, FILTERS.tout);
  console.log(`${label(r.X)}\n   appr. ${r.tr.n} trades, moy ${(r.tr.mean * 100).toFixed(1)} %, gagnés ${(r.tr.win * 100).toFixed(0)} %, sans top3 ${(r.tr.sansTop3 * 100).toFixed(1)} % | TEST ${te.n} trades, moy ${(te.mean * 100).toFixed(1)} %, gagnés ${(te.win * 100).toFixed(0)} %, sans top3 ${(te.sansTop3 * 100).toFixed(1)} %`);
}
const cur = { delay: 0, confirmMin: -1, confirmMax: 99, sl: 0.35, tp: 1, part: 0.5, trail: 0.3, maxH: 16 };
const c1 = score(train, cur, FILTERS.tout), c2 = score(test, cur, FILTERS.tout);
console.log(`\nRéglage actuel (stop −35 %, ½ à ×2, suivi −30 %) : appr. moy ${(c1.mean * 100).toFixed(1)} % | test moy ${(c2.mean * 100).toFixed(1)} %`);

// 2. Filtres, avec les 5 meilleures sorties
console.log('\n== Filtres (seuls et par deux) avec les meilleures sorties ==');
const names = Object.keys(FILTERS).filter((k) => k !== 'tout');
const combos = [['tout'], ...names.map((n) => [n])];
for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) combos.push([names[a], names[b]]);
const best = [];
for (const r of res.slice(0, 5)) for (const c of combos) {
  const fn = (f) => c.every((k) => FILTERS[k](f));
  const tr = score(train, r.X, fn);
  if (tr.n >= 20) best.push({ X: r.X, c, tr });
}
best.sort((a, b) => b.tr.mean - a.tr.mean);
for (const b of best.slice(0, 15)) {
  const te = score(test, b.X, (f) => b.c.every((k) => FILTERS[k](f)));
  console.log(`[${b.c.join(' + ')}] ${label(b.X)}\n   appr. ${b.tr.n}, moy ${(b.tr.mean * 100).toFixed(1)} %, sans top3 ${(b.tr.sansTop3 * 100).toFixed(1)} % | TEST ${te.n}, moy ${te.n ? (te.mean * 100).toFixed(1) : '-'} %, gagnés ${te.n ? (te.win * 100).toFixed(0) : '-'} %, sans top3 ${te.n ? (te.sansTop3 * 100).toFixed(1) : '-'} %`);
}
fs.writeFileSync(path.join(__dirname, 'resultats.json'), JSON.stringify({ n: toks.length, exits: res.slice(0, 30).map((r) => ({ ...r, te: score(test, r.X, FILTERS.tout) })), filters: best.slice(0, 40).map((b) => ({ ...b, te: score(test, b.X, (f) => b.c.every((k) => FILTERS[k](f))) })) }, null, 1));

// Calibrage : simulation du réglage actuel contre le résultat réellement obtenu en direct, token par token
try {
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'live', 'sniper5-state.json'), 'utf8')).sniper;
  const live = {};
  for (const v of Object.values(st.variants)) for (const t of v.trades) if (t.side === 'vente' && !/moitié/.test(t.reason || '') && t.addr && live[t.addr] == null) live[t.addr] = t.ret;
  const files = new Set(fs.readdirSync(DIR).map((f) => f.replace('.json', '')));
  const pairs = [];
  for (const [a, r] of Object.entries(live)) if (files.has(a)) { const tok = toks.find((x) => x.f && JSON.stringify(x.f) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(DIR, a + '.json'))).f)); if (tok) pairs.push([trade(tok, cur), r]); }
  const m = (a) => (a.reduce((x, y) => x + y, 0) / a.length * 100).toFixed(0);
  if (pairs.length) console.log(`\nCalibrage sur ${pairs.length} tokens tradés en direct : simulation ${m(pairs.map((p) => p[0]))} % contre réel ${m(pairs.map((p) => p[1]))} %`);
} catch (e) { console.log('calibrage impossible', e.message); }
