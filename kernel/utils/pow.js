import { pickToken } from '../services/auth.js';
import { apiHeaders, proxiedFetch } from './headers.js';
import { classifyUpstreamCode, credentialError, parseUpstreamEnvelope } from './upstream-errors.js';
import { readFileSync } from 'fs';
import { srcPath } from './runtime-paths.js';

const BASE_URL = 'https://chat.deepseek.com';

// Load and instantiate WASM sha3 module (one-time init)
let wasmInstance = null;

async function getWasm() {
  if (wasmInstance) return wasmInstance;
  const wasmPath = srcPath('sha3_wasm_bg.wasm');
  const wasmBuf = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasmBuf, { wbg: {} });
  wasmInstance = instance;
  return instance;
}

const encoder = new TextEncoder();

function passStringToWasm(instance, str) {
  const { memory, __wbindgen_export_0 } = instance.exports;
  const encoded = encoder.encode(str);
  const ptr = __wbindgen_export_0(encoded.length, 1) >>> 0;
  new Uint8Array(memory.buffer).set(encoded, ptr);
  return [ptr, encoded.length];
}

function wasmSolve(instance, challengeHex, prefix, difficulty) {
  const { memory, wasm_solve, __wbindgen_add_to_stack_pointer } = instance.exports;
  const [chPtr, chLen] = passStringToWasm(instance, challengeHex);
  const [pfPtr, pfLen] = passStringToWasm(instance, prefix);

  const st = __wbindgen_add_to_stack_pointer(-16);
  wasm_solve(st, chPtr, chLen, pfPtr, pfLen, difficulty);
  const v = new DataView(memory.buffer);
  const found = v.getInt32(st, true);
  const answer = v.getFloat64(st + 8, true);
  __wbindgen_add_to_stack_pointer(16);

  if (!found) throw new Error('PoW solve failed: no solution within difficulty');
  return answer;
}

// BigInt fallback
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const MASK = 0xffffffffffffffffn;
const RATE = 136;

function rotl64(v, k) { return ((v << BigInt(k)) | (v >> BigInt(64 - k))) & MASK; }

function keccakF23(s) {
  let a = s.slice();
  for (let r = 0; r < 24; r++) {
    const c = [a[0]^a[5]^a[10]^a[15]^a[20], a[1]^a[6]^a[11]^a[16]^a[21], a[2]^a[7]^a[12]^a[17]^a[22],
               a[3]^a[8]^a[13]^a[18]^a[23], a[4]^a[9]^a[14]^a[19]^a[24]];
    const d = [c[4]^rotl64(c[1],1), c[0]^rotl64(c[2],1), c[1]^rotl64(c[3],1), c[2]^rotl64(c[4],1), c[3]^rotl64(c[0],1)];
    for (let i = 0; i < 25; i++) a[i] = (a[i] ^ d[i%5]) & MASK;
    const b = new Array(25);
    b[0]=a[0];b[10]=rotl64(a[1],1);b[20]=rotl64(a[2],62);b[5]=rotl64(a[3],28);b[15]=rotl64(a[4],27);
    b[16]=rotl64(a[5],36);b[1]=rotl64(a[6],44);b[11]=rotl64(a[7],6);b[21]=rotl64(a[8],55);b[6]=rotl64(a[9],20);
    b[7]=rotl64(a[10],3);b[17]=rotl64(a[11],10);b[2]=rotl64(a[12],43);b[12]=rotl64(a[13],25);b[22]=rotl64(a[14],39);
    b[23]=rotl64(a[15],41);b[8]=rotl64(a[16],45);b[18]=rotl64(a[17],15);b[3]=rotl64(a[18],21);b[13]=rotl64(a[19],8);
    b[14]=rotl64(a[20],18);b[24]=rotl64(a[21],2);b[9]=rotl64(a[22],61);b[19]=rotl64(a[23],56);b[4]=rotl64(a[24],14);
    for (let y = 0; y < 5; y++) {
      const t = [b[y*5], b[y*5+1], b[y*5+2], b[y*5+3], b[y*5+4]];
      for (let x = 0; x < 5; x++) a[y*5+x] = (t[x] ^ ((t[(x+1)%5] ^ MASK) & t[(x+2)%5])) & MASK;
    }
    a[0] = (a[0] ^ RC[r]) & MASK;
  }
  for (let i = 0; i < 25; i++) s[i] = a[i];
}

function readU64LE(buf, off) {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(buf[off + i]) << BigInt(i * 8);
  return v & MASK;
}

function writeU64LE(val, buf, off) {
  const v = val & MASK;
  for (let i = 0; i < 8; i++) buf[off + i] = Number((v >> BigInt(i * 8)) & 0xffn);
}

function preAbsorbPrefix(prefix) {
  const s = new Array(25).fill(0n);
  const buf = Buffer.from(prefix);
  let off = 0;
  while (off + RATE <= buf.length) {
    for (let i = 0; i < RATE / 8; i++) s[i] = (s[i] ^ readU64LE(buf, off + i * 8)) & MASK;
    keccakF23(s);
    off += RATE;
  }
  const tailLen = buf.length - off;
  const tail = Buffer.alloc(RATE);
  buf.copy(tail, 0, off);
  return { s, tail, tailLen };
}

