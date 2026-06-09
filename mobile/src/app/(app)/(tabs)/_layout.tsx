import { Tabs } from 'expo-router'
import { TabBar } from '@/components/ds'

export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <TabBar {...(props as unknown as React.ComponentProps<typeof TabBar>)} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="plugins" />
      <Tabs.Screen name="settings" />
    </Tabs>
  )
}
