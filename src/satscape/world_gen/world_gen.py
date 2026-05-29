#!/usr/bin/env python3
"""
SNES-style overworld generator — sophisticated edition.

Layers:
 1. ELEVATION + MOISTURE noise maps → biome assignment (organic boundaries)
 2. RIVER carving from high elevation to coast, with bridges where paths cross
 3. PATH network connecting landmark sites via A*, smoothed
 4. LANDMARKS: castles, multi-tile cottages, windmills, watchtowers, ruins
 5. AUTOTILE-aware base rendering with proper edges between biomes
 6. DECORATION pass: flowers, rocks, stumps, signs, scattered trees
 7. Coastline outlining + foam
"""

import os, math, random, heapq, json, base64, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops
from pathlib import Path
from collections import deque

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SEED = 11
random.seed(SEED); np.random.seed(SEED)

OUT = Path(__file__).resolve().parent.parent / "world.png"
DATA_OUT = OUT.parent / "world.json"
CHUNK_DIR = Path(__file__).resolve().parent / "chunks"
CHUNK_TILES = 32

# ── Canvas ───────────────────────────────────────────────────────────────
TILE  = 18
MAP_W = 380
MAP_H = 335
W, H  = MAP_W * TILE, MAP_H * TILE

# ── Biome IDs ────────────────────────────────────────────────────────────
OCEAN, DEEP, BEACH, SAND, GRASS, GRASS_LUSH, FOREST, F_DENSE, F_DARK, \
SWAMP, MOUNT, SNOW, LAKE, RIVER, PATH, FARM_V, FARM_H, ORCHARD, \
STONE_FLOOR, HOUSE, CASTLE, BRIDGE, \
AUTUMN_FOREST, CHERRY_GROVE, WHEAT_FIELD, BAMBOO_GROVE, DESERT, \
HIGHWAY, TRAIL = range(29)

NAMES = {OCEAN:'OCEAN', DEEP:'DEEP', BEACH:'BEACH', SAND:'SAND',
         GRASS:'GRASS', GRASS_LUSH:'GRASS_LUSH', FOREST:'FOREST',
         F_DENSE:'F_DENSE', F_DARK:'F_DARK', SWAMP:'SWAMP', MOUNT:'MOUNT',
         SNOW:'SNOW', LAKE:'LAKE', RIVER:'RIVER', PATH:'PATH',
         FARM_V:'FARM_V', FARM_H:'FARM_H', ORCHARD:'ORCHARD',
         STONE_FLOOR:'STONE_FLOOR', HOUSE:'HOUSE', CASTLE:'CASTLE',
         BRIDGE:'BRIDGE'}

# Priority for autotile transitions: higher overrides lower
PRIORITY = {
    OCEAN: 0, DEEP: 0, LAKE: 2, RIVER: 2,
    BEACH: 3, SAND: 4, DESERT: 4,
    GRASS: 5, GRASS_LUSH: 5, SWAMP: 5, WHEAT_FIELD: 5,
    FOREST: 6, F_DENSE: 6, F_DARK: 6, ORCHARD: 6,
    AUTUMN_FOREST: 6, CHERRY_GROVE: 6, BAMBOO_GROVE: 6,
    FARM_V: 7, FARM_H: 7,
    MOUNT: 8, SNOW: 8,
    PATH: 9, BRIDGE: 9, STONE_FLOOR: 9, HIGHWAY: 9, TRAIL: 8,
    HOUSE: 10, CASTLE: 10,
}

# Cells the player can walk on (used for path routing)
WALKABLE = {GRASS, GRASS_LUSH, BEACH, SAND, FOREST, ORCHARD, F_DENSE,
            FARM_V, FARM_H, PATH, STONE_FLOOR}

# Decoration footprints that should block player movement. Water is omitted on
# purpose: TypeScript gates water through the boat hook so boats can unlock it.
SOLID_BIOMES = {HOUSE, CASTLE, MOUNT, SNOW}
SOLID_DECORATION_FOOTPRINTS = {
    # Buildings and substantial structures.
    'house': (2, 2), 'cottage': (2, 2), 'big_house': (3, 3),
    'church': (3, 4), 'barn': (3, 2), 'watchtower': (1, 3),
    'windmill': (2, 3), 'castle': (6, 5), 'ruined_tower': (1, 2),
    'witch_hut': (2, 2), 'lighthouse': (2, 4), 'mage_tower': (2, 4),
    'pagoda': (2, 3), 'cabin': (2, 2), 'old_mill': (2, 2),
    'mushroom_village': (2, 2), 'bandit_camp': (2, 2),
    'ambush_camp': (2, 2), 'spider_lair': (2, 2),
    'pyramid': (3, 3), 'volcano': (3, 3), 'world_tree': (3, 3),
    'sky_island': (3, 3),
    # Player-visible obstacles.
    'rock': (1, 1), 'crystal': (1, 1), 'crystal_pillar': (1, 2),
    'monolith': (1, 1), 'obelisk': (1, 1), 'statue': (1, 1),
    'stone_circle': (1, 1), 'ancient_gate': (2, 1),
    'whale_bones': (2, 1), 'wagon_graveyard': (1, 1),
    'buried_giant': (1, 1), 'knight_tomb': (1, 2),
    'fence': (1, 1),
}


def mark_rect(mask, x, y, w=1, h=1):
    for dy in range(h):
        for dx in range(w):
            tx, ty = x + dx, y + dy
            if 0 <= tx < MAP_W and 0 <= ty < MAP_H:
                mask[ty, tx] = 1


def build_solid_mask(biome, decorations):
    mask = np.zeros((MAP_H, MAP_W), dtype=np.uint8)
    mask[np.isin(biome, list(SOLID_BIOMES))] = 1
    for deco in decorations:
        kind, x, y = deco[0], deco[1], deco[2]
        footprint = SOLID_DECORATION_FOOTPRINTS.get(kind)
        if footprint:
            mark_rect(mask, x, y, footprint[0], footprint[1])
    return mask


def encode_grid(arr):
    grid = np.ascontiguousarray(arr)
    return base64.b64encode(grid.tobytes()).decode("ascii")


def export_world_data(biome, solid, landmarks_by_kind):
    data = {
        "seed": SEED,
        "width": MAP_W,
        "height": MAP_H,
        "encoding": "uint8-base64-rowmajor",
        "biome": encode_grid(biome.astype(np.uint8)),
        "solid": encode_grid(solid.astype(np.uint8)),
        "landmarks": {
            kind: [[int(x), int(y)] for x, y in landmarks_by_kind.get(kind, [])]
            for kind in ("castle", "town", "village", "farmstead", "discovery")
        },
    }
    DATA_OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")


def slice_world_chunks(canvas):
    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    for old in CHUNK_DIR.glob("chunk_*.png"):
        old.unlink()
    cols = math.ceil(MAP_W / CHUNK_TILES)
    rows = math.ceil(MAP_H / CHUNK_TILES)
    for row in range(rows):
        for col in range(cols):
            x0 = col * CHUNK_TILES * TILE
            y0 = row * CHUNK_TILES * TILE
            x1 = min((col + 1) * CHUNK_TILES, MAP_W) * TILE
            y1 = min((row + 1) * CHUNK_TILES, MAP_H) * TILE
            canvas.crop((x0, y0, x1, y1)).convert("RGB").save(
                CHUNK_DIR / f"chunk_{col}_{row}.png",
                optimize=True,
            )
    manifest = {
        "tile": TILE,
        "chunkTiles": CHUNK_TILES,
        "cols": cols,
        "rows": rows,
        "worldTilesX": MAP_W,
        "worldTilesY": MAP_H,
    }
    (CHUNK_DIR / "manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")),
        encoding="utf-8",
    )

# ── Palette ──────────────────────────────────────────────────────────────
C = {
    'ocean':      (60, 155, 220),  'ocean_lt': (95, 180, 235),
    'deep':       (40, 110, 180),
    'beach':      (220, 195, 130), 'beach_dk': (170, 135, 80),
    'sand':       (235, 210, 130), 'sand_dk':  (190, 160, 80),
    'coast':      (150, 90, 40),   'coast_dk': (105, 60, 25),
    'grass':      (118, 200, 75),  'grass_lt': (160, 225, 95),
    'grass_dk':   (75, 160, 50),   'grass_blade': (50, 130, 35),
    'lush':       (95, 185, 60),   'lush_lt':  (140, 215, 80),
    'swamp':      (90, 130, 70),   'swamp_dk': (60, 95, 50),
    'tree_dk':    (24, 75, 28),    'tree':     (45, 115, 42),
    'tree_lt':    (85, 155, 60),
    'tree_orange':(170, 95, 40),   'tree_red': (190, 70, 50),
    'mountain':   (165, 155, 145), 'mountain_dk': (110, 100, 95),
    'mountain_lt':(210, 205, 200),
    'snow':       (240, 245, 252), 'snow_dk':  (195, 210, 225),
    'farm_dirt':  (130, 80, 50),   'farm_dirt_dk':(95, 55, 30),
    'crop_y':     (220, 175, 60),  'crop_y_dk':(160, 120, 35),
    'crop_g':     (110, 175, 60),  'crop_g_dk':(70, 130, 35),
    'path':       (220, 175, 110), 'path_dk':  (170, 125, 70),
    'path_lt':    (240, 210, 155),
    'stone':      (200, 195, 180), 'stone_dk': (140, 135, 120),
    'stone_lt':   (225, 220, 210),
    'water':      (75, 165, 220),  'water_dk': (50, 130, 190),
    'water_lt':   (155, 210, 235),
    'wood':       (115, 75, 40),   'wood_dk':  (75, 50, 28),
    'wood_lt':    (160, 110, 65),
    'roof':       (195, 75, 55),   'roof_dk':  (140, 50, 38),
    'roof_lt':    (225, 110, 85),
    'roof_blue':  (75, 100, 180),  'roof_blue_dk':(50, 70, 130),
    'wall':       (240, 225, 195), 'wall_dk':  (200, 180, 145),
    'flower_r':   (220, 70, 70),   'flower_w': (250, 245, 230),
    'flower_p':   (240, 150, 175), 'flower_y': (245, 220, 90),
    'flower_b':   (140, 130, 230),
    # Extra biome colors
    'autumn':     (210, 130, 60),  'autumn_dk':  (165, 90, 35),
    'autumn_lt':  (240, 175, 95),
    'cherry':     (240, 175, 200), 'cherry_dk':  (200, 110, 150),
    'cherry_lt':  (255, 215, 235),
    'wheat':      (225, 195, 95),  'wheat_dk':   (175, 145, 60),
    'bamboo':     (130, 200, 90),  'bamboo_dk':  (85, 140, 55),
    'bamboo_lt':  (185, 235, 130),
    'desert':     (235, 200, 130), 'desert_dk':  (190, 155, 85),
    'lava':       (220, 80, 30),
}


# ════════════════════════════════════════════════════════════════════════
# NOISE & BIOME ASSIGNMENT
# ════════════════════════════════════════════════════════════════════════

def fbm(w, h, octaves=6, seed=0, persistence=0.5):
    rng = np.random.RandomState(seed)
    out = np.zeros((h, w), float); amp = 1.0; tot = 0.0; f = 3
    for _ in range(octaves):
        n = rng.rand(max(3, h//f+2), max(3, w//f+2))
        scaled = np.array(Image.fromarray((n*255).astype(np.uint8))
                          .resize((w, h), Image.BICUBIC)) / 255.
        out += scaled * amp
        tot += amp
        amp *= persistence; f *= 2
    out /= tot
    return (out - out.min()) / (out.max() - out.min())


def assign_biomes():
    """Generate the world's biome grid from layered noise maps."""
    print("Generating noise maps…")
    elev   = fbm(MAP_W, MAP_H, 7, SEED, 0.55)
    moist  = fbm(MAP_W, MAP_H, 5, SEED+10, 0.5)
    temp   = fbm(MAP_W, MAP_H, 4, SEED+20, 0.5)
    detail = fbm(MAP_W, MAP_H, 3, SEED+30, 0.5)

    # ─── 3-5 MAJOR ISLANDS, larger size, more lobes, more land coverage ───
    ys, xs = np.mgrid[0:MAP_H, 0:MAP_W]
    n_islands = random.randint(3, 5)
    centers = []
    island_seeds = []

    # Use a 2D placement instead of horizontal strip so we use more vertical space
    for i in range(n_islands):
        # Quasi-random positions across the entire map, with some spacing
        for _attempt in range(50):
            cand_x = random.uniform(0.18, 0.82) * MAP_W
            cand_y = random.uniform(0.18, 0.82) * MAP_H
            if all(math.hypot(cand_x-sx, cand_y-sy) > 0.20 * min(MAP_W, MAP_H)
                   for sx, sy in island_seeds):
                break
        sector_x, sector_y = cand_x, cand_y
        # BIGGER main blob (was 0.13-0.20, now 0.16-0.24)
        rw = random.uniform(0.16, 0.24)
        rh = random.uniform(0.16, 0.24)
        centers.append((sector_x, sector_y, rw, rh))
        island_seeds.append((sector_x, sector_y))
        # 3-5 secondary lobes per island, larger
        for _ in range(random.randint(3, 5)):
            ox = random.uniform(-0.14, 0.14) * MAP_W
            oy = random.uniform(-0.14, 0.14) * MAP_H
            lrw = random.uniform(0.10, 0.18)
            lrh = random.uniform(0.10, 0.18)
            centers.append((sector_x + ox, sector_y + oy, lrw, lrh))

    # Composite falloff from all centers
    fall = np.zeros((MAP_H, MAP_W), float)
    for cx_, cy_, rw, rh in centers:
        dist = np.sqrt(((xs - cx_) / (MAP_W * rw)) ** 2 +
                       ((ys - cy_) / (MAP_H * rh)) ** 2)
        lobe_fall = np.clip(1.0 - dist ** 1.8, 0, 1)
        fall = np.maximum(fall, lobe_fall)

    # Perturb coastline so coastlines look natural
    coast_noise = fbm(MAP_W, MAP_H, 3, SEED + 99, 0.55)
    land_strength = fall * 1.0 + elev * 0.30 + (coast_noise - 0.5) * 0.20 - 0.55

    # Mountain noise is INDEPENDENT of falloff — small clustered regions only
    mountain_n = fbm(MAP_W, MAP_H, 5, SEED+40, 0.55)

    biome = np.full((MAP_H, MAP_W), OCEAN, dtype=np.int8)

    for y in range(MAP_H):
        for x in range(MAP_W):
            ls = land_strength[y, x]
            e  = elev[y, x]
            m  = moist[y, x]
            t  = temp[y, x]
            d  = detail[y, x]
            mn = mountain_n[y, x]

            if ls < -0.05:
                biome[y, x] = DEEP if ls < -0.18 else OCEAN
            elif ls < 0.02:
                biome[y, x] = BEACH
            elif ls < 0.08 and m < 0.32:
                biome[y, x] = SAND
            elif mn > 0.72:
                # Mountain region. Snow only at the very top of the mountain.
                biome[y, x] = SNOW if (mn > 0.86 and t < 0.32) else MOUNT
            else:
                # mid land: biome by (moisture, temperature, detail)
                if m > 0.72 and ls < 0.25:
                    biome[y, x] = SWAMP
                elif m > 0.65 and d > 0.6:
                    biome[y, x] = F_DARK
                elif m > 0.55:
                    # Cool damp area → forest variants
                    if t < 0.32 and d > 0.55:
                        biome[y, x] = AUTUMN_FOREST
                    else:
                        biome[y, x] = F_DENSE
                elif m > 0.42:
                    # Warm humid + low detail = bamboo
                    if t > 0.65 and m > 0.48 and d < 0.42:
                        biome[y, x] = BAMBOO_GROVE
                    else:
                        biome[y, x] = FOREST
                elif m > 0.28:
                    biome[y, x] = GRASS_LUSH
                elif m < 0.18 and t > 0.70 and ls > 0.10:
                    biome[y, x] = DESERT
                else:
                    biome[y, x] = GRASS

    # Clean up: BEACH must be near ocean only
    for y in range(MAP_H):
        for x in range(MAP_W):
            if biome[y, x] == BEACH:
                has_ocean = any(0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                                and biome[y+dy, x+dx] in (OCEAN, DEEP)
                                for dy, dx in [(-1,0),(1,0),(0,-1),(0,1),
                                               (-1,-1),(-1,1),(1,-1),(1,1)])
                if not has_ocean:
                    biome[y, x] = GRASS

    # Keep all connected landmasses ABOVE a minimum size — that way 2-3 major
    # islands can survive (not just the largest). Small noise blobs go to ocean.
    def is_land(t): return t not in (OCEAN, DEEP)
    MIN_ISLAND_CELLS = max(200, (MAP_W * MAP_H) // 200)
    visited = np.zeros_like(biome, dtype=bool)
    keep = np.zeros_like(biome, dtype=bool)
    for sy in range(MAP_H):
        for sx in range(MAP_W):
            if visited[sy, sx] or not is_land(biome[sy, sx]): continue
            # BFS this component
            q = deque([(sy, sx)])
            visited[sy, sx] = True
            cells = []
            while q:
                y, x = q.popleft()
                cells.append((y, x))
                for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
                    ny, nx = y+dy, x+dx
                    if 0 <= ny < MAP_H and 0 <= nx < MAP_W and not visited[ny, nx]:
                        if is_land(biome[ny, nx]):
                            visited[ny, nx] = True
                            q.append((ny, nx))
            if len(cells) >= MIN_ISLAND_CELLS:
                for cy_, cx_ in cells:
                    keep[cy_, cx_] = True
    # Convert tiny disconnected blobs to ocean
    for y in range(MAP_H):
        for x in range(MAP_W):
            if is_land(biome[y, x]) and not keep[y, x]:
                biome[y, x] = OCEAN

    # Smooth biome boundaries with a simple majority filter (2 passes)
    from collections import Counter
    for _pass in range(2):
        new = biome.copy()
        for y in range(1, MAP_H-1):
            for x in range(1, MAP_W-1):
                if biome[y, x] in (OCEAN, DEEP): continue
                nb = [biome[y+dy, x+dx] for dy in range(-1,2) for dx in range(-1,2)]
                non_ocean = [n for n in nb if n not in (OCEAN, DEEP)]
                if non_ocean:
                    common = Counter(non_ocean).most_common(1)[0]
                    if common[1] >= 6:
                        new[y, x] = common[0]
        biome = new

    # Remove tiny snow / mountain fragments — replace with surrounding biome
    for t in (SNOW, MOUNT):
        for y in range(MAP_H):
            for x in range(MAP_W):
                if biome[y, x] != t: continue
                same = sum(1 for dy in range(-2, 3) for dx in range(-2, 3)
                           if 0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                           and biome[y+dy, x+dx] == t)
                # Too few same-type neighbors → not a real cluster, demote
                if same < (4 if t == MOUNT else 3):
                    # Replace with majority of NON-MOUNT/SNOW neighbors
                    other = [biome[y+dy, x+dx]
                             for dy in range(-1, 2) for dx in range(-1, 2)
                             if 0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                             and biome[y+dy, x+dx] not in (MOUNT, SNOW, OCEAN, DEEP)]
                    if other:
                        biome[y, x] = Counter(other).most_common(1)[0][0]
                    else:
                        biome[y, x] = GRASS

    # ─── FOREST COHESION: thin out forests so they have clearings ─────────
    # Real forests aren't uniform — they have openings, denser cores, sparse
    # edges. Use a low-frequency noise map to decide density per cell.
    forest_density = fbm(MAP_W, MAP_H, 5, SEED + 77, 0.55)
    edge_falloff = fbm(MAP_W, MAP_H, 3, SEED + 78, 0.5)

    forest_types = (FOREST, F_DENSE, AUTUMN_FOREST, CHERRY_GROVE, BAMBOO_GROVE)
    for y in range(MAP_H):
        for x in range(MAP_W):
            t = biome[y, x]
            if t not in forest_types: continue
            # Density 0 = clearing, 1 = thick canopy
            dens = forest_density[y, x]
            # Forest edges (cells where a neighbor is grass) get lower density
            edge_n = sum(1 for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]
                         if 0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                         and biome[y+dy, x+dx] in (GRASS, GRASS_LUSH, BEACH))
            edge_penalty = edge_n * 0.10  # reduce density at edges
            effective = dens - edge_penalty
            if effective < 0.30 + (edge_falloff[y, x] * 0.05):
                # Convert to a grass clearing
                biome[y, x] = GRASS_LUSH

    # ─── EDGE FEATHERING: extend forest sparsely into adjacent grass ───
    # Some grass cells right next to forest get scattered single trees,
    # making forest edges feel organic rather than hard-cut.
    grass_to_forest = []
    for y in range(1, MAP_H-1):
        for x in range(1, MAP_W-1):
            if biome[y, x] not in (GRASS, GRASS_LUSH): continue
            # Adjacent to forest?
            adj_forest = any(0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                             and biome[y+dy, x+dx] in (FOREST, F_DENSE,
                                                        AUTUMN_FOREST, F_DARK)
                             for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)])
            if not adj_forest: continue
            # ~25% of grass-adjacent-to-forest cells become FOREST
            if forest_density[y, x] > 0.50 and random.random() < 0.30:
                grass_to_forest.append((y, x))
    for y, x in grass_to_forest:
        # Match the forest type of a neighbor for biome cohesion
        for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
            ny, nx = y+dy, x+dx
            if 0 <= ny < MAP_H and 0 <= nx < MAP_W:
                nt = biome[ny, nx]
                if nt in (FOREST, F_DENSE, AUTUMN_FOREST, F_DARK):
                    biome[y, x] = FOREST  # use lighter forest at edges
                    break

    # ─── CLUSTER CLEANUP: only TRULY isolated rare cells get demoted.
    # Lower threshold = more autumn/bamboo/swamp areas survive, creating
    # big sweeping patches of color.
    for rare_type in (AUTUMN_FOREST, BAMBOO_GROVE):
        for y in range(MAP_H):
            for x in range(MAP_W):
                if biome[y, x] != rare_type: continue
                same = sum(1 for dy in range(-2, 3) for dx in range(-2, 3)
                           if 0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                           and biome[y+dy, x+dx] == rare_type)
                # Only kill TRULY isolated cells (need 3 neighbors instead of 5)
                if same < 3:
                    nb = [biome[y+dy, x+dx]
                          for dy in range(-1, 2) for dx in range(-1, 2)
                          if 0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                          and biome[y+dy, x+dx] not in (rare_type, OCEAN, DEEP)]
                    if nb:
                        from collections import Counter
                        biome[y, x] = Counter(nb).most_common(1)[0][0]
                    else:
                        biome[y, x] = GRASS

    # ─── GROW SWAMPS & AUTUMN: dilate them into adjacent damp cells so they
    # form bigger sweeping regions rather than small patches.
    from collections import Counter
    for _grow_pass in range(2):
        for grow_type, neighbours_required, source_types in [
            (AUTUMN_FOREST, 2, (FOREST, F_DENSE, GRASS_LUSH)),
            (SWAMP, 2, (GRASS_LUSH, FOREST, F_DENSE)),
        ]:
            new = biome.copy()
            for y in range(1, MAP_H-1):
                for x in range(1, MAP_W-1):
                    if biome[y, x] not in source_types: continue
                    nb_count = sum(1 for dy, dx in [(-1,0),(1,0),(0,-1),(0,1),
                                                    (-1,-1),(-1,1),(1,-1),(1,1)]
                                   if biome[y+dy, x+dx] == grow_type)
                    if nb_count >= neighbours_required:
                        new[y, x] = grow_type
            biome = new

    return biome, elev, moist


# ════════════════════════════════════════════════════════════════════════
# RIVERS — carve from mountain peaks down to coast
# ════════════════════════════════════════════════════════════════════════

def carve_rivers(biome, elev, n_rivers=5):
    print("Carving rivers…")
    high_cells = list(zip(*np.where((biome == MOUNT) | (biome == SNOW))))
    if not high_cells: return []
    rivers = []
    for _ in range(n_rivers):
        sy, sx = random.choice(high_cells)
        path_cells = []
        for _ in range(400):
            if biome[sy, sx] in (OCEAN, DEEP, LAKE, RIVER):
                break
            if biome[sy, sx] != MOUNT and biome[sy, sx] != SNOW:
                biome[sy, sx] = RIVER
                path_cells.append((sy, sx))
            # Step toward neighbor with lowest elevation
            best, by, bx = 1e9, sy, sx
            for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
                ny, nx = sy+dy, sx+dx
                if not (0 <= ny < MAP_H and 0 <= nx < MAP_W): continue
                cost = elev[ny, nx] + random.random()*0.05
                if cost < best:
                    best, by, bx = cost, ny, nx
            if (by, bx) == (sy, sx): break
            sy, sx = by, bx
        if path_cells:
            rivers.append(path_cells)
    return rivers


# ════════════════════════════════════════════════════════════════════════
# LANDMARKS — castles, settlements, orchards, farms
# ════════════════════════════════════════════════════════════════════════

def find_flat_area(biome, w, h, types={GRASS, GRASS_LUSH}, max_tries=400):
    """Find a w×h area where ALL cells are in `types`."""
    for _ in range(max_tries):
        x = random.randint(2, MAP_W - w - 2)
        y = random.randint(2, MAP_H - h - 2)
        ok = True
        for dy in range(h):
            for dx in range(w):
                if biome[y+dy, x+dx] not in types:
                    ok = False; break
            if not ok: break
        if ok: return x, y
    return None

def stamp_rect(biome, x, y, w, h, t):
    for dy in range(h):
        for dx in range(w):
            biome[y+dy, x+dx] = t


# Castle style presets — each one looks visually distinct.
# Used by both place_castle (to pick footprint sizes) and draw_castle_sprite.
CASTLE_STYLES = [
    {
        'name': 'royal_red',  'size': (9, 8),  'tower_count': 4, 'tower_roof': 'cone',
        'wall': (200, 195, 180), 'wall_dk': (140, 135, 120), 'wall_lt': (225, 220, 210),
        'roof': (195, 75, 55),   'roof_dk': (140, 50, 38),
        'flag_color': (195, 75, 55),
    },
    {
        'name': 'azure_keep', 'size': (8, 7),  'tower_count': 4, 'tower_roof': 'dome',
        'wall': (200, 195, 180), 'wall_dk': (140, 135, 120), 'wall_lt': (225, 220, 210),
        'roof': (75, 100, 180),  'roof_dk': (50, 70, 130),
        'flag_color': (75, 100, 180),
    },
    {
        'name': 'dark_fortress', 'size': (10, 9), 'tower_count': 4, 'tower_roof': 'cone',
        'wall': (85, 80, 90),  'wall_dk': (45, 42, 50),  'wall_lt': (120, 115, 125),
        'roof': (40, 30, 30),  'roof_dk': (20, 15, 15),
        'flag_color': (180, 30, 30),
    },
    {
        'name': 'sand_palace', 'size': (10, 8), 'tower_count': 4, 'tower_roof': 'dome',
        'wall': (220, 195, 145), 'wall_dk': (160, 130, 80), 'wall_lt': (240, 220, 175),
        'roof': (175, 130, 70),  'roof_dk': (125, 90, 45),
        'flag_color': (240, 200, 90),
    },
    {
        'name': 'small_keep', 'size': (6, 5),  'tower_count': 2, 'tower_roof': 'cone',
        'wall': (180, 175, 160), 'wall_dk': (120, 115, 105), 'wall_lt': (210, 205, 195),
        'roof': (150, 70, 50),   'roof_dk': (110, 50, 35),
        'flag_color': (220, 80, 60),
    },
    {
        'name': 'verdant_castle', 'size': (9, 8), 'tower_count': 4, 'tower_roof': 'cone',
        'wall': (200, 195, 180), 'wall_dk': (140, 135, 120), 'wall_lt': (225, 220, 210),
        'roof': (60, 130, 65),   'roof_dk': (35, 90, 40),
        'flag_color': (60, 130, 65),
    },
    {
        'name': 'mage_citadel', 'size': (8, 7), 'tower_count': 4, 'tower_roof': 'cone',
        'wall': (185, 170, 200), 'wall_dk': (130, 115, 145), 'wall_lt': (215, 200, 230),
        'roof': (110, 70, 175),  'roof_dk': (75, 50, 130),
        'flag_color': (200, 180, 240),
    },
    {
        'name': 'iron_bastion', 'size': (11, 9), 'tower_count': 4, 'tower_roof': 'flat',
        'wall': (105, 110, 115), 'wall_dk': (60, 65, 70),    'wall_lt': (145, 150, 155),
        'roof': (80, 85, 90),    'roof_dk': (40, 45, 50),
        'flag_color': (210, 50, 50),
    },
    {
        'name': 'marble_palace', 'size': (10, 8), 'tower_count': 4, 'tower_roof': 'dome',
        'wall': (235, 230, 220), 'wall_dk': (170, 165, 155), 'wall_lt': (250, 248, 245),
        'roof': (190, 50, 70),   'roof_dk': (140, 35, 55),
        'flag_color': (180, 40, 60),
    },
]

# Track placed castle positions to enforce minimum spacing.
_placed_castles = []

