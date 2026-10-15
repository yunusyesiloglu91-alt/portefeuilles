// 📰 Actualités du moment (Google Actualités, flux RSS gratuits) pour la stratégie « Actu » :
// un memecoin lancé juste après une actualité qui démarre, et qui en porte le nom.
// Un mot est « chaud » s'il apparaît dans au moins 2 titres de la dernière heure ET qu'il est nouveau
// (absent des titres des 24 h précédentes) : on évite ainsi les mots permanents comme « Trump ».
const FEEDS = [
  'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Trump+when:1h&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Elon+Musk+when:1h&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=viral+when:1h&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=crypto+when:1h&hl=en-US&gl=US&ceid=US:en',
];
const STOP = new Set(('about after again against also among around because before being between could during every first from have here into just like more most much never news only other over said says should since some still such than that their them then there these they this those through under until very what when where which while will with would year years your says amid report reports video watch live update updates week today latest new news first last back down make makes made time times people world state states house white trump trumps donald biden elon musk market markets stock stocks price prices crypto bitcoin million billion percent official officials government president former american americans national country deal plan plans calls call says told tells could might shows show near three two four five days hours night morning').split(' '));
const words = {}; // mot -> { first, hits: [ { t, title } ] }
const H = 3600000;

function tokenize(title) {
  const clean = title.replace(/\s+-\s+[^-]+$/, ''); // retire « - Nom du journal »
  return [...new Set((clean.match(/[A-Za-zÀ-ÿ]{4,}/g) || []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)))].map((w) => ({ w, title: clean }));
}

async function poll() {
  const now = Date.now();
  for (const url of FEEDS) {
    try {
      const xml = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).text();
      const titles = [...xml.matchAll(/<item><title>([^<]*)<\/title>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&#39;|&quot;/g, "'"));
      for (const title of titles) for (const { w, title: t } of tokenize(title)) {
        // Pendant les 30 premières minutes, tout ce qu'on voit est considéré comme « déjà connu »
        const x = words[w] || (words[w] = { first: now - started < 30 * 60000 ? 0 : now, hits: [] });
        if (!x.hits.some((h) => h.title === t)) x.hits.push({ t: now, title: t });
      }
    } catch { /* flux momentanément indisponible */ }
  }
  for (const w in words) {
    words[w].hits = words[w].hits.filter((h) => now - h.t < 24 * H);
    if (!words[w].hits.length && now - words[w].first > 24 * H) delete words[w];
  }
}

// Mots chauds : ≥ 2 titres dans l'heure, et apparus pour la première fois il y a moins de 2 h
let started = 0;
function hot() {
  const now = Date.now();
  if (now - started < 30 * 60000) return []; // 30 min d'historique avant de juger ce qui est « nouveau »
  return Object.entries(words)
    .filter(([, x]) => now - x.first < 2 * H && x.hits.filter((h) => now - h.t < H).length >= 2)
    .map(([w, x]) => ({ word: w, title: x.hits[x.hits.length - 1].title, n: x.hits.length }));
}

// Le nom ou le symbole du token correspond-il à un mot chaud ?
function match(name, symbol) {
  const n = `${name || ''} ${symbol || ''}`.toLowerCase().replace(/[^a-zà-ÿ]/g, ' ');
  const parts = n.split(/\s+/).filter(Boolean);
  const joined = parts.join('');
  for (const h of hot()) if (parts.includes(h.word) || (h.word.length >= 5 && joined.includes(h.word))) return h;
  return null;
}

function start() {
  started = Date.now();
  poll();
  setInterval(poll, 60000);
}

module.exports = { start, match, hot, poll };
