import { useState } from 'react'
import { View, Text, Pressable, FlatList, RefreshControl, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useDir, type FileEntry } from '@/api/files'
import { joinPath, parentPath, crumbs } from '@/lib/paths'
import { theme } from '@/theme'

export default function FileBrowser() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const sid = Number(id)
  const router = useRouter()
  const [path, setPath] = useState('/')
  const q = useDir(sid, path)
  const entries = (q.data ?? []).slice().sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1))

  const openEntry = (e: FileEntry) => {
    const full = joinPath(path, e.name)
    if (e.is_dir) setPath(full)
    else router.push(`/(app)/files/${sid}/preview?path=${encodeURIComponent(full)}`)
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: theme.space(2), borderBottomWidth: 1, borderColor: theme.border }}>
        {crumbs(path).map((c, i) => (
          <Pressable key={i} onPress={() => setPath(c.path)}><Text style={{ color: theme.accent, fontFamily: 'monospace' }}>{c.label === '/' ? '/' : `${c.label}/`}</Text></Pressable>
        ))}
      </View>
      {q.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : q.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>{q.error instanceof Error ? q.error.message : 'failed'}</Text>
        : <FlatList
            data={entries}
            keyExtractor={(e) => e.name}
            ListHeaderComponent={path !== '/' ? <Pressable onPress={() => setPath(parentPath(path))} style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}><Text style={{ color: theme.textDim }}>..</Text></Pressable> : null}
            renderItem={({ item }) => (
              <Pressable onPress={() => openEntry(item)} style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
                <Text style={{ color: item.is_dir ? theme.accent : theme.text, flex: 1, fontFamily: 'monospace' }}>{item.is_dir ? `${item.name}/` : item.name}</Text>
                {!item.is_dir ? <Text style={{ color: theme.textDim, fontSize: 12 }}>{item.size}B</Text> : null}
              </Pressable>
            )}
            refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={theme.accent} />}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>Empty.</Text>}
          />}
    </View>
  )
}
