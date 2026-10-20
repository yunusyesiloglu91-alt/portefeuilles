// Remise à 100 $ des stratégies actives et application des baleines trouvées par gmgn-baleines.js
const fs = require('fs');
const path = require('path');
const sf = path.join(__dirname, '..', 'live', 'sniper-rt-state.json');
const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
fs.writeFileSync(sf.replace('.json', `.backup-${new Date().toISOString().slice(0, 13).replace(/[:T]/g, '-')}.json`), JSON.stringify(st));
const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'gmgn-baleines.json'), 'utf8'));
const list = [];
for (const g of ['court', 'moyen', 'long']) for (const r of b[g]) list.push({ wallet: r.wallet, group: g, source: 'baleines ' + b.date.slice(0, 10) });
if (list.length < 5) throw new Error('trop peu de baleines trouvées : ' + list.length);
st.copyWallets = list;
for (const id of ['copieCourt', 'copieMoyen', 'copieLong', 'breakout', 'consensus']) {
  st.variants[id] = { cash: 100, positions: [], trades: [], history: [], fees: 0, pendingMints: [] };
}
fs.writeFileSync(sf, JSON.stringify(st));
console.log(list.map((w) => w.group + ':' + w.wallet.slice(0, 8)).join(' '));
