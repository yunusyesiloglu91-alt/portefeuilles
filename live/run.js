// Portefeuille virtuel de 100 € géré automatiquement (un passage = une exécution).
// Lancé toutes les 30 min par GitHub Actions (.github/workflows/live.yml).
//  - Poche BTC (40 %) : investi si le prix > moyenne 50 jours (bougies journalières clôturées), sinon stablecoin.
//  - Poche SOL (30 %) : même règle.
//  - Poche memecoins (30 %) : "profil prudent" de src/meme-rules.js, 3 positions maximum.
// Aucun ordre réel. Résultat : live/state.json, live/PORTEFEUILLE.md, live/courbe.svg
const fs = require('fs');
const path = require('path');
const I = require('../src/indicators.js');
const Rules = require('../src/meme-rules.js');
const { runSniper } = require('./sniper.js');

const DIR = __dirname;
const STATE = path.join(DIR, 'state.json');
const BINANCE = 'https://data-api.binance.vision/api/v3';
const GT = 'https://api.geckoterminal.com/api/v2';
const DS = 'https://api.dexscreener.com';
const DAY = 86400000;
const FEE = 0.001, SLIP = 0.0005; // Binance spot
const SPLIT = { btc: 0.4, sol: 0.3, meme: 0.3 };
const MEME_SLOTS = 3;
let eurusdGlobal = 1;
// Portefeuille Casino (100 $) : jeunes memecoins en pleine accélération. Très risqué, assumé.
const CASINO = { capital: 100, slots: 5, cost: 0.015, minAgeH: 6, maxAgeD: 7, minMcap: 3e5, maxMcap: 20e6, minLiq: 30e3, tp: 1, sl: 0.4, maxHoldH: 48 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, tries = 3) {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.ok) return await r.json();
      if (r.status === 429) { await sleep(30000); continue; }
    } catch { /* réseau */ }
    await sleep(3000);
  }
  throw new Error(`indisponible : ${url.split('?')[0]}`);
}
let lastGt = 0;
async function gt(url) {
  const wait = lastGt + 6000 - Date.now();
  if (wait > 0) await sleep(wait);
  lastGt = Date.now();
  return json(url, 2);
}

