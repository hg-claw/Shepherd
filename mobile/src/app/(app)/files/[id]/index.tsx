import { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Alert, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router'
import { useDir, mkdir, renamePath, rmPath, type FileEntry } from '@/api/files'
import { useServer } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { joinPath, parentPath, crumbs } from '@/lib/paths'
import { cmpStr, bytes } from '@/lib/format'
import { useTheme } from '@/theme'
import { NavBar, List, ListRow, IconButton, Input, Button, ErrLine, Empty } from '@/components/ds'

type Form = { kind: 'mkdir'; value: string } | { kind: 'rename'; from: string; value: string }

export default function FileBrowser() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const sid = Number(id)
  const router = useRouter()
  const navigation = useNavigation()
  const t = useTheme()
  const [path, setPath] = useState('/')
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState(false)
  const [opError, setOpError] = useState<string | null>(null)
  const leavingRef = useRef(false)
  const q = useDir(sid, path)
  const host = nullStr(useServer(sid)?.public_alias)
  const entries = (q.data ?? []).slice().sort((a, b) => (a.is_dir === b.is_dir ? cmpStr(a.name, b.name) : a.is_dir ? -1 : 1))
  const cr = crumbs(path)

  // Hardware/gesture back walks up the directory tree instead of popping the
  // whole screen; the NavBar "Host" button sets leavingRef so it still pops.
  useEffect(() => {
    return navigation.addListener('beforeRemove', (e) => {
      if (leavingRef.current || path === '/') return
      e.preventDefault()
      setPath(parentPath(path))
    })
  }, [navigation, path])

  const cd = (next: string) => {
    setForm(null)
    setOpError(null)
    setPath(next)
  }

  const openEntry = (e: FileEntry) => {
    const full = joinPath(path, e.name)
    if (e.is_dir) cd(full)
    else router.push(`/(app)/files/${sid}/preview?path=${encodeURIComponent(full)}`)
  }

  const submitForm = async () => {
    if (!form || busy) return
    const name = form.value.trim()
    if (!name) return
    setBusy(true)
    setOpError(null)
    try {
      if (form.kind === 'mkdir') await mkdir(sid, joinPath(path, name))
      else await renamePath(sid, joinPath(path, form.from), joinPath(path, name))
      setForm(null)
      await q.refetch()
    } catch (e) {
      setOpError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const doRm = async (entry: FileEntry) => {
    if (busy) return
    setBusy(true)
    setOpError(null)
    try {
      await rmPath(sid, joinPath(path, entry.name), entry.is_dir)
      await q.refetch()
    } catch (e) {
      setOpError(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = (entry: FileEntry) => {
    Alert.alert(
      `Delete ${entry.name}?`,
      entry.is_dir ? 'Deletes this directory and everything inside it.' : 'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { void doRm(entry) } },
      ],
    )
  }

  const rowActions = (entry: FileEntry) => {
    if (busy) return
    Alert.alert(entry.name, undefined, [
      { text: 'Rename', onPress: () => { setOpError(null); setForm({ kind: 'rename', from: entry.name, value: entry.name }) } },
      { text: 'Delete', style: 'destructive', onPress: () => confirmDelete(entry) },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const moreBtn = (entry: FileEntry) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Actions for ${entry.name}`}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      onPress={() => rowActions(entry)}
      style={({ pressed }) => ({
        width: 32, height: 32, borderRadius: t.radius, alignItems: 'center', justifyContent: 'center',
        backgroundColor: pressed ? t.sunken : 'transparent',
      })}
    >
      <Text style={{ fontFamily: t.mono(), fontSize: 16, lineHeight: 20, color: t.muted }}>{'⋯'}</Text>
    </Pressable>
  )

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar
        title={host ? `files · ${host}` : 'Files'}
        backLabel="Host"
        onBack={() => { leavingRef.current = true; router.back() }}
        actions={
          <IconButton
            name="plus"
            accessibilityLabel="New folder"
            onPress={() => { setOpError(null); setForm((f) => (f?.kind === 'mkdir' ? null : { kind: 'mkdir', value: '' })) }}
          />
        }
      />

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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Go to ${c.path}`}
                disabled={cur}
                onPress={() => cd(c.path)}
                hitSlop={{ top: 14, bottom: 14, left: 4, right: 4 }}
              >
                <Text style={{ fontFamily: t.mono(), fontSize: 12.5, paddingHorizontal: 2, color: cur ? t.muted : t.primary }}>
                  {c.label === '/' ? '/' : c.label}
                </Text>
              </Pressable>
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
          {form ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Input
                mono
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1 }}
                value={form.value}
                placeholder={form.kind === 'mkdir' ? 'new folder name' : 'new name'}
                onChangeText={(v) => setForm({ ...form, value: v })}
                onSubmitEditing={() => { void submitForm() }}
              />
              <Button onPress={() => { void submitForm() }} disabled={busy || !form.value.trim()}>
                {form.kind === 'mkdir' ? 'Create' : 'Rename'}
              </Button>
              <IconButton name="x" accessibilityLabel="Cancel" onPress={() => { setForm(null); setOpError(null) }} />
            </View>
          ) : null}
          {opError ? (
            <View style={{ marginBottom: 12 }}>
              <ErrLine>{opError}</ErrLine>
            </View>
          ) : null}

          {entries.length === 0 && path === '/' ? (
            <Empty>Empty directory.</Empty>
          ) : (
            <>
              <List>
                {path !== '/' ? (
                  <ListRow icon="corner-left-up" title=".." mono chevron={false} onPress={() => cd(parentPath(path))} />
                ) : null}
                {entries.map((e) =>
                  e.is_dir ? (
                    <ListRow
                      key={e.name}
                      icon="folder"
                      iconColor={t.primary}
                      title={<Text style={{ color: t.primary }}>{`${e.name}/`}</Text>}
                      mono
                      right={moreBtn(e)}
                      onPress={() => openEntry(e)}
                    />
                  ) : (
                    <ListRow
                      key={e.name}
                      icon="file"
                      title={e.name}
                      detail={bytes(e.size)}
                      mono
                      chevron={false}
                      right={moreBtn(e)}
                      onPress={() => openEntry(e)}
                    />
                  ),
                )}
              </List>
              {entries.length === 0 ? <Empty>Empty directory.</Empty> : null}
            </>
          )}
          <Text style={{ textAlign: 'center', fontFamily: t.mono(), fontSize: 11, color: t.fgDim, paddingTop: 12 }}>
            audit-logged
          </Text>
        </ScrollView>
      )}
    </View>
  )
}
