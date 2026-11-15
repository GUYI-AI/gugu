import { appState } from '@renderer/lib/stores/app-state';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/** Where the link sits in the sentence; never part of a translation. */
const LINK = '\u0000';

/**
 * The archive notice's sentence: 「会话历史」 in it is a link that opens 会话历史, the same page the sidebar's 会话历史
 * button opens (owner 2026-11-12: 「这个会话历史变成点击可跳转的吧」). The sentence stays one translation with a `{link}`
 * slot, so each language puts the link where it reads naturally.
 */
export function ArchivedToastHint() {
  const parts = translateSessionMessage('task.archivedToastHint', { link: LINK }).split(LINK);
  if (parts.length !== 2) throw new Error('task.archivedToastHint must hold exactly one {link}');
  return (
    <>
      {parts[0]}
      <button
        type="button"
        className="cursor-pointer underline underline-offset-2 hover:text-foreground"
        data-archived-toast-history=""
        onClick={() => appState.navigation.navigate('session-history')}
      >
        {translateSessionMessage('sidebar.sessionHistory')}
      </button>
      {parts[1]}
    </>
  );
}
