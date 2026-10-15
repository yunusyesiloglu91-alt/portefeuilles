# Analyse : Éclair sélectif, peut-on l'automatiser en réel ?

Date : 15/10/2026. Données : 136 trades fermés en virtuel (depuis le 14/10 11 h 22), achats à la création.

## 1. Ce que dit le virtuel
- Moyenne par trade : **+13,2 %**.
- Sans le meilleur trade : +8,6 %. Sans les 3 meilleurs : +3,5 %. **Sans les 10 meilleurs : −2,4 %.**
- 31 gagnants, 105 perdants. **Les 10 meilleurs trades font 73 % de tous les gains positifs.**
- Les 8 meilleurs achats ont été faits à un prix de 3,0 à 3,2 millionièmes de dollar : c'est le **prix de lancement**, quelques secondes après la création.

## 2. Pourquoi le virtuel est trop optimiste
1. **Vitesse.** Les achats à la création sont les plus disputés. Des bots et des bundles achètent avant nous, à un prix plus haut. Le virtuel suppose qu'on achète au premier prix vu, sans concurrence.
2. **Sorties.** Nos ventes au « ×13 » (BLUBBER) supposent qu'il existait un acheteur à ce prix-là, pour 10 $. Impossible à vérifier : pour BLOO et SCANND, GeckoTerminal n'a plus d'historique de prix. Un token qui n'a plus de cotation est souvent un token mort ou vidé de sa liquidité.
3. **Frais.** Le virtuel compte 3 % + 3 %. En réel : frais de priorité Solana, frais de la plateforme, et glissement sur des tokens de quelques dizaines de milliers de dollars. Plusieurs points de pourcentage de plus par trade, et jusqu'au double si le marché est agité.
4. **Taille.** À 10 $, on est petit. À 1 000 $ par trade, la liquidité ne suffirait pas, et on ne revendrait pas au prix affiché.
5. **Surapprentissage.** La liste des filtres a été ajustée sur ces mêmes données. Le résultat sur les 136 trades est donc surévalué.
6. **Latence de nos sorties.** Les prix sont relevés toutes les 10 secondes : un token qui s'effondre entre deux relevés nous vend plus bas que prévu (−50 à −95 % observés sur les arnaques).

## 3. Calcul réaliste (estimation)
Hypothèses prudentes, en réel : frais totaux 8 % par aller-retour (au lieu de 6 %), 30 % de trades perdus à −95 % au lieu de −30 % (arnaques), sorties déjà suspectes.
- Le résultat devient **négatif** dès qu'on retire les 10 meilleurs trades, ce qui est déjà le cas en virtuel.
- Avec 8 % de frais et un glissement d'au moins 5 % sur les gains, la moyenne **sans les 10 meilleurs** reste négative.

## 4. Verdict
- **Non, un bot automatisé n'a pas de bonnes raisons de reproduire ces gains en réel.** Les gains virtuels reposent sur une dizaine de trades aux prix d'achat impossibles à obtenir de façon fiable, et sur des sorties qu'on n'a pas pu vérifier.
- Le signal le plus solide n'est pas la rentabilité, mais une **asymétrie** : ~1 trade sur 4 gagne, et les gagnants sont très gros. C'est le profil classique des loteries, pas d'une stratégie qui rapporte régulièrement.
- Avant tout argent réel, il faudrait : (a) un test avec des prix de sortie vérifiés sur la blockchain, (b) des mises réelles très petites (quelques dollars) pendant des semaines, (c) un résultat positif **sans les 10 meilleurs trades**, après frais réels.

## 5. Ce qui est fiable dans notre travail
- Le robot fonctionne et enregistre tout, avec les frais.
- Les filtres anti-arnaque (liquidité, acheteurs/vendeurs, créateur) réduisent les pertes par rapport au « tout acheter ».
- Le cerveau (1 344 tokens) montre ce qui ne marche pas, mais n'a pas encore trouvé de facteur de gain clair.
