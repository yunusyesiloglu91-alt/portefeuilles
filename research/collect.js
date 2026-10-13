// Recherche : historique minute par minute (GeckoTerminal) de chaque token suivi par le cerveau,
// à partir du moment où il a été observé. Sert à tester des stratégies sur des prix réels.
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'ohlcv');
const obs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'live', 'cerveau-obs.json'), 'utf8')).obs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const todo = Object.entries(obs).filter(([a, o]) => o.pair && !fs.existsSync(path.join(OUT, `${a}.json`)) && Date.now() - o.t > 3 * 3600000);
  console.log('à récupérer', todo.length);
  let ok = 0;
  for (const [a, o] of todo) {
    const before = Math.floor((o.t + 1000 * 60000) / 1000);
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${o.pair}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=${Math.min(before, Math.floor(Date.now() / 1000))}&currency=usd&token=${a}`;
    for (let k = 0; k < 4; k++) {
      const r = await fetch(url).catch(() => null);
      if (r && r.status === 429) { await sleep(20000); continue; }
      if (r && r.ok) {
        const d = await r.json();
        const rows = ((d.data && d.data.attributes.ohlcv_list) || []).map((x) => [x[0] * 1000, +x[1], +x[2], +x[3], +x[4], +x[5]]).sort((x, y) => x[0] - y[0]);
        fs.writeFileSync(path.join(OUT, `${a}.json`), JSON.stringify({ t: o.t, p0: o.p0, f: o.f, name: o.name, rows }));
        ok++;
      } else if (r && r.status === 404) fs.writeFileSync(path.join(OUT, `${a}.json`), JSON.stringify({ t: o.t, p0: o.p0, f: o.f, name: o.name, rows: [] }));
      break;
    }
    await sleep(3200); // ~18 requêtes/min : laisse de la place au robot
  }
  console.log('récupérés', ok);
})();