const parisTime = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const eur = (x) => `${x.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const pct = (x) => `${x > 0 ? '+' : ''}${(x * 100).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
const fmtPx = (p) => (p >= 1 ? p.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : Number(p.toPrecision(4)).toString().replace('.', ','));

async function main() {
  const now = Date.now();
  const tick = await json(`${BINANCE}/ticker/price?symbols=${encodeURIComponent(JSON.stringify(['BTCUSDT', 'SOLUSDT', 'EURUSDT']))}`);
  const px = Object.fromEntries(tick.map((t) => [t.symbol, +t.price]));
  const eurusd = px.EURUSDT;
  eurusdGlobal = eurusd;

  // État initial : 100 € convertis en stablecoin (USDT)
  let st;
  if (fs.existsSync(STATE)) st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  else {
    const usd = 100 * eurusd;
    st = {
      start: now, eurusdStart: eurusd,
      sleeves: {
        btc: { symbol: 'BTCUSDT', cash: usd * SPLIT.btc, qty: 0, entry: null },
        sol: { symbol: 'SOLUSDT', cash: usd * SPLIT.sol, qty: 0, entry: null },
        meme: { cash: usd * SPLIT.meme, positions: [] },
      },
      trades: [], history: [], watch: [], notes: [],
    };
  }
  // Test d'une semaine : après 7 jours, le robot s'arrête (et ne consomme plus de minutes GitHub)
  if (process.env.ROBOT_STOP === '1') {
    if (!st.finished) {
      st.finished = now;
      fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
      fs.appendFileSync(path.join(DIR, 'PORTEFEUILLE.md'), `
> ✅ **Test d'une semaine terminé le ${parisTime(now)}.** Le robot est à l'arrêt.
`);
    }
    console.log('Test terminé');
    return;
  }
  const log = (sleeve, side, name, price, usd, extra = {}) => st.trades.push({ t: now, sleeve, side, name, price, usd, ...extra });
  const notes = [];

  // ---------- Poches tendance BTC / SOL
  for (const key of ['btc', 'sol']) {
    const s = st.sleeves[key];
    const rows = await json(`${BINANCE}/klines?symbol=${s.symbol}&interval=1d&limit=80`);
    const closed = rows.filter((r) => r[6] < now).map((r) => +r[4]); // bougies clôturées uniquement
    const sma = I.sma(closed, 50);
    const last = closed.length - 1;
    const want = closed[last] > sma[last];
    s.signal = want ? 'au-dessus de la moyenne 50 j' : 'sous la moyenne 50 j';
    const price = px[s.symbol];
    const name = key.toUpperCase();
    if (want && s.qty === 0 && s.cash > 1) {
      const fill = price * (1 + SLIP);
      s.qty = (s.cash * (1 - FEE)) / fill;
      s.entry = { price: fill, usd: s.cash };
      log(key, 'achat', name, fill, s.cash, { reason: 'prix au-dessus de sa moyenne 50 j' });
      s.cash = 0;
    } else if (!want && s.qty > 0) {
      const fill = price * (1 - SLIP);
      const usd = s.qty * fill * (1 - FEE);
      log(key, 'vente', name, fill, usd, { ret: usd / s.entry.usd - 1, reason: 'prix passé sous sa moyenne 50 j' });
      s.cash = usd; s.qty = 0; s.entry = null;
    }
  }

  // ---------- Memecoins : portefeuille prudent (poche) + portefeuille Casino
  const m = st.sleeves.meme;
  if (!st.casino) st.casino = { start: now, cash: CASINO.capital, positions: [], trades: [], history: [], watch: [] };
  const cz = st.casino;
  const clog = (side, name, price, usd, extra = {}) => cz.trades.push({ t: now, side, name, price, usd, ...extra });
  try {
    // 1. Prix des positions ouvertes (les deux portefeuilles en une requête) et sorties
    const held = [...m.positions, ...cz.positions];
    if (held.length) {
      const r = await gt(`${GT}/simple/networks/solana/token_price/${[...new Set(held.map((p) => p.addr))].join(',')}`);
      const prices = (r.data && r.data.attributes.token_prices) || {};
      for (const p of [...m.positions]) {
        const price = +prices[p.addr];
        if (!(price > 0)) continue;
        p.last = price;
        const reason = Rules.exit(p, price, now);
        if (reason) {
          const usd = p.qty * price * (1 - Rules.PARAMS.cost);
          m.cash += usd;
          m.positions.splice(m.positions.indexOf(p), 1);
          log('meme', 'vente', p.name, price, usd, { ret: usd / p.cost - 1, reason });
        }
      }
      for (const p of [...cz.positions]) {
        const price = +prices[p.addr];
        if (!(price > 0)) continue;
        p.last = price;
        let reason = null;
        if (price >= p.entry * (1 + CASINO.tp)) reason = 'objectif ×2 atteint';
        else if (price <= p.entry * (1 - CASINO.sl)) reason = `stop −${CASINO.sl * 100} %`;
        else if (now - p.t >= CASINO.maxHoldH * 3600000) reason = `${CASINO.maxHoldH} h écoulées`;
        if (reason) {
          const usd = p.qty * price * (1 - CASINO.cost);
          cz.cash += usd;
          cz.positions.splice(cz.positions.indexOf(p), 1);
          clog('vente', p.name, price, usd, { ret: usd / p.cost - 1, reason });
        }
      }
    }

    // 2. Tokens Solana actifs du moment
    const seen = new Map();
    for (const u of [`${GT}/networks/solana/trending_pools?page=1&duration=24h&include=base_token`, `${GT}/networks/solana/trending_pools?page=1&duration=1h&include=base_token`, `${GT}/networks/solana/trending_pools?page=2&duration=1h&include=base_token`]) {
      const r = await gt(u);
      for (const p of r.data || []) {
        const a = p.attributes, addr = p.relationships.base_token.data.id.replace('solana_', '');
        if (Rules.MAJORS.has(addr) || seen.has(addr)) continue;
        seen.set(addr, {
          addr, pool: a.address, name: a.name.split(' / ')[0], price: +a.base_token_price_usd,
          mcap: +(a.market_cap_usd || a.fdv_usd || 0), liq: +a.reserve_in_usd || 0, vol24: +a.volume_usd.h24 || 0,
          ch1: +a.price_change_percentage.h1 / 100, ch6: +a.price_change_percentage.h6 / 100, ch24: +a.price_change_percentage.h24 / 100,
          buyers24: a.transactions.h24.buyers, sellers24: a.transactions.h24.sellers,
          ageDays: (now - Date.parse(a.pool_created_at)) / DAY,
        });
      }
    }
    const all = [...seen.values()];

    // 3. Casino : jeunes tokens en pleine accélération
    const casinoOk = (c) => c.ageDays * 24 >= CASINO.minAgeH && c.ageDays <= CASINO.maxAgeD && c.mcap >= CASINO.minMcap && c.mcap <= CASINO.maxMcap &&
      c.liq >= CASINO.minLiq && c.liq / c.mcap >= 0.03 && c.ch1 > 0 && c.ch6 > 0 && c.ch6 <= 2 && c.buyers24 > c.sellers24;
    cz.paused = true; // arrêté le 13/10 : perd ~27 %, on se concentre sur le sniper (les positions ouvertes finissent leur vie)
    const hot = cz.paused ? [] : all.filter(casinoOk).sort((x, y) => y.ch1 - x.ch1);
    cz.watch = all.filter((c) => c.ageDays <= CASINO.maxAgeD && c.mcap >= CASINO.minMcap && c.mcap <= CASINO.maxMcap).sort((x, y) => y.vol24 - x.vol24).slice(0, 6)
      .map((c) => ({ name: c.name, mcap: c.mcap, ageDays: c.ageDays, ch1: c.ch1, ch24: c.ch24, ok: casinoOk(c) }));
    const czEquity = cz.cash + cz.positions.reduce((t, p) => t + p.qty * (p.last || p.entry), 0);
    for (const c of hot) {
      if (cz.positions.length >= CASINO.slots) break;
      if (cz.positions.some((p) => p.addr === c.addr) || cz.trades.some((t) => t.name === c.name && t.side === 'vente' && now - t.t < DAY)) continue;
      const size = Math.min(czEquity / CASINO.slots, cz.cash);
      if (size < 1) break;
      cz.cash -= size;
      cz.positions.push({ name: c.name, addr: c.addr, pool: c.pool, t: now, entry: c.price, last: c.price, qty: (size * (1 - CASINO.cost)) / c.price, cost: size });
      clog('achat', c.name, c.price, size, { reason: `${c.ageDays < 2 ? Math.round(c.ageDays * 24) + ' h' : Math.round(c.ageDays) + ' j'}, ${(c.mcap / 1e6).toFixed(1)} M$, +${Math.round(c.ch6 * 100)} % sur 6 h` });
    }

    // 4. Prudent : analyse détaillée une fois par heure (l'API gratuite est lente)
    if (!st.lastScan || now - st.lastScan >= 55 * 60000) {
      st.lastScan = now;
      const cands = all.filter(Rules.eligible).sort((x, y) => y.mcap - x.mcap).slice(0, 8);
      for (const c of cands) {
        const r = await gt(`${GT}/networks/solana/pools/${c.pool}/ohlcv/day?aggregate=1&limit=60&token=${c.addr}`);
        const rows = ((r.data && r.data.attributes.ohlcv_list) || []).slice().sort((x, y) => x[0] - y[0]);
        if (rows.length < 2) continue;
        const closes = rows.map((x) => x[4]);
        c.r7 = closes.length > 7 ? c.price / closes[closes.length - 8] - 1 : NaN;
        c.dd = c.price / Math.max(...closes, c.price) - 1;
        c.newHigh = c.price >= Math.max(...closes.slice(0, -1));
      }
      try {
        const ds = await json(`${DS}/latest/dex/tokens/${cands.map((c) => c.addr).join(',')}`, 1);
        for (const pair of ds.pairs || []) {
          const c = cands.find((x) => x.addr === pair.baseToken.address);
          if (!c || c.socials) continue;
          c.socials = ((pair.info && pair.info.socials) || []).map((x) => x.type);
          c.website = !!(pair.info && pair.info.websites && pair.info.websites.length);
          c.boosted = !!(pair.boosts && pair.boosts.active);
        }
      } catch { /* facultatif */ }
      const scored = cands.map((c) => ({ ...c, ...Rules.score(c), ok: Rules.entry(c) })).sort((x, y) => y.score - x.score);
      st.watch = scored.slice(0, 6).map((c) => ({ name: c.name, score: c.score, mcap: c.mcap, ageDays: c.ageDays, ok: c.ok, why: c.ok ? 'tous les critères remplis' : (c.risks[0] || (c.newHigh ? 'critères de taille/âge/volume non remplis' : 'pas à un nouveau record')) }));
      const equity = m.cash + m.positions.reduce((t, p) => t + p.qty * (p.last || p.entry), 0);
      for (const c of scored) {
        if (m.positions.length >= MEME_SLOTS) break;
        if (!c.ok || m.positions.some((p) => p.addr === c.addr)) continue;
        if (st.trades.some((t) => t.sleeve === 'meme' && t.side === 'vente' && t.name === c.name && now - t.t < Rules.PARAMS.cooldownDays * DAY)) continue;
        const size = Math.min(equity / MEME_SLOTS, m.cash);
        if (size < 1) break;
        m.cash -= size;
        m.positions.push({ name: c.name, addr: c.addr, pool: c.pool, t: now, entry: c.price, last: c.price, peak: c.price, qty: (size * (1 - Rules.PARAMS.cost)) / c.price, cost: size });
        log('meme', 'achat', c.name, c.price, size, { reason: `note ${c.score} : ${c.reasons.join(', ')}` });
      }
    }
  } catch (e) {
    notes.push(`memecoins : données indisponibles à ce passage (${e.message}), positions conservées`);
  }
  const czValue = cz.cash + cz.positions.reduce((t, p) => t + p.qty * (p.last || p.entry), 0);
  cz.history.push([now, +czValue.toFixed(2)]);
  cz.trades = cz.trades.slice(-200);

  // ---------- Laboratoire de sniping
  try { notes.push(...(await runSniper(st, now))); } catch (e) { notes.push(`sniper : ${e.message}`); }

  // ---------- Valorisation
  const val = {
    btc: st.sleeves.btc.cash + st.sleeves.btc.qty * px.BTCUSDT,
    sol: st.sleeves.sol.cash + st.sleeves.sol.qty * px.SOLUSDT,
    meme: m.cash + m.positions.reduce((a, p) => a + p.qty * (p.last || p.entry), 0),
  };
  const toEur = (usd) => usd / eurusd;
  const total = toEur(val.btc + val.sol + val.meme);
  st.history.push([now, +total.toFixed(2), +toEur(val.btc).toFixed(2), +toEur(val.sol).toFixed(2), +toEur(val.meme).toFixed(2)]);
  st.lastRun = now;
  st.notes = notes;
  st.trades = st.trades.slice(-200);
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));

  // ---------- Tableau de bord visuel (image pour téléphone) + détails
  const valEur = { btc: toEur(val.btc), sol: toEur(val.sol), meme: toEur(val.meme) };
  fs.writeFileSync(path.join(DIR, 'tableau-de-bord.svg'), dashboard({ now, st, total, valEur, cz, czValue }));
  if (fs.existsSync(path.join(DIR, 'courbe.svg'))) fs.unlinkSync(path.join(DIR, 'courbe.svg'));
  const usd = (x) => `${x.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  const md = [
    '# 📱 Mes portefeuilles virtuels',
    '',
    '![Tableau de bord](tableau-de-bord.svg)',
    '',
    '<details><summary><b>🛡️ Prudent — ce que le robot regarde</b></summary>',
    '',
    st.watch.length ? ['| Token | Note | Cap. | Âge | Décision |', '|---|---|---|---|---|', ...st.watch.map((w) => `| ${w.name} | ${w.score}/100 | ${(w.mcap / 1e6).toFixed(1)} M$ | ${Math.round(w.ageDays)} j | ${w.ok ? '✅ achat' : `⏸️ ${w.why}`} |`)].join('\n') : '_Pas de données._',
    '',
    `Règles : BTC et SOL investis si le prix est au-dessus de leur moyenne 50 j. Memecoins : > 10 M$, > 14 jours, à un nouveau record ; vente à +50 %, −30 % ou après 14 jours. Prix : BTC ${fmtPx(px.BTCUSDT)} $ · SOL ${fmtPx(px.SOLUSDT)} $ · 1 € = ${eurusd.toFixed(4)} $`,
    '</details>',
    '',
    '<details><summary><b>🎰 Casino — ce que le robot regarde</b></summary>',
    '',
    (cz.watch || []).length ? ['| Token | Cap. | Âge | 1 h | 24 h | Décision |', '|---|---|---|---|---|---|', ...cz.watch.map((w) => `| ${w.name} | ${(w.mcap / 1e6).toFixed(1)} M$ | ${Math.round(w.ageDays * 24)} h | ${pct(w.ch1)} | ${pct(w.ch24)} | ${w.ok ? '✅ achat' : '⏸️'} |`)].join('\n') : '_Pas de données._',
    '',
    `Règles : tokens de ${CASINO.minAgeH} h à ${CASINO.maxAgeD} jours, ${CASINO.minMcap / 1e6} à ${CASINO.maxMcap / 1e6} M$, en hausse sur 1 h et de 0 à +200 % sur 6 h, plus d'acheteurs que de vendeurs. ${CASINO.slots} positions. Vente à ×2, −${CASINO.sl * 100} % ou après ${CASINO.maxHoldH} h.`,
    '</details>',
    '',
    '<details><summary><b>📜 Historique complet des ordres</b></summary>',
    '',
    '| Date | Portefeuille | Ordre | Prix | Montant | Résultat | Raison |',
    '|---|---|---|---|---|---|---|',
    ...[...st.trades.map((t) => ({ ...t, pf: `Prudent (${t.sleeve})`, amount: eur(toEur(t.usd)) })), ...cz.trades.map((t) => ({ ...t, pf: 'Casino', amount: usd(t.usd) }))]
      .sort((x, y) => y.t - x.t).slice(0, 60)
      .map((t) => `| ${parisTime(t.t)} | ${t.pf} | ${t.side === 'achat' ? '🟢 achat' : '🔴 vente'} ${t.name} | ${fmtPx(t.price)} $ | ${t.amount} | ${t.ret != null ? pct(t.ret) : ''} | ${t.reason || ''} |`),
    '</details>',
    '',
    ...(notes.length ? ['> ' + notes.join(' · '), ''] : []),
    `_Argent virtuel uniquement, aucun ordre réel. Mis à jour le ${parisTime(now)} (toutes les 5 min environ)._`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(DIR, 'PORTEFEUILLE.md'), md);
  console.log(`Prudent ${total.toFixed(2)} € | Casino ${czValue.toFixed(2)} $ (${cz.positions.length} pos.)${notes.length ? ' | ' + notes.join(' ; ') : ''}`);
}

