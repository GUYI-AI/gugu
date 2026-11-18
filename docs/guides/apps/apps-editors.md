# Your own editor on a textarea or contenteditable

## A text file's handle

`f.text` is the whole text. Change it with `f.insert(i, s)`, `f.delete(i, n)`, or
`f.edit(old, new)` (the unique `old` is replaced; else `content-changed` / `ambiguous`).
`f.onChange(({ local, delta }) => …)` gives each change as retain / insert / delete. A caret that must
follow the text is an anchor: `const a = f.anchor(i)`, later `f.resolve(a)` (null once the file was
rebuilt). Don't diff against `f.text` in a view you draw yourself: bind it (below).
No copy menu on a phone: give a selection a Copy button calling `gugu.clipboard.writeText(text)` on click.

For a text file (`apps-files`). Several people type in the same file at once: bind the editor, and
everyone's letters stay, the caret stays on the letter it was at, and an IME composition stays whole. A
`<textarea>` or `<input>` is one line:

```js
const f = await gugu.files.open((await gugu.getContext()).file)
const unbind = gugu.bind.text(document.querySelector('textarea'), f)   // unbind(): what is typed lands, then it lets go
```

A view you draw yourself (a contenteditable, markdown rendered and edited in place) is the same call, given
four things:

```js
gugu.bind.text({
  element: pad,                                  // where the person types
  read: () => toMarkdown(pad),                   // the whole text as it shows now
  render: (text, sel) => {                       // draw it (others wrote it: escape it), then the caret
    pad.replaceChildren(...toNodes(text))
    if (sel) placeCaret(pad, sel)
  },
  selection: () => caretOffsets(pad),            // { anchor, head } in the text, or null
}, f)
```

The one thing your App must keep: once `render` has drawn `t`, `read` gives back exactly `t` — `*x*` stays
`*x*`, never `_x_`. Whatever your serializer rewrites is a change you make to someone else's writing (the
runtime notes it once in your App's error record). A read-only file: a textarea turns read-only, and what is
typed into your own view is taken back.

With CodeMirror it is one line too:

```js
const f = await gugu.files.open((await gugu.getContext()).file)
const { EditorView, basicSetup, markdown } = await gugu.codemirror()
const view = new EditorView({ parent: document.body, extensions: [basicSetup, markdown()] })
gugu.bind.codemirror(view, f)   // content, others' cursors, undo of your own typing only
```

Bind only an EditorView from `gugu.codemirror()` (it also has `markdownLanguage` for GFM, `json`,
`keymap`, `minimalSetup`). Another CodeMirror copy cannot be bound; ship none. For your own plugin or
decoration it hands CodeMirror's modules whole — `view` (`Decoration`, `ViewPlugin`, `MatchDecorator` …),
`state`, `language`, `commands`, `search`, `autocomplete`, `lint`, `langMarkdown`, `langJson`,
`lezerCommon`, `lezerHighlight`, `lezerMarkdown`: the very copies the binding uses, so what you build on them
works on a bound editor. `const { view: { ViewPlugin, Decoration } } = await gugu.codemirror()`. To style by
syntax rather than a pattern (bold, headings, links): a `language.HighlightStyle` over `lezerHighlight.tags`
(e.g. `tags.strong` in bold), given to `language.syntaxHighlighting`.

Beneath it, for a view you manage entirely yourself: `const s = f.snapshot()` when you read,
`f.applyFrom(s, next)` when you write — only what you changed lands, what others typed since stays.
Text files only (a JSON file is changed key by key). ❌ Never diff `next` against `f.text`: by then it
holds others' letters, and your diff deletes them.
