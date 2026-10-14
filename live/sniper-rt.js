// Sniper à la seconde (argent virtuel), à faire tourner en continu sur un PC.
// Flux temps réel des créations pump.fun (PumpPortal) : décision à la seconde de création,
// suivi de chaque trade des tokens détenus, sorties instantanées.
// Résultats envoyés toutes les 2 min sur la branche "sniper" du dépôt (lue par le site).
//
// Lancer : node live/sniper-rt.js      (Node 22+, GitHub CLI connecté : gh auth login)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = 'yunusyesiloglu91-alt/portefeuilles';
const BRANCH = 'sniper';
const FILE = path.join(__dirname, 'sniper-rt-state.json');
const LOG = path.join(__dirname, 'sniper-rt.log');
const WS_URL = 'wss://pumpportal.fun/api/data';
const SUPPLY = 1e9; // offre fixe des tokens pump.fun
const STAKE = 5, CAPITAL = 100, COST = 0.03, MAX_OPEN = 10;
const MIN = 60000;

const VARIANTS = {
  diplome: { name: "🎓 Diplômé + sécurité", delay: 0, filtered: true, maxMs: 6 * 3600000 },
  diplomeTemoin: { name: "🎓 Diplômé témoin", delay: 0, filtered: false, maxMs: 6 * 3600000 },
  createur: { name: '🔍 Analyse créateur', delay: 0, filtered: true },
  ia: { name: '🤖 IA Claude Opus 5.5', delay: 0, filtered: true },
  seconde: { name: '⚡ Seconde filtrée', delay: 0, filtered: true },
  confirme: { name: '⏱️ Confirmé 60 s', delay: 60000, filtered: true, confirm: true },
  temoin: { name: '🎲 Tout acheter (témoin)', delay: 0, filtered: false },
  // TEST VIRTUEL « éclair » : achète dès la création, sans attendre les métadonnées ni RugCheck (ordre de ~0,1 s),
  // seulement si le créateur n'a pas acheté plus de 5 % de l'offre. Mêmes frais et même sortie que les autres.
  eclair: { name: '⚡ Éclair 0,1 s (test)', delay: 0, fast: true, maxMs: 30 * MIN },
  // Éclair sélectif (test virtuel) : achète à la création seulement si le créateur détient ≤ 5 %,
  // ne lance pas en série (≤ 1 lancement en 24 h) et si le nom n'a pas l'air d'une imitation (pas de mot « test », « rug », « scam »).
  eclairQ: { name: '⚡ Éclair sélectif (test)', delay: 0, fast: true, selective: true, maxMs: 30 * MIN },
};
const RPC = 'https://api.mainnet-beta.solana.com';
const JUNK_IMITATION = /test|rug|scam|fake|copy|clone|free/i;

// Clé API Claude facultative (fichier live/.env : ANTHROPIC_API_KEY=...). Sans clé, la variante IA reste inactive.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* pas de .env */ }
let claude = null;
if (process.env.ANTHROPIC_API_KEY) {
  try { const Anthropic = require('@anthropic-ai/sdk'); claude = new (Anthropic.default || Anthropic)(); } catch { claude = null; }
}
const EXIT = { tp1: 0.5, tp1Part: 0.5, trail: 0.25, sl: 0.3, maxMs: 30 * MIN }; // moitié vendue à +50 %, reste suivi à −25 % du plus haut

