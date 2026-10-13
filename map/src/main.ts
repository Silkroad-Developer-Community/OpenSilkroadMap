import {
  currentLayerKey,
  map,
  mapLayer,
  overlay,
  regionOverlaySource,
  registerCachedPMTiles,
  resetLastRegionId,
  setCurrentLayerKey,
  tileSource,
  updateCoordsVal,
} from "./map";
import { getDungeonFloorKey, navmeshManifestPromise, registerCachedNavmesh, updateNavmesh } from "./navmesh";
import {
  fetchMarkersData,
  npcsData,
  renderTeleports,
  setRenderTeleports,
  teleportsData,
  updateMarkers,
} from "./markers";
import { convertSROToMap } from "./coord";
import { TELEPORT_TYPES } from "./styles";
import { PMTilesDB } from "./pmtiles_db";
import { assetUrl } from "./asset_url";
import {
  initEditor,
  setEditorEnabled,
  setMode,
  exportNavlink,
  resetEdits,
  loadCustomFile,
  editorEnabled,
  isDirty,
  getMode,
  setOnChange,
  getEditActions,
  revertEditAction,
  saveCheckpoint,
  getCheckpoints,
  loadCheckpoint,
  deleteCheckpoint,
} from "./navlink_editor";

// Handle map tiles toggle change
const mapTilesToggle = document.getElementById("maptiles-toggle") as HTMLInputElement | null;
if (mapTilesToggle) {
  const savedMapTiles = localStorage.getItem("maptiles-toggle");
  if (savedMapTiles !== null) {
    mapTilesToggle.checked = savedMapTiles === "true";
  }
  mapLayer.setVisible(mapTilesToggle.checked);
  mapTilesToggle.addEventListener("change", () => {
    localStorage.setItem("maptiles-toggle", String(mapTilesToggle.checked));
    mapLayer.setVisible(mapTilesToggle.checked);
  });
}

// Handle navmesh toggle change
const navmeshToggle = document.getElementById("navmesh-toggle") as HTMLInputElement | null;
if (navmeshToggle) {
  const savedNavmesh = localStorage.getItem("navmesh-toggle");
  if (savedNavmesh !== null) {
    navmeshToggle.checked = savedNavmesh === "true";
  }
  navmeshToggle.addEventListener("change", () => {
    localStorage.setItem("navmesh-toggle", String(navmeshToggle.checked));
    updateNavmesh(map, currentLayerKey);
  });
}

// Handle region info toggle change
const regionToggle = document.getElementById("region-info-toggle") as HTMLInputElement | null;
if (regionToggle) {
  const savedRegion = localStorage.getItem("region-info-toggle");
  if (savedRegion !== null) {
    regionToggle.checked = savedRegion === "true";
  }
  regionToggle.addEventListener("change", () => {
    localStorage.setItem("region-info-toggle", String(regionToggle.checked));
    if (!regionToggle.checked) {
      regionOverlaySource.clear();
      resetLastRegionId();
    }
  });
}

// Handle teleport connection toggles changes
for (let i = 0; i <= 7; i++) {
  const toggle = document.getElementById(`toggle-conn-${i}`) as HTMLInputElement | null;
  if (toggle) {
    const savedToggle = localStorage.getItem(`toggle-conn-${i}`);
    if (savedToggle !== null) {
      toggle.checked = savedToggle === "true";
    }
    toggle.addEventListener("change", () => {
      localStorage.setItem(`toggle-conn-${i}`, String(toggle.checked));
      updateMarkers(currentLayerKey);
    });
  }
}

// Handle toggle all connections button
const toggleAllBtn = document.getElementById("toggle-all-conn");
if (toggleAllBtn) {
  toggleAllBtn.addEventListener("click", () => {
    let anyChecked = false;
    const checkboxes: HTMLInputElement[] = [];
    for (let i = 0; i <= 7; i++) {
      const cb = document.getElementById(`toggle-conn-${i}`) as HTMLInputElement | null;
      if (cb) {
        checkboxes.push(cb);
        if (cb.checked) {
          anyChecked = true;
        }
      }
    }

    const targetState = !anyChecked;
    checkboxes.forEach((cb, i) => {
      cb.checked = targetState;
      localStorage.setItem(`toggle-conn-${i}`, String(targetState));
    });

    updateMarkers(currentLayerKey);
  });
}

