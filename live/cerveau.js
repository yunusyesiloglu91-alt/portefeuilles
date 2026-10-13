// 🧠 Cerveau du sniper : mémoire de ce qui marche et de ce qui ne marche pas.
// 1. Chaque lancement analysé (acheté ou non) est noté avec ses caractéristiques et son prix.
// 2. On suit son prix pendant 24 h : a-t-il fait +50 % avant de perdre 30 % ?
// 3. Les leçons (taux de réussite par caractéristique) sont écrites dans un coffre Obsidian
//    (dossier "cerveau", lisible avec Obsidian ou n'importe quel éditeur) et servent à la stratégie « Cerveau ».
const fs = require('fs');
const path = require('path');

const H = 3600000;
const OBS = path.join(__dirname, 'cerveau-obs.json');
const VAULT = path.join(__dirname, '..', 'cerveau');
const WIN = 0.5, LOSS = 0.3, HORIZON = 24 * H;
const MIN_RESOLVED = 150; // en dessous, le cerveau ne se fait pas encore confiance

const load = () => { try { return JSON.parse(fs.readFileSync(OBS, 'utf8')); } catch { return { obs: {} }; } };
const save = (b) => { fs.writeFileSync(`${OBS}.tmp`, JSON.stringify(b)); fs.renameSync(`${OBS}.tmp`, OBS); };

// Découpage des caractéristiques en tranches lisibles
const FEATURES = {
  'Âge au moment de l’achat': (f) => f.ageMin == null ? null : f.ageMin < 30 ? '< 30 min' : f.ageMin < 60 ? '30–60 min' : f.ageMin < 120 ? '1–2 h' : '2–3 h',
  'Market cap': (f) => f.mcap < 60e3 ? '30–60 k$' : f.mcap < 100e3 ? '60–100 k$' : f.mcap < 200e3 ? '100–200 k$' : '200–300 k$',
  'Liquidité / market cap': (f) => { const r = f.liq / f.mcap; return r < 0.15 ? '< 15 %' : r < 0.3 ? '15–30 %' : '> 30 %'; },
  'Achats / ventes (1 h)': (f) => { const r = f.buys / Math.max(1, f.sells); return r < 1 ? 'plus de ventes' : r < 1.3 ? 'équilibré' : r < 2 ? 'acheteurs ×1,3–2' : 'acheteurs > ×2'; },
  'Activité (1 h)': (f) => { const n = f.buys + f.sells; return n < 200 ? '< 200 transactions' : n < 1000 ? '200–1 000' : '> 1 000'; },
  'Twitter': (f) => (f.twitter ? 'oui' : 'non'),
  'Part du créateur': (f) => f.creatorPct == null ? null : f.creatorPct === 0 ? '0 % (a tout vendu)' : f.creatorPct <= 2 ? '0–2 %' : f.creatorPct <= 5 ? '2–5 %' : '> 5 %',
  'Top 10 détenteurs': (f) => f.top10 == null ? null : f.top10 < 20 ? '< 20 %' : f.top10 < 30 ? '20–30 %' : f.top10 < 50 ? '30–50 %' : '> 50 %',
  'Détenteurs': (f) => f.holders == null ? null : f.holders < 100 ? '< 100' : f.holders < 300 ? '100–300' : '> 300',
  'Réseau d’insiders': (f) => f.insiders == null ? null : f.insiders > 0 ? 'oui' : 'non',
  'Heure (Paris)': (f) => { const h = (new Date(f.t).getUTCHours() + 2) % 24; return h < 6 ? 'nuit 0–6 h' : h < 12 ? 'matin 6–12 h' : h < 18 ? 'après-midi 12–18 h' : 'soir 18–24 h'; },
};

const feats = (c, now) => ({
  t: now, ageMin: Math.round(c.ageH * 60), mcap: c.mcap, liq: c.liq, buys: c.buys1h, sells: c.sells1h, twitter: !!c.twitter,
  creatorPct: c.rc ? c.rc.creatorPct : null, top10: c.rc ? c.rc.top10 : null, holders: c.rc ? c.rc.holders : null, insiders: c.rc ? c.rc.insiders : null,
});

// Rendement d'un trade type (vente à +50 % / stop à −30 %) après frais aller-retour
const tradeRet = (o, fees) => (o.out === 'win' ? WIN : o.out === 'loss' ? -LOSS : Math.max(-LOSS, Math.min(WIN, o.ret24 || 0))) - fees;

function observe(cands, now) {
  const b = load();
  for (const c of cands) {
    if (b.obs[c.addr] || !(c.price > 0)) continue;
    b.obs[c.addr] = { name: c.name, pair: c.pair, t: now, p0: c.price, max: c.price, min: c.price, f: feats(c, now) };
  }
  save(b);
}

