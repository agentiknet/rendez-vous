# Plan de démo — 2 min, 4 beats — speech + enchaînement

Compagnon opératoire de `docs/DEMO-USECASE-2MIN.md` : le script décrit CE que
la démo prouve ; ce plan décrit QUI dit quoi, QUAND, et qui exécute quoi.
État stack au 2026-09-15 : service UP (agent codex/terra), tunnel public OK,
host CopilotKit sur :3000, MCP rdv-personal vivant (Desktop badge TG, Codex
badge console/codex).

## 1. Le pitch (dit à l'écran, ~10 s, avant tout message)

> « Trois personnes, trois canaux, une seule session d'agent partagée. Et le
> moment que j'aime : au milieu de la conversation, on détruit la machine qui
> fait tourner l'agent. La session survit. Regardez. »

## 2. Cast et surfaces

| Rôle | Surface | Nom affiché | Qui/vrai |
|---|---|---|---|
| **Alice** | Web — host CopilotKit (`?room=<CODE>&name=Alice`) | Alice ✓ (claim libre) | l'écran projeté, siège réel |
| **Bob** | Telegram | nom du compte réel (≈ Jeremy) | le téléphone opérateur |
| **Carol** | WhatsApp | nom du compte réel | le téléphone opérateur (ou 2e téléphone) |
| **Codex** | Membre-orchestrateur (badge console/codex) | Codex ✓ | session codex spawnée, en écoute |
| **L'agent** | la salle | — | codex/terra en box e2b |

Noms : Alice est maîtrisable (claim web). Bob/Carol affichent les noms des
comptes réels — la narration les appelle Alice/Bob/Carol, le roster montre la
vérité. (Fiction totale possible via la voie simulée, mais alors plus de vrai
téléphone pour recevoir — à ne pas faire le jour de la prise.)

## 3. Les deux salles — exécution par les assistants

Deux salles jumelles, chacune créée PAR un assistant différent (ça prouve le
MCP des deux côtés) :

- **Salle A — côté Claude Desktop.** Prompt à donner à l'assistant Desktop :
  « Crée une room rendez-vous » (→ `rendezvous_new`), puis « donne-moi les
  liens d'invitation de <slug> » (→ `rendezvous_invite`).
- **Salle B — côté Codex.** Même chose, même wording, dans codex.

Chaque réponse rend `{roomSlug, ready}` + les 3 liens (web / t.me / wa.me).
**Le badge créeur déménage dans sa salle** (pointeur unique par badge) :
la salle A a le badge TG, la salle B le badge Codex — les deux salles vivent
en parallèle, prenez celle que vous filmez (A principale, B secours/replay).

## 4. Pré-prise (dans l'ordre, ~10 min)

1. **Salle créée** (§3) — jamais une salle déjà utilisée.
2. **Écran** : ouvrir le host `http://localhost:3000/?room=<CODE>&name=Alice`,
   vérifier que « Alice » apparaît au roster.
3. **Bob rejoint** : depuis le téléphone TG, envoyer `join <CODE>` (ou cliquer
   le lien t.me). Roster +1.
4. **Carol rejoint** : depuis le téléphone WA, `join <CODE>` (ou lien wa.me).
   Roster +1.
5. **Codex rejoint** : demander à l'orchestrateur (session spawnée) ou via
   codex : `rendezvous_send` « join <CODE> » avec le badge console/codex.
6. **Ping de chauffe** : Bob envoie `ping` — attendre la réponse (premier
   boot jusqu'à ~1 min ; le ping réveille aussi une salle auto-pausée).
7. **Répétition éclair** des beats WhatsApp-dépendants (2 et 5) — pas d'essaie
   pendant la prise.
8. Télésphones dans le champ ou en miroir — décidé AVANT, plus rien à toucher.

## 5. L'enchaînement (le take, ~2 min)

| # | Temps | Qui envoie quoi (canal) | Ce que l'opérateur DIT | Ce qu'on montre |
|---|---|---|---|---|
| 0 | 10 s | — (personne n'envoie) | LE PITCH (§1) | l'écran Alice, roster 3 membres, rien d'envoyé |
| 1 | 25 s | **Bob (TG)** : « On a un client qui veut un week-end à Lisbonne pour deux, début mars, 1200 € tout compris. Proposition pour ce soir. » | « Bob ouvre la salle depuis Telegram. » | l'artifact version 1 apparaître |
| 1b | 10 s | **Carol (WA)** : note vocale « C'est Carol, je suis en route. » | « Et Carol arrive depuis WhatsApp, en vocal. » | la note transcrite en texte, roster [Carol · whatsapp] |
| 2 | 35 s | **Alice (web, chatbox)** : « Vérifie les prix réels sur le web, invente rien. Dis-nous ce que tu fais. » Puis **Carol (WA)** interrompt : « il n'aime pas les auberges » | « Là il travaille vraiment : il cherche, et la salle continue de vivre pendant ce temps. » | l'agent annonce sa recherche, l'artifact se met à jour, l'interjection de Carol est mise en file puis traitée |
| 3 | 20 s | **Bob (TG)** : « À 1200 € en mars on ne tient pas l'hôtel du centre. Soit on sort du centre, soit on passe à 1500. » | « Deux contraintes contradictoires, deux téléphones, la même seconde. » | l'arbitrage UNE ligne, broadcasté à toute la salle |
| 4 | 35 s | opérateur : `service.pauseRoom(<CODE>)` (commande prête, jamais un kill daemon). Puis **Carol (WA)** : « On en était où ? » | « La machine vient de mourir. Vraiment. » … puis, après la reprise : « **La session est persistante. La machine ne l'est pas.** » | l'état paused/box morte, puis la reprise sur box neuve : Lisbonne, le prix cherché, l'arbitrage, la contrainte de Carol |

Variante 2:20 (si la clock le permet) — **beat whisper** entre 3 et 4 :
**Bob (TG)** : « Garde ça entre nous : est-ce qu'on est en train de vendre
trop cher ? » → la réponse part à Bob seul ; Alice ne voit que le badge
« agent a chuchoté à Bob ». Une ligne de speech : « Et là, personne n'a tapé
de commande — c'est l'agent qui décide qui voit quoi. »

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
rejouable = la salle B : mêmes checklists, création exécutée par codex.

## 8. Fiches prompts assistants (copier-coller)

Claude Desktop / Codex — les quatre phrases utiles :
1. « Crée une room rendez-vous »
2. « Donne-moi les liens d'invitation pour <slug> »
3. « Dis dans la salle <slug> : <texte> »
4. « Liste mes rooms »
