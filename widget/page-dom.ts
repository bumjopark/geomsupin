/** 페이지가 공개한 ShadowRoot만 순회한다. 위젯 자체의 내부 트리는 제외한다. */
export function pageRoots(start: Document | ShadowRoot | Element = document): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = start instanceof Element ? [] : [start];
  const visit = (node: Element) => {
    if (node.hasAttribute('data-gp-widget')) return;
    if (node.shadowRoot) { roots.push(node.shadowRoot); for (const child of node.shadowRoot.children) visit(child); }
    for (const child of node.children) visit(child);
  };
  if (start instanceof Element) visit(start); else for (const child of start.children) visit(child);
  return roots;
}

export function matches(element: Element, selector: string): boolean {
  try { return element.matches(selector); } catch { return false; }
}

export function activeElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

export function modalDialogs(roots = pageRoots()): HTMLDialogElement[] {
  return roots.flatMap(root => Array.from(root.querySelectorAll<HTMLDialogElement>('dialog')).filter(dialog => matches(dialog, ':modal')));
}