// Handle layer selection updates
const layerSelect = document.getElementById("layer-select") as HTMLSelectElement | null;
if (layerSelect) {
  layerSelect.addEventListener("change", (e) => {
    // Disable editor if active, warn on dirty
    if (editorEnabled) {
      if (isDirty && !confirm("Switch layer? Unsaved edits will be lost.")) {
        layerSelect.value = currentLayerKey;
        return;
      }
      if (editorToggle) editorToggle.checked = false;
      setEditorEnabled(false);
      updateEditorUI();
    }

    const target = e.target as HTMLSelectElement;
    setCurrentLayerKey(target.value);

    // Refresh the background JPEGs source
    tileSource.clear();
    mapLayer.setSource(null);
    mapLayer.setSource(tileSource);

    // Redraw markers and navmeshes
    updateMarkers(currentLayerKey);
    updateNavmesh(map, currentLayerKey);
    updateCoordsVal();

    // Re-center maps
    const view = map.getView();
    if (currentLayerKey === "world") {
      view.setCenter([135, 91]);
      view.setZoom(6);
    } else {
      view.setCenter([128, 127]);
      view.setZoom(8);
    }
  });
}

// Trigger initial remote datasets fetch and render
fetchMarkersData(() => {
  updateMarkers(currentLayerKey);
  updateNavmesh(map, currentLayerKey);
});

let teleportRenderTimeout: number | null = null;

map.on("movestart", () => {
  if (teleportRenderTimeout !== null) {
    clearTimeout(teleportRenderTimeout);
    teleportRenderTimeout = null;
  }
  setRenderTeleports(false);
  updateMarkers(currentLayerKey);
});

map.on("pointerdrag", () => {
  if (teleportRenderTimeout !== null) {
    clearTimeout(teleportRenderTimeout);
    teleportRenderTimeout = null;
  }
  if (renderTeleports) {
    setRenderTeleports(false);
    updateMarkers(currentLayerKey);
  }
});

map.on("moveend", () => {
  if (teleportRenderTimeout !== null) {
    clearTimeout(teleportRenderTimeout);
  }
  teleportRenderTimeout = window.setTimeout(() => {
    teleportRenderTimeout = null;
    setRenderTeleports(true);
    updateMarkers(currentLayerKey);
  }, 500);
});

// Search input and dropdown functionality with collapsed details tags
const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
const searchResults = document.getElementById("search-results") as HTMLDivElement | null;

function renderCategories(query = "") {
  if (!searchResults) return;
  searchResults.innerHTML = "";

  const matchedNPCs = npcsData
    .filter((n) => !query || n.name.toLowerCase().includes(query))
    .map((n) => ({ ...n, typeName: "NPC", category: "NPC" }));

  const matchedTPs = teleportsData
    .filter((t) => !query || t.name.toLowerCase().includes(query))
    .map((t) => {
      const typeName = TELEPORT_TYPES[t.type] || "Teleport";
      return { ...t, typeName, category: typeName };
    });

  const allItems = [...matchedNPCs, ...matchedTPs];

  // Group by category
  const groups: Record<string, typeof allItems> = {
    NPC: [],
    "Dimensional Gate": [],
    "Fortress Gate": [],
    "Revival Gate": [],
    "Glory Gate": [],
    "Small Fortress Gate": [],
    "Teleport Gate": [],
    "Tahomet Gate": [],
    "NPC Teleport": [],
  };

  allItems.forEach((item) => {
    const cat = item.category || "Teleport";
    if (!groups[cat]) {
      groups[cat] = [];
    }
    groups[cat].push(item);
  });

  let hasAnyMatches = false;

  Object.entries(groups).forEach(([categoryName, items]) => {
    if (items.length === 0) return;
    hasAnyMatches = true;

    const detailsEl = document.createElement("details");
    if (query) {
      detailsEl.open = true; // expand when searched
    }

    const summaryEl = document.createElement("summary");
    summaryEl.textContent = `${categoryName} (${items.length})`;
    detailsEl.appendChild(summaryEl);

    // Limit default visible items to 100 inside a category for performance
    const itemsToShow = query ? items : items.slice(0, 100);

    itemsToShow.forEach((item) => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "search-result-item";
      itemDiv.textContent = item.name;
      itemDiv.addEventListener("click", () => {
        let region = item.region;
        if (region < 0) region += 65536;

        let targetLayerKey = "world";
        if (region >= 32768) {
          const dungeonFloorKey = getDungeonFloorKey(item.x, item.y, region);
          if (dungeonFloorKey) {
            targetLayerKey = dungeonFloorKey;
          }
        }

        if (currentLayerKey !== targetLayerKey) {
          setCurrentLayerKey(targetLayerKey);
          if (layerSelect) {
            layerSelect.value = targetLayerKey;
          }

          tileSource.clear();
          mapLayer.setSource(null);
          mapLayer.setSource(tileSource);

          updateMarkers(currentLayerKey);
          updateNavmesh(map, currentLayerKey);
        }

        const coords = convertSROToMap(item.x, item.y, region);
        const view = map.getView();
        view.animate({
          center: coords,
          zoom: 11,
          duration: 500,
        });

        // Show popup
        const regionString = targetLayerKey === "world" ? `${region} (${region & 0xff},${region >> 8})` : `${region}`;

        const contentEl = document.getElementById("popup-content");
        if (contentEl) {
          contentEl.innerHTML = `
            <div class="popup-title">${item.name}</div>
            <div class="popup-detail">Type: ${item.typeName}</div>
            <div class="popup-detail">X: ${item.x}</div>
            <div class="popup-detail">Y: ${item.y}</div>
            <div class="popup-detail">Region: ${regionString}</div>
          `;
        }
        overlay.setPosition(coords);
      });
      detailsEl.appendChild(itemDiv);
    });

    if (!query && items.length > 100) {
      const moreDiv = document.createElement("div");
      moreDiv.className = "search-result-item";
      moreDiv.style.cursor = "default";
      moreDiv.style.color = "#888";
      moreDiv.style.fontStyle = "italic";
      moreDiv.textContent = `... and ${items.length - 100} more (use search to filter)`;
      detailsEl.appendChild(moreDiv);
    }

    searchResults.appendChild(detailsEl);
  });

  if (!hasAnyMatches) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "search-result-item";
    emptyDiv.style.cursor = "default";
    emptyDiv.style.color = "#888";
    emptyDiv.textContent = "No results found";
    searchResults.appendChild(emptyDiv);
  }
}

