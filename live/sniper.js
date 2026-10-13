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
  qualite: { name: '2️⃣ Assoupli', quality: true, tp1: 1, tp1Part: 0.5, trail: 0.3, sl: 0.35, maxH: 24, chosen: true },
  eclair: { name: '⚡ Sniper éclair', quality: true, tp1: 0.5, tp1Part: 1, sl: 0.25, maxH: 6 },
  moonshot: { name: '🚀 Moonshot', quality: true, tp1: 4, tp1Part: 1, sl: 0.5, maxH: 72 },
  origine: { name: '1️⃣ Recette origine', quality: true, origine: true, tp1: 1, tp1Part: 0.5, trail: 0.3, sl: 0.35, maxH: 24 },
  tres: { name: '3️⃣ Très assoupli', quality: true, tres: true, tp1: 1, tp1Part: 0.5, trail: 0.3, sl: 0.35, maxH: 24 },
  temoin: { name: '🎲 Sans filtre (témoin)', quality: false, tp1: 1, tp1Part: 1, sl: 0.35, maxH: 24 },
  cerveau: { name: '🧠 Cerveau', quality: true, brain: true, tp1: 0.5, tp1Part: 0.5, trail: 0.25, sl: 0.3, maxH: 24 },
};
const Brain = require('./cerveau.js');
const STAKE = 5, CAPITAL = 100, MAX_OPEN = 15;
// Frais réalistes d'un ordre de 5 $ sur Solana : outil de trading 1 %, DEX 0,3 %, glissement 0,5 %, réseau + priorité 0,03 $
const FEES = { tool: 0.01, dex: 0.003, slip: 0.005, fixed: 0.03 };
const COST = FEES.tool + FEES.dex + FEES.slip;

// Budget d'appels par minute pour chaque site gratuit, gardé sous leurs limites officielles.
// Si le budget est épuisé ou si le site répond « trop de requêtes », on saute l'appel au lieu d'attendre.
const BUDGET = [
  [/dexscreener\.com\/(token-profiles|token-boosts)/, 50],
  [/dexscreener\.com/, 240],
  [/geckoterminal\.com/, 20],
  [/rugcheck\.xyz/, 40],
];
const calls = {}, pauseUntil = {};
function allowed(url) {
  const i = BUDGET.findIndex(([re]) => re.test(url));
  if (i < 0) return { ok: true };
  const now = Date.now();
  if (pauseUntil[i] > now) return { ok: false };
  calls[i] = (calls[i] || []).filter((t) => now - t < 60000);
  if (calls[i].length >= BUDGET[i][1]) return { ok: false };
  calls[i].push(now);
  return { ok: true, i };
}
async function json(url) {
  const a = allowed(url);
  if (!a.ok) return null;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    if (r.ok) return await r.json();
    if (r.status === 429 && a.i != null) pauseUntil[a.i] = Date.now() + 15000; // le site demande de ralentir : pause de 15 s pour lui seul
  } catch { /* réseau */ }
  return null;
}
const API_NAMES = ['DexScreener (nouveautés)', 'DexScreener (prix)', 'GeckoTerminal', 'RugCheck'];
const apiUsage = () => Object.fromEntries(BUDGET.map(([, max], i) => [API_NAMES[i], { used: (calls[i] || []).filter((t) => Date.now() - t < 60000).length, max, paused: pauseUntil[i] > Date.now() }]));

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

// Critères de sélection. ORIGINE = la recette qui a trouvé SEALS, ROUTE et SIM (sauvegardée, ne pas modifier).
// SOUPLE = version assouplie en test depuis le 13/10/2026 19 h 15 (argent virtuel). Retour arrière : CRITERES_ACTIFS = 'origine'.
const CRITERES = {
  origine: { twitter: true, creatorMax: 5, top10Max: 30, insidersMax: 0, holdersMin: 100, buyRatioMin: 1 },
  souple: { twitter: false, creatorMax: 10, top10Max: 40, insidersMax: 2, holdersMin: 50, buyRatioMin: 0.9 },
  // TRÈS SOUPLE = encore plus permissif (test du 13/10/2026 19 h 35)
  tres: { twitter: false, creatorMax: 15, top10Max: 50, insidersMax: 5, holdersMin: 25, buyRatioMin: 0.7 },
};
const CRITERES_ACTIFS = 'souple';

