import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HxaConnectClient, ApiError, DownloadError } from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────

const BASE_URL = 'http://test-hub:4800';
const TOKEN = 'test-token-abc';

function makeClient(opts?: { timeout?: number }): HxaConnectClient {
  return new HxaConnectClient({
    url: BASE_URL,
    token: TOKEN,
    timeout: opts?.timeout ?? 5_000,
  });
}

/** Build a standard Response from a Uint8Array body. */
function fakeResponse(body: Uint8Array, opts?: {
  status?: number;
  contentType?: string;
  contentLength?: number | null; // null = omit header
}): Response {
  const { status = 200, contentType = 'image/png', contentLength } = opts ?? {};
  const headers: Record<string, string> = { 'content-type': contentType };
  if (contentLength !== undefined && contentLength !== null) {
    headers['content-length'] = String(contentLength);
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

/** Build a Response whose body delivers chunks with a delay. */
function slowResponse(
  chunks: Uint8Array[],
  delayMs: number,
  opts?: { contentType?: string },
): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(chunks[i++]);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': opts?.contentType ?? 'application/octet-stream' },
  });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// ─── Tests ───────────────────────────────────────────────────

describe('downloadFile', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Happy paths ──────────────────────────────────────────

  it('downloads by fileId', async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      assert.match(url, /\/api\/files\/file-abc$/);
      const h = init?.headers as Record<string, string>;
      assert.equal(h['Authorization'], `Bearer ${TOKEN}`);
      return fakeResponse(PNG, { contentType: 'image/png' });
    };

    const result = await makeClient().downloadFile({ fileId: 'file-abc' });
    assert.deepEqual(result.buffer, PNG);
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.size, 4);
  });

  it('downloads by plain string (convenience)', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      assert.match(String(input), /\/api\/files\/my-file$/);
      return fakeResponse(PNG);
    };
    const result = await makeClient().downloadFile('my-file');
    assert.equal(result.size, 4);
  });

  it('downloads by absolute URL', async () => {
    const absUrl = 'https://other-hub.example.com/api/files/xyz';
    globalThis.fetch = async (input: RequestInfo | URL) => {
      assert.equal(String(input), absUrl);
      return fakeResponse(PNG);
    };
    const result = await makeClient().downloadFile({ url: absUrl });
    assert.equal(result.size, 4);
  });

  it('downloads by hub-relative URL', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      assert.equal(String(input), `${BASE_URL}/api/files/rel-123`);
      return fakeResponse(PNG);
    };
    const result = await makeClient().downloadFile({ url: '/api/files/rel-123' });
    assert.equal(result.size, 4);
  });

  it('URI-encodes fileId with special characters', async () => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.ok(url.includes(encodeURIComponent('file/with spaces')));
      return fakeResponse(PNG);
    };
    await makeClient().downloadFile({ fileId: 'file/with spaces' });
  });

  it('strips charset from content-type', async () => {
    globalThis.fetch = async () =>
      fakeResponse(PNG, { contentType: 'image/jpeg; charset=utf-8' });
    const result = await makeClient().downloadFile('x');
    assert.equal(result.contentType, 'image/jpeg');
  });

  it('returns empty result when response body is null', async () => {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    const result = await makeClient().downloadFile('x');
    assert.equal(result.size, 0);
    assert.equal(result.buffer.length, 0);
    assert.equal(result.contentType, 'application/octet-stream');
  });

  it('defaults content-type to application/octet-stream', async () => {
    globalThis.fetch = async () =>
      new Response(PNG, { status: 200, headers: {} });
    const result = await makeClient().downloadFile('x');
    assert.equal(result.contentType, 'application/octet-stream');
  });

  it('merges multiple chunks correctly', async () => {
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5, 6]);
    globalThis.fetch = async () => slowResponse([chunk1, chunk2], 0);
    const result = await makeClient().downloadFile('x');
    assert.deepEqual(result.buffer, new Uint8Array([1, 2, 3, 4, 5, 6]));
    assert.equal(result.size, 6);
  });

  // ── Oversized body ───────────────────────────────────────

  it('rejects immediately when content-length exceeds maxBytes', async () => {
    let bodyCancelled = false;
    globalThis.fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(100));
          controller.close();
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': '20000000', // 20 MB
        },
      });
    };

    await assert.rejects(
      () => makeClient().downloadFile('x', { maxBytes: 1024 }),
      (err: unknown) => {
        assert.ok(err instanceof DownloadError);
        assert.equal(err.code, 'FILE_TOO_LARGE');
        assert.match(err.message, /20000000.*1024/);
        return true;
      },
    );
    assert.ok(bodyCancelled, 'response body should be cancelled on early reject');
  });

  it('rejects during streaming when body exceeds maxBytes (no content-length)', async () => {
    globalThis.fetch = async () =>
      slowResponse(
        [new Uint8Array(500), new Uint8Array(500), new Uint8Array(500)],
        0,
        { contentType: 'image/png' },
      );

    await assert.rejects(
      () => makeClient().downloadFile('x', { maxBytes: 1000 }),
      (err: unknown) => {
        assert.ok(err instanceof DownloadError);
        assert.equal(err.code, 'FILE_TOO_LARGE');
        assert.match(err.message, /exceeded limit of 1000/);
        return true;
      },
    );
  });

  it('accepts body exactly at maxBytes', async () => {
    const body = new Uint8Array(1024);
    globalThis.fetch = async () => fakeResponse(body, { contentLength: 1024 });
    const result = await makeClient().downloadFile('x', { maxBytes: 1024 });
    assert.equal(result.size, 1024);
  });

  // ── Input validation ─────────────────────────────────────

  it('rejects empty fileId', async () => {
    await assert.rejects(
      () => makeClient().downloadFile({ fileId: '' }),
      (err: unknown) => {
        assert.ok(err instanceof DownloadError);
        assert.equal(err.code, 'FILE_ID_EMPTY');
        return true;
      },
    );
  });

  it('rejects empty url', async () => {
    await assert.rejects(
      () => makeClient().downloadFile({ url: '' }),
      (err: unknown) => {
        assert.ok(err instanceof DownloadError);
        assert.equal(err.code, 'URL_EMPTY');
        return true;
      },
    );
  });

  it('rejects invalid URL scheme', async () => {
    await assert.rejects(
      () => makeClient().downloadFile({ url: 'ftp://evil.com/file' }),
      (err: unknown) => {
        assert.ok(err instanceof DownloadError);
        assert.equal(err.code, 'URL_INVALID');
        assert.match(err.message, /ftp/);
        return true;
      },
    );
  });

  // ── Non-2xx responses ────────────────────────────────────

  it('throws ApiError on 404', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'File not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });

    await assert.rejects(
      () => makeClient().downloadFile('missing'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.match(err.message, /not found/i);
        return true;
      },
    );
  });

  it('throws ApiError on 403', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });

    await assert.rejects(
      () => makeClient().downloadFile('secret'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  it('throws ApiError on 500 with non-JSON body', async () => {
    globalThis.fetch = async () =>
      new Response('Internal Server Error', { status: 500 });

    await assert.rejects(
      () => makeClient().downloadFile('broken'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 500);
        return true;
      },
    );
  });

  // ── Abort / timeout ──────────────────────────────────────

  it('respects external AbortSignal', async () => {
    const ac = new AbortController();
    ac.abort(); // pre-abort

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Check signal — real fetch would throw on abort
      init?.signal?.throwIfAborted();
      return fakeResponse(PNG);
    };

    await assert.rejects(
      () => makeClient().downloadFile('x', { signal: ac.signal }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, 'AbortError');
        return true;
      },
    );
  });

  it('aborts during streaming when signal fires mid-download', async () => {
    const ac = new AbortController();

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Return a slow stream; abort fires after first chunk
      let chunkCount = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (chunkCount >= 3) {
            controller.close();
            return;
          }
          if (chunkCount === 1) {
            // Abort after second chunk
            ac.abort();
          }
          chunkCount++;
          await new Promise((r) => setTimeout(r, 10));
          // Check if aborted
          if (init?.signal?.aborted) {
            controller.error(new DOMException('The operation was aborted', 'AbortError'));
            return;
          }
          controller.enqueue(new Uint8Array(100));
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    };

    await assert.rejects(
      () => makeClient().downloadFile('x', { signal: ac.signal }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // The error is either AbortError or the stream error
        return true;
      },
    );
  });

  it('uses custom timeout', async () => {
    // Mock fetch that delays longer than the timeout — respects signal
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        const onAbort = () => {
          reject(signal!.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        // Delay longer than timeout to guarantee signal fires first
        setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve(fakeResponse(PNG));
        }, 2000);
      });
    };

    await assert.rejects(
      () => makeClient({ timeout: 50 }).downloadFile('x', { timeout: 50 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // Timeout fires as AbortError or TimeoutError depending on runtime
        return true;
      },
    );
  });

  // ── Auth headers ─────────────────────────────────────────

  it('sends X-Org-Id header when orgId is set', async () => {
    const client = new HxaConnectClient({
      url: BASE_URL,
      token: TOKEN,
      orgId: 'org-xyz',
    });

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      assert.equal(h['X-Org-Id'], 'org-xyz');
      assert.equal(h['Authorization'], `Bearer ${TOKEN}`);
      return fakeResponse(PNG);
    };

    await client.downloadFile('x');
  });
});

