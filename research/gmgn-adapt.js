// Mise à jour des portefeuilles suivis : on cherche, parmi les traders rentables des tokens en tendance, ceux qui sont
// ACTIFS en ce moment (dernière transaction récente) et on les classe par durée de détention.
//   court : 2 à 30 min · moyen : 30 min à 12 h · long : plus de 12 h. Tous : gains sur 7 jours, 15 à 200 tokens par semaine.
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
  const tr = cli(['market', 'trending', '--chain', 'sol', '--interval', '24h', '--limit', '40']);
  const tokens = ((tr && tr.data && tr.data.rank) || []).filter((t) => t.liquidity > 20000 && t.market_cap > 80000).slice(0, 10);
  console.log(`${tokens.length} tokens en tendance (24 h) : ${tokens.map((t) => t.symbol).join(', ')}`);
  const by = {};
  for (const t of tokens) {
    for (const extra of [[], ['--tag', 'smart_degen']]) {
      const r = cli(['token', 'traders', '--chain', 'sol', '--address', t.address, '--limit', '25', '--order-by', 'profit', '--direction', 'desc', ...extra]);
      for (const x of (r && r.list) || []) {
        if (!x.address || x.addr_type === 2 || x.is_suspicious) continue;
        const tags = [...arr(x.wallet_tag_v2), ...arr(x.tags)].join(',');
        if (/dex_bot|bundler|sniper|rat_trader|dev/i.test(tags)) continue;
        const w = (by[x.address] = by[x.address] || { profit: 0, n: new Set() });
        w.profit += +x.profit || 0; w.n.add(t.symbol);
      }
    }
  }
  const cands = Object.entries(by).sort((a, b) => b[1].n.size - a[1].n.size || b[1].profit - a[1].profit).slice(0, 30);
  console.log(`${cands.length} portefeuilles candidats. Statistiques sur 7 jours…`);
  const res = [];
  for (const [addr, w] of cands) {
    const e = cli(['portfolio', 'stats', '--chain', 'sol', '--wallet', addr, '--period', '7d']);
    const d = e && (Array.isArray(e) ? e[0] : e.data || e);
    if (!d) continue;
    const st = d.pnl_stat || {};
    res.push({ wallet: addr, sur: w.n.size, tokens7j: st.token_num, winrate: st.winrate, detentionSec: st.avg_holding_period, profit7jUsd: Math.round(+d.realized_profit), inactifH: d.last_timestamp ? +((Date.now() / 1000 - d.last_timestamp) / 3600).toFixed(1) : null });
  }
  const base = (r) => r.profit7jUsd > 0 && r.winrate >= 0.3 && r.tokens7j >= 15 && r.tokens7j <= 200 && r.inactifH != null && r.inactifH <= 6;
  const group = (lo, hi) => res.filter((r) => base(r) && r.detentionSec >= lo && r.detentionSec < hi).sort((a, b) => b.profit7jUsd - a.profit7jUsd).slice(0, 3);
  const court = group(120, 1800), moyen = group(1800, 43200), long = group(43200, 1e9);
  const show = (n, a) => console.log(`${n} : ` + (a.map((r) => `${r.wallet.slice(0, 8)}… (${(r.detentionSec / 3600).toFixed(1)} h, ${Math.round(r.winrate * 100)} %, ${r.tokens7j} tokens/7 j, +${r.profit7jUsd} $, actif il y a ${r.inactifH} h)`).join(' | ') || 'aucun'));
  show('court', court); show('moyen', moyen); show('long', long);
  fs.writeFileSync(path.join(__dirname, 'gmgn-adapt.json'), JSON.stringify({ date: new Date().toISOString(), res, court, moyen, long }, null, 1));
})();
