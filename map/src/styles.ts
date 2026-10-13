import { Style, Icon, Stroke } from "ol/style";
import { assetUrl } from "./asset_url";

// SRO Sector coordinate bounds normalized at zoom 9
export const WORLD_BOUNDS_Z9 = { minX: 52, maxX: 505, minY: 70, maxY: 253 };

export const TELEPORT_TYPES: Record<number, string> = {
  0: "Dimensional Gate",
  1: "Fortress Gate",
  2: "Revival Gate",
  3: "Glory Gate",
  4: "Small Fortress Gate",
  5: "Teleport Gate",
  6: "Tahomet Gate",
  7: "NPC Teleporter",
};

export const npcStyle = new Style({
  image: new Icon({
    src: assetUrl("icons/mm_sign_npc.png"),
    anchor: [0.5, 0.5],
    scale: 1.5,
  }),
});

export const teleportStyles: Record<number, Style> = {
  0: new Style({
    image: new Icon({
      src: assetUrl("icons/xy_gate.png"),
      anchor: [0.5, 0.5],
    }),
  }),
  1: new Style({
    image: new Icon({
      src: assetUrl("icons/fort_worldmap.png"),
      anchor: [0.5, 0.5],
    }),
  }),
  2: new Style({
    image: new Icon({
      src: assetUrl("icons/strut_revival_gate.png"),
      anchor: [0.5, 0.5],
    }),
  }),
  3: new Style({
    image: new Icon({
      src: assetUrl("icons/strut_glory_gate.png"),
      anchor: [0.5, 0.5],
    }),
  }),
  4: new Style({
    image: new Icon({
      src: assetUrl("icons/fort_small_worldmap.png"),
      anchor: [0.5, 0.5],
    }),
  }),
  5: new Style({
    image: new Icon({
      src: assetUrl("icons/map_world_icontel.png"),
      anchor: [0.5, 0.5],
    }),
  }),
  6: new Style({
    image: new Icon({
      src: assetUrl("icons/tahomet_gate.png"),
      anchor: [0.5, 0.5],
    }),
  }),
};

export const connectionStyles: Record<number, Style> = {
  0: new Style({
    stroke: new Stroke({
      color: "#bb86fc",
      width: 1.5,
      lineDash: [4, 4],
    }),
  }),
  1: new Style({
    stroke: new Stroke({
      color: "#ff9100",
      width: 1.5,
      lineDash: [4, 4],
    }),
  }),
  2: new Style({
    stroke: new Stroke({
      color: "#00e676",
      width: 1.5,
      lineDash: [4, 4],
    }),
  }),
  3: new Style({
    stroke: new Stroke({
      color: "#00e5ff",
      width: 1.5,
      lineDash: [4, 4],
    }),
  }),
  4: new Style({
    stroke: new Stroke({
      color: "#ffd740",
      width: 1.5,
      lineDash: [4, 4],
    }),
  }),
  5: new Style({
    stroke: new Stroke({
      color: "#ff5252",
      width: 1.5,
      lineDash: [4, 4],
    }),
  }),
  6: new Style({
    stroke: new Stroke({
      color: "#1de9b6",
      width: 1.5,
      lineDash: [4, 4],
    }),
  }),
  7: new Style({
    stroke: new Stroke({
      color: "#ff4081",
      width: 1.5,
      lineDash: [4, 4],
    }),
  }),
};

export const solidConnectionStyles: Record<number, Style> = {};
for (const key in connectionStyles) {
  const type = parseInt(key, 10);
  const stroke = connectionStyles[type].getStroke()!;
  solidConnectionStyles[type] = new Style({
    stroke: new Stroke({
      color: stroke.getColor(),
      width: 2.5,
    }),
  });
}
