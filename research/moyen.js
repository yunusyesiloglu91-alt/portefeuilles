// Cherche des portefeuilles « moyen terme » vraiment rentables : on prend tous les portefeuilles candidats déjà repérés
// (gros détenteurs « personnes » de memecoins survivants, research/longterme.json), on mesure leurs VRAIS résultats
// (bénéfice par token, durée de détention, régularité) et on garde ceux qui gagnent, tradent à un rythme humain,
// détiennent entre 10 minutes et 12 heures, et sont encore actifs.
const fs = require('fs');
const path = require('path');
const { analyse } = require('./analyse-wallet.js');

(async () => {
  const lt = JSON.parse(fs.readFileSync(path.join(__dirname, 'longterme.json'), 'utf8'));
  const extra = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const cands = [...new Set([...extra, ...lt.res.filter((r) => r.txPerDay >= 2 && r.txPerDay <= 60 && r.lastActiveDays <= 1).sort((a, b) => a.txPerDay - b.txPerDay).map((r) => r.wallet)])].slice(0, 9);
  console.log(`${cands.length} portefeuilles à analyser (≈ 120 transactions chacun)…`);
  const out = [];
  for (const w of cands) {
    const r = await analyse(w, 120).catch(() => null);
    if (!r) continue;
    out.push(r);
    console.log(`${w.slice(0, 6)}… | ${r.transactions} tx en ${r.jours} j | fermés ${r.fermes} gagnés ${r.gagnes} | bénéfice ${r.beneficeSol} SOL (sans top 3 : ${r.sansTop3Sol}) | détention médiane ${r.detentionMedianeMin} min | ouverts ${r.ouverts}`);
    fs.writeFileSync(path.join(__dirname, 'moyen.json'), JSON.stringify({ date: new Date().toISOString(), analyses: out }, null, 1));
  }
  const good = out.filter((r) => r.fermes >= 3 && r.gagnes / r.fermes >= 0.5 && r.beneficeSol > 0.1 && r.sansTop3Sol >= 0 && r.detentionMedianeMin >= 10 && r.detentionMedianeMin <= 720 && r.txParJour <= 120 && r.dernierMouvementH <= 48)
    .sort((a, b) => b.sansTop3Sol - a.sansTop3Sol).slice(0, 4);
  console.log(`\nMoyen terme retenus : ${good.map((r) => r.wallet).join(', ') || 'aucun'}`);
  fs.writeFileSync(path.join(__dirname, 'moyen.json'), JSON.stringify({ date: new Date().toISOString(), analyses: out, retenus: good }, null, 1));
})();
