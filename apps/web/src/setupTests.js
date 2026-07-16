import '@testing-library/jest-dom'

window.__CLAIMGUARD_AUTHENTICATION_MODE__ = "demo_headers"
window.__CLAIMGUARD_ORGANISATION_URL_SCHEME__ = "https"
window.__CLAIMGUARD_ORGANISATION_HOST__ = "claimguard.test"

// simple global fetch mock can be overridden in tests
if (!global.fetch) {
  global.fetch = () => Promise.resolve({ ok: true, json: async () => ({ available: false, report: null }) })
}

// ResizeObserver polyfill for ReactFlow (not available in jsdom)
if (!global.ResizeObserver) {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
