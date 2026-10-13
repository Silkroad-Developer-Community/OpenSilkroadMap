import TileLayer from "ol/layer/WebGLTile";
import XYZ from "ol/source/XYZ";
import { sroProjection, tileGrid } from "./coord";
import { WORLD_BOUNDS_Z9 } from "./styles";
import { PMTiles } from "pmtiles";
import { PMTilesDB, BlobSource } from "./pmtiles_db";
import { assetUrl } from "./asset_url";

interface DungeonNavmeshFloor {
  archive: string;
  floor: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

type DungeonNavmeshManifest = Record<string, DungeonNavmeshFloor[]>;

export let navmeshManifest: DungeonNavmeshManifest | null = null;
let currentNavmeshLayer: any = null;

export const navmeshManifestPromise = fetch(assetUrl("navmesh_dungeons.json"))
  .then((res) => {
    if (!res.ok) throw new Error(`Failed to load dungeon navmesh manifest: ${res.status}`);
    return res.json();
  })
  .then((data: DungeonNavmeshManifest) => {
    navmeshManifest = data;
    return data;
  })
  .catch((error) => {
    console.warn("Could not load dungeon navmesh manifest:", error);
    return null;
  });

const navmeshKey = "navmesh_world";
const navmeshUrl = assetUrl("navmesh_world.pmtiles");
let navmeshPMTiles: PMTiles | null = null;
let navmeshPMTilesPromise: Promise<PMTiles> | null = null;
const dungeonNavmeshCache: Record<string, Promise<PMTiles>> = {};

function getDungeonNavmeshPMTiles(archive: string): Promise<PMTiles> {
  if (!dungeonNavmeshCache[archive]) {
    dungeonNavmeshCache[archive] = (async () => {
      const key = archive.replace(/\.pmtiles$/, "");
      const cachedBlob = await PMTilesDB.get(key);
      return cachedBlob ? new PMTiles(new BlobSource(key, cachedBlob)) : new PMTiles(assetUrl(archive));
    })();
  }
  return dungeonNavmeshCache[archive];
}

function getNavmeshPMTiles(): Promise<PMTiles> {
  if (!navmeshPMTilesPromise) {
    navmeshPMTilesPromise = (async () => {
      if (navmeshPMTiles) return navmeshPMTiles;
      const cachedBlob = await PMTilesDB.get(navmeshKey);
      if (cachedBlob) {
        navmeshPMTiles = new PMTiles(new BlobSource(navmeshKey, cachedBlob));
      } else {
        navmeshPMTiles = new PMTiles(navmeshUrl);
      }
      return navmeshPMTiles;
    })();
  }
  return navmeshPMTilesPromise;
}

export function registerCachedNavmesh(blob: Blob) {
  const instance = new PMTiles(new BlobSource(navmeshKey, blob));
  navmeshPMTiles = instance;
  navmeshPMTilesPromise = Promise.resolve(instance);
}

function createDungeonNavmeshLayer(floorInfo: DungeonNavmeshFloor) {
  const tileSource = new XYZ({
    projection: sroProjection,
    tileGrid,
    tileUrlFunction: (tileCoord) => {
      const tileGridZ = tileCoord[0];
      if (tileGridZ === 0) return undefined;

      const z = tileGridZ === 1 ? 6 : 9;
      const tileX = tileCoord[1];
      const tileY = -tileCoord[2];
      const span = 256 / 2 ** z;
      const minX = Math.floor((128 + floorInfo.minX / 1920) / span);
      const maxX = Math.ceil((128 + floorInfo.maxX / 1920) / span) - 1;
      const minY = Math.floor((127 + floorInfo.minZ / 1920) / span);
      const maxY = Math.ceil((127 + floorInfo.maxZ / 1920) / span) - 1;
      if (tileX < minX || tileX > maxX || tileY < minY || tileY > maxY) return undefined;
      return floorInfo.archive;
    },
    tileLoadFunction: (tile: any, archive: string) => {
      const tileCoord = tile.getTileCoord();
      const z = tileCoord[0] === 1 ? 6 : 9;
      const x = tileCoord[1];
      const y = -tileCoord[2];
      getDungeonNavmeshPMTiles(archive)
        .then((pmtilesInstance) => pmtilesInstance.getZxy(z, x, y))
        .then((res) => {
          if (!res) throw new Error(`No dungeon navmesh tile at ${z}/${x}/${y}`);
          const blobUrl = URL.createObjectURL(new Blob([res.data], { type: "image/webp" }));
          const img = tile.getImage() as HTMLImageElement;
          img.src = blobUrl;
          img.addEventListener("load", () => URL.revokeObjectURL(blobUrl), { once: true });
        })
        .catch(() => {
          (tile.getImage() as HTMLImageElement).src =
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        });
    },
  });

  return new TileLayer({ source: tileSource, opacity: 0.7, minZoom: 6 });
}

const navmeshTileSource = new XYZ({
  projection: sroProjection,
  tileGrid: tileGrid,
  tileUrlFunction: (tileCoord) => {
    const tileGridZ = tileCoord[0];
    const x = tileCoord[1];
    const y = -tileCoord[2];
    const z = tileGridZ === 0 ? 3 : tileGridZ === 1 ? 6 : 9;

    if (currentLayerKeyTemp === "world") {
      const scale = Math.pow(2, 9 - z);
      const minX = Math.floor(WORLD_BOUNDS_Z9.minX / scale);
      const maxX = Math.ceil(WORLD_BOUNDS_Z9.maxX / scale);
      const minY = Math.floor(WORLD_BOUNDS_Z9.minY / scale);
      const maxY = Math.ceil(WORLD_BOUNDS_Z9.maxY / scale);
      if (x < minX || x > maxX || y < minY || y > maxY) return undefined;
    }
    return "dummy";
  },
  tileLoadFunction: (tile: any, src: string) => {
    if (src === "dummy") {
      const tileCoord = tile.getTileCoord();
      const tileGridZ = tileCoord[0];
      const x = tileCoord[1];
      const y = -tileCoord[2];
      const z = tileGridZ === 0 ? 3 : tileGridZ === 1 ? 6 : 9;

      getNavmeshPMTiles().then((pmtilesInstance) => {
        pmtilesInstance
          .getZxy(z, x, y)
          .then((res) => {
            if (!res) throw new Error("No data");
            const blob = new Blob([res.data], { type: "image/webp" });
            const blobUrl = URL.createObjectURL(blob);
            const img = tile.getImage() as HTMLImageElement;
            img.src = blobUrl;
            img.addEventListener(
              "load",
              () => {
                URL.revokeObjectURL(blobUrl);
              },
              { once: true },
            );
          })
          .catch(() => {
            (tile.getImage() as HTMLImageElement).src =
              "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
          });
      });
    }
  },
});

export const navmeshTileLayer = new TileLayer({
  source: navmeshTileSource,
  opacity: 0.7,
  minZoom: 6,
});

// A temporary variable to track current layer internally for URL generator
let currentLayerKeyTemp = "world";

export function updateNavmesh(map: any, currentLayerKey: string) {
  currentLayerKeyTemp = currentLayerKey;

  if (currentNavmeshLayer) {
    if (currentNavmeshLayer === navmeshTileLayer) {
      navmeshTileSource.clear();
      navmeshTileLayer.setSource(null);
      navmeshTileLayer.setSource(navmeshTileSource);
    }
    map.removeLayer(currentNavmeshLayer);
    currentNavmeshLayer = null;
  }

  const showNavmesh = (document.getElementById("navmesh-toggle") as HTMLInputElement | null)?.checked ?? false;
  if (!showNavmesh) return;

  if (currentLayerKey === "world") {
    currentNavmeshLayer = navmeshTileLayer;
    navmeshTileSource.clear();
    navmeshTileLayer.setSource(null);
    navmeshTileLayer.setSource(navmeshTileSource);
    map.addLayer(currentNavmeshLayer);
  } else if (navmeshManifest) {
    const parts = currentLayerKey.split("_");
    const region = parts[0];
    const floorIndex = parts[1] ? parseInt(parts[1], 10) - 1 : 0;

    const floorList = navmeshManifest[region];
    if (floorList) {
      const floorInfo = floorList.find((f: any) => f.floor === floorIndex) || floorList[0];
      if (floorInfo) {
        currentNavmeshLayer = createDungeonNavmeshLayer(floorInfo);
        map.addLayer(currentNavmeshLayer);
      }
    }
  }
}

export function getDungeonFloorKey(rawX: number, rawY: number, region: number): string | null {
  if (!navmeshManifest) return null;
  const floorList = navmeshManifest[String(region)];
  if (!floorList) return null;
  const floor = floorList.find((f) => {
    return rawX >= f.minX && rawX <= f.maxX && rawY >= f.minZ && rawY <= f.maxZ;
  });
  if (floor) {
    return `${region}_${floor.floor + 1}`;
  }
  return `${region}_1`;
}
