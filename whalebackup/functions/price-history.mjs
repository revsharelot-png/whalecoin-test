// netlify/functions/price-history.mjs
import { getStore } from '@netlify/blobs';

const BLOB_PATH = 'whalecoin/price-history.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_GAP_MS = 20 * 60 * 1000;
const RETENTION_MS = 2 * DAY_MS;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

async function readJson(store, path, fallback) {
  try {
    const data = await store.get(path, { type: 'json' });
    return data ?? fallback;
  } catch (_) {
    return fallback;
  }
}

async function writeJson(store, path, data) {
  await store.set(path, JSON.stringify(data));
}

function sanitizePrices(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const [id, value] of Object.entries(raw)) {
    const num = Number(value);
    if (isFinite(num) && num > 0) clean[id] = num;
  }
  return clean;
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // getStore() acá adentro, no a nivel de módulo -- ver nota en trades.mjs.
  const store = getStore('whalecoin-v4');
  let history = await readJson(store, BLOB_PATH, []);

  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const prices = sanitizePrices(body?.prices);
      if (Object.keys(prices).length > 0) {
        const now = Date.now();
        const last = history[history.length - 1];
        if (!last || now - last.t > MIN_GAP_MS) {
          history.push({ t: now, prices });
        } else {
          last.prices = { ...last.prices, ...prices };
        }
        const cutoff = now - RETENTION_MS;
        history = history.filter((p) => p.t >= cutoff);
        await writeJson(store, BLOB_PATH, history);
      }
    } catch (_) {}
  }

  return json({ history });
};