function qualityOk(c, K = CRITERES[CRITERES_ACTIFS]) {
  const q = c.rc;
  if (!q) return { ok: false, why: 'analyse RugCheck indisponible' };
  if (K.twitter && !c.twitter) return { ok: false, why: 'pas de Twitter' };
  if (q.rugged) return { ok: false, why: 'rug détecté' };
  if (q.mintAuth || q.freezeAuth) return { ok: false, why: 'le créateur peut encore imprimer ou bloquer' };
  if (q.creatorPct > K.creatorMax) return { ok: false, why: `créateur détient ${q.creatorPct.toFixed(0)} %` };
  if (q.top10 > K.top10Max) return { ok: false, why: `10 plus gros portefeuilles : ${q.top10.toFixed(0)} %` };
  if (q.insiders > K.insidersMax) return { ok: false, why: 'réseau d’insiders détecté' };
  if (q.danger.length) return { ok: false, why: q.danger[0] };
  if (q.holders < K.holdersMin) return { ok: false, why: `moins de ${K.holdersMin} détenteurs` };
  if (!(c.buys1h > c.sells1h * K.buyRatioMin) || !c.buys1h) return { ok: false, why: 'plus de ventes que d’achats' };
  return { ok: true, why: 'tous les critères' };
}

async function runSniper(st, now, opts = {}) {
  if (!st.sniper) {
    st.sniper = { start: now, variants: {}, seen: {}, watch: [] };
    for (const id in VARIANTS) st.sniper.variants[id] = { cash: CAPITAL, positions: [], trades: [], history: [] };
  }
  const S = st.sniper;
  for (const id in VARIANTS) if (!S.variants[id]) S.variants[id] = { cash: CAPITAL, positions: [], trades: [], history: [], fees: 0 };
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
    // La stratégie Cerveau utilise la sortie qu'il a apprise lui-même (dès 50 tokens suivis 24 h)
    const ex = S.brain && S.brain.exit;
    const V = VARIANTS[id].brain && ex && ex.avg > -0.05 ? { ...VARIANTS[id], tp1: ex.tp, sl: ex.sl, tp1Part: 1, trail: 0 } : VARIANTS[id];
    for (const p of [...v.positions]) {
      const price = priceOf[p.pair];
      if (!(price > 0)) { if (now - p.t > (V.maxH + 6) * H) { v.positions.splice(v.positions.indexOf(p), 1); v.trades.push({ t: now, side: 'vente', name: p.name, price: 0, usd: 0, ret: -1, reason: 'plus de cotation (token mort)' }); } continue; }
      p.last = price;
      p.peak = Math.max(p.peak || p.entry, price);
      p.low = Math.min(p.low || p.entry, price);
      const sell = (part, reason) => {
        const qty = p.qty * part;
        const gross = qty * price;
        const usd = Math.max(0, gross * (1 - COST) - FEES.fixed);
        v.fees = (v.fees || 0) + (gross - usd);
        v.cash += usd;
        p.qty -= qty;
        p.realized = (p.realized || 0) + usd;
        const done = p.qty <= 1e-12 || part >= 1;
        v.trades.push({ t: now, side: 'vente', name: p.name, addr: p.addr, mcap: p.f && p.f.mcap ? p.f.mcap * (price / p.entry) : undefined, done, price, usd, ret: done ? p.realized / p.cost - 1 : usd / (p.cost * part) - 1, reason: done ? reason : `${reason} (moitié)`,
          ...(done ? { f: p.f, held: now - p.t, peak: (p.peak || p.entry) / p.entry, low: (p.low || p.entry) / p.entry } : {}) });
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

  if (opts.exitsOnly) return notes; // passage rapide : seulement les prix et les sorties

  // 3. Nouveaux tokens : profils DexScreener récents + nouveaux pools GeckoTerminal
  const fresh = new Map();
  for (const list of [await json(`${DS}/token-profiles/latest/v1`), await json(`${DS}/token-boosts/latest/v1`), await json(`${DS}/token-boosts/top/v1`)]) {
    for (const x of list || []) if (x.chainId === 'solana') fresh.set(x.tokenAddress, { twitter: (x.links || []).some((l) => l.type === 'twitter' || /x\.com|twitter\.com/.test(l.url || '')) });
  }
  // GeckoTerminal limite à 30 appels/min : nouveaux pools au plus toutes les 20 s (le robot Prudent l'utilise aussi)
  // GeckoTerminal à tour de rôle (une requête toutes les 12 s) : nouveaux pools p. 1 et 2, tendances 1 h
  const GT_PAGES = ['new_pools?page=1', 'new_pools?page=2', 'trending_pools?duration=1h&page=1', 'trending_pools?duration=5m&page=1'];
  S.gtNp = S.gtNp || {};
  if (!S.gtT || now - S.gtT >= 12000) {
    S.gtT = now;
    S.gtI = ((S.gtI || 0) + 1) % GT_PAGES.length;
    const r = await json(`${GT}/networks/solana/${GT_PAGES[S.gtI]}&include=base_token`);
    if (r) S.gtNp[S.gtI] = r;
  }
  const np = { data: Object.values(S.gtNp).flatMap((r) => r.data || []) };
  for (const x of opts.pushed || []) if (!fresh.has(x.mint)) fresh.set(x.mint, { twitter: null });
  for (const p of (np && np.data) || []) {
    const a = p.relationships.base_token.data.id.replace('solana_', '');
    if (!fresh.has(a)) fresh.set(a, { twitter: null });
  }
  S.pool = S.pool || {};
  for (const [a, x] of fresh) if (!S.pool[a]) S.pool[a] = { t: now, tw: x.twitter, c: 0 };
  for (const a in S.pool) if (now - S.pool[a].t > 3 * H) delete S.pool[a];
  // 90 tokens par passage (3 appels), les moins récemment examinés d'abord : toute la mémoire est revue en ~1 min
  const list = Object.entries(S.pool).sort((x, y) => x[1].c - y[1].c).slice(0, 90).map(([a]) => a);
  for (const a of list) S.pool[a].c = now;
  const cands = [];
  for (let k = 0; k < list.length; k += 30) {
    const pairs = (await json(`${DS}/tokens/v1/solana/${list.slice(k, k + 30).join(',')}`)) || [];
    const best = {};
    for (const p of pairs) {
      const a = p.baseToken && p.baseToken.address;
      if (a && (!best[a] || ((p.liquidity && p.liquidity.usd) || 0) > ((best[a].liquidity && best[a].liquidity.usd) || 0))) best[a] = p;
    }
    for (const [a, p] of Object.entries(best)) {
      const tw = (S.pool[a] && S.pool[a].tw) ?? ((p.info && p.info.socials) || []).some((s) => s.type === 'twitter');
      cands.push({
        addr: a, pair: p.pairAddress, name: p.baseToken.symbol || p.baseToken.name, price: +p.priceUsd,
        mcap: p.marketCap || p.fdv || 0, liq: (p.liquidity && p.liquidity.usd) || 0, ageH: (now - p.pairCreatedAt) / H,
        buys1h: (p.txns && p.txns.h1 && p.txns.h1.buys) || 0, sells1h: (p.txns && p.txns.h1 && p.txns.h1.sells) || 0,
        twitter: tw || ((p.info && p.info.socials) || []).some((s) => s.type === 'twitter'),
      });
    }
  }
  const base = cands.filter((c) => c.ageH <= FILTER_BASE.maxAgeH && c.mcap >= FILTER_BASE.minMcap && c.mcap <= FILTER_BASE.maxMcap && c.liq >= FILTER_BASE.minLiq && c.price > 0);

  // 4. Analyse RugCheck (une fois par token, jusqu'à 6 en parallèle)
  const todo = [];
  for (const c of base) {
    const s = S.seen[c.addr];
    if (s && s.rc) c.rc = s.rc;
    else if (todo.length < 6) todo.push(c);
  }
  await Promise.all(todo.map(async (c) => { c.rc = await rugcheck(c.addr); if (c.rc) S.seen[c.addr] = { t: (S.seen[c.addr] || {}).t || now, rc: c.rc }; }));
  for (const c of base) if (!S.seen[c.addr]) S.seen[c.addr] = { t: now, rc: null };
  for (const a in S.seen) if (now - S.seen[a].t > 24 * H) delete S.seen[a];

  // 5. Cerveau : mémorise chaque lancement, suit les anciens, met à jour les leçons
  let B = null;
  try {
    // Le cerveau observe large (tous les jeunes tokens cotés), pas seulement ceux qui passent les filtres : il apprend plus vite
    Brain.observe(cands.filter((c) => c.ageH <= 6 && c.mcap >= 10e3 && c.mcap <= 1e6 && c.liq >= 3e3 && c.price > 0), now);
    // Suivi du cerveau et écriture du coffre Obsidian : une fois par minute suffit
    if (!S.brainT || now - S.brainT >= 60000 || !S.brainCache) {
      S.brainT = now;
      await Brain.track(now, json);
      S.brainCache = Brain.stats(2 * Brain.perOrder(FEES));
      Brain.writeVault(S.brainCache, S, FEES, now);
    }
    B = S.brainCache;
    S.brain = Brain.summary(B);
    // Courbe d'apprentissage : un point toutes les 5 min (tokens appris, réussite, valeur de la stratégie Cerveau)
    S.brainHist = S.brainHist || [];
    const lastH = S.brainHist[S.brainHist.length - 1];
    if (!lastH || now - lastH[0] >= 300000) {
      const cv = S.variants.cerveau;
      S.brainHist.push([now, S.brain.n, S.brain.rate, cv ? +(cv.cash + cv.positions.reduce((a, p) => a + p.qty * (p.last || p.entry), 0)).toFixed(2) : 100]);
      if (S.brainHist.length > 2000) S.brainHist = S.brainHist.filter((_, i) => i % 2 === 0);
    }
  } catch (e) { notes.push(`cerveau : ${e.message}`); }
  S.fees = { ...FEES, perOrder: Brain.perOrder(FEES) };

  // 6. Entrées
  for (const c of base) {
    c.q = qualityOk(c);
    c.q0 = qualityOk(c, CRITERES.origine);
    c.q2 = qualityOk(c, CRITERES.tres);
    const sc = Brain.score(c, B, now);
    const safe = c.rc && !c.rc.rugged && !c.rc.mintAuth && !c.rc.freezeAuth && !c.rc.danger.length;
    c.brainOk = sc ? safe && sc.mult >= 1.5 : c.q.ok;
    c.brainWhy = sc ? `note cerveau ×${sc.mult.toFixed(1)}${sc.why.length ? ' : ' + sc.why.slice(0, 2).join(', ') : ''}` : '';
    for (const [id, v] of Object.entries(S.variants)) {
      const V = VARIANTS[id];
      if (V.brain ? !c.brainOk : V.origine ? !c.q0.ok : V.tres ? !c.q2.ok : V.quality && !c.q.ok) continue;
      if (v.positions.length >= MAX_OPEN || v.cash < STAKE) continue;
      if (v.positions.some((p) => p.addr === c.addr) || v.trades.some((t) => t.name === c.name && t.side === 'achat' && now - t.t < 24 * H)) continue;
      v.cash -= STAKE;
      const net = STAKE * (1 - COST) - FEES.fixed;
      v.fees = (v.fees || 0) + (STAKE - net);
      const f = { ageMin: Math.round(c.ageH * 60), mcap: c.mcap, liq: c.liq, buys: c.buys1h, sells: c.sells1h, twitter: !!c.twitter,
        creatorPct: c.rc ? c.rc.creatorPct : null, top10: c.rc ? c.rc.top10 : null, holders: c.rc ? c.rc.holders : null, brain: V.brain ? c.brainWhy || 'filtres Qualité' : undefined };
      v.positions.push({ name: c.name, addr: c.addr, pair: c.pair, t: now, entry: c.price, last: c.price, peak: c.price, qty: net / c.price, cost: STAKE, f });
      v.trades.push({ t: now, side: 'achat', name: c.name, addr: c.addr, pair: c.pair, mcap: c.mcap, qty: net / c.price, price: c.price, usd: STAKE, reason: `${Math.round(c.ageH * 60)} min, ${Math.round(c.mcap / 1e3)} k$` + (c.rc ? `, créateur ${c.rc.creatorPct.toFixed(1)} %, top 10 ${c.rc.top10.toFixed(0)} %` : '') + (V.brain && c.brainWhy ? `, ${c.brainWhy}` : '') });
    }
  }
  S.watch = base.slice(0, 8).map((c) => ({ name: c.name, ageMin: Math.round(c.ageH * 60), mcap: c.mcap, twitter: c.twitter, ok: c.q.ok, why: c.q.why }));

  // 7. Valeurs (courbe : un point par minute)
  if (S.histT && now - S.histT < 60000) return notes;
  S.histT = now;
  for (const v of Object.values(S.variants)) {
    const val = v.cash + v.positions.reduce((a, p) => a + p.qty * (p.last || p.entry), 0);
    v.history.push([now, +val.toFixed(2)]);
    if (v.history.length > 3000) v.history = v.history.filter((_, i) => i % 2 === 0);
    v.trades = v.trades.slice(-300);
  }
  if (!base.length) notes.push('sniper : aucun lancement dans les critères à ce passage');
  return notes;
}

// Vente à la main depuis le site (bouton « Vendre ») : au dernier prix connu, mêmes frais qu'une vente du robot
function manualSell(st, id, addr) {
  const v = st.sniper && st.sniper.variants[id];
  const p = v && v.positions.find((x) => x.addr === addr);
  if (!p) return null;
  const price = p.last || p.entry;
  const gross = p.qty * price;
  const usd = Math.max(0, gross * (1 - COST) - FEES.fixed);
  v.fees = (v.fees || 0) + (gross - usd);
  v.cash += usd;
  p.realized = (p.realized || 0) + usd;
  const t = { t: Date.now(), side: 'vente', name: p.name, addr: p.addr, done: true, mcap: p.f && p.f.mcap ? p.f.mcap * (price / p.entry) : undefined, price, usd, ret: p.realized / p.cost - 1, reason: 'vendu à la main', f: p.f, held: Date.now() - p.t, peak: (p.peak || p.entry) / p.entry };
  v.trades.push(t);
  v.positions.splice(v.positions.indexOf(p), 1);
  return t;
}

module.exports = { CRITERES, CRITERES_ACTIFS, runSniper, manualSell, VARIANTS, CAPITAL, apiUsage };
