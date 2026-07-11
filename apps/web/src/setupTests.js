import '@testing-library/jest-dom'

// simple global fetch mock can be overridden in tests
if (!global.fetch) {
  global.fetch = () => Promise.resolve({ ok: true, json: async () => ({ available: false, report: null }) })
}
