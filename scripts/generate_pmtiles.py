# /// script
# dependencies = [
#   "pillow",
#   "pmtiles",
# ]
# ///

"""Generate Silkroad map tiles, navmeshes, and PMTiles archives."""

import argparse
import glob
import io
import json
import math
import os
import re
import struct
import tempfile
from collections import defaultdict

from PIL import Image, ImageDraw
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write


def convert_ddj_to_webp(input_path, output_path):
    try:
        with open(input_path, "rb") as f:
            # Skip 20-byte JMX header
            f.seek(20)
            dds_data = f.read()

        # Use io.BytesIO to feed to Pillow
        img = Image.open(io.BytesIO(dds_data))
        # Convert to RGB (DDS can be various formats, minimaps are usually DXT1/RGB)
        img = img.convert("RGB")

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        img.save(output_path, "WEBP", quality=80)
        return True
    except Exception as e:
        print(f"  [!] Error converting {input_path}: {e}")
        return False


def convert_minimaps(media_dir, output_dir):
    world_src = os.path.join(media_dir, "minimap")
    world_dst = os.path.join(output_dir, "8")

    dungeon_src = os.path.join(media_dir, "minimap_d")
    dungeon_dst = os.path.join(output_dir, "d", "8")

    # Process World Map
    if os.path.isdir(world_src):
        print(f"Processing World Map from {world_src}...")
        files = glob.glob(os.path.join(world_src, "*.ddj"))
        count = 0
        for i, f in enumerate(files, 1):
            basename = os.path.basename(f).replace(".ddj", ".webp")
            if convert_ddj_to_webp(f, os.path.join(world_dst, basename)):
                count += 1
            if i % 500 == 0:
                print(f"  Processed {i}/{len(files)}...")
        print(f"Done! Converted {count} world tiles.")
    else:
        print(f"Skipping World Map: {world_src} not found.")

    # Process Dungeons
    if os.path.isdir(dungeon_src):
        print(f"\nProcessing Dungeons from {dungeon_src}...")
        count = 0
        for root, dirs, files in os.walk(dungeon_src):
            for f in files:
                if f.endswith(".ddj"):
                    input_path = os.path.join(root, f)
                    basename = f.replace(".ddj", ".webp")
                    if convert_ddj_to_webp(input_path, os.path.join(dungeon_dst, basename)):
                        count += 1
        print(f"Done! Converted {count} dungeon tiles.")
    else:
        print(f"Skipping Dungeons: {dungeon_src} not found.")


TILE_SIZE = 256
BASE_ZOOM = 8
MIN_ZOOM = 3
MAX_ZOOM = 9
WEBP_QUALITY = 80

BASE_DIR = os.path.join("map", "public", "assets", "img", "silkroad", "minimap")
DUNGEON_DIR = os.path.join(BASE_DIR, "d")


def load_tile(path):
    """Load a tile image, return None if file not found."""
    if os.path.exists(path):
        try:
            return Image.open(path).convert("RGB")
        except Exception as e:
            print(f"  [!] Error loading {path}: {e}")
    return None


