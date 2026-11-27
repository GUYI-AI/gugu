import { describe, expect, it } from 'vitest'
import { localeReadLines } from '../../../scripts/checks/locale-reads-in-memo.mts'

/**
 * @@@locale-input: each case is injected into the rule. That the source itself is clean is
 * `node scripts/checks/locale-reads-in-memo.mts`, run by `pnpm lint:source`.
 */
const lines = (code: string, path = 'apps/desktop/src/a.tsx') => localeReadLines(path, code)
const store = "import { translateSessionMessage } from '@renderer/localization/locale-store'\n"

describe('what keeps a result and reads the global language', () => {
  it('a memo body that translates', () => {
    expect(lines(`${store}const a = useMemo(() => [translateSessionMessage('x')], [])`)).toEqual([2])
    expect(lines(`${store}const a = React.useMemo(() => translateSessionMessage('x'), [])`)).toEqual([2])
  })
  it('a memo body, even in a component that reads the language through a hook', () => {
    expect(lines(`${store}const A = observer(function A() { useLocale(); const a = useMemo(() => translateSessionMessage('x'), []); return a })`)).toEqual([2])
  })
  it('a memoized component that translates while it renders', () => {
    expect(lines(`${store}const A = observer(function A() { return <b>{translateSessionMessage('x')}</b> })`)).toEqual([2])
    expect(lines(`${store}const A = memo(() => <b title={translateSessionMessage('x')} />)`)).toEqual([2])
    expect(lines(`${store}const A = observer(forwardRef(() => <b>{translateSessionMessage('x')}</b>))`)).toEqual([2])
  })
  it('handed to a helper that reads it now', () => {
    expect(lines(`${store}const a = useMemo(() => words(install, translateSessionMessage), [install])`)).toEqual([2])
  })
  it('the global instance, the snapshot, and renamed imports', () => {
    expect(lines("import { i18n } from '@/i18n'\nconst a = useMemo(() => i18n.language, [])")).toEqual([2])
    expect(lines("import { getLocaleSnapshot } from '../../i18n/runtime'\nconst A = memo(() => <b>{getLocaleSnapshot().resolvedLocale}</b>)")).toEqual([2])
    expect(lines("import { translateSessionMessage as t } from '@renderer/localization/locale-store'\nconst a = useMemo(() => t('x'), [])")).toEqual([2])
  })
  it('a formatter left to the global language, not one given the language', () => {
    const format = "import { formatCalendarDay, formatClock } from '@/i18n/format'\n"
    expect(lines(`${format}const A = memo(() => <b>{formatCalendarDay(at, { withTime: true })}</b>)`)).toEqual([2])
    expect(lines(`${format}const A = memo(() => <b>{formatCalendarDay(at, { withTime: true }, locale)}{formatClock(at, locale)}</b>)`)).toEqual([])
  })
})

describe('what does not', () => {
  it('a function nested inside: it runs later, with the global current', () => {
    expect(lines(`${store}const a = useMemo(() => ({ run: () => toast(translateSessionMessage('x')) }), [])`)).toEqual([])
    expect(lines(`${store}const A = observer(() => <b onClick={() => alert(translateSessionMessage('x'))} />)`)).toEqual([])
  })
  it('a translate read from a hook, a plain component, an effect, a test', () => {
    expect(lines(`${store}const a = useMemo(() => translate('x'), [translate])`)).toEqual([])
    expect(lines(`${store}function A() { return <b>{translateSessionMessage('x')}</b> }`)).toEqual([])
    expect(lines(`${store}useEffect(() => { toast(translateSessionMessage('x')) }, [])`)).toEqual([])
    expect(lines(`${store}const a = useMemo(() => translateSessionMessage('x'), [])`, 'apps/desktop/src/a.test.tsx')).toEqual([])
  })
  it('a memoized component that reads the language through a hook: it is drawn again on a switch', () => {
    expect(lines(`${store}const A = observer(function A() { useLocale(); return <b>{translateSessionMessage('x')}</b> })`)).toEqual([])
  })
  it('told which language', () => {
    expect(lines("import { i18n } from '@/i18n'\nconst a = useMemo(() => i18n.t('x', { ns: 'settings', lng }), [lng])")).toEqual([])
  })
  it('handed on as a prop with the language beside it', () => {
    expect(lines(`${store}const A = memo(() => <MessageProvider locale={locale} translate={translateSessionMessage} />)`)).toEqual([])
  })
  it('a name that is not the import', () => {
    expect(lines("const a = useMemo(() => i18n.t('x'), [])")).toEqual([])
    expect(lines("import { i18n } from '@/i18n'\nconst a = useMemo(() => ({ i18n: 1 }).i18n, [])")).toEqual([])
  })
})
