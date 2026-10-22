// E2E outbound mock (preload module).
//
// Intercepts the flow's Web Request POST to the Picallex preleads/label endpoint so
// the E2E suite NEVER hits production. It short-circuits matching axios requests with
// a canned 200 (no network call) — everything else passes through untouched.
//
// Enable it on the chatbot container (test-only):
//   NODE_OPTIONS=--require /usr/src/app/e2e/mock-outbound.js
//   MOCK_PRELEADS_LABEL=1
//   MOCK_OUTBOUND_MATCH=/whatsapp/preleads/label   (optional; default shown)
//
// Inert unless MOCK_PRELEADS_LABEL is truthy, so it is safe to leave preloaded.

if (/^(1|true|yes)$/i.test(process.env.MOCK_PRELEADS_LABEL || '')) {
  try {
    const axios = require('axios');
    const match = process.env.MOCK_OUTBOUND_MATCH || '/whatsapp/preleads/label';

    const labelOf = (cfg) => {
      try { const b = typeof cfg.data === 'string' ? JSON.parse(cfg.data) : cfg.data; return b && b.label_id; }
      catch { return undefined; }
    };

    axios.interceptors.request.use((config) => {
      const url = `${config.baseURL || ''}${config.url || ''}`;
      if (url.includes(match)) {
        // Replace the adapter for THIS request so no real network call is made.
        config.adapter = async (cfg) => ({
          data: { success: true, mocked: true, label_id: labelOf(cfg) },
          status: 200,
          statusText: 'OK (mocked-e2e)',
          headers: { 'x-mocked-by': 'e2e/mock-outbound' },
          config: cfg,
          request: {},
        });
        console.log(JSON.stringify({
          level: 'info',
          message: '[mock-outbound] intercepted (NO real POST): ' + url,
          method: (config.method || 'get').toUpperCase(),
          label_id: labelOf(config),
        }));
      }
      return config;
    });

    console.log(JSON.stringify({ level: 'info', message: `[mock-outbound] active — mocking outbound calls matching "${match}"` }));
  } catch (e) {
    console.log('[mock-outbound] could not install interceptor:', e && e.message);
  }
}