def place_castle(biome, decorations):
    """Place a castle with a UNIQUE style — no two castles look the same.
    Enforces minimum 35-tile distance between castles."""
    # Pick an unused style if any remain; otherwise pick any
    used_names = {s['name'] for _, _, s in _placed_castles}
    available = [s for s in CASTLE_STYLES if s['name'] not in used_names]
    style = random.choice(available) if available else random.choice(CASTLE_STYLES)

    cw, ch = style['size']
    MIN_DIST = 60   # tiles between castle centers

    # Search positions: start near center, widen outward
    for radius in (15, 25, 40, 60, 90, 130):
        for _ in range(300):
            cx_ = MAP_W // 2 + random.randint(-radius, radius)
            cy_ = MAP_H // 2 + random.randint(-radius, radius)
            x = cx_ - cw // 2
            y = cy_ - ch // 2
            if x < 2 or y < 2 or x + cw > MAP_W - 2 or y + ch > MAP_H - 2:
                continue
            # Minimum spacing from other castles
            too_close = any(
                math.hypot((x + cw // 2) - (ox + ow // 2),
                           (y + ch // 2) - (oy + oh // 2)) < MIN_DIST
                for ox, oy, s_ in _placed_castles
                for ow, oh in [s_['size']]
            )
            if too_close: continue
            # Cells available for stamping?
            ok = all(biome[y+dy, x+dx] in (GRASS, GRASS_LUSH, FOREST, F_DENSE,
                                             AUTUMN_FOREST, FOREST)
                     for dy in range(ch) for dx in range(cw))
            if ok:
                print(f"  castle '{style['name']}' at ({x},{y}) — {cw}x{ch}")
                # Carve grass clearing around it
                for dy in range(-2, ch + 2):
                    for dx in range(-2, cw + 2):
                        ay, ax = y+dy, x+dx
                        if 0 <= ay < MAP_H and 0 <= ax < MAP_W:
                            if biome[ay, ax] in (FOREST, F_DENSE, F_DARK,
                                                  ORCHARD, AUTUMN_FOREST):
                                biome[ay, ax] = GRASS_LUSH
                # Stone foundation
                stamp_rect(biome, x, y, cw, ch, STONE_FLOOR)
                _placed_castles.append((x, y, style))
                decorations.append(('castle', x, y, style))
                return (x + cw // 2, y + ch)
    return None


def place_town(biome, decorations, kind='village', avoid=None):
    """Place a multi-building settlement. kind: 'village' | 'town' | 'farmstead'.
    Returns (gate_x, gate_y) entry point or None."""
    avoid = avoid or []
    sizes = {
        'village':   (10, 8),
        'town':      (12, 10),
        'farmstead': (9, 7),
    }
    tw, th = sizes[kind]
    pos = None
    for _ in range(800):
        x = random.randint(3, MAP_W - tw - 3)
        y = random.randint(3, MAP_H - th - 3)
        if any(abs(x-ax) + abs(y-ay) < 22 for ax, ay in avoid):
            continue
        # Allow most biomes; just exclude water/mountain/buildings
        ok = all(biome[y+dy, x+dx] not in (OCEAN, DEEP, LAKE, RIVER, MOUNT, SNOW,
                                            HOUSE, CASTLE, STONE_FLOOR)
                 for dy in range(th) for dx in range(tw))
        if ok: pos = (x, y); break
    if not pos:
        print(f"  {kind}: no valid location found")
        return None
    x, y = pos
    print(f"  {kind} at ({x},{y})")
    avoid.append((x + tw//2, y + th//2))

    # Clear area to lush grass (no trees)
    for dy in range(th):
        for dx in range(tw):
            if biome[y+dy, x+dx] in (FOREST, F_DENSE, F_DARK, ORCHARD):
                biome[y+dy, x+dx] = GRASS_LUSH

    # Plaza at center — small stone area
    plaza_w = 4 if kind == 'town' else 3
    plaza_h = 3
    plaza_x = x + tw//2 - plaza_w//2
    plaza_y = y + th//2 - plaza_h//2
    stamp_rect(biome, plaza_x, plaza_y, plaza_w, plaza_h, STONE_FLOOR)
    # Well in plaza
    decorations.append(('well', plaza_x + plaza_w//2, plaza_y + plaza_h//2))

    # Pick a STYLE THEME for this settlement so each one feels distinct.
    # Choice affects the mix of building types used.
    if kind == 'town':
        theme = random.choice(['classic', 'noble', 'religious', 'asian'])
    elif kind == 'village':
        theme = random.choice(['classic', 'forest', 'fishing', 'asian', 'frontier'])
    else:  # farmstead
        theme = random.choice(['classic', 'frontier', 'fishing'])

    # Place buildings around the plaza, on a loose grid
    building_specs = []
    if kind == 'village':
        n = random.randint(4, 8)
        if theme == 'forest':
            building_specs = [('cabin', 2, 2)] * (n - 1) + [('house', 2, 2)] * 1
        elif theme == 'fishing':
            building_specs = [('house', 2, 2)] * (n - 2) + [('cottage', 2, 2)] * 2
        elif theme == 'asian':
            building_specs = [('pagoda', 2, 3)] * 1 + [('house', 2, 2)] * (n - 1)
        elif theme == 'frontier':
            building_specs = [('cabin', 2, 2)] * (n - 1) + [('barn', 3, 2)] * 1
        else:  # classic
            building_specs = [('house', 2, 2)] * (n - 1) + [('cottage', 2, 2)] * 1
    elif kind == 'town':
        n = random.randint(6, 10)
        if theme == 'religious':
            building_specs = [('church', 3, 4)] * 1 + [('big_house', 3, 3)] * 1 + [('house', 2, 2)] * (n - 2)
        elif theme == 'noble':
            building_specs = [('big_house', 3, 3)] * 2 + [('house', 2, 2)] * (n - 3) + [('church', 3, 4)] * 1
        elif theme == 'asian':
            building_specs = [('pagoda', 2, 3)] * 2 + [('house', 2, 2)] * (n - 2)
        else:  # classic
            building_specs = [('house', 2, 2)] * (n - 3) + [('big_house', 3, 3)] * 2 + [('church', 3, 4)] * 1
    elif kind == 'farmstead':
        n = random.randint(2, 4)
        if theme == 'frontier':
            building_specs = [('cabin', 2, 2)] * (n - 1) + [('barn', 3, 2)] * 1
        elif theme == 'fishing':
            building_specs = [('cottage', 2, 2)] * n
        else:  # classic
            building_specs = [('house', 2, 2)] * (n - 1) + [('barn', 3, 2)] * 1

    random.shuffle(building_specs)
    placed_bldgs = []
    for kind_b, bw, bh in building_specs:
        for _ in range(60):
            bx = x + random.randint(0, tw - bw)
            by = y + random.randint(0, th - bh)
            # Don't overlap plaza
            if (bx < plaza_x + plaza_w and bx + bw > plaza_x and
                by < plaza_y + plaza_h and by + bh > plaza_y):
                continue
            # Don't overlap other buildings (with 1-cell gap)
            clash = False
            for pbx, pby, pbw, pbh in placed_bldgs:
                if (bx < pbx + pbw + 1 and bx + bw > pbx - 1 and
                    by < pby + pbh + 1 and by + bh > pby - 1):
                    clash = True; break
            if clash: continue
            # Cells must all be lush grass currently
            if not all(biome[by+dy, bx+dx] == GRASS_LUSH
                       for dy in range(bh) for dx in range(bw)):
                continue
            # Stamp building
            stamp_rect(biome, bx, by, bw, bh, HOUSE)
            placed_bldgs.append((bx, by, bw, bh))
            decorations.append((kind_b, bx, by))
            break

    # Stone walking paths from plaza to buildings
    pcx, pcy = plaza_x + plaza_w//2, plaza_y + plaza_h//2
    for bx, by, bw, bh in placed_bldgs:
        # door is at bottom-center of building
        dxp = bx + bw//2
        dyp = by + bh
        # carve simple L-path
        cx_, cy_ = pcx, pcy
        steps = 0
        while (cx_, cy_) != (dxp, dyp) and steps < 30:
            if biome[cy_, cx_] in (GRASS, GRASS_LUSH):
                biome[cy_, cx_] = PATH
            if cx_ < dxp: cx_ += 1
            elif cx_ > dxp: cx_ -= 1
            elif cy_ < dyp: cy_ += 1
            elif cy_ > dyp: cy_ -= 1
            steps += 1

    # Fence around the town perimeter, with one gap (the entrance)
    entrance_side = random.choice(['n', 's', 'e', 'w'])
    if entrance_side == 'n': gate = (x + tw//2, y - 1)
    elif entrance_side == 's': gate = (x + tw//2, y + th)
    elif entrance_side == 'e': gate = (x + tw, y + th//2)
    else: gate = (x - 1, y + th//2)

    # Fences NEVER cross roads — leave gaps wherever a path passes through
    NO_FENCE_OVER = (PATH, HIGHWAY, TRAIL, BRIDGE, STONE_FLOOR)
    # North + south fence
    for dx in range(tw):
        for sy, side in [(y-1, 'n'), (y+th, 's')]:
            if 0 <= sy < MAP_H and 0 <= x+dx < MAP_W:
                if entrance_side == side and abs((x+dx) - gate[0]) <= 0:
                    continue
                if biome[sy, x+dx] in NO_FENCE_OVER: continue
                if biome[sy, x+dx] in (GRASS, GRASS_LUSH):
                    decorations.append(('fence', x+dx, sy, 'h'))
    # East + west fence
    for dy in range(th):
        for sx, side in [(x-1, 'w'), (x+tw, 'e')]:
            if 0 <= sx < MAP_W and 0 <= y+dy < MAP_H:
                if entrance_side == side and abs((y+dy) - gate[1]) <= 0:
                    continue
                if biome[y+dy, sx] in NO_FENCE_OVER: continue
                if biome[y+dy, sx] in (GRASS, GRASS_LUSH):
                    decorations.append(('fence', sx, y+dy, 'v'))

    # Decorations inside the town: lamp posts, signs, barrels, carts
    candidates = []
    for dy in range(th):
        for dx in range(tw):
            if biome[y+dy, x+dx] == GRASS_LUSH:
                candidates.append((x+dx, y+dy))
    random.shuffle(candidates)
    deco_count = {'village': 4, 'town': 8, 'farmstead': 3}[kind]
    deco_types = ['lamp', 'sign', 'barrel', 'cart', 'hay_bale']
    if kind == 'town':
        deco_types += ['statue']
    for i, (dx, dy) in enumerate(candidates[:deco_count]):
        deco = random.choice(deco_types)
        decorations.append((deco, dx, dy))

    # Animals: chickens around houses for villages/farmsteads, sheep/cow for farmstead
    animal_count = {'village': 3, 'town': 4, 'farmstead': 6}[kind]
    animal_pool = ['chicken'] * 3
    if kind == 'farmstead':
        animal_pool += ['sheep', 'sheep', 'cow', 'cow']
    elif kind == 'town':
        animal_pool += ['cow']
    candidates = [c for c in candidates if not any(c == (d[1], d[2]) for d in decorations if d[0] in ('lamp', 'sign', 'barrel', 'cart', 'hay_bale', 'statue', 'well'))]
    for _ in range(animal_count):
        if not candidates: break
        dx, dy = candidates.pop()
        decorations.append((random.choice(animal_pool), dx, dy))

    return gate


def place_orchard(biome):
    """Tidy rows of trees."""
    for _ in range(6):
        pos = find_flat_area(biome, 8, 6)
        if pos:
            x, y = pos
            stamp_rect(biome, x, y, 8, 6, ORCHARD)


def place_farms(biome, n=4):
    for _ in range(n):
        pos = find_flat_area(biome, 7, 5)
        if pos:
            x, y = pos
            t = random.choice([FARM_V, FARM_H])
            stamp_rect(biome, x, y, 7, 5, t)


def place_lakes(biome, n=2):
    """Carve organic lakes of varying sizes."""
    for _ in range(n):
        for _ in range(120):
            cx = random.randint(MAP_W//6, MAP_W*5//6)
            cy = random.randint(MAP_H//6, MAP_H*5//6)
            r  = random.randint(3, 11)
            # Check all cells in lake bounds are land
            cells = []
            ok = True
            for dy in range(-r-1, r+2):
                for dx in range(-r-1, r+2):
                    # Stretch shape randomly so not all lakes look round
                    aspect = random.uniform(0.85, 1.4)
                    d = math.hypot(dx, dy * aspect) + random.uniform(-0.8, 0.8)
                    if d <= r:
                        ly, lx = cy+dy, cx+dx
                        if not (0 <= ly < MAP_H and 0 <= lx < MAP_W):
                            ok = False; break
                        if biome[ly, lx] in (OCEAN, DEEP, MOUNT, SNOW, CASTLE, HOUSE):
                            ok = False; break
                        cells.append((ly, lx))
                if not ok: break
            if ok and cells:
                for ly, lx in cells:
                    biome[ly, lx] = LAKE
                break


def add_inter_island_bridges(biome):
    """Find the major landmasses and connect each pair with a wooden bridge
    across the ocean — but only if they're reasonably close."""
    print("Adding inter-island bridges…")
    # Label connected land components
    components = np.full((MAP_H, MAP_W), -1, dtype=int)
    sizes = []
    next_id = 0
    for sy in range(MAP_H):
        for sx in range(MAP_W):
            if components[sy, sx] != -1: continue
            if biome[sy, sx] in (OCEAN, DEEP): continue
            # BFS this component
            q = deque([(sy, sx)])
            components[sy, sx] = next_id
            cells = [(sy, sx)]
            while q:
                y, x = q.popleft()
                for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
                    ny, nx = y+dy, x+dx
                    if 0 <= ny < MAP_H and 0 <= nx < MAP_W \
                       and components[ny, nx] == -1 \
                       and biome[ny, nx] not in (OCEAN, DEEP):
                        components[ny, nx] = next_id
                        q.append((ny, nx))
                        cells.append((ny, nx))
            sizes.append(len(cells))
            next_id += 1

    # Find LARGE landmasses (skip small offshore islands)
    big_components = [i for i, s in enumerate(sizes) if s >= 400]
    print(f"  {next_id} total land components, {len(big_components)} are major islands")
    if len(big_components) < 2: return

    # Build coastal sample per component (subsample to keep distance check fast)
    coastal = {i: [] for i in big_components}
    for y in range(MAP_H):
        for x in range(MAP_W):
            cid = components[y, x]
            if cid not in coastal: continue
            # Coastal = land cell with ocean orthogonal neighbor
            has_ocean = any(0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                            and biome[y+dy, x+dx] in (OCEAN, DEEP)
                            for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)])
            if has_ocean:
                coastal[cid].append((x, y))
    # Subsample coastal points (every 3rd) for speed on large maps
    for cid in coastal:
        coastal[cid] = coastal[cid][::3]

    # For each pair of big components, find the closest pair of coastal points
    # and stamp a BRIDGE through the ocean between them
    built = set()
    for i, a_id in enumerate(big_components):
        for b_id in big_components[i+1:]:
            best = (float('inf'), None, None)
            for ax, ay in coastal[a_id]:
                for bx, by in coastal[b_id]:
                    d = abs(ax-bx) + abs(ay-by)
                    if d < best[0]:
                        best = (d, (ax, ay), (bx, by))
            dist, a, b = best
            # Allow bridges up to ~10% of map width
            max_bridge = max(30, (MAP_W + MAP_H) // 6)
            if a is None or dist > max_bridge: continue
            # Don't build multiple bridges between same pair
            key = tuple(sorted([a_id, b_id]))
            if key in built: continue
            built.add(key)
            ax, ay = a; bx, by = b
            # Carve a straight bridge using Bresenham-like steps
            steps = max(abs(bx-ax), abs(by-ay))
            for s in range(steps + 1):
                t = s / max(1, steps)
                cx = round(ax + (bx-ax) * t)
                cy = round(ay + (by-ay) * t)
                if 0 <= cy < MAP_H and 0 <= cx < MAP_W:
                    if biome[cy, cx] in (OCEAN, DEEP):
                        biome[cy, cx] = BRIDGE
                    # Add slight width — orthogonal neighbor along the bridge axis
                    horizontal = abs(bx-ax) > abs(by-ay)
                    perp_dy, perp_dx = (1, 0) if horizontal else (0, 1)
                    py_, px_ = cy + perp_dy, cx + perp_dx
                    if 0 <= py_ < MAP_H and 0 <= px_ < MAP_W:
                        if biome[py_, px_] in (OCEAN, DEEP):
                            biome[py_, px_] = BRIDGE
            print(f"  bridge ({ax},{ay}) → ({bx},{by}) length={dist}")


def place_offshore_islands(biome, n=4):
    """Sprinkle small islands in the ocean around the main landmass.
    Each island is an irregular blob with sandy beach borders."""
    placed_islands = []
    print(f"Placing offshore islands…")
    for _ in range(n):
        for _ in range(400):
            cx = random.randint(12, MAP_W - 12)
            cy = random.randint(12, MAP_H - 12)
            r = random.randint(3, 7)
            # All cells in the bounding region must currently be ocean
            ok = True
            for dy in range(-r-1, r+2):
                for dx in range(-r-1, r+2):
                    ly, lx = cy+dy, cx+dx
                    if not (0 <= ly < MAP_H and 0 <= lx < MAP_W): continue
                    if biome[ly, lx] not in (OCEAN, DEEP):
                        ok = False; break
                if not ok: break
            if not ok: continue
            # Require buffer of ocean around (so it's clearly an offshore island)
            buf_ok = True
            for dy in range(-r-4, r+5):
                for dx in range(-r-4, r+5):
                    ly, lx = cy+dy, cx+dx
                    if 0 <= ly < MAP_H and 0 <= lx < MAP_W:
                        if biome[ly, lx] not in (OCEAN, DEEP):
                            buf_ok = False; break
                if not buf_ok: break
            if not buf_ok: continue
            # Min spacing between offshore islands
            if any(math.hypot(cx-ox, cy-oy) < r + or_ + 4
                   for ox, oy, or_ in placed_islands):
                continue
            # Stamp the island — irregular blob
            for dy in range(-r-1, r+2):
                for dx in range(-r-1, r+2):
                    d = math.hypot(dx, dy) + random.uniform(-0.9, 0.9)
                    if d <= r:
                        ly, lx = cy+dy, cx+dx
                        if 0 <= ly < MAP_H and 0 <= lx < MAP_W:
                            # Inner = grass, outer ring = beach
                            biome[ly, lx] = GRASS if d <= r - 1.5 else BEACH
            placed_islands.append((cx, cy, r))
            print(f"  island at ({cx},{cy}) r={r}")
            break
    return placed_islands


def populate_offshore_islands(biome, decorations, islands):
    """Place a small feature on each offshore island — lighthouse, treasure,
    shipwreck on beach, hermit hut, etc."""
    feature_options = ['lighthouse', 'treasure', 'campfire', 'crystal',
                       'shipwreck', 'hermit_cave', 'sacred_tree',
                       'totem', 'ancient_gate', 'magic_circle']
    for cx, cy, r in islands:
        feature = random.choice(feature_options)
        # Find a viable spot on the island
        for _ in range(60):
            dy = random.randint(-r+1, r-1)
            dx = random.randint(-r+1, r-1)
            ly, lx = cy+dy, cx+dx
            if not (0 <= ly < MAP_H and 0 <= lx < MAP_W): continue
            if biome[ly, lx] != GRASS: continue
            decorations.append((feature, lx, ly))
            # Mark as used so other systems avoid stacking
            biome[ly, lx] = HOUSE
            break


def place_outlying_cottages(biome, decorations, n=8):
    placed = []
    for _ in range(n):
        for _ in range(100):
            x = random.randint(2, MAP_W-4)
            y = random.randint(2, MAP_H-4)
            ok = (all(biome[y+dy, x+dx] in (GRASS, GRASS_LUSH)
                      for dy in range(2) for dx in range(2)) and
                  all(math.hypot(x-px, y-py) > 6 for px, py in placed))
            if ok:
                placed.append((x, y))
                stamp_rect(biome, x, y, 2, 2, HOUSE)
                decorations.append(('house', x, y))
                break


def place_windmills(biome, decorations, n=2):
    for _ in range(n):
        for _ in range(80):
            x = random.randint(2, MAP_W-3)
            y = random.randint(3, MAP_H-3)
            if biome[y, x] in (GRASS, GRASS_LUSH) and biome[y, x+1] in (GRASS, GRASS_LUSH) \
               and biome[y-1, x] in (GRASS, GRASS_LUSH):
                decorations.append(('windmill', x, y))
                biome[y, x] = HOUSE; biome[y, x+1] = HOUSE
                biome[y-1, x] = HOUSE
                break


# ════════════════════════════════════════════════════════════════════════
# PATH NETWORK
# ════════════════════════════════════════════════════════════════════════

def carve_path(biome, ax, ay, bx, by, road_type=PATH):
    """A* path. road_type controls which tile is stamped (PATH/HIGHWAY/TRAIL).
    Reuses existing roads (any path-like tile costs 1)."""
    def cost(y, x):
        t = biome[y, x]
        if t in (OCEAN, DEEP, MOUNT, SNOW): return 1e9
        if t in (LAKE, RIVER): return 25     # crossing = bridge
        if t in (PATH, HIGHWAY, TRAIL, STONE_FLOOR, BRIDGE): return 1
        if t in (FOREST, F_DENSE, F_DARK, AUTUMN_FOREST, ORCHARD,
                 CHERRY_GROVE, BAMBOO_GROVE): return 4
        if t in (FARM_V, FARM_H, HOUSE, CASTLE): return 1e9
        return 2

    open_set = [(0, ay, ax)]
    came = {}
    g = {(ay, ax): 0}
    target = (by, bx)
    while open_set:
        _, y, x = heapq.heappop(open_set)
        if (y, x) == target: break
        for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
            ny, nx = y+dy, x+dx
            if not (0 <= ny < MAP_H and 0 <= nx < MAP_W): continue
            nc = g[(y, x)] + cost(ny, nx)
            if nc < g.get((ny, nx), 1e18):
                g[(ny, nx)] = nc
                came[(ny, nx)] = (y, x)
                heapq.heappush(open_set, (nc + abs(ny-by)+abs(nx-bx), ny, nx))
    if target not in came: return []

    cells = []
    cur = target
    while cur in came:
        cy, cx = cur
        cells.append((cy, cx))
        cur = came[cur]
    cells.reverse()
    # Don't downgrade existing road tiles (highway > path > trail)
    ROAD_RANK = {TRAIL: 1, PATH: 2, HIGHWAY: 3}
    rank_self = ROAD_RANK.get(road_type, 0)
    # Sanity: if the path goes through ocean cells (shouldn't due to cost,
    # but A* with weights can still produce one if there's no other way),
    # abort — we won't build roads across open ocean.
    if any(biome[cy, cx] in (OCEAN, DEEP) for cy, cx in cells):
        return []
    for cy, cx in cells:
        t = biome[cy, cx]
        if t in (LAKE, RIVER):
            biome[cy, cx] = BRIDGE
            continue
        if t in (HOUSE, CASTLE, STONE_FLOOR): continue
        cur_rank = ROAD_RANK.get(t, 0)
        if rank_self >= cur_rank:
            biome[cy, cx] = road_type
    return cells


def detect_road_crossings(biome):
    """Find tiles where 3 or 4 different road branches meet — crossroads."""
    crossings = []
    ROAD_LIKE = (PATH, HIGHWAY, TRAIL)
    for y in range(2, MAP_H-2):
        for x in range(2, MAP_W-2):
            if biome[y, x] not in ROAD_LIKE: continue
            n_branches = sum(1 for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]
                             if biome[y+dy, x+dx] in ROAD_LIKE + (BRIDGE, STONE_FLOOR))
            if n_branches >= 3:
                crossings.append((x, y))
    return crossings


def build_road_network(biome, decorations, landmarks_by_kind):
    """Hierarchical road network:
      - HIGHWAY: castle ↔ towns, town ↔ town (stone-paved)
      - PATH:    towns ↔ villages, town ↔ farmsteads
      - TRAIL:   villages/farmsteads ↔ each other, and to nearby discoveries
    Returns: count of road tiles created.
    """
    print("Building road network…")
    castles    = landmarks_by_kind.get('castle', [])
    towns      = landmarks_by_kind.get('town', [])
    villages   = landmarks_by_kind.get('village', [])
    farmsteads = landmarks_by_kind.get('farmstead', [])
    discoveries = landmarks_by_kind.get('discovery', [])

    # Pass 1 — HIGHWAYS: castles ↔ towns ↔ towns
    majors = castles + towns
    print(f"  highways through {len(majors)} major landmarks")
    for i, a in enumerate(majors):
        # Connect to closest 2 other majors
        d = sorted([(abs(a[0]-b[0])+abs(a[1]-b[1]), b)
                    for j, b in enumerate(majors) if j != i])
        for _, b in d[:2]:
            carve_path(biome, a[0], a[1], b[0], b[1], road_type=HIGHWAY)

    # Pass 2 — PATHS: each village/farmstead → nearest major landmark
    print(f"  paths from {len(villages)+len(farmsteads)} minor settlements")
    for s in villages + farmsteads:
        if not majors: break
        nearest = min(majors, key=lambda m: abs(s[0]-m[0]) + abs(s[1]-m[1]))
        carve_path(biome, s[0], s[1], nearest[0], nearest[1], road_type=PATH)
    # Connect villages to villages (loops in the network)
    for i, a in enumerate(villages):
        d = sorted([(abs(a[0]-b[0])+abs(a[1]-b[1]), b)
                    for j, b in enumerate(villages) if j != i])
        if d:
            _, b = d[0]
            carve_path(biome, a[0], a[1], b[0], b[1], road_type=PATH)

    # Pass 3 — TRAILS: branch off the road network to discoveries.
    # CERTAIN DISCOVERY TYPES are always hidden — never connected by trails
    # so they have to be found by exploring off the beaten path.
    HIDDEN_KINDS = {'witch_hut', 'sacred_tree', 'portal', 'ancient_gate',
                    'monolith', 'phoenix_nest', 'dragon_nest', 'bandit_camp',
                    'spider_lair', 'crystal_pillar', 'hermit_cave',
                    'buried_giant', 'eagles_nest', 'magic_circle',
                  'mushroom_village', 'totem', 'forest_chest',
                    'hidden_cache', 'ambush_camp', 'sleeping_dragon'}
    # Build lookup: pos → discovery kind from existing decorations
    disc_kind = {}
    for deco in decorations:
        k = deco[0]
        if len(deco) >= 3:
            disc_kind[(deco[1], deco[2])] = k

    road_cells = []
    for y in range(MAP_H):
        for x in range(MAP_W):
            if biome[y, x] in (HIGHWAY, PATH):
                road_cells.append((x, y))
    print(f"  {len(road_cells)} road cells, branching trails to {len(discoveries)} discoveries")
    for dx, dy in discoveries:
        if not road_cells: break
        # Skip if this discovery is one of the "hidden" types — never trail to it
        if disc_kind.get((dx, dy)) in HIDDEN_KINDS:
            continue
        near = min(road_cells, key=lambda r: abs(r[0]-dx) + abs(r[1]-dy))
        if abs(near[0]-dx) + abs(near[1]-dy) > 35:
            continue
        # 50% chance even among non-hidden — keeps the world feeling explorable
        if random.random() < 0.5:
            carve_path(biome, near[0], near[1], dx, dy, road_type=TRAIL)

    # Pass 4 — place signposts BESIDE crossroads (never on them — that would block traffic)
    crossings = detect_road_crossings(biome)
    random.shuffle(crossings)
    placed_signs = []
    for cx, cy in crossings[:max(4, len(crossings) // 4)]:
        # Find an adjacent grass cell to place the signpost
        for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)]:
            sx, sy = cx + dx, cy + dy
            if not (0 <= sy < MAP_H and 0 <= sx < MAP_W): continue
            if biome[sy, sx] not in (GRASS, GRASS_LUSH): continue
            if any(abs(sx-ox)+abs(sy-oy) < 5 for ox, oy in placed_signs): continue
            decorations.append(('sign', sx, sy))
            biome[sy, sx] = HOUSE   # reserve so other props don't stack
            placed_signs.append((sx, sy))
            break


def place_contextual_features(biome, decorations):
    """Place features in narratively-meaningful spots:
      - Ruined towers along old highways (the bones of past empires)
      - Skull piles + abandoned campfires near caves
      - Bandit camps OFF the road in dense forests
      - Whale bones + shipwrecks on remote beaches
      - Hidden caches and encounters in forest clearings
      - Wishing ponds near towns
      - Lamp posts along highways at intervals
    """
    print("Placing contextual features…")
    cave_positions  = []
    castle_positions = []
    town_positions   = []
    for deco in decorations:
        k = deco[0]
        if k == 'cave': cave_positions.append((deco[1], deco[2]))

    # Find road, highway, and forest cells once
    highway_cells = []
    path_cells    = []
    deep_forest   = []   # FOREST/F_DENSE cells far from roads
    forest_clearings = [] # GRASS_LUSH cells surrounded by forest
    remote_beach = []

    ROAD_LIKE = (PATH, HIGHWAY, TRAIL, STONE_FLOOR, BRIDGE)
    FOREST_LIKE = (FOREST, F_DENSE, F_DARK, AUTUMN_FOREST)

    for y in range(MAP_H):
        for x in range(MAP_W):
            t = biome[y, x]
            if t == HIGHWAY:
                highway_cells.append((x, y))
            elif t == PATH:
                path_cells.append((x, y))
            elif t in FOREST_LIKE:
                # "Deep" forest = no road within 3 cells
                near_road = any(
                    0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                    and biome[y+dy, x+dx] in ROAD_LIKE
                    for dy in range(-3, 4) for dx in range(-3, 4)
                )
                if not near_road:
                    deep_forest.append((x, y))
            elif t == GRASS_LUSH:
                # Forest clearing = grass surrounded by forest
                forest_n = sum(
                    1 for dy, dx in [(-1,0),(1,0),(0,-1),(0,1),
                                      (-2,0),(2,0),(0,-2),(0,2)]
                    if 0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                    and biome[y+dy, x+dx] in FOREST_LIKE
                )
                if forest_n >= 4:
                    forest_clearings.append((x, y))
            elif t == BEACH:
                # Remote beach = no settlement within 8 tiles
                near_struct = any(
                    0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                    and biome[y+dy, x+dx] in (HOUSE, CASTLE, STONE_FLOOR)
                    for dy in range(-8, 9) for dx in range(-8, 9)
                )
                if not near_struct:
                    remote_beach.append((x, y))

    print(f"  highway:{len(highway_cells)} path:{len(path_cells)} "
          f"deep_forest:{len(deep_forest)} clearings:{len(forest_clearings)} "
          f"remote_beach:{len(remote_beach)}")

    def reserve(x, y, footprint_w=1, footprint_h=1):
        """Stamp HOUSE so other systems avoid this spot."""
        for dy in range(footprint_h):
            for dx in range(footprint_w):
                if 0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W:
                    biome[y+dy, x+dx] = HOUSE

    random.shuffle(highway_cells)
    random.shuffle(deep_forest)
    random.shuffle(forest_clearings)
    random.shuffle(remote_beach)

    # Ruined towers along highways — remnants of old empire
    n_ruins = min(len(highway_cells) // 80, 6)
    placed = []
    for x, y in highway_cells:
        if len(placed) >= n_ruins: break
        # Place TO THE SIDE of the road, not on it
        offsets = [(2, 0), (-2, 0), (0, 2), (0, -2)]
        random.shuffle(offsets)
        for dx, dy in offsets:
            sx, sy = x + dx, y + dy
            if not (0 <= sy < MAP_H - 1 and 0 <= sx < MAP_W): continue
            if biome[sy, sx] not in (GRASS, GRASS_LUSH, FOREST): continue
            if biome[sy + 1, sx] not in (GRASS, GRASS_LUSH, FOREST): continue
            # Min spacing
            if any(abs(sx-px)+abs(sy-py) < 25 for px, py in placed): continue
            decorations.append(('ruined_tower', sx, sy))
            reserve(sx, sy, 1, 2)
            placed.append((sx, sy))
            break

    # Bandit camps OFF the road, deep in forests
    for x, y in deep_forest[:5]:
        # Check 2x2 area available
        if all(0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
               and biome[y+dy, x+dx] in FOREST_LIKE
               for dy in range(2) for dx in range(2)):
            decorations.append(('bandit_camp', x, y))
            reserve(x, y, 2, 2)

    # Skull piles + abandoned campfires near caves
    for cx, cy in cave_positions:
        # Place 1-2 sinister features near the cave
        for _ in range(2):
            for _ in range(20):
                dx = random.randint(-4, 4)
                dy = random.randint(-4, 4)
                if dx == 0 and dy == 0: continue
                sx, sy = cx + dx, cy + dy
                if not (0 <= sy < MAP_H and 0 <= sx < MAP_W): continue
                if biome[sy, sx] not in (GRASS, GRASS_LUSH, MOUNT, FOREST): continue
                ch = random.choice(['skull', 'campfire', 'wagon_graveyard'])
                decorations.append((ch, sx, sy))
                reserve(sx, sy)
                break

    # Hidden discoveries in proper forest clearings. These are intentionally not
    # stone/magic circles, so clearings feel like found places instead of markers.
    n_clearing_secrets = min(len(forest_clearings) // 18, 12)
    for x, y in forest_clearings:
        if n_clearing_secrets <= 0: break
        # Need 3x3 area
        ok = all(0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                 and biome[y+dy, x+dx] in (GRASS, GRASS_LUSH)
                 for dy in range(3) for dx in range(3))
        if not ok: continue
        secret = random.choice(['forest_chest', 'hidden_cache', 'campfire',
                                'monolith', 'skull', 'ambush_camp'])
        decorations.append((secret, x + 1, y + 1))
        reserve(x + 1, y + 1)
        if secret == 'ambush_camp':
            for ex, ey, enemy in [(x, y + 1, 'goblin'), (x + 2, y + 1, 'goblin'),
                                  (x + 1, y + 2, 'orc')]:
                decorations.append((enemy, ex, ey))
        n_clearing_secrets -= 1

    # Whale bones on remote beaches only
    for x, y in remote_beach[:3]:
        if 0 <= x+1 < MAP_W and biome[y, x+1] == BEACH:
            decorations.append(('whale_bones', x, y))
            reserve(x, y, 2, 1)

    # Lamp posts along highways at intervals (every ~12 tiles)
    if highway_cells:
        sorted_hw = sorted(highway_cells)
        for i in range(0, len(sorted_hw), 14):
            lx, ly = sorted_hw[i]
            # Place beside the road
            for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
                sx, sy = lx + dx, ly + dy
                if 0 <= sy < MAP_H and 0 <= sx < MAP_W:
                    if biome[sy, sx] in (GRASS, GRASS_LUSH):
                        decorations.append(('lamp', sx, sy))
                        biome[sy, sx] = HOUSE
                        break


# ════════════════════════════════════════════════════════════════════════
# DECORATIONS — scattered flowers, rocks, stumps, etc.
# ════════════════════════════════════════════════════════════════════════

def scatter_decorations(biome, decorations):
    print("Scattering decorations…")
    # Small flora
    for y in range(MAP_H):
        for x in range(MAP_W):
            t = biome[y, x]
            if t == GRASS_LUSH and random.random() < 0.10:
                decorations.append(('flower', x, y))
            elif t == GRASS and random.random() < 0.04:
                decorations.append(('flower', x, y))
            elif t == FOREST and random.random() < 0.03:
                decorations.append(('mushroom', x, y))
            elif t == F_DENSE and random.random() < 0.045:
                decorations.append((random.choice(['mushroom', 'rock', 'berry']), x, y))
            elif t == F_DARK and random.random() < 0.04:
                decorations.append(('mushroom', x, y))
            elif t == F_DARK and random.random() < 0.018:
                decorations.append((random.choice(['skull', 'grave', 'campfire']), x, y))
            elif t == AUTUMN_FOREST and random.random() < 0.045:
                decorations.append((random.choice(['pumpkin', 'berry', 'mushroom']), x, y))
            elif t == SAND and random.random() < 0.02:
                decorations.append(('shell', x, y))
            elif t == MOUNT and random.random() < 0.05:
                decorations.append(('rock', x, y))
            elif t == SWAMP and random.random() < 0.10:
                decorations.append(('reed', x, y))
    # Single trees on grass + occasional berry bushes / pumpkins
    for y in range(MAP_H):
        for x in range(MAP_W):
            t = biome[y, x]
            if t in (GRASS, GRASS_LUSH):
                if random.random() < 0.012:
                    decorations.append(('lone_tree', x, y))
                elif random.random() < 0.005:
                    decorations.append(('berry', x, y))
                elif random.random() < 0.002:
                    decorations.append(('pumpkin', x, y))


def scatter_wildlife(biome, decorations):
    """Add roaming wild animals throughout biomes."""
    print("Scattering wildlife…")
    for y in range(MAP_H):
        for x in range(MAP_W):
            t = biome[y, x]
            if t == FOREST and random.random() < 0.006:
                decorations.append(('deer', x, y))
            elif t in (GRASS, GRASS_LUSH) and random.random() < 0.005:
                decorations.append(('rabbit', x, y))
            elif t == F_DENSE and random.random() < 0.004:
                decorations.append(('fox', x, y))
            elif t == F_DARK and random.random() < 0.005:
                decorations.append(('wolf', x, y))
            elif t in (GRASS, GRASS_LUSH, BEACH) and random.random() < 0.003:
                decorations.append(('bird', x, y))


def place_discoveries(biome, decorations):
    """Hide special features around the world for players to discover."""
    print("Placing discoveries…")
    placed = []

    def try_place(types, name, w, h, count=1):
        """Try to place `count` features in cells of `types`."""
        for _ in range(count):
            for _ in range(400):
                x = random.randint(1, MAP_W - w - 1)
                y = random.randint(1, MAP_H - h - 1)
                ok = all(biome[y+dy, x+dx] in types
                         for dy in range(h) for dx in range(w))
                if not ok: continue
                # Min spacing from other placed discoveries
                if any(abs(x-ox) + abs(y-oy) < 8 for ox, oy in placed):
                    continue
                placed.append((x, y))
                decorations.append((name, x, y))
                # Stamp footprint so other systems avoid it
                for dy in range(h):
                    for dx in range(w):
                        biome[y+dy, x+dx] = HOUSE
                break

    # Major discoveries (more of everything for the bigger map)
    try_place((MOUNT,), 'cave', 1, 1, count=8)
    try_place((GRASS, GRASS_LUSH, FOREST, AUTUMN_FOREST), 'treasure', 1, 1, count=10)
    try_place((FOREST, F_DENSE, F_DARK, AUTUMN_FOREST), 'forest_chest', 1, 1, count=28)
    try_place((GRASS, GRASS_LUSH, FOREST), 'ruined_tower', 1, 2, count=4)
    try_place((F_DENSE, F_DARK, AUTUMN_FOREST), 'witch_hut', 2, 2, count=2)
    try_place((GRASS_LUSH, FOREST, CHERRY_GROVE), 'magic_circle', 1, 1, count=2)
    try_place((BEACH,), 'dock', 1, 2, count=2)
    try_place((GRASS, GRASS_LUSH), 'ancient_gate', 2, 1, count=4)
    try_place((MOUNT,), 'crystal', 1, 1, count=10)
    try_place((GRASS, GRASS_LUSH, BEACH, SAND, AUTUMN_FOREST), 'campfire', 1, 1, count=7)
    try_place((GRASS, GRASS_LUSH), 'obelisk', 1, 1, count=4)
    try_place((F_DARK, SWAMP), 'skull', 1, 1, count=5)
    # New discoveries
    try_place((GRASS, GRASS_LUSH, FOREST), 'portal', 1, 1, count=3)
    try_place((MOUNT, SNOW), 'hot_spring', 1, 1, count=4)
    try_place((F_DENSE, F_DARK, CHERRY_GROVE), 'giant_mushroom', 1, 1, count=8)
    try_place((MOUNT,), 'hermit_cave', 1, 1, count=3)
    try_place((GRASS_LUSH, FOREST), 'old_mill', 2, 2, count=2)
    try_place((F_DARK, MOUNT), 'monolith', 1, 1, count=3)
    try_place((BEACH, SAND), 'shipwreck', 2, 1, count=3)
    try_place((GRASS, GRASS_LUSH), 'sacred_tree', 2, 2, count=3)
    try_place((GRASS, GRASS_LUSH, F_DARK), 'totem', 1, 1, count=4)
    try_place((GRASS, GRASS_LUSH, FOREST), 'beehive', 1, 1, count=6)
    try_place((GRASS, GRASS_LUSH), 'stone_bridge', 1, 1, count=2)
    # New buildings as features
    try_place((BEACH, SAND), 'lighthouse', 2, 4, count=2)
    try_place((F_DENSE, FOREST, GRASS_LUSH), 'mage_tower', 2, 4, count=2)
    try_place((MOUNT,), 'mine', 1, 1, count=4)
    try_place((BEACH,), 'boat', 1, 1, count=4)
    try_place((GRASS, GRASS_LUSH, CHERRY_GROVE), 'pagoda', 2, 3, count=2)
    try_place((FOREST, F_DENSE, AUTUMN_FOREST), 'cabin', 2, 2, count=5)
    try_place((GRASS, GRASS_LUSH, DESERT), 'tent', 1, 1, count=6)
    # New mysteries
    try_place((F_DENSE, F_DARK, CHERRY_GROVE), 'mushroom_village', 2, 2, count=2)
    try_place((MOUNT,), 'crystal_pillar', 1, 2, count=4)
    try_place((BEACH, SAND), 'whale_bones', 2, 1, count=2)
    try_place((F_DENSE, F_DARK, AUTUMN_FOREST), 'bandit_camp', 2, 2, count=2)
    try_place((F_DARK, F_DENSE), 'spider_lair', 2, 2, count=2)
    try_place((MOUNT,), 'eagles_nest', 1, 1, count=3)
    try_place((GRASS, GRASS_LUSH, AUTUMN_FOREST), 'wagon_graveyard', 1, 1, count=3)
    try_place((GRASS, GRASS_LUSH), 'knight_tomb', 1, 2, count=3)
    try_place((GRASS_LUSH, F_DENSE, CHERRY_GROVE), 'glowing_meadow', 1, 1, count=1)
    try_place((MOUNT, AUTUMN_FOREST), 'phoenix_nest', 1, 1, count=2)
    try_place((GRASS, GRASS_LUSH, DESERT), 'buried_giant', 1, 1, count=2)
    try_place((GRASS_LUSH, FOREST, CHERRY_GROVE), 'wishing_pond', 1, 1, count=3)


def place_hidden_forest_content(biome, decorations):
    """Add forest-specific hidden content after roads are carved.

    These are deliberately placed away from roads, so they remain exploration
    rewards in clearings and deep tree cover instead of becoming trail stops.
    """
    print("Placing hidden forest content…")
    ROAD_LIKE = (PATH, HIGHWAY, TRAIL, STONE_FLOOR, BRIDGE)
    BLOCKING = (HOUSE, CASTLE, STONE_FLOOR, PATH, HIGHWAY, TRAIL, BRIDGE,
                OCEAN, DEEP, LAKE, RIVER)
    FOREST_LIKE = (FOREST, F_DENSE, F_DARK, AUTUMN_FOREST)

    def near_road(x, y, radius=7):
        return any(0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W
                   and biome[y+dy, x+dx] in ROAD_LIKE
                   for dy in range(-radius, radius + 1)
                   for dx in range(-radius, radius + 1))

    def reserve(x, y, w=1, h=1):
        for dy in range(h):
            for dx in range(w):
                if 0 <= y+dy < MAP_H and 0 <= x+dx < MAP_W:
                    biome[y+dy, x+dx] = HOUSE

    clearing_cells = []
    deep_forest_cells = []
    swamp_cells = []
    autumn_cells = []

    for y in range(2, MAP_H - 2):
        for x in range(2, MAP_W - 2):
            t = biome[y, x]
            if t in BLOCKING or near_road(x, y):
                continue
            if t == GRASS_LUSH:
                forest_n = sum(1 for dy in range(-2, 3) for dx in range(-2, 3)
                               if biome[y+dy, x+dx] in FOREST_LIKE)
                if forest_n >= 10:
                    clearing_cells.append((x, y))
            elif t in FOREST_LIKE:
                deep_forest_cells.append((x, y, t))
            elif t == SWAMP:
                swamp_cells.append((x, y))
            if t == AUTUMN_FOREST:
                autumn_cells.append((x, y))

    random.shuffle(clearing_cells)
    random.shuffle(deep_forest_cells)
    random.shuffle(swamp_cells)
    random.shuffle(autumn_cells)

    placed = []
    dragon_bounds = None
    def spaced(x, y, min_dist=9):
        return all(abs(x-px) + abs(y-py) >= min_dist for px, py in placed)

    # More chests and secrets in clearings between trees.
    for x, y in clearing_cells:
        if len(placed) >= 34:
            break
        if not spaced(x, y):
            continue
        secret = random.choices(
            ['forest_chest', 'hidden_cache', 'treasure', 'campfire',
             'skull', 'wagon_graveyard', 'monolith'],
            weights=[9, 7, 5, 3, 2, 2, 1],
            k=1
        )[0]
        decorations.append((secret, x, y))
        reserve(x, y)
        placed.append((x, y))
        if random.random() < 0.75:
            for ex, ey, enemy in [(x - 1, y, 'goblin'), (x + 1, y, 'goblin')]:
                if 0 <= ey < MAP_H and 0 <= ex < MAP_W and biome[ey, ex] not in BLOCKING:
                    decorations.append((enemy, ex, ey))

    # One large sleeping dragon, buried deep in an unpathed forest pocket.
    dragon_sites = []
    for y in range(4, MAP_H - 7):
        for x in range(4, MAP_W - 9):
            if near_road(x + 3, y + 2, radius=14):
                continue
            cells = [biome[y+dy, x+dx] for dy in range(4) for dx in range(6)]
            forest_count = sum(1 for t in cells if t in (FOREST, F_DENSE, F_DARK))
            blocked = any(t in BLOCKING for t in cells)
            if not blocked and forest_count >= 20:
                dark_bonus = sum(1 for t in cells if t == F_DARK)
                dragon_sites.append((x, y, forest_count + dark_bonus * 2))
    if dragon_sites:
        dragon_sites.sort(key=lambda p: p[2], reverse=True)
        dx, dy, _ = dragon_sites[0]
        decorations.append(('sleeping_dragon', dx, dy))
        dragon_bounds = (dx - 1, dy - 1, dx + 7, dy + 5)
        print(f"  sleeping dragon at ({dx},{dy})")
        for ex, ey, enemy in [(dx - 1, dy + 1, 'orc'), (dx + 6, dy + 2, 'orc'),
                              (dx + 2, dy - 1, 'skeleton'), (dx + 4, dy + 4, 'ghost')]:
            if 0 <= ey < MAP_H and 0 <= ex < MAP_W and biome[ey, ex] not in BLOCKING:
                decorations.append((enemy, ex, ey))
        placed.append((dx + 3, dy + 2))

    # Deep forest encounters, with each forest type getting a different threat mix.
    enemy_budget = max(120, min(360, len(deep_forest_cells) // 30))
    enemy_placed = 0
    for x, y, t in deep_forest_cells:
        if enemy_placed >= enemy_budget:
            break
        if dragon_bounds and dragon_bounds[0] <= x <= dragon_bounds[2] and dragon_bounds[1] <= y <= dragon_bounds[3]:
            continue
        if not spaced(x, y, min_dist=4):
            continue
        if t == F_DARK:
            enemy = random.choice(['giant_spider', 'skeleton', 'ghost', 'wolf'])
        elif t == F_DENSE:
            enemy = random.choice(['goblin', 'orc', 'giant_spider', 'wolf'])
        elif t == AUTUMN_FOREST:
            enemy = random.choice(['skeleton', 'ghost', 'orc'])
        else:
            enemy = random.choice(['goblin', 'wolf', 'giant_spider'])
        decorations.append((enemy, x, y))
        placed.append((x, y))
        enemy_placed += 1

    # Swamps get more identity: amphibious enemies and slimes.
    for x, y in swamp_cells[:max(20, len(swamp_cells) // 90)]:
        if spaced(x, y, min_dist=5):
            decorations.append((random.choice(['slime', 'slime', 'lizardman']), x, y))
            placed.append((x, y))

    # Autumn groves get small hidden rewards without paths.
    for x, y in autumn_cells[:max(8, len(autumn_cells) // 120)]:
        if spaced(x, y, min_dist=8):
            decorations.append((random.choice(['forest_chest', 'treasure',
                                               'phoenix_nest']), x, y))
            reserve(x, y)
            placed.append((x, y))

    print(f"  hidden clearings:{len(clearing_cells)} deep_forest:{len(deep_forest_cells)} "
          f"swamp:{len(swamp_cells)} placed:{len(placed)}")


# ════════════════════════════════════════════════════════════════════════
# RENDERING — tile drawing with autotile edges
# ════════════════════════════════════════════════════════════════════════

def variant(x, y, mod=256):
    return ((x * 7349 + y * 1163) ^ (x * y * 31)) % mod

def has_neighbor_priority_less(biome, y, x, direction):
    """Is the neighbor in `direction` of LOWER priority than current cell?"""
    dy, dx = direction
    ny, nx = y+dy, x+dx
    if not (0 <= ny < MAP_H and 0 <= nx < MAP_W):
        return False
    return PRIORITY[int(biome[ny, nx])] < PRIORITY[int(biome[y, x])]

def grass_base(d, px, py, v, color_base, color_lt, color_dk, color_blade):
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=color_base)
    # Speckles
    if v & 3 == 0:
        d.rectangle([px+3, py+4, px+5, py+5], fill=color_lt)
    if v & 5 == 0:
        d.rectangle([px+TILE-7, py+TILE-8, px+TILE-5, py+TILE-7], fill=color_lt)
    if v & 7 == 0:
        d.rectangle([px+TILE-9, py+3, px+TILE-7, py+5], fill=color_dk)
    # Tiny grass blade marks
    if v & 11 == 0:
        d.line([(px+8, py+TILE-3), (px+8, py+TILE-6)], fill=color_blade)
    if v & 13 == 0:
        d.line([(px+12, py+TILE-4), (px+12, py+TILE-7)], fill=color_blade)
    if v & 17 == 0:
        d.line([(px+5, py+TILE-3), (px+5, py+TILE-5)], fill=color_blade)


def draw_grass(d, px, py, v):
    grass_base(d, px, py, v, C['grass'], C['grass_lt'], C['grass_dk'], C['grass_blade'])

def draw_grass_lush(d, px, py, v):
    grass_base(d, px, py, v, C['lush'], C['lush_lt'], C['grass_dk'], C['grass_blade'])
    # Extra flower hints
    if v & 9 == 0:
        d.point((px+6, py+11), fill=C['flower_w'])
    if v & 21 == 0:
        d.point((px+TILE-5, py+5), fill=C['flower_y'])

def draw_swamp(d, px, py, v):
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['swamp'])
    # Murky pools
    if v & 3 == 0:
        d.ellipse([px+4, py+4, px+9, py+8], fill=C['swamp_dk'])
    if v & 7 == 0:
        d.ellipse([px+TILE-9, py+TILE-7, px+TILE-3, py+TILE-3], fill=C['swamp_dk'])
    # Reed marks
    if v & 11 == 0:
        d.line([(px+3, py+TILE-3), (px+3, py+TILE-8)], fill=C['grass_dk'])

def draw_beach(d, px, py, v):
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['beach'])
    # Subtle speckles
    if v & 5 == 0:
        d.point((px+4, py+5), fill=C['beach_dk'])
    if v & 7 == 0:
        d.point((px+TILE-6, py+TILE-7), fill=C['beach_dk'])
    if v & 11 == 0:
        d.point((px+10, py+3), fill=C['beach_dk'])

def draw_sand(d, px, py, v):
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['sand'])
    # Wavy hatch lines
    for k in range(0, TILE, 4):
        if (k + (v & 1)) % 5 < 3:
            d.line([(px+k, py+2), (px+k+1, py+TILE-3)], fill=C['sand_dk'])

def draw_ocean(d, px, py, v, deep=False):
    base = C['deep'] if deep else C['ocean']
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=base)
    if not deep and v & 5 == 0:
        d.line([(px+3, py+TILE//2), (px+7, py+TILE//2)], fill=C['ocean_lt'])
    if not deep and v & 7 == 0:
        d.line([(px+TILE-9, py+TILE-5), (px+TILE-5, py+TILE-5)], fill=C['ocean_lt'])

def draw_water(d, px, py, v):
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['water'])
    if v & 3 == 0:
        d.line([(px+3, py+6), (px+7, py+6)], fill=C['water_lt'])
    if v & 5 == 0:
        d.line([(px+TILE-8, py+TILE-6), (px+TILE-4, py+TILE-6)], fill=C['water_lt'])

def draw_mountain(d, px, py, v):
    """Rocky terrain — irregular boulders, not diamonds."""
    # Base: dirty stone color (slight variation per tile)
    base_shift = (v & 7) - 3
    base = (max(0, C['mountain'][0]+base_shift),
            max(0, C['mountain'][1]+base_shift),
            max(0, C['mountain'][2]+base_shift))
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=base)
    # 2-3 rounded boulders per tile (deterministic from v)
    cx, cy = px+TILE//2, py+TILE//2
    layouts = [
        [(cx-3, cy-2, 5), (cx+3, cy+1, 4)],
        [(cx-2, cy+2, 6), (cx+4, cy-3, 3)],
        [(cx-4, cy-3, 4), (cx+2, cy+2, 5), (cx+5, cy-2, 2)],
        [(cx, cy, 6), (cx-5, cy+3, 3)],
        [(cx+1, cy-3, 5), (cx-3, cy+3, 4)],
    ]
    layout = layouts[v % len(layouts)]
    for bx, by, r in layout:
        # Boulder: round dark base + lighter highlight
        d.ellipse([bx-r, by-r, bx+r, by+r], fill=C['mountain_dk'])
        d.ellipse([bx-r+1, by-r+1, bx+r-2, by+r-2], fill=base)
        # Highlight top-left
        d.ellipse([bx-r+1, by-r+1, bx-1, by-1], fill=C['mountain_lt'])
    # Tiny scattered rubble specks
    if v & 5 == 0: d.point((px+3, py+TILE-3), fill=C['mountain_dk'])
    if v & 11 == 0: d.point((px+TILE-3, py+3), fill=C['mountain_dk'])

def draw_snow(d, px, py, v):
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['snow'])
    if v & 3 == 0:
        d.point((px+5, py+6), fill=C['snow_dk'])
    if v & 5 == 0:
        d.point((px+TILE-6, py+TILE-7), fill=C['snow_dk'])
    if v & 7 == 0:
        d.point((px+9, py+12), fill=C['snow_dk'])

def draw_tree(d, px, py, leaf_dk, leaf, leaf_lt, kind='oak'):
    """Tree sprite. Caller fills grass under it first. kind: oak | pine | round | dead"""
    if kind == 'oak':
        # Bushy oak — overlapping ellipses (no square edges)
        cx = px + TILE//2
        # Trunk
        d.rectangle([cx-1, py+TILE-4, cx+1, py+TILE-1], fill=C['wood_dk'])
        # Dark base canopy: 3 overlapping ellipses
        d.ellipse([px+1, py+5, px+10, py+TILE-3], fill=leaf_dk)
        d.ellipse([px+TILE-10, py+5, px+TILE-1, py+TILE-3], fill=leaf_dk)
        d.ellipse([px+4, py+1, px+TILE-4, py+10], fill=leaf_dk)
        # Mid green — inset
        d.ellipse([px+3, py+6, px+9, py+TILE-5], fill=leaf)
        d.ellipse([px+TILE-9, py+6, px+TILE-3, py+TILE-5], fill=leaf)
        d.ellipse([px+5, py+3, px+TILE-5, py+9], fill=leaf)
        # Highlight blob (upper-left)
        d.ellipse([px+4, py+3, px+8, py+7], fill=leaf_lt)
    elif kind == 'pine':
        # Conical pine — triangular silhouette
        d.polygon([(px+TILE//2, py+1),
                   (px+2, py+TILE-3),
                   (px+TILE-3, py+TILE-3)], fill=leaf_dk)
        d.polygon([(px+TILE//2, py+4),
                   (px+4, py+TILE-5),
                   (px+TILE-5, py+TILE-5)], fill=leaf)
        d.rectangle([px+TILE//2-1, py+TILE-3, px+TILE//2+1, py+TILE-1], fill=C['wood_dk'])
        # Highlight
        d.point((px+TILE//2-1, py+5), fill=leaf_lt)
        d.point((px+TILE//2-2, py+8), fill=leaf_lt)
    elif kind == 'round':
        # Round canopy ball — wider/shorter
        d.ellipse([px+1, py+3, px+TILE-2, py+TILE-3], fill=leaf_dk)
        d.ellipse([px+3, py+4, px+TILE-4, py+TILE-5], fill=leaf)
        d.ellipse([px+5, py+5, px+9, py+9], fill=leaf_lt)
        # Trunk peek at bottom
        d.rectangle([px+TILE//2-1, py+TILE-4, px+TILE//2+1, py+TILE-1], fill=C['wood_dk'])
    elif kind == 'dead':
        # Dead/bare tree — just branches
        d.rectangle([px+TILE//2-1, py+3, px+TILE//2+1, py+TILE-2], fill=C['wood_dk'])
        d.line([(px+TILE//2, py+5), (px+4, py+2)], fill=C['wood_dk'])
        d.line([(px+TILE//2, py+7), (px+TILE-4, py+3)], fill=C['wood_dk'])
        d.line([(px+TILE//2, py+9), (px+3, py+7)], fill=C['wood_dk'])
        d.line([(px+TILE//2, py+10), (px+TILE-3, py+8)], fill=C['wood_dk'])
    elif kind == 'blossom':
        # Cherry blossom — pink ellipse canopy
        cx = px + TILE//2
        d.rectangle([cx-1, py+TILE-4, cx+1, py+TILE-1], fill=C['wood_dk'])
        d.ellipse([px+1, py+4, px+10, py+TILE-4], fill=(180, 80, 110))
        d.ellipse([px+TILE-10, py+4, px+TILE-1, py+TILE-4], fill=(180, 80, 110))
        d.ellipse([px+4, py+1, px+TILE-4, py+9], fill=(180, 80, 110))
        d.ellipse([px+3, py+5, px+9, py+TILE-5], fill=C['flower_p'])
        d.ellipse([px+TILE-9, py+5, px+TILE-3, py+TILE-5], fill=C['flower_p'])
        d.ellipse([px+5, py+3, px+TILE-5, py+8], fill=C['flower_p'])
        d.ellipse([px+5, py+4, px+9, py+8], fill=C['flower_w'])
        # Falling petals
        d.point((px+1, py+TILE-3), fill=C['flower_p'])
        d.point((px+TILE-2, py+TILE-5), fill=C['flower_p'])


# NOTE: Forests are drawn in TWO passes. The base-tile drawers below only render
# the FOREST FLOOR (a darker, mossy ground). The actual tree canopies are drawn
# in a SEPARATE pass after all base tiles are done, so canopies can overlap
# neighboring tiles and form a continuous forest mass instead of grid of circles.

def draw_forest_floor(d, px, py, v, dark=False):
    """Forest floor — slightly darker grass with shadow speckles where canopy will cover."""
    if dark:
        d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=(66, 118, 48))
    else:
        d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=(72, 130, 52))
    # Lighter speckles (sunlit grass spots)
    if v & 3 == 0:
        d.point((px+3, py+4), fill=(110, 175, 75))
    if v & 5 == 0:
        d.point((px+TILE-6, py+TILE-7), fill=(110, 175, 75))
    # Darker patches (shadows from canopy)
    if v & 7 == 0:
        d.point((px+TILE-7, py+5), fill=(45, 90, 35))
    if v & 11 == 0:
        d.point((px+5, py+TILE-4), fill=(45, 90, 35))
    # Grass blades
    if v & 13 == 0:
        d.line([(px+8, py+TILE-3), (px+8, py+TILE-6)], fill=(35, 75, 30))
    # Occasional undergrowth detail
    if not dark and v & 17 == 0:
        d.point((px+2+(v&7), py+TILE-2), fill=C['flower_w'])


def draw_forest(d, px, py, v):
    draw_forest_floor(d, px, py, v)
def draw_forest_dense(d, px, py, v):
    draw_forest_floor(d, px, py, v)
def draw_forest_dark(d, px, py, v):
    draw_forest_floor(d, px, py, v, dark=True)
def draw_orchard(d, px, py, v):
    draw_forest_floor(d, px, py, v)
def draw_autumn_forest(d, px, py, v):
    # Slightly browner floor (fallen leaves)
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=(95, 115, 55))
    # Scattered fallen leaves
    if v & 3 == 0: d.point((px+3, py+4), fill=C['autumn'])
    if v & 5 == 0: d.point((px+TILE-5, py+TILE-6), fill=C['autumn_lt'])
    if v & 7 == 0: d.point((px+8, py+10), fill=(170, 130, 40))
    if v & 11 == 0: d.point((px+TILE-4, py+5), fill=C['autumn_dk'])

def draw_cherry_grove(d, px, py, v):
    # Lush grass floor with pink petal scatter (canopies drawn in pass 2)
    grass_base(d, px, py, v, C['lush'], C['lush_lt'], C['grass_dk'], C['grass_blade'])
    if v & 3 == 0: d.point((px+3, py+TILE-3), fill=C['cherry'])
    if v & 5 == 0: d.point((px+TILE-5, py+5), fill=C['cherry_lt'])
    if v & 7 == 0: d.point((px+9, py+TILE-5), fill=C['cherry'])


def draw_wheat_field(d, px, py, v):
    # Golden wheat with wavy stalks
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['wheat'])
    # Wavy band patterns
    for k in range(py+1, py+TILE-1, 3):
        d.line([(px+1, k), (px+TILE-2, k)], fill=C['wheat_dk'])
    # Individual stalks (vertical thin lines)
    for sx in range(px+2, px+TILE, 3):
        ofy = (v + sx) & 1
        d.line([(sx, py+1+ofy), (sx, py+TILE-2)], fill=(240, 215, 130))
        d.point((sx, py+1+ofy), fill=(255, 240, 180))
    # Occasional poppy (red flower in wheat)
    if v & 31 == 0:
        d.point((px+TILE//2, py+TILE//2), fill=C['flower_r'])
        d.point((px+TILE//2-1, py+TILE//2+1), fill=C['flower_r'])


def draw_bamboo_grove(d, px, py, v):
    grass_base(d, px, py, v, C['lush'], C['lush_lt'], C['grass_dk'], C['grass_blade'])
    # Vertical bamboo stalks
    for sx, hgt in [(px+3, 4), (px+7, 2), (px+11, 3), (px+TILE-4, 1)]:
        d.line([(sx, py+hgt), (sx, py+TILE-2)], fill=C['bamboo_dk'])
        d.line([(sx+1, py+hgt), (sx+1, py+TILE-2)], fill=C['bamboo'])
        # Joints
        for j in range(py+hgt+3, py+TILE-2, 4):
            d.point((sx, j), fill=C['bamboo_lt'])
            d.point((sx+1, j), fill=C['bamboo_lt'])
        # Leaves at top
        d.point((sx-1, py+hgt-1), fill=C['bamboo'])
        d.point((sx+2, py+hgt-1), fill=C['bamboo_lt'])


def draw_desert(d, px, py, v):
    # Dunes — diagonal wavy lines on sand
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['desert'])
    for k in range(-TILE, TILE, 6):
        if (v + k) % 7 < 4:
            for i in range(TILE):
                if 0 <= i+k < TILE:
                    if (i + k) % 6 < 2:
                        d.point((px+i, py+i+k), fill=C['desert_dk'])
    # Tiny rocks
    if v & 7 == 0:
        d.point((px+5, py+TILE-5), fill=C['mountain_dk'])
        d.point((px+6, py+TILE-5), fill=C['mountain'])
    if v & 11 == 0:
        d.point((px+TILE-6, py+5), fill=C['mountain_dk'])


def draw_farm(d, px, py, v, orient='v'):
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['farm_dirt'])
    if orient == 'v':
        for sx in range(px+2, px+TILE, 4):
            d.rectangle([sx, py+1, sx+1, py+TILE-2], fill=C['crop_y'])
            d.rectangle([sx, py+1, sx, py+TILE-2], fill=C['crop_y_dk'])
        # Plant tops
        for sx in range(px+2, px+TILE, 4):
            d.point((sx, py+2), fill=C['crop_g'])
    else:
        for sy in range(py+2, py+TILE, 4):
            d.rectangle([px+1, sy, px+TILE-2, sy+1], fill=C['crop_y'])
            d.rectangle([px+1, sy, px+TILE-2, sy], fill=C['crop_y_dk'])

def draw_path(d, px, py, v):
    """Plain path tile (used as fallback)."""
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['path'])
    d.rectangle([px+1, py+1, px+TILE-2, py+TILE-2], fill=C['path_lt'])
    d.rectangle([px+2, py+2, px+TILE-3, py+TILE-3], fill=C['path'])
    if v & 7 == 0:
        d.point((px+5, py+7), fill=C['path_dk'])
    if v & 11 == 0:
        d.point((px+TILE-6, py+TILE-7), fill=C['path_dk'])


def draw_path_autotile(d, biome, y, x, px, py, v):
    """Path that only connects in directions with path-like neighbors.

    Cuts off ends with the surrounding biome color so paths look intentional,
    and adds dark outlines on edges facing non-path terrain.
    """
    PATH_LIKE = (PATH, STONE_FLOOR, BRIDGE, HOUSE, CASTLE, HIGHWAY, TRAIL)
    def is_pathlike(ny, nx):
        if not (0 <= ny < MAP_H and 0 <= nx < MAP_W): return False
        return biome[ny, nx] in PATH_LIKE
    n  = is_pathlike(y-1, x);  s  = is_pathlike(y+1, x)
    e  = is_pathlike(y, x+1);  w  = is_pathlike(y, x-1)
    ne = is_pathlike(y-1, x+1); nw = is_pathlike(y-1, x-1)
    se = is_pathlike(y+1, x+1); sw = is_pathlike(y+1, x-1)

    def surround_color(ny, nx):
        if not (0 <= ny < MAP_H and 0 <= nx < MAP_W): return None
        t = biome[ny, nx]
        if t == GRASS:        return C['grass']
        if t == GRASS_LUSH:   return C['lush']
        if t in (FOREST, F_DENSE): return C['grass']
        if t == BEACH:        return C['beach']
        if t == SAND:         return C['sand']
        if t in (FARM_V, FARM_H): return C['farm_dirt']
        if t == MOUNT:        return C['mountain']
        if t == SWAMP:        return C['swamp']
        return None

    # Base path
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['path'])
    d.rectangle([px+1, py+1, px+TILE-2, py+TILE-2], fill=C['path_lt'])
    d.rectangle([px+2, py+2, px+TILE-3, py+TILE-3], fill=C['path'])

    if v & 7 == 0:  d.point((px+5, py+7), fill=C['path_dk'])
    if v & 11 == 0: d.point((px+TILE-6, py+TILE-7), fill=C['path_dk'])

    # Cut off ends to surrounding biome color
    if not n:
        col = surround_color(y-1, x) or C['grass']
        d.rectangle([px, py, px+TILE-1, py+1], fill=col)
    if not s:
        col = surround_color(y+1, x) or C['grass']
        d.rectangle([px, py+TILE-2, px+TILE-1, py+TILE-1], fill=col)
    if not w:
        col = surround_color(y, x-1) or C['grass']
        d.rectangle([px, py, px+1, py+TILE-1], fill=col)
    if not e:
        col = surround_color(y, x+1) or C['grass']
        d.rectangle([px+TILE-2, py, px+TILE-1, py+TILE-1], fill=col)

    # Dark edge outline on sides facing non-path
    if not n: d.line([(px+2, py+2), (px+TILE-3, py+2)], fill=C['path_dk'])
    if not s: d.line([(px+2, py+TILE-3), (px+TILE-3, py+TILE-3)], fill=C['path_dk'])
    if not w: d.line([(px+2, py+2), (px+2, py+TILE-3)], fill=C['path_dk'])
    if not e: d.line([(px+TILE-3, py+2), (px+TILE-3, py+TILE-3)], fill=C['path_dk'])

    # Inside-corner darkening at turns
    if n and e and not ne: d.point((px+TILE-3, py+2), fill=C['path_dk'])
    if n and w and not nw: d.point((px+2, py+2), fill=C['path_dk'])
    if s and e and not se: d.point((px+TILE-3, py+TILE-3), fill=C['path_dk'])
    if s and w and not sw: d.point((px+2, py+TILE-3), fill=C['path_dk'])

def draw_highway_autotile(d, biome, y, x, px, py, v):
    """Major stone-paved road, wider visual than dirt path."""
    PATH_LIKE = (PATH, STONE_FLOOR, BRIDGE, HOUSE, CASTLE, HIGHWAY, TRAIL)
    def is_pathlike(ny, nx):
        if not (0 <= ny < MAP_H and 0 <= nx < MAP_W): return False
        return biome[ny, nx] in PATH_LIKE
    n  = is_pathlike(y-1, x);  s  = is_pathlike(y+1, x)
    e  = is_pathlike(y, x+1);  w  = is_pathlike(y, x-1)

    def surround_color(ny, nx):
        if not (0 <= ny < MAP_H and 0 <= nx < MAP_W): return None
        t = biome[ny, nx]
        if t == GRASS:        return C['grass']
        if t == GRASS_LUSH:   return C['lush']
        if t in (FOREST, F_DENSE, AUTUMN_FOREST): return C['grass']
        if t == BEACH:        return C['beach']
        if t == SAND:         return C['sand']
        if t in (FARM_V, FARM_H): return C['farm_dirt']
        if t == MOUNT:        return C['mountain']
        return None

    # Stone-paved base
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['stone_dk'])
    d.rectangle([px+1, py+1, px+TILE-2, py+TILE-2], fill=C['stone'])
    # Cobblestone pattern - alternating tile checker
    if (x + y) % 2 == 0:
        d.rectangle([px+3, py+3, px+TILE//2-1, py+TILE//2], fill=C['stone_lt'])
        d.rectangle([px+TILE//2+1, py+TILE//2+1, px+TILE-4, py+TILE-4], fill=C['stone_lt'])
    else:
        d.rectangle([px+TILE//2+1, py+3, px+TILE-4, py+TILE//2], fill=C['stone_lt'])
        d.rectangle([px+3, py+TILE//2+1, px+TILE//2-1, py+TILE-4], fill=C['stone_lt'])
    # Light dirt borders along the side (worn shoulders)
    if not n:
        col = surround_color(y-1, x) or C['grass']
        d.rectangle([px, py, px+TILE-1, py+1], fill=col)
        d.line([(px+1, py+2), (px+TILE-2, py+2)], fill=C['path'])
    if not s:
        col = surround_color(y+1, x) or C['grass']
        d.rectangle([px, py+TILE-2, px+TILE-1, py+TILE-1], fill=col)
        d.line([(px+1, py+TILE-3), (px+TILE-2, py+TILE-3)], fill=C['path'])
    if not w:
        col = surround_color(y, x-1) or C['grass']
        d.rectangle([px, py, px+1, py+TILE-1], fill=col)
        d.line([(px+2, py+1), (px+2, py+TILE-2)], fill=C['path'])
    if not e:
        col = surround_color(y, x+1) or C['grass']
        d.rectangle([px+TILE-2, py, px+TILE-1, py+TILE-1], fill=col)
        d.line([(px+TILE-3, py+1), (px+TILE-3, py+TILE-2)], fill=C['path'])


def draw_trail_autotile(d, biome, y, x, px, py, v):
    """Thin minor trail — narrower than path, just a dirt line."""
    PATH_LIKE = (PATH, STONE_FLOOR, BRIDGE, HOUSE, CASTLE, HIGHWAY, TRAIL)
    def is_pathlike(ny, nx):
        if not (0 <= ny < MAP_H and 0 <= nx < MAP_W): return False
        return biome[ny, nx] in PATH_LIKE
    n  = is_pathlike(y-1, x);  s  = is_pathlike(y+1, x)
    e  = is_pathlike(y, x+1);  w  = is_pathlike(y, x-1)

    def surround_color(ny, nx):
        if not (0 <= ny < MAP_H and 0 <= nx < MAP_W): return C['grass']
        t = biome[ny, nx]
        if t == GRASS_LUSH:   return C['lush']
        if t == BEACH:        return C['beach']
        if t == SAND:         return C['sand']
        if t == MOUNT:        return C['mountain']
        if t == DESERT:       return C['desert']
        if t == SWAMP:        return C['swamp']
        return C['grass']

    base = surround_color(y, x)
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=base)
    # Draw a narrow worn dirt strip in the directions of connections
    mid = TILE // 2
    if n: d.rectangle([px+mid-2, py, px+mid+1, py+mid+1], fill=C['path_dk'])
    if s: d.rectangle([px+mid-2, py+mid-1, px+mid+1, py+TILE-1], fill=C['path_dk'])
    if w: d.rectangle([px, py+mid-2, px+mid+1, py+mid+1], fill=C['path_dk'])
    if e: d.rectangle([px+mid-1, py+mid-2, px+TILE-1, py+mid+1], fill=C['path_dk'])
    # Pebbles
    if v & 7 == 0 and (n or s or e or w):
        d.point((px+mid, py+mid), fill=C['path_lt'])


def draw_stone_floor(d, px, py, v):
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['stone'])
    # Cobbles
    if (px // TILE + py // TILE) % 2 == 0:
        d.rectangle([px+2, py+2, px+TILE//2-1, py+TILE//2-1], fill=C['stone_lt'])
        d.rectangle([px+TILE//2, py+TILE//2, px+TILE-3, py+TILE-3], fill=C['stone_lt'])
    else:
        d.rectangle([px+TILE//2, py+2, px+TILE-3, py+TILE//2-1], fill=C['stone_lt'])
        d.rectangle([px+2, py+TILE//2, px+TILE//2-1, py+TILE-3], fill=C['stone_lt'])
    # Grout lines
    d.line([(px, py+TILE//2), (px+TILE-1, py+TILE//2)], fill=C['stone_dk'])
    d.line([(px+TILE//2, py), (px+TILE//2, py+TILE-1)], fill=C['stone_dk'])

def draw_bridge(d, px, py, v):
    # Water under
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['water_dk'])
    # Wooden plank deck
    d.rectangle([px+1, py+3, px+TILE-2, py+TILE-3], fill=C['wood'])
    # Plank lines
    for k in range(py+5, py+TILE-3, 3):
        d.line([(px+1, k), (px+TILE-2, k)], fill=C['wood_dk'])
    # Rails
    d.line([(px+1, py+3), (px+TILE-2, py+3)], fill=C['wood_dk'])
    d.line([(px+1, py+TILE-3), (px+TILE-2, py+TILE-3)], fill=C['wood_dk'])

def draw_house_tile(d, px, py):
    """Single-tile fallback house — for ungrouped HOUSE cells."""
    d.rectangle([px, py, px+TILE-1, py+TILE-1], fill=C['grass'])

def add_transition_edge(d, px, py, biome, y, x, my_type):
    """Add darker border pixels on sides where neighbor has lower priority."""
    # Only for grass-like and farm tiles facing ocean/water → adds beach-like edge
    # And forest tiles facing grass → adds mossy edge
    pass  # Subtle edges are handled by individual tile drawers


# Coastline outline & foam
def render_forest_canopies(canvas, biome):
    """Draw all tree canopies in a single pass with size-jittered overlapping
    ellipses, clipped via mask so they don't bleed onto roads/buildings/water.
    This is what makes forests look like a continuous canopy instead of grid
    of circles — adjacent canopies overlap each other and merge naturally."""
    FOREST_TYPES = (FOREST, F_DENSE, F_DARK, AUTUMN_FOREST,
                    ORCHARD, CHERRY_GROVE)
    # Vegetation-compatible tiles (canopies can paint over these)
    VEG_OK = (GRASS, GRASS_LUSH, FOREST, F_DENSE, F_DARK, AUTUMN_FOREST,
              ORCHARD, CHERRY_GROVE, BAMBOO_GROVE, SWAMP, BEACH)

    # Build a mask of where canopies can be painted
    print("  building canopy mask…")
    mask = Image.new('L', (W, H), 0)
    md = ImageDraw.Draw(mask)
    for y in range(MAP_H):
        for x in range(MAP_W):
            if biome[y, x] in VEG_OK:
                md.rectangle([x*TILE, y*TILE, (x+1)*TILE-1, (y+1)*TILE-1], fill=255)

    # Draw canopies on a separate layer
    print("  painting canopies…")
    canopy = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(canopy)

    # Connected under-canopy shadows help dense/dark forests read as a single
    # biome mass instead of a patchwork of darker square floor tiles.
    for y in range(MAP_H):
        for x in range(MAP_W):
            t = biome[y, x]
            if t not in (F_DENSE, F_DARK):
                continue
            v = variant(x, y)
            px, py = x * TILE, y * TILE
            cx_ = px + TILE // 2 + ((v >> 3) % 7) - 3
            cy_ = py + TILE // 2 + ((v >> 6) % 5) - 2
            if t == F_DARK:
                col = (12, 44, 18, 185)
                rx = 18 + (v % 6)
                ry = 15 + ((v >> 4) % 6)
            else:
                col = (18, 70, 25, 125)
                rx = 16 + (v % 5)
                ry = 14 + ((v >> 4) % 5)
            cd.ellipse([cx_ - rx, cy_ - ry, cx_ + rx, cy_ + ry], fill=col)

    # Color palettes for each forest type
    def palette_for(t, v):
        if t == FOREST:
            return (C['tree_dk'], C['tree'], C['tree_lt'])
        elif t == F_DENSE:
            return ((18, 65, 25), (40, 105, 45), (75, 145, 60))
        elif t == F_DARK:
            return ((10, 35, 12), (22, 60, 22), (40, 90, 35))
        elif t == AUTUMN_FOREST:
            # Mix orange / yellow / red trees by variant
            mode = v % 3
            if mode == 0: return (C['autumn_dk'], C['autumn'], C['autumn_lt'])
            if mode == 1: return ((130, 50, 30), (200, 90, 50), (240, 140, 80))
            return ((150, 110, 35), (210, 175, 55), (245, 220, 100))
        elif t == ORCHARD:
            return (C['tree_dk'], C['tree'], C['tree_lt'])
        elif t == CHERRY_GROVE:
            return ((180, 80, 110), C['cherry'], C['cherry_lt'])
        return (C['tree_dk'], C['tree'], C['tree_lt'])

    for y in range(MAP_H):
        for x in range(MAP_W):
            t = biome[y, x]
            if t not in FOREST_TYPES: continue
            v = variant(x, y)
            px, py = x * TILE, y * TILE

            # Position jitter and size class
            jx = ((v >> 2) % 9) - 4
            jy = ((v >> 5) % 7) - 3
            sz = (v >> 8) % 10
            if sz < 2:   r = 8
            elif sz < 6: r = 11
            elif sz < 9: r = 14
            else:        r = 16

            cx_ = px + TILE//2 + jx
            cy_ = py + TILE//2 + jy - 1
            dk, mid, lt = palette_for(t, v)

            # ─── Per-biome canopy STYLE ───
            # Each forest type now draws a structurally different canopy.

            if t == F_DENSE:
                # Dense forest: heavy multi-blob layered canopy
                # Outer dark blob mass — irregular by stacking 5 ellipses
                offsets = [(-4,-2,r),(4,-3,r-1),(0,-5,r-2),(-3,4,r-2),(5,2,r-2)]
                for ox, oy, br in offsets:
                    cd.ellipse([cx_+ox-br, cy_+oy-br, cx_+ox+br, cy_+oy+br], fill=dk)
                # Mid green clumps (smaller, inside)
                for ox, oy in [(-3,-1),(3,-2),(0,2),(-2,3),(3,3)]:
                    cd.ellipse([cx_+ox-5, cy_+oy-5, cx_+ox+5, cy_+oy+5], fill=mid)
                # Brightest sun-hit on top-left
                cd.ellipse([cx_-r+3, cy_-r+1, cx_-1, cy_-3], fill=lt)
                # Tiny twigs / branch peeks (texture)
                for spk in range(3):
                    sx = cx_ + ((v >> (12+spk*3)) % (2*r-4)) - (r-2)
                    sy = cy_ + ((v >> (14+spk*3)) % (2*r-4)) - (r-2)
                    if (sx-cx_)**2 + (sy-cy_)**2 < (r-3)**2:
                        cd.point((sx, sy), fill=dk)

            elif t == F_DARK:
                # Dark forest: one ancient, tangled canopy mass with sparse
                # highlights. The broad shadow pass above handles cohesion.
                cd.ellipse([cx_-r-2, cy_-r+1, cx_+r+2, cy_+r-1], fill=dk)
                for ox, oy, rr in [(-5, -3, r-4), (5, -2, r-5),
                                   (-2, 4, r-5), (4, 4, r-6)]:
                    cd.ellipse([cx_+ox-rr, cy_+oy-rr,
                                cx_+ox+rr, cy_+oy+rr], fill=mid)
                # Dark branch strokes break up the "green circle" read.
                branch = (8, 25, 10)
                cd.line([(cx_-r+2, cy_), (cx_-3, cy_-3), (cx_+r-3, cy_+2)],
                        fill=branch)
                cd.line([(cx_-r//2, cy_+5), (cx_, cy_+1), (cx_+r//2, cy_+6)],
                        fill=branch)
                if v & 3 == 0:
                    cd.ellipse([cx_-r+4, cy_-r+3, cx_-r+8, cy_-r+7], fill=lt)
                # Spooky glowing eyes (rare)
                if v & 47 == 0:
                    cd.point((cx_-2, cy_), fill=(220, 100, 100))
                    cd.point((cx_+2, cy_), fill=(220, 100, 100))

            elif t == AUTUMN_FOREST:
                # Autumn: clumpy round canopy with vibrant fall colors,
                # extra leaf scatter and mixed warm tones
                # Base dark
                cd.ellipse([cx_-r, cy_-r, cx_+r, cy_+r], fill=dk)
                # Multiple lobe blobs in mid tone
                lobes = [(-r//2,-r//3),(r//2,-r//2),(-r//3,r//2),(r//3,r//3),(0,-r//2)]
                for ox, oy in lobes:
                    cd.ellipse([cx_+ox-5, cy_+oy-5, cx_+ox+5, cy_+oy+5], fill=mid)
                # Bright leaf highlights
                cd.ellipse([cx_-r+3, cy_-r+2, cx_-r+8, cy_-r+7], fill=lt)
                # Extra colored leaves stuck to canopy
                accent = random.choice([(220,80,40),(255,150,40),(245,210,80)])
                for spk in range(3):
                    sx = cx_ + ((v >> (10+spk*3)) % (2*r-2)) - (r-1)
                    sy = cy_ + ((v >> (12+spk*3)) % (2*r-2)) - (r-1)
                    if (sx-cx_)**2 + (sy-cy_)**2 < (r-1)**2:
                        cd.point((sx, sy), fill=accent)

            elif t == CHERRY_GROVE:
                # Cherry: cloud-like rounded fluff with white highlights
                cd.ellipse([cx_-r, cy_-r, cx_+r, cy_+r], fill=dk)
                # Multiple soft blossom blobs
                for ox, oy in [(-r//2,-r//3),(r//2,-r//3),(0,r//3),(-r//3,r//4)]:
                    cd.ellipse([cx_+ox-4, cy_+oy-4, cx_+ox+4, cy_+oy+4], fill=mid)
                # Bright white blossom highlights
                cd.ellipse([cx_-r+2, cy_-r+2, cx_-r+7, cy_-r+7], fill=lt)
                cd.ellipse([cx_+r-7, cy_+r-7, cx_+r-2, cy_+r-2], fill=lt)
                # Falling petal specks
                for spk in range(2):
                    sx = cx_ + ((v >> (10+spk*3)) % 20) - 10
                    sy = cy_ + r + spk*3
                    cd.point((sx, sy), fill=C['flower_w'])

            elif t == ORCHARD:
                # Orchard: tidy round canopy with bright fruit
                cd.ellipse([cx_-r, cy_-r, cx_+r, cy_+r], fill=dk)
                cd.ellipse([cx_-r+2, cy_-r+2, cx_+r-3, cy_+r-3], fill=mid)
                cd.ellipse([cx_-r+3, cy_-r+2, cx_-r+8, cy_-r+7], fill=lt)
                # Fruit dots
                for spk in range(4):
                    sx = cx_ + ((v >> (10+spk*2)) % (2*r-4)) - (r-2)
                    sy = cy_ + ((v >> (12+spk*2)) % (2*r-4)) - (r-2)
                    if (sx-cx_)**2 + (sy-cy_)**2 < (r-3)**2:
                        col = random.choice([C['tree_red'], C['tree_orange']])
                        cd.point((sx, sy), fill=col)

            else:  # FOREST (default oak/deciduous) — varied lobe structure
                # Choose between 3 distinct canopy shape patterns by variant
                shape_mode = (v >> 4) % 4
                if shape_mode == 0:
                    # Round bushy 4-blob
                    cd.ellipse([cx_-r, cy_-r, cx_+r, cy_+r], fill=dk)
                    for ang_i in range(4):
                        ang = ang_i * math.pi / 2 + (v >> 10 & 7) * 0.1
                        lx = cx_ + int(math.cos(ang) * r * 0.45)
                        ly = cy_ + int(math.sin(ang) * r * 0.45) - 1
                        cd.ellipse([lx-5, ly-5, lx+5, ly+5], fill=mid)
                elif shape_mode == 1:
                    # Wide, low-spreading
                    cd.ellipse([cx_-r-1, cy_-r+2, cx_+r+1, cy_+r-1], fill=dk)
                    cd.ellipse([cx_-r+2, cy_-r+3, cx_+r-2, cy_+r-3], fill=mid)
                elif shape_mode == 2:
                    # Tall narrow
                    cd.ellipse([cx_-r+2, cy_-r-1, cx_+r-2, cy_+r-1], fill=dk)
                    cd.ellipse([cx_-r+3, cy_-r+1, cx_+r-3, cy_+r-3], fill=mid)
                else:
                    # Bumpy three-mound
                    cd.ellipse([cx_-r, cy_-r+3, cx_+r, cy_+r-1], fill=dk)
                    cd.ellipse([cx_-7, cy_-r+1, cx_-1, cy_-r+7], fill=dk)
                    cd.ellipse([cx_-2, cy_-r-1, cx_+5, cy_-r+5], fill=dk)
                    cd.ellipse([cx_+1, cy_-r+2, cx_+7, cy_-r+8], fill=dk)
                    cd.ellipse([cx_-r+2, cy_, cx_+r-2, cy_+r-3], fill=mid)
                # Highlight on top-left
                cd.ellipse([cx_-r+3, cy_-r+2, cx_-r+8, cy_-r+7], fill=lt)
                # Tiny dark texture specks for "leaf clumps"
                for spk in range(3):
                    sx = cx_ + ((v >> (10+spk*3)) % (2*r-4)) - (r-2)
                    sy = cy_ + ((v >> (12+spk*3)) % (2*r-4)) - (r-2)
                    if (sx-cx_)**2 + (sy-cy_)**2 < (r-2)**2:
                        cd.point((sx, sy), fill=dk)
                # Bright sparkle
                cd.point((cx_-r+5, cy_-r+4), fill=tuple(min(255,c+40) for c in lt))

            # Type-specific overlays
            if t == ORCHARD:
                # Fruit dots on the canopy
                cd.point((cx_+2, cy_+1), fill=C['tree_red'])
                cd.point((cx_-3, cy_+3), fill=C['tree_orange'])
                cd.point((cx_+4, cy_-2), fill=C['tree_red'])
            elif t == CHERRY_GROVE:
                # Bright blossom dots — small white highlights
                cd.point((cx_+r-5, cy_+r-6), fill=C['flower_w'])
                cd.point((cx_-r+5, cy_+r-3), fill=C['flower_w'])
                cd.point((cx_, cy_-r+3), fill=C['flower_w'])
            elif t == AUTUMN_FOREST:
                # Bright autumn berries / leaf cluster
                cd.point((cx_+r-4, cy_-2), fill=(255, 100, 50))
                cd.point((cx_-r+4, cy_+2), fill=(255, 200, 60))

    # Apply the canopy through the vegetation mask
    print("  compositing…")
    canopy.putalpha(ImageChops.multiply(canopy.split()[3], mask))
    canvas.alpha_composite(canopy)

    # Pine trees: drawn AFTER canopies as accents
    cd2 = ImageDraw.Draw(canvas)
    for y in range(MAP_H):
        for x in range(MAP_W):
            if biome[y, x] not in (FOREST, F_DENSE, AUTUMN_FOREST): continue
            v = variant(x, y)
            if (v & 31) < 22: continue
            px, py = x * TILE, y * TILE
            jx = ((v >> 2) % 5) - 2
            jy = ((v >> 5) % 4) - 1
            cx_ = px + TILE//2 + jx
            cy_ = py + TILE//2 + jy
            dk = (28, 65, 28); mid = (50, 105, 45); lt = (90, 150, 65)
            # Multi-layer pine with shading
            cd2.polygon([(cx_, cy_-10), (cx_-6, cy_+5), (cx_+6, cy_+5)], fill=dk)
            cd2.polygon([(cx_, cy_-7),  (cx_-4, cy_+4), (cx_+4, cy_+4)], fill=mid)
            cd2.polygon([(cx_, cy_-5),  (cx_-2, cy_+2), (cx_+2, cy_+2)], fill=lt)
            cd2.point((cx_-1, cy_-3), fill=(160, 200, 100))
            # Tiny trunk peek
            cd2.rectangle([cx_-1, cy_+5, cx_, cy_+7], fill=(60, 40, 25))

    # ─── DEAD TREES for SWAMP: gnarled bare branches reaching up from the murk ───
    cd3 = ImageDraw.Draw(canvas)
    for y in range(MAP_H):
        for x in range(MAP_W):
            if biome[y, x] != SWAMP: continue
            v = variant(x, y)
            if (v & 15) < 6: continue   # not every swamp cell — about 60%
            px, py = x * TILE, y * TILE
            jx = ((v >> 2) % 5) - 2
            jy = ((v >> 5) % 3) - 1
            cx_ = px + TILE//2 + jx
            cy_ = py + TILE//2 + jy + 2
            trunk_dk = (45, 30, 18)
            trunk_mid = (75, 55, 35)
            # Crooked trunk
            cd3.line([(cx_, cy_+6), (cx_, cy_-7)], fill=trunk_dk, width=2)
            cd3.line([(cx_+1, cy_+6), (cx_+1, cy_-5)], fill=trunk_mid)
            # Gnarled branches
            cd3.line([(cx_, cy_-3), (cx_-5, cy_-7)], fill=trunk_dk)
            cd3.line([(cx_-5, cy_-7), (cx_-7, cy_-5)], fill=trunk_dk)
            cd3.line([(cx_, cy_-5), (cx_+5, cy_-8)], fill=trunk_dk)
            cd3.line([(cx_+5, cy_-8), (cx_+7, cy_-6)], fill=trunk_dk)
            cd3.line([(cx_, cy_-7), (cx_-3, cy_-10)], fill=trunk_dk)
            cd3.line([(cx_, cy_-7), (cx_+2, cy_-10)], fill=trunk_dk)
            # Hanging moss / drips
            if v & 31 == 0:
                cd3.line([(cx_-3, cy_-6), (cx_-3, cy_-3)], fill=(90, 130, 70))
            if v & 23 == 0:
                cd3.line([(cx_+4, cy_-7), (cx_+4, cy_-4)], fill=(90, 130, 70))
            # Occasional carrion crow silhouette on a branch
            if v & 63 == 0:
                cd3.point((cx_-4, cy_-7), fill=(20, 20, 20))
                cd3.point((cx_-3, cy_-7), fill=(20, 20, 20))


def draw_coastline_layer(canvas, biome):
    """Thin sandy strip where ocean meets land — no chunky brown 'dock-like' corners."""
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for y in range(MAP_H):
        for x in range(MAP_W):
            if biome[y, x] not in (OCEAN, DEEP): continue
            for dy, dx in [(-1,0),(1,0),(0,-1),(0,1)]:
                ny, nx = y+dy, x+dx
                if 0<=ny<MAP_H and 0<=nx<MAP_W and biome[ny, nx] not in (OCEAN, DEEP):
                    px, py = x*TILE, y*TILE
                    # Thin sandy lip (2px) along the boundary
                    if dy == -1:
                        d.rectangle([px+1, py+TILE-2, px+TILE-2, py+TILE-1], fill=C['coast'])
                    elif dy == 1:
                        d.rectangle([px+1, py, px+TILE-2, py+1], fill=C['coast'])
                    elif dx == -1:
                        d.rectangle([px+TILE-2, py+1, px+TILE-1, py+TILE-2], fill=C['coast'])
                    elif dx == 1:
                        d.rectangle([px, py+1, px+1, py+TILE-2], fill=C['coast'])
    canvas.alpha_composite(layer)


# ── Multi-tile structures (drawn over the tile pass) ─────────────────────

def draw_house_sprite(canvas, gx, gy):
    """2x2 cottage sprite at tile coords (gx,gy)."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*2
    layer = Image.new('RGBA', (w+8, h+12), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Wall
    wt = 12; wb = h - 2
    d.rectangle([4, wt, w-4, wb], fill=C['wall'])
    d.rectangle([w-7, wt, w-4, wb], fill=C['wall_dk'])
    d.rectangle([4, wb-3, w-4, wb], fill=C['wood_dk'])
    # Roof
    roof_color = random.choice([C['roof'], C['roof_blue']])
    roof_dk    = C['roof_dk'] if roof_color == C['roof'] else C['roof_blue_dk']
    d.polygon([(0, wt+2), (w//2, 2), (w, wt+2)], fill=roof_color)
    d.polygon([(w//2, 2), (w, wt+2), (w//2, wt+2)], fill=roof_dk)
    d.line([(0, wt+2), (w//2, 2), (w, wt+2)], fill=C['wood_dk'])
    # Door
    dw, dh = 8, 14
    d.rectangle([w//2 - dw//2, wb - dh, w//2 + dw//2, wb], fill=C['wood'])
    d.rectangle([w//2 - dw//2, wb - dh, w//2 + dw//2 - 1, wb - 1], fill=C['wood_lt'])
    d.point((w//2 + dw//2 - 2, wb - dh//2), fill=C['flower_y'])
    # Window
    d.rectangle([8, wt + 6, 14, wt + 12], fill=C['water_lt'])
    d.rectangle([8, wt + 6, 14, wt + 12], outline=C['wood_dk'])
    d.line([(11, wt + 6), (11, wt + 12)], fill=C['wood_dk'])
    d.rectangle([w-14, wt + 6, w-8, wt + 12], fill=C['water_lt'])
    d.rectangle([w-14, wt + 6, w-8, wt + 12], outline=C['wood_dk'])
    d.line([(w-11, wt + 6), (w-11, wt + 12)], fill=C['wood_dk'])
    # Chimney
    d.rectangle([w-12, 4, w-8, wt+2], fill=C['stone_dk'])
    d.rectangle([w-13, 3, w-7, 6], fill=C['stone'])
    canvas.alpha_composite(layer, (px-4, py-12))


def draw_castle_sprite(canvas, gx, gy, style=None):
    """Castle with a style dict: size, wall colors, roof colors, tower shape.
    Each style gives a visually distinct castle."""
    if style is None:
        style = CASTLE_STYLES[0]
    tw, th = style['size']
    px, py = gx * TILE, gy * TILE
    cw = tw * TILE; ch = th * TILE
    wall    = style['wall']
    wall_dk = style['wall_dk']
    wall_lt = style['wall_lt']
    roof    = style['roof']
    roof_dk = style['roof_dk']
    tower_count = style['tower_count']
    tower_roof  = style['tower_roof']
    flag_col    = style['flag_color']

    # Extra headroom above for top tower roofs + flags
    layer = Image.new('RGBA', (cw + 60, ch + 130), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ox = 30; oy = 100

    # Inner courtyard
    if tw >= 6 and th >= 5:
        d.rectangle([ox + 25, oy + 50, ox + cw - 25, oy + ch - 10],
                    fill=C['stone'])
        for k in range(oy + 60, oy + ch - 10, 14):
            d.line([(ox + 25, k), (ox + cw - 25, k)], fill=C['stone_dk'])

    # Walls
    wt = 18
    # Top wall
    d.rectangle([ox, oy + 30, ox + cw, oy + 30 + wt], fill=wall)
    d.rectangle([ox, oy + 30 + wt - 4, ox + cw, oy + 30 + wt], fill=wall_dk)
    # Left
    d.rectangle([ox, oy + 30, ox + wt, oy + ch], fill=wall)
    # Right
    d.rectangle([ox + cw - wt, oy + 30, ox + cw, oy + ch], fill=wall)
    d.rectangle([ox + cw - 4, oy + 30, ox + cw, oy + ch], fill=wall_dk)
    # Bottom (with gate gap)
    gate_w = 30 if tw >= 7 else 24
    gx1 = ox + cw // 2 - gate_w // 2
    gx2 = ox + cw // 2 + gate_w // 2
    d.rectangle([ox, oy + ch - wt, gx1, oy + ch], fill=wall)
    d.rectangle([gx2, oy + ch - wt, ox + cw, oy + ch], fill=wall)
    d.rectangle([ox, oy + ch - 4, gx1, oy + ch], fill=wall_dk)
    d.rectangle([gx2, oy + ch - 4, ox + cw, oy + ch], fill=wall_dk)

    # Crenellations along top wall
    cstep = 9
    cx = ox + 4
    while cx + 5 < ox + cw - 4:
        d.rectangle([cx, oy + 30 - 6, cx + 5, oy + 30], fill=wall)
        cx += cstep

    # Tower positions based on tower_count
    if tower_count == 2:
        towers = [(ox, oy + ch), (ox + cw, oy + ch)]
    elif tower_count == 3:
        towers = [(ox, oy + 30), (ox + cw, oy + 30), (ox + cw // 2, oy + ch)]
    else:
        towers = [(ox, oy + 30), (ox + cw, oy + 30),
                  (ox, oy + ch), (ox + cw, oy + ch)]

    tower_r = 16
    for tx, ty in towers:
        # Base disc
        d.ellipse([tx - tower_r, ty - tower_r, tx + tower_r, ty + tower_r], fill=wall)
        d.ellipse([tx - tower_r + 4, ty - tower_r - 2,
                    tx + tower_r - 8, ty + tower_r - 12], fill=wall_lt)
        # Tower body going up
        tower_top_y = ty - tower_r - 48
        d.rectangle([tx - tower_r + 4, tower_top_y,
                     tx + tower_r - 4, ty - tower_r + 4], fill=wall)
        d.rectangle([tx + tower_r - 8, tower_top_y,
                     tx + tower_r - 4, ty - tower_r + 4], fill=wall_dk)
        # Crenellations on tower top
        for ddx in range(-tower_r + 4, tower_r - 4, 6):
            d.rectangle([tx + ddx, tower_top_y - 6,
                         tx + ddx + 3, tower_top_y], fill=wall)

        if tower_roof == 'cone':
            # Conical roof
            d.polygon([(tx - tower_r + 2, tower_top_y),
                       (tx + tower_r - 2, tower_top_y),
                       (tx, tower_top_y - 22)], fill=roof)
            d.polygon([(tx, tower_top_y),
                       (tx + tower_r - 2, tower_top_y),
                       (tx, tower_top_y - 22)], fill=roof_dk)
            roof_top = tower_top_y - 22
            # Flag
            d.line([(tx, roof_top), (tx, roof_top - 12)], fill=C['wood_dk'])
            d.polygon([(tx, roof_top - 12),
                       (tx, roof_top - 6),
                       (tx + 7, roof_top - 9)], fill=flag_col)
        elif tower_roof == 'dome':
            # Hemispherical dome
            d.ellipse([tx - tower_r + 2, tower_top_y - 16,
                        tx + tower_r - 2, tower_top_y + 8], fill=roof)
            d.ellipse([tx - tower_r + 4, tower_top_y - 14,
                        tx, tower_top_y - 4], fill=roof_dk)
            # Small finial
            d.line([(tx, tower_top_y - 16), (tx, tower_top_y - 24)],
                   fill=C['wood_dk'])
            d.ellipse([tx - 2, tower_top_y - 26, tx + 2, tower_top_y - 22],
                      fill=flag_col)
        else:  # flat (just crenellations, no roof)
            # Extra battlements on top
            for ddx in range(-tower_r + 4, tower_r - 4, 4):
                d.rectangle([tx + ddx, tower_top_y - 10,
                             tx + ddx + 2, tower_top_y - 5],
                            fill=wall_dk)
            # Flag on stub pole
            d.line([(tx, tower_top_y - 5), (tx, tower_top_y - 15)],
                   fill=C['wood_dk'])
            d.polygon([(tx, tower_top_y - 15),
                       (tx + 6, tower_top_y - 12),
                       (tx, tower_top_y - 9)], fill=flag_col)

    # Gate house
    gh_x = ox + cw // 2 - 22
    gh_w = 44
    gh_top = oy + ch - wt - 38
    d.rectangle([gh_x, gh_top, gh_x + gh_w, oy + ch], fill=wall)
    d.rectangle([gh_x + gh_w - 4, gh_top, gh_x + gh_w, oy + ch], fill=wall_dk)
    # Gate arch (dark wood + door)
    d.rounded_rectangle([gh_x + 12, oy + ch - 24, gh_x + gh_w - 12, oy + ch],
                        radius=8, fill=C['wood_dk'])
    d.rounded_rectangle([gh_x + 14, oy + ch - 22, gh_x + gh_w - 14, oy + ch - 2],
                        radius=6, fill=C['wood'])
    # Gatehouse crenellations
    for ddx in range(0, gh_w, 6):
        d.rectangle([gh_x + ddx, gh_top - 5, gh_x + ddx + 3, gh_top], fill=wall)
    # Banner above gate
    d.rectangle([gh_x + gh_w // 2 - 6, gh_top - 14, gh_x + gh_w // 2 + 6,
                  gh_top - 5], fill=flag_col)

    canvas.alpha_composite(layer, (px - 30, py - 100))


def draw_windmill_sprite(canvas, gx, gy):
    """2x3 windmill."""
    px, py = gx * TILE, gy * TILE
    cw = 2 * TILE; ch = 3 * TILE
    layer = Image.new('RGBA', (cw + 24, ch + 12), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ox = 12; oy = 4
    # Body (tapered)
    body = [(ox + 4, oy + ch - 4),
            (ox + cw - 4, oy + ch - 4),
            (ox + cw - 8, oy + 20),
            (ox + 8, oy + 20)]
    d.polygon(body, fill=C['wall'])
    d.polygon([(ox + cw // 2, oy + 20),
               (ox + cw - 8, oy + 20),
               (ox + cw - 4, oy + ch - 4),
               (ox + cw // 2, oy + ch - 4)], fill=C['wall_dk'])
    # Roof
    d.polygon([(ox + 4, oy + 22), (ox + cw - 4, oy + 22),
               (ox + cw // 2, oy + 6)], fill=C['roof'])
    d.polygon([(ox + cw // 2, oy + 6), (ox + cw - 4, oy + 22),
               (ox + cw // 2, oy + 22)], fill=C['roof_dk'])
    # Door
    d.rectangle([ox + cw // 2 - 4, oy + ch - 20, ox + cw // 2 + 4, oy + ch - 4],
                fill=C['wood_dk'])
    d.rectangle([ox + cw // 2 - 3, oy + ch - 19, ox + cw // 2 + 3, oy + ch - 5],
                fill=C['wood'])
    # Blades (cross)
    bcx = ox + cw // 2
    bcy = oy + 20
    for ang in (math.pi*0.25, math.pi*0.75, math.pi*1.25, math.pi*1.75):
        ex = bcx + math.cos(ang) * 18
        ey = bcy + math.sin(ang) * 18
        d.line([(bcx, bcy), (ex, ey)], fill=C['wood_dk'], width=2)
        # blade pane
        ang2 = ang + 0.55
        bx = bcx + math.cos(ang2) * 6
        by = bcy + math.sin(ang2) * 6
        d.polygon([(bcx, bcy), (ex, ey), (bx, by)], fill=C['wall'])
    d.ellipse([bcx-3, bcy-3, bcx+3, bcy+3], fill=C['wood_dk'])

    canvas.alpha_composite(layer, (px - 12, py - 12 - 2*TILE))


# ── Additional buildings ──────────────────────────────────────────────────

def draw_big_house_sprite(canvas, gx, gy):
    """3x3 large house: wider footprint, two windows per side, prominent roof."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*3, TILE*3
    layer = Image.new('RGBA', (w+10, h+18), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Wall
    wt = 16; wb = h - 2
    d.rectangle([5, wt, w-5, wb], fill=C['wall'])
    d.rectangle([w-8, wt, w-5, wb], fill=C['wall_dk'])
    d.rectangle([5, wb-3, w-5, wb], fill=C['wood_dk'])
    # Roof — wider, steeper
    roof_color = random.choice([C['roof'], C['roof_blue']])
    roof_dk = C['roof_dk'] if roof_color == C['roof'] else C['roof_blue_dk']
    d.polygon([(0, wt+3), (w//2, 2), (w, wt+3)], fill=roof_color)
    d.polygon([(w//2, 2), (w, wt+3), (w//2, wt+3)], fill=roof_dk)
    d.line([(0, wt+3), (w//2, 2), (w, wt+3)], fill=C['wood_dk'])
    # Roof shingles hint
    for k in range(8, w, 8):
        d.line([(k, wt+3), (k+3, wt+1)], fill=roof_dk)
    # Double door (center)
    dw, dh = 12, 18
    d.rectangle([w//2 - dw//2, wb - dh, w//2 + dw//2, wb], fill=C['wood'])
    d.line([(w//2, wb - dh), (w//2, wb)], fill=C['wood_dk'])
    d.point((w//2 - 3, wb - dh//2), fill=C['flower_y'])
    d.point((w//2 + 3, wb - dh//2), fill=C['flower_y'])
    # Two windows on each side
    for wx in (10, w - 18):
        d.rectangle([wx, wt + 7, wx + 8, wt + 15], fill=C['water_lt'])
        d.rectangle([wx, wt + 7, wx + 8, wt + 15], outline=C['wood_dk'])
        d.line([(wx + 4, wt + 7), (wx + 4, wt + 15)], fill=C['wood_dk'])
        d.line([(wx, wt + 11), (wx + 8, wt + 11)], fill=C['wood_dk'])
    # Chimney
    d.rectangle([w-16, 5, w-12, wt+2], fill=C['stone_dk'])
    d.rectangle([w-17, 4, w-11, 7], fill=C['stone'])
    canvas.alpha_composite(layer, (px-5, py-18))


def draw_church_sprite(canvas, gx, gy):
    """3x4 church with bell tower / steeple."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*3, TILE*4
    layer = Image.new('RGBA', (w+10, h+30), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Main body
    body_top = 30
    body_bot = h - 2
    d.rectangle([5, body_top, w-5, body_bot], fill=C['wall'])
    d.rectangle([w-8, body_top, w-5, body_bot], fill=C['wall_dk'])
    # Steeple base (taller section on left)
    st_w = 18
    st_top = 4
    st_bot = body_bot
    d.rectangle([6, st_top + 16, 6 + st_w, st_bot], fill=C['wall'])
    d.rectangle([6 + st_w - 3, st_top + 16, 6 + st_w, st_bot], fill=C['wall_dk'])
    # Steeple roof (sharp spire)
    d.polygon([(6, st_top + 18), (6 + st_w, st_top + 18),
               (6 + st_w//2, st_top - 4)], fill=C['roof'])
    d.polygon([(6 + st_w//2, st_top - 4),
               (6 + st_w, st_top + 18),
               (6 + st_w//2, st_top + 18)], fill=C['roof_dk'])
    # Cross on steeple
    cx_ = 6 + st_w//2
    d.line([(cx_, st_top - 12), (cx_, st_top - 4)], fill=C['flower_y'], width=1)
    d.line([(cx_ - 3, st_top - 9), (cx_ + 3, st_top - 9)], fill=C['flower_y'], width=1)
    # Bell window in steeple
    d.rectangle([6 + 6, st_top + 20, 6 + st_w - 6, st_top + 28], fill=C['wood_dk'])
    # Main roof (over the body section to right of steeple)
    body_left = 6 + st_w + 2
    d.polygon([(body_left - 2, body_top), (w-5, body_top),
               ((body_left + w-5)//2, body_top - 14)], fill=C['roof'])
    d.polygon([((body_left + w-5)//2, body_top - 14),
               (w-5, body_top),
               ((body_left + w-5)//2, body_top)], fill=C['roof_dk'])
    # Big arched window in main body
    cx_arch = (body_left + w-5)//2
    d.rounded_rectangle([cx_arch - 8, body_top + 8, cx_arch + 8, body_top + 24],
                        radius=6, fill=C['water_lt'])
    d.rounded_rectangle([cx_arch - 8, body_top + 8, cx_arch + 8, body_top + 24],
                        radius=6, outline=C['wood_dk'])
    d.line([(cx_arch, body_top + 10), (cx_arch, body_top + 24)], fill=C['wood_dk'])
    # Door at base of steeple
    dw_ = 10; dh_ = 16
    d.rounded_rectangle([6 + st_w//2 - dw_//2, body_bot - dh_,
                          6 + st_w//2 + dw_//2, body_bot],
                         radius=4, fill=C['wood_dk'])
    d.rounded_rectangle([6 + st_w//2 - dw_//2 + 1, body_bot - dh_ + 1,
                          6 + st_w//2 + dw_//2 - 1, body_bot - 1],
                         radius=3, fill=C['wood'])
    canvas.alpha_composite(layer, (px-5, py-30))


def draw_barn_sprite(canvas, gx, gy):
    """3x2 wide barn with hayloft."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*3, TILE*2
    layer = Image.new('RGBA', (w+10, h+18), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    wt = 12; wb = h - 2
    # Red wood walls
    d.rectangle([5, wt, w-5, wb], fill=C['roof'])
    d.rectangle([w-8, wt, w-5, wb], fill=C['roof_dk'])
    d.rectangle([5, wb-3, w-5, wb], fill=C['wood_dk'])
    # Plank lines on walls
    for k in range(10, w-5, 6):
        d.line([(k, wt), (k, wb)], fill=C['roof_dk'])
    # White accents (corners + door frame)
    d.rectangle([5, wt, 8, wb], fill=C['wall'])
    d.rectangle([w-8, wt, w-5, wb], fill=C['wall'])
    # Gambrel-style roof: two slopes
    d.polygon([(2, wt+3), (w//2, 4), (w-2, wt+3)], fill=C['wood_dk'])
    d.polygon([(2, wt+3), (10, wt-4), (w-10, wt-4), (w-2, wt+3)], fill=C['wood'])
    # Hayloft opening
    d.rectangle([w//2 - 5, wt - 2, w//2 + 5, wt + 5], fill=C['wood_dk'])
    # Big double doors
    dw, dh = 18, 22
    d.rectangle([w//2 - dw//2, wb - dh, w//2 + dw//2, wb], fill=C['wood'])
    d.line([(w//2, wb - dh), (w//2, wb)], fill=C['wood_dk'], width=2)
    # X brace on doors
    d.line([(w//2 - dw//2 + 2, wb - dh + 2),
            (w//2 - 2, wb - 2)], fill=C['wood_lt'])
    d.line([(w//2 + 2, wb - dh + 2),
            (w//2 + dw//2 - 2, wb - 2)], fill=C['wood_lt'])
    canvas.alpha_composite(layer, (px-5, py-18))


def draw_watchtower_sprite(canvas, gx, gy):
    """1x3 tall tower."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE, TILE*3
    layer = Image.new('RGBA', (w+12, h+18), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ox = 6
    # Stone tower body
    d.rectangle([ox+2, 14, ox+w-2, h-2], fill=C['stone'])
    d.rectangle([ox+w-5, 14, ox+w-2, h-2], fill=C['stone_dk'])
    # Stone block lines
    for k in range(20, h-2, 7):
        d.line([(ox+2, k), (ox+w-2, k)], fill=C['stone_dk'])
    # Crenellations
    for ddx in range(2, w-2, 4):
        d.rectangle([ox+ddx, 8, ox+ddx+2, 14], fill=C['stone'])
    # Door at base
    d.rounded_rectangle([ox+w//2-3, h-12, ox+w//2+3, h-2], radius=3, fill=C['wood_dk'])
    d.rounded_rectangle([ox+w//2-2, h-11, ox+w//2+2, h-3], radius=2, fill=C['wood'])
    # Small window halfway up
    d.rectangle([ox+w//2-2, h//2-4, ox+w//2+2, h//2], fill=C['water_lt'])
    d.rectangle([ox+w//2-2, h//2-4, ox+w//2+2, h//2], outline=C['wood_dk'])
    # Flag on top
    d.line([(ox+w//2, 0), (ox+w//2, 8)], fill=C['wood_dk'])
    d.polygon([(ox+w//2, 0), (ox+w//2 + 6, 3), (ox+w//2, 6)], fill=C['roof'])
    canvas.alpha_composite(layer, (px-6, py-18))


def draw_well_sprite(canvas, gx, gy):
    """Stone well, fits in one tile."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE+8), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2; cy = TILE - 6
    # Well base (stone ring)
    d.ellipse([cx-7, cy-3, cx+7, cy+5], fill=C['stone_dk'])
    d.ellipse([cx-6, cy-3, cx+6, cy+3], fill=C['stone'])
    d.ellipse([cx-5, cy-2, cx+5, cy+2], fill=C['water_dk'])
    # Posts
    d.rectangle([cx-7, cy-12, cx-5, cy-2], fill=C['wood_dk'])
    d.rectangle([cx+5, cy-12, cx+7, cy-2], fill=C['wood_dk'])
    # Roof crossbeam
    d.rectangle([cx-8, cy-14, cx+8, cy-11], fill=C['wood'])
    # Tiny pointed roof
    d.polygon([(cx-9, cy-12), (cx+9, cy-12), (cx, cy-18)], fill=C['roof_dk'])
    # Rope
    d.line([(cx, cy-11), (cx, cy-3)], fill=C['wood_lt'])
    canvas.alpha_composite(layer, (px, py - 8))


def draw_lamp_post_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2
    # Post
    d.rectangle([cx-1, 5, cx+1, TILE-2], fill=C['wood_dk'])
    # Lantern (with glow)
    d.rectangle([cx-3, 2, cx+3, 6], fill=C['wood_dk'])
    d.rectangle([cx-2, 3, cx+2, 5], fill=C['flower_y'])
    d.point((cx, 4), fill=(255, 255, 200))
    canvas.alpha_composite(layer, (px, py))


def draw_sign_post_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2
    d.rectangle([cx-1, 8, cx, TILE-2], fill=C['wood_dk'])
    # Sign board
    d.rectangle([cx-5, 5, cx+5, 11], fill=C['wood'])
    d.rectangle([cx-5, 5, cx+5, 11], outline=C['wood_dk'])
    # text lines (decorative)
    d.line([(cx-3, 7), (cx+2, 7)], fill=C['wood_dk'])
    d.line([(cx-3, 9), (cx+1, 9)], fill=C['wood_dk'])
    canvas.alpha_composite(layer, (px, py))


def draw_hay_bale_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rectangle([3, 7, TILE-3, TILE-3], fill=C['crop_y_dk'])
    d.rectangle([3, 7, TILE-3, TILE-3], outline=C['wood_dk'])
    # Hay texture lines
    for k in range(5, TILE-4, 3):
        d.line([(4, k), (TILE-4, k)], fill=C['crop_y'])
    # String binding
    d.line([(TILE//3, 7), (TILE//3, TILE-3)], fill=C['wood_dk'])
    d.line([(2*TILE//3, 7), (2*TILE//3, TILE-3)], fill=C['wood_dk'])
    canvas.alpha_composite(layer, (px, py))


def draw_barrel_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2; cy = TILE - 6
    d.ellipse([cx-4, cy-7, cx+4, cy+3], fill=C['wood_dk'])
    d.rectangle([cx-4, cy-5, cx+4, cy+1], fill=C['wood'])
    d.ellipse([cx-4, cy-7, cx+4, cy-3], fill=C['wood_lt'])
    # Bands
    d.line([(cx-4, cy-3), (cx+4, cy-3)], fill=C['wood_dk'])
    d.line([(cx-4, cy+1), (cx+4, cy+1)], fill=C['wood_dk'])
    canvas.alpha_composite(layer, (px, py))


def draw_cart_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE+4, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Cart body
    d.rectangle([3, 6, TILE+1, TILE-4], fill=C['wood'])
    d.rectangle([3, 6, TILE+1, 8], fill=C['wood_lt'])
    # Wheels
    d.ellipse([2, TILE-7, 8, TILE-1], fill=C['wood_dk'])
    d.ellipse([3, TILE-6, 7, TILE-2], fill=C['wood'])
    d.ellipse([TILE-5, TILE-7, TILE+1, TILE-1], fill=C['wood_dk'])
    d.ellipse([TILE-4, TILE-6, TILE, TILE-2], fill=C['wood'])
    # Hay on top
    d.rectangle([4, 4, TILE, 7], fill=C['crop_y'])
    canvas.alpha_composite(layer, (px-2, py))


def draw_statue_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2
    # Pedestal
    d.rectangle([cx-5, TILE-4, cx+5, TILE+2], fill=C['stone_dk'])
    d.rectangle([cx-4, TILE-5, cx+4, TILE-3], fill=C['stone'])
    # Figure
    d.rectangle([cx-2, 4, cx+2, TILE-5], fill=C['stone_lt'])
    d.ellipse([cx-3, 1, cx+3, 7], fill=C['stone_lt'])
    # Subtle shading
    d.rectangle([cx+1, 4, cx+2, TILE-5], fill=C['stone'])
    canvas.alpha_composite(layer, (px, py-4))


def draw_grave_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2; cy = TILE - 5
    # Stone arch
    d.rounded_rectangle([cx-4, cy-7, cx+4, cy+2], radius=3, fill=C['stone_dk'])
    d.rounded_rectangle([cx-3, cy-6, cx+3, cy+1], radius=2, fill=C['stone'])
    # Cross or RIP mark
    d.point((cx, cy-3), fill=C['stone_dk'])
    d.point((cx, cy-2), fill=C['stone_dk'])
    d.point((cx-1, cy-3), fill=C['stone_dk'])
    d.point((cx+1, cy-3), fill=C['stone_dk'])
    canvas.alpha_composite(layer, (px, py))


# ── Discovery features (surprises hidden across the world) ────────────────

def draw_stone_circle_sprite(canvas, gx, gy):
    """3x3 mystical stone circle: 5 standing stones around a fire pit."""
    px, py = gx * TILE, gy * TILE
    cw = ch = TILE * 3
    layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = cw // 2, ch // 2
    # Dirt patch
    d.ellipse([4, 4, cw-4, ch-4], fill=C['farm_dirt'])
    d.ellipse([8, 8, cw-8, ch-8], fill=C['farm_dirt_dk'])
    # Fire pit in center
    d.ellipse([cx-4, cy-3, cx+4, cy+3], fill=(40, 30, 20))
    d.ellipse([cx-3, cy-2, cx+3, cy+2], fill=(230, 100, 30))
    d.ellipse([cx-1, cy-1, cx+1, cy+1], fill=(255, 200, 80))
    # 5 standing stones at radius
    r = cw * 0.36
    for i in range(5):
        ang = i * 2 * math.pi / 5 - math.pi/2
        sx = int(cx + math.cos(ang) * r)
        sy = int(cy + math.sin(ang) * r)
        d.rectangle([sx-3, sy-7, sx+3, sy+2], fill=C['stone_dk'])
        d.rectangle([sx-2, sy-6, sx+2, sy+1], fill=C['stone'])
        d.point((sx-1, sy-5), fill=C['stone_lt'])
    canvas.alpha_composite(layer, (px, py))


def draw_cave_sprite(canvas, gx, gy):
    """Cave mouth — black hole in stone."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE // 2, TILE - 4
    # Rocky surround
    d.ellipse([1, cy-12, TILE-1, cy+3], fill=C['mountain_dk'])
    d.ellipse([2, cy-10, TILE-2, cy+2], fill=C['mountain'])
    # Black hole (arched)
    d.chord([cx-6, cy-10, cx+6, cy+2], 180, 360, fill=(10, 8, 10))
    d.rectangle([cx-5, cy-3, cx+5, cy+2], fill=(10, 8, 10))
    # Small stones at entrance
    d.point((cx-7, cy+1), fill=C['stone_dk'])
    d.point((cx+7, cy+1), fill=C['stone_dk'])
    canvas.alpha_composite(layer, (px, py))


def draw_treasure_chest_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE // 2, TILE - 4
    # Body
    d.rectangle([cx-5, cy-6, cx+5, cy+2], fill=C['wood'])
    d.rectangle([cx-5, cy-6, cx+5, cy-4], fill=C['wood_lt'])
    # Bands
    d.line([(cx-5, cy-3), (cx+5, cy-3)], fill=C['wood_dk'])
    d.line([(cx-5, cy+1), (cx+5, cy+1)], fill=C['wood_dk'])
    d.line([(cx, cy-6), (cx, cy+2)], fill=C['wood_dk'])
    # Lock
    d.rectangle([cx-1, cy-2, cx+1, cy], fill=C['flower_y'])
    # Sparkle (glowing chest)
    d.point((cx+6, cy-7), fill=(255, 255, 200))
    d.point((cx-6, cy-5), fill=(255, 255, 200))
    canvas.alpha_composite(layer, (px, py))


def draw_ruined_tower_sprite(canvas, gx, gy):
    """1x2 broken stone tower."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE, TILE*2
    layer = Image.new('RGBA', (w, h+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Broken stone body
    d.rectangle([3, 10, w-3, h-2], fill=C['stone'])
    d.rectangle([w-5, 10, w-3, h-2], fill=C['stone_dk'])
    # Stone block lines
    for k in range(16, h-2, 6):
        d.line([(3, k), (w-3, k)], fill=C['stone_dk'])
    # Broken top — jagged edge
    d.polygon([(3, 10), (5, 14), (7, 8), (9, 12),
               (11, 6), (13, 10), (15, 4), (w-3, 12)], fill=(0, 0, 0, 0))
    d.line([(3, 10), (5, 14)], fill=C['stone_dk'])
    d.line([(5, 14), (7, 8)], fill=C['stone_dk'])
    d.line([(7, 8), (9, 12)], fill=C['stone_dk'])
    d.line([(9, 12), (11, 6)], fill=C['stone_dk'])
    d.line([(11, 6), (13, 10)], fill=C['stone_dk'])
    d.line([(13, 10), (15, 4)], fill=C['stone_dk'])
    d.line([(15, 4), (w-3, 12)], fill=C['stone_dk'])
    # Door
    d.rounded_rectangle([w//2-3, h-12, w//2+3, h-2], radius=3, fill=(10, 8, 10))
    # Vines / cracks
    d.line([(w-5, 18), (w-3, h-4)], fill=C['tree_dk'])
    d.point((4, 22), fill=C['tree'])
    canvas.alpha_composite(layer, (px, py-4))


def draw_witch_hut_sprite(canvas, gx, gy):
    """2x2 spooky cottage with green roof and mushroom ring."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*2
    layer = Image.new('RGBA', (w+8, h+12), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Wall (dark wood)
    wt = 14; wb = h - 2
    d.rectangle([4, wt, w-4, wb], fill=C['wood_dk'])
    d.rectangle([w-7, wt, w-4, wb], fill=(40, 25, 15))
    # Crooked green roof
    d.polygon([(2, wt+2), (w//2-2, 0), (w//2+5, 4), (w-2, wt+2)],
              fill=(40, 80, 35))
    d.polygon([(w//2-2, 0), (w//2+5, 4), (w-2, wt+2), (w//2-2, wt+2)],
              fill=(25, 55, 25))
    # Glowing window
    d.rectangle([10, wt+4, 16, wt+10], fill=(180, 220, 80))
    d.rectangle([10, wt+4, 16, wt+10], outline=C['wood_dk'])
    d.line([(13, wt+4), (13, wt+10)], fill=C['wood_dk'])
    d.line([(10, wt+7), (16, wt+7)], fill=C['wood_dk'])
    # Door
    d.rectangle([w-14, wb-12, w-8, wb], fill=(20, 15, 10))
    d.point((w-9, wb-6), fill=C['flower_y'])
    # Crooked chimney with smoke
    d.rectangle([w-12, 4, w-9, wt+1], fill=C['stone_dk'])
    d.ellipse([w-16, -2, w-8, 6], fill=(180, 175, 170, 180))
    d.ellipse([w-12, -6, w-4, 2], fill=(200, 195, 190, 150))
    canvas.alpha_composite(layer, (px-4, py-12))


def draw_magic_circle_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE // 2, TILE // 2
    # Glow base
    d.ellipse([cx-7, cy-5, cx+7, cy+5], fill=(140, 100, 220, 70))
    # Outer circle
    d.ellipse([cx-6, cy-4, cx+6, cy+4], outline=(180, 140, 240), width=1)
    # Inner triangle (mystic)
    d.polygon([(cx, cy-3), (cx-3, cy+2), (cx+3, cy+2)],
              outline=(220, 180, 255))
    # Center sparkle
    d.point((cx, cy), fill=(255, 240, 255))
    d.point((cx-1, cy-1), fill=(255, 240, 255))
    canvas.alpha_composite(layer, (px, py))


def draw_dock_sprite(canvas, gx, gy):
    """1x2 wooden pier extending downward into water."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE, TILE*2
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Deck
    d.rectangle([3, 2, w-3, h-2], fill=C['wood'])
    # Planks
    for k in range(5, h-2, 3):
        d.line([(3, k), (w-3, k)], fill=C['wood_dk'])
    # Edges
    d.line([(3, 2), (3, h-2)], fill=C['wood_dk'])
    d.line([(w-3, 2), (w-3, h-2)], fill=C['wood_dk'])
    # Posts visible at the end
    d.rectangle([2, h-4, 4, h-1], fill=C['wood_dk'])
    d.rectangle([w-4, h-4, w-2, h-1], fill=C['wood_dk'])
    canvas.alpha_composite(layer, (px, py))


def draw_ancient_gate_sprite(canvas, gx, gy):
    """2x1 stone archway leading to nowhere."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE
    layer = Image.new('RGBA', (w, h+8), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Two pillars
    d.rectangle([3, 4, 9, h-2], fill=C['stone'])
    d.rectangle([3, 4, 5, h-2], fill=C['stone_lt'])
    d.rectangle([w-10, 4, w-3, h-2], fill=C['stone'])
    d.rectangle([w-5, 4, w-3, h-2], fill=C['stone_dk'])
    # Lintel
    d.rectangle([1, 0, w-1, 6], fill=C['stone'])
    d.rectangle([1, 4, w-1, 6], fill=C['stone_dk'])
    # Carved rune on lintel
    d.point((w//2, 2), fill=C['flower_y'])
    d.point((w//2-2, 3), fill=C['flower_y'])
    d.point((w//2+2, 3), fill=C['flower_y'])
    canvas.alpha_composite(layer, (px, py))


def draw_crystal_sprite(canvas, gx, gy):
    """Crystalline gem cluster — mineral discovery in mountains."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE // 2, TILE - 4
    color = random.choice([(140, 80, 220), (80, 200, 200), (220, 100, 160)])
    light = tuple(min(255, c+60) for c in color)
    # Three pointed crystals
    d.polygon([(cx, cy-8), (cx-3, cy), (cx+3, cy)], fill=color)
    d.polygon([(cx, cy-8), (cx, cy), (cx+3, cy)], fill=light)
    d.polygon([(cx-5, cy-5), (cx-7, cy+1), (cx-2, cy+1)], fill=color)
    d.polygon([(cx-5, cy-5), (cx-3, cy+1), (cx-2, cy+1)], fill=light)
    d.polygon([(cx+5, cy-4), (cx+3, cy+1), (cx+8, cy+1)], fill=color)
    # Sparkle
    d.point((cx+1, cy-6), fill=(255, 255, 255))
    canvas.alpha_composite(layer, (px, py))


def draw_campfire_sprite(canvas, gx, gy):
    """Abandoned campsite — stones around a smouldering fire."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE // 2, TILE - 5
    # Dirt patch under
    d.ellipse([cx-6, cy-3, cx+6, cy+3], fill=C['farm_dirt_dk'])
    # Ring of stones
    for ang_i in range(7):
        ang = ang_i * math.pi * 2 / 7
        sx = int(cx + math.cos(ang) * 5)
        sy = int(cy + math.sin(ang) * 3)
        d.ellipse([sx-1, sy-1, sx+1, sy+1], fill=C['stone_dk'])
    # Fire/logs in center
    d.line([(cx-2, cy), (cx+2, cy+1)], fill=C['wood_dk'])
    d.line([(cx-1, cy-1), (cx+2, cy)], fill=C['wood_dk'])
    d.ellipse([cx-2, cy-3, cx+2, cy], fill=(230, 100, 30))
    d.point((cx, cy-2), fill=(255, 220, 80))
    canvas.alpha_composite(layer, (px, py))


def draw_obelisk_sprite(canvas, gx, gy):
    """Ancient stone obelisk pointing up."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE // 2
    # Pedestal
    d.rectangle([cx-4, TILE-4, cx+4, TILE+2], fill=C['stone_dk'])
    d.rectangle([cx-3, TILE-3, cx+3, TILE], fill=C['stone'])
    # Obelisk shaft
    d.polygon([(cx-2, 2), (cx+2, 2), (cx+1, TILE-4), (cx-1, TILE-4)],
              fill=C['stone'])
    d.polygon([(cx-2, 2), (cx, 2), (cx-1, TILE-4)], fill=C['stone_lt'])
    # Pyramidal tip
    d.polygon([(cx-2, 2), (cx+2, 2), (cx, -2)], fill=C['stone_dk'])
    # Glyphs
    d.point((cx, 6), fill=C['stone_dk'])
    d.point((cx, 10), fill=C['stone_dk'])
    d.point((cx, 14), fill=C['stone_dk'])
    canvas.alpha_composite(layer, (px, py-4))


# ── New building sprites ──────────────────────────────────────────────────

def draw_lighthouse_sprite(canvas, gx, gy):
    """2x4 tall lighthouse with light at top."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*4
    layer = Image.new('RGBA', (w, h+8), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Stone base
    d.rectangle([4, h-12, w-4, h-2], fill=C['stone_dk'])
    d.rectangle([5, h-11, w-5, h-3], fill=C['stone'])
    # Tower body (tapered, red & white striped)
    body_top = 12
    body_bot = h-12
    d.polygon([(7, body_bot), (w-7, body_bot),
               (w-10, body_top), (10, body_top)], fill=C['wall'])
    # Stripes (red bands)
    stripe_n = 4
    for i in range(stripe_n):
        if i % 2 == 1:
            sy = body_top + (body_bot - body_top) * i // stripe_n
            sy2 = body_top + (body_bot - body_top) * (i+1) // stripe_n
            # Width tapers
            t1 = i / stripe_n; t2 = (i+1) / stripe_n
            lx1 = 10 + (7-10) * (1-t1); rx1 = w-10 + (w-7-(w-10)) * (1-t1)
            lx2 = 10 + (7-10) * (1-t2); rx2 = w-10 + (w-7-(w-10)) * (1-t2)
            d.polygon([(lx1, sy), (rx1, sy), (rx2, sy2), (lx2, sy2)],
                      fill=C['roof'])
    # Lantern room
    d.rectangle([8, 4, w-8, body_top], fill=C['wall_dk'])
    d.rectangle([9, 5, w-9, body_top-1], fill=C['flower_y'])
    # Glowing light beam (small)
    d.ellipse([6, 2, w-6, 9], fill=(255, 240, 150, 120))
    # Cap
    d.polygon([(6, 4), (w-6, 4), (w//2, 0)], fill=C['roof_dk'])
    # Door at base
    d.rounded_rectangle([w//2-3, h-9, w//2+3, h-3], radius=2, fill=C['wood_dk'])
    canvas.alpha_composite(layer, (px, py-8))


def draw_mage_tower_sprite(canvas, gx, gy):
    """2x4 mage tower — tall slim with pointed conical roof."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*4
    layer = Image.new('RGBA', (w+10, h+12), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Tower body
    d.rectangle([5, 24, w-5, h-2], fill=C['stone'])
    d.rectangle([w-8, 24, w-5, h-2], fill=C['stone_dk'])
    # Stone block lines
    for k in range(28, h-2, 6):
        d.line([(5, k), (w-5, k)], fill=C['stone_dk'])
    # Glowing windows
    for k in [38, 56]:
        d.rectangle([w//2-3, k, w//2+3, k+4], fill=(140, 100, 220))
        d.rectangle([w//2-3, k, w//2+3, k+4], outline=C['stone_dk'])
        d.point((w//2, k+1), fill=(220, 200, 255))
    # Wide top platform
    d.rectangle([2, 20, w-2, 26], fill=C['stone_dk'])
    d.rectangle([3, 20, w-3, 23], fill=C['stone'])
    # Pointed cone roof (deep purple)
    d.polygon([(3, 22), (w-3, 22), (w//2, -4)], fill=(75, 50, 130))
    d.polygon([(w//2, -4), (w-3, 22), (w//2, 22)], fill=(50, 30, 90))
    # Star/orb on top
    d.point((w//2, -5), fill=(255, 255, 180))
    d.point((w//2-1, -4), fill=(255, 255, 180))
    d.point((w//2+1, -4), fill=(255, 255, 180))
    # Door
    d.rounded_rectangle([w//2-4, h-12, w//2+4, h-2], radius=4, fill=C['wood_dk'])
    d.rounded_rectangle([w//2-3, h-11, w//2+3, h-3], radius=3, fill=C['wood'])
    canvas.alpha_composite(layer, (px, py-12))


def draw_mine_entrance_sprite(canvas, gx, gy):
    """Wooden mine frame on a mountain face."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE, TILE
    layer = Image.new('RGBA', (w, h+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = w//2, h - 4
    # Stone surround
    d.ellipse([1, cy-12, w-1, cy+3], fill=C['mountain_dk'])
    d.ellipse([2, cy-10, w-2, cy+2], fill=C['mountain'])
    # Dark mine hole
    d.rectangle([cx-5, cy-9, cx+5, cy+1], fill=(8, 6, 8))
    # Wooden support frame (Π shape)
    d.rectangle([cx-7, cy-9, cx-5, cy+1], fill=C['wood'])
    d.rectangle([cx+5, cy-9, cx+7, cy+1], fill=C['wood'])
    d.rectangle([cx-7, cy-11, cx+7, cy-8], fill=C['wood'])
    d.line([(cx-7, cy-11), (cx+7, cy-11)], fill=C['wood_dk'])
    # Mining cart track (rails sticking out)
    d.line([(cx-3, cy+2), (cx-3, cy+5)], fill=C['stone_dk'])
    d.line([(cx+3, cy+2), (cx+3, cy+5)], fill=C['stone_dk'])
    canvas.alpha_composite(layer, (px, py-4))


def draw_boat_sprite(canvas, gx, gy):
    """Fishing boat (1x1)."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 6
    # Hull (curved-ish)
    d.polygon([(cx-7, cy), (cx-5, cy+4), (cx+5, cy+4), (cx+7, cy)],
              fill=C['wood'])
    d.polygon([(cx-5, cy+2), (cx-4, cy+4), (cx+4, cy+4), (cx+5, cy+2)],
              fill=C['wood_dk'])
    # Mast
    d.rectangle([cx, cy-8, cx+1, cy], fill=C['wood_dk'])
    # Sail
    d.polygon([(cx, cy-7), (cx+5, cy-2), (cx, cy-2)], fill=C['wall'])
    # Flag
    d.line([(cx, cy-8), (cx+3, cy-8)], fill=C['flower_r'])
    canvas.alpha_composite(layer, (px, py))


def draw_pagoda_sprite(canvas, gx, gy):
    """2x3 Asian pagoda — tiered roofs."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*3
    layer = Image.new('RGBA', (w+12, h+18), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Bottom level
    d.rectangle([6, h-18, w-6, h-2], fill=C['wood'])
    d.rectangle([6, h-18, w-6, h-15], fill=C['wood_lt'])
    # Bottom roof (tier 1)
    d.polygon([(2, h-15), (w-2, h-15), (w-6, h-18), (6, h-18)], fill=C['roof'])
    d.polygon([(2, h-15), (4, h-13), (w-4, h-13), (w-2, h-15)], fill=C['roof_dk'])
    # Mid level
    d.rectangle([8, h-32, w-8, h-19], fill=C['wood'])
    # Mid roof (tier 2)
    d.polygon([(4, h-32), (w-4, h-32), (w-8, h-34), (8, h-34)], fill=C['roof'])
    d.polygon([(4, h-32), (6, h-30), (w-6, h-30), (w-4, h-32)], fill=C['roof_dk'])
    # Top level
    d.rectangle([10, h-44, w-10, h-35], fill=C['wood'])
    # Top roof
    d.polygon([(6, h-44), (w-6, h-44), (w//2, h-52)], fill=C['roof'])
    d.polygon([(w//2, h-52), (w-6, h-44), (w//2, h-44)], fill=C['roof_dk'])
    # Spire on top
    d.line([(w//2, h-52), (w//2, h-60)], fill=C['flower_y'])
    d.ellipse([w//2-2, h-62, w//2+2, h-58], fill=C['flower_y'])
    # Doors and lanterns
    d.rectangle([w//2-3, h-12, w//2+3, h-2], fill=C['wood_dk'])
    # Red lanterns on tier 1 sides
    d.ellipse([3, h-15, 8, h-11], fill=C['flower_r'])
    d.ellipse([w-8, h-15, w-3, h-11], fill=C['flower_r'])
    canvas.alpha_composite(layer, (px-6, py-18))


def draw_log_cabin_sprite(canvas, gx, gy):
    """2x2 rustic log cabin with horizontal log walls."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*2
    layer = Image.new('RGBA', (w+8, h+14), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    wt = 14; wb = h - 2
    # Wall (logs — horizontal stripes)
    d.rectangle([4, wt, w-4, wb], fill=C['wood_lt'])
    for k in range(wt+2, wb, 4):
        d.line([(4, k), (w-4, k)], fill=C['wood_dk'])
    # Log ends visible at corners
    for cx_ in (4, w-5):
        for k in range(wt+1, wb-1, 4):
            d.ellipse([cx_-1, k, cx_+1, k+2], fill=C['wood'])
    # Foundation stones
    d.rectangle([4, wb-3, w-4, wb], fill=C['stone_dk'])
    # Roof (shingled)
    d.polygon([(0, wt+3), (w//2, 2), (w, wt+3)], fill=C['wood_dk'])
    d.polygon([(2, wt+3), (w//2, 4), (w-2, wt+3)], fill=C['wood'])
    # Roof shingle lines
    for k in range(6, wt+3, 3):
        d.line([(w//2 - (k-2), k), (w//2 + (k-2), k)], fill=C['wood_dk'])
    # Door
    d.rectangle([w//2-3, wb-12, w//2+3, wb], fill=C['wood_dk'])
    # Window
    d.rectangle([7, wt+5, 13, wt+10], fill=C['water_lt'])
    d.rectangle([7, wt+5, 13, wt+10], outline=C['wood_dk'])
    # Chimney with smoke
    d.rectangle([w-13, 4, w-10, wt+1], fill=C['stone_dk'])
    d.ellipse([w-16, -2, w-9, 5], fill=(220, 220, 220, 180))
    canvas.alpha_composite(layer, (px-4, py-14))


def draw_tent_sprite(canvas, gx, gy):
    """Triangular caravan/camp tent (1x1)."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2
    color = random.choice([C['roof'], C['roof_blue'], (200, 100, 160)])
    color_dk = tuple(max(0, c-50) for c in color)
    # Tent body (triangle)
    d.polygon([(cx, 2), (3, TILE-3), (TILE-3, TILE-3)], fill=color)
    d.polygon([(cx, 2), (TILE-3, TILE-3), (cx, TILE-3)], fill=color_dk)
    # Pole / flag on top
    d.line([(cx, 0), (cx, 4)], fill=C['wood_dk'])
    d.polygon([(cx, 0), (cx+4, 1), (cx, 2)], fill=C['flower_y'])
    # Entrance flap
    d.polygon([(cx-2, TILE-3), (cx+2, TILE-3), (cx, TILE-9)],
              fill=C['wood_dk'])
    canvas.alpha_composite(layer, (px, py))


# ── New discovery sprites ─────────────────────────────────────────────────

def draw_portal_sprite(canvas, gx, gy):
    """Magical glowing portal arch."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE+2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 4
    # Glow halo
    d.ellipse([cx-8, cy-12, cx+8, cy+4], fill=(140, 80, 220, 90))
    # Stone arch frame
    d.rounded_rectangle([cx-6, cy-11, cx+6, cy+3], radius=6, fill=C['stone_dk'])
    d.rounded_rectangle([cx-5, cy-10, cx+5, cy+2], radius=5, fill=C['stone'])
    # Swirling magic interior
    d.rounded_rectangle([cx-4, cy-9, cx+4, cy+1], radius=4, fill=(80, 50, 180))
    d.rounded_rectangle([cx-3, cy-8, cx+3, cy], radius=3, fill=(140, 90, 220))
    # Sparkles
    d.point((cx, cy-5), fill=(255, 240, 255))
    d.point((cx-2, cy-2), fill=(220, 200, 255))
    d.point((cx+1, cy-7), fill=(255, 255, 200))
    canvas.alpha_composite(layer, (px, py))


def draw_hot_spring_sprite(canvas, gx, gy):
    """Steaming hot pool."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE//2 + 2
    # Stone rim
    d.ellipse([cx-7, cy-3, cx+7, cy+5], fill=C['mountain_dk'])
    d.ellipse([cx-6, cy-2, cx+6, cy+4], fill=C['mountain'])
    # Glowing water
    d.ellipse([cx-5, cy-2, cx+5, cy+3], fill=(140, 220, 220))
    d.ellipse([cx-3, cy-1, cx+3, cy+2], fill=(190, 240, 240))
    # Steam rising
    d.ellipse([cx-3, cy-8, cx+3, cy-4], fill=(240, 240, 240, 180))
    d.ellipse([cx-2, cy-12, cx+2, cy-8], fill=(220, 220, 220, 120))
    canvas.alpha_composite(layer, (px, py))


def draw_giant_mushroom_sprite(canvas, gx, gy):
    """Oversized fairy-tale mushroom (red cap, white spots)."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 3
    # Stalk
    d.rectangle([cx-3, cy-4, cx+3, cy+2], fill=C['wall'])
    d.rectangle([cx+1, cy-4, cx+3, cy+2], fill=(210, 200, 180))
    # Cap (red dome)
    d.ellipse([cx-7, cy-12, cx+7, cy-2], fill=C['flower_r'])
    d.ellipse([cx-6, cy-12, cx+1, cy-5], fill=(255, 100, 100))
    # White spots
    d.ellipse([cx-4, cy-9, cx-2, cy-7], fill=C['flower_w'])
    d.ellipse([cx, cy-11, cx+2, cy-9], fill=C['flower_w'])
    d.ellipse([cx+3, cy-7, cx+5, cy-5], fill=C['flower_w'])
    canvas.alpha_composite(layer, (px, py-4))


def draw_hermit_cave_sprite(canvas, gx, gy):
    """Cave entrance with smoke (someone lives there)."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 4
    # Cave outer
    d.ellipse([1, cy-12, TILE-1, cy+3], fill=C['mountain_dk'])
    d.ellipse([2, cy-10, TILE-2, cy+2], fill=C['mountain'])
    # Black hole (smaller — door behind it)
    d.chord([cx-5, cy-9, cx+5, cy+2], 180, 360, fill=(10, 8, 10))
    d.rectangle([cx-4, cy-3, cx+4, cy+2], fill=(10, 8, 10))
    # Warm glow from inside
    d.point((cx, cy-2), fill=(255, 200, 80))
    d.point((cx-1, cy-1), fill=(255, 180, 60))
    # Smoke coming out top of cave
    d.ellipse([cx-3, cy-14, cx+3, cy-10], fill=(190, 190, 190, 180))
    d.ellipse([cx-2, cy-17, cx+2, cy-13], fill=(220, 220, 220, 130))
    canvas.alpha_composite(layer, (px, py))


def draw_old_mill_sprite(canvas, gx, gy):
    """2x2 water mill with paddle wheel on the side."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*2
    layer = Image.new('RGBA', (w+12, h+14), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Mill house
    wt = 12; wb = h - 2
    d.rectangle([8, wt, w-2, wb], fill=C['wall'])
    d.rectangle([w-5, wt, w-2, wb], fill=C['wall_dk'])
    d.rectangle([8, wb-3, w-2, wb], fill=C['wood_dk'])
    # Roof
    d.polygon([(6, wt+2), ((w+8)//2, 2), (w, wt+2)], fill=C['roof'])
    d.polygon([((w+8)//2, 2), (w, wt+2), ((w+8)//2, wt+2)], fill=C['roof_dk'])
    # Door
    d.rectangle([w//2+2, wb-12, w//2+8, wb], fill=C['wood_dk'])
    # Water wheel (on the left side)
    wx, wy = 6, h-10
    wr = 10
    d.ellipse([wx-wr, wy-wr, wx+wr, wy+wr], fill=C['wood_dk'])
    d.ellipse([wx-wr+2, wy-wr+2, wx+wr-2, wy+wr-2], fill=C['wood'])
    # Spokes
    for ang_i in range(8):
        ang = ang_i * math.pi / 4
        ex = wx + math.cos(ang) * (wr-2)
        ey = wy + math.sin(ang) * (wr-2)
        d.line([(wx, wy), (ex, ey)], fill=C['wood_dk'])
    # Hub
    d.ellipse([wx-2, wy-2, wx+2, wy+2], fill=C['wood_dk'])
    # Splashing water below
    d.line([(wx-wr, wy+wr+1), (wx+wr, wy+wr+1)], fill=C['water_lt'])
    canvas.alpha_composite(layer, (px-6, py-14))


def draw_monolith_sprite(canvas, gx, gy):
    """Single huge dark stone."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2
    # Dirt base
    d.ellipse([cx-7, TILE-4, cx+7, TILE+2], fill=C['farm_dirt_dk'])
    # Stone (tall, leaning slightly)
    d.polygon([(cx-4, TILE-3), (cx-3, 2), (cx+3, 0), (cx+5, TILE-3)],
              fill=(60, 55, 65))
    d.polygon([(cx-4, TILE-3), (cx-3, 2), (cx, 2), (cx, TILE-3)],
              fill=(40, 38, 50))
    # Glowing rune carved in
    d.point((cx, TILE//2), fill=(180, 200, 255))
    d.point((cx-1, TILE//2+1), fill=(180, 200, 255))
    d.point((cx+1, TILE//2-1), fill=(180, 200, 255))
    canvas.alpha_composite(layer, (px, py-4))


def draw_shipwreck_sprite(canvas, gx, gy):
    """Broken ship hull on beach or in shallow water."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE
    layer = Image.new('RGBA', (w, h+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = w//2
    # Broken hull
    d.polygon([(2, h-2), (8, h-10), (w-8, h-7), (w-2, h-2)], fill=C['wood'])
    d.polygon([(4, h-3), (10, h-9), (w-10, h-7), (w-4, h-3)], fill=C['wood_dk'])
    # Plank ribs
    for k in range(8, w-8, 4):
        d.line([(k, h-9), (k, h-2)], fill=C['wood_dk'])
    # Broken mast
    d.line([(cx-5, h-9), (cx-9, 4)], fill=C['wood_dk'])
    d.line([(cx+3, h-7), (cx+7, 2)], fill=C['wood_dk'])
    # Tattered sail
    d.polygon([(cx-9, 4), (cx-5, 8), (cx-9, 12)], fill=(230, 220, 200))
    canvas.alpha_composite(layer, (px, py))


def draw_sacred_tree_sprite(canvas, gx, gy):
    """Giant ancient tree (2x2 area, much bigger than normal)."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*2
    layer = Image.new('RGBA', (w+8, h+8), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = (w+8)//2, (h+8)//2 + 4
    # Massive trunk
    d.rectangle([cx-4, cy+2, cx+4, h+6], fill=C['wood'])
    d.rectangle([cx-4, cy+2, cx-2, h+6], fill=C['wood_lt'])
    d.rectangle([cx+2, cy+2, cx+4, h+6], fill=C['wood_dk'])
    # Roots (visible at base)
    d.line([(cx-6, h+6), (cx-4, cy+5)], fill=C['wood_dk'], width=2)
    d.line([(cx+6, h+6), (cx+4, cy+5)], fill=C['wood_dk'], width=2)
    # Huge canopy — multiple overlapping circles
    for ox, oy, r in [(-10, -8, 14), (8, -8, 14), (0, -16, 12),
                       (-14, 0, 11), (14, 0, 11), (0, 4, 14)]:
        d.ellipse([cx+ox-r, cy+oy-r, cx+ox+r, cy+oy+r], fill=C['tree_dk'])
    for ox, oy, r in [(-10, -8, 11), (8, -8, 11), (0, -16, 9),
                       (-14, 0, 8), (14, 0, 8), (0, 4, 11)]:
        d.ellipse([cx+ox-r, cy+oy-r, cx+ox+r, cy+oy+r], fill=C['tree'])
    # Highlight blobs
    d.ellipse([cx-13, cy-15, cx-3, cy-7], fill=C['tree_lt'])
    d.ellipse([cx+4, cy-13, cx+12, cy-5], fill=C['tree_lt'])
    # Sparkle dots (mystic glow)
    d.point((cx-2, cy-18), fill=(255, 255, 200))
    d.point((cx+5, cy-15), fill=(255, 255, 200))
    canvas.alpha_composite(layer, (px-4, py-4))


def draw_totem_sprite(canvas, gx, gy):
    """Carved wooden totem pole."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2
    # Pedestal
    d.rectangle([cx-3, TILE-2, cx+3, TILE+2], fill=C['farm_dirt_dk'])
    # Totem (3 stacked faces)
    colors = [C['roof'], C['roof_blue'], C['tree']]
    for i, col in enumerate(colors):
        y0 = 1 + i*7
        y1 = y0 + 6
        d.rectangle([cx-3, y0, cx+3, y1], fill=col)
        d.rectangle([cx-3, y0, cx-1, y1], fill=tuple(max(0, c-40) for c in col))
        # Face features
        d.point((cx-1, y0+2), fill=(0, 0, 0))
        d.point((cx+1, y0+2), fill=(0, 0, 0))
        d.line([(cx-1, y0+4), (cx+1, y0+4)], fill=C['wood_dk'])
    # Wings (top totem)
    d.polygon([(cx-3, 2), (cx-6, 1), (cx-3, 4)], fill=C['roof_dk'])
    d.polygon([(cx+3, 2), (cx+6, 1), (cx+3, 4)], fill=C['roof_dk'])
    canvas.alpha_composite(layer, (px, py-4))


def draw_beehive_sprite(canvas, gx, gy):
    """Yellow conical beehive with bees buzzing."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 4
    # Hive (stacked rings)
    for i, w_ in enumerate([4, 5, 6, 5]):
        y_ = cy - 8 + i*3
        d.ellipse([cx-w_, y_, cx+w_, y_+3], fill=(220, 180, 50))
        d.ellipse([cx-w_, y_, cx+w_, y_+1], fill=(245, 210, 90))
    # Entrance hole
    d.ellipse([cx-1, cy-2, cx+1, cy], fill=(50, 30, 0))
    # Bees flying
    d.point((cx-5, cy-12), fill=(0, 0, 0))
    d.point((cx-4, cy-12), fill=(245, 210, 90))
    d.point((cx+5, cy-10), fill=(0, 0, 0))
    d.point((cx+4, cy-10), fill=(245, 210, 90))
    canvas.alpha_composite(layer, (px, py))


def draw_stone_bridge_sprite(canvas, gx, gy):
    """1x1 small stone bridge sprite (decorative)."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 6
    # Arch
    d.chord([cx-7, cy-3, cx+7, cy+9], 180, 360, fill=C['stone'])
    d.chord([cx-7, cy-2, cx+7, cy+8], 180, 360, fill=C['stone_dk'])
    # Bridge surface
    d.rectangle([cx-7, cy-3, cx+7, cy], fill=C['stone'])
    # Surface stones
    d.line([(cx-3, cy-3), (cx-3, cy)], fill=C['stone_dk'])
    d.line([(cx+3, cy-3), (cx+3, cy)], fill=C['stone_dk'])
    canvas.alpha_composite(layer, (px, py))


# ── More secrets (round 2) ────────────────────────────────────────────────

def draw_mushroom_village_sprite(canvas, gx, gy):
    """2x2 cluster of giant mushroom houses."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*2
    layer = Image.new('RGBA', (w, h+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Three mushroom houses
    for cx, cy, sz, col in [(10, h-6, 7, C['flower_r']),
                              (24, h-4, 8, (180, 100, 200)),
                              (15, h-16, 6, (245, 220, 90))]:
        # Stalk
        d.rectangle([cx-2, cy-2, cx+2, cy+4], fill=C['wall'])
        # Door
        d.ellipse([cx-1, cy+1, cx+1, cy+4], fill=C['wood_dk'])
        # Cap
        d.ellipse([cx-sz, cy-sz-2, cx+sz, cy], fill=col)
        d.ellipse([cx-sz+1, cy-sz-2, cx, cy-1], fill=tuple(min(255, c+40) for c in col))
        # Spots
        d.ellipse([cx-sz+2, cy-sz, cx-sz+5, cy-sz+3], fill=C['flower_w'])
        d.ellipse([cx+1, cy-sz+2, cx+4, cy-sz+5], fill=C['flower_w'])
    canvas.alpha_composite(layer, (px, py))


def draw_crystal_pillar_sprite(canvas, gx, gy):
    """Towering crystal — 1x2."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE, TILE*2
    layer = Image.new('RGBA', (w, h+4), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = w//2; base_y = h - 4
    color = random.choice([(150, 90, 230), (90, 220, 220), (230, 120, 180), (130, 230, 130)])
    light = tuple(min(255, c+70) for c in color)
    # Big main pillar
    d.polygon([(cx, 4), (cx-5, base_y), (cx+5, base_y)], fill=color)
    # Light edge
    d.polygon([(cx, 4), (cx-5, base_y), (cx, base_y)], fill=light)
    # Smaller side crystals
    d.polygon([(cx-6, h-12), (cx-9, base_y), (cx-3, base_y)], fill=color)
    d.polygon([(cx-6, h-12), (cx-9, base_y), (cx-6, base_y)], fill=light)
    d.polygon([(cx+5, h-9), (cx+3, base_y), (cx+9, base_y)], fill=color)
    # Glow halo at top
    for r in range(8, 0, -2):
        d.ellipse([cx-r, 2-r//2, cx+r, 2+r//2],
                  outline=(color[0], color[1], color[2], 80))
    # Sparkle
    d.point((cx, 1), fill=(255, 255, 255))
    canvas.alpha_composite(layer, (px, py-4))


def draw_whale_bones_sprite(canvas, gx, gy):
    """2x1 whale skeleton on beach."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cy = h - 5
    # Spine
    d.line([(4, cy), (w-4, cy)], fill=C['wall_dk'], width=2)
    # Ribs (curved)
    for i in range(6):
        x_ = 6 + i*5
        d.line([(x_, cy), (x_-2, cy-7)], fill=C['wall'], width=1)
        d.line([(x_, cy), (x_+2, cy-7)], fill=C['wall'], width=1)
    # Skull at one end
    d.ellipse([w-12, cy-5, w-2, cy+2], fill=C['wall'])
    # Eye sockets
    d.point((w-8, cy-2), fill=(20, 20, 20))
    d.point((w-5, cy-2), fill=(20, 20, 20))
    # Tail bone
    d.polygon([(2, cy-2), (4, cy), (2, cy+2)], fill=C['wall'])
    canvas.alpha_composite(layer, (px, py))


def draw_bandit_camp_sprite(canvas, gx, gy):
    """2x2 bandit camp: 2-3 dark tents around a fire."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*2
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Dirt patch
    d.ellipse([2, 6, w-2, h-2], fill=C['farm_dirt_dk'])
    # Three small dark tents
    for cx, cy in [(8, h-8), (w-10, h-9), (w//2, 12)]:
        # tent (dark color)
        d.polygon([(cx, cy-7), (cx-5, cy+1), (cx+5, cy+1)], fill=(60, 50, 45))
        d.polygon([(cx, cy-7), (cx+5, cy+1), (cx, cy+1)], fill=(30, 25, 22))
        # Pole top
        d.line([(cx, cy-7), (cx, cy-10)], fill=C['wood_dk'])
        # Skull flag
        d.point((cx-1, cy-9), fill=C['wall'])
        d.point((cx, cy-9), fill=C['wall'])
    # Central fire pit
    cx_f, cy_f = w//2, h//2 + 4
    for ang_i in range(6):
        ang = ang_i * math.pi * 2 / 6
        sx = int(cx_f + math.cos(ang) * 5)
        sy = int(cy_f + math.sin(ang) * 3)
        d.ellipse([sx-1, sy-1, sx+1, sy+1], fill=C['stone_dk'])
    d.ellipse([cx_f-2, cy_f-2, cx_f+2, cy_f+1], fill=(230, 100, 30))
    d.point((cx_f, cy_f-1), fill=(255, 220, 80))
    canvas.alpha_composite(layer, (px, py))


def draw_spider_lair_sprite(canvas, gx, gy):
    """2x2 spider web stretched between trees."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE*2, TILE*2
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = w//2, h//2
    # Web — concentric rings + radial lines
    web_color = (200, 200, 210, 220)
    for r in (4, 8, 12, 16):
        d.ellipse([cx-r, cy-r, cx+r, cy+r], outline=web_color, width=1)
    for ang_i in range(8):
        ang = ang_i * math.pi / 4
        ex = cx + math.cos(ang) * 17
        ey = cy + math.sin(ang) * 17
        d.line([(cx, cy), (ex, ey)], fill=web_color, width=1)
    # The spider in the middle
    d.ellipse([cx-3, cy-2, cx+3, cy+2], fill=(40, 25, 30))
    d.ellipse([cx-1, cy-1, cx+1, cy+1], fill=(220, 60, 60))  # eye glow
    # Spider legs
    for ang_i in range(4):
        ang = ang_i * math.pi / 4 + math.pi / 8
        ex = cx + math.cos(ang) * 6
        ey = cy + math.sin(ang) * 4
        d.line([(cx, cy), (ex, ey)], fill=(40, 25, 30))
        d.line([(cx, cy), (cx-(ex-cx), ey)], fill=(40, 25, 30))
    canvas.alpha_composite(layer, (px, py))


def draw_eagles_nest_sprite(canvas, gx, gy):
    """1x1 — twig nest with eggs on a high perch."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 5
    # Nest (twigs)
    d.ellipse([cx-6, cy-3, cx+6, cy+3], fill=C['wood_dk'])
    d.ellipse([cx-5, cy-2, cx+5, cy+2], fill=C['wood'])
    # Twig texture
    d.line([(cx-5, cy-2), (cx+1, cy+1)], fill=C['wood_dk'])
    d.line([(cx-2, cy-3), (cx+4, cy)], fill=C['wood_dk'])
    # Eggs (3 small)
    d.ellipse([cx-3, cy-1, cx-1, cy+1], fill=C['wall'])
    d.ellipse([cx-1, cy-2, cx+1, cy], fill=C['wall'])
    d.ellipse([cx+1, cy-1, cx+3, cy+1], fill=C['wall'])
    # Eye specks on eggs
    d.point((cx-2, cy), fill=(150, 130, 110))
    canvas.alpha_composite(layer, (px, py))


def draw_wagon_graveyard_sprite(canvas, gx, gy):
    """1x1 — broken wagon wreck."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 4
    # Broken wagon body (tilted)
    d.polygon([(cx-7, cy), (cx+7, cy-3), (cx+7, cy+2), (cx-7, cy+3)],
              fill=C['wood'])
    d.line([(cx-7, cy), (cx+7, cy-3)], fill=C['wood_dk'])
    # Broken wheel sticking up
    d.ellipse([cx-9, cy-7, cx-1, cy+1], outline=C['wood_dk'], width=1)
    d.line([(cx-5, cy-7), (cx-5, cy+1)], fill=C['wood_dk'])
    d.line([(cx-9, cy-3), (cx-1, cy-3)], fill=C['wood_dk'])
    # Other wheel lying flat
    d.ellipse([cx+1, cy+1, cx+8, cy+4], fill=C['wood_dk'])
    # Cargo spilled
    d.point((cx-2, cy-1), fill=C['flower_y'])
    d.point((cx+3, cy), fill=C['flower_y'])
    canvas.alpha_composite(layer, (px, py))


def draw_knight_tomb_sprite(canvas, gx, gy):
    """1x2 — stone sarcophagus with sword on top."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE, TILE*2
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Pedestal base
    d.rectangle([2, h-6, w-2, h-2], fill=C['stone_dk'])
    # Sarcophagus body
    d.rectangle([3, h-22, w-3, h-6], fill=C['stone'])
    d.rectangle([3, h-22, w-3, h-19], fill=C['stone_lt'])
    # Carved knight effigy on top (very stylized)
    d.rectangle([w//2-2, h-21, w//2+2, h-10], fill=C['stone_dk'])
    d.ellipse([w//2-3, h-22, w//2+3, h-17], fill=C['stone_dk'])
    # Sword laid across
    d.rectangle([w//2-1, h-19, w//2+1, h-9], fill=(180, 180, 195))
    d.rectangle([w//2-3, h-19, w//2+3, h-17], fill=C['wood_dk'])
    d.point((w//2, h-19), fill=(250, 220, 90))  # pommel jewel
    canvas.alpha_composite(layer, (px, py))


def draw_glowing_meadow_sprite(canvas, gx, gy):
    """1x1 — bioluminescent flower patch."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE//2
    # Glow halo
    d.ellipse([cx-7, cy-5, cx+7, cy+5], fill=(140, 220, 200, 70))
    # Multiple glowing flowers
    for ox, oy, col in [(-4, 0, (140, 220, 240)),
                          (3, -2, (200, 240, 180)),
                          (0, 3, (240, 200, 240)),
                          (-2, -3, (180, 240, 220)),
                          (4, 2, (220, 220, 250))]:
        # Stem
        d.line([(cx+ox, cy+oy), (cx+ox, cy+oy+3)], fill=(40, 80, 40))
        # Glow petal
        d.ellipse([cx+ox-2, cy+oy-2, cx+ox+2, cy+oy+1], fill=col)
        d.point((cx+ox, cy+oy-1), fill=(255, 255, 255))
    canvas.alpha_composite(layer, (px, py))


def draw_phoenix_nest_sprite(canvas, gx, gy):
    """1x1 — flaming nest, mythical bird's home."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 6
    # Nest of branches
    d.ellipse([cx-7, cy-2, cx+7, cy+5], fill=(120, 60, 30))
    # Flames inside
    d.polygon([(cx-4, cy+1), (cx-2, cy-5), (cx, cy-2), (cx+2, cy-7), (cx+4, cy-3), (cx+4, cy+1)],
              fill=(255, 130, 30))
    d.polygon([(cx-2, cy+1), (cx-1, cy-2), (cx, cy-4), (cx+2, cy-2), (cx+3, cy+1)],
              fill=(255, 220, 80))
    # Glowing center egg
    d.ellipse([cx-2, cy, cx+2, cy+3], fill=(255, 240, 150))
    d.point((cx, cy+1), fill=(255, 255, 255))
    # Sparks rising
    d.point((cx-3, cy-7), fill=(255, 180, 60))
    d.point((cx+4, cy-9), fill=(255, 200, 80))
    canvas.alpha_composite(layer, (px, py))


def draw_buried_giant_sprite(canvas, gx, gy):
    """1x1 — half-buried giant statue head."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 4
    # Dirt mound
    d.ellipse([1, cy, TILE-1, cy+5], fill=C['farm_dirt_dk'])
    # Giant stone head (only top half visible)
    d.chord([cx-8, cy-9, cx+8, cy+5], 180, 360, fill=C['stone_dk'])
    d.chord([cx-7, cy-8, cx+7, cy+4], 180, 360, fill=C['stone'])
    # Eye holes
    d.ellipse([cx-5, cy-4, cx-3, cy-2], fill=(20, 20, 20))
    d.ellipse([cx+3, cy-4, cx+5, cy-2], fill=(20, 20, 20))
    # Crack across face
    d.line([(cx-6, cy-7), (cx-2, cy+1)], fill=C['stone_dk'])
    # Vines growing on it
    d.point((cx-4, cy-1), fill=C['tree'])
    d.point((cx+5, cy-3), fill=C['tree'])
    canvas.alpha_composite(layer, (px, py))


def draw_wishing_pond_sprite(canvas, gx, gy):
    """1x1 — small ornate pond with floating petals."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE//2 + 1
    # Stone rim
    d.ellipse([cx-7, cy-4, cx+7, cy+5], fill=C['stone_dk'])
    d.ellipse([cx-6, cy-3, cx+6, cy+4], fill=C['stone'])
    # Water
    d.ellipse([cx-5, cy-2, cx+5, cy+3], fill=C['water'])
    d.ellipse([cx-4, cy-1, cx+4, cy+2], fill=C['water_lt'])
    # Floating petals
    d.point((cx-2, cy), fill=C['flower_p'])
    d.point((cx+1, cy+1), fill=C['flower_p'])
    d.point((cx+3, cy-1), fill=C['flower_w'])
    # Coin glint
    d.point((cx, cy+1), fill=(255, 240, 90))
    # Lantern on the rim
    d.rectangle([cx+6, cy-7, cx+7, cy-3], fill=C['wood_dk'])
    d.rectangle([cx+5, cy-9, cx+8, cy-7], fill=C['flower_y'])
    canvas.alpha_composite(layer, (px, py))


def place_super_secrets(biome, decorations, offshore_islands):
    """Place the FIVE major super-secret landmarks at meaningful spots.
    Each appears at most once per world and is never reachable by road —
    you have to wander to find them."""
    print("Placing super-secrets…")

    def stamp_secret(name, x, y, w, h):
        for dy in range(h):
            for dx in range(w):
                ax, ay = x+dx, y+dy
                if 0 <= ay < MAP_H and 0 <= ax < MAP_W:
                    biome[ay, ax] = HOUSE   # reserve from path/decor systems
        decorations.append((name, x, y))

    # ── 1. SKY ISLAND on a small offshore island ──
    # The "unbelievable on a small island" — replaces the contents of one
    # small offshore island with the floating-island sprite.
    placed_sky = False
    if offshore_islands:
        # Pick the most ISOLATED small offshore island
        small = [(cx, cy, r) for cx, cy, r in offshore_islands if r <= 5]
        if not small:
            small = list(offshore_islands)
        # Most isolated = farthest from map center
        small.sort(key=lambda i: -math.hypot(i[0]-MAP_W/2, i[1]-MAP_H/2))
        for cx, cy, r in small:
            # Need ~4x4 spot to fit the sprite. Clear grass under it.
            sx, sy = cx-2, cy-2
            ok = all(0 <= sy+dy < MAP_H and 0 <= sx+dx < MAP_W
                     for dy in range(4) for dx in range(4))
            if not ok: continue
            # Convert the island's land to ocean (it's "lifted up")
            for dy in range(-r-1, r+2):
                for dx in range(-r-1, r+2):
                    ay, ax = cy+dy, cx+dx
                    if 0 <= ay < MAP_H and 0 <= ax < MAP_W:
                        if biome[ay, ax] in (GRASS, GRASS_LUSH, BEACH, HOUSE):
                            biome[ay, ax] = OCEAN
            stamp_secret('sky_island', sx, sy, 4, 4)
            # But the sky-island sprite needs the underlying tiles to be ocean
            # for the cloud illusion — already set above
            placed_sky = True
            print(f"  sky island at ({sx},{sy}) on offshore island")
            break

    # ── 2. VOLCANO at the highest part of a major island ──
    # Find a mountain cluster, convert it to volcano
    mount_cells = []
    for y in range(MAP_H):
        for x in range(MAP_W):
            if biome[y, x] == MOUNT:
                mount_cells.append((x, y))
    if mount_cells:
        random.shuffle(mount_cells)
        for vx, vy in mount_cells:
            # Need 5x5 area centered on vx,vy
            sx, sy = vx-2, vy-2
            if sx < 1 or sy < 1 or sx+5 > MAP_W-1 or sy+5 > MAP_H-1: continue
            # Most cells should be mountain or rocky
            mount_n = sum(1 for dy in range(5) for dx in range(5)
                          if biome[sy+dy, sx+dx] in (MOUNT, SNOW, GRASS_LUSH, GRASS))
            if mount_n >= 18:
                stamp_secret('volcano', sx, sy, 5, 5)
                print(f"  volcano at ({sx},{sy})")
                break

    # ── 3. WORLD TREE deep in a vast forest ──
    # Find a 5x5 forest cluster as deep inland as possible
    forest_cells = []
    for y in range(8, MAP_H-8):
        for x in range(8, MAP_W-8):
            if biome[y, x] in (FOREST, F_DENSE):
                # Count forest cells in a 5x5 neighborhood
                fn = sum(1 for dy in range(-3, 4) for dx in range(-3, 4)
                         if biome[y+dy, x+dx] in (FOREST, F_DENSE, F_DARK))
                if fn >= 35:
                    forest_cells.append((x, y, fn))
    # Pick the densest forest spot
    if forest_cells:
        forest_cells.sort(key=lambda c: -c[2])
        for wx, wy, _ in forest_cells:
            sx, sy = wx-2, wy-2
            if sx < 0 or sy < 0 or sx+5 > MAP_W or sy+5 > MAP_H: continue
            stamp_secret('world_tree', sx, sy, 5, 5)
            print(f"  world tree at ({sx},{sy}) in deep forest")
            break

    # ── 4. SUNKEN CITY in shallow ocean near a coast ──
    # Find a 4x4 patch of OCEAN that is fully surrounded by ocean (not just lap)
    # AND within 8 tiles of land (so it's visible/findable)
    ocean_spots = []
    for y in range(4, MAP_H-4):
        for x in range(4, MAP_W-4):
            # 4x4 ocean patch
            if all(biome[y+dy, x+dx] == OCEAN for dy in range(4) for dx in range(4)):
                # Within 8 tiles of land?
                near_land = any(
                    biome[y+ky, x+kx] not in (OCEAN, DEEP)
                    for ky in range(-8, 9) for kx in range(-8, 9)
                    if 0 <= y+ky < MAP_H and 0 <= x+kx < MAP_W
                )
                if near_land:
                    ocean_spots.append((x, y))
    if ocean_spots:
        sx, sy = random.choice(ocean_spots)
        decorations.append(('sunken_city', sx, sy))  # don't reserve as HOUSE (keeps ocean)
        print(f"  sunken city at ({sx},{sy}) in shallow ocean")

    # ── 5. PYRAMID in a sandy/desert area, or on a small offshore island ──
    # Try desert biome first
    desert_cells = []
    for y in range(3, MAP_H-3):
        for x in range(3, MAP_W-3):
            if biome[y, x] in (DESERT, SAND):
                ds = sum(1 for dy in range(-2, 3) for dx in range(-2, 3)
                         if biome[y+dy, x+dx] in (DESERT, SAND, BEACH))
                if ds >= 20:
                    desert_cells.append((x, y))
    pyramid_placed = False
    if desert_cells:
        random.shuffle(desert_cells)
        for px_, py_ in desert_cells:
            sx, sy = px_-2, py_-2
            if sx < 0 or sy < 0 or sx+5 > MAP_W or sy+5 > MAP_H: continue
            stamp_secret('pyramid', sx, sy, 5, 5)
            print(f"  pyramid at ({sx},{sy}) in desert")
            pyramid_placed = True
            break
    if not pyramid_placed:
        # Fall back: deep grass area
        for _ in range(200):
            sx = random.randint(3, MAP_W-8)
            sy = random.randint(3, MAP_H-8)
            ok = all(biome[sy+dy, sx+dx] in (GRASS, GRASS_LUSH, SAND, BEACH)
                     for dy in range(5) for dx in range(5))
            if ok:
                stamp_secret('pyramid', sx, sy, 5, 5)
                print(f"  pyramid at ({sx},{sy}) on grassland")
                break


# ═══════════════════════════════════════════════════════════════════════
# ⚡ SUPER-SECRETS — five UNIQUE landmark features per world ⚡
# Each is placed ONCE, never connects to a road, and is worth the trek.
# ═══════════════════════════════════════════════════════════════════════

def draw_sky_island_sprite(canvas, gx, gy):
    """A FLOATING ISLAND hovering above the sea — drifting clouds beneath,
    a tiny crystal shrine atop, glowing softly. The unbelievable secret."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE * 4, TILE * 4
    layer = Image.new('RGBA', (w + 12, h + 30), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx_, cy_ = (w + 12) // 2, h // 2

    # ── Cloud drift below the island ──
    for ox in range(-6, 7, 2):
        d.ellipse([cx_ - 30 + ox, cy_ + 14, cx_ + 30 + ox, cy_ + 28],
                  fill=(240, 240, 250, 140))
    d.ellipse([cx_ - 28, cy_ + 18, cx_ + 28, cy_ + 32], fill=(255, 255, 255, 200))
    d.ellipse([cx_ - 18, cy_ + 26, cx_ + 18, cy_ + 36], fill=(255, 255, 255, 160))

    # ── Island bottom (tapered like an inverted cone of rock) ──
    pts = [(cx_ - 28, cy_ + 6),
           (cx_ - 22, cy_ + 14),
           (cx_ - 8, cy_ + 22),
           (cx_ + 4, cy_ + 22),
           (cx_ + 18, cy_ + 16),
           (cx_ + 28, cy_ + 8)]
    d.polygon(pts, fill=(70, 50, 40))
    # Lighter rock highlight on top edge
    d.polygon([(cx_ - 28, cy_ + 6), (cx_ - 22, cy_ + 14),
               (cx_ - 4, cy_ + 18), (cx_ + 16, cy_ + 14),
               (cx_ + 28, cy_ + 8), (cx_ + 28, cy_ + 4),
               (cx_ - 28, cy_ + 4)],
              fill=(110, 80, 60))

    # ── Grass surface on top ──
    d.ellipse([cx_ - 30, cy_ - 4, cx_ + 30, cy_ + 10], fill=(110, 175, 70))
    d.ellipse([cx_ - 28, cy_ - 6, cx_ + 28, cy_ + 4], fill=(140, 210, 90))
    # Grass texture
    for _ in range(8):
        gx_ = cx_ + random.randint(-26, 26)
        gy_ = cy_ - 2 + random.randint(-3, 3)
        d.point((gx_, gy_), fill=(60, 130, 40))

    # ── A few trees on the island ──
    for tx, ty in [(cx_ - 14, cy_ - 2), (cx_ + 12, cy_ - 4), (cx_ - 4, cy_ - 6)]:
        d.ellipse([tx - 5, ty - 6, tx + 5, ty + 3], fill=(35, 95, 35))
        d.ellipse([tx - 3, ty - 5, tx + 3, ty + 1], fill=(60, 130, 55))
        d.point((tx - 1, ty - 3), fill=(120, 175, 80))

    # ── Crystal shrine in the center ──
    sx, sy = cx_, cy_ - 14
    # Pedestal
    d.rectangle([sx - 5, sy + 4, sx + 5, sy + 8], fill=(180, 175, 165))
    d.rectangle([sx - 6, sy + 7, sx + 6, sy + 10], fill=(140, 135, 125))
    # Glowing crystal column
    d.polygon([(sx - 3, sy + 4), (sx, sy - 12), (sx + 3, sy + 4)],
              fill=(140, 90, 220))
    d.polygon([(sx - 3, sy + 4), (sx, sy - 12), (sx, sy + 4)],
              fill=(200, 160, 250))
    # Halo of light
    for r in range(14, 4, -2):
        d.ellipse([sx - r, sy - 12 - r // 2, sx + r, sy - 6 + r // 2],
                  outline=(180, 150, 240, 60), width=1)
    # Floating sparkles
    for ox, oy in [(-8, -8), (10, -4), (-12, 2), (6, -14), (14, 4)]:
        d.point((sx + ox, sy + oy), fill=(255, 240, 255))

    # ── Hanging rocks drifting below ──
    d.ellipse([cx_ - 16, cy_ + 30, cx_ - 10, cy_ + 36], fill=(70, 50, 40))
    d.ellipse([cx_ + 10, cy_ + 26, cx_ + 14, cy_ + 32], fill=(70, 50, 40))
    d.ellipse([cx_ + 22, cy_ + 36, cx_ + 26, cy_ + 40], fill=(90, 65, 50))

    canvas.alpha_composite(layer, (px - 6, py - 10))


def draw_volcano_sprite(canvas, gx, gy):
    """A massive ACTIVE VOLCANO with glowing lava, smoke plume, and ash."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE * 5, TILE * 5
    layer = Image.new('RGBA', (w, h + 40), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx_ = w // 2
    base_y = h + 20

    # ── Massive mountain body (dark rock) ──
    d.polygon([(8, base_y), (w - 8, base_y),
               (cx_ + 22, 30), (cx_ - 22, 30)], fill=(60, 50, 50))
    # Lighter shading on left side
    d.polygon([(8, base_y), (cx_ - 22, 30), (cx_, 30), (cx_ - 6, base_y)],
              fill=(85, 70, 65))
    # Rock texture spots
    for _ in range(20):
        rx = random.randint(20, w - 20)
        ry = random.randint(60, base_y - 5)
        d.point((rx, ry), fill=(40, 30, 30))

    # ── Crater rim ──
    d.polygon([(cx_ - 22, 30), (cx_ - 18, 22), (cx_ + 18, 22),
               (cx_ + 22, 30), (cx_ + 12, 36), (cx_ - 12, 36)],
              fill=(35, 25, 25))

    # ── Glowing lava in crater ──
    d.ellipse([cx_ - 14, 24, cx_ + 14, 38], fill=(140, 30, 10))
    d.ellipse([cx_ - 10, 26, cx_ + 10, 34], fill=(220, 90, 20))
    d.ellipse([cx_ - 6, 27, cx_ + 6, 32], fill=(255, 200, 80))
    # Sparks above
    for sx, sy in [(cx_ - 4, 15), (cx_ + 3, 12), (cx_ + 8, 18), (cx_ - 8, 19)]:
        d.point((sx, sy), fill=(255, 220, 80))

    # ── Lava streams running down the sides ──
    d.line([(cx_ - 12, 36), (cx_ - 16, 50), (cx_ - 20, 70), (cx_ - 24, base_y)],
           fill=(220, 60, 20), width=2)
    d.line([(cx_ + 12, 36), (cx_ + 18, 52), (cx_ + 22, 70), (cx_ + 26, base_y)],
           fill=(220, 60, 20), width=2)
    d.line([(cx_, 36), (cx_ + 2, 60), (cx_ - 2, 90), (cx_, base_y - 10)],
           fill=(255, 130, 40), width=1)

    # ── Thick smoke plume above ──
    smoke = [(40, 240), (40, 200), (40, 160)]
    for ox, oy, a in [(-6, -6, 230), (0, -14, 220), (6, -8, 210),
                       (-2, -22, 180), (4, -28, 150), (-4, -36, 100)]:
        d.ellipse([cx_ - 10 + ox, oy + 32, cx_ + 10 + ox, oy + 48],
                  fill=(70, 65, 65, a))

    # ── Lava cooled patches at base (red/orange dirt) ──
    for ox in (-30, -10, 12, 30):
        d.ellipse([cx_ + ox - 5, base_y - 4, cx_ + ox + 5, base_y + 2],
                  fill=(110, 50, 30))

    canvas.alpha_composite(layer, (px, py - 30))


def draw_world_tree_sprite(canvas, gx, gy):
    """The legendary WORLD TREE — colossal ancient tree, glowing softly,
    hidden deep in the forest. Spans a huge area."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE * 5, TILE * 5
    layer = Image.new('RGBA', (w + 20, h + 30), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx_, cy_ = (w + 20) // 2, h // 2 + 10

    # ── Glow halo ──
    for r in range(48, 30, -3):
        d.ellipse([cx_ - r, cy_ - r - 8, cx_ + r, cy_ + r - 8],
                  fill=(180, 230, 180, 30))

    # ── Massive trunk ──
    trunk_w = 14
    d.polygon([(cx_ - trunk_w, h + 18),
               (cx_ + trunk_w, h + 18),
               (cx_ + trunk_w - 4, cy_ - 4),
               (cx_ - trunk_w + 4, cy_ - 4)],
              fill=(80, 55, 35))
    # Trunk lighter side
    d.polygon([(cx_ - trunk_w, h + 18),
               (cx_, h + 18),
               (cx_ - 2, cy_ - 4),
               (cx_ - trunk_w + 4, cy_ - 4)],
              fill=(110, 80, 55))
    # Trunk darker shading
    d.polygon([(cx_ + 2, cy_ - 4),
               (cx_ + trunk_w - 4, cy_ - 4),
               (cx_ + trunk_w, h + 18),
               (cx_ + 6, h + 18)],
              fill=(60, 40, 25))
    # Bark detail lines
    for y_ in range(int(cy_) + 8, h + 16, 8):
        d.line([(cx_ - 4, y_), (cx_ - 5, y_ + 4)], fill=(50, 30, 20))
        d.line([(cx_ + 4, y_), (cx_ + 5, y_ + 4)], fill=(50, 30, 20))

    # ── Huge roots spreading out ──
    for ang in (math.pi * 0.85, math.pi * 0.95, math.pi * 1.05, math.pi * 1.15):
        end_x = cx_ + math.cos(ang) * 26
        end_y = h + 22 + math.sin(ang) * 6
        d.line([(cx_, h + 18), (end_x, end_y)],
               fill=(70, 50, 30), width=3)

    # ── Massive canopy — multiple overlapping blobs ──
    canopy_layout = [
        (-22, -12, 22), (22, -10, 22), (0, -32, 26),
        (-30, 6, 18), (30, 4, 18), (-12, 18, 16),
        (12, 16, 16), (0, -8, 28),
    ]
    # Dark layer
    for ox, oy, r in canopy_layout:
        d.ellipse([cx_ + ox - r, cy_ + oy - r,
                    cx_ + ox + r, cy_ + oy + r], fill=(20, 65, 25))
    # Mid layer
    for ox, oy, r in canopy_layout:
        r2 = r - 3
        d.ellipse([cx_ + ox - r2 + 1, cy_ + oy - r2 - 1,
                    cx_ + ox + r2 - 2, cy_ + oy + r2 - 3], fill=(50, 130, 55))
    # Light highlight blobs
    for ox, oy, r in canopy_layout[:4]:
        r3 = r // 3
        d.ellipse([cx_ + ox - r3, cy_ + oy - r3 - 2,
                    cx_ + ox + r3 - 1, cy_ + oy + r3 - 3], fill=(110, 190, 90))

    # ── Glowing fruit / runes scattered through canopy ──
    glow_dots = [(-18, -16), (16, -8), (-4, -28), (-26, 4),
                 (24, 0), (0, 12), (-10, -4), (12, -18)]
    for ox, oy in glow_dots:
        d.point((cx_ + ox, cy_ + oy), fill=(255, 255, 200))
        # Tiny halo
        d.point((cx_ + ox - 1, cy_ + oy), fill=(220, 240, 180))
        d.point((cx_ + ox + 1, cy_ + oy), fill=(220, 240, 180))

    # ── Carved door at base of trunk ──
    d.rounded_rectangle([cx_ - 4, h + 8, cx_ + 4, h + 18], radius=3, fill=(40, 20, 10))
    d.rounded_rectangle([cx_ - 3, h + 9, cx_ + 3, h + 17], radius=2, fill=(70, 50, 30))
    d.point((cx_ + 2, h + 13), fill=(220, 200, 100))  # golden handle

    canvas.alpha_composite(layer, (px - 10, py - 30))


def draw_sunken_city_sprite(canvas, gx, gy):
    """SUNKEN CITY — massive underwater ruins spanning 4x4 tiles.
    Glimpsed through shallow water — half-collapsed temple, pillars, a giant
    fallen statue."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE * 4, TILE * 4
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # ── Murky underwater tint over the whole region ──
    d.rectangle([0, 0, w, h], fill=(40, 110, 160, 100))

    # ── Pillars in a row (some standing, some broken) ──
    pillar_positions = [(12, 18, 6, 38),    # tall
                        (24, 22, 6, 34),    # tall
                        (36, 26, 6, 30),    # mid-height
                        (48, 14, 6, 42),    # tallest
                        (60, 30, 6, 26),    # short
                        (18, 50, 6, 30),    # tall
                        (32, 56, 6, 24),    # mid
                        (50, 52, 6, 28)]    # tall
    for x_, y_, ww, hh in pillar_positions:
        # Pillar shadow / shaft
        d.rectangle([x_, y_, x_ + ww, y_ + hh], fill=(150, 150, 145, 220))
        d.rectangle([x_, y_, x_ + ww // 2, y_ + hh], fill=(190, 190, 180, 220))
        # Capital top
        d.rectangle([x_ - 1, y_ - 2, x_ + ww + 1, y_], fill=(170, 165, 150, 220))
        # Base
        d.rectangle([x_ - 1, y_ + hh, x_ + ww + 1, y_ + hh + 2],
                    fill=(170, 165, 150, 220))
        # Crack lines
        d.line([(x_ + 2, y_ + hh // 3), (x_ + ww - 2, y_ + hh // 3)],
               fill=(100, 100, 95, 200))

    # ── Toppled column laying on its side ──
    d.rectangle([w - 32, h - 12, w - 4, h - 6], fill=(170, 170, 160, 220))
    d.rectangle([w - 32, h - 12, w - 4, h - 9], fill=(200, 200, 185, 220))
    # End caps
    d.ellipse([w - 36, h - 13, w - 28, h - 5], fill=(160, 155, 145, 220))
    d.ellipse([w - 8, h - 13, w, h - 5], fill=(160, 155, 145, 220))

    # ── Cracked dome / temple roof in middle ──
    d.chord([w // 2 - 18, h // 2 - 8, w // 2 + 18, h // 2 + 16],
            180, 360, fill=(180, 175, 155, 230))
    # Crack across dome
    d.line([(w // 2 - 15, h // 2 + 6), (w // 2 + 18, h // 2 - 4)],
           fill=(80, 80, 75, 230))
    # Top finial broken off
    d.point((w // 2, h // 2 - 8), fill=(100, 100, 95))

    # ── Giant fallen statue head ──
    sx, sy = 12, h - 18
    d.ellipse([sx, sy, sx + 16, sy + 16], fill=(170, 165, 150, 230))
    # Eye holes
    d.point((sx + 5, sy + 6), fill=(30, 50, 70))
    d.point((sx + 11, sy + 6), fill=(30, 50, 70))
    # Cracked mouth
    d.line([(sx + 5, sy + 11), (sx + 11, sy + 11)], fill=(80, 80, 75))

    # ── Seaweed sprouting from rubble ──
    for ox in (5, 22, 45, 65):
        d.line([(ox, h - 4), (ox, h - 12)], fill=(40, 90, 50, 230))
        d.line([(ox + 1, h - 5), (ox + 3, h - 10)], fill=(50, 110, 60, 220))

    # ── Glints (gold treasure in rubble) ──
    d.point((w // 4, h // 2 + 12), fill=(255, 220, 100))
    d.point((w * 3 // 4, h // 3), fill=(255, 220, 100))
    # Bubbles rising
    for bx, by in [(20, 12), (45, 8), (60, 14)]:
        d.point((bx, by), fill=(255, 255, 255, 200))

    canvas.alpha_composite(layer, (px, py))


def draw_pyramid_sprite(canvas, gx, gy):
    """Massive stepped PYRAMID with hieroglyphs and a glowing capstone."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE * 5, TILE * 5
    layer = Image.new('RGBA', (w, h + 20), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx_ = w // 2
    base_y = h + 12

    # ── Sand mound around base ──
    d.ellipse([4, base_y - 10, w - 4, base_y + 10],
              fill=(210, 175, 110))
    d.ellipse([8, base_y - 8, w - 8, base_y + 8],
              fill=(220, 190, 130))

    # ── Pyramid steps (5 tiers, tapering up) ──
    steps = 5
    for i in range(steps):
        t0 = i / steps
        t1 = (i + 1) / steps
        # Wider base, narrower top
        x0 = cx_ - int((w // 2 - 12) * (1 - t0))
        x1 = cx_ + int((w // 2 - 12) * (1 - t0))
        x0t = cx_ - int((w // 2 - 12) * (1 - t1))
        x1t = cx_ + int((w // 2 - 12) * (1 - t1))
        y0 = base_y - int((h - 12) * t0)
        y1 = base_y - int((h - 12) * t1)
        # Front face
        shades = [(195, 165, 100), (180, 150, 88), (170, 140, 78),
                  (160, 130, 70), (150, 120, 62)]
        d.polygon([(x0, y0), (x1, y0), (x1t, y1), (x0t, y1)], fill=shades[i])
        # Shadow on right side
        d.polygon([(cx_, y0), (x1, y0), (x1t, y1), (cx_, y1)],
                  fill=tuple(max(0, c - 30) for c in shades[i]))
        # Step edge highlight
        d.line([(x0, y0), (x1, y0)], fill=(220, 195, 130))

    # ── Big stairway up the front face ──
    stairs_w = 14
    for s in range(8):
        sy = base_y - 3 - s * 5
        d.rectangle([cx_ - stairs_w // 2, sy, cx_ + stairs_w // 2, sy + 2],
                    fill=(140, 110, 60))
        d.line([(cx_ - stairs_w // 2, sy), (cx_ + stairs_w // 2, sy)],
               fill=(110, 85, 45))

    # ── Hieroglyph carvings on the lower faces ──
    glyphs = [(cx_ - 25, base_y - 8, 0), (cx_ - 12, base_y - 8, 1),
              (cx_ + 12, base_y - 8, 2), (cx_ + 22, base_y - 8, 1)]
    for gx_, gy_, kind in glyphs:
        if kind == 0:  # eye
            d.ellipse([gx_ - 2, gy_, gx_ + 2, gy_ + 2], fill=(60, 40, 20))
            d.point((gx_, gy_ + 1), fill=(180, 140, 50))
        elif kind == 1:  # bird
            d.line([(gx_ - 2, gy_), (gx_ + 2, gy_)], fill=(60, 40, 20))
            d.line([(gx_, gy_), (gx_, gy_ + 3)], fill=(60, 40, 20))
        else:  # ankh
            d.line([(gx_, gy_), (gx_, gy_ + 4)], fill=(60, 40, 20))
            d.line([(gx_ - 2, gy_ + 2), (gx_ + 2, gy_ + 2)], fill=(60, 40, 20))

    # ── Golden glowing capstone on top ──
    cap_y = base_y - int((h - 12) * (steps / steps)) - 8
    d.polygon([(cx_ - 4, cap_y + 6), (cx_ + 4, cap_y + 6), (cx_, cap_y)],
              fill=(245, 215, 90))
    d.polygon([(cx_, cap_y + 6), (cx_ + 4, cap_y + 6), (cx_, cap_y)],
              fill=(200, 165, 50))
    # Glow halo
    for r in range(10, 4, -2):
        d.ellipse([cx_ - r, cap_y - r, cx_ + r, cap_y + r],
                  outline=(255, 240, 150, 80), width=1)
    # Bright sparkle
    d.point((cx_, cap_y + 2), fill=(255, 255, 200))

    # ── Dark entrance at base center ──
    d.rectangle([cx_ - 4, base_y - 7, cx_ + 4, base_y - 1], fill=(10, 8, 5))
    d.polygon([(cx_ - 5, base_y - 7), (cx_ + 5, base_y - 7), (cx_, base_y - 12)],
              fill=(20, 14, 8))

    canvas.alpha_composite(layer, (px, py - 12))


# ── Water feature sprites ─────────────────────────────────────────────────

def draw_sail_ship_sprite(canvas, gx, gy):
    """Larger sailing ship floating in deeper water."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE+2, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 5
    # Hull (curved with prow)
    d.polygon([(cx-9, cy), (cx-7, cy+5), (cx+7, cy+5), (cx+9, cy)],
              fill=C['wood'])
    d.polygon([(cx-5, cy+2), (cx-3, cy+4), (cx+3, cy+4), (cx+5, cy+2)],
              fill=C['wood_dk'])
    # Mast
    d.rectangle([cx, cy-12, cx+1, cy], fill=C['wood_dk'])
    # Main sail
    d.polygon([(cx-5, cy-10), (cx+5, cy-10), (cx+6, cy-1), (cx-6, cy-1)],
              fill=C['wall'])
    d.polygon([(cx, cy-10), (cx+5, cy-10), (cx+6, cy-1), (cx, cy-1)],
              fill=(220, 215, 200))
    # Flag at top
    d.polygon([(cx, cy-12), (cx+6, cy-11), (cx, cy-9)], fill=C['roof'])
    # Crow's nest
    d.rectangle([cx-2, cy-12, cx+3, cy-10], fill=C['wood_dk'])
    # Wake under
    d.line([(cx-10, cy+6), (cx-7, cy+6)], fill=C['water_lt'])
    d.line([(cx+7, cy+6), (cx+10, cy+6)], fill=C['water_lt'])
    canvas.alpha_composite(layer, (px, py))


def draw_sea_stack_sprite(canvas, gx, gy):
    """Rock pillar jutting out of the water."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = TILE//2
    # Base ripple
    d.ellipse([2, TILE-5, TILE-2, TILE-1], fill=C['water_lt'])
    # Rock pillar (tall narrow)
    d.polygon([(cx-3, TILE-2), (cx-4, TILE-8), (cx-2, 3),
               (cx+2, 2), (cx+4, TILE-7), (cx+3, TILE-2)],
              fill=C['mountain_dk'])
    d.polygon([(cx-3, TILE-2), (cx-4, TILE-8), (cx-2, 3),
               (cx, 2), (cx, TILE-2)],
              fill=C['mountain'])
    # Highlights
    d.point((cx-1, 5), fill=C['mountain_lt'])
    d.point((cx-1, 10), fill=C['mountain_lt'])
    # Tiny vegetation on top
    if random.random() < 0.4:
        d.point((cx, 1), fill=C['tree'])
    canvas.alpha_composite(layer, (px, py))


def draw_buoy_sprite(canvas, gx, gy):
    """Floating navigation buoy."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 6
    # Ripples below
    d.ellipse([cx-5, cy+2, cx+5, cy+5], fill=C['water_lt'])
    # Buoy (red-white striped)
    d.rectangle([cx-3, cy-4, cx+3, cy+2], fill=C['roof'])
    d.rectangle([cx-3, cy-1, cx+3, cy], fill=C['wall'])
    # Top
    d.line([(cx, cy-7), (cx, cy-4)], fill=C['wood_dk'])
    d.point((cx, cy-7), fill=(255, 200, 0))
    canvas.alpha_composite(layer, (px, py))


def draw_sea_monster_sprite(canvas, gx, gy):
    """Just a dorsal fin or sea serpent coil — mysterious shape."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 4
    # Ripples
    d.ellipse([cx-7, cy, cx+7, cy+4], fill=C['water_lt'])
    d.ellipse([cx-5, cy+1, cx+5, cy+3], fill=C['water'])
    # Dorsal fin sticking up (sinister)
    d.polygon([(cx-3, cy), (cx, cy-9), (cx+3, cy)], fill=(40, 50, 65))
    d.polygon([(cx-3, cy), (cx, cy-9), (cx, cy)], fill=(70, 80, 95))
    # Tail behind it (small bump)
    d.polygon([(cx+5, cy-1), (cx+7, cy-3), (cx+8, cy)], fill=(40, 50, 65))
    canvas.alpha_composite(layer, (px, py))


def draw_sunken_ruins_sprite(canvas, gx, gy):
    """Stone columns visible underwater."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Slightly darker water tint
    d.rectangle([2, 2, TILE-3, TILE-3], fill=(60, 130, 175, 80))
    # Two broken columns (ghostly through water)
    d.rectangle([4, 6, 6, TILE-3], fill=(160, 155, 140, 200))
    d.rectangle([4, 5, 6, 6], fill=(190, 185, 170, 200))  # broken top capital
    d.rectangle([TILE-7, 4, TILE-5, TILE-3], fill=(160, 155, 140, 200))
    d.rectangle([TILE-7, 3, TILE-5, 4], fill=(190, 185, 170, 200))
    # Collapsed lintel
    d.rectangle([3, TILE-5, TILE-3, TILE-3], fill=(140, 135, 120, 200))
    # Ripples on top
    d.line([(2, 3), (TILE-3, 3)], fill=C['water_lt'])
    # Tiny bubbles
    d.point((6, 2), fill=(255, 255, 255, 200))
    d.point((TILE-5, 6), fill=(255, 255, 255, 200))
    canvas.alpha_composite(layer, (px, py))


def draw_floating_barrel_sprite(canvas, gx, gy):
    """Floating barrel drifting at sea — castaway debris."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 5
    d.ellipse([cx-4, cy+1, cx+4, cy+4], fill=C['water_lt'])
    d.ellipse([cx-3, cy-2, cx+3, cy+2], fill=C['wood'])
    d.line([(cx-3, cy-1), (cx+3, cy-1)], fill=C['wood_dk'])
    d.line([(cx-3, cy+1), (cx+3, cy+1)], fill=C['wood_dk'])
    # Tiny crab on top, half random
    if random.random() < 0.3:
        d.point((cx+1, cy-3), fill=C['roof_dk'])
        d.point((cx, cy-3), fill=C['roof_dk'])
    canvas.alpha_composite(layer, (px, py))


def scatter_ocean_features(biome, decorations):
    """Place ships, buoys, sea stacks, sunken ruins on ocean tiles."""
    print("Scattering ocean features…")
    # Find all ocean cells with adequate buffer from land
    ocean_cells = []
    deep_cells  = []
    for y in range(2, MAP_H-2):
        for x in range(2, MAP_W-2):
            if biome[y, x] == OCEAN:
                # Must have NO land in immediate 1-cell neighborhood
                near_land = any(biome[y+dy, x+dx] not in (OCEAN, DEEP)
                                for dy in range(-1, 2) for dx in range(-1, 2))
                if not near_land:
                    ocean_cells.append((x, y))
            elif biome[y, x] == DEEP:
                near_land = any(biome[y+dy, x+dx] not in (OCEAN, DEEP)
                                for dy in range(-2, 3) for dx in range(-2, 3))
                if not near_land:
                    deep_cells.append((x, y))

    random.shuffle(ocean_cells)
    random.shuffle(deep_cells)

    def place(kind, pool, count, taken):
        added = 0
        for x, y in pool:
            if added >= count: break
            if any(abs(x-ox)+abs(y-oy) < 5 for ox, oy in taken):
                continue
            decorations.append((kind, x, y))
            taken.append((x, y))
            added += 1

    taken = []
    # Scale counts with map area
    sf = max(1, (MAP_W * MAP_H) // 12000)
    # Big sailing ships in deep water
    place('sail_ship', deep_cells, random.randint(8, 14) * sf, taken)
    # Sea monsters (rare) in deep water
    place('sea_monster', deep_cells, random.randint(2, 5) * sf, taken)
    # Sea stacks near shore
    place('sea_stack', ocean_cells, random.randint(12, 22) * sf, taken)
    # Sunken ruins
    place('sunken_ruins', ocean_cells, random.randint(5, 10) * sf, taken)
    # Buoys
    place('buoy', ocean_cells, random.randint(8, 16) * sf, taken)
    # Floating barrels
    place('floating_barrel', ocean_cells, random.randint(8, 15) * sf, taken)


def draw_skull_pile_sprite(canvas, gx, gy):
    """Pile of bones — old battlefield marker."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 4
    # Bones (crossed)
    d.line([(cx-5, cy+1), (cx+5, cy-3)], fill=C['wall_dk'], width=2)
    d.line([(cx-5, cy-3), (cx+5, cy+1)], fill=C['wall_dk'], width=2)
    d.point((cx-5, cy+1), fill=C['wall'])
    d.point((cx+5, cy+1), fill=C['wall'])
    # Skull
    d.ellipse([cx-3, cy-6, cx+3, cy-1], fill=C['wall'])
    d.point((cx-1, cy-4), fill=(20, 20, 20))
    d.point((cx+1, cy-4), fill=(20, 20, 20))
    d.point((cx, cy-2), fill=(40, 40, 40))
    canvas.alpha_composite(layer, (px, py))


def draw_pumpkin_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 5
    # Pumpkin body
    d.ellipse([cx-4, cy-3, cx+4, cy+3], fill=(220, 110, 30))
    d.ellipse([cx-3, cy-3, cx+1, cy+3], fill=(245, 140, 50))
    # Ridges
    d.line([(cx-2, cy-3), (cx-2, cy+3)], fill=(180, 80, 20))
    d.line([(cx+2, cy-3), (cx+2, cy+3)], fill=(180, 80, 20))
    # Stem
    d.rectangle([cx-1, cy-5, cx+1, cy-3], fill=C['tree_dk'])
    canvas.alpha_composite(layer, (px, py))


def draw_berry_bush_sprite(canvas, gx, gy):
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = TILE//2, TILE - 5
    # Bush
    d.ellipse([cx-5, cy-3, cx+5, cy+3], fill=C['tree_dk'])
    d.ellipse([cx-4, cy-2, cx+4, cy+2], fill=C['tree'])
    # Red berries
    for ox, oy in [(-3, -1), (1, -2), (3, 0), (-1, 1), (2, 2)]:
        d.point((cx+ox, cy+oy), fill=C['flower_r'])
    canvas.alpha_composite(layer, (px, py))


# ── Wild animal sprites ───────────────────────────────────────────────────

def draw_deer_sprite(canvas, gx, gy):
    px = gx * TILE + random.randint(0, TILE-11)
    py = gy * TILE + random.randint(2, TILE-9)
    layer = Image.new('RGBA', (11, 9), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Body
    d.rectangle([1, 3, 8, 6], fill=(170, 110, 70))
    d.rectangle([1, 3, 8, 4], fill=(190, 130, 85))
    # Head
    d.rectangle([7, 1, 10, 4], fill=(170, 110, 70))
    # Antlers
    d.point((8, 0), fill=C['wood_dk'])
    d.point((10, 0), fill=C['wood_dk'])
    # Legs
    d.rectangle([2, 6, 3, 9], fill=(120, 75, 50))
    d.rectangle([6, 6, 7, 9], fill=(120, 75, 50))
    # White tail tuft
    d.point((1, 4), fill=C['wall'])
    canvas.alpha_composite(layer, (px, py))


def draw_rabbit_sprite(canvas, gx, gy):
    px = gx * TILE + random.randint(2, TILE-8)
    py = gy * TILE + random.randint(4, TILE-7)
    layer = Image.new('RGBA', (7, 7), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Body
    d.ellipse([1, 3, 6, 6], fill=(190, 175, 160))
    # Head
    d.ellipse([3, 1, 6, 4], fill=(200, 185, 170))
    # Long ears
    d.line([(4, 0), (4, 2)], fill=(170, 155, 140))
    d.line([(5, 0), (5, 2)], fill=(170, 155, 140))
    # Eye
    d.point((5, 2), fill=(0, 0, 0))
    # Tail (white puff)
    d.point((1, 4), fill=C['wall'])
    canvas.alpha_composite(layer, (px, py))


def draw_fox_sprite(canvas, gx, gy):
    px = gx * TILE + random.randint(0, TILE-10)
    py = gy * TILE + random.randint(3, TILE-7)
    layer = Image.new('RGBA', (10, 7), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Body
    d.rectangle([1, 2, 7, 5], fill=(210, 110, 45))
    # Head
    d.polygon([(6, 1), (9, 4), (6, 4)], fill=(210, 110, 45))
    # White muzzle
    d.point((8, 3), fill=C['wall'])
    # Bushy tail
    d.polygon([(0, 2), (-1, 5), (1, 5)], fill=(210, 110, 45))
    d.point((0, 4), fill=C['wall'])
    # Legs
    d.point((2, 6), fill=C['wood_dk'])
    d.point((5, 6), fill=C['wood_dk'])
    canvas.alpha_composite(layer, (px, py))


def draw_wolf_sprite(canvas, gx, gy):
    px = gx * TILE + random.randint(0, TILE-11)
    py = gy * TILE + random.randint(3, TILE-7)
    layer = Image.new('RGBA', (11, 7), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Body (gray)
    d.rectangle([1, 2, 8, 5], fill=(95, 95, 105))
    d.rectangle([1, 2, 8, 3], fill=(125, 125, 135))
    # Head
    d.polygon([(7, 1), (10, 3), (10, 5), (7, 5)], fill=(95, 95, 105))
    # Glowing eyes
    d.point((9, 3), fill=C['flower_y'])
    # Tail
    d.polygon([(0, 2), (-1, 5), (1, 4)], fill=(95, 95, 105))
    # Legs
    d.point((2, 6), fill=(60, 60, 70))
    d.point((6, 6), fill=(60, 60, 70))
    canvas.alpha_composite(layer, (px, py))


def draw_bird_sprite(canvas, gx, gy):
    """Small bird flying overhead (M-shape)."""
    px = gx * TILE + random.randint(0, TILE-4)
    py = gy * TILE + random.randint(0, TILE-3)
    d = ImageDraw.Draw(canvas)
    d.line([(px, py+2), (px+1, py), (px+2, py+1), (px+3, py), (px+4, py+2)],
           fill=(40, 40, 50))


# ── Monster / enemy sprites ──────────────────────────────────────────────

def draw_skeleton_sprite(canvas, gx, gy):
    """Skeleton — pale white humanoid with skull, in F_DARK or near ruins."""
    px = gx * TILE + random.randint(2, TILE-8)
    py = gy * TILE + random.randint(3, TILE-10)
    d = ImageDraw.Draw(canvas)
    # Skull
    d.ellipse([px+1, py, px+5, py+4], fill=(240, 235, 220))
    d.point((px+2, py+2), fill=(20, 20, 20))
    d.point((px+4, py+2), fill=(20, 20, 20))
    # Ribcage
    d.rectangle([px+2, py+4, px+5, py+7], fill=(220, 215, 200))
    d.line([(px+2, py+5), (px+5, py+5)], fill=(150, 145, 130))
    # Arms (one with sword)
    d.line([(px+1, py+5), (px, py+8)], fill=(220, 215, 200))
    d.line([(px+5, py+5), (px+7, py+7)], fill=(220, 215, 200))
    d.line([(px+7, py+5), (px+7, py+8)], fill=(180, 180, 190))  # sword
    # Legs
    d.line([(px+2, py+7), (px+2, py+10)], fill=(220, 215, 200))
    d.line([(px+4, py+7), (px+4, py+10)], fill=(220, 215, 200))


def draw_slime_sprite(canvas, gx, gy):
    """Slime — green wobbly blob in swamps/dark forest."""
    px = gx * TILE + random.randint(1, TILE-9)
    py = gy * TILE + random.randint(3, TILE-8)
    d = ImageDraw.Draw(canvas)
    color = random.choice([(80, 200, 100), (100, 180, 220), (200, 100, 200)])
    light = tuple(min(255, c+50) for c in color)
    # Body
    d.ellipse([px, py+2, px+8, py+7], fill=color)
    d.ellipse([px+1, py, px+7, py+5], fill=color)
    # Highlight
    d.ellipse([px+1, py+1, px+3, py+3], fill=light)
    # Eyes
    d.point((px+3, py+3), fill=(0, 0, 0))
    d.point((px+5, py+3), fill=(0, 0, 0))


def draw_goblin_sprite(canvas, gx, gy):
    """Small green goblin enemy."""
    px = gx * TILE + random.randint(2, TILE-8)
    py = gy * TILE + random.randint(3, TILE-9)
    d = ImageDraw.Draw(canvas)
    # Body (green)
    d.rectangle([px+2, py+3, px+5, py+7], fill=(80, 130, 50))
    d.rectangle([px+2, py+3, px+3, py+7], fill=(100, 150, 65))
    # Head (bigger)
    d.ellipse([px+1, py, px+6, py+4], fill=(110, 160, 70))
    # Pointed ears
    d.point((px, py+1), fill=(90, 140, 60))
    d.point((px+6, py+1), fill=(90, 140, 60))
    # Eyes (red)
    d.point((px+2, py+2), fill=(220, 30, 30))
    d.point((px+4, py+2), fill=(220, 30, 30))
    # Club
    d.rectangle([px+5, py+4, px+6, py+7], fill=(120, 80, 40))


def draw_orc_sprite(canvas, gx, gy):
    """Bigger orc enemy — dark green, tusks, axe."""
    px = gx * TILE + random.randint(0, TILE-10)
    py = gy * TILE + random.randint(2, TILE-11)
    d = ImageDraw.Draw(canvas)
    # Body
    d.rectangle([px+2, py+3, px+7, py+9], fill=(60, 100, 40))
    # Armor strap
    d.rectangle([px+2, py+5, px+7, py+6], fill=(70, 50, 30))
    # Head
    d.ellipse([px+2, py, px+7, py+5], fill=(80, 130, 50))
    # Tusks (white)
    d.point((px+3, py+4), fill=(240, 235, 220))
    d.point((px+5, py+4), fill=(240, 235, 220))
    # Eyes (yellow)
    d.point((px+3, py+2), fill=(240, 200, 50))
    d.point((px+5, py+2), fill=(240, 200, 50))
    # Axe handle
    d.line([(px+8, py+3), (px+8, py+8)], fill=(120, 80, 40))
    # Axe head
    d.polygon([(px+7, py+3), (px+10, py+2), (px+9, py+5)], fill=(180, 180, 195))


def draw_ghost_sprite(canvas, gx, gy):
    """Ghost — translucent floating spirit in ruins/dark forest."""
    px = gx * TILE + random.randint(2, TILE-8)
    py = gy * TILE + random.randint(2, TILE-9)
    layer = Image.new('RGBA', (8, 9), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Wispy body
    d.ellipse([1, 0, 7, 5], fill=(220, 230, 240, 180))
    d.rectangle([1, 3, 7, 7], fill=(220, 230, 240, 180))
    # Tattered bottom (zig-zag)
    d.polygon([(1, 7), (2, 9), (3, 7), (4, 9), (5, 7), (6, 9), (7, 7)],
              fill=(220, 230, 240, 180))
    # Eye holes (dark blue)
    d.point((3, 2), fill=(20, 30, 80, 230))
    d.point((5, 2), fill=(20, 30, 80, 230))
    canvas.alpha_composite(layer, (px, py))


def draw_lizardman_sprite(canvas, gx, gy):
    """Lizardman — green-scaled humanoid in swamps."""
    px = gx * TILE + random.randint(1, TILE-9)
    py = gy * TILE + random.randint(2, TILE-10)
    d = ImageDraw.Draw(canvas)
    # Body
    d.rectangle([px+2, py+3, px+5, py+8], fill=(70, 140, 90))
    d.line([(px+2, py+4), (px+2, py+8)], fill=(90, 170, 110))
    # Head (snout)
    d.ellipse([px+1, py, px+6, py+4], fill=(70, 140, 90))
    d.point((px+6, py+2), fill=(50, 110, 70))  # snout tip
    # Eyes (yellow slits)
    d.point((px+3, py+2), fill=(240, 220, 50))
    d.point((px+5, py+2), fill=(240, 220, 50))
    # Tail
    d.line([(px+1, py+6), (px-1, py+9)], fill=(70, 140, 90))
    # Spear
    d.line([(px+7, py+2), (px+7, py+9)], fill=(120, 80, 40))
    d.polygon([(px+7, py+1), (px+6, py+3), (px+8, py+3)], fill=(200, 200, 215))


def draw_troll_sprite(canvas, gx, gy):
    """Hulking troll — brown skin, club."""
    px = gx * TILE + random.randint(0, TILE-12)
    py = gy * TILE + random.randint(0, TILE-12)
    d = ImageDraw.Draw(canvas)
    # Big body
    d.rectangle([px+2, py+4, px+8, py+11], fill=(120, 90, 70))
    # Shading
    d.rectangle([px+2, py+4, px+3, py+11], fill=(150, 115, 90))
    # Head
    d.ellipse([px+2, py, px+8, py+6], fill=(130, 100, 75))
    # Eyes (small dark)
    d.point((px+3, py+3), fill=(40, 30, 20))
    d.point((px+6, py+3), fill=(40, 30, 20))
    # Snarl tusks
    d.point((px+4, py+5), fill=(240, 230, 200))
    d.point((px+6, py+5), fill=(240, 230, 200))
    # Huge club
    d.rectangle([px+8, py+5, px+10, py+11], fill=(100, 70, 40))
    d.line([(px+8, py+5), (px+10, py+5)], fill=(60, 40, 20))


def draw_sleeping_dragon_sprite(canvas, gx, gy):
    """6x4 sleeping dragon hidden in deep forest."""
    px, py = gx * TILE, gy * TILE
    w, h = TILE * 6, TILE * 4
    layer = Image.new('RGBA', (w + 76, h + 24), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ox, oy = 12, 10
    outline = (26, 28, 24)
    body = (154, 76, 48)
    body_dk = (82, 42, 34)
    body_mid = (118, 58, 42)
    body_lt = (218, 126, 72)
    belly = (238, 195, 104)
    belly_dk = (160, 118, 62)
    wing = (103, 72, 154)
    wing_dk = (45, 34, 86)
    horn = (225, 215, 168)
    gold = (246, 210, 70)

    # Nest shadow plus a few treasure glints peeking out under the body.
    d.ellipse([ox+1, oy+31, ox+w+10, oy+h+7], fill=(12, 24, 12, 215))
    d.ellipse([ox+7, oy+37, ox+w+3, oy+h+2], fill=(47, 52, 28, 210))
    d.ellipse([ox+22, oy+50, ox+68, oy+68], fill=(82, 55, 28, 190))
    for tx, ty in [(34, 57), (43, 61), (55, 55), (64, 63), (92, 58)]:
        d.point((ox+tx, oy+ty), fill=gold)
        d.point((ox+tx+1, oy+ty), fill=(255, 242, 120))

    # Far tail curl, drawn first so the body overlaps it.
    d.line([(ox+36, oy+49), (ox+16, oy+54), (ox+12, oy+68),
            (ox+30, oy+73), (ox+48, oy+67)],
           fill=outline, width=14)
    d.line([(ox+36, oy+49), (ox+16, oy+54), (ox+12, oy+68),
            (ox+30, oy+73), (ox+48, oy+67)],
           fill=body_dk, width=11)
    d.line([(ox+36, oy+49), (ox+18, oy+54), (ox+15, oy+67),
            (ox+31, oy+70), (ox+47, oy+65)],
           fill=body, width=7)
    d.polygon([(ox+47, oy+65), (ox+59, oy+58), (ox+55, oy+73)], fill=body_dk)
    d.polygon([(ox+50, oy+64), (ox+56, oy+61), (ox+55, oy+68)], fill=body_lt)

    # Folded wings with rib lines.
    left_wing = [(ox+38, oy+34), (ox+14, oy+8), (ox+62, oy+17), (ox+77, oy+42)]
    right_wing = [(ox+72, oy+33), (ox+104, oy+7), (ox+99, oy+44), (ox+84, oy+47)]
    d.polygon([(x-2, y+2) for x, y in left_wing], fill=outline)
    d.polygon(left_wing, fill=wing_dk)
    d.polygon([(ox+42, oy+33), (ox+22, oy+14), (ox+59, oy+21), (ox+70, oy+40)],
              fill=wing)
    d.polygon([(x+2, y+2) for x, y in right_wing], fill=outline)
    d.polygon(right_wing, fill=wing_dk)
    d.polygon([(ox+76, oy+33), (ox+99, oy+15), (ox+94, oy+40), (ox+85, oy+44)],
              fill=wing)
    for sx, sy, ex, ey in [(42, 33, 25, 15), (50, 33, 45, 18), (61, 36, 59, 21),
                           (78, 34, 98, 15), (84, 37, 94, 25), (88, 42, 95, 38)]:
        d.line([(ox+sx, oy+sy), (ox+ex, oy+ey)], fill=wing_dk)

    # Main sleeping coil: dark outline, body mass, and belly crescent.
    d.ellipse([ox+20, oy+18, ox+100, oy+74], fill=outline)
    d.ellipse([ox+24, oy+22, ox+96, oy+70], fill=body_dk)
    d.ellipse([ox+29, oy+25, ox+91, oy+66], fill=body)
    d.ellipse([ox+44, oy+35, ox+78, oy+58], fill=body_mid)
    d.arc([ox+38, oy+35, ox+84, oy+65], 10, 175, fill=belly, width=5)
    for sx in range(45, 77, 7):
        d.line([(ox+sx, oy+42), (ox+sx-2, oy+49)], fill=belly_dk)

    # Forelegs and claws tucked under the chest.
    for lx, ly in [(60, 61), (82, 60)]:
        d.ellipse([ox+lx-4, oy+ly-4, ox+lx+8, oy+ly+5], fill=body_dk)
        d.ellipse([ox+lx-2, oy+ly-3, ox+lx+6, oy+ly+3], fill=body)
        for c in range(3):
            d.point((ox+lx+5+c, oy+ly+4-c%2), fill=horn)

    # Neck, raised head, snout, horns, and readable sleeping face.
    # A small backing shadow keeps the face legible against forest canopies.
    d.ellipse([ox+96, oy+8, ox+153, oy+46], fill=(12, 24, 12, 215))
    d.line([(ox+82, oy+43), (ox+96, oy+27), (ox+116, oy+27)],
           fill=outline, width=17)
    d.line([(ox+83, oy+42), (ox+96, oy+28), (ox+116, oy+28)],
           fill=body_dk, width=13)
    d.line([(ox+85, oy+41), (ox+98, oy+29), (ox+116, oy+30)],
           fill=body, width=9)

    # Head dome and jaw. The face extends past the body footprint, so the
    # layer is intentionally wider than 6 tiles.
    d.ellipse([ox+103, oy+12, ox+140, oy+44], fill=outline)
    d.ellipse([ox+106, oy+15, ox+137, oy+41], fill=body_dk)
    d.ellipse([ox+109, oy+17, ox+134, oy+37], fill=body)
    d.polygon([(ox+127, oy+20), (ox+160, oy+27), (ox+158, oy+40),
               (ox+127, oy+39)], fill=outline)
    d.polygon([(ox+129, oy+23), (ox+155, oy+29), (ox+154, oy+37),
               (ox+129, oy+36)], fill=body_dk)
    d.polygon([(ox+130, oy+25), (ox+151, oy+30), (ox+150, oy+35),
               (ox+130, oy+34)], fill=body)

    # Big pale muzzle and cheek patch: this is the high-contrast face read.
    d.polygon([(ox+128, oy+28), (ox+151, oy+30), (ox+150, oy+36),
               (ox+133, oy+38), (ox+124, oy+34)], fill=outline)
    d.polygon([(ox+131, oy+29), (ox+148, oy+31), (ox+146, oy+35),
               (ox+134, oy+36), (ox+127, oy+33)], fill=belly)
    d.rectangle([ox+139, oy+31, ox+142, oy+33], fill=(10, 18, 10))
    d.point((ox+151, oy+31), fill=(10, 18, 10))
    d.point((ox+147, oy+37), fill=horn)

    # Closed eye with heavy brow line.
    d.line([(ox+116, oy+25), (ox+127, oy+25)], fill=outline, width=3)
    d.line([(ox+118, oy+28), (ox+126, oy+28)], fill=(8, 20, 8), width=2)
    d.point((ox+121, oy+29), fill=(255, 225, 120))

    # Large horns and cheek spikes.
    d.polygon([(ox+111, oy+18), (ox+105, oy+1), (ox+119, oy+16)], fill=outline)
    d.polygon([(ox+113, oy+17), (ox+107, oy+4), (ox+118, oy+16)], fill=horn)
    d.polygon([(ox+128, oy+19), (ox+137, oy+3), (ox+136, oy+22)], fill=outline)
    d.polygon([(ox+130, oy+18), (ox+136, oy+6), (ox+135, oy+21)], fill=horn)
    d.polygon([(ox+132, oy+38), (ox+139, oy+44), (ox+129, oy+42)], fill=outline)
    d.polygon([(ox+133, oy+38), (ox+137, oy+42), (ox+130, oy+41)], fill=horn)

    # Dorsal spikes following the back and tail.
    for sx, sy, size in [(38, 25, 7), (50, 21, 8), (63, 21, 8),
                         (76, 25, 7), (89, 34, 6), (99, 31, 5)]:
        d.polygon([(ox+sx, oy+sy), (ox+sx+4, oy+sy-size),
                   (ox+sx+8, oy+sy+1)], fill=body_dk)
    for sx, sy in [(39, 35), (51, 31), (66, 30), (80, 35), (91, 44)]:
        d.ellipse([ox+sx, oy+sy, ox+sx+6, oy+sy+4], fill=body_lt)

    # Subtle scale texture.
    for sx, sy in [(34, 46), (42, 52), (55, 38), (70, 53), (86, 47),
                   (96, 36), (112, 35)]:
        d.point((ox+sx, oy+sy), fill=body_lt)
        d.point((ox+sx+1, oy+sy), fill=body_mid)

    # Sleep puffs and a tiny snore mark.
    d.ellipse([ox+139, oy+23, ox+146, oy+29], fill=(218, 228, 218, 145))
    d.ellipse([ox+148, oy+15, ox+154, oy+21], fill=(218, 228, 218, 110))
    d.line([(ox+145, oy+12), (ox+150, oy+12), (ox+145, oy+18), (ox+151, oy+18)],
           fill=(210, 225, 210, 150))

    canvas.alpha_composite(layer, (px - 12, py - 10))


def draw_giant_spider_sprite(canvas, gx, gy):
    """Big spider — for dark forest / cave areas."""
    px = gx * TILE + random.randint(0, TILE-10)
    py = gy * TILE + random.randint(2, TILE-10)
    d = ImageDraw.Draw(canvas)
    # Body (segmented)
    d.ellipse([px+3, py+2, px+7, py+6], fill=(40, 25, 30))
    d.ellipse([px+2, py+4, px+8, py+8], fill=(50, 30, 35))
    # Red eyes
    d.point((px+4, py+3), fill=(220, 30, 30))
    d.point((px+6, py+3), fill=(220, 30, 30))
    # 8 legs splayed out
    for ang_i in range(4):
        ang = (ang_i * 0.5 - 0.7)
        ex = px+5 + math.cos(ang) * 5
        ey = py+5 + math.sin(ang) * 3
        d.line([(px+5, py+5), (ex, ey)], fill=(20, 15, 18))
        d.line([(px+5, py+5), (px+5-(ex-px-5), ey)], fill=(20, 15, 18))


# ── Animal sprites ────────────────────────────────────────────────────────

def draw_chicken_sprite(canvas, gx, gy):
    px = gx * TILE + random.randint(2, TILE-9)
    py = gy * TILE + random.randint(2, TILE-7)
    layer = Image.new('RGBA', (8, 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Body
    d.ellipse([1, 2, 7, 7], fill=C['flower_w'])
    # Head
    d.ellipse([4, 0, 8, 4], fill=C['flower_w'])
    # Comb
    d.point((6, 0), fill=C['flower_r'])
    d.point((5, 0), fill=C['flower_r'])
    # Beak
    d.point((7, 2), fill=C['flower_y'])
    # Eye
    d.point((6, 1), fill=(0, 0, 0))
    # Legs
    d.point((3, 7), fill=C['wood_dk'])
    d.point((5, 7), fill=C['wood_dk'])
    canvas.alpha_composite(layer, (px, py))


def draw_cow_sprite(canvas, gx, gy):
    px = gx * TILE + random.randint(0, TILE-12)
    py = gy * TILE + random.randint(0, TILE-9)
    layer = Image.new('RGBA', (12, 9), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Body
    d.rectangle([1, 3, 9, 7], fill=C['flower_w'])
    # Spots
    d.rectangle([2, 4, 4, 5], fill=(40, 40, 40))
    d.rectangle([6, 4, 8, 6], fill=(40, 40, 40))
    # Head
    d.rectangle([8, 2, 11, 6], fill=C['flower_w'])
    d.rectangle([10, 4, 11, 5], fill=(40, 40, 40))  # nose
    # Horns
    d.point((9, 1), fill=C['stone_dk'])
    d.point((10, 1), fill=C['stone_dk'])
    # Legs
    d.rectangle([2, 7, 3, 9], fill=C['flower_w'])
    d.rectangle([7, 7, 8, 9], fill=C['flower_w'])
    canvas.alpha_composite(layer, (px, py))


def draw_sheep_sprite(canvas, gx, gy):
    px = gx * TILE + random.randint(0, TILE-10)
    py = gy * TILE + random.randint(0, TILE-8)
    layer = Image.new('RGBA', (10, 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Fluffy body
    d.ellipse([0, 2, 8, 7], fill=C['flower_w'])
    d.ellipse([1, 1, 4, 4], fill=C['flower_w'])
    d.ellipse([4, 1, 7, 4], fill=C['flower_w'])
    # Head
    d.ellipse([6, 3, 10, 7], fill=(60, 50, 40))
    # Eye
    d.point((8, 5), fill=(0, 0, 0))
    # Legs
    d.point((2, 7), fill=(60, 50, 40))
    d.point((6, 7), fill=(60, 50, 40))
    canvas.alpha_composite(layer, (px, py))


# ── Fence segments ────────────────────────────────────────────────────────

def draw_fence_sprite(canvas, gx, gy, orient='h'):
    """Wooden fence section. orient='h' for horizontal post line, 'v' for vertical."""
    px, py = gx * TILE, gy * TILE
    layer = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    if orient == 'h':
        # Horizontal rail across the top of the tile
        # Two posts + a rail between them
        d.line([(0, 11), (TILE-1, 11)], fill=C['wood_dk'])
        d.line([(0, 12), (TILE-1, 12)], fill=C['wood'])
        # Posts
        for px_ in (3, TILE-5):
            d.rectangle([px_, 6, px_+2, 14], fill=C['wood_dk'])
            d.rectangle([px_, 6, px_+1, 14], fill=C['wood'])
            d.polygon([(px_, 6), (px_+2, 6), (px_+1, 4)], fill=C['wood_dk'])
    else:
        d.line([(TILE//2-1, 0), (TILE//2-1, TILE-1)], fill=C['wood_dk'])
        d.line([(TILE//2, 0), (TILE//2, TILE-1)], fill=C['wood'])
        # Cross rails
        for py_ in (4, 12):
            d.rectangle([TILE//2 - 5, py_, TILE//2 + 5, py_+2], fill=C['wood'])
            d.rectangle([TILE//2 - 5, py_, TILE//2 + 5, py_], fill=C['wood_dk'])
    canvas.alpha_composite(layer, (px, py))


# ── Decoration sprites ────────────────────────────────────────────────────

def draw_flower(d, px, py, color):
    """Tiny flower."""
    cx = px + TILE//2 + random.randint(-3, 3)
    cy = py + TILE//2 + random.randint(-3, 3)
    d.point((cx-1, cy), fill=color); d.point((cx+1, cy), fill=color)
    d.point((cx, cy-1), fill=color); d.point((cx, cy+1), fill=color)
    d.point((cx, cy), fill=C['flower_y'])

def draw_mushroom(d, px, py):
    cx = px + TILE//2 + random.randint(-3, 3)
    cy = py + TILE//2 + random.randint(-2, 2)
    d.rectangle([cx-1, cy+1, cx+1, cy+3], fill=C['wall'])
    d.ellipse([cx-3, cy-2, cx+3, cy+1], fill=C['flower_r'])
    d.point((cx-1, cy-1), fill=C['wall'])
    d.point((cx+1, cy), fill=C['wall'])

def draw_shell(d, px, py):
    cx = px + TILE//2 + random.randint(-3, 3)
    cy = py + TILE//2 + random.randint(-3, 3)
    d.ellipse([cx-2, cy-2, cx+2, cy+2], fill=C['flower_w'])
    d.point((cx, cy), fill=C['flower_p'])

def draw_rock(d, px, py):
    cx = px + TILE//2 + random.randint(-3, 3)
    cy = py + TILE//2 + random.randint(-3, 3)
    d.ellipse([cx-3, cy-2, cx+3, cy+2], fill=C['mountain_dk'])
    d.ellipse([cx-2, cy-2, cx+2, cy+1], fill=C['mountain'])
    d.point((cx-1, cy-1), fill=C['mountain_lt'])

def draw_reed(d, px, py):
    cx = px + TILE//2 + random.randint(-3, 3)
    cy = py + TILE//2 + random.randint(-2, 2)
    d.line([(cx, cy+3), (cx, cy-3)], fill=C['grass_dk'])
    d.line([(cx+2, cy+3), (cx+2, cy-2)], fill=C['grass_dk'])
    d.point((cx, cy-3), fill=C['wood'])
    d.point((cx+2, cy-2), fill=C['wood'])

def draw_lone_tree(d, px, py):
    cx = px + TILE//2 + random.randint(-2, 2)
    cy = py + TILE//2 + random.randint(-2, 2)
    d.rectangle([cx, cy+2, cx+1, cy+4], fill=C['wood_dk'])
    d.ellipse([cx-3, cy-3, cx+4, cy+3], fill=C['tree_dk'])
    d.ellipse([cx-2, cy-2, cx+3, cy+2], fill=C['tree'])
    d.point((cx-1, cy-1), fill=C['tree_lt'])


# ════════════════════════════════════════════════════════════════════════
# MAIN RENDER
# ════════════════════════════════════════════════════════════════════════

def render_tiles(biome):
    canvas = Image.new('RGBA', (W, H), C['ocean'])
    d = ImageDraw.Draw(canvas)
    for y in range(MAP_H):
        for x in range(MAP_W):
            px = x * TILE; py = y * TILE
            t = int(biome[y, x])
            v = variant(x, y)
            if   t == OCEAN:        draw_ocean(d, px, py, v, deep=False)
            elif t == DEEP:         draw_ocean(d, px, py, v, deep=True)
            elif t == BEACH:        draw_beach(d, px, py, v)
            elif t == SAND:         draw_sand(d, px, py, v)
            elif t == GRASS:        draw_grass(d, px, py, v)
            elif t == GRASS_LUSH:   draw_grass_lush(d, px, py, v)
            elif t == FOREST:       draw_forest(d, px, py, v)
            elif t == F_DENSE:      draw_forest_dense(d, px, py, v)
            elif t == F_DARK:       draw_forest_dark(d, px, py, v)
            elif t == ORCHARD:      draw_orchard(d, px, py, v)
            elif t == AUTUMN_FOREST: draw_autumn_forest(d, px, py, v)
            elif t == CHERRY_GROVE: draw_cherry_grove(d, px, py, v)
            elif t == BAMBOO_GROVE: draw_bamboo_grove(d, px, py, v)
            elif t == WHEAT_FIELD:  draw_wheat_field(d, px, py, v)
            elif t == DESERT:       draw_desert(d, px, py, v)
            elif t == SWAMP:        draw_swamp(d, px, py, v)
            elif t == MOUNT:        draw_mountain(d, px, py, v)
            elif t == SNOW:         draw_snow(d, px, py, v)
            elif t == LAKE:         draw_water(d, px, py, v)
            elif t == RIVER:        draw_water(d, px, py, v)
            elif t == PATH:         draw_path_autotile(d, biome, y, x, px, py, v)
            elif t == HIGHWAY:      draw_highway_autotile(d, biome, y, x, px, py, v)
            elif t == TRAIL:        draw_trail_autotile(d, biome, y, x, px, py, v)
            elif t == FARM_V:       draw_farm(d, px, py, v, 'v')
            elif t == FARM_H:       draw_farm(d, px, py, v, 'h')
            elif t == STONE_FLOOR:  draw_stone_floor(d, px, py, v)
            elif t == BRIDGE:       draw_bridge(d, px, py, v)
            elif t in (HOUSE, CASTLE):
                # Draw underlying grass; the multi-tile sprite goes on top later
                draw_grass(d, px, py, v)
    return canvas


def render_decorations(canvas, decorations):
    """Multi-pass: flora → fences → discoveries → props → buildings → animals."""
    d = ImageDraw.Draw(canvas)
    bldg_layer    = []
    fence_layer   = []
    prop_layer    = []
    animal_layer  = []
    wild_layer    = []
    enemy_layer   = []
    top_layer     = []
    flora_layer   = []
    discovery_layer = []

    BLDG       = {'house','cottage','windmill','castle','big_house','church','barn','watchtower'}
    PROP       = {'well','lamp','sign','barrel','cart','hay_bale','statue','grave',
                  'pumpkin','berry'}
    FARM_ANI   = {'chicken','cow','sheep'}
    WILD_ANI   = {'deer','rabbit','fox','wolf','bird'}
    ENEMY      = {'skeleton','slime','goblin','orc','ghost','lizardman',
                  'troll','giant_spider'}
    DISCOVERY  = {'stone_circle','cave','treasure','ruined_tower','witch_hut',
                  'forest_chest','hidden_cache','ambush_camp',
                  'magic_circle','dock','ancient_gate','crystal','campfire',
                  'obelisk','skull','portal','hot_spring','giant_mushroom',
                  'hermit_cave','old_mill','monolith','shipwreck','sacred_tree',
                  'totem','beehive','stone_bridge','lighthouse','mage_tower',
                  'mine','boat','pagoda','cabin','tent',
                  'mushroom_village','crystal_pillar','whale_bones','bandit_camp',
                  'spider_lair','eagles_nest','wagon_graveyard','knight_tomb',
                  'glowing_meadow','phoenix_nest','buried_giant','wishing_pond',
                  'sail_ship','sea_stack','sea_monster','sunken_ruins',
                  'buoy','floating_barrel',
                  'sky_island','volcano','world_tree','sunken_city','pyramid',
                  'sleeping_dragon'}

    for deco in decorations:
        k = deco[0]
        if k == 'sleeping_dragon': top_layer.append(deco)
        elif k in BLDG:     bldg_layer.append(deco)
        elif k == 'fence':  fence_layer.append(deco)
        elif k in PROP:     prop_layer.append(deco)
        elif k in FARM_ANI: animal_layer.append(deco)
        elif k in WILD_ANI: wild_layer.append(deco)
        elif k in ENEMY:    enemy_layer.append(deco)
        elif k in DISCOVERY: discovery_layer.append(deco)
        else:               flora_layer.append(deco)

    # Pass 1: small flora (under everything)
    for deco in flora_layer:
        k = deco[0]; x, y = deco[1], deco[2]
        px, py = x * TILE, y * TILE
        if k == 'flower':
            color = random.choice([C['flower_r'], C['flower_w'],
                                   C['flower_p'], C['flower_y'], C['flower_b']])
            draw_flower(d, px, py, color)
        elif k == 'mushroom':  draw_mushroom(d, px, py)
        elif k == 'shell':     draw_shell(d, px, py)
        elif k == 'rock':      draw_rock(d, px, py)
        elif k == 'reed':      draw_reed(d, px, py)
        elif k == 'lone_tree': draw_lone_tree(d, px, py)

    # Pass 2: fences
    for fdeco in fence_layer:
        _, fx, fy, orient = fdeco
        draw_fence_sprite(canvas, fx, fy, orient)

    # Pass 3: discoveries (the fun stuff)
    for k, x, y in discovery_layer:
        if k == 'stone_circle': draw_stone_circle_sprite(canvas, x, y)
        elif k == 'cave':       draw_cave_sprite(canvas, x, y)
        elif k in ('treasure', 'forest_chest', 'hidden_cache'):
            draw_treasure_chest_sprite(canvas, x, y)
        elif k == 'ruined_tower': draw_ruined_tower_sprite(canvas, x, y)
        elif k == 'witch_hut':  draw_witch_hut_sprite(canvas, x, y)
        elif k == 'magic_circle': draw_magic_circle_sprite(canvas, x, y)
        elif k == 'dock':       draw_dock_sprite(canvas, x, y)
        elif k == 'ancient_gate': draw_ancient_gate_sprite(canvas, x, y)
        elif k == 'crystal':    draw_crystal_sprite(canvas, x, y)
        elif k == 'campfire':   draw_campfire_sprite(canvas, x, y)
        elif k == 'obelisk':    draw_obelisk_sprite(canvas, x, y)
        elif k == 'skull':      draw_skull_pile_sprite(canvas, x, y)
        elif k == 'portal':     draw_portal_sprite(canvas, x, y)
        elif k == 'hot_spring': draw_hot_spring_sprite(canvas, x, y)
        elif k == 'giant_mushroom': draw_giant_mushroom_sprite(canvas, x, y)
        elif k == 'hermit_cave': draw_hermit_cave_sprite(canvas, x, y)
        elif k == 'old_mill':   draw_old_mill_sprite(canvas, x, y)
        elif k == 'monolith':   draw_monolith_sprite(canvas, x, y)
        elif k == 'shipwreck':  draw_shipwreck_sprite(canvas, x, y)
        elif k == 'sacred_tree': draw_sacred_tree_sprite(canvas, x, y)
        elif k == 'totem':      draw_totem_sprite(canvas, x, y)
        elif k == 'beehive':    draw_beehive_sprite(canvas, x, y)
        elif k == 'stone_bridge': draw_stone_bridge_sprite(canvas, x, y)
        elif k == 'lighthouse': draw_lighthouse_sprite(canvas, x, y)
        elif k == 'mage_tower': draw_mage_tower_sprite(canvas, x, y)
        elif k == 'mine':       draw_mine_entrance_sprite(canvas, x, y)
        elif k == 'boat':       draw_boat_sprite(canvas, x, y)
        elif k == 'pagoda':     draw_pagoda_sprite(canvas, x, y)
        elif k == 'cabin':      draw_log_cabin_sprite(canvas, x, y)
        elif k == 'tent':       draw_tent_sprite(canvas, x, y)
        elif k == 'mushroom_village': draw_mushroom_village_sprite(canvas, x, y)
        elif k == 'crystal_pillar':   draw_crystal_pillar_sprite(canvas, x, y)
        elif k == 'whale_bones':      draw_whale_bones_sprite(canvas, x, y)
        elif k == 'bandit_camp':      draw_bandit_camp_sprite(canvas, x, y)
        elif k == 'ambush_camp':      draw_bandit_camp_sprite(canvas, x, y)
        elif k == 'spider_lair':      draw_spider_lair_sprite(canvas, x, y)
        elif k == 'eagles_nest':      draw_eagles_nest_sprite(canvas, x, y)
        elif k == 'wagon_graveyard':  draw_wagon_graveyard_sprite(canvas, x, y)
        elif k == 'knight_tomb':      draw_knight_tomb_sprite(canvas, x, y)
        elif k == 'glowing_meadow':   draw_glowing_meadow_sprite(canvas, x, y)
        elif k == 'phoenix_nest':     draw_phoenix_nest_sprite(canvas, x, y)
        elif k == 'buried_giant':     draw_buried_giant_sprite(canvas, x, y)
        elif k == 'wishing_pond':     draw_wishing_pond_sprite(canvas, x, y)
        elif k == 'sail_ship':        draw_sail_ship_sprite(canvas, x, y)
        elif k == 'sea_stack':        draw_sea_stack_sprite(canvas, x, y)
        elif k == 'sea_monster':      draw_sea_monster_sprite(canvas, x, y)
        elif k == 'sunken_ruins':     draw_sunken_ruins_sprite(canvas, x, y)
        elif k == 'buoy':             draw_buoy_sprite(canvas, x, y)
        elif k == 'floating_barrel':  draw_floating_barrel_sprite(canvas, x, y)
        # Super-secrets
        elif k == 'sky_island':       draw_sky_island_sprite(canvas, x, y)
        elif k == 'volcano':          draw_volcano_sprite(canvas, x, y)
        elif k == 'world_tree':       draw_world_tree_sprite(canvas, x, y)
        elif k == 'sunken_city':      draw_sunken_city_sprite(canvas, x, y)
        elif k == 'pyramid':          draw_pyramid_sprite(canvas, x, y)

    # Pass 4: small props
    for k, x, y in prop_layer:
        if   k == 'well':     draw_well_sprite(canvas, x, y)
        elif k == 'lamp':     draw_lamp_post_sprite(canvas, x, y)
        elif k == 'sign':     draw_sign_post_sprite(canvas, x, y)
        elif k == 'barrel':   draw_barrel_sprite(canvas, x, y)
        elif k == 'cart':     draw_cart_sprite(canvas, x, y)
        elif k == 'hay_bale': draw_hay_bale_sprite(canvas, x, y)
        elif k == 'statue':   draw_statue_sprite(canvas, x, y)
        elif k == 'grave':    draw_grave_sprite(canvas, x, y)
        elif k == 'pumpkin':  draw_pumpkin_sprite(canvas, x, y)
        elif k == 'berry':    draw_berry_bush_sprite(canvas, x, y)

    # Pass 5: large structures, sorted by y for depth ordering
    bldg_layer.sort(key=lambda b: b[2])
    for deco in bldg_layer:
        k = deco[0]; x = deco[1]; y = deco[2]
        if   k == 'house':      draw_house_sprite(canvas, x, y)
        elif k == 'cottage':    draw_house_sprite(canvas, x, y)
        elif k == 'big_house':  draw_big_house_sprite(canvas, x, y)
        elif k == 'church':     draw_church_sprite(canvas, x, y)
        elif k == 'barn':       draw_barn_sprite(canvas, x, y)
        elif k == 'watchtower': draw_watchtower_sprite(canvas, x, y)
        elif k == 'windmill':   draw_windmill_sprite(canvas, x, y)
        elif k == 'castle':
            style = deco[3] if len(deco) > 3 else None
            draw_castle_sprite(canvas, x, y, style=style)

    # Pass 6: farm animals
    for k, x, y in animal_layer:
        if   k == 'chicken': draw_chicken_sprite(canvas, x, y)
        elif k == 'cow':     draw_cow_sprite(canvas, x, y)
        elif k == 'sheep':   draw_sheep_sprite(canvas, x, y)

    # Pass 7: wild animals (on top)
    for k, x, y in wild_layer:
        if   k == 'deer':    draw_deer_sprite(canvas, x, y)
        elif k == 'rabbit':  draw_rabbit_sprite(canvas, x, y)
        elif k == 'fox':     draw_fox_sprite(canvas, x, y)
        elif k == 'wolf':    draw_wolf_sprite(canvas, x, y)
        elif k == 'bird':    draw_bird_sprite(canvas, x, y)

    # Pass 8: enemies and monsters above wildlife
    for k, x, y in enemy_layer:
        if   k == 'skeleton':     draw_skeleton_sprite(canvas, x, y)
        elif k == 'slime':        draw_slime_sprite(canvas, x, y)
        elif k == 'goblin':       draw_goblin_sprite(canvas, x, y)
        elif k == 'orc':          draw_orc_sprite(canvas, x, y)
        elif k == 'ghost':        draw_ghost_sprite(canvas, x, y)
        elif k == 'lizardman':    draw_lizardman_sprite(canvas, x, y)
        elif k == 'troll':        draw_troll_sprite(canvas, x, y)
        elif k == 'giant_spider': draw_giant_spider_sprite(canvas, x, y)

    # Pass 9: huge secrets that must sit above forest canopy and small actors.
    for k, x, y in top_layer:
        if k == 'sleeping_dragon':
            draw_sleeping_dragon_sprite(canvas, x, y)


# ════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════

def main():
    print(f"Generating {MAP_W}×{MAP_H} world ({W}×{H} px), seed={SEED}…")
    biome, elev, moist = assign_biomes()

    rivers = carve_rivers(biome, elev, n_rivers=random.randint(3, 7))
    place_lakes(biome, n=random.randint(4, 8))
    add_inter_island_bridges(biome)
    offshore_islands = place_offshore_islands(biome, n=random.randint(4, 8))

    decorations = []
    landmarks = []
    landmarks_by_kind = {'castle': [], 'town': [], 'village': [],
                         'farmstead': [], 'discovery': []}

    # Randomize number of castles: usually 1, sometimes 0 or 2
    n_castles = random.choices([0, 1, 1, 1, 2], k=1)[0]
    for _ in range(n_castles):
        castle_gate = place_castle(biome, decorations)
        if castle_gate:
            landmarks.append(castle_gate)
            landmarks_by_kind['castle'].append(castle_gate)

    # Randomize town count for this world
    n_towns      = random.randint(2, 5)
    n_villages   = random.randint(5, 12)
    n_farmsteads = random.randint(3, 8)

    print(f"  generating {n_castles} castle(s), {n_towns} town(s), "
          f"{n_villages} village(s), {n_farmsteads} farmstead(s)")

    town_centers = list(landmarks)
    town_kinds = (['town'] * n_towns +
                  ['village'] * n_villages +
                  ['farmstead'] * n_farmsteads)
    random.shuffle(town_kinds)
    for kind in town_kinds:
        gate = place_town(biome, decorations, kind=kind, avoid=town_centers)
        if gate:
            landmarks.append(gate)
            landmarks_by_kind[kind].append(gate)
            town_centers.append(gate)

    # Place special biome patches — sparse cherry groves (only 0-2, and mixed
    # with regular forest cells so they don't look like solid pink blocks)
    for _ in range(random.randint(0, 2)):
        spot = find_flat_area(biome, 5, 4)
        if spot:
            sx, sy = spot
            for dy in range(4):
                for dx in range(5):
                    # Only ~60% of the patch becomes cherry, rest stays as forest
                    if random.random() < 0.6:
                        biome[sy+dy, sx+dx] = CHERRY_GROVE
                    else:
                        biome[sy+dy, sx+dx] = FOREST
    for _ in range(4):
        spot = find_flat_area(biome, 7, 5)
        if spot:
            sx, sy = spot
            for dy in range(5):
                for dx in range(7):
                    biome[sy+dy, sx+dx] = WHEAT_FIELD

    place_orchard(biome)
    place_farms(biome, n=8)
    place_outlying_cottages(biome, decorations, n=12)
    place_windmills(biome, decorations, n=5)

    # Small cemetery somewhere
    pos = find_flat_area(biome, 4, 4)
    if pos:
        cx_, cy_ = pos
        for dy in range(4):
            for dx in range(4):
                if random.random() < 0.65:
                    decorations.append(('grave', cx_+dx, cy_+dy))

    # Scatter a watchtower on high ground
    for _ in range(60):
        wx = random.randint(2, MAP_W-3)
        wy = random.randint(3, MAP_H-3)
        if biome[wy, wx] in (GRASS, GRASS_LUSH) and \
           biome[wy-1, wx] in (GRASS, GRASS_LUSH) and \
           biome[wy-2, wx] in (GRASS, GRASS_LUSH):
            decorations.append(('watchtower', wx, wy))
            biome[wy, wx] = HOUSE
            break

    # Outlying buildings count as "farmsteads" for the road network
    for deco in decorations:
        k = deco[0]
        if k in ('house', 'cottage', 'big_house', 'barn',
                 'windmill', 'watchtower'):
            pos = (deco[1], deco[2])
            landmarks.append(pos)
            landmarks_by_kind['farmstead'].append(pos)

    # Place SUPER-SECRETS first (the legendary spots) — they reserve their
    # cells so other systems won't overwrite them.
    place_super_secrets(biome, decorations, offshore_islands)

    # Place ordinary discoveries
    place_discoveries(biome, decorations)
    # Record discovery positions so trails can be carved to them
    DISCOVERY_KINDS = {'stone_circle','cave','treasure','forest_chest',
                       'hidden_cache','ambush_camp','sleeping_dragon',
                       'ruined_tower','witch_hut',
                       'magic_circle','dock','ancient_gate','crystal','campfire',
                       'obelisk','skull','portal','hot_spring','giant_mushroom',
                       'hermit_cave','old_mill','monolith','shipwreck','sacred_tree',
                       'totem','beehive','stone_bridge','lighthouse','mage_tower',
                       'mine','boat','pagoda','cabin','tent',
                       'mushroom_village','crystal_pillar','whale_bones','bandit_camp',
                       'spider_lair','eagles_nest','wagon_graveyard','knight_tomb',
                       'glowing_meadow','phoenix_nest','buried_giant','wishing_pond'}
    for deco in decorations:
        if deco[0] in DISCOVERY_KINDS:
            landmarks_by_kind['discovery'].append((deco[1], deco[2]))

    # Build the hierarchical road system
    build_road_network(biome, decorations, landmarks_by_kind)

    # Remove any FENCES that ended up on road tiles (so paths aren't blocked).
    # Fences are placed during place_town BEFORE roads are carved, so this
    # cleanup step is needed to gap them where roads pass through.
    ROAD_TYPES = (PATH, HIGHWAY, TRAIL, BRIDGE, STONE_FLOOR)
    before = len(decorations)
    decorations[:] = [
        d for d in decorations
        if not (d[0] == 'fence'
                and 0 <= d[2] < MAP_H and 0 <= d[1] < MAP_W
                and biome[d[2], d[1]] in ROAD_TYPES)
    ]
    # Also remove fences adjacent to a road on the same axis as their orientation
    # (e.g. a horizontal fence right next to a vertical path tile would still
    # block the road from being entered)
    new_decos = []
    for d in decorations:
        if d[0] != 'fence':
            new_decos.append(d)
            continue
        _, fx, fy, orient = d
        # Check the tile DIRECTLY across the fence — if it's a road and the
        # fence is perpendicular to that road, drop the fence.
        cross_y = fy + (1 if orient == 'h' else 0)
        cross_y_other = fy + (-1 if orient == 'h' else 0)
        cross_x = fx + (1 if orient == 'v' else 0)
        cross_x_other = fx + (-1 if orient == 'v' else 0)
        def is_road(rx, ry):
            if not (0 <= ry < MAP_H and 0 <= rx < MAP_W): return False
            return biome[ry, rx] in ROAD_TYPES
        if (orient == 'h' and (is_road(fx, cross_y) or is_road(fx, cross_y_other))):
            continue
        if (orient == 'v' and (is_road(cross_x, fy) or is_road(cross_x_other, fy))):
            continue
        new_decos.append(d)
    decorations[:] = new_decos
    print(f"  removed {before - len(decorations)} fence segments blocking paths")

    # Contextual features (ruins along roads, bandits in forest, etc.)
    place_contextual_features(biome, decorations)
    place_hidden_forest_content(biome, decorations)

    scatter_decorations(biome, decorations)
    scatter_wildlife(biome, decorations)
    populate_offshore_islands(biome, decorations, offshore_islands)
    scatter_ocean_features(biome, decorations)

    print("Rendering tiles…")
    canvas = render_tiles(biome)

    print("Rendering forest canopies…")
    render_forest_canopies(canvas, biome)

    print("Drawing coastline…")
    draw_coastline_layer(canvas, biome)

    print("Rendering decorations & buildings…")
    render_decorations(canvas, decorations)
    print(f"Exporting gameplay data -> {DATA_OUT}")
    solid = build_solid_mask(biome, decorations)
    export_world_data(biome, solid, landmarks_by_kind)
    print(f"Slicing art chunks -> {CHUNK_DIR}")
    slice_world_chunks(canvas)

    print(f"Saving → {OUT}")
    canvas.convert('RGB').save(str(OUT))
    print("Done.")


if __name__ == '__main__':
    main()
