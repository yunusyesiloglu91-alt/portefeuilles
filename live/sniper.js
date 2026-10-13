// Laboratoire de sniping (argent virtuel) : 4 stratégies testées en parallèle sur les vrais lancements Solana.
// 5 $ par trade, 100 $ par stratégie. Sources : DexScreener (nouveaux tokens, réseaux sociaux, prix),
// GeckoTerminal (nouveaux pools), RugCheck (part du créateur, autorisations, gros détenteurs, insiders).
const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
const RC = 'https://api.rugcheck.xyz/v1';
const H = 3600000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILTER_BASE = { maxAgeH: 3, minMcap: 30e3, maxMcap: 300e3, minLiq: 8e3 };
const VARIANTS = {
  qualite: { name: '🎯 Sniper qualité', quality: true, tp1: 1, tp1Part: 0.5, trail: 0.3, sl: 0.35, maxH: 24, chosen: true },
  eclair: { name: '⚡ Sniper éclair', quality: true, tp1: 0.5, tp1Part: 1, sl: 0.25, maxH: 6 },
  moonshot: { name: '🚀 Moonshot', quality: true, tp1: 4, tp1Part: 1, sl: 0.5, maxH: 72 },
  temoin: { name: '🎲 Sans filtre (témoin)', quality: false, tp1: 1, tp1Part: 1, sl: 0.35, maxH: 24 },
};
const STAKE = 5, CAPITAL = 100, COST = 0.02, MAX_OPEN = 15; // 2 % par ordre : frais + glissement sur tokens très jeunes

async function json(url) {
  for (let k = 0; k < 2; k++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.ok) return await r.json();
      if (r.status === 429) await sleep(5000);
    } catch { /* réseau */ }
    await sleep(1000);
  }
  return null;
}

// Analyse RugCheck réduite à ce qui compte
async function rugcheck(addr) {
  const r = await json(`${RC}/tokens/${addr}/report`);
  if (!r) return null;
  const supply = r.token && r.token.supply ? r.token.supply : null; // même unité brute que creatorBalance
  const pools = new Set((r.markets || []).flatMap((m) => [m.pubkey, m.liquidityA, m.liquidityB, m.liquidityAAccount, m.liquidityBAccount].filter(Boolean)));
  const holders = (r.topHolders || []).filter((h) => !pools.has(h.address) && !pools.has(h.owner));
  const top10 = holders.slice(0, 10).reduce((a, h) => a + (h.pct || 0), 0);
  return {
    creatorPct: supply && r.creatorBalance ? (r.creatorBalance / supply) * 100 : 0,
    mintAuth: !!r.mintAuthority, freezeAuth: !!r.freezeAuthority,
    top10, insiders: r.graphInsidersDetected || 0, holders: r.totalHolders || 0,
    danger: (r.risks || []).filter((x) => x.level === 'danger').map((x) => x.name),
    rugged: !!r.rugged,
  };
}

function qualityOk(c) {
  const q = c.rc;
  if (!q) return { ok: false, why: 'analyse RugCheck indisponible' };
  if (!c.twitter) return { ok: false, why: 'pas de Twitter' };
  if (q.rugged) return { ok: false, why: 'rug détecté' };
  if (q.mintAuth || q.freezeAuth) return { ok: false, why: 'le créateur peut encore imprimer ou bloquer' };
  if (q.creatorPct > 5) return { ok: false, why: `créateur détient ${q.creatorPct.toFixed(0)} %` };
  if (q.top10 > 30) return { ok: false, why: `10 plus gros portefeuilles : ${q.top10.toFixed(0)} %` };
  if (q.insiders > 0) return { ok: false, why: 'réseau d’insiders détecté' };
  if (q.danger.length) return { ok: false, why: q.danger[0] };
  if (q.holders < 100) return { ok: false, why: 'moins de 100 détenteurs' };
  if (!(c.buys1h > c.sells1h)) return { ok: false, why: 'plus de ventes que d’achats' };
  return { ok: true, why: 'tous les critères' };
}

