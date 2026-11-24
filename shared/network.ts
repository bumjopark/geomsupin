/** 헤더뿐 아니라 응답 본문까지 제한 시간을 적용한다. 저장 요청을 자동 재전송하지 않는다. */
export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* 서버의 오류 페이지도 사용자에게 안내한다 */ }
    return { response, data };
  } catch (e) {
    if (controller.signal.aborted) throw new Error('서버 응답이 늦어지고 있어요. 작성한 내용은 남아 있으니 다시 시도해 주세요.');
    throw new Error('서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', { cause: e });
  } finally { clearTimeout(timer); }
}

/** 실패한 같은 내용을 재전송할 때는 같은 키를 쓰고, 성공한 다음 전송부터 새 키를 쓴다. */
export function pendingMutation() {
  let previous = '';
  let key = '';
  return {
    body<T extends object>(body: T): T & { mutationId: string } {
      const json = JSON.stringify(body);
      if (!key || previous !== json) {
        key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('');
        previous = json;
      }
      return { ...body, mutationId: key };
    },
    done() { key = ''; previous = ''; },
  };
}
