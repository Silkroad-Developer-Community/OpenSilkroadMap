import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Style, Circle, Fill, Stroke } from "ol/style";

export const navlinkSource = new VectorSource();
export const navlinkLayer = new VectorLayer({
  source: navlinkSource,
  visible: false,
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
