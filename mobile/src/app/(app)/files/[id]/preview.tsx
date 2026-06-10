import { useEffect, useState } from 'react'
import { ScrollView, Text, View, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { previewFile, PREVIEW_MAX_BYTES, type Preview as Prev } from '@/api/files'
import { useTheme } from '@/theme'
import { NavBar, Pill, Empty } from '@/components/ds'

export default function Preview() {
  const { id, path } = useLocalSearchParams<{ id: string; path: string }>()
  const router = useRouter()
  const t = useTheme()
  const name = String(path).split('/').filter(Boolean).pop() ?? String(path)
  const [state, setState] = useState<{ loading: boolean; data?: Prev; error?: string }>({ loading: true })
  // The preview endpoint caps reads at PREVIEW_MAX_BYTES; content at the cap was cut off.
  const truncated = state.data?.kind === 'text' && state.data.text.length >= PREVIEW_MAX_BYTES

  useEffect(() => {
    let live = true
    previewFile(Number(id), String(path))
      .then((d) => { if (live) setState({ loading: false, data: d }) })
      .catch((e) => { if (live) setState({ loading: false, error: e instanceof Error ? e.message : 'failed' }) })
    return () => { live = false }
  }, [id, path])

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title={name} backLabel="Files" onBack={() => router.back()} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 44, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim }}>
            {String(path)}
          </Text>
          <Pill kind="neutral">read-only</Pill>
        </View>

        {state.loading ? (
          <View style={{ paddingTop: t.space(8), alignItems: 'center' }}>
            <ActivityIndicator color={t.primary} />
          </View>
        ) : state.error ? (
          <Text style={{ color: t.error, fontFamily: t.mono(), fontSize: 12 }}>{state.error}</Text>
        ) : state.data?.kind === 'binary' ? (
          <Empty>Binary file — preview unavailable.</Empty>
        ) : (
          <>
            {truncated ? (
              <View style={{ backgroundColor: t.warnSoft, borderRadius: t.radius, paddingHorizontal: 12, paddingVertical: 8 }}>
                <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.warn }}>Preview truncated at 64 KB.</Text>
              </View>
            ) : null}
            <ScrollView
              horizontal
              style={{
                backgroundColor: t.sunken, borderWidth: 1, borderColor: t.border, borderRadius: t.radius,
              }}
              contentContainerStyle={{ padding: 14 }}
            >
              <Text style={{ fontFamily: t.mono(), fontSize: 12, lineHeight: 18.6, color: t.text }}>
                {state.data?.kind === 'text' ? state.data.text || '(empty)' : ''}
              </Text>
            </ScrollView>
          </>
        )}
      </ScrollView>
    </View>
  )
}
