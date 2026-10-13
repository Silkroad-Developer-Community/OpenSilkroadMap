import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import { convertSROToMap } from "./coord";
import { assetUrl } from "./asset_url";
import { npcStyle, teleportStyles, connectionStyles, solidConnectionStyles } from "./styles";
import { getDungeonFloorKey } from "./navmesh";

export let npcsData: any[] = [];
export let teleportsData: any[] = [];

export let renderTeleports = true;
export function setRenderTeleports(val: boolean) {
  renderTeleports = val;
}

export const markerSource = new VectorSource();
export const markerLayer = new VectorLayer({
  source: markerSource,
});

export const connectionSource = new VectorSource();
export const connectionLayer = new VectorLayer({
  source: connectionSource,
  style: (feature) => {
    const type = (feature.get("type") as number) ?? 0;
    const isHighlighted = feature.get("highlighted") ?? false;
    if (isHighlighted) {
      return solidConnectionStyles[type] || solidConnectionStyles[0];
    }
    return connectionStyles[type] || connectionStyles[0];
  },
});

export function updateMarkers(currentLayerKey: string) {
  markerSource.clear();
  connectionSource.clear();
  const isWorld = currentLayerKey === "world";

  // Draw dashed connection lines for NPCs if enabled
  const showNPCTeleports = (document.getElementById("toggle-conn-7") as HTMLInputElement | null)?.checked ?? false;

  // Draw NPCs
  npcsData.forEach((npc) => {
    let region = npc.region;
    if (region < 0) region += 65536;

    let show = false;
    if (isWorld) {
      show = region < 32768;
    } else {
      const dungeonFloorKey = getDungeonFloorKey(npc.x, npc.y, region);
      show = dungeonFloorKey === currentLayerKey;
    }

    if (show) {
      const coords = convertSROToMap(npc.x, npc.y, region);
      const feature = new Feature({
        geometry: new Point(coords),
        name: npc.name,
        codename: npc.codename || npc.name,
        type: npc.teleport && npc.teleport.length > 0 ? 7 : undefined,
        x: npc.x,
        y: npc.y,
        region: npc.region,
        teleport: npc.teleport,
      });
      feature.setStyle(npcStyle);
      markerSource.addFeature(feature);

      if (renderTeleports && showNPCTeleports && npc.teleport && Array.isArray(npc.teleport)) {
        npc.teleport.forEach((dest: any) => {
          let destRegion = dest.region;
          if (destRegion < 0) destRegion += 65536;

          let destShow = false;
          if (isWorld) {
            destShow = destRegion < 32768;
          } else {
            const dungeonFloorKey = getDungeonFloorKey(dest.x, dest.y, destRegion);
            destShow = dungeonFloorKey === currentLayerKey;
          }

          if (destShow) {
            const targetCoords = convertSROToMap(dest.x, dest.y, destRegion);
            const lineFeature = new Feature({
              geometry: new LineString([coords, targetCoords]),
              type: 7,
              isConnection: true,
              sourceName: npc.name,
              targetName: dest.name,
            });
            connectionSource.addFeature(lineFeature);
          }
        });
      }
    }
  });

  const connectionToggleCache: Record<number, boolean> = {};

  // Draw Teleports (Always visible)
  teleportsData.forEach((tp) => {
    let region = tp.region;
    if (region < 0) region += 65536;

    let show = false;
    if (isWorld) {
      show = region < 32768;
    } else {
      const dungeonFloorKey = getDungeonFloorKey(tp.x, tp.y, region);
      show = dungeonFloorKey === currentLayerKey;
    }

    if (show) {
      const coords = convertSROToMap(tp.x, tp.y, region);
      const feature = new Feature({
        geometry: new Point(coords),
        name: tp.name,
        codename: tp.codename || tp.name,
        type: tp.type,
        x: tp.x,
        y: tp.y,
        region: tp.region,
        teleport: tp.teleport,
      });
      const style = teleportStyles[tp.type] || teleportStyles[0];
      feature.setStyle(style);
      markerSource.addFeature(feature);

      // Draw dashed connection lines if enabled for this category
      let showConnections = connectionToggleCache[tp.type];
      if (showConnections === undefined) {
        showConnections =
          (document.getElementById(`toggle-conn-${tp.type}`) as HTMLInputElement | null)?.checked ?? false;
        connectionToggleCache[tp.type] = showConnections;
      }

      if (renderTeleports && showConnections && tp.teleport && Array.isArray(tp.teleport)) {
        tp.teleport.forEach((dest: any) => {
          let destRegion = dest.region;
          if (destRegion < 0) destRegion += 65536;

          let destShow = false;
          if (isWorld) {
            destShow = destRegion < 32768;
          } else {
            const dungeonFloorKey = getDungeonFloorKey(dest.x, dest.y, destRegion);
            destShow = dungeonFloorKey === currentLayerKey;
          }

          if (destShow) {
            const targetCoords = convertSROToMap(dest.x, dest.y, destRegion);
            const lineFeature = new Feature({
              geometry: new LineString([coords, targetCoords]),
              type: tp.type,
              isConnection: true,
              sourceName: tp.name,
              targetName: dest.name,
            });
            connectionSource.addFeature(lineFeature);
          }
        });
      }
    }
  });
}

// Fetch datasets
export function fetchMarkersData(onLoaded: () => void) {
  let npcsLoaded = false;
  let teleportsLoaded = false;

  const checkDone = () => {
    if (npcsLoaded && teleportsLoaded) {
      onLoaded();
    }
  };

  fetch(assetUrl("npcs.json"))
    .then((res) => res.json())
    .then((data) => {
      npcsData = data;
      npcsLoaded = true;
      checkDone();
    })
    .catch((err) => console.warn("Could not load npcs.json:", err));

  fetch(assetUrl("teleports.json"))
    .then((res) => res.json())
    .then((data) => {
      teleportsData = data;
      teleportsLoaded = true;
      checkDone();
    })
    .catch((err) => console.warn("Could not load teleports.json:", err));
}