// ---------- Image du tableau de bord (thème sombre, lisible sur téléphone)
function dashboard({ now, st, total, valEur, cz, czValue }) {
  const C = { bg: '#0d0f14', card: '#171a21', line: '#262b36', text: '#f2f4f8', muted: '#8b93a7', up: '#22c55e', down: '#ef4444', blue: '#60a5fa', amber: '#fbbf24' };
  const W = 800, P = 24;
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cut = (x, n) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);
  const num = (x, d = 2) => x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sgn = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${num(Math.abs(x * 100), 1)} %`;
  const col = (x) => (x > 0.0005 ? C.up : x < -0.0005 ? C.down : C.muted);
  const ago = (t) => { const mn = Math.round((now - t) / 60000); return mn < 60 ? `il y a ${mn} min` : mn < 1440 ? `il y a ${Math.floor(mn / 60)} h` : `il y a ${Math.floor(mn / 1440)} j`; };
  const out = [];
  let y = 0;

  const spark = (hist, x0, y0, w, h, base, color) => {
    const pts = hist.length > 1 ? hist : [[now - 1, base], [now, hist.length ? hist[0][1] : base]];
    const vals = pts.map((p) => p[1]);
    let lo = Math.min(base, ...vals), hi = Math.max(base, ...vals);
    const pad = Math.max(base * 0.004, (hi - lo) * 0.15); lo -= pad; hi += pad;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
    const X = (t) => x0 + ((t - t0) / Math.max(1, t1 - t0)) * w;
    const Y = (v) => y0 + (1 - (v - lo) / (hi - lo)) * h;
    const line = pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
    const area = `${X(t0).toFixed(1)},${(y0 + h).toFixed(1)} ${line} ${X(t1).toFixed(1)},${(y0 + h).toFixed(1)}`;
    return `<line x1="${x0}" x2="${x0 + w}" y1="${Y(base).toFixed(1)}" y2="${Y(base).toFixed(1)}" stroke="${C.muted}" stroke-dasharray="6 6" opacity=".6"/>
