const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const WIDTH = 480;
const HEIGHT = 800;
const ATC_MAGIC = 0xccc40002;
const ATC_RGB_FLAG = 1;
const LZ_VERSION = 4;
const CHUNK_BYTES = 0x10000;

function usage() {
  return `
Vega X U+ boot animation converter

Usage:
  node scripts/convert_bootanim_lz.js --input BootAnim --output bootanimation.zip

Options:
  --input <dir>     Source boot animation folder. Must contain desc.txt, part0, part1.
  --workdir <dir>   Folder for generated .lz frames. Default: <input>_lz
  --output <zip>    Output bootanimation.zip path. Default: bootanimation.zip
  --copy-to <zip>   Also copy the output zip to another path.
  --help            Show this help.

Legacy positional form still works:
  node scripts/convert_bootanim_lz.js <input> <workdir> <output>
`.trim();
}

function parseArgs(argv) {
  const args = {
    input: null,
    workdir: null,
    output: null,
    copyTo: null,
    help: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--input" || arg === "-i") {
      args.input = argv[++i];
    } else if (arg === "--workdir" || arg === "-w") {
      args.workdir = argv[++i];
    } else if (arg === "--output" || arg === "-o") {
      args.output = argv[++i];
    } else if (arg === "--copy-to") {
      args.copyTo = argv[++i];
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!args.input && positional[0]) args.input = positional[0];
  if (!args.workdir && positional[1]) args.workdir = positional[1];
  if (!args.output && positional[2]) args.output = positional[2];
  if (!args.input) args.input = "BootAnim";
  if (!args.workdir) args.workdir = `${args.input.replace(/[\\/]$/, "")}_lz`;
  if (!args.output) args.output = "bootanimation.zip";
  return args;
}

function requirePath(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
}

function parseDesc(descPath) {
  const raw = fs.readFileSync(descPath, "utf8").replace(/\r\n/g, "\n").trimEnd();
  const lines = raw.split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  if (lines.length < 3) throw new Error(`${descPath}: expected at least 3 non-empty lines`);
  const header = lines[0].trim().split(/\s+/).map(Number);
  if (header.length !== 3 || header.some((n) => !Number.isFinite(n))) {
    throw new Error(`${descPath}: first line must be "480 800 <fps>"`);
  }
  if (header[0] !== WIDTH || header[1] !== HEIGHT) {
    throw new Error(`${descPath}: Vega X U+ requires ${WIDTH}x${HEIGHT}, got ${header[0]}x${header[1]}`);
  }
  for (const part of ["part0", "part1"]) {
    if (!lines.some((line) => line.trim().split(/\s+/)[3] === part)) {
      throw new Error(`${descPath}: missing animation line for ${part}`);
    }
  }
}

function getPngFiles(dir) {
  requirePath(dir, "Part folder");
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")).sort((a, b) => a.localeCompare(b));
  if (!files.length) throw new Error(`No PNG frames found in ${dir}`);
  return files;
}

function validateSource(root) {
  requirePath(root, "Input folder");
  const desc = path.join(root, "desc.txt");
  requirePath(desc, "desc.txt");
  parseDesc(desc);
  return {
    part0: getPngFiles(path.join(root, "part0")),
    part1: getPngFiles(path.join(root, "part1")),
  };
}

