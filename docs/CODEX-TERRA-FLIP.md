# Flip codex/terra — FAIT ET PROUVÉ (2026-09-15)

Le flip demandé par Jeremy le 2026-09-15 (« remplacer claude sdk par CODEX sur
terra ») est **en place** : le service tourne sur `RDV_AGENT_ADAPTER=codex` +
`RDV_AGENT_MODEL=gpt-5.6-terra`, commit `a9c2b9a` (main, non poussé).

## Le chemin qui marche (prouvé live)

La forme abonnement **local** est la seule que le wrapper codex-acp accepte
in-box. Chaîne prouvée deux fois :

1. **Host** : `codex exec -m gpt-5.6-terra` → `pong` (login `~/.codex/auth.json`,
   profil `codex-local`, self-refresh).
2. **Box e2b** : spawn daemon → seed de l'auth.json hôte dans la box via
   `setupCommands` → wrapper passe → premier tour `pong` sur
   `gpt-5.6-terra` (session `rdv-codex-box-f`, auth résolue
   `subscription · cli-local-login`, profil `codex-local` automatiquement).
3. **Salle réelle** : room RDV-YYLP créée via `/inbound/simulated` (membre
   console — aucun téléphone touché), message → `→ [Jeremy/messenger] pong`
   livré. Le service tourne sur codex/terra depuis 14:53.

## Pourquoi les routes « propres » ont échoué (mesuré, pas deviné)

- **Clé API** : `RDV_OPENAI_API_KEY` voit bien `gpt-5.6-terra` dans `/v1/models`
  — mais le wrapper codex-acp **exige le fichier** `~/.codex/auth.json` en
  forme abonnement (`tokens.access_token`) AVANT de considérer
  `CODEX_API_KEY`/`OPENAI_API_KEY` en env (source lue dans
  `@agentclientprotocol/codex-acp@1.10.0`, dist/index.js:25354+).
- **`auth: {mode:"api-key"}` + `env.autoPassthrough`** (probes B/C) : la clé
  n'atteint jamais l'env de la box — `resolveSandboxSecret` =
  `process.env[slug]` du daemon (cli serve.ts:602), et l'env du daemon n'a pas
  la clé. Sans redémarrage daemon, pas de valeur.
- **Env daemon + `env.passthrough`** : marche, mais exige un redémarrage du
  daemon (tue les sessions vivantes) et facture en crédits API au lieu de
  l'abonnement.

Le seed du login hôte (probe E/F) l'emporte : zéro redémarrage daemon,
facturation abonnement, self-refresh lu à chaque boot de room.

## Le patch (commit `a9c2b9a`)

`src/sandbox/boot.ts` : `codexAuthSeedCommand()` lit `~/.codex/auth.json`
hôte en base64 et le sème in-box via `setupCommands` quand
`adapter === "codex"` ; branché sur les DEUX chemins de spawn (boot frais +
re-serve fallback de resume — le beat 6 de la démo re-seed donc sur box
neuve). Test ajusté (host-agnostique : le seed est asserté s'il existe).
check-types OK, 20/20 tests ciblés, suite complète relancée.

## État op pour la démo

- Service UP en PTY dédié (`rdv-service`, agentproto) sur codex/terra ;
  tunnel public `rdv.clipgen.co/health` → 200 (connecteur relancé — il était
  éteint, 1033).
- **À re-répéter avant prise** : les beats étaient calibrés sur le
  comportement claude (arbitrage broadcasté, mesure 2× du 09-14). terra peut
  arbitrer/annoncer différemment — refaire la répétition chronométrée.
- Repli claude : redémarrer le service SANS les deux vars RDV_AGENT_*.
- L'abonnement codex est partagé entre les rooms et les sessions hôte — les
  rate limits ChatGPT s'appliquent ; une room + des sessions codex hôte
  actives en même temps se partagent le quota.
