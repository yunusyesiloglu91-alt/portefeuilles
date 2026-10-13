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
  createur: { name: '🔍 Analyse créateur', delay: 0, filtered: true },
  ia: { name: '🤖 IA Claude Opus 5.5', delay: 0, filtered: true },
  seconde: { name: '⚡ Seconde filtrée', delay: 0, filtered: true },
  confirme: { name: '⏱️ Confirmé 60 s', delay: 60000, filtered: true, confirm: true },
  temoin: { name: '🎲 Tout acheter (témoin)', delay: 0, filtered: false },
};
const RPC = 'https://api.mainnet-beta.solana.com';

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
const EXIT = { tp1: 1, tp1Part: 0.5, trail: 0.3, sl: 0.35, maxMs: 30 * MIN };

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
        if (tok.last > 0 && Math.abs(Math.log(b.price / tok.last)) > Math.log(20)) continue;
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
  for (const v of Object.values(st.variants)) {
    for (const p of [...v.positions]) {
      if (p.mint !== mint && mint) continue;
      const tok = tokens.get(p.mint);
      if (tok && tok.last > 0) p.last = tok.last;
      p.peak = Math.max(p.peak, p.last);
      if (devSold && p.mint === mint) sell(v, p, 1, 'le créateur vend');
      else if (!p.tp1Done && p.last <= p.entry * (1 - EXIT.sl)) sell(v, p, 1, `stop −${EXIT.sl * 100} %`);
      else if (!p.tp1Done && p.last >= p.entry * (1 + EXIT.tp1)) { sell(v, p, EXIT.tp1Part, '×2 atteint'); if (v.positions.includes(p)) p.tp1Done = true; }
      else if (p.tp1Done && p.last <= p.peak * (1 - EXIT.trail)) sell(v, p, 1, `stop suiveur −${EXIT.trail * 100} %`);
      else if (Date.now() - p.t >= EXIT.maxMs) sell(v, p, 1, '30 min écoulées');
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

// ---------- Flux temps réel
async function onCreate(d) {
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
    const held = new Set(Object.values(st.variants).flatMap((v) => v.positions.map((p) => p.mint)));
    subscribed.clear();
    for (const m of held) { if (!tokens.has(m)) tokens.set(m, { mint: m, last: 0, buyers: new Set(), buys: 0, sells: 0 }); subscribe(m); }
  };
  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (!d.mint || !solUsd) return;
    if (d.txType === 'create') onCreate(d).catch(() => {});
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
