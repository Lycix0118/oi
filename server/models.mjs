export function modelProfiles(stored) {
  const profiles =
    stored.profiles ||
    (stored.baseUrl
      ? [
          {
            id: "legacy",
            name: stored.model,
            baseUrl: stored.baseUrl,
            model: stored.model,
            apiKey: stored.apiKey || "",
          },
        ]
      : []);
  return [
    ...(process.env.AI_BASE_URL
      ? [
          {
            id: "server-default",
            name: "服务器默认",
            baseUrl: process.env.AI_BASE_URL,
            model: process.env.AI_MODEL || "",
            apiKey: process.env.AI_API_KEY || "",
            readOnly: true,
          },
        ]
      : []),
    ...profiles,
  ];
}

export function profileModels(profile) {
  return profile.models || (profile.model ? [profile.model] : []);
}

export function resolveModel(stored, id, model) {
  const profiles = modelProfiles(stored);
  const selected = id || stored.activeModelId;
  const profile =
    profiles.find((p) => p.id === selected) ||
    (!id && (profiles.find((p) => !p.readOnly) || profiles[0]));
  if (id && !profile) throw new Error("模型配置不存在，请重新选择");
  const selectedModel =
    model ||
    (profile &&
      profile.id === stored.activeModelId &&
      profileModels(profile).includes(stored.activeModel) &&
      stored.activeModel) ||
    profile?.model ||
    "";
  if (
    profile &&
    selectedModel &&
    !profileModels(profile).includes(selectedModel)
  )
    throw new Error("模型不在此配置中，请重新选择");
  return {
    baseUrl: "",
    apiKey: "",
    ...profile,
    model: selectedModel,
    reasoningEffort: stored.reasoningEffort || "default",
  };
}

export function publicSettings(stored) {
  const selected = resolveModel(stored);
  return {
    ...selected,
    apiKey: "",
    hasKey: !!selected.apiKey,
    activeModelId: selected.id || "",
    profiles: modelProfiles(stored).map((p) => ({
      ...p,
      models: profileModels(p),
      apiKey: "",
      hasKey: !!p.apiKey,
    })),
  };
}

export function modelConnection(stored, body) {
  const { baseUrl, apiKey } = body;
  let url;
  try {
    if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new Error();
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("请输入有效的 HTTP(S) 接口地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入有效的 HTTP(S) 接口地址");
  if (typeof apiKey !== "string" || apiKey.length > 4096)
    throw new Error("API Key 格式无效");
  const id = body.id || "legacy";
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(id) ||
    id === "server-default"
  )
    throw new Error("无效的配置标识");
  const profiles = modelProfiles(stored).filter((p) => !p.readOnly);
  const previous = profiles.find((p) => p.id === id);
  const normalized = url.href.replace(/\/+$/, "");
  const key =
    apiKey.trim() ||
    (previous &&
    new URL(previous.baseUrl).href.replace(/\/+$/, "") === normalized
      ? previous.apiKey
      : "");
  if (!key) throw new Error("新增配置或修改接口地址时，请填写 API Key");
  return { id, baseUrl: normalized, apiKey: key, profiles, previous };
}

export function saveModel(stored, body) {
  const { id, baseUrl, apiKey, profiles, previous } = modelConnection(
    stored,
    body,
  );
  const rawModels = body.models === undefined ? [body.model] : body.models;
  if (
    !Array.isArray(rawModels) ||
    !rawModels.length ||
    rawModels.length > 200 ||
    rawModels.some((m) => typeof m !== "string" || !m.trim() || m.length > 200)
  )
    throw new Error("请添加 1–200 个有效模型，每个模型名称最多 200 个字符");
  const models = [...new Set(rawModels.map((m) => m.trim()))];
  const model = body.model === undefined ? models[0] : body.model;
  if (typeof model !== "string" || !models.includes(model.trim()))
    throw new Error("默认模型必须在配置的模型列表中");
  if (
    body.name !== undefined &&
    (typeof body.name !== "string" || body.name.length > 100)
  )
    throw new Error("配置名称需为 1–100 个字符");
  const name = body.name?.trim() || model.trim().slice(0, 100);
  if (!previous && profiles.length >= 30)
    throw new Error("最多保存 30 套模型配置");
  const saved = {
    id,
    name: name.trim(),
    baseUrl,
    model: model.trim(),
    models,
    apiKey,
    maxRetries: body.maxRetries ?? previous?.maxRetries ?? 2,
  };
  if (
    !Number.isInteger(saved.maxRetries) ||
    saved.maxRetries < 0 ||
    saved.maxRetries > 10
  )
    throw new Error("最大重试次数必须为 0–10 的整数");
  const selected = resolveModel(stored);
  return {
    profiles: previous
      ? profiles.map((p) => (p.id === id ? saved : p))
      : [...profiles, saved],
    activeModelId: selected.id || id,
    activeModel:
      selected.id === id
        ? models.includes(selected.model)
          ? selected.model
          : saved.model
        : selected.id
          ? selected.model
          : saved.model,
  };
}
