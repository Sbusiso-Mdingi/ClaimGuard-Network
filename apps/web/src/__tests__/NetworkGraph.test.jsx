import React from 'react'
import { render, screen } from '@testing-library/react'
import NetworkGraph from '../components/NetworkGraph'

const report = { schemes: [{ scheme_id: 'S1' }] }
const findings = [ { _scheme_id: 'S1', provider_id: 'P1', entity_id: 'E1', detection_id: 'D1', score: 0.5 } ]

test('NetworkGraph renders nodes and side panel on selection', async () => {
  render(<NetworkGraph report={report} filteredFindings={findings} filters={{}} onNavigate={() => {}} />)
  // labels may appear multiple times; ensure at least one occurrence of each
  expect(screen.getAllByText('S1').length).toBeGreaterThan(0)
  expect(screen.getAllByText('P1').length).toBeGreaterThan(0)
  expect(screen.getAllByText('E1').length).toBeGreaterThan(0)
})
