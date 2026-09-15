import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import Map from "ol/Map";
import MapBrowserEvent from "ol/MapBrowserEvent";
import { Style, Circle, Fill, Stroke } from "ol/style";
import Select from "ol/interaction/Select";
import Translate from "ol/interaction/Translate";
import { currentLayerKey } from "./map";
import { convertMapToSRO } from "./coord";
import { PMTilesDB } from "./pmtiles_db";
import { navlinkData, decompressGzipBufferToText } from "./navlink";
import { navlinkSource, navlinkLayer, updateNavlinkViz } from "./navlink_viz";
import { getDungeonFloorKey } from "./navmesh";

const EDITS_DB_KEY = "navlink_edits";
const SEGMENT_LENGTH = 50;
const SNAP_THRESHOLD = 60;

export type EditorMode = "view" | "extend" | "move" | "delete";

let mapInstance: Map | null = null;

let currentMode: EditorMode = "view";
export let editorEnabled = false;
export let isDirty = false;

export interface NavlinkWorkingEdge {
  from: string;
  to: string;
  type: string;
  npc?: string | null;
  dest?: number | null;
}

let workingNodes: Record<string, { x: number; y: number; region: number }> = {};
let workingEdges: Record<string, NavlinkWorkingEdge> = {};

let selectInteraction: Select | null = null;
let translateInteraction: Translate | null = null;
let clickHandler: ((e: MapBrowserEvent<any>) => void) | null = null;
let pointerMoveHandler: ((e: MapBrowserEvent<any>) => void) | null = null;
let hoveredFeature: Feature | null = null;

let extendSourceNodeId: string | null = null;
let extendSourceFeature: Feature | null = null;
let previewLineFeature: Feature | null = null;
let previewNodeFeatures: Feature[] = [];

let onChangeCallback: (() => void) | null = null;

const hoverNodeStyle = new Style({
  image: new Circle({
    radius: 6,
    fill: new Fill({ color: "#ff0000" }),
    stroke: new Stroke({ color: "#fff", width: 1.5 }),
  }),
});

const sourceNodeStyle = new Style({
  image: new Circle({
    radius: 7,
    fill: new Fill({ color: "#ff7597" }),
    stroke: new Stroke({ color: "#fff", width: 2 }),
  }),
});

const editNodeStyle = new Style({
  image: new Circle({
    radius: 6,
    fill: new Fill({ color: "#03dac6" }),
    stroke: new Stroke({ color: "#fff", width: 1.5 }),
  }),
});

const newEdgeStyle = new Style({
  stroke: new Stroke({
    color: "#03dac6",
    width: 2,
    lineDash: [4, 4],
  }),
});

const previewEdgeStyle = new Style({
  stroke: new Stroke({
    color: "rgba(3, 218, 198, 0.3)",
    width: 2,
    lineDash: [8, 6],
  }),
});

const previewNodeStyle = new Style({
  image: new Circle({
    radius: 6,
    fill: new Fill({ color: "rgba(3, 218, 198, 0.3)" }),
    stroke: new Stroke({ color: "rgba(255, 255, 255, 0.3)", width: 1 }),
  }),
});

function deepCloneNavlinkData() {
  if (!navlinkData) return;
  workingNodes = JSON.parse(JSON.stringify(navlinkData.nodes || {}));
  workingEdges = JSON.parse(JSON.stringify(navlinkData.edges || {}));
}

function serializeWorkingData(): any {
  const cleanedEdges: Record<string, any> = {};
  for (const [id, edge] of Object.entries(workingEdges)) {
    if (edge.type === "walk") {
      cleanedEdges[id] = {
        from: edge.from,
        to: edge.to,
        type: "walk",
      };
    } else {
      const e: Record<string, any> = {
        from: edge.from,
        to: edge.to,
        type: edge.type,
      };
      if (edge.npc) e.npc = edge.npc;
      if (edge.dest !== null && edge.dest !== undefined) e.dest = edge.dest;
      cleanedEdges[id] = e;
    }
  }

  return {
    version: navlinkData?.version ?? 1,
    date: navlinkData?.date ?? new Date().toISOString().split("T")[0],
    copyright: navlinkData?.copyright ?? "",
    license: navlinkData?.license ?? "",
    maintainer: navlinkData?.maintainer ?? "",
    contributors: navlinkData?.contributors ?? [],
    changelogs: navlinkData?.changelogs ?? [],
    nodes: workingNodes,
    edges: cleanedEdges,
  };
}

function generateNodeId(x: number, y: number, region: number): string {
  const baseId = `${Math.floor(x)}_${Math.floor(y)}_${region < 0 ? region + 65536 : region}`;
  if (workingNodes[baseId]) {
    let counter = 1;
    while (workingNodes[`${baseId}_${counter}`]) counter++;
    return `${baseId}_${counter}`;
  }
  return baseId;
}

