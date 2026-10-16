// Le cerveau construit sa stratégie : à partir de tous les tokens qu'il a suivis (caractéristiques au moment
// de l'observation + ce qui s'est passé ensuite), il cherche les règles simples (1 ou 2 conditions) qui donnent
// le meilleur résultat, sur la première partie des données, puis les vérifie sur la seconde (jamais vue).
const fs = require('fs');
const path = require('path');
const obs = Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'live', 'cerveau-obs.json'), 'utf8')).obs)
  .filter((o) => o.out && o.f).sort((a, b) => a.t - b.t);
const FEES = 0.06; // aller-retour (frais plateforme + réseau), prudent

// Résultat d'un trade type : on vise +50 %, stop −30 %, sinon le prix à 24 h (borné)
const ret = (o) => (o.out === 'win' ? 0.5 : o.out === 'loss' ? -0.3 : Math.max(-0.3, Math.min(0.5, o.ret24 || 0))) - FEES;

const COND = {
  'âge < 15 min': (f) => f.ageMin < 15, 'âge 15–60 min': (f) => f.ageMin >= 15 && f.ageMin < 60, 'âge > 60 min': (f) => f.ageMin >= 60,
  'mcap < 50 k$': (f) => f.mcap < 50e3, 'mcap 50–150 k$': (f) => f.mcap >= 50e3 && f.mcap < 150e3, 'mcap > 150 k$': (f) => f.mcap >= 150e3,
  'liquidité ≥ 35 %': (f) => f.liq / f.mcap >= 0.35, 'liquidité < 25 %': (f) => f.liq / f.mcap < 0.25,
  'acheteurs ≥ ×1,3': (f) => f.buys >= f.sells * 1.3, 'acheteurs ≥ ×2': (f) => f.buys >= f.sells * 2, 'plus de vendeurs': (f) => f.buys < f.sells,
  'activité < 300': (f) => f.buys + f.sells < 300, 'activité 300–1500': (f) => f.buys + f.sells >= 300 && f.buys + f.sells < 1500, 'activité > 1500': (f) => f.buys + f.sells >= 1500,
  'Twitter': (f) => f.twitter, 'sans Twitter': (f) => !f.twitter,
  'créateur 0 %': (f) => f.creatorPct === 0, 'top 10 < 20 %': (f) => f.top10 != null && f.top10 < 20, 'top 10 ≤ 30 %': (f) => f.top10 != null && f.top10 <= 30,
  'détenteurs < 100': (f) => f.holders != null && f.holders < 100, 'détenteurs ≥ 300': (f) => f.holders >= 300,
  'sans insiders': (f) => f.insiders === 0,
  'nuit (0–6 h)': (f) => (new Date(f.t).getUTCHours() + 2) % 24 < 6, 'après-midi/soir (12–24 h)': (f) => (new Date(f.t).getUTCHours() + 2) % 24 >= 12,
};
const cut = Math.floor(obs.length * 0.6);
const train = obs.slice(0, cut), test = obs.slice(cut);
const score = (set, fns) => {
  const r = set.filter((o) => fns.every((fn) => fn(o.f))).map(ret);
  return r.length ? { n: r.length, avg: r.reduce((a, x) => a + x, 0) / r.length, win: set.filter((o) => fns.every((fn) => fn(o.f)) && o.out === 'win').length / r.length } : { n: 0 };
};
const base = { tr: score(train, []), te: score(test, []) };
console.log(`${obs.length} tokens suivis jusqu'au bout (apprentissage ${train.length}, test ${test.length}).`);
console.log(`Sans aucune règle : appr. ${(base.tr.avg * 100).toFixed(1)} % par trade | test ${(base.te.avg * 100).toFixed(1)} %\n`);
const names = Object.keys(COND);
const rules = [];
for (const a of names) {
  rules.push([a]);
  for (const b of names) if (a < b) rules.push([a, b]);
}
const res = rules.map((r) => ({ r, tr: score(train, r.map((k) => COND[k])) })).filter((x) => x.tr.n >= 40).sort((x, y) => y.tr.avg - x.tr.avg).slice(0, 15)
  .map((x) => ({ ...x, te: score(test, x.r.map((k) => COND[k])) }));
console.log('Règle | apprentissage (trades, moyenne, réussite) | TEST (trades, moyenne, réussite)');
for (const x of res) console.log(`${x.r.join(' + ')} | ${x.tr.n}, ${(x.tr.avg * 100).toFixed(1)} %, ${(x.tr.win * 100).toFixed(0)} % | ${x.te.n}, ${x.te.n ? (x.te.avg * 100).toFixed(1) + ' %' : '-'}, ${x.te.n ? (x.te.win * 100).toFixed(0) + ' %' : '-'}`);
const best = res.filter((x) => x.te.n >= 20 && x.te.avg > 0).sort((a, b) => b.te.avg - a.te.avg)[0];
console.log(`\nMeilleure règle confirmée sur le test : ${best ? best.r.join(' + ') + ` (${(best.te.avg * 100).toFixed(1)} % par trade sur ${best.te.n} tokens jamais vus)` : 'aucune ne reste positive sur le test'}`);
fs.writeFileSync(path.join(__dirname, 'cerveau-strategie.json'), JSON.stringify({ date: new Date().toISOString(), n: obs.length, base, res, best: best ? best.r : null }, null, 1));