def save_tile(img, path):
    """Save a tile as WEBP."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "WEBP", quality=WEBP_QUALITY)


# ---------------------------------------------------------------------------
#  Generate lower zoom levels (z-1 ... MIN_ZOOM): merge 2×2 → 1
# ---------------------------------------------------------------------------


def generate_lower_zooms(tiles_by_zoom, zoom_dir_fn, tile_path_fn):
    """
    Recursively generates levels from BASE_ZOOM-1 down to MIN_ZOOM.

    tiles_by_zoom : dict[zoom] -> dict[(x,y)] -> Image
    zoom_dir_fn   : zoom -> path to zoom level directory
    tile_path_fn  : (zoom, x, y) -> path to tile file
    """
    for z in range(BASE_ZOOM - 1, MIN_ZOOM - 1, -1):
        parent_tiles = tiles_by_zoom[z + 1]
        if not parent_tiles:
            print(f"  Level {z}: no source tiles, skipping")
            break

        # Determine parent tile coordinates at the current level
        # Y in files is inverted (tile.y = -tile.y), so parent_y = -(-y // 2)
        parent_coords = set()
        for x, y in parent_tiles:
            parent_coords.add((x // 2, -(-y // 2)))

        current_tiles = {}
        for px, py in parent_coords:
            merged = Image.new("RGB", (TILE_SIZE * 2, TILE_SIZE * 2))
            has_any = False
            # Children of parent py: y=2py (north/top) and y=2py-1 (south/bottom)
            for dx in (0, 1):
                for child_y, img_y in ((2 * py, 0), (2 * py - 1, TILE_SIZE)):
                    child = parent_tiles.get((2 * px + dx, child_y))
                    if child:
                        merged.paste(child, (dx * TILE_SIZE, img_y))
                        has_any = True

            if has_any:
                resized = merged.resize((TILE_SIZE, TILE_SIZE), Image.LANCZOS)
                if z in (3, 6):
                    path = tile_path_fn(z, px, py)
                    save_tile(resized, path)
                current_tiles[(px, py)] = resized

        tiles_by_zoom[z] = current_tiles
        print(f"  Level {z}: {len(current_tiles)} tiles")


# ---------------------------------------------------------------------------
#  Generate higher zoom level (9): split 1 → 2×2
# ---------------------------------------------------------------------------


def generate_higher_zoom(tiles_z8, tile_path_fn):
    """
    Generates MAX_ZOOM level (9) from BASE_ZOOM level (8).
    Each tile is split into 4 quadrants, each scaled to TILE_SIZE.
    """
    count = 0
    for (x, y), img in tiles_z8.items():
        scaled = img.resize((TILE_SIZE * 2, TILE_SIZE * 2), Image.LANCZOS)
        # Top half (img_y=0) → child y=2y (north)
        # Bottom half (img_y=1) → child y=2y-1 (south)
        for dx in (0, 1):
            for img_y, child_y in ((0, 2 * y), (1, 2 * y - 1)):
                crop = scaled.crop((dx * TILE_SIZE, img_y * TILE_SIZE, (dx + 1) * TILE_SIZE, (img_y + 1) * TILE_SIZE))
                path = tile_path_fn(MAX_ZOOM, 2 * x + dx, child_y)
                save_tile(crop, path)
                count += 1

    print(f"  Level {MAX_ZOOM}: {count} tiles")


# ---------------------------------------------------------------------------
#  World map
# ---------------------------------------------------------------------------


def process_world_map():
    print("=" * 60)
    print("World map")
    print("=" * 60)

    zoom8_dir = os.path.join(BASE_DIR, str(BASE_ZOOM))
    if not os.path.isdir(zoom8_dir):
        print(f"  Directory {zoom8_dir} not found, skipping.")
        return

    # Load all level 8 tiles
    pattern = re.compile(r"^(-?\d+)x(-?\d+)\.webp$", re.IGNORECASE)
    tiles_z8 = {}
    files = [f for f in os.listdir(zoom8_dir) if pattern.match(f)]
    total = len(files)
    print(f"  Loading level {BASE_ZOOM}: {total} tiles...")

    for i, fname in enumerate(files, 1):
        m = pattern.match(fname)
        x, y = int(m.group(1)), int(m.group(2))
        img = load_tile(os.path.join(zoom8_dir, fname))
        if img:
            tiles_z8[(x, y)] = img
        if i % 500 == 0 or i == total:
            print(f"    {i}/{total}")

    print(f"  Loaded {len(tiles_z8)} tiles at level {BASE_ZOOM}")

    def tile_path(z, x, y):
        return os.path.join(BASE_DIR, str(z), f"{x}x{y}.webp")

    # Lower zoom levels
    print("  Generating lower zoom levels (7 -> 3)...")
    tiles_by_zoom = defaultdict(dict)
    tiles_by_zoom[BASE_ZOOM] = tiles_z8
    generate_lower_zooms(tiles_by_zoom, None, tile_path)

    # Higher zoom level
    print("  Generating higher zoom level (9)...")
    generate_higher_zoom(tiles_z8, tile_path)

    # Free memory
    del tiles_by_zoom
    del tiles_z8


# ---------------------------------------------------------------------------
#  Dungeons
# ---------------------------------------------------------------------------


def process_dungeon_maps():
    print()
    print("=" * 60)
    print("Dungeons")
    print("=" * 60)

    zoom8_dir = os.path.join(DUNGEON_DIR, str(BASE_ZOOM))
    if not os.path.isdir(zoom8_dir):
        print(f"  Directory {zoom8_dir} not found, skipping.")
        return

    # Parse filenames: {prefix}_{x}x{y}.webp
    pattern = re.compile(r"^(.+)_(-?\d+)x(-?\d+)\.webp$", re.IGNORECASE)

    # Group by prefix
    groups = defaultdict(dict)
    for fname in os.listdir(zoom8_dir):
        m = pattern.match(fname)
        if m:
            prefix = m.group(1)
            x, y = int(m.group(2)), int(m.group(3))
            groups[prefix][(x, y)] = fname

    print(f"  Found {len(groups)} dungeon maps")

    for prefix, coords in sorted(groups.items()):
        print(f"\n  --- {prefix} ({len(coords)} tiles) ---")

        # Load level 8 tiles
        tiles_z8 = {}
        for (x, y), fname in coords.items():
            img = load_tile(os.path.join(zoom8_dir, fname))
            if img:
                tiles_z8[(x, y)] = img

        if not tiles_z8:
            print("    No loaded tiles, skipping.")
            continue

        def tile_path(z, x, y, _prefix=prefix):
            return os.path.join(DUNGEON_DIR, str(z), f"{_prefix}_{x}x{y}.webp")

        # Lower zoom levels
        tiles_by_zoom = defaultdict(dict)
        tiles_by_zoom[BASE_ZOOM] = tiles_z8
        generate_lower_zooms(tiles_by_zoom, None, tile_path)

        # Higher zoom level
        generate_higher_zoom(tiles_z8, tile_path)

        # Free memory
        del tiles_by_zoom
        del tiles_z8


# ---------------------------------------------------------------------------
#  Entry point
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
#  Constants (mirrors RSBot NavMeshApi)
# ---------------------------------------------------------------------------

REGION_WIDTH = 1920.0
REGION_LENGTH = 1920.0

TILES_X = 96
TILES_Z = 96
TILES_TOTAL = TILES_X * TILES_Z

VERTICES_X = TILES_X + 1
VERTICES_Z = TILES_Z + 1
VERTICES_TOTAL = VERTICES_X * VERTICES_Z

BLOCKS_X = 6
BLOCKS_Z = 6
BLOCKS_TOTAL = BLOCKS_X * BLOCKS_Z

TILE_WIDTH = 20.0
TILE_LENGTH = 20.0

# NavMeshEdgeFlag
FLAG_BLOCK_DST2SRC = 1
FLAG_BLOCK_SRC2DST = 2
FLAG_BLOCKED = 3  # both bits
FLAG_INTERNAL = 4
FLAG_GLOBAL = 8
FLAG_RAILING = 16
FLAG_ENTRANCE = 32
FLAG_BIT6 = 64
FLAG_SIEGE = 128

# NavMeshStructOption
STRUCT_OPT_EDGE = 1
STRUCT_OPT_CELL = 2
STRUCT_OPT_EVENT = 4

# PNG tile size matches map tiles
PNG_SIZE = 256

# Render size: 2x tile size for native zoom-9 quality
RENDER_SIZE = PNG_SIZE * 2  # 512

# ---------------------------------------------------------------------------
#  Binary helpers
# ---------------------------------------------------------------------------


class BinaryStream:
    """Minimal binary reader matching NavMeshReader behaviour."""

    def __init__(self, data: bytes):
        self._buf = data
        self._pos = 0

    @property
    def pos(self):
        return self._pos

    def seek(self, offset, whence=0):
        if whence == 0:
            self._pos = offset
        elif whence == 1:
            self._pos += offset
        elif whence == 2:
            self._pos = len(self._buf) + offset

    def read_bytes(self, n):
        r = self._buf[self._pos : self._pos + n]
        self._pos += n
        return r

    def read_int16(self):
        r = struct.unpack_from("<h", self._buf, self._pos)[0]
        self._pos += 2
        return r

    def read_uint16(self):
        r = struct.unpack_from("<H", self._buf, self._pos)[0]
        self._pos += 2
        return r

    def read_int32(self):
        r = struct.unpack_from("<i", self._buf, self._pos)[0]
        self._pos += 4
        return r

    def read_float(self):
        r = struct.unpack_from("<f", self._buf, self._pos)[0]
        self._pos += 4
        return r

    def read_bool(self):
        r = self._buf[self._pos]
        self._pos += 1
        return bool(r)

    def read_byte(self):
        r = self._buf[self._pos]
        self._pos += 1
        return r

    def read_string_fixed(self, n):
        raw = self._buf[self._pos : self._pos + n]
        self._pos += n
        # Find null terminator
        end = n
        for i in range(n):
            if raw[i] == 0:
                end = i
                break
        return raw[:end].decode("ascii", errors="replace")

    def read_string(self):
        length = self.read_int32()
        if length <= 0:
            return ""
        return self.read_string_fixed(length)

    def read_vec2(self):
        x = self.read_float()
        y = self.read_float()
        return (x, y)

    def read_vec3(self):
        x = self.read_float()
        y = self.read_float()
        z = self.read_float()
        return (x, y, z)

    def read_line2d(self):
        """Read 2D line: 2x Vector2 → ((x1,z1), (x2,z2))."""
        x1, z1 = self.read_vec2()
        x2, z2 = self.read_vec2()
        return ((x1, z1), (x2, z2))


# ---------------------------------------------------------------------------
#  Region ID helpers
# ---------------------------------------------------------------------------


def rid_x(rid):
    return rid & 0xFF


def rid_z(rid):
    return (rid >> 8) & 0x7F


def rid_is_dungeon(rid):
    return (rid >> 15) & 1 == 1


def rid_make(x, z, dungeon=False):
    v = (x & 0xFF) | ((z & 0x7F) << 8)
    if dungeon:
        v |= 0x8000
    return v


# ---------------------------------------------------------------------------
#  Edge colour (matches NavMeshExtenions.ToPen)
# ---------------------------------------------------------------------------


def edge_color(flag):
    if flag & FLAG_BLOCKED:
        return "#FF0000"  # Red
    if flag & FLAG_RAILING:
        return "#0000FF"  # Blue
    return "#00FF00"  # Lime


# ---------------------------------------------------------------------------
#  Object ID → colour (matches NavMeshExtenions.ToColor)
# ---------------------------------------------------------------------------


def obj_id_color(i):
    def bit(a, b):
        return (a >> b) & 1

    if i == 0:
        return (0, 192, 255, 128)
    r = (bit(i, 4) + bit(i, 1) * 2 + 1) * 63
    g = (bit(i, 3) + bit(i, 2) * 2 + 1) * 63
    b = (bit(i, 5) + bit(i, 0) * 2 + 1) * 63
    return (min(r, 255), min(g, 255), min(b, 255), 128)


def obj_id_css(i):
    r, g, b, a = obj_id_color(i)
    return f"rgba({r},{g},{b},{a / 255:.2f})"


# ---------------------------------------------------------------------------
#  Load MapInfo.mfo → set of enabled region IDs
# ---------------------------------------------------------------------------


def load_map_info(data_dir):
    path = os.path.join(data_dir, "NavMesh", "MapInfo.mfo")
    if not os.path.isfile(path):
        print(f"  [!] MapInfo.mfo not found at {path}")
        return set()

    with open(path, "rb") as f:
        raw = f.read()

    s = BinaryStream(raw)
    sig = s.read_string_fixed(12)
    if sig != "JMXVMFO 1000":
        print(f"  [!] Invalid MapInfo signature: {sig}")
        return set()

    map_width = s.read_int16()
    map_length = s.read_int16()
    s.read_int16()  # short2
    s.read_int16()  # short3
    s.read_int16()  # short4
    s.read_int16()  # short5

    total = 256 * 256
    bitmap = s.read_bytes(total // 8)

    enabled = set()
    for z in range(map_length):
        for x in range(map_width):
            rid = rid_make(x, z)
            byte_idx = rid >> 3
            bit_mask = 128 >> (rid % 8)
            if byte_idx < len(bitmap) and (bitmap[byte_idx] & bit_mask):
                enabled.add(rid)

    return enabled


# ---------------------------------------------------------------------------
#  Load Object.ifo → dict[id] → path
# ---------------------------------------------------------------------------


def load_object_index(data_dir):
    path = os.path.join(data_dir, "NavMesh", "Object.ifo")
    if not os.path.isfile(path):
        print(f"  [!] Object.ifo not found at {path}")
        return {}

    obj_map = {}
    with open(path, "r", encoding="ascii", errors="replace") as f:
        sig = f.readline().strip()
        if sig != "JMXVOBJI1000":
            print(f"  [!] Invalid Object.ifo signature: {sig}")
            return {}
        count = int(f.readline().strip())
        pattern = re.compile(r'(\d{5})\s+0x([0-9a-fA-F]{8})\s+"(.+?)"')
        for line in f:
            m = pattern.match(line.strip())
            if m:
                obj_id = int(m.group(1))
                obj_flag = int(m.group(2), 16)
                obj_path = m.group(3)
                obj_map[obj_id] = (obj_flag, obj_path)

    return obj_map


# ---------------------------------------------------------------------------
#  Load DungeonInfo.txt → dict[rid] → dof_path
# ---------------------------------------------------------------------------


def load_dungeon_info(data_dir):
    path = os.path.join(data_dir, "Dungeon", "DungeonInfo.txt")
    if not os.path.isfile(path):
        path2 = os.path.join(data_dir, "Dungeon", "dungeoninfo.txt")
        if os.path.isfile(path2):
            path = path2
        else:
            print(f"  [!] DungeonInfo.txt not found")
            return {}

    dungeons = {}
    pattern = re.compile(r'^(?:(\d)\t)?(\d+)\t"(.+)"$')
    with open(path, "r", encoding="ascii", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            m = pattern.match(line)
            if not m:
                continue
            service = m.group(1)
            if service is not None and service == "0":
                continue
            dun_id = int(m.group(2))
            dun_path = m.group(3)
            rid = rid_make(dun_id & 0xFF, (dun_id >> 8) & 0x7F, dungeon=True)
            # Actually dungeon RID = short(dun_id) with dungeon bit set
            rid = dun_id & 0x7FFF
            rid |= 0x8000
            dungeons[rid] = dun_path

    return dungeons


# ---------------------------------------------------------------------------
#  Parse NavMeshObj from .bms file (JMXVBMS 0110)
# ---------------------------------------------------------------------------


def parse_navmesh_obj_bms(data):
    """Parse a .bms NavMeshObj. Returns (vertices, cells, global_edges, internal_edges, struct_option)."""
    s = BinaryStream(data)
    sig = s.read_string_fixed(12)
    if sig != "JMXVBMS 0110":
        return None

    # Header
    vertex_offset = s.read_int32()
    skin_offset = s.read_int32()
    face_offset = s.read_int32()
    cloth_vertex_offset = s.read_int32()
    cloth_edge_offset = s.read_int32()
    bbox_offset = s.read_int32()
    occlusion_portal_offset = s.read_int32()
    navmesh_obj_offset = s.read_int32()
    skined_navmesh_offset = s.read_int32()
    offset9 = s.read_int32()
    int1 = s.read_int32()
    struct_option = s.read_int32()

    s.seek(4, 1)  # SubPrimCount
    s.seek(4, 1)  # VertexFlag
    s.seek(4, 1)  # 0

    name = s.read_string()

    if navmesh_obj_offset == 0:
        return None

    s.seek(navmesh_obj_offset)

    # Vertices: index, position(vec3), normal(byte)
    vertex_count = s.read_int32()
    vertices = []
    for i in range(vertex_count):
        pos = s.read_vec3()
        normal_idx = s.read_byte()
        vertices.append(pos)  # (x, y, z)

    # Cells: 3 vertex indices + flag + optional event zone
    cell_count = s.read_int32()
    cells = []
    for i in range(cell_count):
        vi0 = s.read_int16()
        vi1 = s.read_int16()
        vi2 = s.read_int16()
        flag = s.read_int16()
        if struct_option & STRUCT_OPT_CELL:
            s.read_byte()  # event zone
        cells.append((vi0, vi1, vi2))

    # Global edges: 2 vertex indices, src_cell, dst_cell, flag + optional event zone
    global_edge_count = s.read_int32()
    global_edges = []
    for i in range(global_edge_count):
        vi0 = s.read_int16()
        vi1 = s.read_int16()
        src_cell = s.read_int16()
        dst_cell = s.read_int16()
        flag = s.read_byte() | FLAG_GLOBAL
        if struct_option & STRUCT_OPT_EDGE:
            s.read_byte()  # event zone
        p0 = vertices[vi0]
        p1 = vertices[vi1]
        global_edges.append((p0, p1, flag))

    # Internal edges
    internal_edge_count = s.read_int32()
    internal_edges = []
    for i in range(internal_edge_count):
        vi0 = s.read_int16()
        vi1 = s.read_int16()
        src_cell = s.read_int16()
        dst_cell = s.read_int16()
        flag = s.read_byte() | FLAG_INTERNAL
        if struct_option & STRUCT_OPT_EDGE:
            s.read_byte()  # event zone
        p0 = vertices[vi0]
        p1 = vertices[vi1]
        internal_edges.append((p0, p1, flag))

    return {
        "name": name,
        "vertices": vertices,
        "cells": cells,
        "global_edges": global_edges,
        "internal_edges": internal_edges,
        "struct_option": struct_option,
    }


# ---------------------------------------------------------------------------
#  Parse NavMeshObj from .bsr file (JMXVRES 0109)
# ---------------------------------------------------------------------------


def parse_navmesh_obj_bsr(data):
    s = BinaryStream(data)
    sig = s.read_string_fixed(12)
    if sig != "JMXVRES 0109":
        return None

    prim_mtrl_set_offset = s.read_int32()
    prim_mesh_offset = s.read_int32()
    anim_set_offset = s.read_int32()
    anim_snd_set_offset = s.read_int32()
    mesh_group_offset = s.read_int32()
    anim_set2_offset = s.read_int32()
    mod_palette_offset = s.read_int32()
    navmesh_obj_offset = s.read_int32()
    int0 = s.read_int32()
    int1 = s.read_int32()
    int2 = s.read_int32()
    int3 = s.read_int32()
    int4 = s.read_int32()

    if navmesh_obj_offset == 0:
        return None

    s.seek(navmesh_obj_offset)
    navmesh_obj_path = s.read_string()
    if not navmesh_obj_path:
        return None

    return navmesh_obj_path  # returns path to .bms


def parse_navmesh_obj_cpd(data):
    s = BinaryStream(data)
    sig = s.read_string_fixed(12)
    if sig != "JMXVCPD 0101":
        return None

    navmesh_obj_offset = s.read_int32()
    res_obj_list_offset = s.read_int32()
    s.read_int32()  # int0
    s.read_int32()  # int1
    s.read_int32()  # int2
    s.read_int32()  # int3
    s.read_int32()  # int4

    if navmesh_obj_offset == 0:
        return None

    s.seek(navmesh_obj_offset)
    navmesh_obj_path = s.read_string()
    if not navmesh_obj_path:
        return None

    return navmesh_obj_path  # returns path to .bsr


# ---------------------------------------------------------------------------
#  Resolve and load NavMeshObj (handles .bms / .bsr / .cpd chain)
# ---------------------------------------------------------------------------

_obj_cache = {}


def load_navmesh_obj(data_dir, obj_path):
    """Load a NavMeshObj following the chain: .cpd → .bsr → .bms"""
    if obj_path in _obj_cache:
        return _obj_cache[obj_path]

    full_path = os.path.join(data_dir, obj_path.replace("\\", os.sep))
    if not os.path.isfile(full_path):
        _obj_cache[obj_path] = None
        return None

    with open(full_path, "rb") as f:
        data = f.read()

    ext = obj_path.rsplit(".", 1)[-1].lower()

    if ext == "bms":
        result = parse_navmesh_obj_bms(data)
        _obj_cache[obj_path] = result
        return result
    elif ext == "bsr":
        bms_path = parse_navmesh_obj_bsr(data)
        if bms_path:
            result = load_navmesh_obj(data_dir, bms_path)
            _obj_cache[obj_path] = result
            return result
    elif ext == "cpd":
        bsr_path = parse_navmesh_obj_cpd(data)
        if bsr_path:
            result = load_navmesh_obj(data_dir, bsr_path)
            _obj_cache[obj_path] = result
            return result

    _obj_cache[obj_path] = None
    return None


# ---------------------------------------------------------------------------
#  Parse terrain NVM file
# ---------------------------------------------------------------------------


def parse_terrain_nvm(data, data_dir, obj_index):
    """
    Parse a terrain .nvm file.
    Returns dict with 'instances', 'global_edges', 'internal_edges'.
    """
    s = BinaryStream(data)
    sig = s.read_string_fixed(12)
    if sig != "JMXVNVM 1000":
        print(f"  [!] Invalid NVM signature: {sig}")
        return None

    # Instances (NavMeshInstObj)
    instance_count = s.read_int16()
    instances = []
    for i in range(instance_count):
        obj_idx = s.read_int32()
        local_pos = s.read_vec3()  # (x, y, z)
        s.read_int16()  # type
        yaw = s.read_float()
        inst_id = s.read_uint16()
        s.read_uint16()  # short0
        is_big = s.read_bool()
        is_struct = s.read_bool()
        region = s.read_uint16()
        world_uid = (region << 16) | inst_id

        # Link edges
        link_edge_count = s.read_int16()
        for _ in range(link_edge_count):
            s.read_int16()  # linked_obj_id
            s.read_int16()  # linked_obj_edge_id
            s.read_int16()  # edge_id

        # Load the object mesh
        obj_data = None
        if obj_idx in obj_index:
            obj_flag, obj_path = obj_index[obj_idx]
            obj_data = load_navmesh_obj(data_dir, obj_path)

        instances.append(
            {
                "obj_idx": obj_idx,
                "local_pos": local_pos,
                "yaw": yaw,
                "world_uid": world_uid,
                "obj_data": obj_data,
            }
        )

    # Cells
    total_cell_count = s.read_int32()
    open_cell_count = s.read_int32()
    for i in range(total_cell_count):
        s.read_vec2()  # rect min
        s.read_vec2()  # rect max
        inst_count = s.read_byte()
        for _ in range(inst_count):
            s.read_int16()

    # Global edges
    global_edge_count = s.read_int32()
    global_edges = []
    for i in range(global_edge_count):
        line = s.read_line2d()  # ((x1,z1),(x2,z2))
        flag = s.read_byte()
        s.read_byte()  # src side
        s.read_byte()  # dst side
        s.read_int16()  # src cell index
        s.read_int16()  # dst cell index
        s.read_int16()  # src mesh index
        s.read_int16()  # dst mesh index
        global_edges.append((line, flag))

    # Internal edges
    internal_edge_count = s.read_int32()
    internal_edges = []
    for i in range(internal_edge_count):
        line = s.read_line2d()
        flag = s.read_byte()
        s.read_byte()  # src side
        s.read_byte()  # dst side
        s.read_int16()  # src cell index
        s.read_int16()  # dst cell index
        internal_edges.append((line, flag))

    # TileMap (skip - we don't need it for PNG rendering)
    # HeightMap (skip)
    # SurfaceMap (skip)

    return {
        "instances": instances,
        "global_edges": global_edges,
        "internal_edges": internal_edges,
    }


# ---------------------------------------------------------------------------
#  Parse dungeon DOF file (JMXVDOF 0101)
# ---------------------------------------------------------------------------


def parse_dungeon_dof(data, data_dir):
    """
    Parse a dungeon .dof file.
    Returns list of blocks, each with navmesh obj data, transforms, floor info.
    """
    s = BinaryStream(data)
    sig = s.read_string_fixed(12)
    if sig != "JMXVDOF 0101":
        print(f"  [!] Invalid DOF signature: {sig}")
        return None

    block_offset = s.read_int32()
    link_offset = s.read_int32()
    voxel_offset = s.read_int32()
    group_offset = s.read_int32()
    label_offset = s.read_int32()
    offset5 = s.read_int32()
    offset6 = s.read_int32()
    bbox_offset = s.read_int32()

    # BoundingBox
    s.seek(bbox_offset)
    bbox_min = s.read_vec3()
    bbox_max = s.read_vec3()

    # Blocks
    s.seek(block_offset)
    block_count = s.read_int32()

    blocks = []
    for i in range(block_count):
        path = s.read_string()
        name = s.read_string()
        s.seek(4, 1)  # skip 4 bytes

        position = s.read_vec3()
        yaw = s.read_float()
        is_entrance = s.read_int32()
        bb_min = s.read_vec3()
        bb_max = s.read_vec3()

        s.seek(20, 1)  # skip 20 bytes

        has_height_fog = s.read_bool()
        if has_height_fog:
            s.seek(16, 1)

        has_unknown_vec = s.read_bool()
        if has_unknown_vec:
            s.seek(28, 1)

        str_len = s.read_int32()
        s.seek(str_len, 1)  # skip string

        room_index = s.read_int32()
        floor_index = s.read_int32()

        connected_count = s.read_int32()
        for _ in range(connected_count):
            s.read_int32()

        visible_count = s.read_int32()
        s.seek(visible_count * 4, 1)

        block_obj_count = s.read_int32()
        block_col_obj_count = s.read_int32()
        for _ in range(block_obj_count):
            s.read_string()  # name
            s.read_string()  # path
            s.read_vec3()  # position
            s.seek(24, 1)
            block_obj_flag = s.read_int32()
            s.read_int32()
            s.read_float()  # radius squared
            if block_obj_flag & 4:
                s.seek(4, 1)  # color

        block_light_count = s.read_int32()
        for _ in range(block_light_count):
            light_str_len = s.read_int32()
            s.seek(light_str_len, 1)
            s.seek(60, 1)

        # Load the navmesh object
        obj_data = load_navmesh_obj(data_dir, path)

        blocks.append(
            {
                "id": i,
                "path": path,
                "name": name,
                "position": position,
                "yaw": yaw,
                "floor_index": floor_index,
                "room_index": room_index,
                "obj_data": obj_data,
                "bb_min": bb_min,
                "bb_max": bb_max,
            }
        )

    # Labels
    floor_labels = {}
    if label_offset != 0:
        s.seek(label_offset)
        room_count = s.read_int32()
        for i in range(room_count):
            s.read_string()  # room label
        floor_count = s.read_int32()
        for i in range(floor_count):
            floor_labels[i] = s.read_string()

    return {
        "blocks": blocks,
        "floor_labels": floor_labels,
        "bbox_min": bbox_min,
        "bbox_max": bbox_max,
    }


# ---------------------------------------------------------------------------
#  PNG tile rendering
# ---------------------------------------------------------------------------


def transform_obj_point(px, pz, yaw, lx, lz):
    """Apply rotation (-yaw) and translation to get world-space coords."""
    cos_y = math.cos(-yaw)
    sin_y = math.sin(-yaw)
    wx = px * cos_y + pz * sin_y + lx
    wz = -px * sin_y + pz * cos_y + lz
    return wx, wz


def edge_rgba(flag):
    """Edge colour as RGBA tuple."""
    if flag & FLAG_BLOCKED:
        return (255, 0, 0, 255)
    if flag & FLAG_RAILING:
        return (0, 0, 255, 255)
    return (0, 255, 0, 255)


def obj_id_rgba(i):
    """Object colour as RGBA tuple (alpha=128)."""

    def bit(a, b):
        return (a >> b) & 1

    if i == 0:
        return (0, 192, 255, 128)
    r = (bit(i, 4) + bit(i, 1) * 2 + 1) * 63
    g = (bit(i, 3) + bit(i, 2) * 2 + 1) * 63
    b = (bit(i, 5) + bit(i, 0) * 2 + 1) * 63
    return (min(r, 255), min(g, 255), min(b, 255), 128)


def render_terrain_region(nvm_data, size):
    """
    Render navmesh for one region into a RGBA PIL Image.
    NVM Z axis points north, image Y axis points down -> flip Z.
    """
    scale = size / REGION_WIDTH
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    def tx(x):
        return x * scale

    def ty(z):
        return size - z * scale

    # Object triangles
    drawn_uids = set()
    for inst in nvm_data["instances"]:
        if inst["world_uid"] in drawn_uids:
            continue
        drawn_uids.add(inst["world_uid"])
        obj = inst["obj_data"]
        if obj is None:
            continue
        lx, ly, lz = inst["local_pos"]
        yaw = inst["yaw"]
        fill = obj_id_rgba(inst["world_uid"])

        for vi0, vi1, vi2 in obj["cells"]:
            verts = obj["vertices"]
            pts = []
            for vi in (vi0, vi1, vi2):
                wx, wz = transform_obj_point(verts[vi][0], verts[vi][2], yaw, lx, lz)
                pts.append((tx(wx), ty(wz)))
            draw.polygon(pts, fill=fill)

        for edges, w in ((obj["global_edges"], 1), (obj["internal_edges"], 1)):
            for p0, p1, flag in edges:
                x0, z0 = transform_obj_point(p0[0], p0[2], yaw, lx, lz)
                x1, z1 = transform_obj_point(p1[0], p1[2], yaw, lx, lz)
                draw.line([(tx(x0), ty(z0)), (tx(x1), ty(z1))], fill=edge_rgba(flag), width=w)

    # Terrain edges
    for edges, w in ((nvm_data["global_edges"], 1), (nvm_data["internal_edges"], 1)):
        for line, flag in edges:
            (x0, z0), (x1, z1) = line
            draw.line([(tx(x0), ty(z0)), (tx(x1), ty(z1))], fill=edge_rgba(flag), width=w)

    return img


def save_webp(img, path):
    """Save RGBA image as WEBP."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "WEBP", quality=80)


