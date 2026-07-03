#!/usr/bin/env node
// LiteLLM model-prefix rewrite proxy.
//
// Claude Code CLI strips the `anthropic/` provider prefix locally and stores
// bare `claude-opus-4-7` in its jsonl. On resume, it sends that bare name to
// the Anthropic-compat API — which the Tenstorrent LiteLLM proxy rejects
// ("Invalid model name"). This proxy rewrites the model field in both request
// and response (including SSE streams) so the container can transparently
// talk to LiteLLM.
//
// Also injects the LiteLLM Bearer key and the 1M-context beta header, so
// OneCLI credential injection is not needed for this hop — the container
// bypasses OneCLI (via NO_PROXY) for host.docker.internal.
//
// Env:
//   LITELLM_API_KEY   — required, injected as `Authorization: Bearer …`
//   PORT              — default 9090
//   BIND              — default 172.17.0.1 (docker bridge)
//   UPSTREAM_HOST     — default litellm-proxy--tenstorrent.workload.tenstorrent.com

import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';

const UPSTREAM_HOST = process.env.UPSTREAM_HOST ||
  'litellm-proxy--tenstorrent.workload.tenstorrent.com';
const API_KEY = process.env.LITELLM_API_KEY;
const PORT = parseInt(process.env.PORT || '9090', 10);
const BIND = process.env.BIND || '172.17.0.1';

if (!API_KEY) {
  console.error('LITELLM_API_KEY not set');
  process.exit(1);
}

const MODEL_RE = /"model"\s*:\s*"(claude-[a-z0-9.-]+)"/g;

function prefixModel(s) {
  return s.replace(MODEL_RE, (_m, name) => `"model":"anthropic/${name}"`);
}

// Streaming rewriter: keeps a small tail so the pattern isn't split by a chunk boundary.
class ChunkPrefixer extends Transform {
  constructor() {
    super();
    this.tail = '';
  }
  _transform(chunk, _enc, cb) {
    const s = this.tail + chunk.toString('utf8');
    const boundary = Math.max(0, s.length - 64);
    const out = prefixModel(s.slice(0, boundary));
    this.tail = s.slice(boundary);
    cb(null, Buffer.from(out, 'utf8'));
  }
  _flush(cb) {
    cb(null, Buffer.from(prefixModel(this.tail), 'utf8'));
  }
}

const server = http.createServer((req, res) => {
  const reqChunks = [];
  req.on('data', c => reqChunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(reqChunks);
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('json') && body.length > 0) {
      body = Buffer.from(prefixModel(body.toString('utf8')), 'utf8');
    }

    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['content-length'];
    delete headers['authorization'];
    delete headers['proxy-authorization'];
    delete headers['x-api-key'];
    // Ask upstream for uncompressed responses so the stream rewriter can see model fields.
    headers['accept-encoding'] = 'identity';
    headers['host'] = UPSTREAM_HOST;
    headers['authorization'] = `Bearer ${API_KEY}`;
    headers['anthropic-beta'] = 'context-1m-2025-08-07';
    headers['content-length'] = String(body.length);

    const upReq = https.request({
      hostname: UPSTREAM_HOST,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
    }, upRes => {
      const respHeaders = { ...upRes.headers };
      delete respHeaders['content-length'];
      delete respHeaders['content-encoding'];
      delete respHeaders['transfer-encoding'];
      res.writeHead(upRes.statusCode, respHeaders);
      upRes.pipe(new ChunkPrefixer()).pipe(res);
    });
    upReq.on('error', err => {
      console.error(new Date().toISOString(), 'upstream error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
    upReq.write(body);
    upReq.end();
  });
  req.on('error', err => console.error(new Date().toISOString(), 'req error:', err.message));
});

server.listen(PORT, BIND, () => {
  console.log(`litellm-rewrite-proxy listening on ${BIND}:${PORT} → https://${UPSTREAM_HOST}`);
});
