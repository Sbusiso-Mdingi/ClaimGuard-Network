import React from 'react'
import { render, screen } from '@testing-library/react'
import DetailPanel from '../components/DetailPanel'

test('DetailPanel renders title and meta', () => {
  render(<DetailPanel title="T" meta="M"><div>content</div></DetailPanel>)
  expect(screen.getByText('T')).toBeInTheDocument()
  expect(screen.getByText('M')).toBeInTheDocument()
  expect(screen.getByText('content')).toBeInTheDocument()
})
