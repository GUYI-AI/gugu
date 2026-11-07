import { ScheduledBand } from './frame'
import { mountComposerBandFrame } from './mount'

const host = document.querySelector<HTMLElement>('#fixture')!
const band = document.querySelector<HTMLSelectElement>('#band')!
const theme = document.querySelector<HTMLSelectElement>('#theme')!
const width = document.querySelector<HTMLSelectElement>('#width')!
const result = document.querySelector<HTMLElement>('#result')!
const fixture = mountComposerBandFrame(host)
let clicks = 0

function render() {
  const chosenTheme = theme.value === 'dark' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', chosenTheme)
  document.body.style.background = 'var(--bg)'
  document.body.style.color = 'var(--foreground)'
  host.style.width = `${width.value}px`
  fixture.render({ theme: chosenTheme, phone: width.value === '360',
    scheduled: band.value === 'schedule', band: band.value === 'schedule' ? <ScheduledBand /> : undefined,
    composerProps: band.value === 'queue' ? { isWorking: true,
      queuedPrompts: [{ id: 'controlled-layout-only', text: 'Controlled fixture queued input — no message will be sent', origin: 'typed' }],
      onEditQueuedPrompt: () => {}, onDeleteQueuedPrompt: () => {}, onReorderQueuedPrompts: () => {}, onSendQueuedPromptNow: () => {} } : undefined,
    onScrollToBottom: () => { result.textContent = `Recovery button clicks: ${++clicks}` } })
}

for (const control of [band, theme, width]) control.addEventListener('change', render)
window.addEventListener('pagehide', () => fixture.dispose(), { once: true })
render()
