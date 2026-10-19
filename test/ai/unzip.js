// Reads a ZIP file (stored or deflated entries) into { name: Buffer }, checking sizes and CRCs.
const zlib = require("zlib");

exports.unzip = function unzip(buf) {
	let eocd = -1;
	for (let i = buf.length - 22; i >= 0; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("No end of central directory");
	const count = buf.readUInt16LE(eocd + 10);
	let at = buf.readUInt32LE(eocd + 16);
	const out = {};
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("Bad central directory header");
		const method = buf.readUInt16LE(at + 10);
		const crc = buf.readUInt32LE(at + 16);
		const compressed = buf.readUInt32LE(at + 20);
		const size = buf.readUInt32LE(at + 24);
		const nameLen = buf.readUInt16LE(at + 28);
		const extraLen = buf.readUInt16LE(at + 30);
		const commentLen = buf.readUInt16LE(at + 32);
		const offset = buf.readUInt32LE(at + 42);
		const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
		if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Bad local header for ${name}`);
		const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
		const raw = buf.subarray(start, start + compressed);
		const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
		if (data.length !== size) throw new Error(`Size mismatch in ${name}`);
		if (zlib.crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
		out[name] = { data, method };
		at += 46 + nameLen + extraLen + commentLen;
	}
	return out;
};
