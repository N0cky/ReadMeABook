/**
 * Component: Request File Download Route Tests (multi-file zip)
 * Documentation: documentation/README.md
 *
 * Streams a real zip (archiver ZipArchive) from two files on disk and checks
 * that it unzips to the same names and bytes.
 */

import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findFirstMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ prisma: { request: { findFirst: findFirstMock } } }));
vi.mock('@/lib/utils/jwt', () => ({ verifyDownloadToken: (token: string) => (token === 'good' ? { requestId: 'req-1' } : null) }));
vi.mock('@/lib/utils/logger', () => ({
  RMABLogger: { create: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const request = (token: string) => ({ nextUrl: new URL(`http://localhost/api/requests/req-1/download?token=${token}`) }) as any;
const params = { params: Promise.resolve({ id: 'req-1' }) };

describe('GET /api/requests/[id]/download', () => {
  let dir: string;
  const partOne = Buffer.from('ID3 part one audio bytes');
  const partTwo = Buffer.alloc(64 * 1024, 7); // compressible, larger than one chunk

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-download-'));
    await fs.writeFile(path.join(dir, 'Part 1.mp3'), partOne);
    await fs.writeFile(path.join(dir, 'Part 2.mp3'), partTwo);
    await fs.writeFile(path.join(dir, 'cover.jpg'), Buffer.from('not audio'));
    findFirstMock.mockResolvedValue({
      id: 'req-1', status: 'downloaded', type: 'audiobook',
      audiobook: { title: 'My Book', filePath: dir },
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('streams a zip of the audio files that unzips to the same names and bytes', async () => {
    const { GET } = await import('@/app/api/requests/[id]/download/route');
    const response = await GET(request('good'), params);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="My Book.zip"');

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(['Part 1.mp3', 'Part 2.mp3']);
    expect(zip.getEntry('Part 1.mp3')!.getData().equals(partOne)).toBe(true);
    expect(zip.getEntry('Part 2.mp3')!.getData().equals(partTwo)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('flattens a backslash in a file name so the entry cannot become a folder path', async () => {
    // Only possible on POSIX file systems, where a backslash is an ordinary filename character
    const tricky = Buffer.from('ID3 tricky');
    await fs.writeFile(path.join(dir, '..\\..\\evil.mp3'), tricky);
    const { GET } = await import('@/app/api/requests/[id]/download/route');
    const response = await GET(request('good'), params);

    const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(['.._.._evil.mp3', 'Part 1.mp3', 'Part 2.mp3']);
    expect(names.some((n) => n.includes('\\') || n.includes('/'))).toBe(false);
    expect(zip.getEntry('.._.._evil.mp3')!.getData().equals(tricky)).toBe(true);
  });

  it('rejects a bad token', async () => {
    const { GET } = await import('@/app/api/requests/[id]/download/route');
    const response = await GET(request('bad'), params);
    expect(response.status).toBe(401);
  });
});
