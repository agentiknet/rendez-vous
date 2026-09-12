# 🎬 Storyboard — "Le séminaire" · take final

**1:50**, un seul cadre 4-up, une horloge unique en surimpression.

Base : le storyboard séminaire de Jérémy (le scénario est bien meilleur que le
précédent : il a un *job nommé*, ce que les deux reviews indépendantes
pointaient comme le trou n°1 en Usefulness). Fusionné avec ce que les reviews
ont trouvé de dur : la règle des 45 secondes, le gate de confirmation qu'il ne
faut surtout pas couper, l'attribution visible, et l'interdiction de
sur-promettre.

---

## Le cadre — géométrie exacte

**Pas un 2×2.** Un quadrant carré de 960×540 pour un écran de téléphone en
portrait, ça donne un timbre-poste illisible ou un crop qui coupe les bulles.
Trois colonnes, les téléphones debout dans leur format natif :

```
 1920 × 1080
┌──────────┬───────────────────────────────────┬──────────┐
│          │  ROOM WEB  (navigateur, 1040×640) │          │
│  JULIE   │  ┌───────────────┬──────────────┐ │   TOM    │
│  phone   │  │  transcript   │   artifact   │ │  phone   │
│ portrait │  │  (attribué)   │  PDF ▸ site  │ │ portrait │
│ 400×1000 │  └───────────────┴──────────────┘ │ 400×1000 │
│          ├───────────────────────────────────┤          │
│          │  ATLAS — terminal, 1040×400       │          │
│  x:20    │  fond sombre, monospace           │  x:1500  │
└──────────┴───────────────────────────────────┴──────────┘
   440 px              1040 px                    440 px
```

Trois raisons pour ce découpage :

- Les deux téléphones gardent leur ratio natif : on lit les bulles, on voit les
  **badges d'attribution**, on voit le vocal avec sa transcription.
- Le centre est **la page room-web telle qu'elle existe déjà** — elle rend
  nativement transcript à gauche, artifact à droite ([page.ts](src/web/page.ts)).
  Rien à fabriquer pour la vidéo, on filme le produit.
- Atlas en bandeau **terminal sombre, en monospace**, sous le reste. Le
  contraste visuel fait le travail que le texte ne peut pas faire : le jury voit
  au premier coup d'œil que ce membre-là est une machine.

Bandeau permanent dans la bande Atlas, coin haut-gauche, toujours présent :
> *Atlas — un agent sur le Mac de la boîte. Même room, mêmes endpoints que Julie
> et Tom.*

Sans ce bandeau, le jury voit un troisième prénom. Les deux reviews l'ont dit
séparément.

## Habillage

| Élément | Spec |
| --- | --- |
| **Horloge** | Une seule, en haut au centre, `00:00` monospace. Jamais une par panneau — l'horloge unique est ce qui prouve la simultanéité |
| **Surbrillance** | Quand un message arrive, un liseré de 3 px sur le panneau concerné pendant 600 ms. C'est ce qui fait suivre l'œil sans voix off |
| **Cartons** | Bas de cadre, pleine largeur, fond sombre 80 %, 2 s max. Un seul par acte |
| **Badge attribution** | Quand `[Tom · messenger]` apparaît chez Julie, zoom doux ×1.15 sur ce fragment, 1 s. C'est la preuve que les deux fils sont vraiment joints |
| **Son** | Voix off uniquement sur les 3 moments notés. Pas de musique sous les beats de contenu — le silence fait durer le money shot |
| **Sortie** | 1920×1080, 30 fps, H.264. Sous-titres brûlés pour les vocaux |

## Type de plan, beat par beat

« Plan » = ce qu'on met en avant, pas un mouvement de caméra : tout est capture
d'écran, le montage se fait au zoom et au liseré.

