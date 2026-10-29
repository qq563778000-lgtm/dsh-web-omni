import { solvePowChallengeForUpload } from '../utils/pow.js';
import { apiHeaders, getHeaders, proxiedFetch } from '../utils/headers.js';
import { EXT_BY_MIME, extensionFromName, resolveUploadableBytes } from '../utils/message-files.js';

const BASE_URL = 'https://chat.deepseek.com';

// Strip characters that could break out of the Content-Disposition /
// Content-Type header fields in the hand-built multipart body.
function sanitizeHeaderField(s) {
  return String(s).replace(/["\r\n]/g, '');
}

export async function uploadFile(fileBuffer, filename, mimeType, token) {
  const powResponse = await solvePowChallengeForUpload(token);

  const safeName = sanitizeHeaderField(filename);
  const safeMime = sanitizeHeaderField(mimeType);
  const boundary = `----FormBoundary${Date.now()}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${safeMime}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, fileBuffer, footer]);

  const res = await proxiedFetch(`${BASE_URL}/api/v0/file/upload_file`, {
    method: 'POST',
    headers: {
      ...await apiHeaders(token, {
        'x-ds-pow-response': powResponse,
        'x-file-size': body.length.toString(),
        'x-model-type': 'vision',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
    },
    body,
  });

  const json = await res.json();
  const fileId = json.data?.biz_data?.id;
  if (!fileId) throw new Error(`File upload failed: ${JSON.stringify(json)}`);

  return fileId;
}

export async function waitForFileReady(fileId, token, maxAttempts = 30, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await proxiedFetch(`${BASE_URL}/api/v0/file/fetch_files?file_ids=${fileId}`, {
      headers: await getHeaders(token),
    });
    const json = await res.json();
    const files = json.data?.biz_data?.files;
    if (files && files.length > 0) {
      const status = files[0].status?.toUpperCase();
      if (status === 'SUCCESS' || status === 'PROCESSED' || status === 'READY' || status === 'DONE') {
        return files[0];
      }
      if (status === 'FAILED') {
        throw new Error(`File processing failed: ${files[0].error_code || 'unknown'}`);
      }
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error(`File not ready after ${maxAttempts * intervalMs / 1000}s`);
}

/**
 * 确保文件名带扩展名。
 *
 * 上游按扩展名判定文件类型，无扩展名会直接返回
 * biz_code=9 unsupported file type。因此这里兜底补一个与 mimeType
 * 匹配的扩展名，避免上游因文件名问题拒收。
 */
function ensureExtension(filename, mimeType) {
  const name = String(filename || '').trim();
  if (extensionFromName(name)) return name;
  const ext = EXT_BY_MIME[String(mimeType || '').toLowerCase()] || 'bin';
  return `${name || 'uploaded'}.${ext}`;
}

export async function resolveUploadableToRefId(file, token) {
  const { buffer, mimeType } = await resolveUploadableBytes(file, proxiedFetch);
  const resolvedMime = mimeType || file.mimeType || 'application/octet-stream';
  return uploadRefFile(
    buffer,
    ensureExtension(file.filename, resolvedMime),
    resolvedMime,
    token,
  );
}
