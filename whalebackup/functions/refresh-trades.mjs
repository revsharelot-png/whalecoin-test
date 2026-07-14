// netlify/functions/refresh-trades.mjs
import { getStore } from '@netlify/blobs';

export const config = { timeout: 30 };

const TRADES_BLOB_PATH = 'whalecoin/trades-cache.json';
const BATCH_SIZE = 5;

const TOKENS = [
  { id: 'strike', symbol: 'STRIKE', policy_id: 'f13ac4d66b3ee19a6aa0f2a22298737bd907cc95121662fc971b5275', asset_name: '535452494b45' },
  { id: 'ascend', symbol: 'ASCEND', policy_id: 'eb7a93ebc321647673490810f618b548d7c24aa64d30ae342dba7076', asset_name: '0014df10415343454e44' },
  { id: 'surf', symbol: 'SURF', policy_id: '2d9db8a89f074aa045eab177f23a3395f62ced8b53499a9e4ad46c80', asset_name: '464c4f57' },
  { id: 'pulse', symbol: 'PULSE', policy_id: '2da97f55d49be13dabc8450a2eabab0412f3075a03f7519d32d46925', asset_name: '0014df1050554c5345' },
  { id: 'atlas', symbol: 'ATLAS', policy_id: '9ff9a1b456f074e03be90631e1a5f9b6ed08eacabd0e7f95a11ffff1', asset_name: '0014df1041544c4153' },
];

const POOL_ADDRESSES = {
  strike:  "f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c73e1518e92f367fd5820ac2da1d40ab24fbca1d6cb2c28121ad92f57aff8abce",
  ascend:  "f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ce66195788208dcd363edb600eaf2331019e3599baba645d81d61ef060c82d861",
  surf:    "f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4cb623827076d8b01e7529a77d9f0a9c2fb863dc9aa36416a4ebb12f9d0a6e7f15",
  pulse:   "f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c0c931d4690bc1c779e1ad3fbe20ebcf8888bee0a5b26b7a5042d106da6d974f1",
  atlas:   "f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c71a87b654d5b109bd1e860ee1b0bedcf15a91b558db895d788720bb86462b100",
};

const GT_HEADERS = { Accept: 'application/json' };
const CALL_SPACING_MS = 1500;

// --- CSWAP (pool aparte que también opera STRIKE, vía Blockfrost) ---
const CSWAP_CONTRACT_ADDRESS = 'addr1z8ke0c9p89rjfwmuh98jpt8ky74uy5mffjft3zlcld9h7ml3lmln3mwk0y3zsh3gs3dzqlwa9rjzrxawkwm4udw9axhs6fuu6e';
const STRIKE_POLICY = 'f13ac4d66b3ee19a6aa0f2a22298737bd907cc95121662fc971b5275';
const STRIKE_ASSET_NAME = '535452494b45';
const STRIKE_UNIT = STRIKE_POLICY + STRIKE_ASSET_NAME;
const STRIKE_DECIMALS = 6;
const CSWAP_TX_COUNT = 20;
const CSWAP_CALL_SPACING_MS = 200;
const BLOCKFROST_BASE = 'https://cardano-mainnet.blockfrost.io/api/v0';

function blockfrostHeaders() {
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  if (!projectId) return null;
  return { project_id: projectId };
}

function sumUnitAmount(amountArr, unit) {
  return (amountArr || [])
    .filter(a => a.unit === unit)
    .reduce((sum, a) => sum + Number(a.quantity), 0);
}

