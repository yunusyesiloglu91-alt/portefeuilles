// Prix réels pump.fun, lus directement sur la blockchain Solana (compte « bonding curve » de chaque token).
// La courbe est un échange automatique à produit constant sur des réserves virtuelles :
// on peut donc calculer EXACTEMENT ce qu'un ordre aurait reçu à un instant donné, impact de notre ordre compris.
const RPC = 'https://api.mainnet-beta.solana.com';
// Secours : nœud Tatum (clé gratuite dans live/.env, jamais publiée), utilisé seulement quand le serveur public refuse
const TATUM = 'https://solana-mainnet.gateway.tatum.io';
let TATUM_KEY = '';
try { TATUM_KEY = (require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').match(/^TATUM_API_KEY=(.+)$/m) || [])[1] || ''; } catch { /* pas de clé */ }
const usage = { public: 0, tatum: 0, failed: 0 };
async function rpcCall(body) {
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000), body });
    if (r.ok) { const j = await r.json(); if (j.result !== undefined) { usage.public++; return j; } }
  } catch { /* on passe au secours */ }
  if (TATUM_KEY) {
    try {
      const r = await fetch(TATUM, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': TATUM_KEY.trim() }, signal: AbortSignal.timeout(4000), body });
      if (r.ok) { const j = await r.json(); if (j.result !== undefined) { usage.tatum++; return j; } }
    } catch { /* les deux ont échoué */ }
  }
  usage.failed++;
  throw new Error('RPC indisponible');
}
const FEE = 0.0125; // frais pump.fun sur la courbe : 0,95 % plateforme + 0,30 % créateur

// Lit plusieurs courbes en un seul appel (jusqu'à 100). Renvoie { clé: { vT, vS, rS, complete } } ; vT en jetons, vS et rS en SOL.
async function read(keys) {
  const out = {};
  for (let k = 0; k < keys.length; k += 100) {
    const j = await rpcCall(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys.slice(k, k + 100), { encoding: 'base64', commitment: 'processed' }] }));
    j.result.value.forEach((acc, i) => {
      if (!acc) return; // compte introuvable
      const b = Buffer.from(acc.data[0], 'base64');
      // rS = SOL réellement déposés par les acheteurs (les réserves « virtuelles » dépendent du réglage de la courbe)
      out[keys[k + i]] = { vT: Number(b.readBigUInt64LE(8)) / 1e6, vS: Number(b.readBigUInt64LE(16)) / 1e9, rS: Number(b.readBigUInt64LE(32)) / 1e9, rT: Number(b.readBigUInt64LE(24)) / 1e6, complete: b[48] === 1 };
    });
  }
  return out;
}

// Achat de solIn SOL sur la courbe c : jetons reçus, frais payés, et nouvel état de la courbe après notre ordre
function buyQuote(c, solIn) {
  const net = solIn * (1 - FEE);
  const tokens = c.vT - (c.vS * c.vT) / (c.vS + net);
  return { tokens, feeSol: solIn * FEE, after: { vT: c.vT - tokens, vS: c.vS + net } };
}

// Vente de `tokens` jetons sur la courbe c : SOL reçus après frais
function sellQuote(c, tokens) {
  const gross = c.vS - (c.vS * c.vT) / (c.vT + tokens);
  return { sol: gross * (1 - FEE), feeSol: gross * FEE };
}

const mid = (c) => c.vS / c.vT; // prix instantané d'un jeton, en SOL

async function rpc(method, params) {
  const j = await rpcCall(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  return j.result;
}

module.exports = { read, buyQuote, sellQuote, mid, FEE, usage, rpc };
