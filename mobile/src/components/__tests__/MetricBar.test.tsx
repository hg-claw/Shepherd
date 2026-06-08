import React from 'react'
import { render } from '@testing-library/react-native'
import { MetricBar } from '../MetricBar'
test('renders percent and dash for null', () => {
  expect(render(<MetricBar label="CPU" value={42} />).getByText('42%')).toBeTruthy()
  expect(render(<MetricBar label="MEM" value={null} />).getByText('—')).toBeTruthy()
})
