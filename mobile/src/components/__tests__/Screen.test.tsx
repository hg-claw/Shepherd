import React from 'react'
import { render } from '@testing-library/react-native'
import { Text } from 'react-native'
import { Screen } from '../Screen'
test('renders children', () => {
  expect(render(<Screen><Text>hi</Text></Screen>).getByText('hi')).toBeTruthy()
})