function solvePowBigInt(challengeHex, salt, expireAt, difficulty) {
  if (challengeHex.length !== 64) throw new Error('pow: challenge must be 64 hex chars');
  const target = Buffer.from(challengeHex, 'hex');
  const t0 = readU64LE(target, 0);
  const t1 = readU64LE(target, 8);
  const t2 = readU64LE(target, 16);
  const t3 = readU64LE(target, 24);
  const prefix = `${salt}_${expireAt}_`;
  const { s: baseState, tail, tailLen } = preAbsorbPrefix(prefix);

  for (let n = 0; n < difficulty; n++) {
    const nonceStr = n.toString();
    const nonceBuf = Buffer.from(nonceStr);
    const totalTail = tailLen + nonceBuf.length;
    const s = baseState.slice();

    if (totalTail < RATE) {
      const buf = Buffer.alloc(RATE);
      tail.copy(buf, 0, 0, tailLen);
      nonceBuf.copy(buf, tailLen);
      buf[totalTail] = 0x06;
      buf[RATE - 1] |= 0x80;
      for (let i = 0; i < RATE / 8; i++) s[i] = (s[i] ^ readU64LE(buf, i * 8)) & MASK;
      keccakF23(s);
    } else {
      const buf1 = Buffer.alloc(RATE);
      tail.copy(buf1, 0, 0, tailLen);
      nonceBuf.copy(buf1, tailLen, 0, RATE - tailLen);
      for (let i = 0; i < RATE / 8; i++) s[i] = (s[i] ^ readU64LE(buf1, i * 8)) & MASK;
      keccakF23(s);
      const rem = totalTail - RATE;
      const buf2 = Buffer.alloc(RATE);
      nonceBuf.copy(buf2, 0, RATE - tailLen, RATE - tailLen + rem);
      buf2[rem] = 0x06;
      buf2[RATE - 1] |= 0x80;
      for (let i = 0; i < RATE / 8; i++) s[i] = (s[i] ^ readU64LE(buf2, i * 8)) & MASK;
      keccakF23(s);
    }

    if (s[0] === t0 && s[1] === t1 && s[2] === t2 && s[3] === t3) return n;
  }

  throw new Error('PoW solve failed: no solution within difficulty');
}

let useWasm = true;

/**
 * 上游没有下发 challenge 时，把信封里的真实原因翻译成结构化错误。
 *
 * 为什么不能保留原来的通用文案：上游对失效 token 返回
 * `{ code: 40003, msg: 'Authorization Failed (invalid token)' }`，
 * 旧实现只看到"没有 challenge"就抛 `PoW challenge failed: no challenge
 * returned`。这条文案里既没有 40003 也没有 token 字样，导致上层的
 * isCredentialRelatedError 判定"换凭据也无用"，池里还有可用凭据也不会被尝试。
 *
 * 实测同一批凭据：8 个返回 40003、1 个正常，但请求在前几个上直接失败。
 *
 * 这里只负责如实报告，不在此禁用凭据——pow.js 同时被补全与上传两条路径使用，
 * 禁用决策应由真正占用凭据的调用方做（见 utils/sse.js）。
 */
export function noChallengeError(json) {
  const envelope = parseUpstreamEnvelope(json);
  const code = envelope?.code ?? envelope?.bizCode ?? null;
  const detail = envelope?.message || 'no challenge returned';

  if (envelope) {
    const semantics = classifyUpstreamCode(code);
    if (semantics.credentialFailover) {
      return credentialError(
        `PoW challenge rejected by upstream (${code}: ${detail})`,
        { ...semantics, code, upstream: envelope.upstream },
      );
    }
  }

  // 非凭据类原因（上游格式调整、风控页等）：保留原文案，但带上 code 便于归因。
  const err = new Error(`PoW challenge failed: ${detail}`);
  if (code !== null) err.upstreamCode = code;
  if (envelope?.upstream) err.upstream = envelope.upstream;
  return err;
}

async function solvePowInternal(token, targetPath = '/api/v0/chat/completion') {
  const res = await proxiedFetch(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: await apiHeaders(token),
    body: JSON.stringify({ target_path: targetPath }),
  });

  if (res.status === 202) {
    throw new Error('PoW challenge: WAF blocked (202)');
  }

  const text = await res.text();
  if (!text) throw new Error('PoW challenge: empty response');

  const json = JSON.parse(text);
  const c = json.data?.biz_data?.challenge;
  if (!c) throw noChallengeError(json);
  if (c.algorithm !== 'DeepSeekHashV1') throw new Error(`Unsupported PoW algorithm: ${c.algorithm}`);

  const difficulty = c.difficulty || 144000;
  const prefix = `${c.salt}_${c.expire_at}_`;
  let answer;

  if (useWasm) {
    try {
      const instance = await getWasm();
      answer = wasmSolve(instance, c.challenge, prefix, difficulty);
    } catch (e) {
      console.warn('WASM PoW failed, falling back to BigInt:', e.message);
      useWasm = false;
      // Re-enable WASM after 30 minutes in case the failure was transient
      setTimeout(() => { useWasm = true; }, 30 * 60 * 1000);
      answer = solvePowBigInt(c.challenge, c.salt, c.expire_at, difficulty);
    }
  } else {
    answer = solvePowBigInt(c.challenge, c.salt, c.expire_at, difficulty);
  }

  const powResponse = {
    algorithm: c.algorithm,
    challenge: c.challenge,
    salt: c.salt,
    answer,
    signature: c.signature,
    target_path: c.target_path,
  };

  return Buffer.from(JSON.stringify(powResponse)).toString('base64');
}

// For chat.js — takes explicit token (same token used for PoW and completion)
export async function solvePowChallengeWithToken(token, targetPath = '/api/v0/chat/completion') {
  const powResponse = await solvePowInternal(token, targetPath);
  return { powResponse };
}

// Legacy: picks a token automatically (used by upload.js)
export async function solvePowChallenge(preferVision = false) {
  const token = pickToken(preferVision);
  const powResponse = await solvePowInternal(token, '/api/v0/chat/completion');
  return { powResponse, token };
}

// For upload.js — takes explicit token
export async function solvePowChallengeForUpload(token) {
  return solvePowInternal(token, '/api/v0/file/upload_file');
}
