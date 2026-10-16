# La méthode : tout ce qu'on a appris, en une seule règle

Rédigé le 16/10/2026, après trois jours de tests virtuels aux prix réels. Tous les chiffres viennent de nos propres mesures
(fichiers `research/`, états des robots). Les sources externes sont citées à la fin.

---

## LA RÈGLE UNIQUE

> **On ne met de l'argent réel que sur une stratégie dont le gain a été prouvé :**
> **1. aux prix qu'un vrai bot aurait obtenus (pas aux prix annoncés),**
> **2. après des frais deux fois plus élevés que prévu,**
> **3. sans compter les 3 meilleurs trades,**
> **4. sur des données que la stratégie n'a jamais vues,**
> **5. sur au moins 300 trades.**
> **Si une seule de ces cinq conditions manque, on ne trade pas.**

Jusqu'ici, **aucune de nos stratégies sur memecoins n'a passé ces cinq conditions.** La seule qui les passe a été testée au tout
début : la tendance sur Bitcoin (voir plus bas).

---

## 1. Ce que l'on a mesuré, par étape

### Étape 1 : la vidéo « Claude Trade » (jour 1)
- Les « paliers » de dépôt (400 / 1 000 / 2 000 $) avec des gains « plafonnés à 5×–20× » : mécanique de pyramide. Écartée.

### Étape 2 : Bitcoin, Ethereum, Solana (jour 1)
- 9 familles de stratégies, 107 réglages, choisis sur 2020–2023, jugés sur 2024–2026 (jamais vus).
- **La plus solide : la plus simple.** Investi quand le prix est au-dessus de sa moyenne des 50 derniers jours, sinon en stablecoin.
  Sur Bitcoin : **+107 %** (contre +93 % pour simplement garder) avec une perte maximale de **−27 %** (contre −53 %).
  Environ 12 trades par an. Ça tient pour tous les réglages de 50 à 200 jours : ce n'est pas un coup de chance.
- **Le trading rapide perd** : 15 stratégies sur 16 en bougies d'1 h perdent sur la période de test, les frais mangent tout.
- Une stratégie de rotation affichait **+27 434 %** sur la période d'apprentissage et **+19 %** sur le test. Les beaux backtests mentent.
- Réalisme : +30 % par an, c'est environ **2 € par mois pour 100 €**.

### Étape 3 : l'étude des memecoins (jour 1)
- 6 475 memecoins. **77 % finissent morts** (−90 %). Garder du DOGE depuis juin 2024 : −48 % ; PEPE −75 % ; BONK −91 % ; WIF −94 %.
- Les gros gagnants (TBB ×38, ANSEM ×36) sont **4 sur 6 retombés sous leur prix d'entrée** : seul celui qui vend près du sommet gagne.

### Étape 4 : le sniper 5 minutes, puis à la seconde (jours 1–2)
- Le gain de +43 % affiché venait **d'un seul token (SEALS, +932 %)**. Sans lui : −4 %.
- Un token à +18 949 % était un **bug** (un token déjà coté pris pour un lancement).
- Les robots à 5 minutes ratent les effondrements (JEANWIFCAP : −98,8 % alors que le stop était à −35 %).

### Étape 5 : le moteur « prix réels » (jour 3) — le tournant
Nous lisons la **courbe pump.fun directement sur la blockchain**, 1 seconde après la décision, avec l'impact de notre ordre,
les frais et les achats des autres bots arrivés avant nous.
- Éclair sélectif : de **+479 %** (prix annoncés) à **−13 % par trade** (prix réels).
- **Même en achetant au tout premier bloc possible** (bloc 0), le résultat est **−8 % par trade**. La vitesse ne sauve rien.
- Expert (achat du repli après un pump, vente par paliers de 25 %) : **−55 % en 20 trades**. On achetait la sortie des premiers acheteurs.

### Étape 6 : copie de portefeuilles, TikTok, vague, actu, cerveau (jours 3–4)
- **Copie moyen terme** : plus haut **140 $** à 3 h 48, retombée à **86 $**. Le pic venait de deux ou trois trades.
- Les portefeuilles « gagnants » sont en réalité des **robots** (30 à 180 transactions par heure, quelques secondes de détention),
  ou des **créateurs** qui gagnent en vendant à ceux qui achètent après eux. Les copier avec 2 secondes de retard revient à être leur client.
- **Le cerveau** (2 356 tokens) a trouvé « acheteurs ≥ 2 × vendeurs et market cap < 50 k$ » : +30 % par trade selon lui. Mais lui-même
  donne **+16 % à « tout acheter »**, ce qui est faux en réel : ses relevés espacés ratent les chutes. Règle retirée.
- Les frais comptés (3 % par ordre + frais réseau) ont déjà coûté **~30 $ sur 100 trades**, soit 30 % du capital par stratégie.

---

## 2. Les erreurs qu'on a faites (et ce qu'elles ont coûté en illusions)

