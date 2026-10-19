// 📈 Stratégie « cassure de l'ATH » (idée de la vidéo : trader les runners déjà migrés, entrer quand le token
// repasse au-dessus de son plus haut après un repli, sortir par paliers).
//   - Univers : tokens Solana déjà sortis de pump.fun (migrés), market cap 100–450 k$ au moment de la cassure.
//   - Signal : le token a reculé d'au moins 22 % depuis son plus haut, puis repasse au-dessus de ce plus haut.
//   - Niveau (nombre de « smart money » sur le token, donnée GMGN) : 1–2 → niveau 1, 3–5 → niveau 2, 6 et + → niveau 3.
//   - Mise : 5 $ / 10 $ / 15 $. Stop : −10 % (niveaux 1 et 2), −20 % (niveau 3), remonté au prix d'achat après ×1,3.
//   - Sorties : niveau 1 → tout à ×2 ; niveaux 2 et 3 → la moitié à ×2 (on récupère la mise), puis 25 % (niveau 2) ou
//     15 % (niveau 3) du reste à chaque nouvelle hausse de 30 %, tout si le prix retombe de 35 % sous son plus haut.
// Données : GMGN (lecture seule) pour le classement, DexScreener pour le prix d'exécution.
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const env = path.join(__dirname, '.env');
const KEY = (fs.existsSync(env) && (fs.readFileSync(env, 'utf8').match(/^GMGN_API_KEY=(.+)$/m) || [])[1]) || 'gmgn_solbscbaseethmonadtron';
const run = (cmd) => new Promise((res) => exec(cmd, { env: { ...process.env, GMGN_API_KEY: KEY.trim() }, timeout: 30000, maxBuffer: 20e6 }, (e, out) => { try { res(JSON.parse(out)); } catch { res(null); } }));

const LEVELS = { 1: { stake: 5, sl: 0.9, step: 1 }, 2: { stake: 8, sl: 0.9, step: 0.25 }, 3: { stake: 10, sl: 0.8, step: 0.15 } };
const levelOf = (n) => (n >= 6 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0);

