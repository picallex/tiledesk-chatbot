const redis = require('redis');
const winston = require('./utils/winston');

// Mismo límite que una automatización (30 días). Se renueva en cada escritura,
// así que solo vence lo que lleva 30 días sin actividad.
const REQUEST_KEYS_TTL_SECONDS = 30 * 24 * 60 * 60;

class TdCache {

    constructor(config) {
        winston.debug("(TdCache) config: ", config);
        this.redis_host = config.host;
        this.redis_port = config.port;
        this.redis_password = config.password;
        winston.debug("TdCache redis_host: ", this.redis_host);
        winston.debug("TdCache redis_port: ", this.redis_port);
        winston.debug("TdCache redis_password: ", this.redis_password);
        this.client = null;
        this.subscriberClient = null;
    }

    async connect(callback) {

        return new Promise( async (resolve, reject) => {
            /**
             * Connect redis client
             */
            this.client = redis.createClient(
              {
                  url: `redis://${this.redis_host}:${this.redis_port}`,
                  password: this.redis_password
              });
            this.client.on('error', err => {
                reject(err);
                if (callback) {
                    callback(err);
                }
            });
            this.client.on('ready',function() {
                resolve();
                if (callback) {
                    callback();
                }
            });
            await this.client.connect();

            /**
             * Connect redis subscription client
             */
            this.subscriberClient = redis.createClient(
              {
                url: `redis://${this.redis_host}:${this.redis_port}`,
                password: this.redis_password
              });
            this.subscriberClient.on('error', err => {
                reject(err);
                if (callback) {
                    callback(err);
                }
            });
            this.subscriberClient.on('ready',function() {
                resolve();
                if (callback) {
                    callback();
                }
            });
            await this.subscriberClient.connect();
        });
    }

    async set(key, value, options) {
      if (!options) {
        options = {EX: 86400}
      }
      await this.client.set(
        key,
        value,
        options);
    }

    async incr(key, options) {
      if (!options) {
        options = {EX: REQUEST_KEYS_TTL_SECONDS}
      }
      await this.client.multi()
        .INCR(key)
        .EXPIRE(key, options.EX)
        .exec();
    }

    // HSET no acepta expiración (el {EX} se ignoraba y los hashes :parameters
    // no vencían nunca): el TTL va en un EXPIRE aparte, en la misma transacción.
    async hset(dict_key, key, value, options) {
      if (!value) {
        return;
      }
      if (!options) {
        options = {EX: REQUEST_KEYS_TTL_SECONDS}
      }
      await this.client.multi()
        .HSET(dict_key, key, value)
        .EXPIRE(dict_key, options.EX)
        .exec();
    }

    async hdel(dict_key, key) {
      await this.client.HDEL(dict_key, key);
    }
    
    async setJSON(key, value, options) {
      if (!value) {
        return;
      }
      if (!options) {
        options = {EX: 86400}
      }
      const _string = JSON.stringify(value);
      return await this.set(key, _string, options);
    }
    
    async get(key) {
      const value = await this.client.GET(key);
      return value;
    }

    async hgetall(dict_key) {
      const all = await this.client.HGETALL(dict_key);
      return all;
    }

    async hget(dict_key, key) {
      const value = await this.client.HGET(dict_key, key);
      return value;
    }
    
    async getJSON(key, callback) {
      const value = await this.get(key);
      return JSON.parse(value);
    }
    
    async del(key) {
        await this.client.del(key);
    }
    
    async publish(key, value) {
      await this.client.publish(key, value);
    }

    async subscribe(topic, callback) {
      if (!this.subscriberClient) {
        throw new Error("Redis subscriber not connected");
      }

      if (!callback || typeof callback !== 'function') {
        throw new Error("Callback is mandatory for subscribe")
      }

      await this.subscriberClient.subscribe(topic, (message) => {
        callback(message, topic);
      })
    }

    async unsubscribe(topic) {
      if (!this.subscriberClient) {
        winston.warn("Redis subscriberClient not initialized, cannot unsubscribe.");
        return;
      }
    
      try {
        const result = await this.subscriberClient.unsubscribe(topic);
        winston.debug(`Unsubscribed from topic "${topic}". Current subscription count: ${result}`);
      } catch (err) {
        winston.error(`Error unsubscribing from topic "${topic}":`, err);
      }
    }
    
    // async unsubscribe(topic, listener) {
    //   await this.subscriberClient.unsubscribe(topic, listener);
    // }

    // subscribe(key, callback) {
    //   this.redis_sub.subscribe(key, (message) => {
    //     callback(message);
    //   });
    // }
}

module.exports = { TdCache, REQUEST_KEYS_TTL_SECONDS };