| t | Plan | Mise en avant |
| --- | --- | --- |
| 0:00 | **Plan large**, les 4 panneaux, tout calme | Poser la géométrie. 2 s, pas plus |
| 0:03 | **Push sur la bande Atlas** ×1.3 | Une machine parle en premier. Tenir jusqu'à la fin de sa phrase |
| 0:07 | **Retour large, split attention** — liseré simultané sur les DEUX téléphones | Deux questions *différentes* au même instant. C'est le plan le plus important de l'ouverture : il ne marche qu'en large |
| 0:12 | **Serré sur Julie** | Sa contrainte budget, en texte |
| 0:18 | **Serré sur Tom**, la bulle vocale + sa transcription qui s'écrit | Le multimodal arrive parce qu'un mec répond en marchant, pas comme une démo de feature |
| 0:22 | **Coupe sur Julie** | Le badge `[Tom · messenger]` chez elle → zoom sur le fragment |
| 0:28 | **Plan large**, puis **push lent sur le centre** ×1.4 sur 5 s | ⚡ Le conflit. Le message doit remplir le centre et **rester 5 s**. Ne rien couper pendant ce plan |
| 0:48 | **Alternance serrée** Julie ▸ Tom ▸ Julie, ~3 s chacun | L'arbitrage. Le rythme accélère, les plans raccourcissent |
| 1:05 | **Centre plein cadre**, l'artifact | Le PDF se reconstruit en direct |
| 1:12 | **Split** centre + Julie | Elle corrige une ligne, ça change à l'écran |
| 1:20 | **Centre**, l'aperçu d'envoi | Destinataire, canal, objet, document. Tenir 3 s |
| 1:25 | **Serré sur Tom** puis **centre** | Il confirme ▸ la transcription enregistre qui a demandé, qui a confirmé |
| 1:30 | **Centre plein cadre**, navigateur | Le site, **URL affichée en clair**, on y navigue |
| 1:40 | **Serré sur Tom** (vocal) puis centre | La photo en hero, mise à jour en direct |
| 1:45 | **Plan large final**, les 4 panneaux, PDF et site visibles | La chute |

## Captation — qui est sur quoi

C'est le point qui peut coincer le jour J, autant le trancher maintenant.

| Panneau | Comment on capture | Identité |
| --- | --- | --- |
| Tom | Téléphone de Jérémy, enregistrement d'écran iOS, ou QuickTime en filaire (plus propre, pas de barre d'enregistrement rouge) | Le contact Telegram réel `6371794295` |
| Julie | **Telegram Web dans une fenêtre de navigateur**, cadrée au ratio d'un téléphone | Un deuxième compte Telegram |
| Centre | Chrome sur `rdv.clipgen.co/r/<code>`, fenêtre à 1040×640 | — |
| Atlas | iTerm plein écran, thème sombre, police 16 pt, le pont qui tourne | `scripts/room-agent.ts` |

**Julie a besoin d'un second compte Telegram.** Si tu n'en as pas sous la main,
ordre de repli, décidé : (1) Telegram Web avec un second numéro — c'est la
meilleure option, ça reste une vraie surface de chat et ça capture proprement ;
(2) Julie passe sur la vue room-web dans un second profil de navigateur — on
perd « deux téléphones » mais on garde deux surfaces distinctes, et c'est la
vraie revendication du produit de toute façon ; (3) on ne fait pas la démo à
deux humains, ce qui n'est pas une option.

**Contrainte dure, rappel :** rien ne sort vers un tiers réel. Le « boss » est
`jeremy@agentik.net`, en répétition comme au tournage.

## Assets à préparer avant

- La photo de villa surf (Pays Basque, terrasse) — celle que Tom envoie.
- Les deux vocaux de Tom, enregistrés à l'avance dans Telegram, prêts à envoyer.
- Le contenu du séminaire pour le site : programme, infos pratiques, FAQ.
- Avatars Julie / Tom distincts dans Telegram, pour qu'on les suive d'un coup
  d'œil.
- Le carton d'ouverture et les deux autres, rendus d'avance.

---

## ⚠️ Le beat d'ouverture : ce qui marche vraiment

Ton idée — l'agent 3 qui écrit aux deux humains pour lancer le sujet — est la
meilleure du storyboard. **Mais pas par le mécanisme que tu décris**, et il vaut
mieux le savoir maintenant qu'au tournage.

Vérifié dans `src/fanout/reader.ts` : le fan-out ne réagit qu'à `text-delta` et
`turn-end`. **Il ne diffuse que les tours de l'agent de la room.** Le message
d'un membre — Atlas compris — entre dans la session comme un prompt et
n'atterrit jamais sur le téléphone des autres. Si Atlas poste « quelles sont vos
contraintes ? », Julie et Tom ne verront pas ce message ; ils verront la
*réponse* de l'agent.

Donc on fait comme ça, et c'est plus fort :

