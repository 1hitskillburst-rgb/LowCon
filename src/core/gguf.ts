import type { ChatTemplateType } from './types';

export interface ParsedGgufMetadata {
  name: string;
  architecture: string;
  quantization: string;
  contextLength: number;
  fileSizeBytes: number;
  tensorCount: number;
  chatTemplate?: string;
  inferredTemplateType: ChatTemplateType;
  version: number;
}

const GGUF_MAGIC = [0x47, 0x47, 0x55, 0x46]; // "GGUF"
const textDecoder = new TextDecoder('utf-8', { fatal: false });
const textEncoder = new TextEncoder();

class BinaryCursor {
  private view: DataView;
  private bytes: Uint8Array;
  public offset = 0;

  constructor(buffer: ArrayBuffer | Uint8Array) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  private ensure(n: number): void {
    if (this.offset + n > this.bytes.byteLength) {
      throw new Error(`Unexpected EOF while reading GGUF header (needed ${n} bytes at offset ${this.offset}).`);
    }
  }

  readBytes(n: number): Uint8Array {
    this.ensure(n);
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  readU8(): number {
    this.ensure(1);
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readI8(): number {
    this.ensure(1);
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readU16(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readI16(): number {
    this.ensure(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readU32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readI32(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readF32(): number {
    this.ensure(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readU64Number(): number {
    this.ensure(8);
    const big = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return Number(big);
  }

  readI64Number(): number {
    this.ensure(8);
    const big = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return Number(big);
  }

  readF64(): number {
    this.ensure(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  skip(n: number): void {
    this.ensure(n);
    this.offset += n;
  }

  readU64OrU32(version: number): number {
    return version === 1 ? this.readU32() : this.readU64Number();
  }

  readString(version: number): string {
    const len = this.readU64OrU32(version);
    if (len > 10 * 1024 * 1024) {
      throw new Error(`Corrupt GGUF header: string length ${len} exceeds 10MB safety bound.`);
    }
    const raw = this.readBytes(len);
    return textDecoder.decode(raw);
  }
}

function readGgufValue(cursor: BinaryCursor, valType: number, key: string, version: number): unknown {
  switch (valType) {
    case 0:
      return cursor.readU8();
    case 1:
      return cursor.readI8();
    case 2:
      return cursor.readU16();
    case 3:
      return cursor.readI16();
    case 4:
      return cursor.readU32();
    case 5:
      return cursor.readI32();
    case 6:
      return cursor.readF32();
    case 7:
      return cursor.readU8() !== 0;
    case 8:
      return cursor.readString(version);
    case 9: {
      const elemType = cursor.readU32();
      const arrayLen = cursor.readU64OrU32(version);
      if ((key.endsWith('.tokens') || arrayLen > 2000) && elemType === 8) {
        for (let i = 0; i < arrayLen; i++) {
          const strLen = cursor.readU64OrU32(version);
          cursor.skip(strLen);
        }
        return `[${arrayLen} strings skipped]`;
      }
      if (arrayLen > 5000) {
        const elemSize =
          elemType === 0 || elemType === 1 || elemType === 7
            ? 1
            : elemType === 2 || elemType === 3
              ? 2
              : elemType === 10 || elemType === 11 || elemType === 12
                ? 8
                : 4;
        cursor.skip(arrayLen * elemSize);
        return `[${arrayLen} items skipped]`;
      }
      const arr: unknown[] = [];
      for (let i = 0; i < arrayLen; i++) {
        arr.push(readGgufValue(cursor, elemType, key, version));
      }
      return arr;
    }
    case 10:
      return cursor.readU64Number();
    case 11:
      return cursor.readI64Number();
    case 12:
      return cursor.readF64();
    default:
      throw new Error(`Unknown GGUF metadata value type: ${valType}`);
  }
}

export function fileTypeToQuantization(fileType: number): string {
  const table: Record<number, string> = {
    0: 'F32',
    1: 'F16',
    2: 'Q4_0',
    3: 'Q4_1',
    7: 'Q8_0',
    8: 'Q5_0',
    9: 'Q5_1',
    10: 'Q2_K',
    11: 'Q3_K_S',
    12: 'Q3_K_M',
    13: 'Q3_K_L',
    14: 'Q4_K_S',
    15: 'Q4_K_M',
    16: 'Q5_K_S',
    17: 'Q5_K_M',
    18: 'Q6_K',
    32: 'BF16',
  };
  return table[fileType] ?? 'Unknown';
}

export function detectQuantizationFromFilename(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  const candidates: Array<[string, string]> = [
    ['q4_k_m', 'Q4_K_M'],
    ['q4_k_s', 'Q4_K_S'],
    ['q5_k_m', 'Q5_K_M'],
    ['q5_k_s', 'Q5_K_S'],
    ['q6_k', 'Q6_K'],
    ['q8_0', 'Q8_0'],
    ['q4_0', 'Q4_0'],
    ['q5_0', 'Q5_0'],
    ['q2_k', 'Q2_K'],
    ['q3_k_m', 'Q3_K_M'],
    ['bf16', 'BF16'],
    ['f16', 'F16'],
    ['f32', 'F32'],
  ];
  for (const [needle, label] of candidates) {
    if (lower.includes(needle)) return label;
  }
  return undefined;
}

export function inferChatTemplateFromArchitecture(
  architecture: string,
  rawTemplate?: string,
): ChatTemplateType {
  if (rawTemplate) {
    if (rawTemplate.includes('<|start_header_id|>')) return 'Llama3';
    if (rawTemplate.includes('<|im_start|>')) return 'ChatML';
    if (rawTemplate.includes('<start_of_turn>')) return 'Gemma';
    if (rawTemplate.includes('[INST]')) return 'Mistral';
  }
  const arch = architecture.toLowerCase();
  if (arch.includes('qwen') || arch.includes('phi')) return 'ChatML';
  if (arch.includes('llama')) return 'Llama3';
  if (arch.includes('mistral')) return 'Mistral';
  if (arch.includes('gemma')) return 'Gemma';
  return 'ChatML';
}

/**
 * Pure-TypeScript GGUF v1/v2/v3 header parser ported from `src/inference/gguf.rs`.
 */
export function parseGgufHeader(
  buffer: ArrayBuffer | Uint8Array,
  totalFileSize: number,
  defaultName: string,
): ParsedGgufMetadata {
  const cursor = new BinaryCursor(buffer);
  const magic = cursor.readBytes(4);
  if (
    magic[0] !== GGUF_MAGIC[0] ||
    magic[1] !== GGUF_MAGIC[1] ||
    magic[2] !== GGUF_MAGIC[2] ||
    magic[3] !== GGUF_MAGIC[3]
  ) {
    throw new Error('Invalid GGUF format: expected magic header "GGUF".');
  }

  const version = cursor.readU32();
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new Error(`Unsupported GGUF version: ${version}. Supported versions are 1, 2, and 3.`);
  }

  const tensorCount = cursor.readU64OrU32(version);
  const kvCount = cursor.readU64OrU32(version);
  if (kvCount > 100_000) {
    throw new Error(`Corrupt GGUF header: metadata KV count (${kvCount}) exceeds safety bound.`);
  }

  const kvMap = new Map<string, unknown>();
  for (let i = 0; i < kvCount; i++) {
    const key = cursor.readString(version);
    const valType = cursor.readU32();
    const val = readGgufValue(cursor, valType, key, version);
    kvMap.set(key, val);
  }

  let architecture = typeof kvMap.get('general.architecture') === 'string'
    ? (kvMap.get('general.architecture') as string)
    : '';
  if (!architecture) {
    for (const key of kvMap.keys()) {
      if (key.endsWith('.context_length')) {
        architecture = key.slice(0, -'.context_length'.length);
        break;
      }
    }
  }
  if (!architecture) architecture = 'unknown';

  const name =
    typeof kvMap.get('general.name') === 'string'
      ? (kvMap.get('general.name') as string)
      : defaultName.replace(/\.gguf$/i, '');

  const rawCtx =
    kvMap.get(`${architecture}.context_length`) ??
    Array.from(kvMap.entries()).find(([k]) => k.endsWith('.context_length'))?.[1] ??
    kvMap.get('general.context_length');
  const contextLength = typeof rawCtx === 'number' && rawCtx >= 256 ? Math.floor(rawCtx) : 4096;

  const rawFileType = kvMap.get('general.file_type');
  let quantization =
    typeof rawFileType === 'number' ? fileTypeToQuantization(rawFileType) : 'Unknown';
  if (quantization === 'Unknown') {
    quantization = detectQuantizationFromFilename(defaultName) ?? 'Unknown';
  }

  const chatTemplate =
    typeof kvMap.get('tokenizer.chat_template') === 'string'
      ? (kvMap.get('tokenizer.chat_template') as string)
      : undefined;

  return {
    name,
    architecture,
    quantization,
    contextLength,
    fileSizeBytes: totalFileSize,
    tensorCount,
    chatTemplate,
    inferredTemplateType: inferChatTemplateFromArchitecture(architecture, chatTemplate),
    version,
  };
}

/**
 * Generates a valid GGUF v3 binary header in memory (for tests and local validation).
 */
export function createMockGgufBytes(
  architecture: string,
  name: string,
  contextLength: number,
  fileType: number,
  chatTemplate?: string,
): Uint8Array {
  const parts: Uint8Array[] = [];

  const pushU32 = (v: number) => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, v, true);
    parts.push(new Uint8Array(buf));
  };
  const pushU64 = (v: number) => {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, BigInt(v), true);
    parts.push(new Uint8Array(buf));
  };
  const pushStr = (s: string) => {
    const bytes = textEncoder.encode(s);
    pushU64(bytes.length);
    parts.push(bytes);
  };
  const pushKvStr = (key: string, val: string) => {
    pushStr(key);
    pushU32(8);
    pushStr(val);
  };
  const pushKvU32 = (key: string, val: number) => {
    pushStr(key);
    pushU32(4);
    pushU32(val);
  };

  parts.push(new Uint8Array(GGUF_MAGIC));
  pushU32(3);
  pushU64(128);
  pushU64(chatTemplate ? 5 : 4);

  pushKvStr('general.architecture', architecture);
  pushKvStr('general.name', name);
  pushKvU32(`${architecture}.context_length`, contextLength);
  pushKvU32('general.file_type', fileType);
  if (chatTemplate) {
    pushKvStr('tokenizer.chat_template', chatTemplate);
  }

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
