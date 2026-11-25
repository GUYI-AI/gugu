interface CodeEditorHistory {
  hasFocus(): boolean;
  undo(): void;
  redo(): void;
}

let activeEditor: CodeEditorHistory | null = null;

export function registerCodeEditorHistory(editor: CodeEditorHistory, subscribe: (listener: () => void) => () => void): () => void {
  const dispose = subscribe(() => { activeEditor = editor; });
  if (editor.hasFocus()) activeEditor = editor;
  return () => {
    dispose();
    if (activeEditor === editor) activeEditor = null;
  };
}