function readPng(file) {
  const data = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!data.subarray(0, 8).equals(sig)) throw new Error(`${file}: not a PNG`);

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  const idat = [];

  while (off < data.length) {
    const len = data.readUInt32BE(off);
    const type = data.toString("ascii", off + 4, off + 8);
    const body = data.subarray(off + 8, off + 8 + len);
    off += 12 + len;

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error(`${file}: interlaced PNG is not supported`);
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`${file}: only 8-bit PNG is supported`);
  if (![2, 3, 6].includes(colorType)) throw new Error(`${file}: unsupported PNG color type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error(`${file}: indexed PNG has no PLTE`);

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 3);
  let src = 0;
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }

  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let x = 0; x < stride; x++) {
      const val = raw[src++];
      const left = x >= channels ? cur[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      if (filter === 0) cur[x] = val;
      else if (filter === 1) cur[x] = (val + left) & 0xff;
      else if (filter === 2) cur[x] = (val + up) & 0xff;
      else if (filter === 3) cur[x] = (val + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) cur[x] = (val + paeth(left, up, upLeft)) & 0xff;
      else throw new Error(`${file}: invalid PNG filter ${filter}`);
    }

    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 3;
      if (colorType === 3) {
        const idx = cur[x] * 3;
        pixels[dst] = palette[idx] || 0;
        pixels[dst + 1] = palette[idx + 1] || 0;
        pixels[dst + 2] = palette[idx + 2] || 0;
      } else {
        const s = x * channels;
        pixels[dst] = cur[s];
        pixels[dst + 1] = cur[s + 1];
        pixels[dst + 2] = cur[s + 2];
      }
    }

    const tmp = prev;
    prev = cur;
    cur = tmp;
  }

  return { width, height, pixels };
}

function expandQuantized(v, bits) {
  v <<= 8 - bits;
  return v | (v >> bits);
}

function packAtcC0(r, g, b) {
  return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
}

function packAtcC1(r, g, b) {
  return (r >> 3) | ((g >> 2) << 5) | ((b >> 3) << 11);
}

function unpackAtcC0(c) {
  return [
    expandQuantized(c & 0x1f, 5),
    expandQuantized((c >> 5) & 0x1f, 5),
    expandQuantized((c >> 10) & 0x1f, 5),
  ];
}

function unpackAtcC1(c) {
  return [
    expandQuantized(c & 0x1f, 5),
    expandQuantized((c >> 5) & 0x3f, 6),
    expandQuantized((c >> 11) & 0x1f, 5),
  ];
}

function atcMode0Palette(c0, c1) {
  const a = unpackAtcC0(c0);
  const d = unpackAtcC1(c1);
  return [
    a,
    [
      Math.floor((5 * a[0] + 3 * d[0]) / 8),
      Math.floor((5 * a[1] + 3 * d[1]) / 8),
      Math.floor((5 * a[2] + 3 * d[2]) / 8),
    ],
    [
      Math.floor((3 * a[0] + 5 * d[0]) / 8),
      Math.floor((3 * a[1] + 5 * d[1]) / 8),
      Math.floor((3 * a[2] + 5 * d[2]) / 8),
    ],
    d,
  ];
}

function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr * 3 + dg * dg * 4 + db * db * 2;
}

function bestPrincipalAxis(colors) {
  const mean = [0, 0, 0];
  for (const c of colors) {
    mean[0] += c[0];
    mean[1] += c[1];
    mean[2] += c[2];
  }
  mean[0] /= colors.length;
  mean[1] /= colors.length;
  mean[2] /= colors.length;

  let axis = [1, 1, 1];
  for (let iter = 0; iter < 6; iter++) {
    const next = [0, 0, 0];
    for (const c of colors) {
      const v = [c[0] - mean[0], c[1] - mean[1], c[2] - mean[2]];
      const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
      next[0] += v[0] * dot;
      next[1] += v[1] * dot;
      next[2] += v[2] * dot;
    }
    const len = Math.hypot(next[0], next[1], next[2]) || 1;
    axis = [next[0] / len, next[1] / len, next[2] / len];
  }
  return { mean, axis };
}

function addCandidate(set, color) {
  set.add(`${Math.max(0, Math.min(255, Math.round(color[0])))},${Math.max(0, Math.min(255, Math.round(color[1])))},${Math.max(0, Math.min(255, Math.round(color[2])))}`);
}

function parseCandidate(s) {
  return s.split(",").map(Number);
}

function buildEndpointCandidates(colors) {
  const set = new Set();
  let minR = 255, minG = 255, minB = 255;
  let maxR = 0, maxG = 0, maxB = 0;
  for (const c of colors) {
    addCandidate(set, c);
    minR = Math.min(minR, c[0]); minG = Math.min(minG, c[1]); minB = Math.min(minB, c[2]);
    maxR = Math.max(maxR, c[0]); maxG = Math.max(maxG, c[1]); maxB = Math.max(maxB, c[2]);
  }
  addCandidate(set, [minR, minG, minB]);
  addCandidate(set, [maxR, maxG, maxB]);

  const { mean, axis } = bestPrincipalAxis(colors);
  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of colors) {
    const p = (c[0] - mean[0]) * axis[0] + (c[1] - mean[1]) * axis[1] + (c[2] - mean[2]) * axis[2];
    minP = Math.min(minP, p);
    maxP = Math.max(maxP, p);
  }
  for (const scale of [0.75, 1.0, 1.25]) {
    addCandidate(set, [mean[0] + axis[0] * minP * scale, mean[1] + axis[1] * minP * scale, mean[2] + axis[2] * minP * scale]);
    addCandidate(set, [mean[0] + axis[0] * maxP * scale, mean[1] + axis[1] * maxP * scale, mean[2] + axis[2] * maxP * scale]);
  }

  return [...set].map(parseCandidate);
}

function scoreAtcPair(colors, c0, c1) {
  const palette = atcMode0Palette(c0, c1);
  let error = 0;
  let indices = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0;
    let bestErr = Infinity;
    for (let p = 0; p < 4; p++) {
      const err = colorDistance(colors[i], palette[p]);
      if (err < bestErr) {
        bestErr = err;
        best = p;
      }
    }
    error += bestErr;
    indices |= best << (i * 2);
  }
  return { error, indices };
}

function encodeAtcRgbBlock(colors) {
  const candidates = buildEndpointCandidates(colors);
  let best = { error: Infinity, c0: 0, c1: 0, indices: 0 };

  for (const a of candidates) {
    const c0 = packAtcC0(a[0], a[1], a[2]);
    for (const b of candidates) {
      const c1 = packAtcC1(b[0], b[1], b[2]);
      const scored = scoreAtcPair(colors, c0, c1);
      if (scored.error < best.error) {
        best = { error: scored.error, c0, c1, indices: scored.indices };
      }
    }
  }

  return best;
}

function encodeAtcRgbBlocks(image) {
  const blocksX = Math.ceil(image.width / 4);
  const blocksY = Math.ceil(image.height / 4);
  const out = Buffer.alloc(blocksX * blocksY * 8);
  let dst = 0;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const colors = [];
      for (let yy = 0; yy < 4; yy++) {
        for (let xx = 0; xx < 4; xx++) {
          const x = Math.min(image.width - 1, bx * 4 + xx);
          const y = Math.min(image.height - 1, by * 4 + yy);
          const p = (y * image.width + x) * 3;
          colors.push([image.pixels[p], image.pixels[p + 1], image.pixels[p + 2]]);
        }
      }
      const block = encodeAtcRgbBlock(colors);
      out.writeUInt16LE(block.c0, dst);
      out.writeUInt16LE(block.c1, dst + 2);
      out.writeUInt32LE(block.indices >>> 0, dst + 4);
      dst += 8;
    }
  }

  return out;
}

class BitWriter {
  constructor() {
    this.bits = [];
  }

  bit(v) {
    this.bits.push(v ? 1 : 0);
  }

  u16(v) {
    for (let i = 15; i >= 0; i--) this.bit((v >> i) & 1);
  }

  toBuffer() {
    const words = Math.ceil(this.bits.length / 16);
    const out = Buffer.alloc(words * 2);
    for (let w = 0; w < words; w++) {
      let v = 0;
      for (let i = 0; i < 16; i++) {
        v = (v << 1) | (this.bits[w * 16 + i] || 0);
      }
      out.writeUInt16LE(v, w * 2);
    }
    return out;
  }
}

function encodeLiteralChunk(chunk) {
  if (chunk.length > CHUNK_BYTES) throw new Error("chunk too large");
  if (chunk.length & 1) throw new Error("chunk length must be even");
  const writer = new BitWriter();
  for (let i = 0; i < chunk.length; i += 2) {
    writer.bit(1);
    writer.u16(chunk.readUInt16LE(i));
  }
  const header = Buffer.alloc(4);
  header.writeUInt16LE(chunk.length / 2, 0);
  header.writeUInt16LE(0x0808, 2);
  return Buffer.concat([header, writer.toBuffer()]);
}

function makeLzPayload(atcData) {
  const chunks = [];
  for (let off = 0; off < atcData.length; off += CHUNK_BYTES) {
    chunks.push(encodeLiteralChunk(atcData.subarray(off, Math.min(atcData.length, off + CHUNK_BYTES))));
  }

  const tableBytes = 8 + chunks.length * 4;
  let cursor = tableBytes;
  const payloadHeader = Buffer.alloc(tableBytes);
  payloadHeader.writeUInt16LE(LZ_VERSION, 0);
  payloadHeader.writeUInt16LE(chunks.length, 2);
  payloadHeader.writeUInt32LE(atcData.length, 4);
  for (let i = 0; i < chunks.length; i++) {
    payloadHeader.writeUInt32LE(cursor / 2, 8 + i * 4);
    cursor += chunks[i].length;
  }
  return Buffer.concat([payloadHeader, ...chunks]);
}

function makeLzFrame(pngFile, outFile) {
  const image = readPng(pngFile);
  if (image.width !== WIDTH || image.height !== HEIGHT) {
    throw new Error(`${pngFile}: expected ${WIDTH}x${HEIGHT}, got ${image.width}x${image.height}`);
  }
  const atc = encodeAtcRgbBlocks(image);
  const payload = makeLzPayload(atc);
  const header = Buffer.alloc(28);
  header.writeUInt32LE(ATC_MAGIC, 0);
  header.writeUInt32LE(image.width, 4);
  header.writeUInt32LE(image.height, 8);
  header.writeUInt32LE(ATC_RGB_FLAG, 12);
  header.writeUInt32LE(28, 16);
  header.writeUInt32LE(atc.length, 20);
  header.writeUInt32LE(payload.length, 24);
  fs.writeFileSync(outFile, Buffer.concat([header, payload]));
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function listFiles(dir) {
  return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b)).flatMap((name) => {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    return stat.isDirectory() ? listFiles(full) : stat.isFile() ? [full] : [];
  });
}

function makeStoreZip(root, outZip) {
  const ordered = [path.join(root, "desc.txt"), ...listFiles(path.join(root, "part0")), ...listFiles(path.join(root, "part1"))];
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const full of ordered) {
    const data = fs.readFileSync(full);
    const name = Buffer.from(path.relative(root, full).split(path.sep).join("/"), "utf8");
    const dt = dosDateTime(fs.statSync(full).mtime);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    let p = 0;
    local.writeUInt32LE(0x04034b50, p); p += 4;
    local.writeUInt16LE(20, p); p += 2;
    local.writeUInt16LE(0, p); p += 2;
    local.writeUInt16LE(0, p); p += 2;
    local.writeUInt16LE(dt.time, p); p += 2;
    local.writeUInt16LE(dt.date, p); p += 2;
    local.writeUInt32LE(crc, p); p += 4;
    local.writeUInt32LE(data.length, p); p += 4;
    local.writeUInt32LE(data.length, p); p += 4;
    local.writeUInt16LE(name.length, p); p += 2;
    local.writeUInt16LE(0, p); p += 2;
    name.copy(local, p);
    chunks.push(local, data);

    const cdir = Buffer.alloc(46 + name.length);
    p = 0;
    cdir.writeUInt32LE(0x02014b50, p); p += 4;
    cdir.writeUInt16LE(20, p); p += 2;
    cdir.writeUInt16LE(20, p); p += 2;
    cdir.writeUInt16LE(0, p); p += 2;
    cdir.writeUInt16LE(0, p); p += 2;
    cdir.writeUInt16LE(dt.time, p); p += 2;
    cdir.writeUInt16LE(dt.date, p); p += 2;
    cdir.writeUInt32LE(crc, p); p += 4;
    cdir.writeUInt32LE(data.length, p); p += 4;
    cdir.writeUInt32LE(data.length, p); p += 4;
    cdir.writeUInt16LE(name.length, p); p += 2;
    cdir.writeUInt16LE(0, p); p += 2;
    cdir.writeUInt16LE(0, p); p += 2;
    cdir.writeUInt16LE(0, p); p += 2;
    cdir.writeUInt16LE(0, p); p += 2;
    cdir.writeUInt32LE(0, p); p += 4;
    cdir.writeUInt32LE(offset, p); p += 4;
    name.copy(cdir, p);
    central.push(cdir);
    offset += local.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  let p = 0;
  end.writeUInt32LE(0x06054b50, p); p += 4;
  end.writeUInt16LE(0, p); p += 2;
  end.writeUInt16LE(0, p); p += 2;
  end.writeUInt16LE(ordered.length, p); p += 2;
  end.writeUInt16LE(ordered.length, p); p += 2;
  end.writeUInt32LE(centralSize, p); p += 4;
  end.writeUInt32LE(centralOffset, p); p += 4;
  end.writeUInt16LE(0, p);
  fs.writeFileSync(outZip, Buffer.concat([...chunks, ...central, end]));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(args.input);
  const outRoot = path.resolve(args.workdir);
  const outZip = path.resolve(args.output);
  const frames = validateSource(root);

  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(outRoot, "part0"), { recursive: true });
  fs.mkdirSync(path.join(outRoot, "part1"), { recursive: true });
  fs.copyFileSync(path.join(root, "desc.txt"), path.join(outRoot, "desc.txt"));

  for (const part of ["part0", "part1"]) {
    const srcDir = path.join(root, part);
    const dstDir = path.join(outRoot, part);
    for (const file of frames[part]) {
      const base = path.basename(file, path.extname(file));
      makeLzFrame(path.join(srcDir, file), path.join(dstDir, `${base}.lz`));
    }
  }

  makeStoreZip(outRoot, outZip);
  if (args.copyTo) fs.copyFileSync(outZip, path.resolve(args.copyTo));
  console.log(`Wrote ${outRoot}`);
  console.log(`Wrote ${outZip}`);
  console.log(`Frames: part0=${frames.part0.length}, part1=${frames.part1.length}`);
  if (args.copyTo) console.log(`Copied output to ${path.resolve(args.copyTo)}`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
}