// ─── downloadToPath ────────────────────────────────────────────

describe('downloadToPath', () => {
  let originalFetch: typeof globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    tmpDir = join(tmpdir(), `hxa-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves downloaded file to disk', async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    globalThis.fetch = async () => fakeResponse(body, { contentType: 'image/png' });

    const outPath = join(tmpDir, 'image.png');
    const result = await makeClient().downloadToPath('file-1', outPath);

    assert.ok(existsSync(outPath), 'file should exist on disk');
    const written = readFileSync(outPath);
    assert.deepEqual(new Uint8Array(written), body);
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.size, 8);
    assert.ok(result.path.endsWith('image.png'));
    assert.ok(result.path.startsWith('/'), 'path should be absolute');
  });

  it('creates parent directories', async () => {
    globalThis.fetch = async () => fakeResponse(PNG);

    const outPath = join(tmpDir, 'a', 'b', 'c', 'file.png');
    await makeClient().downloadToPath('file-2', outPath);

    assert.ok(existsSync(outPath));
  });

  it('propagates DownloadError from downloadFile', async () => {
    await assert.rejects(
      () => makeClient().downloadToPath({ fileId: '' }, join(tmpDir, 'out.bin')),
      (err: unknown) => {
        assert.ok(err instanceof DownloadError);
        assert.equal(err.code, 'FILE_ID_EMPTY');
        return true;
      },
    );
  });

  it('propagates ApiError from downloadFile', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'gone' }), { status: 410 });

    await assert.rejects(
      () => makeClient().downloadToPath('gone-file', join(tmpDir, 'out.bin')),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 410);
        return true;
      },
    );
  });
});

// ─── getFileUrl ────────────────────────────────────────────────

describe('getFileUrl', () => {
  it('returns absolute URL with encoded fileId', () => {
    const client = makeClient();
    assert.equal(client.getFileUrl('abc-123'), `${BASE_URL}/api/files/abc-123`);
  });

  it('encodes special characters', () => {
    const client = makeClient();
    const url = client.getFileUrl('file/with spaces');
    assert.equal(url, `${BASE_URL}/api/files/${encodeURIComponent('file/with spaces')}`);
  });

  it('strips trailing slash from base URL', () => {
    const client = new HxaConnectClient({ url: `${BASE_URL}/`, token: TOKEN });
    assert.equal(client.getFileUrl('x'), `${BASE_URL}/api/files/x`);
  });
});

// ─── DownloadError ─────────────────────────────────────────────

describe('DownloadError', () => {
  it('has correct name, code, and message', () => {
    const err = new DownloadError('FILE_TOO_LARGE', 'Too big');
    assert.equal(err.name, 'DownloadError');
    assert.equal(err.code, 'FILE_TOO_LARGE');
    assert.equal(err.message, 'Too big');
    assert.ok(err instanceof Error);
  });

  it('is distinct from ApiError', () => {
    const dlErr = new DownloadError('FILE_TOO_LARGE', 'big');
    const apiErr = new ApiError(500, { error: 'internal' });
    assert.ok(!(dlErr instanceof ApiError));
    assert.ok(!(apiErr instanceof DownloadError));
  });
});
