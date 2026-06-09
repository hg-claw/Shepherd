import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import { ThemeProvider } from '@/theme'
import { Pill, MetricBar, Kpi, Button, ListRow, Switch } from '../index'
import { statusOf, barKind } from '../helpers'

function wrap(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>)
}

test('Pill renders its label', () => {
  const { getByText } = wrap(<Pill kind="ok">healthy</Pill>)
  expect(getByText('healthy')).toBeTruthy()
})

test('MetricBar shows percent, and em-dash for null', () => {
  const a = wrap(<MetricBar label="cpu" value={42} />)
  expect(a.getByText('42%')).toBeTruthy()
  const b = wrap(<MetricBar label="cpu" value={null} />)
  expect(b.getByText('—')).toBeTruthy()
})

test('Kpi shows label, value and sub', () => {
  const { getByText } = wrap(<Kpi label="hosts" value="12" sub="online" tone="ok" />)
  expect(getByText('hosts')).toBeTruthy()
  expect(getByText('12')).toBeTruthy()
  expect(getByText('online')).toBeTruthy()
})

test('Button fires onPress', () => {
  const onPress = jest.fn()
  const { getByText } = wrap(<Button onPress={onPress}>Deploy</Button>)
  fireEvent.press(getByText('Deploy'))
  expect(onPress).toHaveBeenCalledTimes(1)
})

test('ListRow renders title and detail', () => {
  const { getByText } = wrap(<ListRow icon="server" title="node-1" detail="1.2.3.4" />)
  expect(getByText('node-1')).toBeTruthy()
  expect(getByText('1.2.3.4')).toBeTruthy()
})

test('Switch toggles via onChange', () => {
  const onChange = jest.fn()
  const { getByRole } = wrap(<Switch on={false} onChange={onChange} />)
  fireEvent.press(getByRole('switch'))
  expect(onChange).toHaveBeenCalledWith(true)
})

test('statusOf / barKind helpers', () => {
  expect(statusOf({ online: false, cpu: 0, mem: 0, disk: 0 })).toEqual({ kind: 'neutral', label: 'offline' })
  expect(statusOf({ online: true, cpu: 95, mem: 10, disk: 10 }).kind).toBe('err')
  expect(statusOf({ online: true, cpu: 85, mem: 10, disk: 10 }).kind).toBe('warn')
  expect(statusOf({ online: true, cpu: 10, mem: 10, disk: 10 }).kind).toBe('ok')
  expect(barKind(null)).toBe('')
  expect(barKind(80)).toBe('warn')
  expect(barKind(92)).toBe('err')
})
