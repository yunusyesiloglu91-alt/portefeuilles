// Recherche de portefeuilles moyen terme avec les données GMGN (lecture seule, aucune commande d'achat).
// 1. Tokens solana en tendance sur 24 h ; 2. pour chacun, les traders les plus rentables (bénéfice réalisé) ;
// 3. portefeuilles qui reviennent sur plusieurs tokens ; 4. leurs statistiques sur 7 et 30 jours.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const KEY = process.env.GMGN_API_KEY || (fs.existsSync(path.join(__dirname, '..', 'live', '.env')) && (fs.readFileSync(path.join(__dirname, '..', 'live', '.env'), 'utf8').match(/^GMGN_API_KEY=(.+)$/m) || [])[1]) || 'gmgn_solbscbaseethmonadtron';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cli(args) {
  for (let k = 0; k < 4; k++) {
    try {
      const out = execFileSync('gmgn-cli', args, { env: { ...process.env, GMGN_API_KEY: KEY.trim() }, encoding: 'utf8', timeout: 40000, shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return JSON.parse(out);
    } catch { /* limite de débit ou réseau : on attend */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500 * (k + 1));
  }
  return null;
}

(async () => {
  const tr = cli(['market', 'trending', '--chain', 'sol', '--interval', '24h', '--limit', '40']);
  const tokens = ((tr && tr.data && tr.data.rank) || []).filter((t) => t.liquidity > 20000 && t.market_cap > 100000).slice(0, 14);
  console.log(`${tokens.length} tokens en tendance : ${tokens.map((t) => t.symbol).join(', ')}`);
  const by = {};
  for (const t of tokens) {
    const r = cli(['token', 'traders', '--chain', 'sol', '--address', t.address, '--limit', '30', '--order-by', 'profit', '--direction', 'desc']);
    for (const x of (r && r.list) || []) {
      if (!x.address || x.addr_type === 2 || x.is_suspicious) continue; // pas les pools, pas les suspects
      const arr = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);
      const tags = [...arr(x.wallet_tag_v2), ...arr(x.tags)].join(',');
      if (/dex_bot|bundler|sniper|rat_trader|dev/i.test(tags)) continue; // robots, initiés
      const w = (by[x.address] = by[x.address] || { n: 0, profit: 0, tokens: [], tags: new Set() });
      w.n++; w.profit += +x.profit || 0; w.tokens.push(t.symbol); (Array.isArray(x.wallet_tag_v2) ? x.wallet_tag_v2 : []).forEach((g) => w.tags.add(g));
    }
    await sleep(600);
  }
  const ranked = Object.entries(by).filter(([, w]) => w.n >= 2 && w.profit > 500).sort((a, b) => b[1].n - a[1].n || b[1].profit - a[1].profit).slice(0, 25);
  console.log(`${ranked.length} portefeuilles rentables sur au moins 2 tokens. Statistiques…`);
  const res = [];
  for (const [addr, w] of ranked) {
    const s = cli(['portfolio', 'stats', '--chain', 'sol', '--wallet', addr, '--period', '7d']);
    const d = s && (Array.isArray(s) ? s[0] : s.data || s);
    const st = d && (d.pnl_stat || d.stats || d);
    res.push({ wallet: addr, sur: w.n, tokens: w.tokens.join(','), profitUsd: Math.round(w.profit), tags: [...w.tags].join(','), stats7d: st });
    await sleep(500);
  }
  fs.writeFileSync(path.join(__dirname, 'gmgn-moyen.json'), JSON.stringify({ date: new Date().toISOString(), tokens: tokens.map((t) => t.symbol), res }, null, 1));
  for (const r of res) console.log(`${r.wallet.slice(0, 8)}… | sur ${r.sur} tokens (${r.tokens}) | bénéfice ${r.profitUsd} $ | ${r.tags}`);
})();
