// Règles memecoin partagées par le scanner (navigateur) et le robot (Node).
// Calibrées sur meme/analyze.js (memecoins lancés entre avril et octobre 2026) :
//  - signaux défavorables stables : rotation du volume > 20 %/jour, +150 % en 7 j, capitalisation 1-3 M$, moins de 7 jours ;
//  - signaux "moins mauvais" : token au-dessus de 10 M$, âgé de plus de 14 jours, rotation < 20 %, qui fait un nouveau record ;
//  - "Profil prudent" : seule stratégie proche de l'équilibre sur la période de test (−3 % quand l'indice memecoin faisait −68 %),
//    mais avec seulement 10 trades : rien n'est prouvé. Le robot reste en argent virtuel.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MemeRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAJORS = new Set([
    'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
  ]);

  const PARAMS = {
    cost: 0.01, // 1 % par ordre (frais DEX + glissement)
    maxPositions: 5, cooldownDays: 3,
    // Profil prudent
    minMcap: 10e6, maxMcap: 100e6, minLiq: 100e3, minVol: 100e3, minAgeDays: 14, maxTurnover: 0.2, maxR7: 1.5,
    takeProfit: 0.5, stopLoss: 0.3, holdDays: 14,
  };

  const eligible = (c) => c.mcap >= 1e6 && c.mcap <= PARAMS.maxMcap && c.liq >= 50e3 && c.vol24 >= PARAMS.minVol;

  // Signaux de risque
  function risks(c) {
    const r = [];
    const turnover = c.mcap ? c.vol24 / c.mcap : 0;
    if (turnover > 0.5) r.push(`rotation ${Math.round(turnover * 100)} %/j : profil des tokens qui s'effondrent`);
    else if (turnover > 0.2) r.push(`rotation élevée (${Math.round(turnover * 100)} %/j)`);
    if (c.r7 > 1.5) r.push('déjà +150 % sur 7 j');
    else if (c.ch24 > 1) r.push('déjà +100 % sur 24 h');
    if (c.ageDays < 7) r.push('moins de 7 jours');
    if (c.mcap < 3e6) r.push('moins de 3 M$');
    if (c.liq && c.mcap && c.liq / c.mcap < 0.03) r.push('liquidité très faible');
    if (c.socials && !c.socials.length && !c.website) r.push('ni site ni réseaux sociaux');
    if (c.sellers24 && c.buyers24 && c.sellers24 > c.buyers24 * 1.5) r.push('bien plus de vendeurs que d’acheteurs');
    if (c.boosted) r.push('mise en avant payante');
    return r;
  }

  // Note sur 100 : plus elle est haute, plus le token ressemble aux profils "moins mauvais" de l'analyse
  function score(c) {
    const reasons = [];
    const turnover = c.mcap ? c.vol24 / c.mcap : 0;
    let s = 50;
    if (c.mcap >= 30e6) { s += 10; reasons.push('≥ 30 M$'); } else if (c.mcap >= 10e6) { s += 5; reasons.push('≥ 10 M$'); } else if (c.mcap < 3e6) s -= 15;
    if (c.ageDays >= 60) { s += 10; reasons.push('plus de 60 j'); } else if (c.ageDays >= 14) { s += 5; reasons.push('plus de 14 j'); } else if (c.ageDays < 7) s -= 15;
    if (turnover < 0.05) { s += 10; reasons.push('volume calme'); } else if (turnover < 0.2) s += 5; else if (turnover > 0.5) s -= 20; else s -= 10;
    if (c.dd != null) {
      if (c.dd >= -0.05) { s += 10; reasons.push('à son record'); } else if (c.dd < -0.5) s -= 10;
    }
    if (c.r7 > 1.5 || c.ch24 > 1) s -= 15;
    const rk = risks(c);
    s -= rk.filter((x) => /réseaux|vendeurs|liquidité|payante/.test(x)).length * 8;
    return { score: Math.max(0, Math.min(100, Math.round(s))), reasons, risks: rk };
  }

  // Entrée du robot (profil prudent) : nécessite les indicateurs quotidiens (r7, dd, newHigh)
  function entry(c) {
    const turnover = c.mcap ? c.vol24 / c.mcap : 1;
    return c.mcap >= PARAMS.minMcap && c.mcap <= PARAMS.maxMcap && c.liq >= PARAMS.minLiq && c.vol24 >= PARAMS.minVol &&
      c.ageDays >= PARAMS.minAgeDays && turnover < PARAMS.maxTurnover && c.newHigh === true && !(c.r7 > PARAMS.maxR7) &&
      !risks(c).some((x) => /réseaux|vendeurs|liquidité/.test(x));
  }

  // Sortie : objectif (ordre limite), stop de protection, durée maximale
  function exit(p, price, now) {
    if (price >= p.entry * (1 + PARAMS.takeProfit)) return `objectif +${PARAMS.takeProfit * 100} %`;
    if (price <= p.entry * (1 - PARAMS.stopLoss)) return `stop −${PARAMS.stopLoss * 100} %`;
    if (now - p.t >= PARAMS.holdDays * 86400000) return `${PARAMS.holdDays} jours écoulés`;
    return null;
  }

  return { PARAMS, MAJORS, eligible, risks, score, entry, exit };
});