function generateEdgeId(from: string, to: string): string {
  return `${from}__${to}`;
}

function markDirty() {
  isDirty = true;
  saveEditsToDB();
  if (onChangeCallback) onChangeCallback();
}

export interface EditActionEntry {
  id: string;
  description: string;
  timestamp: string;
  before: { nodes: typeof workingNodes; edges: typeof workingEdges };
}

let editActions: EditActionEntry[] = [];
let actionIdCounter = 0;

function actionTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

export function getEditActions(): EditActionEntry[] {
  return [...editActions];
}

function pushEditAction(description: string): void {
  editActions.unshift({
    id: String(++actionIdCounter),
    description,
    timestamp: actionTimestamp(),
    before: {
      nodes: JSON.parse(JSON.stringify(workingNodes)),
      edges: JSON.parse(JSON.stringify(workingEdges)),
    },
  });
}

export function revertEditAction(actionId: string): void {
  const idx = editActions.findIndex(a => a.id === actionId);
  if (idx < 0) return;
  const before = editActions[idx].before;
  console.log("[revert] actionId:", actionId, "idx:", idx, "total:", editActions.length, "slicing from", idx + 1, "to end —", "new len:", editActions.length - (idx + 1));
  workingNodes = JSON.parse(JSON.stringify(before.nodes));
  workingEdges = JSON.parse(JSON.stringify(before.edges));
  editActions = editActions.slice(idx + 1);
  isDirty = true;
  saveEditsToDB();
  reRenderFromWorkingData();
  if (onChangeCallback) onChangeCallback();
}

export function clearEditActions(): void {
  editActions = [];
  actionIdCounter = 0;
}

export function setOnChange(cb: (() => void) | null) {
  onChangeCallback = cb;
}

function findNodeFeatureByNodeId(nodeId: string): Feature | null {
  const features = navlinkSource.getFeatures();
  for (const f of features) {
    if (f.get("linkType") === "node" && f.get("nodeId") === nodeId) {
      return f;
    }
  }
  return null;
}

function nodeIdToMapCoords(nodeId: string): number[] | null {
  const feature = findNodeFeatureByNodeId(nodeId);
  if (!feature) return null;
  const geom = feature.getGeometry();
  if (geom instanceof Point) return geom.getCoordinates();
  return null;
}

function findNearestWorkingNode(x: number, y: number, threshold: number, excludeNodeId?: string): { nodeId: string; x: number; y: number; region: number } | null {
  let best: { nodeId: string; x: number; y: number; region: number; dist: number } | null = null;
  for (const [nodeId, node] of Object.entries(workingNodes)) {
    if (nodeId === excludeNodeId) continue;
    const dx = node.x - x;
    const dy = node.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < threshold && (!best || dist < best.dist)) {
      best = { nodeId, x: node.x, y: node.y, region: node.region, dist };
    }
  }
  return best ? { nodeId: best.nodeId, x: best.x, y: best.y, region: best.region } : null;
}

function removePreview() {
  if (previewLineFeature) {
    navlinkSource.removeFeature(previewLineFeature);
    previewLineFeature = null;
  }
  for (const f of previewNodeFeatures) {
    navlinkSource.removeFeature(f);
  }
  previewNodeFeatures = [];
}

