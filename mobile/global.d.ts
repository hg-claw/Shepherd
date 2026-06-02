// CSS module declarations for web bundler
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

// Side-effect CSS imports (e.g. NativeWind / global styles)
declare module '*.css' {}
