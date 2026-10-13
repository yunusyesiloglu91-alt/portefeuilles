// Un passage du robot (Prudent, Casino, Sniper 5 min) lancé depuis le PC par la tâche Windows "Robot portefeuilles".
// Récupère l'état sur la branche "data", fait tourner live/run.js, renvoie l'état. Une seule copie à la fois.
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const REPO = 'yunusyesiloglu91-alt/portefeuilles';
const STATE = path.join(__dirname, 'state.json');
const LOG = path.join(__dirname, 'robot-pc.log');
const log = (m) => fs.appendFileSync(LOG, `[${new Date().toLocaleString('fr-FR')}] ${m}\n`);

const guard = require('net').createServer().on('error', () => process.exit(0));
guard.listen(47124, '127.0.0.1', async () => {
  try {
    const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
    const api = `https://api.github.com/repos/${REPO}/contents/state.json`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
    const cur = await fetch(`${api}?ref=data`, { headers });
    if (!cur.ok) throw new Error(`lecture état ${cur.status}`);
    const meta = await cur.json();
    fs.writeFileSync(STATE, Buffer.from(meta.content, 'base64'));
    const run = spawnSync(process.execPath, [path.join(__dirname, 'run.js')], { encoding: 'utf8', timeout: 4 * 60000 });
    if (run.status !== 0) throw new Error(`passage en échec : ${(run.stderr || '').slice(0, 300)}`);
    const put = await fetch(api, {
      method: 'PUT', headers,
      body: JSON.stringify({ message: 'Robot (PC) : mise à jour', content: fs.readFileSync(STATE).toString('base64'), sha: meta.sha, branch: 'data' }),
    });
    if (!put.ok) throw new Error(`envoi état ${put.status}`);
    log((run.stdout || '').trim());
  } catch (e) {
    log(`ERREUR ${e.message}`);
  }
  process.exit(0);
});
