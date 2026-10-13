export function assetUrl(path: string): string {
  return `${new URL(".", document.baseURI).href}assets/${path}`;
}
