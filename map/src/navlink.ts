export let navlinkData: any = null;

export function setNavlinkData(data: any | null): void {
  navlinkData = data;
}

export async function decompressGzipBufferToText(buffer: ArrayBuffer): Promise<string> {
  const cs = new DecompressionStream("gzip");
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
