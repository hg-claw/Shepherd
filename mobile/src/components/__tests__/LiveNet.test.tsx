import React from 'react'
import { render } from '@testing-library/react-native'
import { Text } from 'react-native'
import { LiveNet } from '../LiveNet'
jest.mock('@/api/wallLive', () => ({ useLiveNet: jest.fn() }))
import { useLiveNet } from '@/api/wallLive'

test('shows live value when present, else fallback', () => {
  ;(useLiveNet as jest.Mock).mockReturnValue({ rx_bps: 11, tx_bps: 22 })
  const a = render(<LiveNet id={1} fallbackRx={1} fallbackTx={2}>{(rx, tx) => <Text>{`${rx}/${tx}`}</Text>}</LiveNet>)
  expect(a.getByText('11/22')).toBeTruthy()
  ;(useLiveNet as jest.Mock).mockReturnValue(undefined)
  const b = render(<LiveNet id={1} fallbackRx={1} fallbackTx={2}>{(rx, tx) => <Text>{`${rx}/${tx}`}</Text>}</LiveNet>)
  expect(b.getByText('1/2')).toBeTruthy()
})
