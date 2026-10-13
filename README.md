# OpenSilkroadMap

The hackable [**Silkroad Online**](http://www.joymax.com/silkroad/) world map.

![map](map.png)

## Features

- Explore the world map, dungeons and navmeshes
- Search objects (NPCs, teleporters)
- [NavLink](https://github.com/Silkroad-Developer-Community/Silkroad-NavLink) integration
- Teleport actions, displays
- Show coordinates, region on hover
- Cachable zoom levels
- Generate maps for any Silkroad Online version with only a few scripts

## Getting Started

### Prerequisites

- [Node.js](https://deno.com/) (v18+)
- [Python 3.10+](https://www.python.org/) with [uv](https://github.com/astral-sh/uv) (recommended) or standard pip for asset processing.

### 1. Install Dependencies

```shell
deno install
```

### 2. Extracting Client Files (.pk2)

Extract the PK2 archives into the `game_source` folder:

You can use the [pk2_mate tool binary](https://github.com/Veykril/pk2/releases).

```shell
mkdir game_source
pk2_mate extract --archive "C:\Games\SRO\Media.pk2" --out "game_source\Media"
pk2_mate extract --archive "C:\Games\SRO\Data.pk2" --out "game_source\Data"
```

### 3. Processing Silkroad Assets

```shell
uv run scripts/generate_pmtiles.py
uv run scripts/generate_game_data.py
```

You can delete the `game_source` directory afterwards.

### 4. Run the Development Server

```shell
deno task dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Credits

- Initial work done by [Jellybitz](https://github.com/JellyBitz) on [xSROMap](https://github.com/JellyBitz/xSROMap)
- Integrated changes made on [kis1yi](https://github.com/kis1yi)'s [fork](https://github.com/kis1yi/xSROMap)
- Adjustments, cleanup, integrations to OasisBot and scripts to further improve reproducibility by [Egezenn](https://github.com/Egezenn)

## TODO

- Opacity sliders for layers
- OasisBot connection
  - Dungeon integration (on NavLink display, need to quantize heights on dungeon regions so that they don't render on top of each other)
