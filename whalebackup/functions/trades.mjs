// netlify/functions/trades.mjs
import { getStore } from '@netlify/blobs';

const TRADES_BLOB_PATH = 'whalecoin/trades-cache.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    // getStore() DENTRO del handler -- si se llama una sola vez a nivel de módulo,
    // el token que trae adentro puede vencerse en contenedores "calientes" reutilizados
    // entre invocaciones, y ahí explota con "Failed to decode token: Token expired".
    const store = getStore('whalecoin-v4');
    const data = await store.get(TRADES_BLOB_PATH, { type: 'json' });
    if (!data) {
      return json({ trades: [], updatedAt: Date.now() });
    }
    return json(data);
  } catch (error) {
    console.error('❌ trades error:', error.message);
    return json({ trades: [], updatedAt: Date.now(), error: error.message });
  }
};