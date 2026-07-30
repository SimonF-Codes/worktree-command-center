import { describe, it, expect } from 'vitest';
import { buildZip, crc32, zipEntryName, dosDateTime, ZIP_MAX_ENTRIES } from '../src/terminals/zip-writer';
import { readZip, listZipNames, findEocd } from '../src/terminals/zip-reader';

describe('crc32', () => {
	it('matches the known PKZIP/gzip check values', () => {
		expect(crc32(Buffer.from(''))).toBe(0);
		expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926); // the standard CRC-32 check vector
		expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
	});
});

describe('zipEntryName', () => {
	it('normalizes to posix and strips traversal (zip-slip)', () => {
		expect(zipEntryName('src\\ui\\a.ts')).toBe('src/ui/a.ts');
		expect(zipEntryName('/abs/path.txt')).toBe('abs/path.txt');
		expect(zipEntryName('../../etc/passwd')).toBe('etc/passwd');
		expect(zipEntryName('a/./b//c')).toBe('a/b/c');
		expect(zipEntryName('..')).toBe('');
	});
});

describe('dosDateTime', () => {
	it('packs a date into the DOS fields and floors at the 1980 epoch', () => {
		const { time, date } = dosDateTime(new Date(2026, 6, 30, 1, 15, 42)); // 2026-07-30 01:15:42
		expect((date >> 9) + 1980).toBe(2026);
		expect((date >> 5) & 0x0f).toBe(7);
		expect(date & 0x1f).toBe(30);
		expect(time >> 11).toBe(1);
		expect((time >> 5) & 0x3f).toBe(15);
		expect((time & 0x1f) * 2).toBe(42);
		// 1970 is unrepresentable in DOS — it must clamp, not emit a negative year field.
		expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
	});
});

describe('buildZip / readZip round trip', () => {
	const entries = [
		{ name: 'ARCHIVE.md', data: Buffer.from('# summary\n') },
		{ name: 'worktree/src/a.ts', data: Buffer.from('export const a = 1;\n'.repeat(200)) }, // compressible
		{ name: 'worktree/empty.txt', data: Buffer.from('') },
		{ name: 'conversation/slug/s.jsonl', data: Buffer.from('{"type":"user"}\n') },
	];

	it('produces a well-formed archive whose entries read back byte-identical', () => {
		const zip = buildZip(entries, new Date(2026, 6, 30, 1, 15, 42));
		expect(zip.readUInt32LE(0)).toBe(0x04034b50); // starts with a local file header
		expect(findEocd(zip)).toBeGreaterThan(0);
		const back = readZip(zip);
		expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
		for (const e of entries) {
			const got = back.find((b) => b.name === e.name)!;
			expect(got.data.equals(e.data)).toBe(true);
		}
	});

	it('actually compresses repetitive content', () => {
		const big = Buffer.from('x'.repeat(100_000));
		const zip = buildZip([{ name: 'big.txt', data: big }]);
		expect(zip.length).toBeLessThan(big.length / 10);
		expect(readZip(zip)[0]!.data.equals(big)).toBe(true);
	});

	it('lists names without inflating anything', () => {
		const zip = buildZip(entries);
		expect(listZipNames(zip)).toEqual(entries.map((e) => e.name));
	});

	it('round-trips non-ASCII names via the UTF-8 flag', () => {
		const zip = buildZip([{ name: 'wörk/ünïcode—ok.txt', data: Buffer.from('hi') }]);
		expect(readZip(zip)[0]!.name).toBe('wörk/ünïcode—ok.txt');
	});

	it('drops entries whose name normalizes to nothing', () => {
		const zip = buildZip([{ name: '..', data: Buffer.from('nope') }, { name: 'ok.txt', data: Buffer.from('yes') }]);
		expect(readZip(zip).map((e) => e.name)).toEqual(['ok.txt']);
	});

	it('refuses more entries than a non-ZIP64 archive can index', () => {
		const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') }));
		expect(() => buildZip(many)).toThrow(/too many files/);
	});
});

describe('readZip robustness', () => {
	it('rejects a buffer that is not a zip', () => {
		expect(() => readZip(Buffer.from('definitely not a zip archive'))).toThrow(/not a zip/);
	});

	it('throws rather than silently returning half an archive when the directory is corrupt', () => {
		const zip = buildZip([{ name: 'a.txt', data: Buffer.from('aaaa') }, { name: 'b.txt', data: Buffer.from('bbbb') }]);
		const eocd = findEocd(zip);
		const cdOffset = zip.readUInt32LE(eocd + 16);
		zip.writeUInt32LE(0xdeadbeef, cdOffset); // clobber the first central-directory signature
		expect(() => readZip(zip)).toThrow(/central directory/);
	});

	it('skips an entry whose payload was corrupted rather than failing the whole extraction', () => {
		const zip = buildZip([
			{ name: 'good.txt', data: Buffer.from('good content here') },
			{ name: 'bad.txt', data: Buffer.from('z'.repeat(5000)) },
		]);
		// Flip a byte inside the second entry's stored/deflated payload so its CRC no longer matches.
		const eocd = findEocd(zip);
		const cdOffset = zip.readUInt32LE(eocd + 16);
		zip[cdOffset - 10] = zip[cdOffset - 10]! ^ 0xff;
		const back = readZip(zip);
		expect(back.some((e) => e.name === 'good.txt')).toBe(true);
		expect(back.length).toBeLessThan(2);
	});
});
