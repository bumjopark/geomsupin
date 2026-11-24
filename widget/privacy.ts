import { pageRoots } from './page-dom.ts';

export const MASK_ATTRIBUTE = 'data-review-mask';
const MASK_CANDIDATES = `[${MASK_ATTRIBUTE}],input,textarea`;
const SENSITIVE_NAME = /pass|pwd|passwd|card|cvc|cvv|ssn|jumin|resident|주민|비밀번호/i;

function isMask(element: Element) {
  if (element.hasAttribute(MASK_ATTRIBUTE)) return true;
  if (!element.matches('input,textarea')) return false;
  const type = element.getAttribute('type')?.toLowerCase();
  const autocomplete = element.getAttribute('autocomplete')?.toLowerCase().split(/\s+/) ?? [];
  const name = `${element.getAttribute('name') ?? ''} ${element.id}`;
  return type === 'password' || autocomplete.some(token => token.includes('password') || token.startsWith('cc-')) || SENSITIVE_NAME.test(name);
}

export function isInReviewMask(node: Node): boolean {
  for (let current: Node | null = node; current;) {
    if (current.nodeType === Node.ELEMENT_NODE && isMask(current as Element)) return true;
    const slot: HTMLSlotElement | null | undefined = (current as Element | Text).assignedSlot;
    const parent: Node | null = slot ?? current.parentNode;
    current = parent?.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in parent ? (parent as ShadowRoot).host : parent;
  }
  return false;
}

export function touchesReviewMask(element: Element): boolean {
  const includesMask = (root: ParentNode) => Array.from(root.querySelectorAll(MASK_CANDIDATES)).some(isMask);
  return isInReviewMask(element) || includesMask(element) || pageRoots(element).some(includesMask);
}