**Atlas déclenche, l'agent de la room parle.** Atlas — qui tourne sur la machine
de la boîte et voit le calendrier — ouvre la room et pose le sujet. L'agent
central reçoit ça comme le tour d'un membre et sollicite Julie et Tom sur leurs
canaux, chacun personnellement, avec `[[ask]]`.

Trois raisons pour lesquelles c'est mieux que ta version :

1. **C'est vrai aujourd'hui**, sans une ligne de code de plus.
2. Ça colle à ton « via le bot central » au pied de la lettre : le bot central
   *est* le relais. Atlas est l'initiateur, l'agent de la room est la voix.
3. Ça retourne la démo habituelle : **personne n'ouvre d'application.** Le
   travail commence parce qu'une machine a remarqué une échéance, et deux humains
   reçoivent un message sur Telegram. Aucune soumission à base de chatbot ne peut
   ouvrir comme ça.

---

## Le découpage

### 0:00–0:12 · L'agent ouvre le sujet
**Carton 2 s :** *« 30 personnes. Un séminaire à organiser. Personne n'ouvre
d'application. »*

- **Atlas** (quadrant bas-gauche) : *« Le séminaire annuel est dans 4 mois et
  rien n'est réservé. J'ouvre une room avec Julie et Tom. »*
- **L'agent** → **Julie** sur Telegram : *« Julie, ton cadre budget et dates ? »*
- **L'agent** → **Tom** sur Telegram : *« Tom, ce qui compte pour toi côté
  expérience ? »*

Les deux téléphones sonnent **en même temps**, avec deux questions
**différentes**. C'est la première image et elle contient déjà la thèse.

### 0:12–0:28 · Les contraintes arrivent, chacun sur son canal
- **Julie** (texte) : *« Budget 12k max, tout le monde vient, train uniquement,
  pas pendant les vacances scolaires. »*
