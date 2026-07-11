import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FilterBar from '../components/FilterBar'

describe('FilterBar', () => {
  const schemes = [{ scheme_id: 'A' }, { scheme_id: 'B' }]
  const defaultFilters = { search: '', schemeId: null, risk: 'all', detectionStatus: null, sortBy: 'score_desc', page: 1, pageSize: 25 }

  it('renders and updates search', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<FilterBar filters={defaultFilters} schemes={schemes} resultCount={5} onChange={onChange} onClear={() => {}} />)

    const input = screen.getByPlaceholderText(/Search providers/i)
    await user.type(input, 'abc')
    expect(onChange).toHaveBeenCalled()
  })
})
