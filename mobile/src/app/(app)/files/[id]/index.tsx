import { useState } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useDir, type FileEntry } from '@/api/files'
import { useServer } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { joinPath, parentPath, crumbs } from '@/lib/paths'
import { cmpStr } from '@/lib/format'
import { useTheme } from '@/theme'
import { NavBar, List, ListRow, Icon } from '@/components/ds'

export default function FileBrowser() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const sid = Number(id)
  const router = useRouter()
  const t = useTheme()
  const [path, setPath] = useState('/')
  const q = useDir(sid, path)
  const host = nullStr(useServer(sid)?.public_alias)
  const entries = (q.data ?? []).slice().sort((a, b) => (a.is_dir === b.is_dir ? cmpStr(a.name, b.name) : a.is_dir ? -1 : 1))
  const cr = crumbs(path)

  const openEntry = (e: FileEntry) => {
    const full = joinPath(path, e.name)
    if (e.is_dir) setPath(full)
    else router.push(`/(app)/files/${sid}/preview?path=${encodeURIComponent(full)}`)
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar title={host ? `files · ${host}` : 'Files'} backLabel="Host" onBack={() => router.back()} />

      <View
        style={{
          flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 2,
          paddingHorizontal: 14, paddingVertical: 10,
          backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border,
        }}
      >
        {cr.map((c, i) => {
          const cur = i === cr.length - 1
          return (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text
                onPress={() => setPath(c.path)}
                style={{ fontFamily: t.mono(), fontSize: 12.5, paddingHorizontal: 2, color: cur ? t.muted : t.primary }}
              >
                {c.label === '/' ? '/' : c.label}
              </Text>
              {i < cr.length - 1 && i > 0 ? (
                <Text style={{ fontFamily: t.mono(), fontSize: 12.5, color: t.fgDim }}>/</Text>
              ) : null}
            </View>
          )
        })}
      </View>

      {q.isLoading ? (
        <ActivityIndicator color={t.primary} style={{ marginTop: t.space(8) }} />
      ) : q.isError ? (
        <Text style={{ color: t.error, padding: t.space(4) }}>
          {q.error instanceof Error ? q.error.message : 'failed'}
        </Text>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, paddingBottom: 44 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={t.primary} />}
        >
          {entries.length === 0 && path === '/' ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.fgDim }}>Empty directory.</Text>
            </View>
          ) : (
            <List>
              {path !== '/' ? (
                <ListRow icon="corner-left-up" title=".." mono chevron={false} onPress={() => setPath(parentPath(path))} />
              ) : null}
              {entries.map((e) =>
                e.is_dir ? (
                  <ListRow
                    key={e.name}
                    icon="folder"
                    iconColor={t.primary}
                    title={<Text style={{ color: t.primary }}>{`${e.name}/`}</Text>}
                    mono
                    onPress={() => openEntry(e)}
                  />
                ) : (
                  <ListRow
                    key={e.name}
                    icon="file"
                    title={e.name}
                    detail={`${e.size} B`}
                    mono
                    chevron={false}
                    onPress={() => openEntry(e)}
                  />
                ),
              )}
            </List>
          )}
          <Text style={{ textAlign: 'center', fontFamily: t.mono(), fontSize: 11, color: t.fgDim, paddingTop: 12 }}>
            read-only · audit-logged
          </Text>
        </ScrollView>
      )}
    </View>
  )
}