function updateExtendPreview(event: MapBrowserEvent<any>, hoveredAtPixel: any) {
  const sourceNode = workingNodes[extendSourceNodeId!];
  if (!sourceNode) { removePreview(); return; }

  const mapCoords = event.coordinate;
  const sro = convertMapToSRO(mapCoords[0], mapCoords[1], currentLayerKey);
  if (!sro) { removePreview(); return; }

  let targetX: number;
  let targetY: number;
  let targetRegion: number;
  let snappedToNode: string | null = null;
  if (hoveredAtPixel && hoveredAtPixel.get("linkType") === "node") {
    targetX = hoveredAtPixel.get("x") as number;
    targetY = hoveredAtPixel.get("y") as number;
    targetRegion = hoveredAtPixel.get("region") as number;
    snappedToNode = hoveredAtPixel.get("nodeId") as string;
    console.log("[snap] pixel hit node:", snappedToNode, "isNew:", !!(workingNodes[snappedToNode] && !navlinkData?.edges?.[`${snappedToNode}_dummy`]));
  } else {
    const sRegion = sro.region < 0 ? sro.region + 65536 : sro.region;
    const nearest = findNearestWorkingNode(sro.x, sro.y, SNAP_THRESHOLD, extendSourceNodeId!);
    if (nearest) {
      targetX = nearest.x;
      targetY = nearest.y;
      targetRegion = nearest.region;
      snappedToNode = nearest.nodeId;
      console.log("[snap] spatial snap to:", nearest.nodeId, "dist:", Math.sqrt((nearest.x - sro.x) ** 2 + (nearest.y - sro.y) ** 2).toFixed(1));
    } else {
      targetX = sro.x;
      targetY = sro.y;
      targetRegion = sRegion;
      console.log("[snap] no snap at sro:", sro.x.toFixed(0), sro.y.toFixed(0), "region:", sRegion);
    }
  }

  const dx = targetX - sourceNode.x;
  const dy = targetY - sourceNode.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance < 1) { removePreview(); return; }

  const nSegments = Math.ceil(distance / SEGMENT_LENGTH);
  const sourceCoords = nodeIdToMapCoords(extendSourceNodeId!);
  if (!sourceCoords) { removePreview(); return; }

  const region = sourceNode.region;
  const points: number[][] = [sourceCoords];
  const nodeCoords: number[][] = [];
  for (let i = 1; i <= nSegments; i++) {
    const t = Math.min(i * SEGMENT_LENGTH / distance, 1);
    const nx = sourceNode.x + dx * t;
    const ny = sourceNode.y + dy * t;
    const coordRegion = i === nSegments && snappedToNode ? targetRegion : region;
    const coord = navlinkToMapCoords(nx, ny, coordRegion);
    points.push(coord);
    if (i < nSegments || !snappedToNode) {
      nodeCoords.push(coord);
    }
  }

  if (previewLineFeature) {
    previewLineFeature.setGeometry(new LineString(points));
  } else {
    previewLineFeature = new Feature({
      geometry: new LineString(points),
      linkType: "preview",
    });
    previewLineFeature.setStyle(previewEdgeStyle);
    navlinkSource.addFeature(previewLineFeature);
  }

  for (const f of previewNodeFeatures) {
    navlinkSource.removeFeature(f);
  }
  previewNodeFeatures = [];
  for (const coord of nodeCoords) {
    const nf = new Feature({ geometry: new Point(coord), linkType: "preview" });
    nf.setStyle(previewNodeStyle);
    navlinkSource.addFeature(nf);
    previewNodeFeatures.push(nf);
  }
}

function clearExtendSource() {
  removePreview();
  if (extendSourceFeature) {
    extendSourceFeature.setStyle(editNodeStyle);
    extendSourceFeature = null;
  }
  extendSourceNodeId = null;
}

function setupPointerMoveHandler() {
  if (!mapInstance) return;

  pointerMoveHandler = (event: MapBrowserEvent<any>) => {
    if (!editorEnabled || currentMode === "view") {
      clearHover();
      removePreview();
      return;
    }

    const pixel = event.pixel;
    const feature = mapInstance!.forEachFeatureAtPixel(pixel, (f) => f, { layerFilter: (l) => l === navlinkLayer });

    if (feature && feature.get("linkType") === "node") {
      if (hoveredFeature !== feature) {
        clearHover();
        hoveredFeature = feature as Feature;
        (feature as Feature).setStyle(hoverNodeStyle);
      }
    } else {
      clearHover();
    }

    if (currentMode === "extend" && extendSourceNodeId) {
      updateExtendPreview(event, feature);
    } else {
      removePreview();
    }
  };

  mapInstance.on("pointermove", pointerMoveHandler);
}

export function getMode(): EditorMode {
  return currentMode;
}

function clearHover() {
  if (hoveredFeature) {
    if (hoveredFeature === extendSourceFeature) {
      hoveredFeature.setStyle(sourceNodeStyle);
    } else {
      hoveredFeature.setStyle(editNodeStyle);
    }
    hoveredFeature = null;
  }
}

function removeInteractions() {
  if (!mapInstance) return;
  if (selectInteraction) {
    mapInstance.removeInteraction(selectInteraction);
    selectInteraction = null;
  }
  if (translateInteraction) {
    mapInstance.removeInteraction(translateInteraction);
    translateInteraction = null;
  }
  if (clickHandler) {
    mapInstance.un("click", clickHandler);
    clickHandler = null;
  }
  if (pointerMoveHandler) {
    mapInstance.un("pointermove", pointerMoveHandler);
    pointerMoveHandler = null;
  }
  clearHover();
  clearExtendSource();
}

export function setMode(mode: EditorMode) {
  removeInteractions();
  currentMode = mode;

  if (!mapInstance || !editorEnabled) return;

  switch (mode) {
    case "extend":
      setupExtendMode();
      break;
    case "move":
      setupMoveMode();
      break;
    case "delete":
      setupDeleteMode();
      break;
  }

  if (mode !== "view") {
    setupPointerMoveHandler();
  }
}

