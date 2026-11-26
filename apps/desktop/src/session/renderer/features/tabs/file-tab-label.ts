import { fileBaseName } from '@renderer/features/sessions/stores/workspace-path';

export interface FileTabLabel {
  name: string;
  /** 同名时补在名字后面、能把它和别的同名页签分开的那截路径;不重名时没有。 */
  hint?: string;
}

/**
 * 一组页签各叫什么。重名的,从路径末尾往上取最短的、在同名的几个之间唯一的那截:
 * `a/x/index.html`、`b/x/index.html`、`c/y/index.html` ⇒ `a/x`、`b/x`、`y`。
 * 名字就是文件名时文件名本身分不开它们,从父目录取起;名字是 `<title>` 时文件名也算一截。
 * 没有路径的(`path` 为空,比如 http 网页)不补。
 */
export function fileTabLabels(tabs: readonly { path: string; title: string | null }[]): FileTabLabel[] {
  const names = tabs.map((tab) => tab.title || fileBaseName(tab.path));
  const segments = tabs.map((tab, i) => {
    const parts = tab.path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] === names[i] ? parts.slice(0, -1) : parts;
  });
  const tail = (i: number, k: number) => segments[i].slice(-k).join('/');
  return names.map((name, i) => {
    // 路径一模一样的不算对手:路径分不开它们,分开它们的是别的(diff 页签的「工作区 / 暂存」)。
    const rivals = names.flatMap((other, j) => (j !== i && other === name && tabs[j].path !== tabs[i].path ? [j] : []));
    if (rivals.length === 0 || segments[i].length === 0) return { name };
    for (let k = 1; k <= segments[i].length; k++) {
      const hint = tail(i, k);
      if (rivals.every((j) => tail(j, k) !== hint)) return { name, hint };
    }
    return { name, hint: segments[i].join('/') };
  });
}
