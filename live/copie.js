// 👥 Copie de portefeuilles gagnants : le robot est prévenu à chaque transaction des portefeuilles suivis
// (abonnement « logsSubscribe » au nœud Solana public, gratuit), lit la transaction, et en déduit
// achat / vente d'un token pump.fun et la part vendue. Il suit aussi l'argent : si un portefeuille suivi
// envoie au moins 1 SOL vers une nouvelle adresse, cette adresse est suivie à son tour.
const WS_URL = 'wss://api.mainnet-beta.solana.com';
const { PublicKey } = require('@solana/web3.js');
const WSOL = 'So11111111111111111111111111111111111111112';
const onCurve = (a) => { try { return PublicKey.isOnCurve(new PublicKey(a).toBytes()); } catch { return false; } };
const IGNORE = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNyFzTcFDhpGN6c3Jn']);

function create({ rpc, onTrade, onNewWallet, log }) {
  let ws = null;
  const wallets = new Map(); // adresse -> groupe (« court » / « moyen »)
  const subs = new Map(); // id de requête -> adresse
  let nextId = 1;
  const seen = new Set();

  function subscribe(addr) {
    if (!ws || ws.readyState !== 1) return;
    const id = nextId++;
    subs.set(id, addr);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [addr] }, { commitment: 'confirmed' }] }));
  }
  const subOf = {}; // id d'abonnement -> adresse
  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { for (const a of wallets.keys()) subscribe(a); log(`copie : ${wallets.size} portefeuilles suivis`); };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && subs.has(m.id) && m.result != null) { subOf[m.result] = subs.get(m.id); return; }
      if (m.method !== 'logsNotification') return;
      const addr = subOf[m.params.subscription];
      const v = m.params.result.value;
      if (!addr || v.err || seen.has(v.signature)) return;
      seen.add(v.signature);
      if (seen.size > 5000) seen.clear();
      handle(addr, v.signature).catch(() => {});
    };
    ws.onclose = () => setTimeout(connect, 3000);
    ws.onerror = () => { try { ws.close(); } catch { /* déjà fermé */ } };
    // Le nœud public coupe les connexions inactives : petit signe de vie
    const ping = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'getHealth' })); else clearInterval(ping); }, 30000);
  }

  async function handle(addr, sig) {
    let t = null;
    for (let k = 0; k < 5 && !t; k++) {
      t = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      if (!t) await new Promise((r) => setTimeout(r, 400));
    }
    if (!t || t.meta.err) return;
    const keys = t.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    if (keys[0] !== addr) return; // seulement les transactions signées par le portefeuille suivi
    const i = keys.indexOf(addr);
    const pre = {}, post = {};
    for (const b of t.meta.preTokenBalances || []) if (b.owner === addr) pre[b.mint] = +b.uiTokenAmount.uiAmountString || 0;
    for (const b of t.meta.postTokenBalances || []) if (b.owner === addr) post[b.mint] = +b.uiTokenAmount.uiAmountString || 0;
    // SOL natif + SOL « emballé » (WSOL) : certaines ventes sont payées en WSOL
    const sol = (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9 + ((post[WSOL] || 0) - (pre[WSOL] || 0));
    let traded = false;
    // 🐋 Baleine qui déplace ses tokens vers un autre portefeuille (sans SOL échangé) : on suit le nouveau portefeuille,
    // pour copier ses ventes de là-bas (sinon on ne verrait jamais la vente).
    if (Math.abs(sol) < 0.05) {
      for (const mint of Object.keys(pre)) {
        if (IGNORE.has(mint) || (post[mint] || 0) >= pre[mint] - 1e-6) continue;
        const gain = {};
        for (const b of t.meta.postTokenBalances || []) if (b.mint === mint && b.owner && b.owner !== addr) gain[b.owner] = +b.uiTokenAmount.uiAmountString || 0;
        for (const b of t.meta.preTokenBalances || []) if (b.mint === mint && gain[b.owner] != null) gain[b.owner] -= +b.uiTokenAmount.uiAmountString || 0;
        const moved = pre[mint] - (post[mint] || 0);
        for (const [to, g] of Object.entries(gain)) {
          // Seulement un vrai portefeuille (adresse « sur la courbe ») : jamais une pool ou un programme
          if (g >= moved * 0.5 && !wallets.has(to) && onCurve(to)) { traded = true; onNewWallet({ from: addr, to, sol: 0, mint, tokens: true, group: wallets.get(addr) }); }
        }
      }
    }
    for (const mint of new Set([...Object.keys(pre), ...Object.keys(post)])) {
      if (IGNORE.has(mint) || Math.abs(sol) < 0.05) continue; // SOL / stablecoins et poussières
      const a = pre[mint] || 0, b = post[mint] || 0;
      if (Math.abs(b - a) < 1e-6) continue;
      traded = true;
      if (b > a) onTrade({ wallet: addr, group: wallets.get(addr), side: 'achat', mint, sol: -sol, sig });
      else onTrade({ wallet: addr, group: wallets.get(addr), side: 'vente', mint, part: a > 0 ? Math.min(1, (a - b) / a) : 1, sol, sig });
    }
    // Suivre l'argent : envoi d'au moins 1 SOL vers une adresse qui n'est pas encore suivie
    if (!traded && sol <= -1) {
      for (const ins of t.transaction.message.instructions || []) {
        const p = ins.parsed;
        if (ins.program === 'system' && p && p.type === 'transfer' && p.info.source === addr && p.info.lamports >= 1e9 && !wallets.has(p.info.destination) && onCurve(p.info.destination)) {
          onNewWallet({ from: addr, to: p.info.destination, sol: p.info.lamports / 1e9, group: wallets.get(addr) });
        }
      }
    }
  }

  return {
    start(list) { for (const { wallet, group } of list) wallets.set(wallet, group); connect(); },
    add(wallet, group) { if (wallets.has(wallet)) return false; wallets.set(wallet, group); subscribe(wallet); return true; },
    list() { return [...wallets.entries()].map(([wallet, group]) => ({ wallet, group })); },
  };
}

module.exports = { create };