// Detecta swaps comparando el UTXO del contrato ANTES (input) y DESPUÉS (output)
// de la tx: si entró ADA y salió STRIKE del pool, alguien compró STRIKE (y viceversa).
// Es más confiable que mirar inputs/outputs sueltos de la transacción completa.
async function fetchCswapStrikeTrades() {
  const headers = blockfrostHeaders();
  if (!headers) {
    console.warn('cswap: falta BLOCKFROST_PROJECT_ID, se omite esta fuente.');
    return [];
  }

  try {
    const listRes = await fetch(
      `${BLOCKFROST_BASE}/addresses/${CSWAP_CONTRACT_ADDRESS}/transactions?order=desc&count=${CSWAP_TX_COUNT}`,
      { headers }
    );
    if (!listRes.ok) {
      console.warn(`cswap: lista de txs falló con ${listRes.status}`);
      return [];
    }
    const txList = await listRes.json();

    const trades = [];
    for (let i = 0; i < txList.length; i++) {
      const txRef = txList[i];
      try {
        const utxoRes = await fetch(`${BLOCKFROST_BASE}/txs/${txRef.tx_hash}/utxos`, { headers });
        if (!utxoRes.ok) continue;
        const utxo = await utxoRes.json();

        const poolIns = (utxo.inputs || []).filter(x => x.address === CSWAP_CONTRACT_ADDRESS);
        const poolOuts = (utxo.outputs || []).filter(x => x.address === CSWAP_CONTRACT_ADDRESS);
        // Si no hay exactamente 1 UTXO de pool de cada lado, no es un swap simple: lo salteamos.
        if (poolIns.length !== 1 || poolOuts.length !== 1) continue;

        const lovelaceIn = sumUnitAmount(poolIns[0].amount, 'lovelace');
        const lovelaceOut = sumUnitAmount(poolOuts[0].amount, 'lovelace');
        const strikeIn = sumUnitAmount(poolIns[0].amount, STRIKE_UNIT);
        const strikeOut = sumUnitAmount(poolOuts[0].amount, STRIKE_UNIT);

        const deltaLovelace = lovelaceOut - lovelaceIn;
        const deltaStrike = strikeOut - strikeIn;
        if (deltaLovelace === 0 || deltaStrike === 0) continue;

        const tokenAmount = Math.abs(deltaStrike) / Math.pow(10, STRIKE_DECIMALS);
        const adaAmount = Math.abs(deltaLovelace) / 1_000_000;
        if (!isFinite(tokenAmount) || tokenAmount <= 0) continue;
        if (!isFinite(adaAmount) || adaAmount <= 0) continue;

        // El input que NO es del pool suele ser la wallet del trader (swap simple:
        // 1 input del pool + 1 input del usuario pagando).
        const userInput = (utxo.inputs || []).find(x => x.address !== CSWAP_CONTRACT_ADDRESS);

        trades.push({
          symbol: 'STRIKE',
          side: deltaLovelace > 0 ? 'buy' : 'sell', // entró ADA al pool => alguien compró STRIKE
          tokenAmount,
          priceAda: adaAmount / tokenAmount,
          txHash: txRef.tx_hash,
          wallet: userInput?.address || null,
          timestamp: txRef.block_time ? txRef.block_time * 1000 : Date.now(),
        });
      } catch (_) {
        // una tx individual falló: la salteamos, no aborta el resto del batch
      }
      if (i < txList.length - 1) await sleep(CSWAP_CALL_SPACING_MS);
    }

    return trades;
  } catch (e) {
    console.warn('cswap: fallo general -', e.message);
    return [];
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function normalizeTrade(raw, token) {
  const a = raw?.attributes || {};
  const kind = (a.kind || a.type || a.trade_type || '').toLowerCase();
  const side = kind.includes('sell') ? 'sell' : kind.includes('buy') ? 'buy' : null;
  if (!side) return null;

  let tokenAmount;
  let pricePerToken;
  if (side === 'buy') {
    tokenAmount = Number(a.to_token_amount ?? a.amount ?? NaN);
    pricePerToken = Number(a.price_to_in_currency_token ?? a.price_in_ada ?? NaN);
  } else {
    tokenAmount = Number(a.from_token_amount ?? a.amount ?? NaN);
    pricePerToken = Number(a.price_from_in_currency_token ?? a.price_in_ada ?? NaN);
  }
  if (!isFinite(tokenAmount) || tokenAmount <= 0) return null;
  if (!isFinite(pricePerToken) || pricePerToken <= 0) return null;

  const timestamp = a.block_timestamp || a.timestamp || a.tx_timestamp || null;
  const txHash = a.tx_hash || a.transaction_hash || a.hash || null;
  const wallet = a.tx_from_address || a.from_address || a.maker || null;

  if (!timestamp) return null;

  return {
    symbol: token.symbol,
    side,
    tokenAmount,
    priceAda: pricePerToken,
    txHash,
    wallet,
    timestamp: new Date(timestamp).getTime(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTradesForPool(token, poolAddress) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/cardano/pools/${poolAddress}/trades`;
    const res = await fetch(url, { headers: GT_HEADERS, signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.status === 429) {
      console.warn(`refresh: 429 para ${token.symbol}. Se conserva el cache anterior de este token.`);
      return null;
    }
    if (!res.ok) {
      console.warn(`refresh: Error ${res.status} para ${token.symbol}. Se conserva el cache anterior de este token.`);
      return null;
    }
    const data = await res.json();
    return (data?.data || []).map(r => normalizeTrade(r, token)).filter(Boolean);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      console.warn(`refresh: Timeout para ${token.symbol}. Se conserva el cache anterior de este token.`);
    } else {
      console.warn(`refresh: fallo en ${token.symbol}:`, e.message, '- Se conserva el cache anterior de este token.');
    }
    return null;
  }
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

export default async (req) => {
  // getStore() acá adentro, no a nivel de módulo -- ver nota en trades.mjs.
  const store = getStore('whalecoin-v4');

  const pools = {};
  for (const t of TOKENS) {
    const addr = POOL_ADDRESSES[t.id];
    if (addr) pools[t.id] = { address: addr, name: t.symbol + '/ADA' };
  }
  const tokensWithPool = TOKENS.filter(t => pools[t.id]?.address);
  const batch = tokensWithPool.slice(0, BATCH_SIZE);

  const previous = await readJson(store, TRADES_BLOB_PATH, { trades: [] });
  const previousBySymbol = {};
  for (const t of previous.trades || []) {
    (previousBySymbol[t.symbol] ||= []).push(t);
  }

  const resultsBySymbol = { ...previousBySymbol };
  const failedSymbols = [];
  const refreshedSymbols = [];

  for (let i = 0; i < batch.length; i++) {
    const t = batch[i];
    const trades = await fetchTradesForPool(t, pools[t.id].address);
    
    if (trades === null) {
      failedSymbols.push(t.symbol);
    } else if (trades.length > 0) {
      resultsBySymbol[t.symbol] = trades;
      refreshedSymbols.push(t.symbol);
    } else {
      refreshedSymbols.push(t.symbol);
    }
    if (i < batch.length - 1) await sleep(CALL_SPACING_MS);
  }

  // CSWAP: fuente aparte que también opera STRIKE, se mezcla con lo ya obtenido para ese símbolo.
  try {
    const cswapTrades = await fetchCswapStrikeTrades();
    if (cswapTrades.length > 0) {
      const merged = [...(resultsBySymbol.STRIKE || []), ...cswapTrades];
      const seen = new Set();
      resultsBySymbol.STRIKE = merged.filter(tr => {
        if (seen.has(tr.txHash)) return false;
        seen.add(tr.txHash);
        return true;
      });
      refreshedSymbols.push('STRIKE (cswap)');
    }
  } catch (e) {
    console.warn('cswap: no se pudo integrar -', e.message);
  }

  const allTrades = Object.values(resultsBySymbol).flat();
  allTrades.sort((a, b) => b.timestamp - a.timestamp);
  const trades = allTrades.slice(0, 60);

  const result = { trades, updatedAt: Date.now() };
  if (failedSymbols.length > 0) result._staleSymbols = failedSymbols;

  try {
    await writeJson(store, TRADES_BLOB_PATH, result);
    return json({
      status: 'ok',
      totalTrades: allTrades.length,
      batch: batch.map(t => t.symbol),
      refreshedSymbols,
      failedSymbols,
      message: failedSymbols.length > 0
        ? `Batch [${batch.map(t => t.symbol).join(', ')}]: ${refreshedSymbols.join(', ') || 'ninguno'} actualizado, ${failedSymbols.join(', ')} usó cache anterior.`
        : `Batch [${batch.map(t => t.symbol).join(', ')}] actualizado correctamente.`,
    });
  } catch (e) {
    console.error('❌ Error CRÍTICO guardando en Blob:', e.message);
    return json({
      status: 'error',
      totalTrades: allTrades.length,
      error: e.message,
      stack: e.stack,
    }, 500);
  }
};