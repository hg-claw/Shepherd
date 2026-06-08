// wsURL turns an https/http baseURL + a path into a wss/ws URL.
export function wsURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/^http/, 'ws')}${path}`
}
