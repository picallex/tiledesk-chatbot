# One-shot: TTL para las claves `tilebot:requests:*` que nunca vencían

**Cuándo correrlo:** UNA vez, después de deployar el cambio de `TdCache` (a partir de ahí las
claves nuevas ya nacen con TTL).

**Por qué:** `TdCache.hset()` le pasaba `{EX: 86400}` a `HSET`, que no acepta expiración: los
hashes `tilebot:requests:<id>:parameters` (y el contador `:step`) quedaban para siempre. En prod
(2026-10-15) había 251k claves y solo 21k con TTL: Redis en 3.86 GB y cada `BGSAVE` tardaba 38 s
a 100% de CPU.

El script recorre `tilebot:requests:*` con `SCAN` (no bloquea) y a las que no tienen TTL les pone
30 días contados desde su último acceso. Las que ya llevan más de 30 días sin uso se reparten en
las próximas 24 h para que no venzan todas juntas.

**Cómo correrlo** (en el host de los bots, en un contenedor del chatbot con el código nuevo):

```bash
docker exec chatbot-new node scripts/migrations/2026-10-15-redis-request-keys-ttl.js --dry-run
docker exec chatbot-new node scripts/migrations/2026-10-15-redis-request-keys-ttl.js
```

**Verificación:** `expires` debería acercarse a `keys`, y `used_memory` bajar en las siguientes 24 h.

```bash
docker exec redis redis-cli info keyspace
docker exec redis redis-cli info memory | grep used_memory_human
```
