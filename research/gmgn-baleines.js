// 🐋 Grande recherche de baleines : on balaie les meilleurs traders de ~40 tokens en tendance (1 h, 6 h, 24 h),
// en tout plusieurs centaines de portefeuilles, puis on garde ceux qui gagnent sur 7 ET 30 jours, encore actifs,
// et on les classe par durée de détention : court (2–30 min), moyen (30 min–12 h), long (> 12 h).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = path.join(__dirname, '..', 'live', '.env');
const KEY = process.env.GMGN_API_KEY || (fs.existsSync(env) && (fs.readFileSync(env, 'utf8').match(/^GMGN_API_KEY=(.+)$/m) || [])[1]) || 'gmgn_solbscbaseethmonadtron';
function cli(args) {
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let k = 0; k < 3; k++) {
    sleep(1500); // pause entre appels : sinon GMGN bannit l'IP
    try { return JSON.parse(execFileSync('gmgn-cli', args, { env: { ...process.env, GMGN_API_KEY: KEY.trim() }, encoding: 'utf8', timeout: 40000, shell: true, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* limite de débit */ }
    sleep(30000 * (k + 1));
  }
  return null;
}
const arr = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);
const MAX_STATS = +(process.argv[2] || 120);
(() => {
  const toks = new Map();
  for (const iv of ['1h', '6h', '24h']) {
    const tr = cli(['market', 'trending', '--chain', 'sol', '--interval', iv, '--limit', '100']);
    for (const t of (tr && tr.data && tr.data.rank) || []) if (t.liquidity > 15000 && t.market_cap > 50000 && !toks.has(t.address)) toks.set(t.address, t);
  }
  const tokens = [...toks.values()].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 40);
  console.log(`${tokens.length} tokens étudiés`);
  const by = {};
  let seen = 0;
  for (const t of tokens) {
    for (const extra of [[], ['--tag', 'smart_degen']]) {
      const r = cli(['token', 'traders', '--chain', 'sol', '--address', t.address, '--limit', '50', '--order-by', 'profit', '--direction', 'desc', ...extra]);
      for (const x of (r && r.list) || []) {
        seen++;
        if (!x.address || x.addr_type === 2 || x.is_suspicious) continue;
        const tags = [...arr(x.wallet_tag_v2), ...arr(x.tags)].join(',');
        if (/dex_bot|bundler|sniper|rat_trader|dev/i.test(tags)) continue;
        const w = (by[x.address] = by[x.address] || { profit: 0, n: new Set() });
        w.profit += +x.profit || 0; w.n.add(t.symbol);
      }
    }
  }
  const all = Object.entries(by);
  console.log(`${seen} lignes de traders, ${all.length} portefeuilles uniques`);
  const cands = all.filter(([, w]) => w.profit > 0).sort((a, b) => b[1].n.size - a[1].n.size || b[1].profit - a[1].profit).slice(0, MAX_STATS);
  console.log(`${cands.length} candidats : statistiques 7 j et 30 j…`);
  const res = [];
  for (const [addr, w] of cands) {
    const e7 = cli(['portfolio', 'stats', '--chain', 'sol', '--wallet', addr, '--period', '7d']);
    const d = e7 && (Array.isArray(e7) ? e7[0] : e7.data || e7);
    if (!d || !(+d.realized_profit > 0)) continue;
    const e30 = cli(['portfolio', 'stats', '--chain', 'sol', '--wallet', addr, '--period', '30d']);
    const d30 = e30 && (Array.isArray(e30) ? e30[0] : e30.data || e30);
    const s = d.pnl_stat || {};
    res.push({ wallet: addr, sur: w.n.size, tokens7j: s.token_num, winrate: s.winrate, detentionSec: s.avg_holding_period,
      profit7jUsd: Math.round(+d.realized_profit), profit30jUsd: d30 ? Math.round(+d30.realized_profit) : null,
      winrate30: d30 && d30.pnl_stat ? d30.pnl_stat.winrate : null,
      inactifH: d.last_timestamp ? +((Date.now() / 1000 - d.last_timestamp) / 3600).toFixed(1) : null });
  }
  // Baleine fiable : gagne sur 7 j et 30 j, réussite ≥ 35 %, pas un robot (≤ 250 tokens/7 j), active depuis ≤ 12 h
  const ok = (r) => r.profit30jUsd > 0 && r.winrate >= 0.35 && (r.winrate30 == null || r.winrate30 >= 0.3) && r.tokens7j >= 5 && r.tokens7j <= 250 && r.inactifH != null && r.inactifH <= 12;
  const score = (r) => r.profit30jUsd + 2 * r.profit7jUsd;
  const group = (lo, hi, n) => res.filter((r) => ok(r) && r.detentionSec >= lo && r.detentionSec < hi).sort((a, b) => score(b) - score(a)).slice(0, n);
  const court = group(120, 1800, 3), moyen = group(1800, 43200, 4), long = group(43200, 1e9, 4);
  const show = (n, a) => console.log(`${n} : ` + (a.map((r) => `${r.wallet.slice(0, 8)} (${(r.detentionSec / 3600).toFixed(1)} h, ${Math.round(r.winrate * 100)} %, 7j +${r.profit7jUsd} $, 30j +${r.profit30jUsd} $, actif il y a ${r.inactifH} h)`).join(' | ') || 'aucun'));
  console.log(`${res.length} portefeuilles gagnants sur 7 j, ${res.filter(ok).length} passent tous les filtres`);
  show('court', court); show('moyen', moyen); show('long', long);
  fs.writeFileSync(path.join(__dirname, 'gmgn-baleines.json'), JSON.stringify({ date: new Date().toISOString(), scannes: all.length, res, court, moyen, long }, null, 1));
})();