const log = (...a) => {
  const line = `[${new Date().toLocaleString('fr-FR')}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG, `${line}\n`);
};

// ---------- État
let st = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
if (!st) st = { start: Date.now(), variants: {}, seen: 0, lastCreate: null, recent: [] };
for (const id in VARIANTS) if (!st.variants[id]) st.variants[id] = { cash: CAPITAL, positions: [], trades: [], history: [] };
st.creators = st.creators || {}; // portefeuille créateur -> dates de ses lancements (lanceurs en série)
st.aiEnabled = !!claude;
const save = () => { fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(st)); fs.renameSync(`${FILE}.tmp`, FILE); };

// ---------- Prix du SOL
let solUsd = 0;
async function refreshSol() {
  try {
    const r = await fetch('https://data-api.binance.vision/api/v3/ticker/price?symbol=SOLUSDT');
    solUsd = +(await r.json()).price;
  } catch { /* garde l'ancien */ }
}
const priceUsd = (mcapSol) => (mcapSol * solUsd) / SUPPLY;

// ---------- Suivi des tokens (créateur, acheteurs, dernier prix)
const tokens = new Map(); // mint -> { creator, name, symbol, t0, p0, last, buyers:Set, buys, sells, devSold, meta }
// Le flux des trades de PumpPortal est payant : les prix des tokens suivis viennent de DexScreener toutes les 10 s
const subscribed = new Set();
let ws = null;
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const subscribe = (mint) => { subscribed.add(mint); };
const unsubscribe = (mint) => {
  const stillHeld = Object.values(st.variants).some((v) => v.positions.some((p) => p.mint === mint));
  const pending = pendingConfirm.has(mint);
  if (!stillHeld && !pending) { subscribed.delete(mint); tokens.delete(mint); }
};
async function pollPrices() {
  const mints = [...subscribed];
  for (let k = 0; k < mints.length; k += 30) {
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(k, k + 30).join(',')}`);
      const pairs = await r.json();
      const best = {};
      for (const p of pairs || []) {
        const a = p.baseToken && p.baseToken.address;
        if (!a || !(+p.priceUsd > 0)) continue;
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        // Priorité aux paires pump.fun / PumpSwap, puis à la plus liquide
        const pump = /pump/.test(p.dexId || '');
        const cur = best[a];
        if (!cur || (pump && !cur.pump) || (pump === cur.pump && liq > cur.liq)) best[a] = { price: +p.priceUsd, liq, pump, m5: (p.txns && p.txns.m5) || {} };
      }
      for (const [a, b] of Object.entries(best)) {
        const tok = tokens.get(a);
        if (!tok) continue;
        // Garde-fou : un saut de plus de ×20 en 10 s est une erreur de cotation, on l'ignore
        // Premier prix du vrai marché très loin du prix de création : l'achat simulé n'était pas réalisable, on l'annule
        if (!tok.seenDs && tok.p0 > 0 && Math.abs(Math.log(b.price / tok.p0)) > Math.log(5)) { cancelToken(tok); continue; }
        if (tok.last > 0 && Math.abs(Math.log(b.price / tok.last)) > Math.log(20)) continue;
        // Saut de plus de ×3 en 10 s : on attend qu'un 2e relevé le confirme avant d'y croire
        if (tok.last > 0 && Math.abs(Math.log(b.price / tok.last)) > Math.log(3)) {
          if (!tok.jump || Math.abs(Math.log(b.price / tok.jump)) > Math.log(1.5)) { tok.jump = b.price; continue; }
        }
        tok.jump = 0;
        // Liquidité trop faible : prix pas réalisable en vrai, on ne s'en sert pas pour vendre en gain
        if (b.liq > 0 && b.liq < 3000 && tok.last > 0 && b.price > tok.last) continue;
        tok.last = b.price;
        tok.buys = b.m5.buys || 0;
        tok.sells = b.m5.sells || 0;
        tok.seenDs = true;
        checkExits(a, false);
      }
    } catch { /* réessai au prochain tour */ }
  }
}

// Métadonnées (Twitter, site) avec délai maximal pour ne pas rater la seconde
async function metadata(uri) {
  if (!uri) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(uri, { signal: ctrl.signal });
    clearTimeout(timer);
    return await r.json();
  } catch { return null; }
}

