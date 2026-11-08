let accountId: string | null = null;
export const setApiUser = (id: string | null) => {
  accountId = id;
};

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const owner = accountId;
  const safe = !options?.method || options.method.toUpperCase() === "GET";
  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    if (owner !== accountId) throw new Error("当前账号已变化");
    try {
      res = await fetch(`/api${url}`, {
        ...options,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(accountId ? { "X-OI-User": accountId } : {}),
          ...options?.headers,
        },
      });
      if (
        !safe ||
        ![408, 429, 500, 502, 503, 504].includes(res.status) ||
        attempt >= 2
      )
        break;
      await res.body?.cancel();
    } catch (error) {
      if (!safe || options?.signal?.aborted || attempt >= 2) throw error;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 500 * 2 ** attempt + Math.random() * 200),
    );
  }
  const body = await res.json().catch(() => {
    throw new Error(
      res.ok
        ? "服务器返回了无效数据，请刷新重试"
        : `服务暂时不可用（HTTP ${res.status}），请稍后重试`,
    );
  });
  if (res.status === 401 && !url.startsWith("/auth/"))
    window.dispatchEvent(new Event("auth-expired"));
  if (!res.ok)
    throw Object.assign(new Error(body.error || "请求失败，请稍后重试"), {
      status: res.status,
    });
  return body;
}
export const uid = () => crypto.randomUUID();
