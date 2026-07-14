// netlify/functions/protocol-yields.mjs
import { getStore } from '@netlify/blobs';

const BLOB_PATH = 'whalecoin/protocol-yields.json';
const CACHE_TTL_MS = 15 * 60 * 1000;

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

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

async function fetchStrikeApr() {
  const res = await fetch('https://api.strikefinance.org/v2/liquid-staking/summary', {
    headers: { ...BROWSER_HEADERS, Referer: 'https://app.strikefinance.org/staking' },
  });
  if (!res.ok) throw new Error('Strike API ' + res.status);
  const data = await res.json();
  const aprDecimal = Number(data.apr_30d);
  if (!isFinite(aprDecimal)) throw new Error('Strike: apr_30d ausente o inválido');
  return {
    apr: aprDecimal * 100,
    aprWindowDays: data.apr_window_days ?? 30,
    uniqueStakers: data.active_staked_count ?? null,
    source: 'api.strikefinance.org (v2 liquid staking)',
  };
}

async function fetchSurfApy() {
  const res = await fetch('https://surflending.org/api/staking/getAPY', {
    headers: { ...BROWSER_HEADERS, Referer: 'https://surflending.org/en/staking' },
  });
  if (!res.ok) throw new Error('Surf API ' + res.status);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('Surf: respuesta no es JSON (posible bloqueo/HTML) -> ' + text.slice(0, 120));
  }
  const apy = Number(data.aggregatedApy);
  if (!isFinite(apy)) {
    throw new Error('Surf: aggregatedApy ausente o inválido. Respuesta: ' + JSON.stringify(data).slice(0, 300));
  }
  return {
    apy,
    periodApy: Number(data.periodApy) || null,
    source: 'surflending.org (SURF staking, aggregated APY)',
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // getStore() acá adentro, no a nivel de módulo -- ver nota en trades.mjs.
  const store = getStore('whalecoin-v4');
  const cached = await readJson(store, BLOB_PATH, null);
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return json(cached);
  }

  const result = { strike: null, surf: null, updatedAt: Date.now() };
  const [strikeRes, surfRes] = await Promise.allSettled([fetchStrikeApr(), fetchSurfApy()]);

  if (strikeRes.status === 'fulfilled') {
    result.strike = strikeRes.value;
  } else {
    console.warn('Strike yield fetch failed:', strikeRes.reason?.message);
    if (cached?.strike) result.strike = cached.strike;
  }

  if (surfRes.status === 'fulfilled') {
    result.surf = surfRes.value;
  } else {
    console.warn('Surf yield fetch failed:', surfRes.reason?.message);
    if (cached?.surf) result.surf = cached.surf;
  }

  try {
    await writeJson(store, BLOB_PATH, result);
  } catch (e) {
    console.warn('No se pudo cachear en Blob (se sirve igual):', e.message);
  }

  return json(result);
};