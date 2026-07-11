import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import AppRoot from '../AppRoot'

const sampleReport = { available: true, report: { schemes: [{ scheme_id: 'S1', provider_findings: [], member_findings: [] }] } }

beforeEach(() => {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(sampleReport) }))
})

test('AppRoot loads report and shows scheme', async () => {
  render(<AppRoot />)
  expect(screen.getByText(/Loading detection report/i)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText(/Network risk, surfaced/i)).toBeInTheDocument())
  // scheme label appears in multiple places (option, header, svg); assert at least one
  expect(screen.getAllByText('S1').length).toBeGreaterThan(0)
})
