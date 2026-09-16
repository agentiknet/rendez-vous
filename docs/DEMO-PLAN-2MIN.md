# Plan de démo — 2 min, 4 beats — speech + enchaînement

Compagnon opératoire de `docs/DEMO-USECASE-2MIN.md` : le script décrit CE que
la démo prouve ; ce plan décrit QUI dit quoi, QUAND, et qui exécute quoi.
État stack au 2026-09-15 : service UP (agent codex/terra), tunnel public OK,
host CopilotKit sur :3000, MCP rdv-personal vivant (Desktop badge TG, Codex
badge console/codex).

Décision cast (2026-09-15) : **Jeremy pour les deux salles** — un humain,
trois surfaces. Pas de cast fictif ; le roster montre la vérité et c'est le
propos (cross-device : un humain, plusieurs canaux, l'agent le sait).

## 1. Le pitch (dit à l'écran, ~10 s, avant tout message)

> « Un humain, trois appareils, une seule session d'agent partagée — et même
> un deuxième agent qui rejoint la salle. Et le moment que j'aime : au milieu
> de la conversation, on détruit la machine qui fait tourner l'agent. La
> session survit. Regardez. »

## 2. Cast et surfaces

| Rôle | Surface | Nom affiché | Note |
|---|---|---|---|
| **Jeremy** | Telegram | Jeremy (nom du compte) | le brief, la contradiction, le whisper |
| **Jeremy** | WhatsApp | Jeremy (nom du compte) | la note vocale, la reprise |
| **Jeremy** | Web — host CopilotKit (`?room=<CODE>&name=Jeremy`) | Jeremy (claim libre) | l'écran projeté, la demande de vérification web |
| **Codex** | Membre-orchestrateur (badge console/codex) | Codex | session codex spawnée, en écoute |
| **L'agent** | la salle | — | codex/terra en box e2b |

Trois lignes « Jeremy » au roster = le claim cross-device, pas un bug : la
première fois que la note vocale WA arrive sans re-salutation, c'est le beat.

**Un utilisateur, trois plateformes (décision 2026-09-15)** : le codex
interactif porte AUSSI le badge TG — Desktop, codex et les téléphones parlent
comme le même Jeremy. Seule exception : la session orchestrateur spawnée garde
son badge distinct « Codex » (console/codex) pour rester visible comme agent
dans le roster.

## 3. Les deux salles — exécution par les assistants

Deux salles jumelles, chacune créée PAR un assistant différent (ça prouve le
MCP des deux côtés) :

- **Salle A — côté Claude Desktop.** Prompt à donner à l'assistant Desktop :
  « Crée une room rendez-vous **en sandbox** » (→ `rendezvous_new` avec
  `sandbox: true` — depuis 2026-09-16, `new` sans flag crée une salle
  LOCALE, sans artifact), puis « donne-moi les liens d'invitation de
  <slug> » (→ `rendezvous_invite`).
- **Salle B — côté Codex.** Même chose, même wording, dans codex.

Chaque réponse rend `{roomSlug, ready}` + les 3 liens (web / t.me / wa.me).
**Le badge créeur déménage dans sa salle** (pointeur unique par badge).
Codex interactif portant le badge TG (§2), créer la salle B depuis codex
déplace le MÊME pointeur que Desktop — **les prises sont séquentielles** :
pour revenir dans une salle, « join <CODE> ». Jamais deux prises en parallèle
sur le même badge.

## 4. Pré-prise (dans l'ordre, ~10 min)

1. **Salle créée** (§3) — jamais une salle déjà utilisée.
2. **Écran** : ouvrir le host `http://localhost:3000/?room=<CODE>&name=Jeremy`,
   vérifier que « Jeremy » apparaît au roster.
3. **TG** : `join <CODE>` depuis le téléphone (ou lien t.me). Roster +1.
4. **WA** : `join <CODE>` depuis le téléphone (ou lien wa.me). Roster +1.
5. **Codex rejoint** : `rendezvous_send` « join <CODE> » avec le badge
   console/codex (via la session orchestrateur ou codex).
6. **Ping de chauffe** : TG envoie `ping` — attendre la réponse (premier boot
   jusqu'à ~1 min ; le ping réveille aussi une salle auto-pausée).
7. **Répétition éclair** des beats WhatsApp-dépendants (1b et 4) — pas
   d'essai pendant la prise.
8. Téléphones dans le champ ou en miroir — décidé AVANT, plus rien à toucher.

## 5. L'enchaînement (le take, ~2 min)

| # | Temps | Qui envoie quoi (canal) | Ce que l'opérateur DIT | Ce qu'on montre |
|---|---|---|---|---|
| 0 | 10 s | — (personne n'envoie) | LE PITCH (§1) | l'écran, roster 3 Jeremy + Codex, rien d'envoyé |
| 1 | 25 s | **Jeremy (TG)** : « On a un client qui veut un week-end à Lisbonne pour deux, début mars, 1200 € tout compris. Proposition pour ce soir. » | « J'ouvre la salle depuis Telegram. » | l'artifact version 1 apparaître |
| 1b | 15 s | **Jeremy (WA)** : note vocale « Ajoute le transfert aéroport, le client l'a demandé au téléphone. » | « Et là je switch d'appareil — WhatsApp, en vocal. » | la note transcrite en texte ; l'agent NE re-salue PAS : même humain, autre canal |
| 2 | 30 s | **Jeremy (web, chatbox)** : « Vérifie les prix réels sur le web, invente rien. Dis-nous ce que tu fais. » Puis **Jeremy (WA)** interrompt : « et il n'aime pas les auberges » | « Là il travaille vraiment : il cherche, et la salle continue de vivre pendant ce temps. » | l'agent annonce sa recherche, l'artifact se met à jour, l'interjection mise en file puis traitée |
| 3 | 20 s | **Jeremy (TG)** : « À 1200 € en mars on ne tient pas l'hôtel du centre. Soit on sort du centre, soit on passe à 1500. » | « Le brief évolue en pleine conversation. » | l'arbitrage UNE ligne, broadcasté à toute la salle |
| 4 | 35 s | opérateur : `service.pauseRoom(<CODE>)` (commande prête, jamais un kill daemon). Puis **Jeremy (WA)** : « On en était où ? » | « La machine vient de mourir. Vraiment. » … puis, après la reprise : « **La session est persistante. La machine ne l'est pas.** » | l'état paused/box morte, puis la reprise sur box neuve : Lisbonne, le transfert, le prix cherché, l'arbitrage |

Variante 2:20 (si la clock le permet) — **beat whisper** entre 3 et 4 :
**Jeremy (TG)** : « Garde ça entre nous : est-ce qu'on est en train de vendre
trop cher ? » → la réponse part au TG seul ; l'écran ne voit que le badge
« agent a chuchoté à Jeremy ». Une ligne de speech : « Et là, personne n'a
tapé de commande — c'est l'agent qui décide qui voit quoi. »

Le rôle de Codex dans le take : SILENCIEUX par défaut (il écoute). Option
flourish sur le beat 2 : « Codex, vérifie aussi de ton côté » → il délègue à
un sous-agent et poste le résultat. À ne montrer que si la répétition l'a
prouvé deux fois.

## 6. Si ça déraille (les lignes honnêtes)

- **Aucune réponse** → check `https://rdv.clipgen.co/health` ; 502 = webhooks
  entrants perdus, redémarrer le service en session qui survit (jamais `&`).
- **Note vocale « could not be fetched »** → le dire à voix haute et
  continuer : c'est le plancher honnête, il fait partie du propos.
- **Membre en id brut** (6371794295) → cosmétique, le nom se rafraîchit au
  prochain message. Continuer.
- **Salle auto-pausée** (20 min) → un message quelconque la résume ; refaire
  le ping de chauffe.
- **Jamais de kill daemon pour le beat 4** — uniquement `service.pauseRoom`.

## 7. Après la prise

Assembler via le skill screencast (crop/retime + gate gemini). Le take
rejouable = la salle B : mêmes checklists, création exécutée par codex, Jeremy
rejoint avec « join <CODE-B> ».

## 8. Fiches prompts assistants (copier-coller)

Claude Desktop / Codex — les quatre phrases utiles :
1. « Crée une room rendez-vous en sandbox » (`sandbox: true`)
2. « Donne-moi les liens d'invitation pour <slug> »
3. « Dis dans la salle <slug> : <texte> »
4. « Liste mes rooms »
