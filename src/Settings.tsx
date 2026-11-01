import { useCallback, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2,
  Check,
  Globe,
  CircleAlert,
} from "lucide-react";
import { Modal } from "./components";
import { api, uid } from "./api";
import type { ModelProfile, Settings as Config } from "./types";

type Draft = Pick<
  ModelProfile,
  "id" | "name" | "baseUrl" | "model" | "models" | "apiKey" | "readOnly"
>;
const emptyDraft = (id: string = uid()): Draft => ({
  id,
  name: "",
  baseUrl: "",
  model: "",
  models: [],
  apiKey: "",
});
const draftFrom = (p: ModelProfile): Draft => ({
  id: p.id,
  name: p.name,
  baseUrl: p.baseUrl,
  model: p.model,
  models: p.models || (p.model ? [p.model] : []),
  apiKey: "",
  readOnly: p.readOnly,
});
function normalizeUrl(value: string) {
  try {
    return new URL(value.trim()).href.replace(/\/+$/, "");
  } catch {
    return value.trim();
  }
}

export default function Settings({
  initial,
  onClose,
  onSaved,
}: {
  initial: Config;
  onClose: () => void;
  onSaved: (settings: Config, message: string) => void;
}) {
  const profiles = initial.profiles || [];
  const [values, setValues] = useState<Draft>(() => {
    const p =
      profiles.find((p) => p.id === initial.activeModelId) || profiles[0];
    return p ? draftFrom(p) : emptyDraft();
  });
  const [visible, setVisible] = useState(false);
  const [operation, setOperation] = useState<
    "save" | "delete" | "discover" | "activate" | null
  >(null);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [availableModels, setAvailableModels] = useState<string[] | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const busy = operation !== null;
  const models = values.models || [];
  const original = profiles.find((p) => p.id === values.id);
  const baseline = original ? draftFrom(original) : emptyDraft(values.id);
  const dirty =
    !values.readOnly &&
    (JSON.stringify(values) !== JSON.stringify(baseline) ||
      !!modelInput.trim() ||
      selectedModels.length > 0);
  const canKeepKey =
    !!original?.hasKey &&
    normalizeUrl(original.baseUrl) === normalizeUrl(values.baseUrl);
  const filteredModels =
    availableModels?.filter((m) =>
      m.toLowerCase().includes(modelSearch.trim().toLowerCase()),
    ) || [];
  const resetDiscovery = () => {
    setAvailableModels(null);
    setSelectedModels([]);
    setModelSearch("");
  };
  const update = (patch: Partial<Draft>) => {
    setValues((v) => ({ ...v, ...patch }));
    setError("");
  };
  const discard = useCallback(
    () => !dirty || confirm("有未保存的修改，确定放弃吗？"),
    [dirty],
  );
  const close = useCallback(() => {
    if (!pending.current && discard()) onClose();
  }, [discard, onClose]);
  function selectProfile(profile?: ModelProfile) {
    if (pending.current || profile?.id === values.id || (!profile && !original))
      return;
    if (!discard()) return;
    setValues(profile ? draftFrom(profile) : emptyDraft());
    setVisible(false);
    setModelInput("");
    resetDiscovery();
    setError("");
  }
  function addModels(added: string[]) {
    const normalized = added.map((m) => m.trim()).filter(Boolean);
    const next = [...new Set([...models, ...normalized])];
    if (normalized.some((m) => m.length > 200) || next.length > 200) {
      setError("每套配置支持 1–200 个模型，每个模型 ID 最多 200 个字符");
      return;
    }
    update({ models: next, model: values.model || next[0] || "" });
    if (normalized.includes(modelInput.trim())) setModelInput("");
    setSelectedModels((selected) => selected.filter((m) => !next.includes(m)));
  }
  async function run(
    kind: NonNullable<typeof operation>,
    action: () => Promise<void>,
  ) {
    if (pending.current) return;
    pending.current = true;
    setOperation(kind);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setOperation(null);
    }
  }
  async function discover() {
    await run("discover", async () => {
      const result = await api<{ models: string[] }>("/models/discover", {
        method: "POST",
        body: JSON.stringify({
          id: values.id,
          baseUrl: values.baseUrl.trim(),
          apiKey: values.apiKey.trim(),
        }),
      });
      setAvailableModels(result.models);
      setSelectedModels([]);
      setModelSearch("");
    });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (values.readOnly) return;
    const savedModels = [
      ...new Set(
        [...models, ...selectedModels, modelInput.trim()].filter(Boolean),
      ),
    ];
    if (!savedModels.length) {
      setError("请至少添加一个模型 ID");
      return;
    }
    if (savedModels.length > 200 || savedModels.some((m) => m.length > 200)) {
      setError("每套配置最多 200 个模型，每个模型 ID 最多 200 个字符");
      return;
    }
    await run("save", async () => {
      const next = await api<Config>("/settings", {
        method: "PUT",
        body: JSON.stringify({
          id: values.id,
          name: values.name.trim(),
          baseUrl: values.baseUrl.trim(),
          apiKey: values.apiKey.trim(),
          model: values.model || savedModels[0],
          models: savedModels,
        }),
      });
      onSaved(next, "配置已保存");
      onClose();
    });
  }
  async function activate() {
    if (!original || dirty) return;
    await run("activate", async () => {
      const next = await api<Config>("/settings", {
        method: "PATCH",
        body: JSON.stringify({
          activeModelId: original.id,
          model: original.model,
        }),
      });
      onSaved(next, "已切换模型");
      onClose();
    });
  }

  return (
    <Modal
      title="模型配置"
      subtitle="管理接口与模型；在聊天输入框中切换当前模型。"
      onClose={close}
      wide
    >
      <div className="settings-container">
        <aside className="profile-list" aria-label="已保存配置">
          <div className="profile-list-header">
            <h3>已保存配置</h3>
            <button
              type="button"
              className="icon-button"
              aria-label="新增配置"
              title="新增配置"
              disabled={busy || !original}
              onClick={() => selectProfile()}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="profile-items">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`profile-item ${values.id === p.id ? "active" : ""}`}
                aria-pressed={values.id === p.id}
                disabled={busy}
                onClick={() => selectProfile(p)}
              >
                <div className="profile-item-main">
                  <div className="profile-item-name" title={p.name}>
                    {p.name}
                  </div>
                  <div className="profile-item-model">
                    {p.models?.length || (p.model ? 1 : 0)} 个模型
                    {p.readOnly ? " · 只读" : ""}
                  </div>
                  {initial.activeModelId === p.id && (
                    <small className="profile-current">当前使用</small>
                  )}
                </div>
                {values.id === p.id && (
                  <Check size={16} className="profile-item-check" />
                )}
              </button>
            ))}
            {!profiles.length && (
              <div className="profile-empty">
                <p>暂无保存的配置</p>
                <p>填写接口、密钥并添加模型</p>
              </div>
            )}
            {!original && (
              <div className="profile-draft">
                <Plus size={14} />
                正在新增配置
              </div>
            )}
          </div>
        </aside>
        <form onSubmit={save} className="profile-editor">
          <div className="profile-editor-header">
            <h3>
              {original ? "配置详情" : "新增配置"}
              {dirty && <small className="profile-unsaved">未保存</small>}
            </h3>
            {original && !original.readOnly && (
              <button
                type="button"
                className="icon-button danger"
                aria-label="删除配置"
                title="删除配置"
                disabled={busy}
                onClick={() => {
                  if (
                    !confirm(
                      `确定删除配置“${original.name}”？${initial.activeModelId === original.id ? "当前模型将切换至其他可用配置。" : ""}`,
                    )
                  )
                    return;
                  void run("delete", async () => {
                    const next = await api<Config>(
                      `/models/${encodeURIComponent(original.id)}`,
                      { method: "DELETE" },
                    );
                    onSaved(next, "配置已删除");
                    onClose();
                  });
                }}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
          <div className="profile-editor-fields">
            {values.readOnly && (
              <div className="readonly-notice">
                <CircleAlert size={16} />
                <p>
                  服务器默认配置由管理员维护。可使用此配置，或新增个人配置。
                </p>
              </div>
            )}
            <label className="field-group">
              <span className="field-label">
                配置名称<span className="field-hint">选填</span>
              </span>
              <input
                aria-label="配置名称"
                value={values.name}
                maxLength={100}
                disabled={busy || values.readOnly}
                placeholder="例如：日常解题（留空使用默认模型 ID）"
                onChange={(e) => update({ name: e.target.value })}
                className="field-input"
              />
            </label>
            <label className="field-group">
              <span className="field-label">
                <Globe size={14} />
                <span>接口地址</span>
                <span className="field-hint">Base URL</span>
              </span>
              <input
                aria-label="接口地址"
                type="url"
                required
                disabled={busy || values.readOnly}
                value={values.baseUrl}
                onChange={(e) => {
                  update({ baseUrl: e.target.value });
                  resetDiscovery();
                }}
                placeholder="https://api.example.com/v1"
                autoComplete="url"
                className="field-input"
              />
            </label>
            <label className="field-group">
              <span className="field-label">
                <KeyRound size={14} />
                <span>API Key</span>
                <span className="field-hint">
                  {canKeepKey ? "已保存，留空保留" : "必填"}
                </span>
              </span>
              <div className="password-input">
                <input
                  aria-label="API Key"
                  type={visible ? "text" : "password"}
                  value={values.apiKey}
                  onChange={(e) => {
                    update({ apiKey: e.target.value });
                    resetDiscovery();
                  }}
                  placeholder={canKeepKey ? "已保存密钥" : "输入 API Key"}
                  autoComplete="off"
                  disabled={busy || values.readOnly}
                  required={!canKeepKey}
                  maxLength={4096}
                />
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy || values.readOnly}
                  onClick={() => setVisible(!visible)}
                  aria-label={visible ? "隐藏密钥" : "显示密钥"}
                >
                  {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            {!values.readOnly && (
              <section className="model-discovery" aria-label="API 可用模型">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    busy ||
                    !values.baseUrl.trim() ||
                    (!values.apiKey.trim() && !canKeepKey)
                  }
                  onClick={discover}
                >
                  {operation === "discover" && (
                    <LoaderCircle size={15} className="spin" />
                  )}
                  {operation === "discover" ? "获取中…" : "从 API 获取模型列表"}
                </button>
                <p className="model-help">
                  兼容 OpenAI 的接口可获取模型列表；也可在下方手动添加模型 ID。
                </p>
                {availableModels !== null && (
                  <>
                    <p className="model-help" role="status">
                      {availableModels.length
                        ? `获取到 ${availableModels.length} 个模型，勾选后加入配置，也可直接保存。`
                        : "接口未返回可用模型，可手动添加。"}
                    </p>
                    {availableModels.length > 0 && (
                      <>
                        <input
                          className="field-input"
                          aria-label="搜索可用模型"
                          placeholder="搜索模型 ID"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                        />
                        <div className="available-model-list">
                          {!filteredModels.length && (
                            <p className="model-help model-empty">
                              没有匹配的模型
                            </p>
                          )}
                          {filteredModels.map((model) => {
                            const added = models.includes(model);
                            return (
                              <label className="available-model" key={model}>
                                <input
                                  type="checkbox"
                                  disabled={busy || added}
                                  checked={
                                    added || selectedModels.includes(model)
                                  }
                                  onChange={(e) =>
                                    setSelectedModels((selected) =>
                                      e.target.checked
                                        ? [...selected, model]
                                        : selected.filter((m) => m !== model),
                                    )
                                  }
                                />
                                <span>{model}</span>
                                {added && <small>已添加</small>}
                              </label>
                            );
                          })}
                        </div>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy || !selectedModels.length}
                          onClick={() => addModels(selectedModels)}
                        >
                          加入所选模型（{selectedModels.length}）
                        </button>
                      </>
                    )}
                  </>
                )}
              </section>
            )}
            <section className="profile-models" aria-label="配置中的模型">
              <div className="field-label">配置中的模型（{models.length}）</div>
              <p className="model-help">
                模型共用此接口和密钥。勾选默认模型；保存配置保留当前聊天模型。
              </p>
              {!models.length && (
                <p className="model-empty">
                  尚未添加模型，请从 API 获取或手动添加。
                </p>
              )}
              {models.map((model) => (
                <div className="profile-model-row" key={model}>
                  <label>
                    <input
                      type="radio"
                      name="default-model"
                      aria-label={`设为默认模型 ${model}`}
                      checked={values.model === model}
                      disabled={busy || values.readOnly}
                      onChange={() => update({ model })}
                    />
                    <span title={model}>{model}</span>
                    {values.model === model && <small>默认</small>}
                  </label>
                  {!values.readOnly && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除模型 ${model}`}
                      disabled={busy}
                      onClick={() => {
                        const next = models.filter((m) => m !== model);
                        update({
                          models: next,
                          model:
                            values.model === model
                              ? next[0] || ""
                              : values.model,
                        });
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
              {!values.readOnly && (
                <div className="model-add-row">
                  <input
                    className="field-input"
                    aria-label="添加模型 ID"
                    placeholder="输入模型 ID"
                    maxLength={200}
                    disabled={busy}
                    value={modelInput}
                    onChange={(e) => {
                      setModelInput(e.target.value);
                      setError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (modelInput.trim()) addModels([modelInput]);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || !modelInput.trim()}
                    onClick={() => addModels([modelInput])}
                  >
                    添加模型
                  </button>
                </div>
              )}
            </section>
          </div>
          {error && (
            <div role="alert" className="form-error profile-error">
              {error}
            </div>
          )}
          <div className="profile-editor-footer">
            {original &&
              !dirty &&
              original.hasKey &&
              original.model &&
              (initial.activeModelId !== original.id ||
                initial.model !== original.model) && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={activate}
                >
                  {operation === "activate" && (
                    <LoaderCircle size={15} className="spin" />
                  )}
                  使用默认模型
                </button>
              )}
            <button
              type="button"
              className="secondary-button"
              onClick={close}
              disabled={busy}
            >
              {values.readOnly ? "关闭" : "取消"}
            </button>
            {!values.readOnly && (
              <button
                type="submit"
                className="primary-button"
                disabled={busy || (!!original && !dirty)}
              >
                {operation === "save" && (
                  <LoaderCircle size={15} className="spin" />
                )}
                {operation === "save" ? "保存中…" : "保存配置"}
              </button>
            )}
          </div>
        </form>
      </div>
    </Modal>
  );
}