if (searchInput && searchResults) {
  searchInput.addEventListener("focus", () => {
    renderCategories(searchInput.value.toLowerCase().trim());
    searchResults.style.display = "block";
  });

  searchInput.addEventListener("input", () => {
    renderCategories(searchInput.value.toLowerCase().trim());
    searchResults.style.display = "block";
  });

  // Hide search results when clicking outside
  document.addEventListener("click", (e) => {
    if (
      searchInput &&
      searchResults &&
      !searchInput.contains(e.target as Node) &&
      !searchResults.contains(e.target as Node)
    ) {
      searchResults.style.display = "none";
    }
  });
}

const precacheToggle = document.getElementById("precache-toggle") as HTMLInputElement | null;
const precacheProgress = document.getElementById("precache-progress");
const precachePercent = document.getElementById("precache-percent");
const precacheCount = document.getElementById("precache-count");

const ARCHIVE_KEYS = [
  "world",
  "navmesh_world",
  "32769_1",
  "32769_2",
  "32769_3",
  "32769_4",
  "32775",
  "32774",
  "32773",
  "32772",
  "32771",
  "32770",
  "32784",
  "32786",
  "32785",
];

async function getArchiveKeys() {
  const manifest = await navmeshManifestPromise;
  const dungeonNavmeshKeys = Object.values(manifest ?? {})
    .flat()
    .map((floor) => floor.archive.replace(/\.pmtiles$/, ""));
  return [...ARCHIVE_KEYS, ...dungeonNavmeshKeys];
}