const JUNK = /^(test|tst|asdf|aaa+|x+|\.+|rug|scam)$/i;
function filters(tok) {
  const m = tok.meta || {};
  const twitter = [m.twitter, m.extensions && m.extensions.twitter].find((x) => typeof x === 'string' && /(x|twitter)\.com\//i.test(x));
  if (!twitter) return { ok: false, why: 'pas de Twitter' };
  if (tok.devPct > 5) return { ok: false, why: `créateur ${tok.devPct.toFixed(1)} %` };
  if (JUNK.test(tok.symbol || '') || JUNK.test(tok.name || '')) return { ok: false, why: 'nom bidon' };
  const dup = st.recent.filter((r) => r.symbol && r.symbol.toLowerCase() === (tok.symbol || '').toLowerCase() && Date.now() - r.t < 60 * MIN).length;
  if (dup > 1) return { ok: false, why: 'symbole déjà lancé plusieurs fois cette heure' };
  return { ok: true, why: 'Twitter, créateur ≤ 5 %' };
}

// ---------- Analyse du portefeuille du créateur (blockchain Solana, ~0,2 s)
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function creatorProfile(wallet) {
  try {
    const [sigs, bal] = await Promise.all([rpc('getSignaturesForAddress', [wallet, { limit: 1000 }]), rpc('getBalance', [wallet])]);
    const oldest = sigs.length ? sigs[sigs.length - 1].blockTime : null;
    return { txs: sigs.length, ageDays: oldest ? (Date.now() / 1000 - oldest) / 86400 : 0, sol: (bal && bal.value) / 1e9 };
  } catch { return null; }
}

function creatorFilters(tok) {
  const base = filters(tok);
  if (!base.ok) return base;
  const m = tok.meta || {};
  const c = tok.creatorInfo;
  if (!c) return { ok: false, why: 'portefeuille du créateur illisible' };
  if (c.ageDays < 3) return { ok: false, why: `portefeuille du créateur de ${c.ageDays < 1 ? Math.round(c.ageDays * 24) + ' h' : c.ageDays.toFixed(1) + ' j'}` };
  if (c.txs < 20) return { ok: false, why: `créateur : ${c.txs} transactions seulement` };
  if (c.sol < 0.5) return { ok: false, why: `créateur : ${c.sol.toFixed(2)} SOL` };
  if (tok.launches24h > 1) return { ok: false, why: `créateur : ${tok.launches24h} lancements en 24 h` };
  if (tok.devPct < 0.5) return { ok: false, why: 'le créateur n’a rien acheté' };
  if (!(m.website || m.telegram || (m.extensions && (m.extensions.website || m.extensions.telegram)))) return { ok: false, why: 'ni site ni Telegram' };
  return { ok: true, why: `créateur ${c.ageDays >= 30 ? '30 j+' : Math.round(c.ageDays) + ' j'}, ${c.txs}${c.txs >= 1000 ? '+' : ''} tx, ${c.sol.toFixed(1)} SOL, ${tok.devPct.toFixed(1)} %` };
}

// Note de Claude (Opus 5.5) sur le projet, à partir des seules données publiques
async function aiScore(tok) {
  if (!claude) return null;
  const m = tok.meta || {};
  const facts = {
    nom: tok.name, symbole: tok.symbol, description: (m.description || '').slice(0, 500),
    twitter: m.twitter || null, site: m.website || null, telegram: m.telegram || null,
    part_createur_pct: +tok.devPct.toFixed(2), createur: tok.creatorInfo, lancements_createur_24h: tok.launches24h,
  };
  try {
    const res = await claude.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 1000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: 'Tu évalues des memecoins Solana qui viennent d’être lancés, pour un test en argent virtuel. Juge originalité du concept, cohérence nom/description/liens, et signaux d’arnaque (copie d’un token connu, promesses de gains, liens incohérents). Réponds uniquement par un objet JSON : {"note": entier de 0 à 10, "raison": "phrase courte en français"}.',
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    });
    if (res.stop_reason === 'refusal') return null;
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { note: Number(j.note), raison: String(j.raison || '').slice(0, 120) };
  } catch (e) {
    log('IA indisponible :', e.message);
    return null;
  }
}

// ---------- Ordres virtuels
function buy(id, tok, why) {
  const v = st.variants[id];
  if (v.positions.length >= MAX_OPEN || v.cash < STAKE || !(tok.last > 0)) return;
  if (v.positions.some((p) => p.mint === tok.mint)) return;
  const fill = tok.last * (1 + COST);
  v.cash -= STAKE;
  v.positions.push({ mint: tok.mint, name: tok.symbol || tok.name, t: Date.now(), entry: fill, last: tok.last, peak: tok.last, qty: STAKE / fill, cost: STAKE, realized: 0 });
  v.trades.push({ t: Date.now(), side: 'achat', name: tok.symbol || tok.name, mint: tok.mint, price: fill, usd: STAKE, reason: why });
  subscribe(tok.mint);
}

function cancelToken(tok) {
  for (const v of Object.values(st.variants)) {
    const p = v.positions.find((x) => x.mint === tok.mint);
    if (!p) continue;
    v.cash += p.cost; // remboursement de la mise : rien n'a encore été vendu
    v.positions.splice(v.positions.indexOf(p), 1);
    v.trades = v.trades.filter((t) => t.mint !== tok.mint);
  }
  tok.seenDs = true;
  unsubscribe(tok.mint);
  log('achat annulé, prix de départ faux :', tok.symbol || tok.mint);
}

