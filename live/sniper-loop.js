// Sniper en continu sur le PC : prix et sorties chaque seconde, recherche de nouveaux tokens toutes les 5 s.
// Remplace le passage toutes les 5 min. État local live/sniper5-state.json, publié chaque minute
// sur la branche "sniper" (fichier sniper5.json) pour le site. Une seule copie à la fois (port 47125).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runSniper, manualSell, apiUsage } = require('./sniper.js');
const Rapport = require('./rapport.js');
const REPORTED = ['qualite', 'cerveau'];

// Notifications et bouton « Vendre » via ntfy.sh (service gratuit de messages, sans compte).
// NOTIF : le PC annonce chaque achat / vente (le site et l'appli ntfy du téléphone l'affichent).
// CMD : le site envoie « vendre tel token », le PC exécute.
const MAIN = 'qualite';
const NOTIF = 'sniper-97f143460ae09334d6';
const CMD = 'sniper-97f143460ae09334d6-cmd';
const DATA = 'sniper-97f143460ae09334d6-data';
const mc = (x) => (!x ? '' : x >= 1e6 ? `${(x / 1e6).toFixed(1).replace('.', ',')} M$` : `${Math.max(5, Math.round(x / 5e3) * 5)} k$`);
const fmt = (p) => (p >= 1 ? p.toFixed(2) : Number(p.toPrecision(3)).toString());
async function notify(t) {
  const buy = t.side === 'achat';
  const title = buy ? `🟢 Achat ${t.name}` : `${t.ret >= 0 ? '💰' : '🔴'} Vente ${t.name} ${t.ret >= 0 ? '+' : ''}${Math.round(t.ret * 100)} %`;
  const message = buy ? `5 $ · market cap ≈ ${mc(t.mcap)} · ${fmt(t.price)} $ le jeton` : `${t.usd.toFixed(2)} $ reçus · market cap ≈ ${mc(t.mcap)} · ${t.reason}`;
  try { await fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify({ topic: DATA, message: JSON.stringify({ ...t, f: undefined }) }) }); } catch { /* pas grave */ }
  try { await fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify({ topic: NOTIF, title, message, tags: [buy ? 'chart_with_upwards_trend' : 'moneybag'] }) }); } catch { /* pas grave */ }
}
const orders = [];
function commands() {
  const ws = new WebSocket(`wss://ntfy.sh/${CMD}/ws`);
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.event !== 'message') return;
      const c = JSON.parse(m.message);
      if (c.action === 'sell' && c.addr && Date.now() - m.time * 1000 < 120000) orders.push(c.addr);
    } catch { /* message ignoré */ }
  };
  ws.onclose = () => setTimeout(commands, 5000);
  ws.onerror = () => { try { ws.close(); } catch { /* déjà fermé */ } };
}

// Flux temps réel gratuit (PumpPortal) : chaque token qui sort de pump.fun nous est signalé à la seconde,
// sans rien demander à personne, donc sans limite. On le garde 3 h dans la liste à analyser.
const pushed = [];
let wsOk = false;
function stream() {
  const ws = new WebSocket('wss://pumpportal.fun/api/data');
  ws.onopen = () => { wsOk = true; ws.send(JSON.stringify({ method: 'subscribeMigration' })); log('flux temps réel pump.fun connecté'); };
  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.mint && !pushed.some((x) => x.mint === d.mint)) pushed.push({ mint: d.mint, t: Date.now() });
    } catch { /* message de service */ }
  };
  ws.onclose = () => { wsOk = false; setTimeout(stream, 5000); };
  ws.onerror = () => { try { ws.close(); } catch { /* déjà fermé */ } };
}

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
  const body = { message: 'Sniper (PC) : mise à jour', content: Buffer.from(JSON.stringify({ ...st.sniper, seen: undefined, gtNp: undefined, pool: undefined, poolSize: Object.keys(st.sniper.pool || {}).length, brainCache: undefined, lastRun: Date.now() })).toString('base64'), branch: 'sniper' };
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
  stream();
  commands();
  let lastScan = 0, lastPub = 0;
  let seenT = Math.max(0, ...st.sniper.variants[MAIN].trades.map((t) => t.t));
  const repT = {};
  for (const id of REPORTED) repT[id] = Math.max(0, ...((st.sniper.variants[id] || { trades: [] }).trades.map((t) => t.t)));
  for (;;) {
    const now = Date.now();
    const scan = now - lastScan >= SCAN;
    try {
      while (pushed.length && now - pushed[0].t > 3 * 3600000) pushed.shift();
      const notes = await runSniper(st, now, { exitsOnly: !scan, pushed });
      while (orders.length) {
        const t = manualSell(st, MAIN, orders.shift());
        if (t) { log(`vente à la main : ${t.name}`); lastPub = 0; }
      }
      for (const t of st.sniper.variants[MAIN].trades) if (t.t > seenT) { seenT = t.t; notify(t); }
      for (const id of REPORTED) {
        const v = st.sniper.variants[id];
        if (!v) continue;
        for (const t of v.trades) if (t.t > repT[id]) {
          repT[id] = t.t;
          if (t.side === 'vente' && !/moitié/.test(t.reason || '')) Rapport.report(st.sniper, id, t);
        }
      }
      st.sniper.advice = Rapport.advice(st.sniper);
      st.sniper.live = { stream: wsOk, pushed: pushed.length, api: apiUsage(), t: now, notif: NOTIF, cmd: CMD };
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