# ---------------------------------------------------------------------------
#  Generate lower zoom levels: merge 2x2 -> 1
# ---------------------------------------------------------------------------


def generate_navmesh_lower_zooms(tiles_z8, out_dir, base_zoom=8, min_zoom=3):
    """
    Generate zoom levels base_zoom-1 down to min_zoom by merging 2x2 tiles.
    tiles_z8: dict[(x, y)] -> PIL Image at base zoom level.
    """
    tiles_by_zoom = {base_zoom: tiles_z8}

    for z in range(base_zoom - 1, min_zoom - 1, -1):
        parent_tiles = tiles_by_zoom[z + 1]
        if not parent_tiles:
            print(f"  Level {z}: no source tiles, skipping")
            break

        # Parent tile coordinates (y inverted like in the minimap tile generator)
        parent_coords = set()
        for x, y in parent_tiles:
            parent_coords.add((x // 2, -(-y // 2)))

        current_tiles = {}
        tile_size = PNG_SIZE
        for px, py in parent_coords:
            merged = Image.new("RGBA", (tile_size * 2, tile_size * 2), (0, 0, 0, 0))
            has_any = False
            for dx in (0, 1):
                for child_y, img_y in ((2 * py, 0), (2 * py - 1, tile_size)):
                    child = parent_tiles.get((2 * px + dx, child_y))
                    if child:
                        merged.paste(child, (dx * tile_size, img_y))
                        has_any = True

            if has_any:
                resized = merged.resize((tile_size, tile_size), Image.LANCZOS)
                if z in (3, 6):
                    path = os.path.join(out_dir, str(z), f"{px}x{py}.webp")
                    save_webp(resized, path)
                current_tiles[(px, py)] = resized

        tiles_by_zoom[z] = current_tiles
        print(f"  Level {z}: {len(current_tiles)} tiles")


# ---------------------------------------------------------------------------
#  Process world map regions -> PNG tiles at all zoom levels
# ---------------------------------------------------------------------------


def process_world_navmesh(data_dir, out_dir, obj_index):
    print("=" * 60)
    print("World map navmesh")
    print("=" * 60)

    enabled_regions = load_map_info(data_dir)
    print(f"  Active regions: {len(enabled_regions)}")

    navmesh_dir = os.path.join(data_dir, "navmesh")
    if not os.path.isdir(navmesh_dir):
        navmesh_dir = os.path.join(data_dir, "NavMesh")
    if not os.path.isdir(navmesh_dir):
        print(f"  [!] navmesh directory not found in {data_dir}")
        return

    nm_out = os.path.join(out_dir, "navmesh")

    # Render at 2x resolution (RENDER_SIZE=512) for native zoom-9 quality
    tiles_hires = {}
    count = 0
    total = len(enabled_regions)
    for idx, rid in enumerate(sorted(enabled_regions), 1):
        x = rid_x(rid)
        z = rid_z(rid)
        nvm_file = os.path.join(navmesh_dir, f"nv_{rid:04X}.nvm")
        if not os.path.isfile(nvm_file):
            nvm_file = os.path.join(navmesh_dir, f"nv_{rid:04x}.nvm")
        if not os.path.isfile(nvm_file):
            continue

        with open(nvm_file, "rb") as f:
            raw = f.read()

        nvm_data = parse_terrain_nvm(raw, data_dir, obj_index)
        if nvm_data is None:
            continue

        img = render_terrain_region(nvm_data, RENDER_SIZE)

        # Check if image is not fully transparent
        if img.getbbox() is None:
            continue

        tiles_hires[(x, z)] = img
        count += 1

        if idx % 200 == 0 or idx == total:
            print(f"  {idx}/{total} regions processed, {count} rendered")

    # Zoom 9: split each 512x512 into 4 native 256x256 quadrants
    print(f"  Generating zoom 9 (native from {RENDER_SIZE}x{RENDER_SIZE})...")
    count9 = 0
    tile_size = PNG_SIZE
    for (x, y), img in tiles_hires.items():
        for dx in (0, 1):
            for img_y, child_y in ((0, 2 * y), (1, 2 * y - 1)):
                crop = img.crop((dx * tile_size, img_y * tile_size, (dx + 1) * tile_size, (img_y + 1) * tile_size))
                if crop.getbbox() is not None:
                    path = os.path.join(nm_out, "9", f"{2 * x + dx}x{child_y}.webp")
                    save_webp(crop, path)
                    count9 += 1
    print(f"  Level 9: {count9} tiles")

    # Zoom 8: downscale 512->256 (in memory for generating lower zoom levels)
    print("  Generating zoom 8 (downscale)...")
    tiles_z8 = {}
    for (x, y), img in tiles_hires.items():
        z8 = img.resize((tile_size, tile_size), Image.LANCZOS)
        tiles_z8[(x, y)] = z8
    print(f"  Level 8: {len(tiles_z8)} tiles")

    # Free hi-res images
    del tiles_hires

    # Generate lower zoom levels
    print("  Generating lower zoom levels (7 -> 3)...")
    generate_navmesh_lower_zooms(tiles_z8, nm_out)

    # Free memory
    del tiles_z8


# ---------------------------------------------------------------------------
#  Process dungeons -> PMTiles archives (one per floor)
# ---------------------------------------------------------------------------


def dungeon_navmesh_tiles(img, min_x, min_z, max_x, max_z, zoom):
    map_min_x = 128 + min_x / 1920
    map_max_x = 128 + max_x / 1920
    map_min_y = 127 + min_z / 1920
    map_max_y = 127 + max_z / 1920
    span = 256 / (2**zoom)
    scale_x = img.width / (map_max_x - map_min_x)
    scale_y = img.height / (map_max_y - map_min_y)
    min_tile_x = math.floor(map_min_x / span)
    max_tile_x = math.ceil(map_max_x / span) - 1
    min_tile_y = math.floor(map_min_y / span) + 1
    max_tile_y = math.ceil(map_max_y / span)
    pixels_per_map_unit = 2**zoom

    for tile_x in range(min_tile_x, max_tile_x + 1):
        for tile_y in range(min_tile_y, max_tile_y + 1):
            tile = img.transform(
                (PNG_SIZE, PNG_SIZE),
                Image.Transform.AFFINE,
                (
                    scale_x / pixels_per_map_unit,
                    0,
                    (tile_x * span - map_min_x) * scale_x,
                    0,
                    scale_y / pixels_per_map_unit,
                    (map_max_y - tile_y * span) * scale_y,
                ),
                resample=Image.Resampling.BICUBIC,
                fillcolor=(0, 0, 0, 0),
            )
            if tile.getbbox() is not None:
                yield tile_x, tile_y, tile


def write_dungeon_navmesh_archive(img, bounds, archive_path):
    tiles = {}
    for zoom in (6, 9):
        for tile_x, tile_y, tile in dungeon_navmesh_tiles(img, *bounds, zoom):
            tile_id = zxy_to_tileid(zoom, tile_x, tile_y)
            tile_bytes = io.BytesIO()
            tile.save(tile_bytes, "WEBP", quality=80)
            tiles[tile_id] = tile_bytes.getvalue()

    if not tiles:
        return False

    with write(archive_path) as archive:
        for tile_id, tile_data in sorted(tiles.items()):
            archive.write_tile(tile_id, tile_data)
        archive.finalize(
            {
                "tile_type": TileType.WEBP,
                "tile_compression": Compression.NONE,
                "min_zoom": 6,
                "max_zoom": 9,
            },
            {"name": os.path.basename(archive_path), "description": "Dungeon Navmesh Overlay"},
        )
    return True


def process_dungeon_navmesh(data_dir, assets_dir):
    print()
    print("=" * 60)
    print("Dungeon navmesh")
    print("=" * 60)

    dungeons = load_dungeon_info(data_dir)
    print(f"  Dungeons found: {len(dungeons)}")

    manifest = {}

    count = 0
    for rid, dof_rel_path in sorted(dungeons.items()):
        dof_path = os.path.join(data_dir, dof_rel_path.replace("\\", os.sep))
        if not os.path.isfile(dof_path):
            print(f"  [!] DOF not found: {dof_path}")
            continue

        with open(dof_path, "rb") as f:
            raw = f.read()

        try:
            dof_data = parse_dungeon_dof(raw, data_dir)
        except Exception as e:
            print(f"  [!] Error parsing {dof_rel_path}: {e}")
            continue

        if dof_data is None:
            continue

        # Group blocks by floor
        floors = defaultdict(list)
        for block in dof_data["blocks"]:
            floors[block["floor_index"]].append(block)

        dof_basename = os.path.splitext(os.path.basename(dof_path))[0]
        dungeon_id = rid & 0x7FFF

        for floor_idx, floor_blocks in sorted(floors.items()):
            # Compute bounding box across all blocks on this floor
            all_xs = []
            all_zs = []
            for block in floor_blocks:
                obj = block["obj_data"]
                if obj is None:
                    continue
                lx, ly, lz = block["position"]
                yaw = block["yaw"]
                for vert in obj["vertices"]:
                    wx, wz = transform_obj_point(vert[0], vert[2], yaw, lx, lz)
                    all_xs.append(wx)
                    all_zs.append(wz)

            if not all_xs:
                continue

            min_x = min(all_xs)
            max_x = max(all_xs)
            min_z = min(all_zs)
            max_z = max(all_zs)

            pad = 50.0
            min_x -= pad
            min_z -= pad
            max_x += pad
            max_z += pad

            width = max_x - min_x
            height = max_z - min_z

            if width <= 0 or height <= 0:
                continue

            # Scale to high-resolution image
            max_dim = max(width, height)
            img_w = int(width / max_dim * 2048)
            img_h = int(height / max_dim * 2048)
            scale = img_w / width

            img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)
            has_content = False

            def txd(x):
                return (x - min_x) * scale

            def tyd(z):
                return (max_z - z) * scale

            for block in floor_blocks:
                obj = block["obj_data"]
                if obj is None:
                    continue

                lx, ly, lz = block["position"]
                yaw = block["yaw"]
                bid = block["id"]
                fill = obj_id_rgba(bid)

                for vi0, vi1, vi2 in obj["cells"]:
                    verts = obj["vertices"]
                    pts = []
                    for vi in (vi0, vi1, vi2):
                        wx, wz = transform_obj_point(verts[vi][0], verts[vi][2], yaw, lx, lz)
                        pts.append((txd(wx), tyd(wz)))
                    draw.polygon(pts, fill=fill)
                    has_content = True

                for edges, w in ((obj["global_edges"], 1), (obj["internal_edges"], 1)):
                    for p0, p1, flag in edges:
                        x0, z0 = transform_obj_point(p0[0], p0[2], yaw, lx, lz)
                        x1, z1 = transform_obj_point(p1[0], p1[2], yaw, lx, lz)
                        draw.line([(txd(x0), tyd(z0)), (txd(x1), tyd(z1))], fill=edge_rgba(flag), width=w)
                        has_content = True

            if not has_content:
                continue

            region_key = str(rid)
            archive_name = f"navmesh_{region_key}_{floor_idx + 1}.pmtiles"
            os.makedirs(assets_dir, exist_ok=True)
            archive_path = os.path.join(assets_dir, archive_name)
            if not write_dungeon_navmesh_archive(img, (min_x, min_z, max_x, max_z), archive_path):
                continue

            if region_key not in manifest:
                manifest[region_key] = []
            manifest[region_key].append(
                {
                    "archive": archive_name,
                    "floor": floor_idx,
                    "minX": round(min_x, 2),
                    "minZ": round(min_z, 2),
                    "maxX": round(max_x, 2),
                    "maxZ": round(max_z, 2),
                }
            )

            count += 1
            print(f"  [{dungeon_id}] {dof_basename} floor {floor_idx} -> {archive_name}")

    manifest_path = os.path.join(assets_dir, "navmesh_dungeons.json")
    os.makedirs(assets_dir, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"  Manifest written: {manifest_path}")
    print(f"  Total: {count} dungeon navmesh PMTiles archives")


# ---------------------------------------------------------------------------
#  Entry point
# ---------------------------------------------------------------------------


def generate_navmesh_assets(data_dir, out_dir, assets_dir):
    if not os.path.isdir(data_dir):
        raise FileNotFoundError(f"Data directory '{data_dir}' not found.")

    print(f"Data directory: {data_dir}")
    print(f"Output directory: {out_dir}")
    print(f"Asset directory: {assets_dir}")
    print()

    # Load object index
    obj_index = load_object_index(data_dir)
    print(f"Loaded {len(obj_index)} objects from Object.ifo")
    print()

    # Process world map
    process_world_navmesh(data_dir, out_dir, obj_index)

    # Process dungeons
    process_dungeon_navmesh(data_dir, assets_dir)

    print()
    print("Done!")


USED_ZOOMS = {3, 6, 9}

BASE_DIR = os.path.join("map", "public", "assets", "img", "silkroad", "minimap")
OUTPUT_DIR = os.path.join("map", "public", "assets")

DUNGEON_PREFIXES = {
    "32769_1": "dh_a01_floor01",
    "32769_2": "dh_a01_floor02",
    "32769_3": "dh_a01_floor03",
    "32769_4": "dh_a01_floor04",
    "32775": "qt_a01_floor01",
    "32774": "qt_a01_floor02",
    "32773": "qt_a01_floor03",
    "32772": "qt_a01_floor04",
    "32771": "qt_a01_floor05",
    "32770": "qt_a01_floor06",
    "32784": "rn_sd_egypt1_01",
    "32786": "flame_dungeon01",
    "32785": "fort_dungeon01",
}


def create_pmtiles(output_name, get_tiles_fn, description):
    output_path = os.path.join(OUTPUT_DIR, output_name)
    print(f"Creating {output_name} ({description})...")

    tiles = get_tiles_fn()
    if not tiles:
        print(f"  No tiles found for {output_name}, skipping.")
        return

    # Sort tiles by tile ID as required by PMTiles specification
    sorted_tiles = sorted(tiles, key=lambda t: t[0])

    with write(output_path) as w:
        for tile_id, file_path, _ in sorted_tiles:
            with open(file_path, "rb") as f:
                w.write_tile(tile_id, f.read())

        w.finalize(
            {
                "tile_type": TileType.WEBP,
                "tile_compression": Compression.NONE,
                "min_zoom": min(tile[2] for tile in tiles),
                "max_zoom": max(tile[2] for tile in tiles),
            },
            {"name": output_name, "description": description},
        )
    print(f"  Successfully wrote {len(tiles)} tiles to {output_path}")


def get_world_tiles():
    tiles = []
    # Search in BASE_DIR for zoom levels
    pattern = re.compile(r"^((-?\d+)x(-?\d+))\.webp$", re.IGNORECASE)
    for z_str in os.listdir(BASE_DIR):
        if not z_str.isdigit():
            continue
        z = int(z_str)
        if z not in USED_ZOOMS:
            continue
        z_dir = os.path.join(BASE_DIR, z_str)
        if not os.path.isdir(z_dir):
            continue
        for fname in os.listdir(z_dir):
            m = pattern.match(fname)
            if m:
                x = int(m.group(2))
                y = int(m.group(3))
                if x >= 0 and y >= 0:
                    tile_id = zxy_to_tileid(z, x, y)
                    tiles.append((tile_id, os.path.join(z_dir, fname), z))
    return tiles


def get_navmesh_world_tiles():
    tiles = []
    navmesh_dir = os.path.join(BASE_DIR, "navmesh")
    if not os.path.isdir(navmesh_dir):
        return tiles
    pattern = re.compile(r"^((-?\d+)x(-?\d+))\.webp$", re.IGNORECASE)
    for z_str in os.listdir(navmesh_dir):
        if not z_str.isdigit():
            continue
        z = int(z_str)
        if z not in USED_ZOOMS:
            continue
        z_dir = os.path.join(navmesh_dir, z_str)
        if not os.path.isdir(z_dir):
            continue
        for fname in os.listdir(z_dir):
            m = pattern.match(fname)
            if m:
                x = int(m.group(2))
                y = int(m.group(3))
                if x >= 0 and y >= 0:
                    tile_id = zxy_to_tileid(z, x, y)
                    tiles.append((tile_id, os.path.join(z_dir, fname), z))
    return tiles


def get_dungeon_tiles(prefix):
    tiles = []
    dungeon_dir = os.path.join(BASE_DIR, "d")
    if not os.path.isdir(dungeon_dir):
        return tiles
    pattern = re.compile(rf"^{prefix}_(-?\d+)x(-?\d+)\.webp$", re.IGNORECASE)
    for z_str in os.listdir(dungeon_dir):
        if not z_str.isdigit():
            continue
        z = int(z_str)
        if z not in USED_ZOOMS:
            continue
        z_dir = os.path.join(dungeon_dir, z_str)
        if not os.path.isdir(z_dir):
            continue
        for fname in os.listdir(z_dir):
            m = pattern.match(fname)
            if m:
                x = int(m.group(1))
                y = int(m.group(2))
                if x >= 0 and y >= 0:
                    tile_id = zxy_to_tileid(z, x, y)
                    tiles.append((tile_id, os.path.join(z_dir, fname), z))
    return tiles


def main():
    parser = argparse.ArgumentParser(description="Generate Silkroad map assets and PMTiles archives")
    parser.add_argument("--media", default=r"game_source/Media", help="Path to extracted Silkroad Media directory")
    parser.add_argument("--data", default=r"game_source/Data", help="Path to extracted Silkroad Data directory")
    parser.add_argument(
        "--assets",
        default=os.path.join("map", "public", "assets"),
        help="Output directory for PMTiles archives and generated data",
    )
    args = parser.parse_args()
    if not os.path.isdir(args.data):
        parser.error(f"data directory '{args.data}' not found")

    global BASE_DIR, DUNGEON_DIR, OUTPUT_DIR
    OUTPUT_DIR = args.assets

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="opensilkroad-map-") as intermediate_dir:
        BASE_DIR = intermediate_dir
        DUNGEON_DIR = os.path.join(BASE_DIR, "d")

        print(f"Intermediate map files: {BASE_DIR}")
        convert_minimaps(args.media, BASE_DIR)
        process_world_map()
        process_dungeon_maps()
        generate_navmesh_assets(args.data, BASE_DIR, OUTPUT_DIR)

        create_pmtiles("world.pmtiles", get_world_tiles, "World Map Background Tiles")
        create_pmtiles("navmesh_world.pmtiles", get_navmesh_world_tiles, "World Navmesh Tiles")
        for layer_key, prefix in DUNGEON_PREFIXES.items():
            create_pmtiles(
                f"{layer_key}.pmtiles",
                lambda p=prefix: get_dungeon_tiles(p),
                f"Dungeon Map {layer_key} Background Tiles",
            )

    print("\nPMTiles generation completed!")


if __name__ == "__main__":
    main()
