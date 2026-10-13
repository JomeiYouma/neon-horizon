# Neon Horizon

**Jouer en ligne :** https://jomeiyouma.github.io/neon-horizon/

Jeu de rythme en Three.js dans un décor synthwave. Des sphères roulent sur les
lignes d'une grille et se frappent au clavier (`A` `Z` `O` `P`) quand elles
atteignent les anneaux. Les notes ne sont pas écrites à la main : elles sont
déduites du morceau lui-même, au chargement.

![Une partie en cours : sphères sur la grille, combo et soleil à l'horizon](docs/partie.webp)

## Jouer

1. Choisir un fichier audio sur l'écran d'accueil (MP3, WAV, OGG…). Il est
   décodé et analysé dans le navigateur, rien n'est envoyé.
2. `Espace` pour démarrer, puis `A` `Z` à gauche et `O` `P` à droite.
3. À la fin du morceau : nombre de Perfect, Good et Miss, combo maximal et
   précision.

Les curseurs en bas à droite règlent la hauteur, la vitesse et l'amplitude du
relief. Le relief réagit au morceau, ou au microphone si on bascule la source.

## Fonctionnement

- **Génération des notes** (`src/lib/chart.js`) : flux spectral pour repérer
  les attaques, suivi du tempo, puis placement sur une grille de doubles
  croches. Le nombre de notes suit l'intensité du passage, et la piste dépend
  de la hauteur du son : graves à gauche, aigus à droite.
- **Jeu** (`src/rhythm.js`) : fenêtres de 50 ms (Perfect) et 120 ms (Good)
  autour de la note, compensées par la latence de sortie audio. Sphères,
  anneaux et ondes de choc sont dessinés par des shaders.
- **Audio** (`src/lib/audio.js`) : un seul graphe Web Audio. Un raté étouffe
  le morceau un instant (filtre passe-bas), et les sons de retour sont
  synthétisés, sans hauteur, pour ne jamais jurer avec la tonalité.
- **Décor** (`src/script.js`) : trois plans déplacés en boucle, relief animé
  dans le vertex shader, fondu de distance tramé, bloom et décalage RVB. En
  jeu, le défilement est calé sur le tempo pour que les sphères restent sur
  les lignes.

## Lancer en local

```bash
npm install
npm run dev     # serveur de développement
npm run build   # build de production dans dist/
```

En développement, un morceau placé dans `static/` sous le nom
`one-more-time--aerodynamic.mp3` est chargé par défaut. Les MP3 de ce dossier
ne sont pas versionnés.

## Crédits

Projet réalisé en MMI3 (développement front, 2026), à partir du
[starter Three.js](https://github.com/rdad/three-starter) fourni pour le cours.
