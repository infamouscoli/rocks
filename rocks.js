import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Keypair, Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types.js';

const BLOCK_ENGINE = process.env.BLOCK_ENGINE_URL ?? 'amsterdam.mainnet.block-engine.jito.wtf';
const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const DEFAULT_TIP = Number(process.env.DEFAULT_TIP_LAMPORTS ?? 20000);
const PORT = Number(process.env.PORT ?? 8787);
const TIP_CAP = Number(process.env.TIP_CAP ?? 1000000);
const MAX_BODY = 256 * 1024;

const loadKeypair = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

const authKeypair = loadKeypair(process.env.AUTH_KEYPAIR);
const tipPayer = process.env.TIP_KEYPAIR ? loadKeypair(process.env.TIP_KEYPAIR) : authKeypair;
const connection = new Connection(RPC_URL, 'confirmed');
const client = searcherClient(BLOCK_ENGINE, authKeypair);

const stats = new Map();
const pending = new Map();
let tipCursor = 0;

const botStats = (bot) => {
  if (!stats.has(bot)) stats.set(bot, { sent: 0, landed: 0 });
  return stats.get(bot);
};

client.onBundleResult(
  (result) => {
    const bot = pending.get(result.bundleId);
    if (bot === undefined) return;
    if (result.finalized || result.processed) {
      botStats(bot).landed += 1;
      pending.delete(result.bundleId);
    } else if (result.rejected || result.dropped) {
      pending.delete(result.bundleId);
    }
  },
  (err) => console.error('onBundleResult err', err.message ?? err),
);

const nextTipAccount = async () => {
  const res = await client.getTipAccounts();
  if (!res.ok) throw new Error('no tip accts (' + res.error.message + ')');
  const accounts = res.value;
  return new PublicKey(accounts[tipCursor++ % accounts.length]);
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });

const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const submit = async (bot, body) => {
  if (!Array.isArray(body.transactions) || body.transactions.length < 1 || body.transactions.length > 4) {
    throw Object.assign(new Error('transactions must hold 1-4 base64 entries'), { status: 400 });
  }
  const txs = body.transactions.map((b64) => VersionedTransaction.deserialize(Buffer.from(b64, 'base64')));
  const tip = Math.min(Number(body.tipLamports ?? DEFAULT_TIP), TIP_CAP);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const bundle = new Bundle(txs, 5);
  const tipped = bundle.addTipTx(tipPayer, tip, await nextTipAccount(), blockhash);
  if (tipped instanceof Error) throw Object.assign(tipped, { status: 400 });
  const sent = await client.sendBundle(tipped);
  if (!sent.ok) throw Object.assign(new Error(sent.error.message), { status: 502 });
  pending.set(sent.value, bot);
  botStats(bot).sent += 1;
  return sent.value;
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/stats') {
      const out = {};
      for (const [bot, s] of stats) {
        out[bot] = { sent: s.sent, landed: s.landed, rate: s.sent ? s.landed / s.sent : 0 };
      }
      return reply(res, 200, out);
    }
    if (req.method === 'POST' && req.url === '/bundle') {
      const bot = String(req.headers['x-bot'] ?? 'anonymous');
      const uuid = await submit(bot, await readJson(req));
      return reply(res, 200, { uuid });
    }
    return reply(res, 404, { error: 'not found' });
  } catch (err) {
    return reply(res, err.status ?? 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
