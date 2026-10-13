// Sniper en continu sur le PC : prix et sorties chaque seconde, recherche de nouveaux tokens toutes les 5 s.
// Remplace le passage toutes les 5 min. État local live/sniper5-state.json, publié chaque minute
// sur la branche "sniper" (fichier sniper5.json) pour le site. Une seule copie à la fois (port 47125).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSniper } = require('./sniper.js');

const REPO = 'yunusyesiloglu91-alt/portefeuilles';
const FILE = path.join(__dirname, 'sniper5-state.json');
const LOG = path.join(__dirname, 'sniper-loop.log');
const FAST = 1000, SCAN = 5000, PUB = 30000; // prix chaque seconde, nouveaux tokens toutes les 5 s, site toutes les 30 s
const log = (m) => fs.appendFileSync(LOG, `[${new Date().toLocaleString('fr-FR')}] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = '';
const headers = () => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' });

async function bootstrap() {
  if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  // Premier démarrage : reprend le sniper là où le robot 5 min l'avait laissé
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/state.json?ref=data`, { headers: { ...headers(), Accept: 'application/vnd.github.raw+json' } });
  const st = r.ok ? await r.json() : {};
  log(`démarrage à partir de l'état du robot 5 min (${st.sniper ? 'trouvé' : 'vide'})`);
  return { sniper: st.sniper };
}

let sha = null;
async function publish(st) {
  const api = `https://api.github.com/repos/${REPO}/contents/sniper5.json`;
  if (!sha) { const cur = await fetch(`${api}?ref=sniper`, { headers: headers() }); if (cur.ok) sha = (await cur.json()).sha; }
  const body = { message: 'Sniper (PC) : mise à jour', content: Buffer.from(JSON.stringify({ ...st.sniper, seen: undefined, gtNp: undefined, brainCache: undefined, lastRun: Date.now() })).toString('base64'), branch: 'sniper' };
  if (sha) body.sha = sha;
  const put = await fetch(api, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  if (put.ok) sha = (await put.json()).content.sha;
  else { sha = null; throw new Error(`publication ${put.status}`); }
}

const guard = require('net').createServer().on('error', () => process.exit(0));
guard.listen(47125, '127.0.0.1', async () => {
  token = execSync('gh auth token', { encoding: 'utf8' }).trim();
  const st = await bootstrap();
  log('sniper en continu démarré');
  let lastScan = 0, lastPub = 0;
  for (;;) {
    const now = Date.now();
    const scan = now - lastScan >= SCAN;
    try {
      const notes = await runSniper(st, now, { exitsOnly: !scan });
      if (scan) lastScan = now;
      const shown = notes.filter((n) => !/aucun lancement/.test(n));
      if (shown.length) log(shown.join(' · '));
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(st)); fs.renameSync(`${FILE}.tmp`, FILE);
    } catch (e) { log(`ERREUR ${e.message}`); }
    if (Date.now() - lastPub >= PUB) {
      try { await publish(st); lastPub = Date.now(); } catch (e) { log(`ERREUR ${e.message}`); }
    }
    await sleep(Math.max(100, FAST - (Date.now() - now)));
  }
});
