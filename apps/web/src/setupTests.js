import '@testing-library/jest-dom'
import { configure } from '@testing-library/dom'

configure({ asyncUtilTimeout: 5_000 })

window.__CLAIMGUARD_ORGANISATION_URL_SCHEME__ = "https"
window.__CLAIMGUARD_ORGANISATION_HOST__ = "claimguard.test"

if (!global.fetch) {
  global.fetch = () => Promise.resolve({ ok: true, json: async () => ({ available: false, report: null }) })
}

if (!global.ResizeObserver) {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
