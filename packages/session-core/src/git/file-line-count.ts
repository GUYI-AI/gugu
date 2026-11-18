import fs from 'node:fs/promises';

export type FileLineCountResult = {
  lines: number;
  truncated: boolean;
  totalSize: number;
};

export async function countFileLines(
  filePath: string,
  options: { maxBytes: number }
): Promise<FileLineCountResult> {
  const stat = await fs.stat(filePath);
  const handle = await fs.open(filePath, 'r');
  try {
    const limit = options.maxBytes + 1;
    // 大多数未跟踪文件只有几行。按文件大小取 buffer,不能为每个小文件都分配并清零 512KiB。
    // 多留一字节用于发现 stat 与 read 之间的增长;读满时再读到原来的截断边界,不能漏行或误报未截断。
    let buffer = Buffer.allocUnsafe(Math.min(stat.size + 1, limit));
    let { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length && buffer.length < limit) {
      const grown = Buffer.allocUnsafe(limit);
      buffer.copy(grown, 0, 0, bytesRead);
      const rest = await handle.read(grown, bytesRead, limit - bytesRead, bytesRead);
      bytesRead += rest.bytesRead;
      buffer = grown;
    }
    const truncated = bytesRead > options.maxBytes;
    const content = buffer.subarray(0, truncated ? options.maxBytes : bytesRead);
    return {
      lines: countLines(content),
      truncated,
      totalSize: stat.size,
    };
  } finally {
    await handle.close();
  }
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;

  let lines = 0;
  for (const byte of content) {
    if (byte === 0x0a) lines++;
  }

  if (content[content.length - 1] !== 0x0a) lines++;
  return lines;
}