function sell(v, p, part, reason) {
  const qty = p.qty * part;
  const usd = qty * p.last * (1 - COST);
  v.cash += usd;
  p.qty -= qty;
  p.realized += usd;
  const done = part >= 1 || p.qty <= 1e-9;
  v.trades.push({ t: Date.now(), side: 'vente', name: p.name, mint: p.mint, price: p.last, usd, ret: done ? p.realized / p.cost - 1 : usd / (p.cost * part) - 1, reason: done ? reason : `${reason} (moitié)` });
  if (done) { v.positions.splice(v.positions.indexOf(p), 1); unsubscribe(p.mint); }
}

function checkExits(mint, devSold) {
  for (const [vid, v] of Object.entries(st.variants)) {
    const maxMs = (VARIANTS[vid] && VARIANTS[vid].maxMs) || EXIT.maxMs;
    for (const p of [...v.positions]) {
      if (p.mint !== mint && mint) continue;
      const tok = tokens.get(p.mint);
      if (tok && tok.last > 0) p.last = tok.last;
      p.peak = Math.max(p.peak, p.last);
      if (devSold && p.mint === mint) sell(v, p, 1, 'le créateur vend');
      else if (!p.tp1Done && p.last <= p.entry * (1 - EXIT.sl)) sell(v, p, 1, `stop −${EXIT.sl * 100} %`);
      else if (!p.tp1Done && p.last >= p.entry * (1 + EXIT.tp1)) { sell(v, p, EXIT.tp1Part, '+50 % atteint'); if (v.positions.includes(p)) p.tp1Done = true; }
      else if (p.tp1Done && p.last <= p.peak * (1 - EXIT.trail)) sell(v, p, 1, `stop suiveur −${EXIT.trail * 100} %`);
      else if (Date.now() - p.t >= maxMs) sell(v, p, 1, `${Math.round(maxMs / MIN) >= 60 ? Math.round(maxMs / 3600000) + ' h' : Math.round(maxMs / MIN) + ' min'} écoulées`);
    }
  }
}

// ---------- Confirmation à 60 s
const pendingConfirm = new Map(); // mint -> timer
function scheduleConfirm(tok) {
  pendingConfirm.set(tok.mint, setTimeout(() => {
    pendingConfirm.delete(tok.mint);
    const gain = tok.last / tok.p0 - 1;
    const ok = tok.seenDs && tok.buys >= 10 && tok.buys > tok.sells && gain >= 0.2 && gain <= 3;
    if (ok) buy('confirme', tok, `60 s : ${tok.buys} achats / ${tok.sells} ventes, ${gain >= 0 ? '+' : ''}${Math.round(gain * 100)} %`);
    unsubscribe(tok.mint);
  }, VARIANTS.confirme.delay));
}

