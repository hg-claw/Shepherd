import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useScripts, type Script } from '@/api/scripts'
import { useTheme } from '@/theme'
import { NavBar, List, Icon, Empty } from '@/components/ds'

function ScriptRow({ script, onPress }: { script: Script; onPress: () => void }) {
  const t = useTheme()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12,
        minHeight: 52, paddingVertical: 10, paddingHorizontal: 14,
        backgroundColor: pressed ? t.sunken : 'transparent',
      })}
    >
      <View style={{ width: 30, height: 30, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: t.sunken }}>
        <Icon name="scroll-text" size={16} color={t.muted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: t.mono(500), fontSize: t.fs.md, color: t.text }}>
          {script.name}
        </Text>
        {script.description ? (
          <Text numberOfLines={1} style={{ fontFamily: t.font(), fontSize: 12, color: t.muted, marginTop: 2 }}>
            {script.description}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-right" size={16} color={t.fgDim} />
    </Pressable>
  )
}

export default function ScriptsList() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>()
  const router = useRouter()
  const t = useTheme()
  const q = useScripts()
  const scripts = q.data ?? []

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title="Scripts" backLabel="Host" onBack={() => router.back()} />

      {q.isLoading ? (
        <ActivityIndicator color={t.primary} style={{ marginTop: t.space(8) }} />
      ) : q.isError ? (
        <Text style={{ color: t.error, padding: t.space(4) }}>failed to load scripts</Text>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 44, gap: 12 }}>
          {serverId ? (
            <Text style={{ fontFamily: t.font(), fontSize: 12.5, color: t.muted }}>
              Target: <Text style={{ fontFamily: t.mono() }}>{serverId}</Text>
            </Text>
          ) : null}

          {scripts.length === 0 ? (
            <Empty>No scripts.</Empty>
          ) : (
            <List>
              {scripts.map((s) => (
                <ScriptRow
                  key={s.id}
                  script={s}
                  onPress={() => router.push(`/(app)/scripts/${s.id}?serverId=${serverId}`)}
                />
              ))}
            </List>
          )}
        </ScrollView>
      )}
    </View>
  )
}
