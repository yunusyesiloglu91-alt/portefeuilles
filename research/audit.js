// Contrôle des stratégies à prix réels : comptes, frais, ventes estimées, et sensibilité aux frais de priorité.
const fs = require('fs');
const path = require('path');
const st = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'live', 'sniper-rt-state.json'), 'utf8'));
const sol = +process.argv[2] || 106;
const NET_SOL = 0.000205; // frais réseau + priorité comptés aujourd'hui par transaction

for (const id of ['expert', 'vague', 'actu']) {
  const v = st.variants[id];
  if (!v) continue;
  const buys = v.trades.filter((t) => t.side === 'achat');
  const sells = v.trades.filter((t) => t.side === 'vente');
  const spent = buys.reduce((a, t) => a + t.usd, 0);
  const got = sells.reduce((a, t) => a + t.usd, 0);
  const openCost = v.positions.reduce((a, p) => a + p.cost, 0);
  const openVal = v.positions.reduce((a, p) => a + p.qty * (p.last || p.entry), 0);
  // Contrôle des comptes : cash = 100 − achats + ventes (− frais des ordres ratés)
  const expectedCash = 100 - spent + got;
  const gap = v.cash - expectedCash;
  const txs = buys.length + sells.length;
  const estim = sells.filter((t) => /estimé/.test(t.reason || '')).length;
  // Résultat par token (achat + toutes ses ventes)
  const byMint = {};
  for (const t of v.trades) {
    const m = (byMint[t.mint] = byMint[t.mint] || { name: t.name, cost: 0, got: 0, sells: 0, done: false });
    if (t.side === 'achat') m.cost += t.usd;
    else { m.got += t.usd; m.sells++; if (!/palier|moitié/.test(t.reason || '')) m.done = true; }
  }
  const closed = Object.values(byMint).filter((m) => m.done && m.cost > 0);
  const pnl = closed.map((m) => m.got - m.cost);
  const win = pnl.filter((x) => x > 0).length;
  const total = pnl.reduce((a, x) => a + x, 0);
  const best = pnl.slice().sort((a, b) => b - a);
  console.log(`\n=== ${id} ===`);
  console.log(`Valeur ${(v.cash + openVal).toFixed(2)} $ (cash ${v.cash.toFixed(2)} + ${v.positions.length} positions ${openVal.toFixed(2)})`);
  console.log(`Contrôle des comptes : écart ${gap.toFixed(2)} $ (${Math.abs(gap) < 0.5 ? 'OK' : 'À VÉRIFIER'}) · ordres ratés ${v.failed || 0}`);
  console.log(`Trades fermés ${closed.length} · gagnés ${win} · gain réalisé ${total.toFixed(2)} $ · sans le meilleur ${(total - (best[0] || 0)).toFixed(2)} $ · sans les 3 meilleurs ${(total - best.slice(0, 3).reduce((a, x) => a + x, 0)).toFixed(2)} $`);
  console.log(`Transactions ${txs} (dont ${sells.length} ventes) · ventes au prix estimé ${estim}`);
  console.log(`Frais comptés : ${(v.fees || 0).toFixed(2)} $ (dont réseau ${(txs * NET_SOL * sol).toFixed(2)} $)`);
  for (const fee of [0.001, 0.003]) {
    const extra = txs * (fee - NET_SOL) * sol;
    console.log(`  si frais de priorité ${fee} SOL par transaction : −${extra.toFixed(2)} $ → valeur ${(v.cash + openVal - extra).toFixed(2)} $`);
  }
}
