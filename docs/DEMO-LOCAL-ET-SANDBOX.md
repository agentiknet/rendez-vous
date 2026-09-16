# Deux démos — harness local piloté du remote / salle sandbox avec contact invité

Compagnon de `DEMO-PLAN-2MIN.md` : deux prises distinctes, deux modes du
même service. **Aucun code à écrire** — le mode local existe
(`LocalBooter`, PLAN §4 R3) et a été prouvé de bout en bout le 2026-09-16
(salle scratch RDV-C2Y3 : session codex `gpt-5.6-terra`, cwd = ce repo,
`roster` + `say` via MCP room en loopback, zéro sandbox).

## La bascule (l'unique différence d'exploitation)

Le booter est global au service (`RDV_BOOTER`), choisi au démarrage :

- **Démo A** — `RDV_BOOTER=local` : pas de box, pas d'artifact ; la session
  de salle est une session agentproto ordinaire SUR CE MAC (cwd = ce repo,
  credentials locaux, codex lit `~/.codex/auth.json` nativement).
- **Démo B** — `RDV_BOOTER=e2b` : la config en place — box, artifact live,
  canvakit, pause/destroy possibles.

Les salles persistent à travers la relance. Relance dans la session
agentproto qui survit (jamais `&`) :

```bash
cd /Volumes/SSDExternalMacStudio/Code/experiments/hackatons/rendez-vous && set -a && source .env.local && set +a && RDV_BOOTER=local node src/cli.ts serve
```

```bash
cd /Volumes/SSDExternalMacStudio/Code/experiments/hackatons/rendez-vous && set -a && source .env.local && set +a && RDV_BOOTER=e2b node src/cli.ts serve
```

Ordre conseillé : **B d'abord** (config actuelle, zéro relance), puis la
bascule en local pour **A**. Ou l'inverse si A se joue près du Mac.

---

## Démo A — « Mon harness local, piloté du téléphone » (~90 s)

Pitch (dit à l'écran, 10 s) :

> « L'agent de cette salle ne tourne pas dans un cloud — il tourne sur
> CETTE machine, avec ses fichiers et ses droits. Mon téléphone le pilote.
> Regardez. »

Pré-prise : salle créée via l'assistant MCP (« Crée une room rendez-vous »),
TG + WA rejoignent (`join <CODE>`), host web ouvert sur
`http://localhost:3000/?room=<CODE>&name=Jeremy`, ping de chauffe (premier
boot local ~40-90 s).

| # | Temps | Qui envoie quoi | Ce que l'opérateur DIT | Ce qu'on montre |
|---|---|---|---|---|
| 0 | 10 s | — | LE PITCH | le host : roster complet, panneau artifact vide (honnête : pas de box) |
| 1 | 25 s | **TG** : « Liste les 5 derniers commits du repo rendez-vous et résume ce qui a changé aujourd'hui. » | « Le brief part de mon téléphone. » | l'agent exécute un `git log` RÉEL du repo et résume |
| 2 | 20 s | — (écran) | « La session vit ICI — regardez le process. » | à l'écran : l'arbre des sessions agentproto (ou un `ps`) montrant la session `rdv-<CODE>` en codex, cwd = ce repo |
| 3 | 20 s | **WA** : « Crée /tmp/rdv-demo/pitch.md avec trois idées de pitch, puis dis-nous ce que tu as écrit. » | « Il écrit sur mon disque, en direct. » | l'agent confirme ; le fichier existe (`cat` dans un second terminal si l'écran le permet) |
| 4 | 15 s | **TG** : « Entre nous : laquelle de ces trois idées est la plus faible ? » | « Et il sait qui voit quoi. » | la réponse chuchotée au TG seul ; l'écran ne voit que « l'agent a chuchoté » |

Lignes honnêtes (démo A) :

- **Pas d'artifact en local** — canvakit reste e2b-only ; le panneau vide
  du host fait partie du propos (« pas de machine louée, pas de document
  servi depuis le cloud »).
- **L'agent a les droits complets de la machine** — c'est le propos ET la
  limite ; le dire si quelqu'un demande.
- Premier boot ~40-90 s — le ping de chauffe est obligatoire.

---

## Démo B — « J'invite un contact, on travaille ensemble dans la sandbox » (~2 min)

Pitch :

> « Une salle, une sandbox qui travaille — et un invité qui arrive en cours
> de route par un simple lien. Tout le monde voit le même document se
> construire. »

Pré-prise : config e2b (actuelle), salle créée via MCP, puis à
l'assistant : « Donne-moi les liens d'invitation pour <slug> »
(`rendezvous_invite`) — les 3 liens web / t.me / wa.me. **Le contact rejoint
par le lien, pas en tapant `join`** — c'est le beat. Contact : un vrai
humain (Mathilde a déjà prouvé la jointure sur RDV-8TGC) ou le deuxième
téléphone.

| # | Temps | Qui envoie quoi | Ce que l'opérateur DIT | Ce qu'on montre |
|---|---|---|---|---|
| 0 | 10 s | — | LE PITCH | le host, artifact prêt, roster : Jeremy |
| 1 | 25 s | **Jeremy (TG)** : brief Lisbonne (week-end deux, début mars, 1200 €) | « Je briefe la salle depuis Telegram. » | l'artifact version 1 apparaître |
| 2 | 20 s | **LE CONTACT** ouvre le lien wa.me (ou web) | « Et là j'invite quelqu'un — un simple lien. » | le roster +1 annoncé par l'agent en une ligne |
| 3 | 30 s | **CONTACT** : « Ajoute une contrainte : vol de nuit seulement. » | « Il participe au brief. » | l'agent intègre, artifact version 2 |
| 4 | 25 s | **Jeremy (TG)** : « Non — le client déteste les vols de nuit. » | « Deux humains, un arbitre. » | l'arbitrage UNE ligne, broadcasté à toute la salle |
| 5 | 10 s | — | « Deux téléphones, une sandbox, un document. » | l'artifact final partagé |

Ligne honnête (démo B) : si la box est froide, le premier message la boot
(~1 min) — le ping de chauffe reste dans la pré-prise.

---

## Après les prises

Assembler via le skill screencast (crop/retime + gate gemini). Deux prises
indépendantes, une relance de service entre les deux — ne JAMAIS tuer le
daemon : couper le service (Ctrl-C dans sa session) puis relancer avec le
nouveau `RDV_BOOTER`.
