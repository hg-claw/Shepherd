import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import { ThemeProvider } from '@/theme'
import { AreaChart, chartGeometry, normalizeSeries } from '../AreaChart'

function wrap(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>)
}

test('normalizeSeries accepts numbers and {x,y} points, nulls non-finite', () => {
  expect(normalizeSeries([1, null, undefined, NaN, 2])).toEqual([1, null, null, null, 2])
  expect(normalizeSeries([{ x: 0, y: 5 }, { x: 1, y: null }])).toEqual([5, null])
})

test('chartGeometry scales values into line + area paths', () => {
  const g = chartGeometry([0, 50, 100], 100, 60, 0)
  expect(g).not.toBeNull()
  expect(g!.min).toBe(0)
  expect(g!.max).toBe(100)
  expect(g!.last).toBe(100)
  // min maps to the bottom (y=60), max to the top (y=0), midpoint between
  expect(g!.line).toBe('M0.0 60.0 L50.0 30.0 L100.0 0.0')
  expect(g!.area).toContain('Z')
})

test('chartGeometry splits null gaps into segments', () => {
  const g = chartGeometry([0, 100, null, 100, 0], 100, 60, 0)
  expect(g!.line.match(/M/g)).toHaveLength(2)
})

test('chartGeometry handles flat and empty series', () => {
  const flat = chartGeometry([5, 5, 5], 100, 60)
  expect(flat!.line).toContain('30.0') // flat line at mid-height
  expect(chartGeometry([], 100, 60)).toBeNull()
  expect(chartGeometry([null, null], 100, 60)).toBeNull()
})

test('AreaChart renders min/max labels once laid out', () => {
  const { getByTestId, getByText } = wrap(
    <AreaChart testID="chart" data={[10, 90]} height={56} format={(v) => `${v}%`} />,
  )
  fireEvent(getByTestId('chart'), 'layout', { nativeEvent: { layout: { width: 200, height: 56 } } })
  expect(getByText('90%')).toBeTruthy()
  expect(getByText('10%')).toBeTruthy()
})

test('AreaChart shows "no data" for empty or all-null data', () => {
  expect(wrap(<AreaChart data={[]} />).getByText('no data')).toBeTruthy()
  expect(wrap(<AreaChart data={[null, null]} />).getByText('no data')).toBeTruthy()
})
