// Prix réels pump.fun, lus directement sur la blockchain Solana (compte « bonding curve » de chaque token).
// La courbe est un échange automatique à produit constant sur des réserves virtuelles :
// on peut donc calculer EXACTEMENT ce qu'un ordre aurait reçu à un instant donné, impact de notre ordre compris.
const RPC = 'https://api.mainnet-beta.solana.com';
const FEE = 0.0125; // frais pump.fun sur la courbe : 0,95 % plateforme + 0,30 % créateur

// Lit plusieurs courbes en un seul appel (jusqu'à 100). Renvoie { clé: { vT, vS, complete } } ; vT en jetons, vS en SOL.
async function read(keys) {
  const out = {};
  for (let k = 0; k < keys.length; k += 100) {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys.slice(k, k + 100), { encoding: 'base64', commitment: 'processed' }] }),
    });
    if (!r.ok) throw new Error(`RPC ${r.status}`);
    const j = await r.json();
    if (!j.result) throw new Error('RPC sans résultat');
    j.result.value.forEach((acc, i) => {
      if (!acc) return; // compte introuvable
      const b = Buffer.from(acc.data[0], 'base64');
      out[keys[k + i]] = { vT: Number(b.readBigUInt64LE(8)) / 1e6, vS: Number(b.readBigUInt64LE(16)) / 1e9, complete: b[48] === 1 };
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

module.exports = { read, buyQuote, sellQuote, mid, FEE };