function setupExtendMode() {
  if (!mapInstance) return;

  clickHandler = (event: MapBrowserEvent<any>) => {
    if (!editorEnabled || currentMode !== "extend") return;

    const pixel = event.pixel;
    const feature = mapInstance!.forEachFeatureAtPixel(pixel, (f) => f, { layerFilter: (l) => l === navlinkLayer });

    if (!extendSourceNodeId) {
      if (feature && feature.get("linkType") === "node") {
        extendSourceNodeId = feature.get("nodeId") as string;
        extendSourceFeature = feature as Feature;
        (feature as Feature).setStyle(sourceNodeStyle);
      } else {
        const mapCoords = event.coordinate;
        const sro = convertMapToSRO(mapCoords[0], mapCoords[1], currentLayerKey);
        if (!sro) return;
        const region = sro.region < 0 ? sro.region + 65536 : sro.region;
        const nodeId = generateNodeId(sro.x, sro.y, region);
        console.log("[extend] created new node:", nodeId, "at sro:", sro.x.toFixed(0), sro.y.toFixed(0), "region:", region, "coords:", navlinkToMapCoords(sro.x, sro.y, region));
        pushEditAction(`Created node at ${Math.floor(sro.x)}, ${Math.floor(sro.y)}`);
        workingNodes[nodeId] = { x: sro.x, y: sro.y, region };
        const coords = navlinkToMapCoords(sro.x, sro.y, region);
        const nodeFeature = new Feature({
          geometry: new Point(coords),
          nodeId,
          linkType: "node",
        });
        nodeFeature.set("x", sro.x);
        nodeFeature.set("y", sro.y);
        nodeFeature.set("region", region);
        nodeFeature.setStyle(editNodeStyle);
        navlinkSource.addFeature(nodeFeature);
        extendSourceNodeId = nodeId;
        extendSourceFeature = nodeFeature;
        nodeFeature.setStyle(sourceNodeStyle);
        markDirty();
      }
      return;
    }

    let targetX: number;
    let targetY: number;
    let targetRegion: number;
    let existingTargetNodeId: string | null = null;

    if (feature && feature.get("linkType") === "node") {
      existingTargetNodeId = feature.get("nodeId") as string;
      targetX = feature.get("x") as number;
      targetY = feature.get("y") as number;
      targetRegion = feature.get("region") as number;
    } else {
      const mapCoords = event.coordinate;
      const sro = convertMapToSRO(mapCoords[0], mapCoords[1], currentLayerKey);
      if (!sro) return;
      targetX = sro.x;
      targetY = sro.y;
      targetRegion = sro.region < 0 ? sro.region + 65536 : sro.region;
    }

    const sourceNode = workingNodes[extendSourceNodeId];
    if (!sourceNode) { clearExtendSource(); return; }

    const dx = targetX - sourceNode.x;
    const dy = targetY - sourceNode.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 1) return;

    const region = sourceNode.region;
    let prevNodeId = extendSourceNodeId;
    const nSegments = Math.ceil(distance / SEGMENT_LENGTH);
    if (existingTargetNodeId) {
      pushEditAction(`Extended to existing node ${existingTargetNodeId}`);
    } else {
      pushEditAction(`Extended to (${Math.floor(targetX)}, ${Math.floor(targetY)})`);
    }

    for (let i = 1; i <= nSegments; i++) {
      const t = Math.min(i * SEGMENT_LENGTH / distance, 1);
      const nx = sourceNode.x + dx * t;
      const ny = sourceNode.y + dy * t;

      if (i === nSegments && existingTargetNodeId) {
        const edgeId = generateEdgeId(prevNodeId, existingTargetNodeId);
        const prevCoords = nodeIdToMapCoords(prevNodeId);
        const targetCoords = navlinkToMapCoords(targetX, targetY, targetRegion);
        if (prevCoords) {
          const edgeFeature = new Feature({
            geometry: new LineString([prevCoords, targetCoords]),
            from: prevNodeId,
            to: existingTargetNodeId,
            linkType: "walk",
            isConnection: true,
            isNavlinkEdge: true,
          });
          edgeFeature.setStyle(newEdgeStyle);
          navlinkSource.addFeature(edgeFeature);
        }
        workingEdges[edgeId] = { from: prevNodeId, to: existingTargetNodeId, type: "walk" };
        prevNodeId = existingTargetNodeId;
      } else {
        const nodeId = generateNodeId(nx, ny, region);

        workingNodes[nodeId] = { x: nx, y: ny, region };

        const coords = navlinkToMapCoords(nx, ny, region);
        const nodeFeature = new Feature({
          geometry: new Point(coords),
          nodeId,
          linkType: "node",
        });
        nodeFeature.set("x", nx);
        nodeFeature.set("y", ny);
        nodeFeature.set("region", region);
        nodeFeature.setStyle(editNodeStyle);
        navlinkSource.addFeature(nodeFeature);

        const edgeId = generateEdgeId(prevNodeId, nodeId);
        const prevCoords = nodeIdToMapCoords(prevNodeId);
        if (prevCoords) {
          const edgeFeature = new Feature({
            geometry: new LineString([prevCoords, coords]),
            from: prevNodeId,
            to: nodeId,
            linkType: "walk",
            isConnection: true,
            isNavlinkEdge: true,
          });
          edgeFeature.setStyle(newEdgeStyle);
          navlinkSource.addFeature(edgeFeature);
        }

        workingEdges[edgeId] = { from: prevNodeId, to: nodeId, type: "walk" };
        prevNodeId = nodeId;
      }
    }

    const oldSourceFeature = extendSourceFeature;
    const lastNodeId = prevNodeId;
    clearExtendSource();
    if (oldSourceFeature) {
      oldSourceFeature.setStyle(editNodeStyle);
    }
    const lastFeature = findNodeFeatureByNodeId(lastNodeId);
    if (lastFeature) {
      extendSourceNodeId = lastNodeId;
      extendSourceFeature = lastFeature;
      lastFeature.setStyle(sourceNodeStyle);
    }
    markDirty();
  };

  mapInstance.on("click", clickHandler);

  selectInteraction = new Select({
    condition: () => false,
    layers: [navlinkLayer],
  });
  mapInstance.addInteraction(selectInteraction);
}