// Suivi des prix (≤ 5 appels DexScreener par passage)
async function track(now, json) {
  const b = load();
  const open = Object.entries(b.obs).filter(([, o]) => !o.out).sort((x, y) => (x[1].checked || 0) - (y[1].checked || 0)).slice(0, 150);
  for (let k = 0; k < open.length; k += 30) {
    const chunk = open.slice(k, k + 30);
    const pairs = (await json(`https://api.dexscreener.com/tokens/v1/solana/${chunk.map(([a]) => a).join(',')}`)) || [];
    const px = {};
    for (const p of pairs) if (p.pairAddress && +p.priceUsd > 0) px[p.pairAddress] = +p.priceUsd;
    for (const [, o] of chunk) {
      o.checked = now;
      const p = px[o.pair];
      if (p > 0 && Math.abs(Math.log(p / (o.last || o.p0))) < Math.log(20)) {
        o.last = p; o.max = Math.max(o.max, p); o.min = Math.min(o.min, p);
        if (o.max >= o.p0 * (1 + WIN)) o.out = 'win';
        else if (o.min <= o.p0 * (1 - LOSS)) o.out = 'loss';
      } else if (!p && now - o.t > 6 * H) o.out = 'loss'; // plus coté : token mort
      if (!o.out && now - o.t >= HORIZON) { o.out = 'flat'; o.ret24 = (o.last || o.p0) / o.p0 - 1; }
      if (o.out) o.tOut = now;
    }
  }
  for (const a in b.obs) if (now - b.obs[a].t > 14 * 24 * H) delete b.obs[a]; // mémoire glissante de 14 jours
  save(b);
}

function stats(fees) {
  const all = Object.values(load().obs);
  const done = all.filter((o) => o.out);
  const base = { n: done.length, win: done.filter((o) => o.out === 'win').length, pending: all.length - done.length };
  base.rate = base.n ? base.win / base.n : 0;
  base.avg = base.n ? done.reduce((a, o) => a + tradeRet(o, fees), 0) / base.n : 0;
  const table = {};
  for (const [feat, fn] of Object.entries(FEATURES)) {
    const g = {};
    for (const o of done) {
      const k = fn(o.f);
      if (k == null) continue;
      g[k] = g[k] || { n: 0, win: 0, sum: 0 };
      g[k].n++; g[k].win += o.out === 'win' ? 1 : 0; g[k].sum += tradeRet(o, fees);
    }
    table[feat] = Object.entries(g).map(([k, x]) => ({ k, n: x.n, rate: x.win / x.n, avg: x.sum / x.n }));
  }
  return { base, table };
}

// Note d'un lancement : produit des rapports « réussite de sa tranche / réussite moyenne » (lissés)
function score(c, S, now) {
  if (!S || S.base.n < MIN_RESOLVED) return null;
  const f = feats(c, now);
  let logr = 0;
  const why = [];
  for (const [feat, fn] of Object.entries(FEATURES)) {
    const k = fn(f);
    const row = k != null && S.table[feat].find((x) => x.k === k);
    if (!row || row.n < 15) continue;
    const r = (row.win + 2 * S.base.rate) / (row.n + 2) / Math.max(0.01, S.base.rate);
    logr += Math.log(r);
    if (r > 1.25) why.push(`${feat.toLowerCase()} ${k}`);
  }
  return { mult: Math.exp(logr), why };
}

const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)} %`;
const perOrder = (fees) => fees.tool + fees.dex + fees.slip + fees.fixed / 5;

function lessons(S) {
  const all = [];
  for (const [feat, rows] of Object.entries(S.table)) for (const r of rows) if (r.n >= 20) all.push({ feat, ...r });
  return {
    good: all.filter((l) => l.rate > S.base.rate * 1.25).sort((a, b) => b.rate - a.rate),
    bad: all.filter((l) => l.rate < S.base.rate * 0.75).sort((a, b) => a.rate - b.rate),
  };
}

// Coffre Obsidian : Accueil, Leçons, Stratégies, Frais, journal du jour
function writeVault(S, sniper, fees, now) {
  fs.mkdirSync(path.join(VAULT, 'Journal'), { recursive: true });
  const day = new Date(now).toISOString().slice(0, 10);
  const { good, bad } = lessons(S);
  const line = (l) => `- **${l.feat} : ${l.k}** → ${Math.round(l.rate * 100)} % de réussite (moyenne ${Math.round(S.base.rate * 100)} %), trade moyen ${pct(l.avg)} — ${l.n} cas`;
  const when = new Date(now).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

  fs.writeFileSync(path.join(VAULT, 'Accueil.md'), `# 🧠 Cerveau du sniper

Mis à jour le ${when}.