async function runSniper(st, now) {
  if (!st.sniper) {
    st.sniper = { start: now, variants: {}, seen: {}, watch: [] };
    for (const id in VARIANTS) st.sniper.variants[id] = { cash: CAPITAL, positions: [], trades: [], history: [] };
  }
  const S = st.sniper;
  const notes = [];

  // 1. Prix des positions ouvertes (DexScreener, par paire achetée)
  const open = Object.values(S.variants).flatMap((v) => v.positions);
  const priceOf = {};
  const addrs = [...new Set(open.map((p) => p.addr))];
  for (let k = 0; k < addrs.length; k += 30) {
    const pairs = (await json(`${DS}/tokens/v1/solana/${addrs.slice(k, k + 30).join(',')}`)) || [];
    for (const p of pairs) if (p.pairAddress && +p.priceUsd > 0) priceOf[p.pairAddress] = +p.priceUsd;
  }

  // 2. Sorties
  for (const [id, v] of Object.entries(S.variants)) {
    const V = VARIANTS[id];
    for (const p of [...v.positions]) {
      const price = priceOf[p.pair];
      if (!(price > 0)) { if (now - p.t > (V.maxH + 6) * H) { v.positions.splice(v.positions.indexOf(p), 1); v.trades.push({ t: now, side: 'vente', name: p.name, price: 0, usd: 0, ret: -1, reason: 'plus de cotation (token mort)' }); } continue; }
      p.last = price;
      p.peak = Math.max(p.peak || p.entry, price);
      const sell = (part, reason) => {
        const qty = p.qty * part;
        const usd = qty * price * (1 - COST);
        v.cash += usd;
        p.qty -= qty;
        p.realized = (p.realized || 0) + usd;
        const done = p.qty <= 1e-12 || part >= 1;
        v.trades.push({ t: now, side: 'vente', name: p.name, price, usd, ret: done ? p.realized / p.cost - 1 : usd / (p.cost * part) - 1, reason: done ? reason : `${reason} (moitié)` });
        if (done) v.positions.splice(v.positions.indexOf(p), 1);
      };
      if (price <= p.entry * (1 - V.sl) && !p.tp1Done) sell(1, `stop −${V.sl * 100} %`);
      else if (!p.tp1Done && price >= p.entry * (1 + V.tp1)) {
        if (V.tp1Part >= 1) sell(1, `objectif ×${1 + V.tp1}`);
        else { sell(V.tp1Part, `objectif ×${1 + V.tp1}`); p.tp1Done = true; }
      } else if (p.tp1Done && V.trail && price <= p.peak * (1 - V.trail)) sell(1, `stop suiveur −${V.trail * 100} % après le sommet`);
      else if (now - p.t >= V.maxH * H) sell(1, `${V.maxH} h écoulées`);
    }
  }

  // 3. Nouveaux tokens : profils DexScreener récents + nouveaux pools GeckoTerminal
  const fresh = new Map();
  for (const list of [await json(`${DS}/token-profiles/latest/v1`), await json(`${DS}/token-boosts/latest/v1`)]) {
    for (const x of list || []) if (x.chainId === 'solana') fresh.set(x.tokenAddress, { twitter: (x.links || []).some((l) => l.type === 'twitter' || /x\.com|twitter\.com/.test(l.url || '')) });
  }
  const np = await json(`${GT}/networks/solana/new_pools?page=1&include=base_token`);
  for (const p of (np && np.data) || []) {
    const a = p.relationships.base_token.data.id.replace('solana_', '');
    if (!fresh.has(a)) fresh.set(a, { twitter: null });
  }
  const list = [...fresh.keys()].filter((a) => !S.seen[a] || now - S.seen[a].t < 3 * H);
  const cands = [];
  for (let k = 0; k < list.length; k += 30) {
    const pairs = (await json(`${DS}/tokens/v1/solana/${list.slice(k, k + 30).join(',')}`)) || [];
    const best = {};
    for (const p of pairs) {
      const a = p.baseToken && p.baseToken.address;
      if (a && (!best[a] || ((p.liquidity && p.liquidity.usd) || 0) > ((best[a].liquidity && best[a].liquidity.usd) || 0))) best[a] = p;
    }
    for (const [a, p] of Object.entries(best)) {
      const tw = fresh.get(a).twitter ?? ((p.info && p.info.socials) || []).some((s) => s.type === 'twitter');
      cands.push({
        addr: a, pair: p.pairAddress, name: p.baseToken.symbol || p.baseToken.name, price: +p.priceUsd,
        mcap: p.marketCap || p.fdv || 0, liq: (p.liquidity && p.liquidity.usd) || 0, ageH: (now - p.pairCreatedAt) / H,
        buys1h: (p.txns && p.txns.h1 && p.txns.h1.buys) || 0, sells1h: (p.txns && p.txns.h1 && p.txns.h1.sells) || 0,
        twitter: tw || ((p.info && p.info.socials) || []).some((s) => s.type === 'twitter'),
      });
    }
  }
  const base = cands.filter((c) => c.ageH <= FILTER_BASE.maxAgeH && c.mcap >= FILTER_BASE.minMcap && c.mcap <= FILTER_BASE.maxMcap && c.liq >= FILTER_BASE.minLiq && c.price > 0);

  // 4. Analyse RugCheck (une fois par token, max 8 par passage)
  let checks = 0;
  for (const c of base) {
    const s = S.seen[c.addr];
    if (s && s.rc !== undefined) { c.rc = s.rc; continue; }
    if (checks >= 8) continue;
    checks++;
    c.rc = await rugcheck(c.addr);
    S.seen[c.addr] = { t: now, rc: c.rc };
    await sleep(800);
  }
  for (const c of base) if (!S.seen[c.addr]) S.seen[c.addr] = { t: now, rc: c.rc };
  for (const a in S.seen) if (now - S.seen[a].t > 24 * H) delete S.seen[a];

  // 5. Entrées
  for (const c of base) {
    c.q = qualityOk(c);
    for (const [id, v] of Object.entries(S.variants)) {
      const V = VARIANTS[id];
      if (V.quality && !c.q.ok) continue;
      if (v.positions.length >= MAX_OPEN || v.cash < STAKE) continue;
      if (v.positions.some((p) => p.addr === c.addr) || v.trades.some((t) => t.name === c.name && t.side === 'achat' && now - t.t < 24 * H)) continue;
      v.cash -= STAKE;
      v.positions.push({ name: c.name, addr: c.addr, pair: c.pair, t: now, entry: c.price, last: c.price, peak: c.price, qty: (STAKE * (1 - COST)) / c.price, cost: STAKE });
      v.trades.push({ t: now, side: 'achat', name: c.name, price: c.price, usd: STAKE, reason: `${Math.round(c.ageH * 60)} min, ${Math.round(c.mcap / 1e3)} k$` + (c.rc ? `, créateur ${c.rc.creatorPct.toFixed(1)} %, top 10 ${c.rc.top10.toFixed(0)} %` : '') });
    }
  }
  S.watch = base.slice(0, 8).map((c) => ({ name: c.name, ageMin: Math.round(c.ageH * 60), mcap: c.mcap, twitter: c.twitter, ok: c.q.ok, why: c.q.why }));

  // 6. Valeurs
  for (const v of Object.values(S.variants)) {
    const val = v.cash + v.positions.reduce((a, p) => a + p.qty * (p.last || p.entry), 0);
    v.history.push([now, +val.toFixed(2)]);
    if (v.history.length > 3000) v.history = v.history.filter((_, i) => i % 2 === 0);
    v.trades = v.trades.slice(-300);
  }
  if (!base.length) notes.push('sniper : aucun lancement dans les critères à ce passage');
  return notes;
}

module.exports = { runSniper, VARIANTS, CAPITAL };
