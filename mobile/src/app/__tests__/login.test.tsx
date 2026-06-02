import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import LoginScreen from '../(auth)/login'
import { useAuth } from '@/store/auth'

test('submitting calls store.login with entered values', () => {
  const login = jest.fn()
  useAuth.setState({ status: 'signedOut', baseURL: null, token: null, admin: null, error: null, login } as never)
  const { getByPlaceholderText, getByText } = render(<LoginScreen />)
  fireEvent.changeText(getByPlaceholderText('https://your-server'), 'https://h')
  fireEvent.changeText(getByPlaceholderText('username'), 'alice')
  fireEvent.changeText(getByPlaceholderText('password'), 'pw')
  fireEvent.press(getByText('Sign in'))
  expect(login).toHaveBeenCalledWith('https://h', 'alice', 'pw')
})