- [[Leçons]] : ce qui marche et ce qui ne marche pas, mesuré sur ${S.base.n} lancements suivis jusqu'au bout (${S.base.pending} en cours de suivi).
- [[Stratégies]] : résultats de chaque stratégie de test.
- [[Frais]] : ce que coûte un trade.
- Journal : un fichier par jour dans \`Journal/\`.

**Règle du jeu.** Un lancement est une **réussite** s'il prend +${WIN * 100} % avant de perdre ${LOSS * 100} %. C'est la sortie du sniper : moitié vendue à +50 %, stop à −30 %.

**Réussite moyenne : ${Math.round(S.base.rate * 100)} %**, trade moyen après frais : ${pct(S.base.avg)}.
${S.base.n < MIN_RESOLVED ? `\n> Le cerveau apprend encore (${S.base.n}/${MIN_RESOLVED} lancements suivis jusqu'au bout). En attendant, la stratégie « Cerveau » applique les filtres de « Qualité ».\n` : ''}`);

  fs.writeFileSync(path.join(VAULT, 'Leçons.md'), `# Leçons

Retour : [[Accueil]]. Calculé sur **${S.base.n} lancements** (achetés ou non) suivis jusqu'à +50 %, −30 % ou 24 h.
Réussite moyenne : **${Math.round(S.base.rate * 100)} %**. Une tranche n'est citée qu'à partir de 20 cas.

## ✅ Ce qui marche le mieux
${good.length ? good.slice(0, 8).map(line).join('\n') : '- Pas encore assez de cas.'}

## ❌ Ce qui marche le moins
${bad.length ? bad.slice(0, 8).map(line).join('\n') : '- Pas encore assez de cas.'}

## Toutes les mesures
${Object.entries(S.table).map(([feat, rows]) => `### ${feat}\n| Tranche | Cas | Réussite | Trade moyen après frais |\n|---|---|---|---|\n${rows.slice().sort((a, b) => b.rate - a.rate).map((r) => `| ${r.k} | ${r.n} | ${Math.round(r.rate * 100)} % | ${pct(r.avg)} |`).join('\n')}`).join('\n\n')}
`);

  const strat = Object.entries(sniper.variants).map(([id, v]) => {
    const val = v.cash + v.positions.reduce((a, p) => a + p.qty * (p.last || p.entry), 0);
    const cl = v.trades.filter((t) => t.side === 'vente' && !/moitié/.test(t.reason || ''));
    return `| ${id} | ${val.toFixed(2)} $ (${pct(val / 100 - 1)}) | ${cl.filter((t) => t.ret > 0).length}/${cl.length} | ${(v.fees || 0).toFixed(2)} $ |`;
  });
  fs.writeFileSync(path.join(VAULT, 'Stratégies.md'), `# Stratégies (sniper 5 min, 100 $ chacune, 5 $ par trade)

Retour : [[Accueil]] · mis à jour le ${when}

| Stratégie | Valeur | Trades gagnés | Frais payés |
|---|---|---|---|
${strat.join('\n')}
`);

  const o = perOrder(fees);
  fs.writeFileSync(path.join(VAULT, 'Frais.md'), `# Frais d'un trade de 5 $

Retour : [[Accueil]]

| Poste | Coût par ordre |
|---|---|
| Outil de trading automatique (bot type Jupiter / Telegram) | ${(fees.tool * 100).toFixed(1)} % |
| Frais de la plateforme d'échange (DEX) | ${(fees.dex * 100).toFixed(1)} % |
| Glissement (le prix bouge pendant l'ordre) | ${(fees.slip * 100).toFixed(1)} % |
| Réseau Solana + priorité | ${fees.fixed.toFixed(2)} $ fixe (≈ ${((fees.fixed / 5) * 100).toFixed(1)} % sur 5 $) |
| **Total par ordre** | **≈ ${(o * 100).toFixed(1)} %** |
| **Aller-retour (achat + vente)** | **≈ ${(2 * o * 100).toFixed(1)} %** |

Un token doit donc monter d'environ ${Math.round(2 * o * 100)} % juste pour rembourser les frais.
`);

  const todays = Object.entries(sniper.variants).flatMap(([id, v]) => v.trades.map((t) => ({ ...t, id }))).filter((t) => new Date(t.t).toISOString().slice(0, 10) === day);
  fs.writeFileSync(path.join(VAULT, 'Journal', `${day}.md`), `# Journal du ${day}

Retour : [[Accueil]] · [[Leçons]] · mis à jour le ${when}

- Lancements suivis jusqu'au bout (total) : ${S.base.n}, réussite ${Math.round(S.base.rate * 100)} %
- Ordres du jour : ${todays.filter((t) => t.side === 'achat').length} achats, ${todays.filter((t) => t.side === 'vente').length} ventes

## Ventes du jour
${todays.filter((t) => t.side === 'vente').slice(-60).map((t) => `- ${new Date(t.t).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })} [${t.id}] **${t.name}** ${pct(t.ret)} — ${t.reason}`).join('\n') || '- aucune'}
`);
}

// Résumé léger publié avec l'état (affiché sur le site)
function summary(S) {
  const { good, bad } = lessons(S);
  const slim = (l) => ({ feat: l.feat, k: l.k, n: l.n, rate: +l.rate.toFixed(3), avg: +l.avg.toFixed(3) });
  return {
    n: S.base.n, pending: S.base.pending, rate: +S.base.rate.toFixed(3), avg: +S.base.avg.toFixed(3),
    ready: S.base.n >= MIN_RESOLVED, min: MIN_RESOLVED, good: good.slice(0, 4).map(slim), bad: bad.slice(0, 4).map(slim),
  };
}

module.exports = { observe, track, stats, score, writeVault, summary, perOrder, MIN_RESOLVED };
