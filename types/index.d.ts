export type Note = { text: string } | null
export type Confirm = { number: number; action: 'hecho' | 'descartar' }

declare module 'claude-code' {
  interface PluginState {
    pendientes: { note: Note; confirm: Confirm | null; draft: string; showClosed: boolean }
  }
}