- **Tom** (🎤 vocal, transcription visible à l'écran) : *« Et si on faisait du
  surf ?! L'équipe gardera un souvenir de malade 🏄 »*

Le vocal de Tom est transcrit **et attribué** — `[Tom · messenger]` visible dans
le quadrant de Julie. Le multimodal n'est pas démontré comme une feature, il
arrive parce qu'un mec répond en marchant.

### 0:28–0:48 · ⚡ LE MONEY SHOT — le conflit
- **Tom** (📷 photo) : villa surf au Pays Basque — *« Villa surf, 40 pers, juin ! »*
- **L'agent**, en gros, **tenu 5 secondes** :

> **Conflit détecté ⚠️**
> La villa de Tom : 16 000 €. Le plafond de Julie : 12 000 €.
> Et juin tombe en période scolaire — la contrainte de Julie.
> Tom, la villa est non négociable ? Julie, flexible sur les dates ?

**Voix off :** *« L'agent voit les deux fils. Il sait qui a dit quoi. Il arbitre. »*

C'est le meilleur plan de la vidéo et c'est un meilleur money shot que le
chuchotement privé qu'on avait avant. Raison : **un chatbot ne peut pas détecter
ce conflit.** Il n'a jamais qu'un seul fil. Détecter que la contrainte de Julie
et l'envie de Tom sont incompatibles exige d'avoir les deux — c'est très
exactement la ligne « valeur non reproductible dans un chatbox » du barème
Innovation 5. On ne montre pas une feature, on montre pourquoi la room existe.

### 0:48–1:05 · L'arbitrage
- **Julie** : *« 14k ça passe si on part en septembre. »*
- **Tom** : *« OK septembre. Mais villa avec terrasse, sinon rien 😤 »*
- **L'agent** : *« Villa avec terrasse, Biarritz, 2ᵉ semaine de septembre,
  13 800 €. Julie, Tom — on valide ? »*
- **Julie** : *« Validé ✅ »* · **Tom** (🎤) : *« Go ! »*

Deux personnes qui ne se sont pas parlé viennent de converger, sur deux
téléphones, sans réunion. C'est le produit.

### 1:05–1:30 · Le PDF, et le gate
- **Tom** : *« Faut convaincre le boss, prépare un PDF propre. »*
- **Julie** (pointe une ligne de l'aperçu) : *« Le coût/pers est faux, c'est 460
  pas 520. »*
- **Tom** : *« Ajoute la photo de la villa. »*
- Le PDF **se reconstruit en direct** dans le quadrant artifact.
- **L'agent** : aperçu de l'envoi — destinataire, canal, objet, document rendu —
  *« Je n'envoie rien tant que l'un de vous ne confirme pas. »*
- **Tom** : *« confirm PDF-X7PQ »* → le PDF part.
- Dernière image du beat : **la transcription** — *qui a demandé, qui a confirmé,
  quoi, à qui.*

**Ne pas couper ce beat.** Les deux reviews sont d'accord : c'est le seul moment
de contrôle humain à l'écran, et c'est toute la réponse au critère 4
(« controllable »).

⚠️ **Contrainte dure :** le « boss » doit être une adresse qu'on possède
(`jeremy@agentik.net`). Aucun envoi à un tiers réel, ni en répétition ni au
tournage. À l'écran on affiche l'aperçu ; le destinataire n'a pas besoin d'être
lisible.

### 1:30–1:45 · Le site, en ligne pour de vrai
- **Julie** : *« Maintenant un site pour l'équipe. »*
- **L'agent** : *« Site en ligne 🌐 — programme, infos pratiques, FAQ, code promo
  train. »* → **l'URL est affichée en clair et on y navigue.**
- **Tom** (🎤) : *« Mets la photo de la villa en hero. »* → mis à jour en direct.

L'URL affichée est la preuve que ce n'est pas une maquette. La montrer, ne pas
la raconter.

### 1:45–1:50 · Chute
Vue finale : la room, le PDF, le site côte à côte.

> *« Un séminaire. Deux livrables. Zéro réunion. Deux humains, deux agents, une
> seule session. »*

---

## Ce que j'ai coupé de ton découpage, et pourquoi

| Coupé | Pourquoi |
| --- | --- |
| Scène 0 « session vide, deux avatars » | Une session vide ne prouve rien. Ouvrir sur Atlas qui déclenche met la chose surprenante à la seconde 3 au lieu de la seconde 110 |
| « Je bloque l'option 48h » | On ne réserve rien. Une action qu'on ne fait pas est exactement le genre de ligne qu'un jury demande à voir |
| Scène 4 séparée (« on prépare un PDF ») | Fondue dans 1:05. Annoncer puis faire coûte 10 s pour un seul événement |
| Le 3ᵉ vocal de Tom | Deux suffisent à prouver le multimodal ; le troisième c'est du remplissage |
| 40 s de durée totale | 2:30 → 1:50. Un jury qui en note quarante décroche ; tout ce qui nous distingue est désormais avant 0:50 |

## Ce que j'ai ajouté

- **L'ouverture par Atlas** (ton idée, mécanisme corrigé) — la chose surprenante
  passe de la fin au tout début.
- **Deux questions différentes envoyées simultanément** à 0:05 — l'agent qui
  s'adresse aux membres *individuellement*, ce qui était revendiqué en prose et
  montré nulle part.
- **Le gate de confirmation** — absent de ton découpage, et c'est notre meilleure
  réponse au critère 4.
- **L'attribution visible** (`[Tom · messenger]`) dans le quadrant de l'autre.
  Sans ça, un jury ne voit pas que les deux fils sont vraiment joints.

---

## À répéter avant de tourner

1. **`[[ask]]` part bien.** Le marqueur vient d'être enseigné à l'agent
   (`f0a856e`, 466 tests verts) mais n'a encore jamais été observé en vrai. Si
   l'agent n'ouvre pas d'ask à 0:05, tout le beat d'ouverture tombe.
2. **Atlas se tait sauf quand on l'adresse.** Le pont renvoie *chaque* tour de la
   room dans la session desktop et reposte *chaque* tour desktop. Sans consigne,
   Atlas commentera le vocal de Tom et le quadrant devient du bruit.
3. **Répéter entièrement via `/inbound/simulated` + `RDV_BOOTER=local`** — coût
   zéro, pas de sandbox — avant la prise réelle.
4. **Plan B assumé :** si l'ask ne tient pas, Atlas ouvre la room et l'agent pose
   les questions parce qu'on le lui demande. Le point « une machine est membre »
   passe quand même. Ne pas improviser devant la caméra.

## Conséquence sur le deck

La page 2 nomme encore Alice et Bob. Elle doit nommer **Julie, Tom, Atlas et la
boîte mail**, et la page 3 doit citer le séminaire comme le job. Le deck et la
vidéo doivent raconter la même histoire, sinon le jury lit deux produits.
