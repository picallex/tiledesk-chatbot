const assert = require('assert');
const FlowExecution = require('../models/flow_execution');
const { FlowExecutionStore } = require('../services/FlowExecutionStore');
const { FlowExecutionSupervisor } = require('../services/FlowExecutionSupervisor');
const { TdCache, REQUEST_KEYS_TTL_SECONDS } = require('../TdCache');

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeRedisClient() {
  const calls = [];
  const multi = {
    HSET(...args) { calls.push(['HSET', ...args]); return multi; },
    INCR(...args) { calls.push(['INCR', ...args]); return multi; },
    EXPIRE(...args) { calls.push(['EXPIRE', ...args]); return multi; },
    async exec() { calls.push(['EXEC']); return []; }
  };
  return { calls, multi: () => multi };
}

describe('Redis request keys TTL', function() {

  it('hset sets the field and a 30 days TTL on the hash', async () => {
    const cache = new TdCache({});
    const client = fakeRedisClient();
    cache.client = client;

    await cache.hset('tilebot:requests:r1:parameters', 'name', '"Ana"');

    assert.deepStrictEqual(client.calls, [
      ['HSET', 'tilebot:requests:r1:parameters', 'name', '"Ana"'],
      ['EXPIRE', 'tilebot:requests:r1:parameters', 30 * 24 * 60 * 60],
      ['EXEC']
    ]);
  });

  it('hset honours an explicit TTL', async () => {
    const cache = new TdCache({});
    const client = fakeRedisClient();
    cache.client = client;

    await cache.hset('k', 'f', 'v', { EX: 60 });

    assert.deepStrictEqual(client.calls[1], ['EXPIRE', 'k', 60]);
  });

  it('hset writes nothing for an empty value', async () => {
    const cache = new TdCache({});
    const client = fakeRedisClient();
    cache.client = client;

    await cache.hset('k', 'f', '');

    assert.strictEqual(client.calls.length, 0);
  });

  it('incr renews the TTL of the counter', async () => {
    const cache = new TdCache({});
    const client = fakeRedisClient();
    cache.client = client;

    await cache.incr('tilebot:requests:r1:step');

    assert.deepStrictEqual(client.calls, [
      ['INCR', 'tilebot:requests:r1:step'],
      ['EXPIRE', 'tilebot:requests:r1:step', REQUEST_KEYS_TTL_SECONDS],
      ['EXEC']
    ]);
  });
});

describe('FlowExecutionStore.purgeExpiredCompleted', function() {
  const originalFind = FlowExecution.find;
  const originalDeleteMany = FlowExecution.deleteMany;
  let findArgs;
  let deleteFilter;

  function stubModel(foundIds, deletedCount) {
    findArgs = null;
    deleteFilter = null;
    FlowExecution.find = (filter, projection) => {
      findArgs = { filter, projection };
      return {
        limit(limit) {
          findArgs.limit = limit;
          return { lean: async () => foundIds.map(_id => ({ _id })) };
        }
      };
    };
    FlowExecution.deleteMany = async (filter) => {
      deleteFilter = filter;
      return { deletedCount };
    };
  }

  afterEach(() => {
    FlowExecution.find = originalFind;
    FlowExecution.deleteMany = originalDeleteMany;
  });

  it('only selects completed executions with Redis cleaned and older than the retention', async () => {
    stubModel(['a', 'b'], 2);
    const before = Date.now();

    const deleted = await FlowExecutionStore.purgeExpiredCompleted({ retentionDays: 30, limit: 500 });

    assert.strictEqual(deleted, 2);
    assert.strictEqual(findArgs.filter.status, 'completed');
    assert.deepStrictEqual(findArgs.filter.redis_cleaned_at, { $ne: null });
    const cutoff = findArgs.filter.completed_at.$lt.getTime();
    assert(cutoff <= before - 30 * DAY_MS + 1000 && cutoff >= before - 30 * DAY_MS - 1000);
    assert.deepStrictEqual(findArgs.projection, { _id: 1 });
    assert.strictEqual(findArgs.limit, 500);
  });

  it('repeats the filter on delete so a revived execution is not removed', async () => {
    stubModel(['a', 'b'], 1);

    const deleted = await FlowExecutionStore.purgeExpiredCompleted({ retentionDays: 30, limit: 500 });

    assert.strictEqual(deleted, 1);
    assert.strictEqual(deleteFilter.status, 'completed');
    assert.deepStrictEqual(deleteFilter.redis_cleaned_at, { $ne: null });
    assert.deepStrictEqual(deleteFilter.completed_at, findArgs.filter.completed_at);
    assert.deepStrictEqual(deleteFilter._id, { $in: ['a', 'b'] });
  });

  it('does not delete when nothing is expired', async () => {
    stubModel([], 0);

    const deleted = await FlowExecutionStore.purgeExpiredCompleted({ retentionDays: 30, limit: 500 });

    assert.strictEqual(deleted, 0);
    assert.strictEqual(deleteFilter, null);
  });
});

describe('FlowExecutionSupervisor purge pass', function() {
  const originals = {};
  const stubbed = ['recoverStuckLeases', 'claimDue', 'purgeExpiredCompleted'];
  let purgeCalls;

  beforeEach(() => {
    purgeCalls = [];
    stubbed.forEach(name => { originals[name] = FlowExecutionStore[name]; });
    FlowExecutionStore.recoverStuckLeases = async () => {};
    FlowExecutionStore.claimDue = async () => null;
    FlowExecutionStore.purgeExpiredCompleted = async (args) => {
      purgeCalls.push(args);
      return 0;
    };
  });

  afterEach(() => {
    stubbed.forEach(name => { FlowExecutionStore[name] = originals[name]; });
  });

  it('purges with a 30 days retention by default', async () => {
    const supervisor = new FlowExecutionSupervisor({ resumeFn: async () => {} });

    await supervisor._tick();

    assert.deepStrictEqual(purgeCalls, [{ retentionDays: 30, limit: 500 }]);
  });

  it('uses the configured retention and batch size', async () => {
    const supervisor = new FlowExecutionSupervisor({
      resumeFn: async () => {}, retentionDays: 45, purgeBatchSize: 100
    });

    await supervisor._tick();

    assert.deepStrictEqual(purgeCalls, [{ retentionDays: 45, limit: 100 }]);
  });

  it('does not purge when disabled', async () => {
    const supervisor = new FlowExecutionSupervisor({ resumeFn: async () => {}, purgeEnabled: false });

    await supervisor._tick();

    assert.strictEqual(purgeCalls.length, 0);
  });

  it('a purge failure does not break the tick', async () => {
    FlowExecutionStore.purgeExpiredCompleted = async () => { throw new Error('mongo down'); };
    const supervisor = new FlowExecutionSupervisor({ resumeFn: async () => {} });

    await supervisor._tick();

    assert.strictEqual(supervisor.running, false);
  });
});
