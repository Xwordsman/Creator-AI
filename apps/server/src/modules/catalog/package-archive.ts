import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import type { Readable } from 'node:stream';
import type { PackageFile } from '@creator-ai/contracts';
import { ApiError } from '../../common/http';

const MAX_FILES = 128;
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
export function invalidPackage(message: string): never {
  throw new ApiError(400, 'INVALID_PACKAGE', message);
}
export function safePackagePath(path: string): string {
  if (
    !path ||
    path.length > 240 ||
    /[\\:\x00-\x1f]/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))
  )
    invalidPackage('包内路径不安全，不能包含绝对路径、反斜杠或上级目录。');
  return path;
}
export function readArchive(buffer: Buffer): Promise<PackageFile[]> {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 2 * 1024 * 1024)
    invalidPackage('请上传不超过 2 MiB 的 ZIP 包。');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) return reject(new ApiError(400, 'INVALID_PACKAGE', '无法读取 ZIP 包。'));
        const files: PackageFile[] = [];
        const paths = new Set<string>();
        let count = 0;
        let total = 0;
        let failed = false;
        const fail = () => {
          failed = true;
          zip.close();
          reject(
            new ApiError(
              400,
              'INVALID_PACKAGE',
              'ZIP 包包含不安全路径、链接、重复文件，或超过数量/解压大小限制。',
            ),
          );
        };
        zip.on('error', fail);
        zip.on('end', () => {
          if (!failed) resolve(files);
        });
        zip.on('entry', (entry: yauzl.Entry) => {
          if (failed) return;
          try {
            if (++count > MAX_FILES || entry.generalPurposeBitFlag & 1) return fail();
            const directory = entry.fileName.endsWith('/');
            const path = safePackagePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
            const normalized = path.normalize('NFC').toLowerCase();
            const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (paths.has(normalized) || (fileType && fileType !== 0x8000 && fileType !== 0x4000))
              return fail();
            paths.add(normalized);
            if (directory) {
              zip.readEntry();
              return;
            }
            if (entry.uncompressedSize > MAX_FILE || total + entry.uncompressedSize > MAX_TOTAL)
              return fail();
            zip.openReadStream(entry, (streamError, stream) => {
              if (streamError || !stream) return fail();
              let size = 0;
              const chunks: Buffer[] = [];
              stream.on('error', fail);
              stream.on('data', (chunk: Buffer) => {
                size += chunk.length;
                total += chunk.length;
                if (size > MAX_FILE || total > MAX_TOTAL) {
                  stream.destroy();
                  fail();
                  return;
                }
                chunks.push(chunk);
              });
              stream.on('end', () => {
                if (failed) return;
                const data = Buffer.concat(chunks);
                const text = data.toString('utf8');
                const isText = !text.includes('\0') && Buffer.from(text).equals(data);
                files.push({
                  path,
                  content: isText ? text : data.toString('base64'),
                  encoding: isText ? 'utf8' : 'base64',
                });
                zip.readEntry();
              });
            });
          } catch {
            fail();
          }
        });
        zip.readEntry();
      },
    );
  });
}

export async function writeArchive(files: PackageFile[]): Promise<Buffer> {
  const paths = new Set<string>();
  let total = 0;
  if (files.length > MAX_FILES) invalidPackage('导出条目超过 128 个，请拆分能力包。');
  for (const file of files) {
    const path = safePackagePath(file.path).normalize('NFC').toLowerCase();
    const size = Buffer.byteLength(file.content, file.encoding);
    total += size;
    if (paths.has(path) || size > MAX_FILE || total > MAX_TOTAL)
      invalidPackage('导出包含重复路径或超出导入容量，请拆分能力包。');
    paths.add(path);
  }
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    let compressed = 0;
    zip.on('error', reject);
    zip.outputStream.on('data', (chunk: Buffer) => {
      compressed += chunk.length;
      if (compressed > 2 * 1024 * 1024) {
        (zip.outputStream as Readable).destroy();
        reject(new ApiError(400, 'INVALID_PACKAGE', '导出 ZIP 超过 2 MiB，请拆分能力包。'));
        return;
      }
      chunks.push(chunk);
    });
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const file of files)
      zip.addBuffer(Buffer.from(file.content, file.encoding), safePackagePath(file.path));
    zip.end();
  });
}
