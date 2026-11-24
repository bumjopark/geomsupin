let pageIdentity: string | undefined;

export function reviewerPid() {
  const key = 'gp:guide:pid';
  const storages = [() => localStorage, () => sessionStorage];
  for (const storage of storages) {
    try {
      const value = storage().getItem(key);
      if (value && /^[A-Za-z0-9_-]{16,64}$/.test(value)) return value;
    } catch { /* 다음 저장소를 확인한다. */ }
  }
  pageIdentity ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  for (const storage of storages) {
    try { storage().setItem(key, pageIdentity); break; } catch { /* 현재 초대 화면에서는 같은 값을 쓴다. */ }
  }
  return pageIdentity;
}
