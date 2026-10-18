// Recherche de portefeuilles « court terme » avec GMGN (lecture seule) : traders « smart money » des tokens en tendance,
// puis leurs statistiques sur 7 jours. On garde ceux qui gardent entre 1 et 30 minutes, gagnent sur 7 jours
// et tradent à un rythme qu'on peut suivre (15 à 300 tokens par semaine).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = path.join(__dirname, '..', 'live', '.env');
const KEY = process.env.GMGN_API_KEY || (fs.existsSync(env) && (fs.readFileSync(env, 'utf8').match(/^GMGN_API_KEY=(.+)$/m) || [])[1]) || 'gmgn_solbscbaseethmonadtron';
function cli(args) {
  for (let k = 0; k < 4; k++) {
    try { return JSON.parse(execFileSync('gmgn-cli', args, { env: { ...process.env, GMGN_API_KEY: KEY.trim() }, encoding: 'utf8', timeout: 40000, shell: true, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* limite de débit */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500 * (k + 1));
  }
  return null;
}
const arr = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);
(() => {
  const tr = cli(['market', 'trending', '--chain', 'sol', '--interval', '1h', '--limit', '30']);
  const tokens = ((tr && tr.data && tr.data.rank) || []).filter((t) => t.liquidity > 15000 && t.market_cap > 50000).slice(0, 12);
  console.log(`${tokens.length} tokens en tendance (1 h) : ${tokens.map((t) => t.symbol).join(', ')}`);
  const by = {};
  for (const t of tokens) {
    for (const tag of ['smart_degen', 'renowned']) {
      const r = cli(['token', 'traders', '--chain', 'sol', '--address', t.address, '--limit', '20', '--order-by', 'profit', '--direction', 'desc', '--tag', tag]);
      for (const x of (r && r.list) || []) {
        if (!x.address || x.addr_type === 2 || x.is_suspicious) continue;
        const tags = [...arr(x.wallet_tag_v2), ...arr(x.tags)].join(',');
        if (/dex_bot|bundler|sniper|rat_trader/i.test(tags)) continue;
        const w = (by[x.address] = by[x.address] || { profit: 0, tokens: new Set(), name: x.name || x.twitter_username || '' });
        w.profit += +x.profit || 0; w.tokens.add(t.symbol);
      }
    }
  }
  const cands = Object.entries(by).sort((a, b) => b[1].profit - a[1].profit).slice(0, 30);
  console.log(`${cands.length} portefeuilles « smart money » candidats. Statistiques sur 7 jours…`);
  const res = [];
  for (const [addr, w] of cands) {
    const e = cli(['portfolio', 'stats', '--chain', 'sol', '--wallet', addr, '--period', '7d']);
    const d = e && (Array.isArray(e) ? e[0] : e.data || e);
    const st = (d && d.pnl_stat) || {};
    res.push({ wallet: addr, nom: w.name, tokens: [...w.tokens].join(','), tokens7j: st.token_num, winrate: st.winrate, detentionSec: st.avg_holding_period, profit7jUsd: d ? Math.round(+d.realized_profit) : null, rendement7j: d ? +(+d.realized_profit_pnl).toFixed(3) : null });
  }
  const good = res.filter((r) => r.detentionSec >= 60 && r.detentionSec <= 1800 && r.winrate >= 0.4 && r.profit7jUsd > 0 && r.tokens7j >= 15 && r.tokens7j <= 300)
    .sort((a, b) => b.profit7jUsd - a.profit7jUsd).slice(0, 3);
  const line = (r) => r.wallet.slice(0, 8) + '… | ' + (r.nom || '-') + ' | ' + r.tokens7j + ' tokens/7 j | réussite ' + (r.winrate != null ? Math.round(r.winrate * 100) + ' %' : '-') + ' | détention ' + (r.detentionSec != null ? (r.detentionSec / 60).toFixed(0) + ' min' : '-') + ' | gain 7 j ' + r.profit7jUsd + ' $';
  for (const r of res.filter((x) => x.tokens7j).sort((a, b) => b.profit7jUsd - a.profit7jUsd).slice(0, 12)) console.log(line(r));
  console.log('\nCourt terme retenus : ' + (good.map((r) => r.wallet.slice(0, 8) + '…').join(', ') || 'aucun'));
  fs.writeFileSync(path.join(__dirname, 'gmgn-court.json'), JSON.stringify({ date: new Date().toISOString(), res, retenus: good }, null, 1));
})();