// ---------- Diplômés : tokens qui sortent de la courbe pump.fun (≈ 1 % des lancements)
async function rugReport(mint) {
  try {
    const r = await (await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`)).json();
    const supply = r.token && r.token.supply;
    const pools = new Set((r.markets || []).flatMap((m) => [m.pubkey, m.liquidityA, m.liquidityB, m.liquidityAAccount, m.liquidityBAccount].filter(Boolean)));
    const holders = (r.topHolders || []).filter((h) => !pools.has(h.address) && !pools.has(h.owner));
    return {
      creatorPct: supply && r.creatorBalance ? (r.creatorBalance / supply) * 100 : 0,
      top10: holders.slice(0, 10).reduce((a, h) => a + (h.pct || 0), 0),
      insiders: r.graphInsidersDetected || 0, holders: r.totalHolders || 0,
      mintAuth: !!r.mintAuthority, freezeAuth: !!r.freezeAuthority, rugged: !!r.rugged,
      danger: (r.risks || []).filter((x) => x.level === 'danger').map((x) => x.name),
      uri: r.tokenMeta && r.tokenMeta.uri,
    };
  } catch { return null; }
}
async function onMigration(d) {
  st.migrations = (st.migrations || 0) + 1;
  await new Promise((r) => setTimeout(r, 75000)); // laisser le nouveau marché s'ouvrir et être indexé
  const [pairs, rc] = await Promise.all([
    fetch(`https://api.dexscreener.com/tokens/v1/solana/${d.mint}`).then((r) => r.json()).catch(() => []),
    rugReport(d.mint),
  ]);
  const p = (pairs || []).filter((x) => +x.priceUsd > 0).sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
  if (!p) return;
  const tok = { mint: d.mint, name: p.baseToken.name, symbol: p.baseToken.symbol, t0: Date.now(), last: +p.priceUsd, p0: +p.priceUsd, buys: 0, sells: 0, buyers: new Set() };
  tokens.set(d.mint, tok);
  buy('diplomeTemoin', tok, 'sortie de pump.fun');
  const liq = (p.liquidity && p.liquidity.usd) || 0;
  const m5 = (p.txns && p.txns.m5) || {};
  // Réseaux : DexScreener met du temps à les afficher, on lit aussi les métadonnées du token
  const meta = rc && rc.uri ? await metadata(rc.uri) : null;
  const twitter = ((p.info && p.info.socials) || []).some((x) => x.type === 'twitter') || !!(meta && [meta.twitter, meta.extensions && meta.extensions.twitter].find((x) => typeof x === 'string' && /(x|twitter).com//i.test(x)));
  let why = null;
  if (!rc) why = 'RugCheck indisponible';
  else if (rc.rugged || rc.danger.length) why = rc.rugged ? 'rug détecté' : rc.danger[0];
  else if (rc.mintAuth || rc.freezeAuth) why = 'autorisations dangereuses';
  else if (rc.creatorPct > 5) why = `créateur ${rc.creatorPct.toFixed(0)} %`;
  else if (rc.top10 > 30) why = `top 10 : ${rc.top10.toFixed(0)} %`;
  else if (rc.insiders > 0) why = 'réseau d’insiders';
  else if (rc.holders < 200) why = `${rc.holders} détenteurs`;
  else if (!twitter) why = 'pas de Twitter';
  else if (liq < 20000) why = `liquidité ${Math.round(liq / 1000)} k$`;
  else if (!((m5.buys || 0) > (m5.sells || 0))) why = 'plus de ventes que d’achats';
  st.recentGrad = (st.recentGrad || []).concat([{ t: Date.now(), symbol: tok.symbol, ok: !why, why: why || 'tous les critères' }]).slice(-30);
  if (!why) buy('diplome', tok, `diplômé, ${rc.holders} détenteurs, top 10 ${rc.top10.toFixed(0)} %, liquidité ${Math.round(liq / 1000)} k$`);
  subscribe(d.mint);
  unsubscribe(d.mint);
}

// ---------- Flux temps réel
async function onCreate(d) {
  // Seuls les vrais lancements pump.fun (adresse en "...pump", nom et symbole présents) ont un prix de départ fiable
  if (!/pump$/.test(d.mint) || !d.symbol || !d.name) return;
  st.seen++;
  const tok = {
    mint: d.mint, creator: d.traderPublicKey, name: d.name, symbol: d.symbol, t0: Date.now(),
    devPct: ((d.initialBuy || 0) / SUPPLY) * 100, p0: priceUsd(d.marketCapSol), last: priceUsd(d.marketCapSol),
    buyers: new Set(), buys: 0, sells: 0, devSold: false, meta: null,
  };
  tokens.set(d.mint, tok);
  st.lastCreate = { name: d.symbol, t: Date.now() };
  // Lanceurs en série : on retient chaque lancement de chaque créateur
  const hist = (st.creators[tok.creator] || []).filter((t) => Date.now() - t < 24 * 60 * MIN);
  hist.push(Date.now());
  st.creators[tok.creator] = hist;
  tok.launches24h = hist.length;
  // Témoin : achète tout, tout de suite
  buy('temoin', tok, 'création');
  // Éclair (test virtuel) : achat immédiat si le créateur détient peu
  if (tok.devPct <= 5) buy('eclair', tok, 'création, créateur ' + tok.devPct.toFixed(1) + ' %');
  if (tok.devPct <= 5 && tok.launches24h <= 1 && !JUNK_IMITATION.test(d.name) && !JUNK_IMITATION.test(d.symbol)) buy('eclairQ', tok, 'création sélective, créateur ' + tok.devPct.toFixed(1) + ' %, premier lancement');
  // Métadonnées et portefeuille du créateur en parallèle
  [tok.meta, tok.creatorInfo] = await Promise.all([metadata(d.uri), creatorProfile(tok.creator)]);
  const f = filters(tok);
  const fc = creatorFilters(tok);
  const secs = () => `${((Date.now() - tok.t0) / 1000).toFixed(1)} s après création`;
  st.recent.push({ t: Date.now(), symbol: d.symbol, ok: fc.ok, why: fc.ok ? fc.why : fc.why, devPct: +tok.devPct.toFixed(2) });
  if (st.recent.length > 200) st.recent = st.recent.slice(-200);
  if (!f.ok) { if (!Object.values(st.variants).some((v) => v.positions.some((p) => p.mint === d.mint))) tokens.delete(d.mint); return; }
  buy('seconde', tok, `${secs()}, ${f.why}`);
  if (fc.ok) {
    buy('createur', tok, `${secs()}, ${fc.why}`);
    const ai = await aiScore(tok);
    if (ai) {
      st.recent[st.recent.length - 1].ai = ai;
      if (ai.note >= 7) buy('ia', tok, `${secs()}, IA ${ai.note}/10 : ${ai.raison}`);
    }
  }
  subscribe(d.mint);
  scheduleConfirm(tok);
}

function onTrade(d) {
  const tok = tokens.get(d.mint);
  if (!tok) return;
  tok.last = priceUsd(d.marketCapSol);
  if (d.txType === 'buy') { tok.buys++; tok.buyers.add(d.traderPublicKey); }
  if (d.txType === 'sell') { tok.sells++; if (d.traderPublicKey === tok.creator) tok.devSold = true; }
  checkExits(d.mint, d.txType === 'sell' && d.traderPublicKey === tok.creator);
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    log('connecté au flux temps réel');
    send({ method: 'subscribeNewToken' });
    send({ method: 'subscribeMigration' });
    const held = new Set(Object.values(st.variants).flatMap((v) => v.positions.map((p) => p.mint)));
    subscribed.clear();
    for (const m of held) { if (!tokens.has(m)) tokens.set(m, { mint: m, last: 0, buyers: new Set(), buys: 0, sells: 0 }); subscribe(m); }
  };
  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!d.mint) return;
    if (!solUsd && d.txType === 'create') return;
    if (d.txType === 'create') onCreate(d).catch(() => {});
    else if (d.txType === 'migrate' || d.txType === 'migration' || (d.pool && !d.txType && d.mint)) onMigration(d).catch((e) => log('diplômé :', e.message));
    else if (d.txType === 'buy' || d.txType === 'sell') onTrade(d);
  };
  ws.onclose = () => { log('flux coupé, reconnexion dans 5 s'); setTimeout(connect, 5000); };
  ws.onerror = () => ws.close();
}