function setupMoveMode() {
  if (!mapInstance) return;

  translateInteraction = new Translate({
    layers: [navlinkLayer],
    hitTolerance: 8,
  });

  let movingNodeId: string | null = null;

  translateInteraction.on("translatestart", (event) => {
    const feature = event.features.item(0);
    if (feature && feature.get("linkType") === "node") {
      movingNodeId = feature.get("nodeId") as string;
    }
  });

  translateInteraction.on("translating", (event) => {
    if (!movingNodeId) return;
    const feature = event.features.item(0);
    if (!feature) return;
    const coords = (feature.getGeometry() as Point).getCoordinates();
    updateEdgeGeometriesForNodeFromCoords(movingNodeId, coords);
  });

  translateInteraction.on("translateend", (event) => {
    if (!movingNodeId) return;
    const feature = event.features.item(0);
    if (!feature) { movingNodeId = null; return; }

    const coords = (feature.getGeometry() as Point).getCoordinates();
    const sro = convertMapToSRO(coords[0], coords[1], currentLayerKey);
    if (!sro) { movingNodeId = null; return; }

    const region = sro.region < 0 ? sro.region + 65536 : sro.region;
    feature.set("x", sro.x);
    feature.set("y", sro.y);
    feature.set("region", region);

    if (workingNodes[movingNodeId]) {
      const oldNode = workingNodes[movingNodeId];
      pushEditAction(`Moved node from (${Math.floor(oldNode.x)}, ${Math.floor(oldNode.y)}) to (${Math.floor(sro.x)}, ${Math.floor(sro.y)})`);
      workingNodes[movingNodeId] = { x: sro.x, y: sro.y, region };
    }

    updateEdgeGeometriesForNode(movingNodeId);
    movingNodeId = null;
    markDirty();
  });

  mapInstance.addInteraction(translateInteraction);
}

function setupDeleteMode() {
  if (!mapInstance) return;

  clickHandler = (event: MapBrowserEvent<any>) => {
    if (!editorEnabled || currentMode !== "delete") return;

    const pixel = event.pixel;
    const feature = mapInstance!.forEachFeatureAtPixel(pixel, (f) => f, { layerFilter: (l) => l === navlinkLayer });
    if (!feature) return;

    const linkType = feature.get("linkType") as string;
    if (linkType === "node") {
      const nodeId = feature.get("nodeId") as string;
      pushEditAction(`Deleted node ${nodeId}`);
      delete workingNodes[nodeId];
      const toRemove: string[] = [];
      for (const [edgeId, edge] of Object.entries(workingEdges)) {
        if (edge.from === nodeId || edge.to === nodeId) {
          toRemove.push(edgeId);
        }
      }
      for (const edgeId of toRemove) {
        delete workingEdges[edgeId];
      }
      const edgeFeatures = navlinkSource.getFeatures().filter((f) => {
        const ft = f.get("linkType") as string;
        return (ft === "walk" || ft === "teleport") && (f.get("from") === nodeId || f.get("to") === nodeId);
      });
      edgeFeatures.forEach((f) => navlinkSource.removeFeature(f));
    } else if (linkType === "walk" || linkType === "teleport") {
      const from: string = feature.get("from");
      const to: string = feature.get("to");
      pushEditAction(`Deleted edge from ${from} to ${to}`);
      const edgeId = generateEdgeId(from, to);
      delete workingEdges[edgeId];
      const reverseId = generateEdgeId(to, from);
      delete workingEdges[reverseId];
    } else {
      return;
    }

    navlinkSource.removeFeature(feature as Feature);
    markDirty();
  };

  mapInstance.on("click", clickHandler);

  selectInteraction = new Select({
    condition: () => false,
    layers: [navlinkLayer],
  });
  mapInstance.addInteraction(selectInteraction);
}

