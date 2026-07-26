import { test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Table, TableBody, TableEmpty } from './table'

test('Table wraps in horizontal-scroll surface', () => {
  const { container } = render(<Table data-testid="t"><TableBody /></Table>)
  const wrapper = container.firstElementChild!
  expect(wrapper.className).toContain('overflow-x-auto')
  expect(wrapper.className).toContain('bg-elev')
})

test('TableEmpty renders spanning placeholder row', () => {
  render(
    <table><tbody><TableEmpty colSpan={5}>nothing here</TableEmpty></tbody></table>,
  )
  const cell = screen.getByText('nothing here')
  expect(cell).toHaveAttribute('colspan', '5')
  expect(cell.className).toContain('py-6')
})
