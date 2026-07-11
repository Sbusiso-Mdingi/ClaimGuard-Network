import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PaginatedList from '../components/PaginatedList'

describe('PaginatedList', () => {
  const items = Array.from({ length: 45 }, (_, i) => `item-${i}`)

  it('renders page and navigates', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    render(<PaginatedList items={items} page={1} pageSize={10} onPageChange={onPageChange} renderItem={(it) => <div key={it}>{it}</div>} />)

    expect(screen.getByText('Page 1 / 5')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Next page'))
    expect(onPageChange).toHaveBeenCalled()
  })
})
