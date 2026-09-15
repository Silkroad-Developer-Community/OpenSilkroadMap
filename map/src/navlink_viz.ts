import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import { Style, Circle, Fill, Stroke } from "ol/style";
import { navlinkData } from "./navlink";
import { getDungeonFloorKey } from "./navmesh";

export const navlinkSource = new VectorSource();
export const navlinkLayer = new VectorLayer({
  source: navlinkSource,
  style: (feature) => {
    const linkType = feature.get("linkType") as string;
    if (linkType === "node") {
      return nodeStyle;
    }
    const highlighted = feature.get("highlighted") ?? false;
    if (linkType === "teleport") {
      return highlighted ? teleportEdgeSolidStyle : teleportEdgeStyle;
    }
    return highlighted ? walkEdgeSolidStyle : walkEdgeStyle;
  },
});

const nodeStyle = new Style({
  image: new Circle({
    radius: 2,
    fill: new Fill({ color: "rgba(255, 255, 255, 0.5)" }),
  }),
});

const walkEdgeStyle = new Style({
  stroke: new Stroke({
    color: "rgba(255, 255, 255, 0.15)",
    width: 1,
  }),
});

const teleportEdgeStyle = new Style({
  stroke: new Stroke({
    color: "#03dac6",
    width: 2,
    lineDash: [6, 4],
  }),
});

const teleportEdgeSolidStyle = new Style({
  stroke: new Stroke({
    color: "#03dac6",
    width: 3,
  }),
});

const walkEdgeSolidStyle = new Style({
  stroke: new Stroke({
    color: "rgba(255, 255, 255, 0.5)",
    width: 2,
  }),
});

function navlinkToMap(x: number, y: number, region: number): number[] {
  if (region > 32767 || region < 0) {
    return [128 + x / 1920, 127 + y / 1920];
  }
  return [x / 192 + 135, y / 192 + 91];
}

export function updateNavlinkViz(currentLayerKey: string) {
  navlinkSource.clear();

  if (!navlinkData || !navlinkData.nodes || !navlinkData.edges) return;

  const nodes = navlinkData.nodes as Record<string, { x: number; y: number; region: number }>;
  const edges = navlinkData.edges as Record<string, { from: string; to: string; type: string; npc?: string | null; dest?: number | null }>;

  const isWorld = currentLayerKey === "world";

  const nodeCoords: Record<string, number[]> = {};

  for (const [nodeId, node] of Object.entries(nodes)) {
    let region = node.region;
    if (region < 0) region += 65536;

    let show = false;
    if (isWorld) {
      show = region < 32768;
    } else {
      const dungeonFloorKey = getDungeonFloorKey(node.x, node.y, region);
      show = dungeonFloorKey === currentLayerKey;
    }

    if (show) {
      const coords = navlinkToMap(node.x, node.y, region);
      nodeCoords[nodeId] = coords;
    }
  }

  for (const [nodeId, coords] of Object.entries(nodeCoords)) {
    const node = nodes[nodeId];
    const feature = new Feature({
      geometry: new Point(coords),
      nodeId,
      linkType: "node",
    });
    feature.set("x", node.x);
    feature.set("y", node.y);
    feature.set("region", node.region < 0 ? node.region + 65536 : node.region);
    navlinkSource.addFeature(feature);
  }

  for (const edge of Object.values(edges)) {
    const fromCoords = nodeCoords[edge.from];
    const toCoords = nodeCoords[edge.to];
    if (fromCoords && toCoords) {
      const feature = new Feature({
        geometry: new LineString([fromCoords, toCoords]),
        from: edge.from,
        to: edge.to,
        linkType: edge.type,
        isConnection: true,
        isNavlinkEdge: true,
        npc: edge.npc,
        dest: edge.dest,
      });
      navlinkSource.addFeature(feature);
    }
  }
}
