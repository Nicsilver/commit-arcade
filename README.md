<h1 align="center">Commit Arcade</h1>

<p align="center">
  Your GitHub contribution graph, played as a classic arcade game.<br>
  Ten games, rendered as animated SVGs you can drop into your profile README.
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/snake.svg">
    <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/snake-light.svg" alt="A snake eating a contribution graph and growing with every commit">
  </picture>
</p>

## The games

| Game | What happens |
| --- | --- |
| `snake` | The snake eats your contributions and grows with every one. Each body segment keeps the colour of the day it ate. |
| `pacman` | Pac-Man clears the graph while four ghosts give chase. Power pellets sit in the corners, and the maze flashes when the board is clear. |
| `breakout` | Your days are bricks. Busy days crack before they break, and a fireball finishes the wall. |
| `invaders` | Every contribution is an invader marching in formation. Bunkers, bombs and a mystery ship included. |
| `asteroids` | The ship warps in and shoots your graph apart. Busy days split into drifting rocks first. |
| `tetris` | Your graph drops into a stack, tetrominoes fill the gaps and the lines clear. Ends on a Tetris when the board allows it. |
| `bomberman` | Days are soft blocks. Bomberman plants bombs, runs for cover and picks up power-ups along the way. |
| `galaga` | Your days are the enemy formation. Dive attacks, a tractor-beam capture and the dual fighter rescue. |
| `centipede` | Your contributions are the mushroom field. Shoot the centipede and it splits, leaving new mushrooms behind. |
| `tron` | Two light cycles race for your days and derez every one they touch. Only one of them makes it to the end. |
| `daily` | A different game every day, picked from the date. |

<details>
<summary>See them all</summary>

### Pac-Man
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/pacman.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/pacman-light.svg" alt="Pac-Man on a contribution graph">
</picture>

### Breakout
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/breakout.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/breakout-light.svg" alt="Breakout on a contribution graph">
</picture>

### Space Invaders
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/invaders.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/invaders-light.svg" alt="Space Invaders on a contribution graph">
</picture>

### Asteroids
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/asteroids.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/asteroids-light.svg" alt="Asteroids on a contribution graph">
</picture>

### Tetris
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/tetris.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/tetris-light.svg" alt="Tetris on a contribution graph">
</picture>

### Bomberman
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/bomberman.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/bomberman-light.svg" alt="Bomberman on a contribution graph">
</picture>

### Galaga
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/galaga.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/galaga-light.svg" alt="Galaga on a contribution graph">
</picture>

### Centipede
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/centipede.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/centipede-light.svg" alt="Centipede on a contribution graph">
</picture>

### Tron
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/tron.svg">
  <img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/tron-light.svg" alt="Tron on a contribution graph">
</picture>

### Neon theme
<img src="https://raw.githubusercontent.com/Nicsilver/commit-arcade/output/neon.svg" alt="Today's game in the neon theme">

</details>

## Put it on your profile

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

Want one game every day instead of a rotation? Swap `game=daily` for one game: `snake`, `pacman`, `breakout`, `invaders`, `asteroids`, `tetris`, `bomberman`, `galaga`, `centipede`, `tron`. You can list as many outputs as you like.

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