function create({ st, id, log, dexPrices, buy, sell, maxOpen = 6 }) {
  const watch = new Map(); // adresse -> { ath, pulledAt, last }
  const entered = new Map(); // adresse -> heure de la dernière entrée
  let scanning = false, managing = false;
  const note = (symbol, ok, why) => { st.breakoutRecent = (st.breakoutRecent || []).concat([{ t: Date.now(), symbol, ok, why }]).slice(-20); };

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const r = await run('gmgn-cli market trending --chain sol --interval 6h --limit 100 --order-by volume --min-marketcap 40000 --max-marketcap 800000 --min-liquidity 15000 --platform Pump.fun');
      const rows = (r && r.data && r.data.rank) || [];
      const now = Date.now();
      for (const t of rows) {
        const mc = +t.market_cap, addr = t.address;
        if (!(mc > 0) || !addr) continue;
        const migrated = t.migrated_pool_exchange || /complet|migrat/i.test(t.launchpad_status || '');
        if (!migrated || mc < 40e3 || mc > 800e3) continue;
        const w = watch.get(addr) || { ath: Math.max(+t.history_highest_market_cap || 0, mc), pulledAt: 0, symbol: t.symbol };
        if (!watch.has(addr)) { w.ath = Math.max(w.ath, mc); watch.set(addr, w); }
        w.symbol = t.symbol;
        w.mc = mc;
        if (mc > w.ath) {
          const prev = w.ath;
          const ready = w.pulledAt && now - w.pulledAt >= 90000 && prev >= 100e3 && mc >= 100e3 && mc <= 450e3;
          w.ath = mc; w.pulledAt = 0;
          if (ready) await tryEnter(t, mc, prev);
        } else if (mc <= 0.78 * w.ath && !w.pulledAt) w.pulledAt = now;
        else if (mc > 0.9 * w.ath && w.pulledAt && now - w.pulledAt > 20 * 60000) w.pulledAt = 0; // repli trop ancien
      }
      for (const [a, w] of watch) if (!rows.some((t) => t.address === a) && !w.keep) { w.miss = (w.miss || 0) + 1; if (w.miss > 40) watch.delete(a); }
      st.breakoutWatch = [...watch.values()].filter((w) => w.pulledAt).slice(0, 8).map((w) => ({ symbol: w.symbol, mc: Math.round(w.mc), ath: Math.round(w.ath) }));
    } catch (e) { log('cassure : ' + e.message); }
    scanning = false;
  }

  async function tryEnter(t, mc, prevAth) {
    const sym = t.symbol || t.name;
    const v = st.variants[id];
    if (now() - (entered.get(t.address) || 0) < 6 * 3600000) return;
    const lvl = levelOf(+t.smart_degen_count || 0);
    const why = [];
    if (!lvl) why.push('aucun « smart money » sur le token');
    if (t.is_wash_trading) why.push('volume truqué (wash trading)');
    if (t.is_honeypot) why.push('honeypot');
    if (+t.rug_ratio > 0.35) why.push(`risque de rug ${(+t.rug_ratio).toFixed(2)}`);
    if (+t.liquidity / mc < 0.25) why.push(`liquidité faible (${Math.round((+t.liquidity / mc) * 100)} % de la market cap)`);
    if (+t.bundler_rate > 0.4) why.push(`bundlers ${Math.round(+t.bundler_rate * 100)} %`);
    if (v.positions.filter((p) => p.breakout).length >= maxOpen) why.push('trop de positions ouvertes');
    if (v.cash < LEVELS[lvl || 1].stake) why.push('plus assez de cash');
    if (why.length) { note(sym, false, `cassure à ${Math.round(mc / 1e3)} k$ refusée : ${why[0]}`); return; }
    entered.set(t.address, now());
    note(sym, true, `cassure de ${Math.round(prevAth / 1e3)} k$ → ${Math.round(mc / 1e3)} k$, niveau ${lvl} (${t.smart_degen_count} smart money)`);
    await buy(t.address, `cassure de l'ATH ${Math.round(prevAth / 1e3)} k$ après repli, niveau ${lvl} (${t.smart_degen_count} smart money)`, LEVELS[lvl].stake, { breakout: true, lvl, entryMc: mc });
  }
  const now = () => Date.now();

  // Gestion des positions ouvertes, toutes les 8 s
  async function manage() {
    if (managing) return;
    managing = true;
    try {
      const v = st.variants[id];
      const open = v.positions.filter((p) => p.breakout && !p.selling);
      if (!open.length) { managing = false; return; }
      const prices = await dexPrices(open.map((p) => p.mint));
      for (const p of open) {
        const d = prices[p.mint];
        if (!d) continue;
        p.last = d.price;
        p.peak = Math.max(p.peak || 0, d.price);
        const L = LEVELS[p.lvl];
        const m = p.last / p.entry;
        p.step = p.step || 0;
        const stop = p.be ? 1.0 : L.sl;
        if (m <= stop) { await sell(p, 1, p.be ? 'stop au prix d’achat' : `stop −${Math.round((1 - L.sl) * 100)} %`); continue; }
        if (p.lvl === 1) { if (m >= 2) await sell(p, 1, 'objectif ×2 (niveau 1)'); }
        else if (p.step === 0) { if (m >= 2) { p.step = 1; p.lastM = m; p.be = true; await sell(p, 0.5, 'palier ×2 : la mise est récupérée (50 %)'); } }
        else if (m >= (p.lastM || 2) * 1.3) { p.lastM = m; p.step++; await sell(p, L.step, `nouvelle hausse de 30 % : on prend ${Math.round(L.step * 100)} %`); }
        else if (p.last <= p.peak * 0.65) await sell(p, 1, 'tendance inversée (−35 % sous le plus haut)');
        if (now() - p.t >= 24 * 3600000 && !p.selling) await sell(p, 1, '24 h écoulées');
      }
    } catch (e) { log('cassure (gestion) : ' + e.message); }
    managing = false;
  }
  return { scan, manage, watch };
}

module.exports = { create, levelOf };
