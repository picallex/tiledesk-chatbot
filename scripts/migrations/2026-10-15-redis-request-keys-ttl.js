// One-shot: pone TTL a las claves tilebot:requests:* que quedaron sin expiración
// (HSET ignoraba el {EX} de TdCache.hset). Ver el .md del mismo nombre.
//
//   docker exec chatbot-new node scripts/migrations/2026-10-15-redis-request-keys-ttl.js [--dry-run]

const redis = require('redis');

const TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_TTL_SECONDS = 60 * 60;
const SPREAD_SECONDS = 24 * 60 * 60;
const SCAN_COUNT = 1000;
const PAUSE_MS = 50;

const dryRun = process.argv.includes('--dry-run');

// Una clave vence a los 30 días de su último acceso (OBJECT IDLETIME). Las que ya
// pasaron ese plazo se reparten en las próximas 24 h para no expirar todas de golpe.
function ttlFor(idleSeconds) {
  const remaining = TTL_SECONDS - idleSeconds;
  if (remaining > MIN_TTL_SECONDS) {
    return remaining;
  }
  return MIN_TTL_SECONDS + Math.floor(Math.random() * SPREAD_SECONDS);
}

async function main() {
  const client = redis.createClient({
    url: `redis://${process.env.CACHE_REDIS_HOST}:${process.env.CACHE_REDIS_PORT}`,
    password: process.env.CACHE_REDIS_PASSWORD
  });
  await client.connect();

  let scanned = 0;
  let expired = 0;
  for await (const key of client.scanIterator({ MATCH: 'tilebot:requests:*', COUNT: SCAN_COUNT })) {
    scanned++;
    if (scanned % SCAN_COUNT === 0) {
      console.log(`scanned=${scanned} without_ttl=${expired}`);
      await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
    }
    if (await client.TTL(key) !== -1) {
      continue;
    }
    if (!dryRun) {
      await client.EXPIRE(key, ttlFor(await client.OBJECT_IDLETIME(key) || 0));
    }
    expired++;
  }

  console.log(`done${dryRun ? ' (dry run)' : ''}: scanned=${scanned} without_ttl=${expired}`);
  await client.quit();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
