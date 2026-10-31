let accountId: string | null = null;
export const setApiUser = (id: string | null) => {
  accountId = id;
};

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${url}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(accountId ? { "X-OI-User": accountId } : {}),
      ...options?.headers,
    },
  });
  const body = await res.json().catch(() => {
    throw new Error(
      res.ok
        ? "服务器返回了无效数据，请刷新重试"
        : `服务暂时不可用（HTTP ${res.status}），请稍后重试`,
    );
  });
  if (res.status === 401 && !url.startsWith("/auth/"))
    window.dispatchEvent(new Event("auth-expired"));
  if (!res.ok) throw new Error(body.error || "请求失败，请稍后重试");
  return body;
}
export const uid = () => crypto.randomUUID();
