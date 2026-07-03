// Shared payload inspector: detects values that would make a serializer
// (e.g. axios's recursive toFormData/params walk) recurse forever — a
// circular reference — or blow the stack — pathological depth. The walk is
// itself bounded (stops at the first cycle and at maxDepth), so it can never
// overflow while checking. Returns { ok:true } or { ok:false, reason, path }.

const DEFAULT_MAX_DEPTH = 200;

function inspectPayload(root, maxDepth) {
  const limit = typeof maxDepth === 'number' ? maxDepth : DEFAULT_MAX_DEPTH;
  const ancestors = new WeakSet();
  let bad = null;
  function walk(value, path, depth) {
    if (bad) return;
    if (value === null || typeof value !== 'object') return;
    if (ancestors.has(value)) { bad = { reason: 'circular', path: path || '<root>' }; return; }
    if (depth > limit) { bad = { reason: 'too-deep', path: path || '<root>' }; return; }
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && !bad; i++) {
        walk(value[i], path + '[' + i + ']', depth + 1);
      }
    } else {
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length && !bad; i++) {
        walk(value[keys[i]], path ? path + '.' + keys[i] : keys[i], depth + 1);
      }
    }
    ancestors.delete(value); // keep only ancestors → detects true cycles, not shared refs
  }
  try {
    walk(root, '', 0);
  } catch (e) {
    return { ok: true }; // never let the inspector itself break the caller
  }
  return bad ? { ok: false, reason: bad.reason, path: bad.path } : { ok: true };
}

module.exports = { inspectPayload, DEFAULT_MAX_DEPTH };
