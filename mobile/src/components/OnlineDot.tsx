import { View } from 'react-native'
import { theme } from '@/theme'

export function OnlineDot({ online }: { online: boolean }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? '#4ade80' : theme.textDim }} />
}
