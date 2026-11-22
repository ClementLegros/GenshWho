# GenshWho

Jeu de devinettes à deux joueurs avec les personnages de Genshin Impact : chacun choisit un personnage secret, puis on se pose à tour de rôle des questions fermées (oui / non) pour trouver celui de l'adversaire.

Projet de fan non officiel, sans lien avec HoYoverse.

## Lancer

```bash
npm install
npm start          # http://localhost:3000  (PORT=8080 npm start pour changer de port)
```

Un joueur crée un salon et envoie le lien (ou le code à 5 caractères) à l'autre.

## Fonctionnement

- `server.js` : serveur HTTP + WebSocket (`/ws`). Il gère les salons et toute la logique de partie ; le personnage secret d'un joueur n'est jamais envoyé à l'adversaire avant la fin.
- `characters.js` : récupère la liste des personnages sur l'API publique de [gi.yatta.moe](https://gi.yatta.moe) au démarrage puis toutes les 6 heures. Les personnages annoncés mais pas encore sortis sont masqués jusqu'à leur date de sortie. La liste et les images sont mises en cache dans `data/`, donc le site continue de marcher si l'API est momentanément indisponible.
- `public/` : interface (HTML/CSS/JS sans framework ni étape de build).

Les salons vivent en mémoire : un redémarrage du serveur interrompt les parties en cours.

## Mettre en ligne

Il faut un hébergeur qui garde un processus Node allumé et accepte les WebSockets (Render, Railway, Fly.io, un VPS…). Un hébergement purement statique ne suffit pas.
