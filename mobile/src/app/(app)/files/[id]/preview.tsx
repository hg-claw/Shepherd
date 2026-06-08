import { useEffect, useState } from 'react'
import { ScrollView, Text, View, ActivityIndicator } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { previewFile, type Preview as Prev } from '@/api/files'
import { theme } from '@/theme'
import { Screen } from '@/components/Screen'

export default function Preview() {
  const { id, path } = useLocalSearchParams<{ id: string; path: string }>()
  const [state, setState] = useState<{ loading: boolean; data?: Prev; error?: string }>({ loading: true })
  useEffect(() => {
    let live = true
    previewFile(Number(id), String(path))
      .then((d) => { if (live) setState({ loading: false, data: d }) })
      .catch((e) => { if (live) setState({ loading: false, error: e instanceof Error ? e.message : 'failed' }) })
    return () => { live = false }
  }, [id, path])

  if (state.loading) return <Screen><View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={theme.accent} /></View></Screen>
  if (state.error) return <Screen><View style={{ padding: theme.space(4) }}><Text style={{ color: theme.error }}>{state.error}</Text></View></Screen>
  if (state.data?.kind === 'binary') return <Screen><View style={{ padding: theme.space(4) }}><Text style={{ color: theme.textDim }}>Binary file — can&apos;t preview.</Text></View></Screen>
  const text = state.data?.kind === 'text' ? state.data.text : ''
  return (
    <Screen edges={['top']}>
      <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space(3) }}>
        <Text style={{ color: theme.text, fontFamily: 'monospace', fontSize: 12 }}>{text || '(empty)'}</Text>
      </ScrollView>
    </Screen>
  )
}
