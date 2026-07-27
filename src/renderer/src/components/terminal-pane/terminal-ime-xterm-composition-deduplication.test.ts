// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(screenReaderMode = false): {
  emitted: string[]
  terminal: Terminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ screenReaderMode })
  terminal.open(container)
  const textarea = terminal.textarea
  if (!textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, textarea }
}

function dispatchCompositionEvent(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data: string = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  // happy-dom ignores CompositionEventInit.data, but Chromium supplies it.
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

function startComposition(textarea: HTMLTextAreaElement, text: string): void {
  dispatchCompositionEvent(textarea, 'compositionstart')
  dispatchCompositionEvent(textarea, 'compositionupdate', text)
  textarea.value = text
}

function dispatchKeydown(
  textarea: HTMLTextAreaElement,
  key: string,
  code: string,
  keyCode: number
): void {
  const keydown = new KeyboardEvent('keydown', { key, code, bubbles: true })
  Object.defineProperty(keydown, 'keyCode', { value: keyCode })
  textarea.dispatchEvent(keydown)
}

function dispatchComposedInput(textarea: HTMLTextAreaElement, init: InputEventInit): void {
  const input = new InputEvent('input', { ...init, bubbles: true })
  // happy-dom ignores InputEventInit.composed, but Chromium reports it for this IBus path.
  Object.defineProperty(input, 'composed', { value: true })
  textarea.dispatchEvent(input)
}

function typeObservedAscii(textarea: HTMLTextAreaElement, text: string): void {
  for (const character of text) {
    dispatchKeydown(textarea, character, `Key${character.toUpperCase()}`, character.charCodeAt(0))
    textarea.value += character
    dispatchComposedInput(textarea, { data: character, inputType: 'insertText' })
  }
}

function updateObservedIbusComposition(
  textarea: HTMLTextAreaElement,
  prefix: string,
  text: string
): void {
  dispatchCompositionEvent(textarea, 'compositionupdate', text)
  textarea.value = `${prefix}${text}`
  dispatchComposedInput(textarea, { data: text, inputType: 'insertCompositionText' })
}

function startObservedIbusComposition(textarea: HTMLTextAreaElement, text: string): string {
  const prefix = textarea.value
  textarea.setSelectionRange(prefix.length, prefix.length)
  dispatchCompositionEvent(textarea, 'compositionstart')
  dispatchKeydown(textarea, 'Process', 'KeyG', 229)
  updateObservedIbusComposition(textarea, prefix, text)
  return prefix
}

function endObservedIbusComposition(textarea: HTMLTextAreaElement, prefix: string): void {
  dispatchCompositionEvent(textarea, 'compositionupdate')
  textarea.value = prefix
  dispatchComposedInput(textarea, { inputType: 'deleteContentBackward' })
  dispatchCompositionEvent(textarea, 'compositionend')
}

function commitObservedIbusComposition(
  textarea: HTMLTextAreaElement,
  prefix: string,
  text: string
): void {
  endObservedIbusComposition(textarea, prefix)
  textarea.value = `${prefix}${text}`
  dispatchComposedInput(textarea, { data: text, inputType: 'insertText' })
}

function typeObservedIbusCommit(textarea: HTMLTextAreaElement, text: string): void {
  const prefix = startObservedIbusComposition(textarea, text)
  commitObservedIbusComposition(textarea, prefix, text)
}

function typeObservedIbusKeypressCommit(textarea: HTMLTextAreaElement, text: string): void {
  const prefix = startObservedIbusComposition(textarea, text)
  endObservedIbusComposition(textarea, prefix)
  dispatchKeypress(textarea, text)
  textarea.value = `${prefix}${text}`
  dispatchComposedInput(textarea, { data: text, inputType: 'insertText' })
}

function dispatchKeypress(textarea: HTMLTextAreaElement, text: string): void {
  const keypress = new KeyboardEvent('keypress', { key: text, bubbles: true })
  // happy-dom omits Chromium's legacy charCode field that xterm still reads.
  Object.defineProperty(keypress, 'charCode', { value: text.charCodeAt(0) })
  textarea.dispatchEvent(keypress)
}

describe('xterm IME composition de-duplication', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('emits a propagated IBus Hangul commit exactly once', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    typeObservedIbusCommit(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('does not drop an unpropagated IBus commit before the following keydown', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    dispatchKeydown(textarea, 'a', 'KeyA', 65)
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
  })

  it('preserves mixed Hangul ASCII Hangul input', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    typeObservedIbusCommit(textarea, '한')
    typeObservedAscii(textarea, 'abc')
    typeObservedIbusCommit(textarea, '글')
    dispatchKeydown(textarea, 'Enter', 'Enter', 13)
    await nextEventLoop()

    expect(emitted.join('')).toBe('한abc글\r')
    terminal.dispose()
  })

  it('preserves a Korean final-consonant transfer across compositions', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, 'ㅇ')
    updateObservedIbusComposition(textarea, '', '아')
    updateObservedIbusComposition(textarea, '', '앙')
    dispatchCompositionEvent(textarea, 'compositionend', '앙')
    textarea.setSelectionRange(1, 1)
    dispatchCompositionEvent(textarea, 'compositionstart')
    updateObservedIbusComposition(textarea, '아', '아')
    dispatchCompositionEvent(textarea, 'compositionend', '아')
    await nextEventLoop()

    expect(emitted.join('')).toBe('아아')
    terminal.dispose()
  })

  it('does not let stale timers leak across composition transactions', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '테')
    dispatchCompositionEvent(textarea, 'compositionend', '테')
    dispatchKeydown(textarea, 'a', 'KeyA', 65)
    dispatchKeydown(textarea, 'Process', 'KeyR', 229)
    textarea.setSelectionRange(1, 1)
    dispatchCompositionEvent(textarea, 'compositionstart')
    updateObservedIbusComposition(textarea, '테', '스')
    commitObservedIbusComposition(textarea, '테', '스')
    dispatchKeydown(textarea, 'Enter', 'Enter', 13)
    await nextEventLoop()

    expect(emitted.join('')).toBe('테a스\r')
    terminal.dispose()
  })

  it('keeps a deferred composition update scoped to its transaction', async () => {
    const { terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    dispatchComposedInput(textarea, { data: '한', inputType: 'insertText' })
    textarea.setSelectionRange(1, 1)
    dispatchCompositionEvent(textarea, 'compositionstart')
    textarea.value = '한글'
    textarea.setSelectionRange(2, 2)
    await nextEventLoop()

    const compositionPosition = (
      terminal as unknown as {
        _core: { _compositionHelper: { _compositionPosition: { start: number; end: number } } }
      }
    )._core._compositionHelper._compositionPosition
    expect(compositionPosition).toEqual({ start: 1, end: 1 })
    dispatchCompositionEvent(textarea, 'compositionend', '글')
    await nextEventLoop()
    terminal.dispose()
  })

  it('preserves a retained commit before a no-keydown text insertion', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    textarea.value = '한x'
    dispatchComposedInput(textarea, { data: 'x', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('한x')
    terminal.dispose()
  })

  it('keeps screen-reader trailing text outside an authoritative commit', async () => {
    const { emitted, terminal, textarea } = openTerminal(true)

    textarea.value = '一二'
    textarea.setSelectionRange(1, 1)
    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', '一')
    textarea.value = '一一二'
    textarea.setSelectionRange(2, 2)
    dispatchCompositionEvent(textarea, 'compositionend', '一')
    dispatchComposedInput(textarea, { data: '一', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('一')
    terminal.dispose()
  })

  it('flushes an unpropagated Hangul commit before Enter', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    dispatchKeydown(textarea, 'Enter', 'Enter', 13)
    await nextEventLoop()

    expect(emitted.join('')).toBe('한\r')
    terminal.dispose()
  })

  it('deduplicates each commit without suppressing a legitimate repeated syllable', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    typeObservedIbusKeypressCommit(textarea, '가')
    typeObservedIbusKeypressCommit(textarea, '가')
    dispatchKeydown(textarea, 'Enter', 'Enter', 13)
    await nextEventLoop()

    expect(emitted.join('')).toBe('가가\r')
    terminal.dispose()
  })

  it('emits a post-composition IBus Hangul keypress only once', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    // Why: IBus clears at compositionend, then restores the same commit after
    // xterm's keypress path has already emitted it.
    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    const compositionHelper = (
      terminal as unknown as {
        _core: {
          _compositionHelper: {
            _pendingCompositionFinalizations: { keypressData: string }[]
          }
        }
      }
    )._core._compositionHelper
    expect(compositionHelper._pendingCompositionFinalizations).toHaveLength(1)
    dispatchKeypress(textarea, '한')
    expect(compositionHelper._pendingCompositionFinalizations[0].keypressData).toBe('한')
    expect(emitted).toEqual([])
    textarea.value = '한'
    textarea.dispatchEvent(
      new InputEvent('input', { data: '한', inputType: 'insertText', bubbles: true })
    )
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('preserves composition-first order when keypress overlaps its suffix', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '가한')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('가한')
    terminal.dispose()
  })

  it('emits unmatched keypress before propagated composition text', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionupdate', 'a')
    textarea.value = 'a'
    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
  })

  it('does not repeat keypress contained before propagated composition text', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionupdate', '한a')
    textarea.value = '한a'
    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
  })

  it('merges multiple deferred keypresses with partial textarea overlap', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, 'a')
    dispatchKeypress(textarea, 'b')
    textarea.value = '한a'
    await nextEventLoop()

    expect(emitted.join('')).toBe('한ab')
    terminal.dispose()
  })

  it('reconciles buffered keypress before immediate keydown finalization', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, '한')
    textarea.value = '한'
    const keydown = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true })
    Object.defineProperty(keydown, 'keyCode', { value: 65 })
    textarea.dispatchEvent(keydown)
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
  })
})
