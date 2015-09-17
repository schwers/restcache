var sha = require('sha1');
var LRU = require('lru-cache');

function Cache(config) {
  var config = config || {};

  this.defaultDataCacheConfig = config.defaultDataCacheConfig || {};
  this.defaultRequestCacheConfig = config.defaultRequestCacheConfig || {};
  this.dataTypes = config.dataTypes || {};

  this.requestCache = {};
  this.dataCache = {};
  this.headCache = {};

  this.setUpDataCache();
}

Cache.prototype.setUpDataCache = function() {
  for (var type in this.dataTypes) {
    this.resetData(type);
  }
}

Cache.prototype.get = function(fn, params, options) {
  var cache = this;
  var options = options || this.defaultRequestCacheConfig || {};
  var key = options.name || fn.name;

  if (!options.cache && this.defaultRequestCacheConfig.cache) {
    options.cache = this.defaultRequestCacheConfig.cache;
  }

  if (!key) {
    return Promise.reject('No key was passed in, and function did not have a name.');
  }

  var paramsHash = Cache.generateHash(params);

  var failedRule = false;

  if (options.rules) {
    failedRule = options.rules.some(function(rule) {
      return !rule(params);
    });
  }

  if (!failedRule) {
    var cachedData = this.loadFromCache(key, paramsHash);

    if (cachedData) {
      if (options.unformat) {
        cachedData.body = options.unformat(cachedData.body);
      }

      return Promise.resolve(cachedData);
    }
  }

  return new Promise(function(resolve, reject) {
    fn.apply(undefined, params).then(function(data){
      var cacheData = Object.assign({}, data);
      resolve(data);

      if (options.format) {
        cacheData.body = options.format(cacheData.body);
      }

      cache.setCaches(key, paramsHash, cacheData, options);
    }, function(error) {
      reject(error);
    });
  });
};

Cache.prototype.getById = function(type, id, fn, params, options) {
  if (this.dataCache[type]) {
    var res = this.dataCache[type].get(id);

    if (res) {
      var o = {};
      o[type] = res;

      if (options.unformat) {
        o = options.unformat(o);
      }

      return Promise.resolve(o);
    }
  }

  return this.get(fn, params, options);
};


Cache.prototype.loadFromCache = function(key, hash) {
  if (!this.requestCache[key]) { return; }

  var requestCache = this.requestCache[key].get(hash);
  if(!requestCache) { return; }

  var headers = this.headCache[key].get(hash);

  if(typeof headers === 'undefined') { return; }

  var obj = {
    body: {},
    headers,
  };

  var dataCache;
  var found = true;
  var id;

  for (var type in requestCache) {
    dataCache = this.dataCache[type];
    if (!dataCache) { return; }

    id = this.getidProperty(type);

    if (requestCache[type].map) {
      obj.body[type] = requestCache[type].map(function(id) {
        var data = dataCache.get(id);
        if (typeof data === 'undefined') {
          found = false;
        }

        return data;
      });
    } else {
      obj.body[type] = dataCache.get(id);
      found = typeof obj.body[type] === 'undefined';
    }

    if (!found) { return; }
  }

  return obj;
};

Cache.prototype.setCaches = function(key, hash, data, options) {
  this.setRequestCache(key, hash, data, options);
  this.setDataCache(data.body);
};

Cache.prototype.setRequestCache = function(key, hash, data, options) {
  var dataType;
  var id;

  if (!this.requestCache[key]) {
    if (!options.cache) {
      throw('No LRU configuration passed in for '+key+', aborting.');
    }

    this.requestCache[key] = this.requestCache[key] || new LRU(options.cache);
    this.headCache[key] = this.headCache[key] || new LRU(options.cache);
  }

  var idCache = {};

  // explicitly null, instead of undefined; this allows us to check if the key
  // exists
  data.headers = data.headers || null;
  this.headCache[key].set(hash, data.headers);

  for (var type in data.body) {
    id = this.getidProperty(type);

    if (data.body[type].map) {
      idCache[type] = data.body[type].map(function(d) {
        return d[id];
      });
    } else {
      idCache[type] = data.body[type][id];
    }
  }

  this.requestCache[key].set(hash, idCache);
};

Cache.prototype.setDataCache = function(data) {
  var dataType;
  var id;

  for (var k in data) {
    if (!this.dataCache[k]) {
      this.resetData(k);
    }

    dataType = this.dataTypes[k];

    id = this.getidProperty(k);

    if (Array.isArray(data[k])) {
      for (var o in data[k]) {
        if (data[k][o].hasOwnProperty(id)) {
          this.dataCache[k].set(data[k][o][id], data[k][o]);
        }
      }
    } else {
      this.dataCache[k].set(data[k][id], data[k]);
    }
  }
};

Cache.prototype.resetData = function(type, data) {
  if (!type) {
    this.dataCache = {};
    return;
  }

  var cache = this.dataCache[type];

  if (!cache) {
    var cacheConfig = this.getDataCacheConfig(type);

    if (cacheConfig) {
      this.dataCache[type] = new LRU(cacheConfig);
    }

    return;
  }


  if (!data) {
    cache.reset();
    return;
  }

  var id = this.getidProperty(type);

  // If it's an array
  if (Array.isArray(data)) {
    data.forEach(function(d) {
      cache.set(d[id], d);
    });
  } else {
    cache.set(data[id], data);
  }
};

Cache.prototype.resetRequests = function(key, parameters, ids) {
  if (typeof key === 'function') {
    key = key.name;
  }

  if (!key) {
    this.requestCache = {};
    this.headCache = {};
    return;
  }

  var cache = this.requestCache[key];
  var headCache = this.headCache[key];

  if (!parameters) {
    cache.reset();
    headCache.reset();
    return;
  }

  var hash = Cache.generateHash(parameters);

  if (ids) {
    cache.set(hash, ids);
    return;
  }

  cache.del(hash);
};

Cache.prototype.deleteData = function(type, data) {
  if (!type || !this.dataCache[type]) {
    return;
  }

  var dataCache = this.dataCache[type];
  var id = this.getidProperty(type);

  if (Array.isArray(data)) {
    data.forEach(function(d) {
      dataCache.del(d[id]);
    });
    return;
  } else if (typeof data === 'object') {
    dataCache.del(data[id]);
    return;
  }

  dataCache.del(data);
}

Cache.prototype.getidProperty = function(type) {
  var dataType = this.dataTypes[type];
  return dataType ? dataType.idProperty || 'id' : 'id';
}

Cache.prototype.getDataCacheConfig = function(type) {
  if (this.dataTypes && this.dataTypes[type]) {
    if (this.dataTypes[type].hasOwnProperty('cache')) {
      return this.dataTypes[type].cache;
    }
  }

  return this.defaultDataCacheConfig.cache;
}

Cache.prototype.head = function(key, params) {
  var keyCache = this.headCache[key];
  if(!keyCache) { return; }

  var paramsHash = Cache.generateHash(params);

  return keyCache.get(paramsHash);
}

Cache.prototype.body = function(key, params) {
  var paramsHash = Cache.generateHash(params);
  return this.loadFromCache(key, paramsHash).body;
}

Cache.generateHash = function(params) {
  return sha(JSON.stringify(params) || '');
};

module.exports = Cache;
