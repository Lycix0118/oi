import { useCallback, useState } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { Modal } from "./components";
import { api } from "./api";
import type { User } from "./types";

export default function Auth({
  mode,
  onClose,
  onSuccess,
  onSwitch,
}: {
  mode: "login" | "register";
  onClose: () => void;
  onSuccess: (user: User) => void;
  onSwitch: (mode: "login" | "register") => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const register = mode === "register";
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      onSuccess(result.user);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={register ? "注册账号" : "登录账号"}
      subtitle={
        register
          ? "保存你的对话与配置，一起完善共享知识库。"
          : "继续你的学习，找回对话与模型配置。"
      }
      onClose={close}
    >
      <form className="settings-form auth-form" onSubmit={submit}>
        <label>
          用户名
          <input
            name="username"
            required
            minLength={2}
            maxLength={32}
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={busy}
            placeholder="2–32 个中文、字母、数字或 _ -"
          />
        </label>
        <label>
          密码
          <div className="password-input">
            <input
              name="password"
              required
              minLength={6}
              maxLength={128}
              type={visible ? "text" : "password"}
              autoComplete={register ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              placeholder="至少 6 个字符"
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setVisible(!visible)}
              aria-label={visible ? "隐藏密码" : "显示密码"}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button
          className="primary-button auth-submit"
          type="submit"
          disabled={busy}
        >
          {busy && <LoaderCircle size={15} className="spin" />}
          {busy ? "请稍候…" : register ? "注册并登录" : "登录"}
        </button>
        <p className="auth-switch">
          {register ? "已有账号？" : "还没有账号？"}
          <button
            type="button"
            disabled={busy}
            onClick={() => onSwitch(register ? "login" : "register")}
          >
            {register ? "去登录" : "去注册"}
          </button>
        </p>
      </form>
    </Modal>
  );
}