function updateEdgeGeometriesForNode(nodeId: string) {
  const features = navlinkSource.getFeatures();
  for (const f of features) {
    if (f.get("linkType") !== "walk" && f.get("linkType") !== "teleport") continue;
    const from = f.get("from") as string;
    const to = f.get("to") as string;
    if (from === nodeId || to === nodeId) {
      const fromCoords = nodeIdToMapCoords(from);
      const toCoords = nodeIdToMapCoords(to);
      if (fromCoords && toCoords) {
        f.setGeometry(new LineString([fromCoords, toCoords]));
      }
    }
  }
}

function updateEdgeGeometriesForNodeFromCoords(nodeId: string, newCoords: number[]) {
  const features = navlinkSource.getFeatures();
  for (const f of features) {
    if (f.get("linkType") !== "walk" && f.get("linkType") !== "teleport") continue;
    const from = f.get("from") as string;
    const to = f.get("to") as string;
    if (from === nodeId || to === nodeId) {
      const otherId = from === nodeId ? to : from;
      const otherCoords = nodeIdToMapCoords(otherId);
      if (otherCoords) {
        const lineFrom = from === nodeId ? newCoords : otherCoords;
        const lineTo = to === nodeId ? newCoords : otherCoords;
        f.setGeometry(new LineString([lineFrom, lineTo]));
      }
    }
  }
}

function navlinkToMapCoords(x: number, y: number, region: number): number[] {
  if (region > 32767 || region < 0) {
    return [128 + x / 1920, 127 + y / 1920];
  }
  return [x / 192 + 135, y / 192 + 91];
}

export function initEditor(map: Map) {
  mapInstance = map;
}

export async function refreshEditorData() {
  deepCloneNavlinkData();
  await loadEditsFromDB();
  reRenderFromWorkingData();
}

export function setEditorEnabled(enabled: boolean) {
  if (enabled === editorEnabled) return;

  editorEnabled = enabled;

  if (enabled) {
    navlinkLayer.setVisible(true);
    currentMode = "view";
    deepCloneNavlinkData();
    loadEditsFromDB().then(() => {
      reRenderFromWorkingData();
    });
  } else {
    removeInteractions();
    currentMode = "view";
    isDirty = false;
    extendSourceNodeId = null;
    extendSourceFeature = null;
    workingNodes = {};
    workingEdges = {};
    updateNavlinkViz(currentLayerKey);
  }
}

function reRenderFromWorkingData() {
  navlinkSource.clear();
  if (!mapInstance) return;

  const mapCoords: Record<string, number[]> = {};

  for (const [nodeId, node] of Object.entries(workingNodes)) {
    let region = node.region;
    if (region < 0) region += 65536;

    const isWorld = currentLayerKey === "world";
    let show = false;
    if (isWorld) {
      show = region < 32768;
    } else {
      const dungeonFloorKey = getDungeonFloorKey(node.x, node.y, region);
      show = dungeonFloorKey === currentLayerKey;
    }

    if (show) {
      const coords = navlinkToMapCoords(node.x, node.y, region);
      mapCoords[nodeId] = coords;
    }
  }

  for (const [nodeId, coords] of Object.entries(mapCoords)) {
    const node = workingNodes[nodeId];
    const feature = new Feature({
      geometry: new Point(coords),
      nodeId,
      linkType: "node",
    });
    feature.set("x", node.x);
    feature.set("y", node.y);
    feature.set("region", node.region);
    feature.setStyle(editNodeStyle);
    navlinkSource.addFeature(feature);
  }

  for (const edge of Object.values(workingEdges)) {
    const fromCoords = mapCoords[edge.from];
    const toCoords = mapCoords[edge.to];
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
      if (!navlinkData?.edges?.[generateEdgeId(edge.from, edge.to)]) {
        feature.setStyle(newEdgeStyle);
      }
      navlinkSource.addFeature(feature);
    }
  }
}

async function saveEditsToDB() {
  try {
    const data = serializeWorkingData();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    await PMTilesDB.set(EDITS_DB_KEY, blob);
  } catch (e) {
    console.error("Failed to save navlink edits:", e);
  }
}