// ---------- Publication sur GitHub (branche "sniper")
let token = null, sha = null;
async function publish() {
  try {
    if (!token) token = execSync('gh auth token', { encoding: 'utf8' }).trim();
    const now = Date.now();
    for (const v of Object.values(st.variants)) {
      const val = v.cash + v.positions.reduce((a, p) => a + p.qty * p.last, 0);
      v.history.push([now, +val.toFixed(2)]);
      if (v.history.length > 2000) v.history = v.history.filter((_, i) => i % 2 === 0);
      v.trades = v.trades.slice(-300);
    }
    save();
    const { creators, ...pub } = st;
    for (const w in creators) if (!creators[w].some((t) => now - t < 24 * 60 * MIN)) delete creators[w];
    const body = { ...pub, lastRun: now, solUsd, recent: st.recent.slice(-15) };
    const content = Buffer.from(JSON.stringify(body)).toString('base64');
    const api = `https://api.github.com/repos/${REPO}/contents/sniper.json`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
    if (!sha) {
      const r = await fetch(`${api}?ref=${BRANCH}`, { headers });
      if (r.ok) sha = (await r.json()).sha;
    }
    const r = await fetch(api, { method: 'PUT', headers, body: JSON.stringify({ message: 'Sniper seconde : mise à jour', content, branch: BRANCH, ...(sha ? { sha } : {}) }) });
    if (r.ok) sha = (await r.json()).content.sha;
    else { sha = null; log('publication refusée', r.status); }
  } catch (e) { log('publication impossible :', e.message); }
}

// ---------- Démarrage (une seule copie à la fois : la tâche Windows le relance toutes les 5 min s'il s'est arrêté)
const guard = require('net').createServer().on('error', () => process.exit(0));
guard.listen(47123, '127.0.0.1', () => start());
async function start() {
  await refreshSol();
  log(`Sniper seconde démarré · SOL ${solUsd} $`);
  connect();
  setInterval(refreshSol, MIN);
  setInterval(pollPrices, 10000); // prix des tokens suivis (DexScreener)
  setInterval(() => checkExits(null, false), 10000); // sorties sur durée même sans trade
  setInterval(publish, 2 * MIN);
  setTimeout(publish, 15000);
}