| # | Erreur | Conséquence | Garde-fou désormais |
|---|---|---|---|
| 1 | Prendre un gain isolé pour une stratégie (SEALS) | Fausse confiance | Toujours compter **sans les 3 meilleurs** |
| 2 | Acheter « au prix annoncé » à la création | Gains simulés impossibles (479 % → −13 %) | Prix lu sur la courbe 1 s après, avec les autres bots |
| 3 | Sous-estimer les frais (3 % → réel 5 à 20 %) | Résultats trop beaux | Frais réseau 0,001 SOL par transaction, test à frais doublés |
| 4 | Sortie « au bout de 30 min » au dernier prix connu | Les arnaques (prix → 0) étaient invisibles | Sorties relues chaque seconde sur la blockchain |
| 5 | Un token déjà coté pris pour un lancement | +18 949 % faux | Seuls les vrais lancements pump.fun |
| 6 | Mesurer l'argent entré avec `vS − 30` | Tokens vides pris pour des « leaders » | Utiliser la réserve **réelle** `rS` |
| 7 | Achats en double (mots-clés multiples) | Même token acheté 5 fois | Un achat par token, y compris en cours d'ordre |
| 8 | Vente interrompue par un redémarrage | Position bloquée (LADYDOPE −39 %) | Drapeau « vente en cours » effacé au démarrage |
| 9 | Filtres RugCheck sur tokens trop jeunes | « top 10 : 0 % » pour tous : aucune protection | Lecture directe des détenteurs sur la blockchain |
| 10 | Afficher la mauvaise stratégie (Éclair du 5 min à la place de celui de la seconde) | « 3 $ » au lieu de 184 $ | Noms uniques par stratégie |
| 11 | Optimiser sur les mêmes données que celles du test | Résultats gonflés | Train 60 % / test 40 %, jamais mélangés |
| 12 | Croire que la vitesse crée le gain | Logiciel d'achat ultra-rapide inutile | Mesure du résultat au bloc 0 à 4 : −8 à −13 % |

---

## 3. Pourquoi le sniping de memecoins perd, en cinq phrases

1. **Presque tous les tokens meurent** : 80 % arrêtent de trader dans la journée (CoinGecko).
2. **Chaque aller-retour coûte 3 à 5 % minimum**, plus le glissement : il faut monter de 6 à 20 % pour rester à zéro.
3. **Ceux qui gagnent sont avant nous** : le créateur et ses portefeuilles dans le bloc de création, les bots payés pour être les plus rapides.
4. **Quand le signal est visible pour nous, c'est souvent le moment où ils revendent** : acheter un « repli », une « vague » ou une « alerte » revient à acheter leur sortie.
5. **Le résultat repose sur quelques trades** : sans les 3 à 10 meilleurs, toutes nos stratégies sont négatives.

---

## 4. Ce qui est fiable dans tout ce qu'on a construit

- Le **moteur de prix réels** (`live/courbe.js`) : c'est l'outil qui nous a empêchés de nous mentir.
- Les **comptes** : contrôle au centime (`research/audit.js`), écart ≤ 0,02 $.
- Le **cerveau** comme mesure : il dit ce qui ne marche pas (créateur 2–5 %, gros détenteurs, Twitter seul n'aide pas).
- Les **protections** : un achat par token, sorties à la seconde, flux temps réel, secours Tatum pour la blockchain.
- Les **outils de recherche** : `blocs.js` (entrée bloc par bloc), `smartmoney.js` (portefeuilles), `longterme.js`, `cerveau-strategie.js`.

---

## 5. Procédure avant tout argent réel

1. La stratégie tourne **au moins 300 trades** en virtuel aux prix réels.
2. Résultat positif **après frais ×2** et **sans ses 3 meilleurs trades**.
3. Résultat positif sur une **période jamais vue** (au moins 5 jours de plus).
4. Passer d'abord **1 à 2 $ par trade pendant plusieurs semaines**, en réel, et comparer **chaque trade réel au virtuel**.
5. Jamais plus de **5 % du capital par trade**, jamais plus de **ce qu'on peut perdre sans conséquence**.
6. Un portefeuille dédié avec une petite somme, **jamais** les clés principales, jamais d'accès au reste de l'argent.
7. Un arrêt automatique : −20 % sur la semaine → on coupe et on analyse.

## 6. Ce qu'on peut faire d'utile dès maintenant

- **Garder la tendance sur Bitcoin** (moyenne 50 jours) comme référence : +30 %/an, perte maximale divisée par deux. Elle est simple, lente,
  et la seule à avoir passé le test des données jamais vues.
- **Continuer les tests memecoins uniquement en virtuel**, pour apprendre : copie de portefeuilles lents (long terme), vagues, actualité.
- **Refaire la recherche des portefeuilles tous les quelques jours** : les gagnants changent vite.

---

## Sources externes
- Solidus Labs (via The Defiant) : 98,6 % des lancements pump.fun sont des pump-and-dumps ou rug pulls — https://thedefiant.io/alarming-99-of-memecoin-launches-on-pumpfun-are-pump-and-dumps-or-rug-pulls-report
- CoinGecko (via CryptoPotato) : 80 % des tokens pump.fun arrêtent de trader le jour du lancement ou le lendemain — https://cryptopotato.com/nearly-70-of-pump-fun-tokens-die-on-launch-day-coingecko/
- Galaxy Research (via Cointelegraph) : les plateformes et les bots captent l'essentiel des profits, durée de détention médiane ~100 s — https://cointelegraph.com/news/memecoins-attract-users-platforms-reap-profits-report
- Guides de praticiens (MadeOnSol, MoonPay, Blofin, DEXTools) : paliers de vente, stops, contrôles avant achat. Ce sont des habitudes, pas des preuves.
