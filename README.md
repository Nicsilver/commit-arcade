<p align="center">
  <img src="assets/banner.svg" width="100%" alt="Commit Arcade: 10 classic games on your contribution graph">
</p>

<p align="center">
  <a href="https://github.com/Nicsilver/commit-arcade/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Nicsilver/commit-arcade/ci.yml?branch=main&style=for-the-badge&label=build&color=7c5cff" alt="Build status"></a>
  <img src="https://img.shields.io/badge/games-10-ff4df0?style=for-the-badge" alt="10 games">
  <img src="https://img.shields.io/badge/JavaScript_in_the_SVGs-none-23f0ff?style=for-the-badge" alt="No JavaScript in the SVGs">
  <img src="https://img.shields.io/badge/license-MIT-f5b53d?style=for-the-badge" alt="MIT license">
</p>

<p align="center">
  <b>Your GitHub contribution graph, played as a classic arcade game.</b><br>
  Snake, Pac-Man, Breakout, Space Invaders, Asteroids, Tetris, Bomberman, Galaga, Centipede and Tron,<br>
  each simulated on your real graph and rendered as an animated SVG for your profile README.
</p>

<p align="center">
  <a href="#insert-coin">Insert coin</a> ·
  <a href="#the-games">The games</a> ·
  <a href="#options">Options</a> ·
  <a href="#how-it-works">How it works</a>
</p>

<br>

<p align="center">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/neon.svg" width="100%" alt="Today's game in the neon theme">
</p>
<p align="center"><sub>Today's game on my own graph, in the <code>neon</code> theme. It changes every day.</sub></p>

## Insert coin

Three steps, GitHub only, nothing to host.

1. Create `.github/workflows/arcade.yml` in your profile repo (the one named after your username):

```yaml
name: Arcade

on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  arcade:
    runs-on: ubuntu-latest
    steps:
      - uses: Nicsilver/commit-arcade@v1
        with:
          outputs: |
            dist/arcade.svg?game=daily&theme=github-dark
            dist/arcade-light.svg?game=daily&theme=github-light

      - uses: crazy-max/ghaction-github-pages@v4
        with:
          target_branch: output
          build_dir: dist
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

2. Run it once from the Actions tab (it also runs every night after that).

3. Add this to your `README.md`, with your username:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YOUR_NAME/YOUR_NAME/output/arcade.svg">
  <img src="https://raw.githubusercontent.com/YOUR_NAME/YOUR_NAME/output/arcade-light.svg" alt="My contribution graph as an arcade game">
</picture>
```

Want the same game every day instead of a rotation? Swap `game=daily` for one game: `snake`, `pacman`, `breakout`, `invaders`, `asteroids`, `tetris`, `bomberman`, `galaga`, `centipede`, `tron`. You can list as many outputs as you like.

## The games

Every game ends the same way: an empty board, a STAGE CLEAR card and a score equal to your contributions for the year.

### 01 · Snake <sub><code>game=snake</code></sub>

The snake eats your contributions and grows with every one. Each body segment keeps the colour of the day it came from, and it speeds up for the finish.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/snake.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/snake-light.svg" width="100%" alt="Snake played on a contribution graph">
</picture>

### 02 · Pac-Man <sub><code>game=pacman</code></sub>

Pac-Man clears the graph while Blinky, Pinky, Inky and Clyde give chase. Power pellets sit in the corners, ghosts are worth 200 to 1600, and the maze flashes when the board is clear.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/pacman.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/pacman-light.svg" width="100%" alt="Pac-Man played on a contribution graph">
</picture>

### 03 · Breakout <sub><code>game=breakout</code></sub>

Your days are the wall. Busy days crack before they break, chips fly, and a fireball smashes through the last third.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/breakout.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/breakout-light.svg" width="100%" alt="Breakout played on a contribution graph">
</picture>

### 04 · Space Invaders <sub><code>game=invaders</code></sub>

Every contribution is an invader marching in formation. Bunkers, zigzag bombs and the mystery ship included.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/invaders.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/invaders-light.svg" width="100%" alt="Space Invaders played on a contribution graph">
</picture>