if (precacheToggle && precacheProgress && precachePercent && precacheCount) {
  const savedPrecache = localStorage.getItem("precache-toggle");
  if (savedPrecache !== null) {
    precacheToggle.checked = savedPrecache === "true";
  }

  precacheToggle.addEventListener("change", async () => {
    localStorage.setItem("precache-toggle", String(precacheToggle.checked));

    if (precacheToggle.checked) {
      precacheToggle.disabled = true;
      precacheProgress.style.display = "block";

      try {
        let completedCount = 0;
        const archiveKeys = await getArchiveKeys();
        for (const key of archiveKeys) {
          precachePercent.textContent = `Downloading ${key}...`;
          precacheCount.textContent = `${completedCount}/${archiveKeys.length}`;

          const url = assetUrl(`${key}.pmtiles`);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed to fetch ${key}`);

          const contentLength = res.headers.get("content-length");
          const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
          let loadedBytes = 0;

          const reader = res.body!.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              loadedBytes += value.length;
              if (totalBytes > 0) {
                const pct = Math.round((loadedBytes / totalBytes) * 100);
                precachePercent.textContent = `Downloading ${key}: ${pct}%`;
              }
            }
          }

          const fullBlob = new Blob(chunks as BlobPart[], { type: "application/octet-stream" });
          await PMTilesDB.set(key, fullBlob);

          if (key === "navmesh_world") {
            registerCachedNavmesh(fullBlob);
          } else if (!key.startsWith("navmesh_")) {
            registerCachedPMTiles(key, fullBlob);
          }

          completedCount++;
          precacheCount.textContent = `${completedCount}/${archiveKeys.length}`;
        }

        precachePercent.textContent = "100% (Done)";
        precacheCount.textContent = `Cached ${archiveKeys.length} archives`;
      } catch (e) {
        precachePercent.textContent = "Error caching";
        precacheCount.textContent = String(e);
        precacheToggle.checked = false;
        localStorage.setItem("precache-toggle", "false");
      } finally {
        precacheToggle.disabled = false;
      }
    } else {
      for (const key of await getArchiveKeys()) {
        await PMTilesDB.delete(key);
      }
      precacheProgress.style.display = "none";
      precachePercent.textContent = "0%";
      precacheCount.textContent = "0/0";
    }
  });
}

initEditor(map);

// Drawing Tools Editor
const editorToggle = document.getElementById("editor-toggle") as HTMLInputElement | null;
const editorToolbar = document.getElementById("editor-toolbar") as HTMLDivElement | null;
const editorStatus = document.getElementById("editor-status") as HTMLDivElement | null;
const editorExportBtn = document.getElementById("editor-export-btn") as HTMLButtonElement | null;
const editorResetBtn = document.getElementById("editor-reset-btn") as HTMLButtonElement | null;
const editorImportBtn = document.getElementById("editor-import-btn") as HTMLButtonElement | null;
const editorFileInput = document.getElementById("editor-file-input") as HTMLInputElement | null;

const editorStatusMessages: Record<string, string> = {
  view: "Extend (default) · S=Move · D=Delete · Esc=idle",
  extend: "Click a source node, then click on the map to extend (50m segments) · Esc to idle",
  delete: "Click a node or edge to delete it · Esc to idle",
  move: "Drag any node to reposition it · Esc to idle",
};

function updateEditorUI() {
  if (!editorToolbar || !editorStatus) return;

  editorToolbar.style.display = editorEnabled ? "block" : "none";

  if (editorEnabled) {
    const mode = getMode();
    editorStatus.textContent = editorStatusMessages[mode] || "";
    document.querySelectorAll(".editor-mode-btn").forEach((btn) => {
      const el = btn as HTMLElement;
      el.classList.toggle("active", el.dataset.mode === mode);
    });
  }
}

const editorSaveBtn = document.getElementById("editor-save-btn") as HTMLButtonElement | null;
const editActionsList = document.getElementById("edit-actions-list") as HTMLDivElement | null;
const historyEmpty = document.getElementById("history-empty") as HTMLDivElement | null;
const checkpointsList = document.getElementById("checkpoints-list") as HTMLDivElement | null;
const checkpointsEmpty = document.getElementById("checkpoints-empty") as HTMLDivElement | null;
const historyToggle = document.getElementById("history-toggle") as HTMLElement | null;

function refreshEditActionsList() {
  if (!editActionsList || !historyEmpty) return;
  const actions = getEditActions();
  editActionsList.innerHTML = "";
  if (actions.length === 0) {
    historyEmpty.style.display = "block";
    return;
  }
  historyEmpty.style.display = "none";
  for (const action of actions) {
    const item = document.createElement("div");
    item.className = "saved-navlink-item";
    item.textContent = `${action.timestamp} - ${action.description}`;

    const revertBtn = document.createElement("span");
    revertBtn.className = "delete-btn";
    revertBtn.textContent = "\u21a9";
    revertBtn.title = "Revert this edit";
    revertBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isDirty && !confirm(`Revert "${action.description}"?`)) return;
      revertEditAction(action.id);
      refreshEditActionsList();
    });
    item.appendChild(revertBtn);

    editActionsList.appendChild(item);
  }
}

async function refreshCheckpointsList() {
  if (!checkpointsList || !checkpointsEmpty) return;
  const entries = await getCheckpoints();
  checkpointsList.innerHTML = "";
  if (entries.length === 0) {
    checkpointsEmpty.style.display = "block";
    return;
  }
  checkpointsEmpty.style.display = "none";
  for (const entry of entries) {
    const label = `${entry.timestamp} - ${entry.walkEdgeCount}+${entry.teleportEdgeCount}/${entry.nodeCount} - ${entry.newWalkCount}/${entry.newTeleportCount}`;
    const item = document.createElement("div");
    item.className = "saved-navlink-item";
    item.textContent = label;

    const delBtn = document.createElement("span");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.title = "Delete this checkpoint";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteCheckpoint(entry.id);
      refreshCheckpointsList();
    });
    item.appendChild(delBtn);

    item.addEventListener("click", async () => {
      if (isDirty && !confirm("Discard current edits and load this checkpoint?")) return;
      try {
        if (editorStatus) editorStatus.textContent = "Loading checkpoint...";
        await loadCheckpoint(entry.id);
        if (editorStatus) editorStatus.textContent = "Checkpoint loaded";
      } catch (e: any) {
        if (editorStatus) editorStatus.textContent = `Error: ${e.message}`;
      }
    });

    checkpointsList.appendChild(item);
  }
}

if (editorToggle && editorToolbar) {
  const savedEditor = localStorage.getItem("editor-toggle");
  if (savedEditor !== null) {
    editorToggle.checked = savedEditor === "true";
  }

  editorToggle.addEventListener("change", () => {
    localStorage.setItem("editor-toggle", String(editorToggle.checked));
    setEditorEnabled(editorToggle.checked);
    updateEditorUI();
    if (editorToggle.checked) {
      refreshEditActionsList();
      refreshCheckpointsList();
    }
  });

  if (editorToggle.checked) {
    setEditorEnabled(true);
    updateEditorUI();
    refreshEditActionsList();
    refreshCheckpointsList();
  }
}

document.querySelectorAll(".editor-mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!editorEnabled) return;
    const mode = (btn as HTMLElement).dataset.mode as string;
    if (mode) {
      setMode(mode as any);
      updateEditorUI();
    }
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "F1") {
    e.preventDefault();
    if (editorToggle) {
      editorToggle.checked = !editorToggle.checked;
      localStorage.setItem("editor-toggle", String(editorToggle.checked));
      setEditorEnabled(editorToggle.checked);
      updateEditorUI();
      if (editorToggle.checked) {
        refreshEditActionsList();
        refreshCheckpointsList();
      }
    }
    return;
  }
  if (!editorEnabled) return;
  if (e.key === "Escape") {
    setMode("view");
    updateEditorUI();
    return;
  }
  const keyMode: Record<string, string> = { e: "extend", s: "move", d: "delete" };
  const mode = keyMode[e.key.toLowerCase()];
  if (mode) {
    setMode(mode as any);
    updateEditorUI();
  }
});

if (editorSaveBtn) {
  editorSaveBtn.addEventListener("click", async () => {
    try {
      if (editorStatus) editorStatus.textContent = "Saving checkpoint...";
      await saveCheckpoint();
      if (editorStatus) editorStatus.textContent = "Checkpoint saved";
      refreshCheckpointsList();
    } catch (e: any) {
      if (editorStatus) editorStatus.textContent = `Error: ${e.message}`;
    }
  });
}

if (editorExportBtn) {
  editorExportBtn.addEventListener("click", () => {
    exportNavlink();
  });
}

if (editorResetBtn) {
  editorResetBtn.addEventListener("click", async () => {
    if (isDirty && !confirm("Reset all edits? This cannot be undone.")) return;
    await resetEdits();
  });
}

if (editorImportBtn && editorFileInput) {
  editorImportBtn.addEventListener("click", () => {
    editorFileInput.click();
  });
  editorFileInput.addEventListener("change", async () => {
    const file = editorFileInput.files?.[0];
    if (!file) return;
    try {
      if (editorStatus) editorStatus.textContent = "Loading file...";
      await loadCustomFile(file);
    } catch (e: any) {
      if (editorStatus) editorStatus.textContent = `Error: ${e.message}`;
    }
    editorFileInput.value = "";
  });
}

// History panel collapse toggle
if (historyToggle) {
  historyToggle.addEventListener("click", () => {
    historyToggle.classList.toggle("collapsed");
  });
}

setOnChange(() => {
  updateEditorUI();
  refreshEditActionsList();
});

// Initialize on page load
refreshEditActionsList();
refreshCheckpointsList();
