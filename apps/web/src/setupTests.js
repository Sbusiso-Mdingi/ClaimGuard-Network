import '@testing-library/jest-dom'

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