async function loadEditsFromDB() {
  try {
    const blob = await PMTilesDB.get(EDITS_DB_KEY);
    if (blob) {
      const text = await blob.text();
      const data = JSON.parse(text);
      if (data.nodes) workingNodes = data.nodes;
      if (data.edges) workingEdges = data.edges;
      isDirty = true;
    }
  } catch (e) {
    console.error("Failed to load navlink edits:", e);
  }
}

export async function resetEdits() {
  isDirty = false;
  clearEditActions();
  await PMTilesDB.delete(EDITS_DB_KEY);
  workingNodes = JSON.parse(JSON.stringify(navlinkData.nodes || {}));
  workingEdges = JSON.parse(JSON.stringify(navlinkData.edges || {}));
  reRenderFromWorkingData();
  if (onChangeCallback) onChangeCallback();
}

export function exportNavlink() {
  const data = serializeWorkingData();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "navigation_linkage_edited.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const CHECKPOINTS_MANIFEST_KEY = "navlink_checkpoints_manifest";

export interface CheckpointEntry {
  id: string;
  timestamp: string;
  nodeCount: number;
  walkEdgeCount: number;
  teleportEdgeCount: number;
  newWalkCount: number;
  newTeleportCount: number;
}

function countCheckpointTypes(): { walkEdgeCount: number; teleportEdgeCount: number; nodeCount: number; newWalkCount: number; newTeleportCount: number } {
  let walkEdgeCount = 0;
  let teleportEdgeCount = 0;
  let newWalkCount = 0;
  let newTeleportCount = 0;
  const originalEdges = navlinkData?.edges ?? {};
  for (const [edgeId, edge] of Object.entries(workingEdges)) {
    if (edge.type === "teleport") teleportEdgeCount++;
    else walkEdgeCount++;
    if (!originalEdges[edgeId]) {
      if (edge.type === "teleport") newTeleportCount++;
      else newWalkCount++;
    }
  }
  return {
    walkEdgeCount,
    teleportEdgeCount,
    nodeCount: Object.keys(workingNodes).length,
    newWalkCount,
    newTeleportCount,
  };
}

async function getCheckpointManifest(): Promise<CheckpointEntry[]> {
  try {
    const blob = await PMTilesDB.get(CHECKPOINTS_MANIFEST_KEY);
    if (blob) return JSON.parse(await blob.text());
  } catch (e) {
    console.error("Failed to load checkpoint manifest:", e);
  }
  return [];
}

async function setCheckpointManifest(manifest: CheckpointEntry[]): Promise<void> {
  const blob = new Blob([JSON.stringify(manifest)], { type: "application/json" });
  await PMTilesDB.set(CHECKPOINTS_MANIFEST_KEY, blob);
}

export async function saveCheckpoint(): Promise<string> {
  const timestamp = actionTimestamp();
  const counts = countCheckpointTypes();
  const data = serializeWorkingData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  await PMTilesDB.set(`navlink_checkpoint_${timestamp}`, blob);

  const manifest = await getCheckpointManifest();
  manifest.unshift({
    id: timestamp,
    timestamp,
    nodeCount: counts.nodeCount,
    walkEdgeCount: counts.walkEdgeCount,
    teleportEdgeCount: counts.teleportEdgeCount,
    newWalkCount: counts.newWalkCount,
    newTeleportCount: counts.newTeleportCount,
  });
  await setCheckpointManifest(manifest);

  return timestamp;
}

export async function getCheckpoints(): Promise<CheckpointEntry[]> {
  return await getCheckpointManifest();
}

export async function loadCheckpoint(id: string): Promise<void> {
  const blob = await PMTilesDB.get(`navlink_checkpoint_${id}`);
  if (!blob) throw new Error("Checkpoint not found");
  const text = await blob.text();
  const data = JSON.parse(text);
  if (!data.nodes || !data.edges) throw new Error("Invalid checkpoint data");
  workingNodes = JSON.parse(JSON.stringify(data.nodes));
  workingEdges = JSON.parse(JSON.stringify(data.edges));
  isDirty = true;
  clearEditActions();
  saveEditsToDB();
  reRenderFromWorkingData();
  if (onChangeCallback) onChangeCallback();
}

export async function deleteCheckpoint(id: string): Promise<void> {
  await PMTilesDB.delete(`navlink_checkpoint_${id}`);
  const manifest = await getCheckpointManifest();
  await setCheckpointManifest(manifest.filter((e) => e.id !== id));
}

export async function loadCustomFile(file: File): Promise<void> {
  try {
    let text: string;
    try {
      text = await file.text();
      JSON.parse(text);
    } catch {
      const buffer = await file.arrayBuffer();
      text = await decompressGzipBufferToText(buffer);
      JSON.parse(text);
    }

    const data = JSON.parse(text);
    if (!data.nodes || !data.edges) {
      throw new Error("Invalid navlink file: missing nodes or edges");
    }

    workingNodes = JSON.parse(JSON.stringify(data.nodes));
    workingEdges = JSON.parse(JSON.stringify(data.edges));
    isDirty = true;
    clearEditActions();
    saveEditsToDB();
    reRenderFromWorkingData();
    if (onChangeCallback) onChangeCallback();
  } catch (e) {
    throw new Error(`Failed to load navlink file: ${e}`);
  }
}

function sroLocalToWorld(region: number, x: number, y: number): { x: number; y: number; region: number } {
  let r = region < 0 ? region + 65536 : region;
  if (r < 32768) {
    const xSec = r & 0xff;
    const ySec = r >> 8;
    const secX = xSec + x / 1920;
    const secY = ySec + y / 1920 - 1;
    return {
      x: (secX - 135) * 192,
      y: (secY - 91) * 192,
      region: r,
    };
  }
  return { x, y, region: r };
}

function findOrCreateWorkingNode(
  wx: number,
  wy: number,
  region: number,
  snapDist = 60
): { nodeId: string; created: boolean } {
  const nearest = findNearestWorkingNode(wx, wy, snapDist);
  if (nearest) {
    return { nodeId: nearest.nodeId, created: false };
  }
  const nodeId = generateNodeId(wx, wy, region);
  workingNodes[nodeId] = { x: wx, y: wy, region };
  return { nodeId, created: true };
}

export function importSingleTeleportLink(
  src: { codename: string; x: number; y: number; region: number },
  dst: { name: string; x: number; y: number; region: number; target_id?: number | null },
  snapDist = 60
): { edgeId: string; createdNodes: number } {
  pushEditAction(`Imported teleport ${src.codename} → ${dst.name}`);

  let createdNodes = 0;
  const srcCoord = sroLocalToWorld(src.region, src.x, src.y);
  const srcNode = findOrCreateWorkingNode(srcCoord.x, srcCoord.y, srcCoord.region, snapDist);
  if (srcNode.created) createdNodes++;

  const dstCoord = sroLocalToWorld(dst.region, dst.x, dst.y);
  const dstNode = findOrCreateWorkingNode(dstCoord.x, dstCoord.y, dstCoord.region, snapDist);
  if (dstNode.created) createdNodes++;

  const edgeId = generateEdgeId(srcNode.nodeId, dstNode.nodeId);
  const targetId = dst.target_id ?? null;

  const newEdge: NavlinkWorkingEdge = {
    from: srcNode.nodeId,
    to: dstNode.nodeId,
    type: "teleport",
  };
  if (src.codename) newEdge.npc = src.codename;
  if (targetId !== null && targetId !== undefined) newEdge.dest = targetId;

  workingEdges[edgeId] = newEdge;

  markDirty();
  reRenderFromWorkingData();

  return { edgeId, createdNodes };
}

export function importTeleportLinks(
  teleports: any[],
  snapDist = 60
): { added: number; updated: number; createdNodes: number } {
  pushEditAction(`Imported teleport batch`);

  let added = 0;
  let updated = 0;
  let createdNodes = 0;

  for (const tp of teleports) {
    const codename = tp.codename || tp.name;
    const dests = tp.teleport;
    if (!Array.isArray(dests) || dests.length === 0) continue;

    const srcCoord = sroLocalToWorld(tp.region, tp.x, tp.y);
    const src = findOrCreateWorkingNode(srcCoord.x, srcCoord.y, srcCoord.region, snapDist);
    if (src.created) createdNodes++;

    for (const dst of dests) {
      const targetId = dst.target_id ?? null;
      const dstCoord = sroLocalToWorld(dst.region, dst.x, dst.y);
      const target = findOrCreateWorkingNode(dstCoord.x, dstCoord.y, dstCoord.region, snapDist);
      if (target.created) createdNodes++;

      const edgeId = generateEdgeId(src.nodeId, target.nodeId);
      const existing = workingEdges[edgeId];
      if (existing) {
        if (existing.type !== "teleport" || existing.npc !== codename || existing.dest !== targetId) {
          existing.type = "teleport";
          if (codename) existing.npc = codename;
          if (targetId !== null && targetId !== undefined) existing.dest = targetId;
          updated++;
        }
      } else {
        const edgeObj: NavlinkWorkingEdge = {
          from: src.nodeId,
          to: target.nodeId,
          type: "teleport",
        };
        if (codename) edgeObj.npc = codename;
        if (targetId !== null && targetId !== undefined) edgeObj.dest = targetId;
        workingEdges[edgeId] = edgeObj;
        added++;
      }
    }
  }

  if (added > 0 || updated > 0 || createdNodes > 0) {
    markDirty();
    reRenderFromWorkingData();
  }

  return { added, updated, createdNodes };
}

