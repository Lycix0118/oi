import { useCallback, useState } from "react";
import { Eye, EyeOff, KeyRound, LoaderCircle } from "lucide-react";
import { Modal } from "./components";
import { api } from "./api";
import type { Settings as Config } from "./types";

export default function Settings({
  initial,
  onClose,
  onSaved,
}: {
  initial: Config;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify(values) });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="模型配置" onClose={close}>
      <form onSubmit={save} className="settings-form">
        <label>
          接口地址 <span>Base URL</span>
          <input
            type="url"
            required
            value={values.baseUrl}
            onChange={(e) => setValues({ ...values, baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
            autoComplete="url"
          />
        </label>
        <label>
          模型名称 <span>Model ID</span>
          <input
            required
            value={values.model}
            onChange={(e) => setValues({ ...values, model: e.target.value })}
            placeholder="例如 deepseek-chat、gpt-4o"
          />
        </label>
        <label>
          API Key <span>{initial.hasKey ? "留空则保留原密钥" : "必填"}</span>
          <div className="password-input">
            <KeyRound size={15} />
            <input
              type={visible ? "text" : "password"}
              value={values.apiKey}
              onChange={(e) => setValues({ ...values, apiKey: e.target.value })}
              placeholder={initial.hasKey ? "••••••••••••••••" : "sk-..."}
              autoComplete="off"
              required={!initial.hasKey}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setVisible(!visible)}
              aria-label={visible ? "隐藏密钥" : "显示密钥"}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="secondary-button"
            onClick={close}
            disabled={busy}
          >
            取消
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy && <LoaderCircle size={15} className="spin" />}
            {busy ? "保存中" : "保存配置"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
