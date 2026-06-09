import React from 'react'
import { View, Text, TextInput, type TextInputProps } from 'react-native'
import { useTheme } from '@/theme'

// .label: 12.5/500; .req is err-colored.
export function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  const t = useTheme()
  return (
    <Text style={{ fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>
      {children}
      {required ? <Text style={{ color: t.err }}> *</Text> : null}
    </Text>
  )
}

// .hint: mono 11.5 fg-dim.
export function Hint({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  return <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim }}>{children}</Text>
}

// .err-line: mono 12.5 err.
export function ErrLine({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  return <Text style={{ fontFamily: t.mono(), fontSize: 12.5, color: t.err }}>{children}</Text>
}

// .field: column gap 6.
export function Field({ label, required, children }: {
  label?: React.ReactNode; required?: boolean; children: React.ReactNode
}) {
  return (
    <View style={{ gap: 6 }}>
      {label != null ? <Label required={required}>{label}</Label> : null}
      {children}
    </View>
  )
}

// .input: h44, pad 0/13, bg-elev, border input, radius, md. mono optional. placeholder fg-dim.
export function Input({ mono, style, ...props }: TextInputProps & { mono?: boolean }) {
  const t = useTheme()
  return (
    <TextInput
      placeholderTextColor={t.fgDim}
      {...props}
      style={[
        {
          height: 44, paddingHorizontal: 13, color: t.text,
          backgroundColor: t.surface, borderWidth: 1, borderColor: t.input, borderRadius: t.radius,
          fontSize: t.fs.md, fontFamily: mono ? t.mono() : t.font(),
        },
        style,
      ]}
    />
  )
}
