import { PMTilesDB } from "./pmtiles_db";

export let navlinkData: any = null;

const NAVLINK_KEY = "navigation_linkage";
const GITHUB_RELEASE_API =
  "https://api.github.com/repos/Silkroad-Developer-Community/Silkroad-NavLink/releases/latest";

async function fetchFromGitHub(): Promise<Response> {
  const releaseRes = await fetch(GITHUB_RELEASE_API);
  if (!releaseRes.ok) throw new Error(`GitHub API error: ${releaseRes.statusText}`);
  const release = await releaseRes.json();
  const asset = release.assets?.find((a: any) => a.name === "navigation_linkage.json.gz");
  if (!asset?.url) throw new Error("navigation_linkage.json.gz asset not found in latest release");

  const assetRes = await fetch(asset.url, {
    headers: { Accept: "application/octet-stream" },
  });
  if (!assetRes.ok) throw new Error(`Failed to download asset: ${assetRes.statusText}`);
  return assetRes;
}

export async function getNavlinkData(): Promise<any | null> {
  if (navlinkData) return navlinkData;

  const cachedBlob = await PMTilesDB.get(NAVLINK_KEY);
  if (cachedBlob) {
    const text = await cachedBlob.text();
    navlinkData = JSON.parse(text);
    return navlinkData;
  }
  return null;
}

async function responseToText(response: Response): Promise<string> {
  const contentEncoding = response.headers.get("content-encoding");
  const contentType = response.headers.get("content-type") || "";

  if (contentEncoding?.includes("gzip")) {
    return await response.text();
  }

  if (contentType.includes("gzip")) {
    const buffer = await response.arrayBuffer();
    return decompressGzipBufferToText(buffer);
  }

  const text = await response.text();
  try {
    JSON.parse(text);
    return text;
  } catch {
    const buffer = await response.arrayBuffer();
    return decompressGzipBufferToText(buffer);
  }
}

export async function downloadAndCacheNavlink(
  onProgress: (percent: number, message: string) => void
): Promise<any | null> {
  onProgress(0, "Fetching release info from GitHub...");

  try {
    const response = await fetchFromGitHub();

    onProgress(50, "Processing...");
    const text = await responseToText(response);
    navlinkData = JSON.parse(text);

    await PMTilesDB.set(NAVLINK_KEY, new Blob([text], { type: "application/json" }));

    onProgress(100, "Done");
    return navlinkData;
  } catch (e) {
    onProgress(-1, `Error: ${e}`);
    return null;
  }
}

export async function decompressGzipBufferToText(buffer: ArrayBuffer): Promise<string> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(new Uint8Array(buffer));
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(result);
}

export function clearNavlinkCache(): void {
  navlinkData = null;
}