### 05 · Asteroids <sub><code>game=asteroids</code></sub>

The ship warps in and shoots your graph apart. Busy days split into drifting rocks first, and a flying saucer drops by.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/asteroids.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/asteroids-light.svg" width="100%" alt="Asteroids played on a contribution graph">
</picture>

### 06 · Tetris <sub><code>game=tetris</code></sub>

Your graph settles into a stack, tetrominoes fill the gaps and the lines sweep away. It finishes on a Tetris when the board allows it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/tetris.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/tetris-light.svg" width="100%" alt="Tetris played on a contribution graph">
</picture>

### 07 · Bomberman <sub><code>game=bomberman</code></sub>

Days are soft blocks. Bomberman plants bombs, runs for cover, sets off chain reactions and picks up power-ups along the way.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/bomberman.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/bomberman-light.svg" width="100%" alt="Bomberman played on a contribution graph">
</picture>

### 08 · Galaga <sub><code>game=galaga</code></sub>

Your days are the enemy formation. Looping dive attacks, the tractor-beam capture and the dual fighter rescue.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/galaga.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/galaga-light.svg" width="100%" alt="Galaga played on a contribution graph">
</picture>

### 09 · Centipede <sub><code>game=centipede</code></sub>

Your contributions are the mushroom field. Shoot the centipede and it splits, leaving new mushrooms behind. Watch out for the flea and the spider.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/centipede.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/centipede-light.svg" width="100%" alt="Centipede played on a contribution graph">
</picture>

### 10 · Tron <sub><code>game=tron</code></sub>

Two light cycles race for your days and derez every one they touch. They cut each other off until only one is left.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/tron.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/tron-light.svg" width="100%" alt="Tron played on a contribution graph">
</picture>

### Neon <sub><code>theme=neon</code></sub>

Any game on its own dark cabinet with a stronger glow, like the one at the top. The `github-dark` and `github-light` themes are transparent, so they sit on your profile like the real graph.

And `game=daily` picks a different one every day, so your profile is never the same two days running.

## Options

Each output line is a file path followed by options:

```
dist/arcade.svg?game=pacman&theme=neon&accent=#ff4df0
```

| Option | Values | Default |
| --- | --- | --- |
| `game` | `snake`, `pacman`, `breakout`, `invaders`, `asteroids`, `tetris`, `bomberman`, `galaga`, `centipede`, `tron`, `daily` | `snake` |
| `theme` | `github-dark`, `github-light`, `neon` | `github-dark` |
| `background` | a colour, or `none` for transparent | from theme |
| `empty` | colour of days without contributions | from theme |
| `levels` | four comma-separated colours, light to heavy | from theme |
| `sprites` | four comma-separated colours for sprites made from days | follows `levels` |
| `ink`, `muted`, `accent`, `surface` | colours for text, the player and banners | from theme |

Action inputs:

| Input | Default |
| --- | --- |
| `outputs` | required |
| `github_user_name` | the repository owner |
| `github_token` | `${{ github.token }}` |

## Run it locally

```sh
git clone https://github.com/Nicsilver/commit-arcade
cd commit-arcade
GITHUB_TOKEN=... node dist/cli.js --user YOUR_NAME --game all --out preview
node dist/cli.js --sample --game pacman --theme neon --out preview
```

No dependencies at runtime. Node 22.18 or newer.

## How it works

Each game is simulated on your actual graph first: the snake does pathfinding without biting itself, the Breakout paddle aims its returns at bricks that are left, the invaders get shot column by column, Tetris only makes legal drops, and Bomberman never stands in a blast. The simulation records when everything moves, and that timeline is compiled into CSS keyframes on one shared loop. There's no JavaScript in the SVGs, so GitHub renders them as plain images.

The score at the top counts your contributions as the game clears them, so every run ends on your total for the year.

The same graph always plays the same game, so the image only changes when your contributions do.

## Development

```sh
npm ci
npm test
npm run demo     # renders every game on a sample graph into demo/
npm run build    # bundles dist/, which the action runs from
```

Inspired by [Platane/snk](https://github.com/Platane/snk), the snake that started it all.

## License

MIT
