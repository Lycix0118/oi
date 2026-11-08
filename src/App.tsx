import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cloud,
  Copy,
  FileText,
  LibraryBig,
  LogOut,
  Menu,
  MessageSquare,
  Paperclip,
  PanelLeftClose,
  PenLine,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Square,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { api, setApiUser, uid } from "./api";
import { Logo, Markdown, Modal } from "./components";
import Settings from "./Settings";
import Library from "./Library";
import Auth from "./Auth";
import type {
  Chat,
  Message,
  Note,
  LibraryIndex,
  Settings as Config,
  User,
  View,
} from "./types";

const effortLevels = [
  { value: "default", label: "默认" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
] as const;

function readView(): View {
  const hash = location.hash.slice(1);
  return ["chat", "agent", "library"].includes(hash) ? (hash as View) : "chat";
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register" | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const currentUser = useRef<string | null>(null);
  const effortWrite = useRef(Promise.resolve());
  const [view, setView] = useState<View>(readView);
  const [sidebar, setSidebar] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [folderPaths, setFolderPaths] = useState<string[]>([]);
  const loadedChats = useRef(new Set<string>());
  const chatLoadRequest = useRef(0);
  const [chatLoading, setChatLoading] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [config, setConfig] = useState<Config>({
    baseUrl: "",
    model: "",
    apiKey: "",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<
    { name: string; content: string; dataUrl?: string }[]
  >([]);
  const [attachmentReads, setAttachmentReads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cloud, setCloud] = useState(
    () => localStorage.getItem("oi-cloud") === "1",
  );
  const [historyNext, setHistoryNext] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [searchChats, setSearchChats] = useState<Chat[]>([]);
  const [searchNext, setSearchNext] = useState<string | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const searchVersion = useRef(0);
  const [messageLimit, setMessageLimit] = useState(40);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [editText, setEditText] = useState("");
  const [messageSaving, setMessageSaving] = useState(false);
  const [effortIndex, setEffortIndex] = useState(0);
  const [toast, setToast] = useState("");
  const [toastKind, setToastKind] = useState<"success" | "error">("success");
  const [error, setError] = useState("");
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [deleteChat, setDeleteChat] = useState<Chat | null>(null);
  const [libraryDirty, setLibraryDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<
    (() => void) | null
  >(null);
  const [notePath, setNotePath] = useState<string | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [dragging, setDragging] = useState(false);

  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const nearBottom = useRef(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const mode = view === "agent" ? "agent" : "chat";
  const active = chats.find((c) => c.id === activeId && c.mode === mode);
  const messages = active?.messages || [];

  const notify = useCallback(
    (text: string, kind: "success" | "error" = "success") => {
      setToast(text);
      setToastKind(kind);
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(""), 3200);
    },
    [],
  );

  const refreshNotes = useCallback(async () => {
    const owner = currentUser.current;
    if (!owner) return;
    try {
      const values = await api<LibraryIndex>("/library");
      if (currentUser.current === owner) {
        setNotes(values.notes);
        setFolderPaths(values.folders);
      }
    } catch (e) {
      notify((e as Error).message);
    }
  }, [notify]);

  useEffect(() => {
    let cancelled = false;
    api<{ user: User | null }>("/auth/me")
      .then((result) => {
        if (!cancelled) {
          currentUser.current = result.user?.id || null;
          setApiUser(currentUser.current);
          setWorkspaceLoading(!!result.user);
          setUser(result.user);
        }
      })
      .catch((error) => notify(error.message))
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });
    const expired = () => {
      clearAccount();
      setAuthMode("login");
      notify("登录已过期，请重新登录");
    };
    const syncAccount = () => {
      api<{ user: User | null }>("/auth/me")
        .then(({ user: nextUser }) => {
          if (cancelled || (nextUser?.id || null) === currentUser.current)
            return;
          clearAccount();
          currentUser.current = nextUser?.id || null;
          setApiUser(currentUser.current);
          setWorkspaceLoading(!!nextUser);
          setUser(nextUser);
        })
        .catch(() => {});
    };
    window.addEventListener("auth-expired", expired);
    window.addEventListener("focus", syncAccount);
    return () => {
      cancelled = true;
      window.removeEventListener("auth-expired", expired);
      window.removeEventListener("focus", syncAccount);
      controller.current?.abort();
      clearTimeout(toastTimer.current);
    };
  }, [notify]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const owner = user.id;
    setWorkspaceLoading(true);
    Promise.all([
      api<LibraryIndex>("/library"),
      api<Config>("/settings"),
      api<{ items: Omit<Chat, "messages">[]; next: string | null }>(
        "/chats?page=1",
      ),
    ])
      .then(([nextNotes, nextConfig, nextChats]) => {
        if (cancelled || currentUser.current !== owner) return;
        setNotes(nextNotes.notes);
        setFolderPaths(nextNotes.folders);
        setConfig(nextConfig);
        setChats(nextChats.items.map((chat) => ({ ...chat, messages: [] })));
        setHistoryNext(nextChats.next);
        setEffortIndex(
          Math.max(
            0,
            effortLevels.findIndex(
              (level) => level.value === nextConfig.reasoningEffort,
            ),
          ),
        );
      })
      .catch((error) => {
        if (!cancelled) notify(error.message);
      })
      .finally(() => {
        if (!cancelled) setWorkspaceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, notify]);

  function clearAccount() {
    currentUser.current = null;
    setApiUser(null);
    controller.current?.abort();
    setUser(null);
    setChats([]);
    loadedChats.current.clear();
    chatLoadRequest.current++;
    setChatLoading(false);
    setFolderPaths([]);
    setNotes([]);
    setActiveId(null);
    setHistoryNext(null);
    setEditingMessage(null);
    setConfig({ baseUrl: "", model: "", apiKey: "" });
    setEffortIndex(0);
    setInput("");
    setAttachments([]);
    setError("");
    setSettingsOpen(false);
    setSwitchingModel(false);
    setSearch(false);
    setDeleteChat(null);
    setReferenceOpen(false);
    setPendingNavigation(null);
    setLibraryDirty(false);
    setNotePath(null);
    setBusy(false);
    setWorkspaceLoading(false);
  }

  function openSettings() {
    if (!user) setAuthMode("login");
    else if (!workspaceLoading && !switchingModel) setSettingsOpen(true);
  }

  async function logout() {
    try {
      await effortWrite.current;
      await api("/auth/logout", { method: "POST" });
      clearAccount();
      notify("已退出登录");
    } catch (error) {
      notify((error as Error).message);
    }
  }

  function changeEffort(index: number) {
    if (!authReady || workspaceLoading) return;
    setEffortIndex(index);
    const owner = currentUser.current;
    if (!owner) return;
    const save = effortWrite.current.then(async () => {
      if (currentUser.current !== owner) return;
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ reasoningEffort: effortLevels[index].value }),
      });
    });
    effortWrite.current = save.catch((error) =>
      notify(`保存失败：${error.message}`),
    );
  }

  useEffect(() => {
    const fn = () => {
      const next = readView();
      if (next === view) return;
      if (busy) {
        history.replaceState(null, "", `#${view}`);
        return;
      }
      if (libraryDirty) {
        history.replaceState(null, "", `#${view}`);
        setPendingNavigation(() => () => performNavigate(next));
      } else performNavigate(next);
    };
    addEventListener("hashchange", fn);
    return () => removeEventListener("hashchange", fn);
  }, [busy, libraryDirty, view]);

  useEffect(() => {
    if (nearBottom.current)
      end.current?.scrollIntoView({
        behavior: busy ? "instant" : "smooth",
        block: "end",
      });
  }, [messages, busy]);

  useEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((v) => !v);
      }
      if (e.key === "Escape") {
        setReferenceOpen(false);
        setSidebar(false);
      }
    };
    addEventListener("keydown", fn);
    return () => removeEventListener("keydown", fn);
  }, []);

  function navigate(next: View) {
    if (busy) {
      notify("请先停止当前生成");
      return;
    }
    requestNavigation(() => performNavigate(next));
  }

  function requestNavigation(action: () => void) {
    if (libraryDirty) setPendingNavigation(() => action);
    else action();
  }

  function performNavigate(next: View) {
    chatLoadRequest.current++;
    setChatLoading(false);
    setLibraryDirty(false);
    setView(next);
    location.hash = next;
    setSidebar(false);
    setSearch(false);
    setError("");
    setInput("");
    setAttachments([]);
    setActiveId(null);
    setShowScrollBottom(false);
  }

  function newChat() {
    if (busy) return;
    chatLoadRequest.current++;
    setChatLoading(false);
    if (view === "library") {
      navigate("chat");
      return;
    }
    setActiveId(null);
    setInput("");
    setAttachments([]);
    setError("");
    setSidebar(false);
    setShowScrollBottom(false);
    setTimeout(() => textarea.current?.focus(), 0);
  }

  function openChat(chat: Chat) {
    if (busy) return;
    requestNavigation(() => {
      performNavigate(chat.mode);
      setChats((prev) =>
        prev.some((c) => c.id === chat.id) ? prev : [...prev, chat],
      );
      setActiveId(chat.id);
      setMessageLimit(40);
      nearBottom.current = true;
      const owner = currentUser.current;
      const request = ++chatLoadRequest.current;
      setChatLoading(true);
      api<Chat>(`/chats/${encodeURIComponent(chat.id)}`)
        .then((value) => {
          if (
            currentUser.current !== owner ||
            chatLoadRequest.current !== request
          )
            return;
          loadedChats.current.add(value.id);
          if (value.generation?.error) setError(value.generation.error);
          setChats((previous) =>
            previous.map((item) => (item.id === value.id ? value : item)),
          );
        })
        .catch((error) => {
          if (
            currentUser.current === owner &&
            chatLoadRequest.current === request
          ) {
            setActiveId(null);
            notify(error.message);
          }
        })
        .finally(() => {
          if (chatLoadRequest.current === request) setChatLoading(false);
        });
    });
  }

  function openNote(path: string) {
    if (busy) return;
    requestNavigation(() => {
      performNavigate("library");
      setNotePath(path);
    });
  }

  async function loadSearch(before?: string, version = searchVersion.current) {
    const owner = currentUser.current;
    setSearchBusy(true);
    try {
      const page = await api<{
        items: Omit<Chat, "messages">[];
        next: string | null;
      }>(
        "/chats?page=1&q=" +
          encodeURIComponent(query) +
          (before ? "&before=" + encodeURIComponent(before) : ""),
      );
      if (owner !== currentUser.current || version !== searchVersion.current)
        return;
      const items = page.items.map((c) => ({ ...c, messages: [] }));
      setSearchChats((prev) =>
        before
          ? [...prev, ...items.filter((c) => !prev.some((p) => p.id === c.id))]
          : items,
      );
      setSearchNext(page.next);
    } catch (e) {
      if (owner === currentUser.current) notify((e as Error).message);
    } finally {
      if (version === searchVersion.current) setSearchBusy(false);
    }
  }
  useEffect(() => {
    const version = ++searchVersion.current;
    setSearchChats([]);
    setSearchNext(null);
    if (!search || !user) return;
    const timer = setTimeout(() => void loadSearch(undefined, version), 250);
    return () => clearTimeout(timer);
  }, [query, search, user?.id]);

  async function loadHistory() {
    if (!historyNext || historyBusy) return;
    const owner = currentUser.current;
    setHistoryBusy(true);
    try {
      const page = await api<{
        items: Omit<Chat, "messages">[];
        next: string | null;
      }>("/chats?page=1&before=" + encodeURIComponent(historyNext));
      if (owner !== currentUser.current) return;
      setChats((prev) => [
        ...prev,
        ...page.items
          .filter((c) => !prev.some((p) => p.id === c.id))
          .map((c) => ({ ...c, messages: [] })),
      ]);
      setHistoryNext(page.next);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setHistoryBusy(false);
    }
  }
  async function changeMessage(id: string, content: string | null) {
    if (!active || busy || messageSaving) return;
    const owner = currentUser.current;
    setMessageSaving(true);
    try {
      const next = {
        ...active,
        messages:
          content === null
            ? active.messages.filter((m) => m.id !== id)
            : active.messages.map((m) => (m.id === id ? { ...m, content } : m)),
      };
      const saved = await persist(next);
      if (owner !== currentUser.current) return;
      setChats((prev) =>
        prev.map((c) =>
          c.id === next.id ? { ...next, revision: saved.revision } : c,
        ),
      );
      setEditingMessage(null);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setMessageSaving(false);
    }
  }
  useEffect(() => {
    if (!activeId || !user || active?.generation?.status !== "running") return;
    const owner = user.id;
    const id = activeId;
    let cancelled = false;
    setBusy(true);
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const chat = await api<Chat>("/chats/" + encodeURIComponent(id));
        if (cancelled || currentUser.current !== owner) return;
        setChats((prev) => prev.map((c) => (c.id === id ? chat : c)));
        if (chat.generation?.status !== "running") {
          setBusy(false);
          if (chat.generation?.error) setError(chat.generation.error);
          if (chat.mode === "agent") void refreshNotes();
        }
      } catch (error) {
        if (
          !cancelled &&
          currentUser.current === owner &&
          (error as Error & { status?: number }).status === 404
        ) {
          setBusy(false);
          setActiveId(null);
          notify("对话已被删除");
        }
        /* Keep polling after temporary connectivity loss. */
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void tick(), 1500);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeId, user?.id, active?.generation?.status]);

  async function persist(chat: Chat) {
    return await api<{ revision: number }>(`/chats/${chat.id}`, {
      method: "PUT",
      body: JSON.stringify(chat),
    });
  }

  async function runCompletion(baseChat: Chat, resetComposer = false) {
    loadedChats.current.add(baseChat.id);
    const owner = currentUser.current;
    const assistant: Message = {
      id: uid(),
      role: "assistant",
      content: "",
      reasoning: "",
      tools: [],
    };
    const chat: Chat = {
      ...baseChat,
      updatedAt: new Date().toISOString(),
      messages: [...baseChat.messages, assistant],
    };
    const update = () => {
      if (currentUser.current !== owner) return;
      setChats((prev) => [
        structuredClone(chat),
        ...prev.filter((c) => c.id !== chat.id),
      ]);
    };
    setActiveId(chat.id);
    update();
    setBusy(true);
    setError("");
    nearBottom.current = true;
    setShowScrollBottom(false);

    const abort = new AbortController();
    controller.current = abort;
    let streamError = "";
    let completed = false;
    let started = false;
    let cloudRunning = false;
    try {
      const saved = await persist({
        ...chat,
        messages: chat.messages.slice(0, -1),
      });
      chat.revision = saved.revision;
      if (resetComposer && currentUser.current === owner) {
        setInput("");
        setAttachments([]);
      }
      if (cloud) {
        await api("/chat", {
          method: "POST",
          body: JSON.stringify({
            chatId: chat.id,
            assistantId: assistant.id,
            revision: chat.revision,
            modelId: config.activeModelId,
            model: config.model,
            mode: chat.mode,
            cloud: true,
            reasoningEffort: effortLevels[effortIndex].value,
            messages: baseChat.messages.map((m) => ({
              role: m.role,
              content: m.content,
              images: m.images,
            })),
          }),
        });
        started = true;
        cloudRunning = true;
        chat.generation = { status: "running", cloud: true };
        completed = true;
        return;
      }
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(owner ? { "X-OI-User": owner } : {}),
        },
        body: JSON.stringify({
          chatId: chat.id,
          assistantId: assistant.id,
          revision: chat.revision,
          modelId: config.activeModelId,
          model: config.model,
          mode: chat.mode,
          reasoningEffort: effortLevels[effortIndex].value,
          messages: chat.messages.slice(0, -1).map((m) => ({
            role: m.role,
            content: m.content,
            images: m.images,
          })),
        }),
        signal: abort.signal,
      });
      if (!res.ok) {
        if (res.status === 401) window.dispatchEvent(new Event("auth-expired"));
        const body = await res.json();
        throw new Error(body.error || "连接失败");
      }
      started = true;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const parse = (line: string) => {
        if (!line.startsWith("data:")) return;
        const event = JSON.parse(line.slice(5).trim());
        if (event.type === "delta") {
          assistant.content += event.text;
          update();
        }
        if (event.type === "reasoning") {
          assistant.reasoning = (assistant.reasoning || "") + event.text;
          update();
        }
        if (event.type === "tool") {
          assistant.tools!.push({
            name: event.name,
            path: event.path,
            result: event.result,
          });
          update();
          refreshNotes();
        }
        if (event.type === "warning") notify(event.text);
        if (event.type === "error") streamError = event.error;
        if (event.type === "done") completed = true;
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) parse(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) parse(buffer.trim());
      if (streamError) throw new Error(streamError);
      if (!completed) throw new Error("连接已中断，可点击重试。");
    } catch (e) {
      if (!abort.signal.aborted && currentUser.current === owner)
        setError((e as Error).message);
    } finally {
      if (
        !assistant.content.trim() &&
        !assistant.tools?.length &&
        !assistant.reasoning?.trim()
      )
        chat.messages = chat.messages.filter((m) => m.id !== assistant.id);
      update();
      if (currentUser.current === owner) {
        try {
          const saved = await api<Chat>(`/chats/${chat.id}`);
          if (currentUser.current === owner) {
            cloudRunning = saved.generation?.status === "running";
            if (saved.generation?.error) setError(saved.generation.error);
            setChats((prev) => [
              saved,
              ...prev.filter((c) => c.id !== chat.id),
            ]);
          }
        } catch (e) {
          if (started) notify(`同步对话失败：${(e as Error).message}`);
        } finally {
          if (currentUser.current === owner) {
            setBusy(cloudRunning);
            controller.current = null;
          }
        }
      }
      if (chat.mode === "agent") refreshNotes();
    }
  }

  async function send() {
    if ((!input.trim() && !attachments.length) || busy || attachmentReads)
      return;
    if (!user) {
      setAuthMode("login");
      return;
    }
    if (workspaceLoading || chatLoading || switchingModel) return;
    if (!config.hasKey || !config.baseUrl || !config.model) {
      setSettingsOpen(true);
      return;
    }
    const text = input.trim();
    const content =
      text +
      attachments
        .filter((f) => !f.dataUrl)
        .map((f) => `\n\n---\n附件：${f.name}\n\n${f.content}`)
        .join("");
    const images = attachments
      .filter((f) => f.dataUrl)
      .map((f) => ({ name: f.name, dataUrl: f.dataUrl! }));
    const userMessage: Message = {
      id: uid(),
      role: "user",
      content,
      ...(images.length ? { images } : {}),
    };
    const baseChat: Chat = {
      id: active?.id || uid(),
      revision: active?.revision,
      title:
        active?.title ||
        (text || attachments[0]?.name || "图片对话")
          .split("\n")[0]
          .slice(0, 35),
      mode,
      updatedAt: new Date().toISOString(),
      messages: [...messages, userMessage],
    };
    await runCompletion(baseChat, true);
  }

  async function regenerate() {
    if (!active || busy || chatLoading) return;
    const last = active.messages.at(-1);
    const trimmed =
      last?.role === "assistant"
        ? active.messages.slice(0, -1)
        : active.messages;
    if (!trimmed.length) return;
    await runCompletion({ ...active, messages: trimmed });
  }

  async function attachFiles(files: FileList | File[] | null) {
    if (!files?.length || busy) return;
    setAttachmentReads((count) => count + 1);
    try {
      await readAttachments(files);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setAttachmentReads((count) => count - 1);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function readAttachments(files: FileList | File[]) {
    const owner = currentUser.current;
    for (const file of [...files]) {
      if (file.type.startsWith("image/")) {
        if (
          !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
            file.type,
          )
        ) {
          notify("图片支持 PNG、JPEG、WebP 和 GIF 格式");
          continue;
        }
        if (!file.size || file.size > 2 * 1024 * 1024) {
          notify("单张图片需小于 2 MB");
          continue;
        }
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("读取图片失败"));
            reader.readAsDataURL(file);
          });
          if (currentUser.current !== owner) return;
          setAttachments((prev) =>
            [
              ...prev,
              { name: file.name || "粘贴图片.png", content: "", dataUrl },
            ].slice(-4),
          );
        } catch (e) {
          notify((e as Error).message);
        }
        continue;
      }
      if (
        !/\.(md|txt|cpp|cc|c|h|hpp|py|java|js|ts|json|in|out)$/i.test(file.name)
      ) {
        notify("仅支持 Markdown、文本和常见代码文件");
        continue;
      }
      if (file.size > 150000) {
        notify("单个附件需小于 150 KB");
        continue;
      }
      const content = await file.text();
      if (currentUser.current !== owner) return;
      setAttachments((prev) =>
        [...prev, { name: file.name, content }].slice(-4),
      );
    }
  }

  async function attachNote(note: Note) {
    try {
      const file = await api<{ content: string }>(
        `/note?path=${encodeURIComponent(note.path)}`,
      );
      if (file.content.length > 150000)
        throw new Error("笔记过大，请节选内容后发送");
      setAttachments((prev) =>
        [...prev, { name: note.path, content: file.content }].slice(-4),
      );
      setReferenceOpen(false);
      textarea.current?.focus();
    } catch (e) {
      notify((e as Error).message);
    }
  }

  const closePendingNavigation = useCallback(
    () => setPendingNavigation(null),
    [],
  );
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeAuth = useCallback(() => setAuthMode(null), []);
  const closeSearch = useCallback(() => setSearch(false), []);
  const closeDeleteChat = useCallback(() => setDeleteChat(null), []);

  const visibleChats = chats.filter((c) => c.mode === mode);
  const searchedChats = searchChats;
  const searchedNotes = notes.filter((n) =>
    `${n.title} ${n.path} ${n.excerpt}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  return (
    <div className="app-shell">
      {sidebar && (
        <div className="sidebar-scrim" onClick={() => setSidebar(false)} />
      )}
      <aside className={`sidebar ${sidebar ? "open" : ""}`}>
        <div className="brand-wrap">
          <a
            className="brand"
            href="#chat"
            onClick={(e) => {
              e.preventDefault();
              navigate("chat");
            }}
            aria-label="OI 首页"
          >
            <Logo />
            <span className="brand-name">OI</span>
          </a>
          <button
            type="button"
            className="icon-button mobile-close"
            onClick={() => setSidebar(false)}
            aria-label="关闭导航"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>

        <div className="sidebar-top-actions">
          <button className="new-chat" onClick={newChat} disabled={busy}>
            <Plus size={16} />
            <span>新建对话</span>
          </button>
          <button
            className="sidebar-search"
            onClick={() => {
              setSearch(true);
              setQuery("");
            }}
          >
            <Search size={15} />
            <span>搜索</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>

        <nav className="main-nav" aria-label="主导航">
          <button
            className={view === "chat" ? "active" : ""}
            onClick={() => navigate("chat")}
          >
            <MessageSquare size={17} />
            <span>题目讲解</span>
          </button>
          <button
            className={view === "agent" ? "active" : ""}
            onClick={() => navigate("agent")}
          >
            <PenLine size={17} />
            <span>知识创作</span>
          </button>
          <button
            className={view === "library" ? "active" : ""}
            onClick={() => navigate("library")}
          >
            <LibraryBig size={17} />
            <span>共享知识库</span>
            <span className="nav-count">{notes.length}</span>
          </button>
        </nav>

        <div className="sidebar-divider" />
        <div className="nav-label">历史对话</div>
        <div className="history-list">
          {visibleChats.length ? (
            visibleChats.map((c) => (
              <div
                className={`history-item ${c.id === activeId ? "selected" : ""}`}
                key={c.id}
              >
                <button onClick={() => openChat(c)} disabled={busy}>
                  <MessageSquare size={14} />
                  <span>{c.title}</span>
                </button>
                <button
                  className="history-delete"
                  onClick={() => setDeleteChat(c)}
                  disabled={busy}
                  aria-label={`删除对话 ${c.title}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="empty-history">暂无记录</div>
          )}
          {historyNext && (
            <button
              className="secondary-button"
              disabled={historyBusy}
              onClick={() => loadHistory()}
            >
              {historyBusy ? "加载中…" : "加载更早对话"}
            </button>
          )}
        </div>

        <div className="sidebar-bottom">
          <button className="settings-trigger" onClick={openSettings}>
            <i className={config.hasKey ? "connected" : ""} />
            <span>{config.model || "模型配置"}</span>
            <Settings2 size={15} />
          </button>
        </div>
      </aside>

      <main className={`main-panel view-${view}`}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              onClick={() => setSidebar(true)}
              aria-label="打开导航"
            >
              <Menu size={19} />
            </button>
            <span className="breadcrumb-current">
              {view === "chat"
                ? "题目讲解"
                : view === "agent"
                  ? "知识创作"
                  : "共享知识库"}
            </span>
            {active && view !== "library" && (
              <>
                <ChevronRight size={14} />
                <span className="breadcrumb-sub">{active.title}</span>
              </>
            )}
          </div>
          <div className="topbar-actions">
            {!authReady ? (
              <span className="account-status">加载中…</span>
            ) : user ? (
              <>
                <span className="account-name" title={user.username}>
                  <UserRound size={15} />
                  {user.username}
                </span>
                <button
                  className="secondary-button compact-button"
                  disabled={busy || workspaceLoading}
                  onClick={() =>
                    requestNavigation(() => {
                      void logout();
                    })
                  }
                  aria-label="退出登录"
                >
                  <LogOut size={14} />
                  退出
                </button>
              </>
            ) : (
              <>
                <button
                  className="secondary-button compact-button"
                  onClick={() => setAuthMode("login")}
                >
                  登录
                </button>
                <button
                  className="primary-button compact-button"
                  onClick={() => setAuthMode("register")}
                >
                  注册
                </button>
              </>
            )}
          </div>
        </header>

        {view === "library" && (!authReady || !user || workspaceLoading) ? (
          <div className="reader-placeholder guest-library">
            <LibraryBig size={36} />
            <h2>共享知识库</h2>
            <p>
              {!authReady || workspaceLoading
                ? "正在加载学习空间…"
                : "登录后可浏览、编辑所有用户共同维护的笔记。"}
            </p>
            {authReady && !user && (
              <button
                className="primary-button"
                onClick={() => setAuthMode("login")}
              >
                登录后使用
              </button>
            )}
          </div>
        ) : view === "library" ? (
          <Library
            folderPaths={folderPaths}
            notes={notes}
            refresh={refreshNotes}
            notify={notify}
            selectedPath={notePath}
            setSelectedPath={setNotePath}
            onDirtyChange={setLibraryDirty}
            onAsk={(note) => {
              performNavigate("agent");
              setInput(`请读取 ${note.path}，`);
              setTimeout(() => textarea.current?.focus(), 0);
            }}
          />
        ) : (
          <>
            <div
              className={`chat-scroll ${messages.length ? "has-messages" : ""}`}
              ref={chatScroll}
              onScroll={() => {
                const el = chatScroll.current!;
                const isNear =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 140;
                nearBottom.current = isNear;
                setShowScrollBottom(!isNear && messages.length > 0);
              }}
            >
              {chatLoading ? (
                <div className="reader-placeholder" role="status">
                  正在加载对话…
                </div>
              ) : !messages.length ? (
                <div className="welcome">
                  <div className="welcome-heading">
                    <h1>{mode === "agent" ? "知识创作" : "题目讲解"}</h1>
                  </div>
                  {renderComposer()}
                </div>
              ) : (
                <div className="conversation">
                  {messages.length > messageLimit && (
                    <button
                      className="secondary-button"
                      onClick={() => {
                        nearBottom.current = false;
                        setMessageLimit((n) => n + 40);
                      }}
                    >
                      加载更早消息（剩余 {messages.length - messageLimit} 条）
                    </button>
                  )}
                  {messages.slice(-messageLimit).map((m, localIndex) => {
                    const index =
                      Math.max(0, messages.length - messageLimit) + localIndex;
                    return (
                      <div className={`message message-${m.role}`} key={m.id}>
                        {m.role === "assistant" && (
                          <div className="assistant-avatar">
                            <Logo small />
                          </div>
                        )}
                        <div className="message-body">
                          {m.reasoning && (
                            <details className="reasoning-block">
                              <summary>
                                <BrainCircuit size={13} />
                                <span>思考过程</span>
                                <ChevronDown size={12} />
                              </summary>
                              <pre>{m.reasoning}</pre>
                            </details>
                          )}
                          {m.tools && m.tools.length > 0 && (
                            <div className="tool-list">
                              {m.tools.map((t, i) => (
                                <details className="tool-call" key={i}>
                                  <summary>
                                    <span
                                      className={
                                        t.result.startsWith("操作失败")
                                          ? "tool-error"
                                          : ""
                                      }
                                    >
                                      {t.result.startsWith("操作失败") ? (
                                        <CircleAlert size={14} />
                                      ) : (
                                        <Check size={14} />
                                      )}
                                    </span>
                                    <span>
                                      {{
                                        list_files: "浏览知识库",
                                        read_file: "读取文件",
                                        write_file: "保存文件",
                                        edit_file: "修改文件",
                                      }[t.name] || t.name}
                                    </span>
                                    {t.path && (
                                      <button
                                        onClick={(e) => {
                                          e.preventDefault();
                                          if (!busy) openNote(t.path!);
                                        }}
                                      >
                                        {t.path}
                                      </button>
                                    )}
                                    <ChevronDown size={12} />
                                  </summary>
                                  <pre>{t.result}</pre>
                                </details>
                              ))}
                            </div>
                          )}
                          {m.images && m.images.length > 0 && (
                            <div className="message-images">
                              {m.images.map((image, i) => (
                                <img
                                  key={i}
                                  src={image.dataUrl}
                                  alt={image.name}
                                />
                              ))}
                            </div>
                          )}
                          {m.content ? (
                            <Markdown content={m.content} />
                          ) : busy && index === messages.length - 1 ? (
                            <div className="typing-indicator">
                              <span />
                              <span />
                              <span />
                            </div>
                          ) : null}
                          {!busy &&
                            active?.generation?.status !== "running" && (
                              <div className="message-actions">
                                <button
                                  disabled={messageSaving}
                                  onClick={() => {
                                    setEditingMessage(m);
                                    setEditText(m.content);
                                  }}
                                  aria-label="编辑消息"
                                >
                                  <PenLine size={13} />
                                  编辑
                                </button>
                                <button
                                  disabled={messageSaving}
                                  onClick={() => {
                                    if (confirm("确定永久删除这条消息？"))
                                      void changeMessage(m.id, null);
                                  }}
                                  aria-label="删除消息"
                                >
                                  <Trash2 size={13} />
                                  删除
                                </button>
                              </div>
                            )}
                          {m.role === "assistant" &&
                            m.content &&
                            !(busy && index === messages.length - 1) && (
                              <div className="message-actions">
                                <button
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(
                                        m.content,
                                      );
                                      setCopiedId(m.id);
                                      setTimeout(() => setCopiedId(""), 1600);
                                    } catch {
                                      notify("复制失败");
                                    }
                                  }}
                                  aria-label="复制回复"
                                >
                                  {copiedId === m.id ? (
                                    <Check size={13} />
                                  ) : (
                                    <Copy size={13} />
                                  )}
                                  <span>
                                    {copiedId === m.id ? "已复制" : "复制"}
                                  </span>
                                </button>
                                <button
                                  onClick={async () => {
                                    try {
                                      const title =
                                        m.content
                                          .match(/^#\s+(.+)/m)?.[1]
                                          ?.replace(/[<>:"/\\|?*]/g, "")
                                          .slice(0, 60) ||
                                        active?.title
                                          ?.replace(/[<>:"/\\|?*]/g, "")
                                          .slice(0, 60) ||
                                        "对话笔记";
                                      const path = `对话笔记/${title}-${Date.now().toString(36)}.md`;
                                      await api("/note", {
                                        method: "PUT",
                                        body: JSON.stringify({
                                          path,
                                          content: m.content,
                                          createOnly: true,
                                        }),
                                      });
                                      refreshNotes();
                                      notify("已保存到知识库");
                                    } catch (e) {
                                      notify((e as Error).message);
                                    }
                                  }}
                                >
                                  <BookOpen size={13} />
                                  <span>存为笔记</span>
                                </button>
                                {index === messages.length - 1 && (
                                  <button
                                    onClick={regenerate}
                                    aria-label="重新生成"
                                  >
                                    <RotateCcw size={13} />
                                    <span>重试</span>
                                  </button>
                                )}
                              </div>
                            )}
                        </div>
                      </div>
                    );
                  })}
                  {error && (
                    <div className="chat-error" role="alert">
                      <CircleAlert size={16} />
                      <div>
                        <span>{error}</span>
                        <div className="chat-error-actions">
                          <button onClick={regenerate}>
                            <RotateCcw size={12} />
                            重试
                          </button>
                          <button onClick={() => setSettingsOpen(true)}>
                            接口设置
                            <ArrowRight size={12} />
                          </button>
                        </div>
                      </div>
                      <button
                        className="icon-button"
                        onClick={() => setError("")}
                        aria-label="关闭错误"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  <div ref={end} />
                </div>
              )}
            </div>

            {showScrollBottom && (
              <button
                className="scroll-bottom-btn"
                onClick={() => {
                  nearBottom.current = true;
                  setShowScrollBottom(false);
                  end.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "end",
                  });
                }}
                aria-label="滚动到底部"
              >
                <ArrowDown size={15} />
              </button>
            )}

            {messages.length > 0 && (
              <div className="bottom-composer">{renderComposer()}</div>
            )}
          </>
        )}
      </main>

      {editingMessage && (
        <Modal
          title="编辑消息"
          onClose={() => {
            if (!messageSaving) setEditingMessage(null);
          }}
        >
          <textarea
            className="field-input message-editor"
            aria-label="消息内容"
            rows={12}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            disabled={messageSaving}
          />
          <p>保存后，后续对话将使用修改后的内容。已有回复不会自动重新生成。</p>
          <button
            className="primary-button"
            disabled={
              messageSaving ||
              (!editText.trim() && !editingMessage.images?.length)
            }
            onClick={() => void changeMessage(editingMessage.id, editText)}
          >
            保存修改
          </button>
        </Modal>
      )}
      {toast && (
        <div
          className={`toast ${toastKind === "error" ? "toast-error" : ""}`}
          role="status"
        >
          {toastKind === "error" ? (
            <CircleAlert size={15} />
          ) : (
            <Check size={15} />
          )}
          {toast}
        </div>
      )}

      {settingsOpen && (
        <Settings
          key={user?.id}
          initial={config}
          onClose={() => {
            if (currentUser.current === user?.id) closeSettings();
          }}
          onSaved={(next, message) => {
            if (currentUser.current !== user?.id) return;
            setConfig(next);
            notify(message);
          }}
        />
      )}
      {authMode && (
        <Auth
          key={authMode}
          mode={authMode}
          onClose={closeAuth}
          onSwitch={setAuthMode}
          onSuccess={(nextUser) => {
            clearAccount();
            currentUser.current = nextUser.id;
            setApiUser(nextUser.id);
            setWorkspaceLoading(true);
            setUser(nextUser);
            setAuthMode(null);
            notify(authMode === "register" ? "注册成功，已登录" : "登录成功");
          }}
        />
      )}

      {search && (
        <Modal title="全局搜索" onClose={closeSearch}>
          <div className="search-modal">
            <div className="search-input">
              <Search size={16} />
              <input
                autoFocus
                placeholder="输入标题或知识点…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>ESC</kbd>
            </div>
            <div className="search-results">
              <p>
                知识笔记 <span>{searchedNotes.length}</span>
              </p>
              {searchedNotes.map((n) => (
                <button key={n.path} onClick={() => openNote(n.path)}>
                  <FileText size={15} />
                  <span>
                    {n.title}
                    <small>{n.path}</small>
                  </span>
                  <ArrowRight size={14} />
                </button>
              ))}
              <p>
                对话记录 <span>{searchedChats.length}</span>
              </p>
              {searchedChats.map((c) => (
                <button key={c.id} onClick={() => openChat(c)}>
                  <MessageSquare size={15} />
                  <span>
                    {c.title}
                    <small>
                      {c.mode === "agent" ? "知识创作" : "题目讲解"}
                    </small>
                  </span>
                  <ArrowRight size={14} />
                </button>
              ))}
              {searchNext && (
                <button
                  disabled={searchBusy}
                  onClick={() => void loadSearch(searchNext)}
                >
                  {searchBusy ? "加载中…" : "加载更多对话"}
                </button>
              )}
              {!searchBusy &&
                !searchedNotes.length &&
                !searchedChats.length && (
                  <div className="search-empty">无匹配结果</div>
                )}
            </div>
          </div>
        </Modal>
      )}

      {pendingNavigation && (
        <Modal title="未保存的修改" onClose={closePendingNavigation}>
          <div className="confirm-body">
            <p>当前笔记有未保存的修改，是否放弃修改并离开？</p>
            <div className="confirm-actions">
              <button
                className="secondary-button"
                onClick={closePendingNavigation}
              >
                返回编辑
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  setLibraryDirty(false);
                  pendingNavigation();
                  setPendingNavigation(null);
                }}
              >
                放弃修改并离开
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleteChat && (
        <Modal title="删除对话" onClose={closeDeleteChat}>
          <div className="confirm-body">
            <p>{deleteChat.title}</p>
            <div className="confirm-actions">
              <button className="secondary-button" onClick={closeDeleteChat}>
                取消
              </button>
              <button
                className="danger-button"
                onClick={async () => {
                  try {
                    await api(`/chats/${deleteChat.id}`, { method: "DELETE" });
                    setChats((prev) =>
                      prev.filter((c) => c.id !== deleteChat.id),
                    );
                    if (activeId === deleteChat.id) setActiveId(null);
                    setDeleteChat(null);
                    notify("对话已删除");
                  } catch (e) {
                    notify((e as Error).message);
                  }
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );

  function renderComposer() {
    return (
      <div
        className={`composer ${busy ? "generating" : ""} ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          attachFiles(e.dataTransfer.files);
        }}
      >
        {attachments.length > 0 && (
          <div className="attachment-list">
            {attachments.map((f, i) => (
              <span key={`${f.name}-${i}`}>
                {f.dataUrl ? (
                  <img
                    className="attachment-image"
                    src={f.dataUrl}
                    alt={f.name}
                  />
                ) : (
                  <FileText size={13} />
                )}
                {f.name}
                <button
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, n) => n !== i))
                  }
                  disabled={busy}
                  aria-label={`移除附件 ${f.name}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          aria-label={mode === "agent" ? "发送知识创作需求" : "发送题目或问题"}
          placeholder={
            mode === "agent"
              ? "输入要整理或修改的知识点… (Enter 发送，Shift + Enter 换行)"
              : "输入题目、代码或问题… (Enter 发送，Shift + Enter 换行)"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const images = [...e.clipboardData.items]
              .filter(
                (item) =>
                  item.kind === "file" && item.type.startsWith("image/"),
              )
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null);
            if (images.length) {
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              if (text) {
                const { selectionStart, selectionEnd } = e.currentTarget;
                setInput(
                  (prev) =>
                    prev.slice(0, selectionStart) +
                    text +
                    prev.slice(selectionEnd),
                );
              }
              void attachFiles(images);
            }
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy}
          rows={3}
        />
        <div className="composer-toolbar">
          <div className="composer-options">
            <div className={`effort-control ${busy ? "disabled" : ""}`}>
              <div className="effort-heading">
                <span>
                  思考强度 <strong>{effortLevels[effortIndex].label}</strong>
                </span>
                <button
                  type="button"
                  className="effort-reset"
                  onClick={() => changeEffort(0)}
                  disabled={
                    busy || !authReady || workspaceLoading || effortIndex === 0
                  }
                  aria-label="恢复默认思考强度"
                  title="恢复默认"
                >
                  <RotateCcw size={12} />
                </button>
              </div>
              <div
                className="effort-track"
                style={
                  {
                    "--effort-progress": `${(effortIndex / (effortLevels.length - 1)) * 100}%`,
                  } as CSSProperties
                }
              >
                <div className="effort-ticks" aria-hidden="true">
                  {effortLevels.map((level, index) => (
                    <span
                      key={level.value}
                      className={index <= effortIndex ? "active" : ""}
                    />
                  ))}
                </div>
                <input
                  type="range"
                  min={0}
                  max={effortLevels.length - 1}
                  step={1}
                  value={effortIndex}
                  onChange={(e) => changeEffort(Number(e.target.value))}
                  disabled={busy || !authReady || workspaceLoading}
                  aria-label="思考强度"
                  aria-valuetext={effortLevels[effortIndex].label}
                />
              </div>
            </div>
            <div className="reference-control">
              <button
                className={`reference-button ${referenceOpen ? "on" : ""}`}
                aria-label="引用笔记"
                title="引用笔记"
                onClick={() => setReferenceOpen(!referenceOpen)}
                disabled={busy}
              >
                <BookOpen size={14} />
                <span>引用笔记</span>
              </button>
              {referenceOpen && (
                <>
                  <div
                    className="popover-dismiss"
                    onClick={() => setReferenceOpen(false)}
                  />
                  <div className="reference-popover">
                    {notes.length ? (
                      notes.map((n) => (
                        <button key={n.path} onClick={() => attachNote(n)}>
                          <FileText size={14} />
                          <span>{n.path}</span>
                        </button>
                      ))
                    ) : (
                      <p>暂无笔记</p>
                    )}
                  </div>
                </>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,.md,.txt,.cpp,.cc,.c,.h,.hpp,.py,.java,.js,.ts,.json,.in,.out"
              onChange={(e) => attachFiles(e.target.files)}
            />
            <button
              className="reference-button"
              onClick={() => fileInput.current?.click()}
              aria-label="添加图片、文本或代码附件"
              disabled={busy}
            >
              <Paperclip size={14} />
              <span>附件</span>
            </button>
          </div>
          <div className="composer-right">
            <label
              className={`cloud-switch ${busy ? "disabled" : ""}`}
              title="使用服务器网络，关闭网页后继续生成；服务器必须持续运行"
            >
              <input
                type="checkbox"
                aria-label="使用云端"
                checked={cloud}
                disabled={busy}
                onChange={() => {
                  setCloud(!cloud);
                  localStorage.setItem("oi-cloud", cloud ? "0" : "1");
                }}
              />
              <span className="cloud-track" aria-hidden="true">
                <Cloud size={11} className="cloud-track-icon" />
                <span className="cloud-thumb" />
              </span>
              <span className="cloud-label">云端</span>
            </label>
            {config.profiles?.length ? (
              <>
                <select
                  className="model-quick-select"
                  aria-label="快速切换模型"
                  value={JSON.stringify([
                    config.activeModelId || "",
                    config.model,
                  ])}
                  title={switchingModel ? "正在切换模型…" : config.model}
                  disabled={busy || switchingModel || workspaceLoading}
                  onChange={async (e) => {
                    const [activeModelId, model] = JSON.parse(
                      e.target.value,
                    ) as [string, string];
                    if (
                      activeModelId === config.activeModelId &&
                      model === config.model
                    )
                      return;
                    const owner = currentUser.current;
                    setSwitchingModel(true);
                    try {
                      const next = await api<Config>("/settings", {
                        method: "PATCH",
                        body: JSON.stringify({ activeModelId, model }),
                      });
                      if (currentUser.current === owner) setConfig(next);
                    } catch (e) {
                      if (currentUser.current === owner)
                        notify((e as Error).message, "error");
                    } finally {
                      if (currentUser.current === owner)
                        setSwitchingModel(false);
                    }
                  }}
                >
                  {config.profiles.map((p) => (
                    <optgroup key={p.id} label={p.name} disabled={!p.hasKey}>
                      {(p.models || [p.model]).map((model) => (
                        <option
                          key={model}
                          value={JSON.stringify([p.id, model])}
                        >
                          {p.name === model ? model : `${p.name} · ${model}`}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button model-manage"
                  aria-label="管理模型配置"
                  title="管理模型配置"
                  disabled={switchingModel || workspaceLoading}
                  onClick={openSettings}
                >
                  <Settings2 size={15} />
                </button>
              </>
            ) : (
              <button
                className="model-select"
                disabled={workspaceLoading}
                onClick={openSettings}
                title="配置 AI 模型"
              >
                <span>{config.model || "选择模型"}</span>
                <ChevronDown size={12} />
              </button>
            )}
            {busy ? (
              <button
                className="send-button stop"
                onClick={() => {
                  if (active?.generation?.status === "running")
                    void api("/chats/" + active.id + "/stop", {
                      method: "POST",
                    }).catch((e) => notify(e.message));
                  else controller.current?.abort();
                }}
                aria-label="停止生成"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-button"
                onClick={send}
                disabled={
                  (!input.trim() && !attachments.length) ||
                  attachmentReads > 0 ||
                  !authReady ||
                  workspaceLoading ||
                  chatLoading ||
                  switchingModel
                }
                aria-label="发送消息"
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