<polygon points="${area}" fill="${color}" opacity=".12"/>
<polyline points="${line}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${X(t1).toFixed(1)}" cy="${Y(vals[vals.length - 1]).toFixed(1)}" r="7" fill="${color}"/>`;
  };

  const card = (title, tag, tagColor, value, change, hist, base, chips) => {
    const h = 400, x = P, w = W - 2 * P;
    const c = col(change);
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="${C.card}" stroke="${C.line}"/>`);
    out.push(`<text x="${x + 28}" y="${y + 52}" font-size="28" font-weight="700" fill="${C.text}">${esc(title)}</text>`);
    out.push(`<rect x="${x + w - 28 - tag.length * 13 - 28}" y="${y + 24}" width="${tag.length * 13 + 28}" height="40" rx="20" fill="${tagColor}" opacity=".18"/>`);
    out.push(`<text x="${x + w - 28 - (tag.length * 13 + 28) / 2}" y="${y + 51}" font-size="20" font-weight="700" text-anchor="middle" fill="${tagColor}">${esc(tag)}</text>`);
    out.push(`<text x="${x + 28}" y="${y + 132}" font-size="68" font-weight="800" fill="${C.text}">${esc(value)}</text>`);
    out.push(`<rect x="${x + 28}" y="${y + 150}" width="170" height="44" rx="22" fill="${c}" opacity=".18"/>`);
    out.push(`<text x="${x + 113}" y="${y + 180}" font-size="26" font-weight="700" text-anchor="middle" fill="${c}">${esc(sgn(change))}</text>`);
    out.push(spark(hist, x + 28, y + 212, w - 56, 100, base, c));
    const cw = (w - 56 - (chips.length - 1) * 12) / chips.length;
    chips.forEach((ch, k) => {
      const cx = x + 28 + k * (cw + 12);
      out.push(`<rect x="${cx}" y="${y + 328}" width="${cw}" height="52" rx="14" fill="${C.bg}"/>`);
      out.push(`<text x="${cx + 16}" y="${y + 352}" font-size="17" fill="${C.muted}">${esc(ch[0])}</text>`);
      out.push(`<text x="${cx + 16}" y="${y + 373}" font-size="19" font-weight="700" fill="${ch[2] || C.text}">${esc(ch[1])}</text>`);
    });
    y += h + 24;
  };

  // En-tête
  const day = Math.min(7, Math.floor((now - st.start) / DAY) + 1);
  y = 28;
  out.push(`<text x="${P}" y="${y + 36}" font-size="38" font-weight="800" fill="${C.text}">Mes portefeuilles virtuels</text>`);
  out.push(`<text x="${P}" y="${y + 72}" font-size="22" fill="${C.muted}">Mis à jour ${esc(parisTime(now))} · jour ${day}/7 · toutes les 5 min</text>`);
  y += 104;

  const b = st.sleeves.btc, s = st.sleeves.sol, m = st.sleeves.meme;
  card('🛡️ Prudent', 'BTC · SOL · MEMES', C.blue, `${num(total)} €`, total / 100 - 1, st.history.map((h) => [h[0], h[1]]), 100, [
    ['Bitcoin', `${num(valEur.btc)} € ${b.qty > 0 ? '· investi' : '· attente'}`, b.qty > 0 ? C.up : C.muted],
    ['Solana', `${num(valEur.sol)} € ${s.qty > 0 ? '· investi' : '· attente'}`, s.qty > 0 ? C.up : C.muted],
    ['Memecoins', `${num(valEur.meme)} € · ${m.positions.length}/${MEME_SLOTS}`],
  ]);
  const czClosed = cz.trades.filter((t) => t.side === 'vente');
  const czWins = czClosed.filter((t) => t.ret > 0).length;
  card('🎰 Casino', 'TRÈS RISQUÉ', C.amber, `${num(czValue)} $`, czValue / CASINO.capital - 1, cz.history, CASINO.capital, [
    ['Positions', `${cz.positions.length}/${CASINO.slots} ouvertes`],
    ['Cash', `${num(cz.cash)} $`],
    ['Trades fermés', czClosed.length ? `${czClosed.length} · ${czWins} gagnants` : 'aucun'],
  ]);

  // Positions en cours
  const rows = [];
  if (b.qty > 0) rows.push({ pf: 'Prudent', color: C.blue, name: 'Bitcoin', t: (st.trades.filter((t) => t.sleeve === 'btc' && t.side === 'achat').pop() || {}).t, ret: (valEur.btc * eurusdGlobal) / b.entry.usd - 1, val: `${num(valEur.btc)} €` });
  if (s.qty > 0) rows.push({ pf: 'Prudent', color: C.blue, name: 'Solana', t: (st.trades.filter((t) => t.sleeve === 'sol' && t.side === 'achat').pop() || {}).t, ret: (valEur.sol * eurusdGlobal) / s.entry.usd - 1, val: `${num(valEur.sol)} €` });
  for (const p of m.positions) rows.push({ pf: 'Prudent', color: C.blue, name: p.name, t: p.t, ret: (p.last * p.qty) / p.cost - 1, val: `${num((p.last * p.qty) / eurusdGlobal)} €` });
  for (const p of cz.positions) rows.push({ pf: 'Casino', color: C.amber, name: p.name, t: p.t, ret: (p.last * p.qty) / p.cost - 1, val: `${num(p.last * p.qty)} $` });
  out.push(`<text x="${P}" y="${y + 30}" font-size="28" font-weight="800" fill="${C.text}">Positions en cours</text>`);
  y += 50;
  if (!rows.length) { out.push(`<text x="${P}" y="${y + 28}" font-size="22" fill="${C.muted}">Aucune position ouverte : tout est en stablecoin.</text>`); y += 56; }
  for (const r of rows) {
    out.push(`<rect x="${P}" y="${y}" width="${W - 2 * P}" height="84" rx="18" fill="${C.card}" stroke="${C.line}"/>`);
    out.push(`<rect x="${P}" y="${y}" width="8" height="84" rx="4" fill="${r.color}"/>`);
    out.push(`<text x="${P + 28}" y="${y + 37}" font-size="26" font-weight="700" fill="${C.text}">${esc(cut(r.name, 18))}</text>`);
    out.push(`<text x="${P + 28}" y="${y + 66}" font-size="18" fill="${C.muted}">${esc(r.pf)} · acheté ${r.t ? esc(ago(r.t)) : ''}</text>`);
    out.push(`<text x="${W - P - 24}" y="${y + 38}" font-size="28" font-weight="800" text-anchor="end" fill="${col(r.ret)}">${esc(sgn(r.ret))}</text>`);
    out.push(`<text x="${W - P - 24}" y="${y + 66}" font-size="18" text-anchor="end" fill="${C.muted}">${esc(r.val)}</text>`);
    y += 96;
  }

  // Derniers ordres
  y += 16;
  out.push(`<text x="${P}" y="${y + 30}" font-size="28" font-weight="800" fill="${C.text}">Derniers achats et ventes</text>`);
  y += 50;
  const trades = [...st.trades.map((t) => ({ ...t, pf: 'Prudent', amount: `${num(t.usd / eurusdGlobal)} €` })), ...cz.trades.map((t) => ({ ...t, pf: 'Casino', amount: `${num(t.usd)} $` }))].sort((p, q) => q.t - p.t).slice(0, 10);
  if (!trades.length) { out.push(`<text x="${P}" y="${y + 28}" font-size="22" fill="${C.muted}">Aucun ordre pour l'instant.</text>`); y += 56; }
  for (const t of trades) {
    const buy = t.side === 'achat';
    const c = buy ? C.up : C.down;
    out.push(`<circle cx="${P + 26}" cy="${y + 32}" r="22" fill="${c}" opacity=".18"/>`);
    out.push(buy ? `<path d="M${P + 26} ${y + 20} l10 14 h-20 z" fill="${c}"/>` : `<path d="M${P + 26} ${y + 44} l10 -14 h-20 z" fill="${c}"/>`);
    out.push(`<text x="${P + 62}" y="${y + 28}" font-size="23" font-weight="700" fill="${C.text}">${buy ? 'Achat' : 'Vente'} ${esc(cut(t.name, 16))}</text>`);
    out.push(`<text x="${P + 62}" y="${y + 54}" font-size="17" fill="${C.muted}">${esc(t.pf)} · ${esc(parisTime(t.t))}${t.reason ? ` · ${esc(cut(t.reason, 34))}` : ''}</text>`);
    out.push(`<text x="${W - P}" y="${y + 28}" font-size="22" font-weight="700" text-anchor="end" fill="${t.ret != null ? col(t.ret) : C.text}">${t.ret != null ? esc(sgn(t.ret)) : esc(t.amount)}</text>`);
    if (t.ret != null) out.push(`<text x="${W - P}" y="${y + 54}" font-size="17" text-anchor="end" fill="${C.muted}">${esc(t.amount)}</text>`);
    y += 72;
  }
  y += 24;
  out.push(`<text x="${W / 2}" y="${y}" font-size="17" text-anchor="middle" fill="${C.muted}">Argent virtuel · aucun ordre réel n'est passé</text>`);
  y += 28;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${y}" width="${W}" height="${y}" font-family="-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif">
<rect width="${W}" height="${y}" fill="${C.bg}"/>
${out.join('\n')}
</svg>
`;
}

main().catch((e) => { console.error(e); process.exit(1); });
