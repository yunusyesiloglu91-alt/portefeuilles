// 📋 Rapport automatique après chaque trade fermé : ce qui s'est passé, pourquoi, et la leçon.
// Les diagnostics sont comptés : s'ils se répètent, le cerveau (et toi) savez quoi corriger.
const fs = require('fs');
const path = require('path');
const VAULT = path.join(__dirname, '..', 'cerveau', 'Rapports');

const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))} %`;
const dur = (ms) => (ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1).replace('.', ',')} h`);

function diagnose(t) {
  const peak = t.peak || 1, win = t.ret > 0;
  if (/main/.test(t.reason)) return { code: 'manuel', txt: 'Vendu à la main.', fix: 'Comparer avec ce que le robot aurait fait.' };
  if (!win && peak < 1.1) return { code: 'entree', txt: `N'a jamais vraiment monté (sommet ×${peak.toFixed(2)}).`, fix: 'Mauvaise entrée : ce profil de token est à filtrer.' };
  if (!win && peak >= 1.3) return { code: 'rendu', txt: `Est monté jusqu'à ×${peak.toFixed(2)} puis a tout rendu.`, fix: 'Sortie trop tardive : prendre une partie du gain plus tôt.' };
  if (!win && t.held < 5 * 60000) return { code: 'rug', txt: `Chute brutale en ${dur(t.held)}.`, fix: 'Probable vente massive du créateur ou des gros portefeuilles : surveiller le top 10.' };
  if (!win) return { code: 'lent', txt: 'A baissé doucement sans jamais décoller.', fix: 'Manque d’élan à l’achat : exiger plus d’acheteurs.' };
  const kept = (t.ret + 1) / peak;
  if (peak >= 3 && kept < 0.5) return { code: 'tot', txt: `Gain pris, mais le token est allé jusqu'à ×${peak.toFixed(1)}.`, fix: 'Vendu trop tôt : laisser courir une partie plus longtemps.' };
  return { code: 'bon', txt: `Bonne sortie (sommet ×${peak.toFixed(2)}).`, fix: 'Rien à changer.' };
}

function profile(f) {
  if (!f) return '';
  const k = (x) => (x >= 1e3 ? `${Math.round(x / 1e3)} k$` : `${Math.round(x)} $`);
  return [`${f.ageMin} min`, `mcap ${k(f.mcap)}`, `liquidité ${k(f.liq)}`, `${f.buys}/${f.sells} achats/ventes`, f.twitter ? 'Twitter ✓' : 'sans Twitter',
    f.creatorPct != null ? `créateur ${f.creatorPct.toFixed(1)} %` : '', f.top10 != null ? `top 10 ${Math.round(f.top10)} %` : '', f.holders != null ? `${f.holders} détenteurs` : ''].filter(Boolean).join(', ');
}

// Crée le rapport, l'ajoute au carnet Obsidian du jour et au résumé publié sur le site
function report(S, id, t) {
  const d = diagnose(t);
  const r = { t: t.t, id, name: t.name, ret: +t.ret.toFixed(3), held: t.held || 0, peak: +(t.peak || 1).toFixed(2), code: d.code, txt: d.txt, fix: d.fix, profile: profile(t.f), brain: t.f && t.f.brain };
  S.reports = (S.reports || []).concat([r]).slice(-40);
  S.diag = S.diag || {};
  S.diag[d.code] = (S.diag[d.code] || 0) + 1;
  try {
    fs.mkdirSync(VAULT, { recursive: true });
    const day = new Date(t.t).toISOString().slice(0, 10);
    const file = path.join(VAULT, `${day}.md`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# Rapports du ${day}\n\nRetour : [[Accueil]] · [[Leçons]]\n`);
    fs.appendFileSync(file, `\n## ${t.ret > 0 ? '✅' : '❌'} ${t.name} ${pct(t.ret)} — ${id} — ${new Date(t.t).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })}
- Gardé ${dur(t.held || 0)}, sommet ×${(t.peak || 1).toFixed(2)}, sortie : ${t.reason}
- À l'achat : ${r.profile || 'inconnu'}${r.brain ? `\n- Pourquoi acheté : ${r.brain}` : ''}
- Diagnostic : ${d.txt}
- Leçon : ${d.fix}
`);
  } catch { /* le carnet n'est pas indispensable */ }
  return r;
}

// Conseil global à partir des diagnostics qui se répètent
function advice(S) {
  const d = S.diag || {}, n = Object.values(d).reduce((a, x) => a + x, 0);
  if (n < 5) return null;
  const top = Object.entries(d).filter(([k]) => k !== 'bon' && k !== 'manuel').sort((a, b) => b[1] - a[1])[0];
  if (!top) return 'Les sorties sont bonnes : on garde les réglages.';
  const msg = { entree: 'La plupart des pertes viennent de tokens qui ne montent jamais : le cerveau va durcir les filtres d’entrée.',
    rendu: 'Beaucoup de gains rendus : le cerveau va tester une prise de gain plus tôt.',
    rug: 'Beaucoup de chutes brutales : attention aux tokens où les 10 plus gros portefeuilles pèsent lourd.',
    lent: 'Beaucoup de tokens sans élan : exiger plus d’acheteurs au moment de l’achat.',
    tot: 'Souvent vendu trop tôt : laisser courir une plus grosse partie.' };
  return `${msg[top[0]]} (${top[1]} cas sur ${n} trades analysés)`;
}

module.exports = { report, advice };
