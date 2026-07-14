// netlify/functions/address-info.mjs
//
// Centraliza las consultas de balance/UTXOs de Cardano (vault, burn address, locked
// address) del lado del servidor -- antes el frontend le pegaba directo a Blockfrost
// con una API key hardcodeada en el HTML (visible para cualquiera que abra el código
// fuente) y, si fallaba, a Koios vía una cadena de proxies públicos poco confiables.
//
// GET /api/address-info?addresses=addr1,addr2,addr3
//   -> { "addr1": { balance, utxo_set, source }, "addr2": { error }, ... }
//
// La API key de Blockfrost vive en el env var BLOCKFROST_PROJECT_ID (mismo que ya
// usa refresh-trades.mjs para CSWAP) -- nunca llega al navegador.

import { getStore } from '@netlify/blobs';

const BLOCKFROST_BASE = 'https://cardano-mainnet.blockfrost.io/api/v0';
const KOIOS_BASE = 'https://api.koios.rest/api/v0/address_info';
const CACHE_TTL_MS = 20 * 1000; // 20s -- suficiente para no pegarle a Blockfrost/Koios en cada visita
const MAX_ADDRESSES = 6; // límite defensivo, no tiene sentido pedir más que esto acá

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

// Misma normalización que ya hacía el frontend: separa lovelace del resto de los
// assets, y parte cada "unit" en policy_id (56 chars) + asset_name (el resto).
function normalizeBlockfrostAmount(amount) {
  const lovelace = amount?.find((a) => a.unit === 'lovelace')?.quantity || '0';
  const assetList = (amount || [])
    .filter((item) => item.unit !== 'lovelace')
    .map((item) => ({
      policy_id: item.unit.slice(0, 56),
      asset_name: item.unit.slice(56),
      quantity: item.quantity,
    }));
  return { balance: lovelace, utxo_set: [{ asset_list: assetList }] };
}

async function fetchFromBlockfrost(address, projectId) {
  const res = await fetch(`${BLOCKFROST_BASE}/addresses/${address}`, {
    headers: { project_id: projectId, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Blockfrost HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return normalizeBlockfrostAmount(data.amount);
}

async function fetchFromKoios(address) {
  const url = `${KOIOS_BASE}?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Koios HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.length) throw new Error('Koios: sin datos para esta dirección');
  return data[0]; // Koios ya devuelve algo con forma { balance, utxo_set }
}

async function fetchAddress(address, projectId, store) {
  const cacheKey = `whalecoin/address-cache/${address}`;
  const cached = await readJson(store, cacheKey, null);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  let result;
  try {
    if (!projectId) throw new Error('BLOCKFROST_PROJECT_ID no configurado');
    const info = await fetchFromBlockfrost(address, projectId);
    result = { ...info, source: 'Blockfrost' };
  } catch (bfError) {
    try {
      const info = await fetchFromKoios(address);
      result = { ...info, source: 'Koios' };
    } catch (koiosError) {
      // Si falla todo pero teníamos un cache viejo (aunque venza el TTL), mejor
      // servir un dato stale que romper el dashboard entero.
      if (cached?.result) {
        return { ...cached.result, stale: true };
      }
      return { error: `Blockfrost: ${bfError.message} | Koios: ${koiosError.message}` };
    }
  }

  await writeJson(store, cacheKey, { result, fetchedAt: Date.now() }).catch(() => {});
  return result;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const url = new URL(req.url);
  const raw = url.searchParams.get('addresses') || '';
  const addresses = raw.split(',').map((a) => a.trim()).filter(Boolean).slice(0, MAX_ADDRESSES);

  if (addresses.length === 0) {
    return json({ error: 'Falta el parámetro ?addresses=addr1,addr2,...' }, 400);
  }

  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  const store = getStore('whalecoin-v4'); // mismo store que ya usan el resto de las funciones

  const results = {};
  await Promise.all(
    addresses.map(async (addr) => {
      results[addr] = await fetchAddress(addr, projectId, store);
    })
  );

  return json(results);
};
