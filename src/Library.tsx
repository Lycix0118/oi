import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  Home,
  List,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PenLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "./api";
import { Markdown, Modal } from "./components";
import type { Note } from "./types";

type Props = {
  notes: Note[];
  folderPaths: string[];
  refresh: () => Promise<void>;
  notify: (text: string) => void;
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
  onAsk: (note: Note) => void;
  onDirtyChange: (dirty: boolean) => void;
};
type EditorMode = "read" | "edit" | "split";
type Entry = {
  path: string;
  name: string;
  kind: "folder" | "file";
  note?: Note;
};
type Dialog = "create-file" | "rename-file" | "create-folder" | "rename-folder";

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const joinPath = (folder: string, name: string) =>
  folder ? `${folder}/${name}` : name;
const fileName = (path: string) => path.split("/").at(-1) || path;
const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export default function Library({
  notes,
  folderPaths,
  refresh,
  notify,
  selectedPath,
  setSelectedPath,
  onAsk,
  onDirtyChange,
}: Props) {
  const [query, setQuery] = useState("");
  const searchQuery = useDeferredValue(query.trim().toLowerCase());
  const [folder, setFolder] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("read");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [targetPath, setTargetPath] = useState("");
  const [filename, setFilename] = useState("");
  const [fileError, setFileError] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [entryMenu, setEntryMenu] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [retry, setRetry] = useState(0);
  const readerRef = useRef<HTMLElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const current = notes.find((n) => n.path === selectedPath);
  const dirty = content !== original;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (selectedPath && !notes.some((n) => n.path === selectedPath))
      setSelectedPath(null);
  }, [notes, selectedPath, setSelectedPath]);

  useEffect(() => {
    if (!selectedPath) {
      setContent("");
      setOriginal("");
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setLoadError("");
    setEditorMode("read");
    api<{ content: string }>(`/note?path=${encodeURIComponent(selectedPath)}`, {
      signal: abort.signal,
    })
      .then((data) => {
        setContent(data.content);
        setOriginal(data.content);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setLoadError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [selectedPath, retry]);
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    addEventListener("beforeunload", fn);
    return () => removeEventListener("beforeunload", fn);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!selectedPath) return false;
    setSaving(true);
    try {
      await api("/note", {
        method: "PUT",
        body: JSON.stringify({ path: selectedPath, content }),
      });
      setOriginal(content);
      await refresh();
      notify("已保存");
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [selectedPath, content, refresh, notify]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "s" &&
        (editorMode !== "read" || dirty)
      ) {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    addEventListener("keydown", fn);
    return () => removeEventListener("keydown", fn);
  }, [dirty, editorMode, save, saving]);
  useEffect(() => {
    if (!fullscreen) return;
    const fn = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "Escape") {
        setFullscreen(false);
        return;
      }
      if (e.key === "Tab") {
        const items = [
          ...(readerRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ) || []),
        ];
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    addEventListener("keydown", fn);
    return () => removeEventListener("keydown", fn);
  }, [fullscreen]);
  useEffect(() => {
    if (!selectedPath) setFullscreen(false);
    else setFolder(parentOf(selectedPath));
  }, [selectedPath]);

  function guard(action: () => void) {
    if (dirty) setPending(() => action);
    else action();
  }
  function navigate(next: string) {
    setHistory((h) => [...h, folder]);
    setFuture([]);
    setFolder(next);
    setSelectedPath(null);
  }
  function openNote(note: Note) {
    guard(() => {
      navigate(parentOf(note.path));
      setSelectedPath(note.path);
    });
  }
  function goBack() {
    if (selectedPath) {
      guard(() => {
        setSelectedPath(null);
        setFolder(parentOf(selectedPath));
      });
      return;
    }
    if (!history.length) return;
    const previous = history.at(-1)!;
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [folder, ...f]);
    setFolder(previous);
  }
  function goForward() {
    if (!future.length || selectedPath) return;
    setHistory((h) => [...h, folder]);
    setFolder(future[0]);
    setFuture((f) => f.slice(1));
  }
  function goUp() {
    if (folder) navigate(parentOf(folder));
  }
  function openDialog(type: Dialog, path = "") {
    setDialog(type);
    setTargetPath(path);
    setFileError("");
    setFilename(
      type === "create-file"
        ? joinPath(folder, "新笔记.md")
        : type === "create-folder"
          ? joinPath(folder, "新建文件夹")
          : path,
    );
  }
  const closeDialog = useCallback(() => {
    if (!fileBusy) setDialog(null);
  }, [fileBusy]);
  const closePending = useCallback(() => setPending(null), []);

  const allFolders = useMemo(() => {
    const paths = new Set(folderPaths);
    notes.forEach((note) => {
      const parts = note.path.split("/").slice(0, -1);
      parts.forEach((_, i) => paths.add(parts.slice(0, i + 1).join("/")));
    });
    return [...paths].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [notes, folderPaths]);
  const folders = allFolders.filter((path) => parentOf(path) === folder);
  const entries: Entry[] = searchQuery
    ? notes
        .filter((n) =>
          `${n.path} ${n.title} ${n.excerpt}`
            .toLowerCase()
            .includes(searchQuery),
        )
        .map((note) => ({
          path: note.path,
          name: fileName(note.path),
          kind: "file",
          note,
        }))
    : [
        ...folders.map((path) => ({
          path,
          name: fileName(path),
          kind: "folder" as const,
        })),
        ...notes
          .filter((note) => parentOf(note.path) === folder)
          .map((note) => ({
            path: note.path,
            name: fileName(note.path),
            kind: "file" as const,
            note,
          })),
      ];
  const headings = content
    .replace(/^```[^\n]*\n[\s\S]*?^```/gm, "")
    .split("\n")
    .filter((s) => /^#{2,3} /.test(s))
    .map((s) => ({
      depth: s.startsWith("###") ? 3 : 2,
      title: s.replace(/^#+\s*/, ""),
    }));
  const words = content.replace(/[#*`>\-|]/g, "").replace(/\s/g, "").length;

  function entryActions(entry: Entry) {
    return (
      <div className="entry-actions">
        <button
          aria-label={`${entry.kind === "folder" ? "文件夹" : "文件"}更多操作 ${entry.name}`}
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation();
            setEntryMenu(entryMenu === entry.path ? "" : entry.path);
          }}
        >
          <MoreHorizontal size={17} />
        </button>
        {entryMenu === entry.path && (
          <>
            <div
              className="popover-dismiss"
              onClick={(e) => {
                e.stopPropagation();
                setEntryMenu("");
              }}
            />
            <div className="file-menu" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  openDialog(
                    entry.kind === "folder" ? "rename-folder" : "rename-file",
                    entry.path,
                  );
                  setEntryMenu("");
                }}
              >
                <PenLine size={14} />
                重命名 / 移动
              </button>
              {entry.note && (
                <button
                  onClick={() => {
                    openNote(entry.note!);
                    setEntryMenu("");
                  }}
                >
                  <BookOpen size={14} />
                  打开笔记
                </button>
              )}
              <button
                className="danger-text"
                onClick={() => {
                  guard(() => setDeleting(entry));
                  setEntryMenu("");
                }}
              >
                <Trash2 size={14} />
                删除{entry.kind === "folder" ? "文件夹" : "笔记"}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="library-page">
      <div className="library-workspace">
        {!selectedPath ? (
          <section className="windows-explorer" aria-label="文件资源管理器">
            <div className="explorer-commandbar">
              <div className="new-item-wrap">
                <button
                  className="command-new"
                  onClick={() => guard(() => openDialog("create-file"))}
                >
                  <Plus size={17} />
                  新建
                  <ChevronDown size={13} />
                </button>
                <button
                  className="command-folder"
                  onClick={() => guard(() => openDialog("create-folder"))}
                  title="新建文件夹"
                  aria-label="新建文件夹"
                >
                  <FolderPlus size={17} />
                </button>
              </div>
              <span className="command-divider" />
              <button
                className="command-button"
                onClick={() => importRef.current?.click()}
              >
                <Upload size={16} />
                导入
              </button>
            </div>
            <div className="explorer-navigation">
              <div className="navigation-buttons">
                <button
                  onClick={goBack}
                  disabled={!history.length}
                  aria-label="后退"
                  title="后退"
                >
                  <ArrowLeft size={17} />
                </button>
                <button
                  onClick={goForward}
                  disabled={!future.length}
                  aria-label="前进"
                  title="前进"
                >
                  <ArrowRight size={17} />
                </button>
                <button
                  onClick={goUp}
                  disabled={!folder}
                  aria-label="向上"
                  title="向上"
                >
                  <ArrowUp size={17} />
                </button>
                <button
                  onClick={async () => {
                    await refresh();
                    notify("已刷新");
                  }}
                  aria-label="刷新"
                  title="刷新"
                >
                  <RefreshCw size={16} />
                </button>
              </div>
              <nav className="address-bar" aria-label="当前位置">
                <Home size={15} />
                <button onClick={() => guard(() => navigate(""))}>
                  共享知识库
                </button>
                {folder
                  .split("/")
                  .filter(Boolean)
                  .map((name, i, parts) => (
                    <span
                      className="address-segment"
                      key={parts.slice(0, i + 1).join("/")}
                    >
                      <ChevronRight size={13} />
                      <button
                        onClick={() =>
                          guard(() => navigate(parts.slice(0, i + 1).join("/")))
                        }
                      >
                        {name}
                      </button>
                    </span>
                  ))}
              </nav>
              <div className="explorer-search">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSelectedPath(null);
                  }}
                  placeholder="搜索共享知识库"
                  aria-label="搜索知识文件"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    aria-label="清除文件搜索"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
            <div className="explorer-content">
              <div className="directory-caption">
                <h2>
                  {query
                    ? `“${query}”的搜索结果`
                    : folder
                      ? fileName(folder)
                      : "共享知识库"}
                </h2>
                <div className="directory-view-controls">
                  <span>{entries.length} 个项目</span>
                  <button
                    className={viewMode === "grid" ? "active" : ""}
                    onClick={() => setViewMode("grid")}
                    aria-label="大图标视图"
                    title="大图标"
                  >
                    <Grid2X2 size={16} />
                  </button>
                  <button
                    className={viewMode === "list" ? "active" : ""}
                    onClick={() => setViewMode("list")}
                    aria-label="详细信息视图"
                    title="详细信息"
                  >
                    <List size={17} />
                  </button>
                </div>
              </div>
              {entries.length ? (
                viewMode === "grid" ? (
                  <div className="explorer-grid">
                    {entries.map((entry) => (
                      <div className="explorer-card" key={entry.path}>
                        <button
                          className="explorer-item"
                          onClick={() =>
                            entry.kind === "folder"
                              ? guard(() => navigate(entry.path))
                              : openNote(entry.note!)
                          }
                          title={entry.path}
                        >
                          {entry.kind === "folder" ? (
                            <Folder
                              className="windows-folder-icon"
                              size={62}
                              strokeWidth={1.25}
                              fill="currentColor"
                            />
                          ) : (
                            <div className="markdown-file-icon">
                              <FileText size={52} strokeWidth={1.25} />
                              <span>MD</span>
                            </div>
                          )}
                          <span className="explorer-item-name">
                            {entry.name}
                          </span>
                          {entry.note && (
                            <small>{formatSize(entry.note.size)}</small>
                          )}
                        </button>
                        {entryActions(entry)}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    className="details-table"
                    role="table"
                    aria-label="文件列表"
                  >
                    <div className="details-header" role="row">
                      <span>名称</span>
                      <span>修改日期</span>
                      <span>类型</span>
                      <span>大小</span>
                      <span />
                    </div>
                    {entries.map((entry) => (
                      <div className="details-row" role="row" key={entry.path}>
                        <button
                          className="details-name"
                          onClick={() =>
                            entry.kind === "folder"
                              ? guard(() => navigate(entry.path))
                              : openNote(entry.note!)
                          }
                          title={entry.path}
                        >
                          {entry.kind === "folder" ? (
                            <Folder size={21} fill="currentColor" />
                          ) : (
                            <FileText size={20} />
                          )}
                          <span>{entry.name}</span>
                        </button>
                        <span>
                          {entry.note
                            ? new Date(entry.note.updatedAt).toLocaleString(
                                "zh-CN",
                                { hour12: false },
                              )
                            : "—"}
                        </span>
                        <span>
                          {entry.kind === "folder" ? "文件夹" : "Markdown 文件"}
                        </span>
                        <span>
                          {entry.note ? formatSize(entry.note.size) : "—"}
                        </span>
                        {entryActions(entry)}
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className="folder-placeholder">
                  <FolderOpen size={46} strokeWidth={1.2} />
                  <p>{query ? "没有匹配的项目" : "此文件夹为空"}</p>
                  {!query && (
                    <button
                      className="secondary-button"
                      onClick={() => openDialog("create-file")}
                    >
                      <FilePlus2 size={15} />
                      新建 Markdown 笔记
                    </button>
                  )}
                </div>
              )}
            </div>
            <footer className="explorer-statusbar">
              <span>{entries.length} 个项目</span>
              <span>{query ? "搜索整个知识库" : folder || "共享知识库"}</span>
            </footer>
          </section>
        ) : (
          <section
            className={`reader ${fullscreen ? "is-fullscreen" : ""}`}
            ref={readerRef}
            aria-label="Markdown 文档"
          >
            <div className="reader-toolbar">
              <button
                className="reader-back icon-button"
                onClick={goBack}
                aria-label="返回文件夹"
                title="返回文件夹"
              >
                <ArrowLeft size={17} />
              </button>
              <div className="reader-breadcrumb">
                <FileText size={14} />
                <span>{selectedPath}</span>
                {dirty && <span className="dirty-badge">未保存</span>}
                {current && (
                  <small className="reader-stats">
                    {words.toLocaleString()} 字 ·{" "}
                    {new Date(current.updatedAt).toLocaleDateString("zh-CN")}
                  </small>
                )}
              </div>
              {current && (
                <div className="reader-actions">
                  {(editorMode !== "read" || dirty) && (
                    <button
                      className="primary-button compact-button"
                      onClick={save}
                      disabled={saving || !dirty}
                    >
                      {saving ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Save size={14} />
                      )}
                      保存修改
                    </button>
                  )}
                  <button
                    className="secondary-button compact-button"
                    onClick={() => guard(() => onAsk(current))}
                    title="在知识创作中用 AI 编辑此笔记"
                  >
                    <Sparkles size={13} />
                    AI 编辑
                  </button>
                  <div className="view-switch">
                    <button
                      className={editorMode === "read" ? "active" : ""}
                      onClick={() => setEditorMode("read")}
                    >
                      <BookOpen size={13} />
                      阅读
                    </button>
                    <button
                      className={editorMode === "split" ? "active" : ""}
                      onClick={() => setEditorMode("split")}
                    >
                      <Columns2 size={13} />
                      分屏
                    </button>
                    <button
                      className={editorMode === "edit" ? "active" : ""}
                      onClick={() => setEditorMode("edit")}
                    >
                      <Code2 size={13} />
                      编辑
                    </button>
                  </div>
                  <button
                    className="icon-button"
                    onClick={() => setFullscreen((v) => !v)}
                    aria-label={fullscreen ? "退出全屏" : "全屏查看"}
                    title={fullscreen ? "退出全屏 (Esc)" : "全屏查看"}
                    aria-pressed={fullscreen}
                  >
                    {fullscreen ? (
                      <Minimize2 size={17} />
                    ) : (
                      <Maximize2 size={17} />
                    )}
                  </button>
                  <div className="file-menu-wrap">
                    <button
                      className="icon-button"
                      onClick={() => setMenu(!menu)}
                      aria-label="文件更多操作"
                    >
                      <MoreHorizontal size={17} />
                    </button>
                    {menu && (
                      <>
                        <div
                          className="popover-dismiss"
                          onClick={() => setMenu(false)}
                        />
                        <div className="file-menu">
                          <button
                            onClick={() => {
                              guard(() =>
                                openDialog("rename-file", selectedPath),
                              );
                              setMenu(false);
                            }}
                          >
                            <PenLine size={14} />
                            重命名 / 移动
                          </button>
                          <button
                            onClick={() => {
                              const url = URL.createObjectURL(
                                new Blob([content], {
                                  type: "text/markdown;charset=utf-8",
                                }),
                              );
                              const a = document.createElement("a");
                              a.href = url;
                              a.download = fileName(selectedPath);
                              a.click();
                              setTimeout(() => URL.revokeObjectURL(url), 500);
                              setMenu(false);
                            }}
                          >
                            <ArrowDownToLine size={14} />
                            导出 Markdown
                          </button>
                          <button
                            className="danger-text"
                            onClick={() => {
                              guard(() =>
                                setDeleting({
                                  path: selectedPath,
                                  name: fileName(selectedPath),
                                  kind: "file",
                                  note: current,
                                }),
                              );
                              setMenu(false);
                            }}
                          >
                            <Trash2 size={14} />
                            删除笔记
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
            {loading ? (
              <div className="reader-placeholder">
                <LoaderCircle size={22} className="spin" />
              </div>
            ) : loadError ? (
              <div className="reader-placeholder">
                <p>{loadError}</p>
                <button
                  className="secondary-button"
                  onClick={() => setRetry((n) => n + 1)}
                >
                  重试
                </button>
              </div>
            ) : current ? (
              editorMode !== "read" ? (
                <div
                  className={`editor-layout ${editorMode === "split" ? "is-split" : ""}`}
                >
                  <div className="editor-workspace">
                    <textarea
                      className="markdown-editor"
                      aria-label="Markdown 编辑器"
                      spellCheck={false}
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Tab") {
                          e.preventDefault();
                          const el = e.currentTarget,
                            start = el.selectionStart;
                          setContent(
                            content.slice(0, start) +
                              "    " +
                              content.slice(el.selectionEnd),
                          );
                          requestAnimationFrame(() => {
                            el.selectionStart = el.selectionEnd = start + 4;
                          });
                        }
                      }}
                    />
                    {editorMode === "split" && (
                      <div className="split-preview">
                        <Markdown content={content} />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="article-layout">
                  <article className="article-content">
                    <Markdown content={content} />
                  </article>
                  {headings.length > 0 && (
                    <aside className="article-toc">
                      <div className="toc-header">
                        <List size={13} />
                        目录
                      </div>
                      {headings.map((h, i) => (
                        <button
                          className={h.depth === 3 ? "nested" : ""}
                          key={i}
                          onClick={() => {
                            const target = [
                              ...document.querySelectorAll(
                                ".article-content h2, .article-content h3",
                              ),
                            ].find((el) => el.textContent === h.title);
                            target?.scrollIntoView({
                              behavior: "smooth",
                              block: "start",
                            });
                          }}
                        >
                          {h.title}
                        </button>
                      ))}
                    </aside>
                  )}
                </div>
              )
            ) : (
              <div className="reader-placeholder">
                <p>文件不存在或已被移动</p>
                <button
                  className="secondary-button"
                  onClick={() => setSelectedPath(null)}
                >
                  返回文件夹
                </button>
              </div>
            )}
          </section>
        )}
      </div>
      <input
        type="file"
        ref={importRef}
        hidden
        accept=".md"
        multiple
        onChange={async (e) => {
          for (const file of [...(e.target.files || [])]) {
            if (
              !file.name.toLowerCase().endsWith(".md") ||
              file.size > 500000
            ) {
              notify("仅支持 500 KB 以内的 .md 文件");
              continue;
            }
            try {
              await api("/note", {
                method: "PUT",
                body: JSON.stringify({
                  path: joinPath(folder, file.name),
                  content: await file.text(),
                  createOnly: true,
                }),
              });
              notify(`已导入 ${file.name}`);
            } catch (err) {
              notify((err as Error).message);
            }
          }
          await refresh();
          if (importRef.current) importRef.current.value = "";
        }}
      />
      {dialog && (
        <Modal
          title={
            dialog === "create-file"
              ? "新建笔记"
              : dialog === "create-folder"
                ? "新建文件夹"
                : "重命名 / 移动"
          }
          subtitle={
            dialog.includes("folder")
              ? "文件夹可以包含任意层级的子文件夹和笔记"
              : "使用 / 分隔目录，文件需以 .md 结尾"
          }
          onClose={closeDialog}
        >
          <form
            className="file-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setFileBusy(true);
              setFileError("");
              try {
                if (dialog === "create-folder")
                  await api("/folder", {
                    method: "POST",
                    body: JSON.stringify({ path: filename }),
                  });
                else if (dialog === "rename-folder")
                  await api("/folder/rename", {
                    method: "POST",
                    body: JSON.stringify({
                      path: targetPath,
                      newPath: filename,
                    }),
                  });
                else {
                  await api(
                    dialog === "create-file" ? "/note" : "/note/rename",
                    {
                      method: dialog === "create-file" ? "PUT" : "POST",
                      body: JSON.stringify(
                        dialog === "create-file"
                          ? {
                              path: filename,
                              content: `# ${fileName(filename).replace(/\.md$/i, "")}\n\n`,
                              createOnly: true,
                            }
                          : { path: targetPath, newPath: filename },
                      ),
                    },
                  );
                }
                if (dialog === "rename-folder") {
                  setFolder(filename);
                  setSelectedPath(null);
                }
                await refresh();
                if (dialog === "create-file" || dialog === "rename-file") {
                  setSelectedPath(filename);
                  setFolder(parentOf(filename));
                }
                setDialog(null);
                notify(
                  dialog === "create-file"
                    ? "已创建笔记"
                    : dialog === "create-folder"
                      ? "已创建文件夹"
                      : "已更新路径",
                );
              } catch (err) {
                setFileError((err as Error).message);
              } finally {
                setFileBusy(false);
              }
            }}
          >
            <label>
              {dialog.includes("folder") ? "文件夹路径" : "文件路径"}
              <span>支持多级目录，使用 / 分隔</span>
              <input
                required
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder={
                  dialog.includes("folder")
                    ? "算法/动态规划/背包"
                    : "基础算法/笔记名称.md"
                }
              />
            </label>
            {fileError && (
              <p className="form-error" role="alert">
                {fileError}
              </p>
            )}
            <div className="confirm-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={closeDialog}
              >
                取消
              </button>
              <button className="primary-button" disabled={fileBusy}>
                {fileBusy && <LoaderCircle size={14} className="spin" />}
                {dialog === "create-file"
                  ? "创建笔记"
                  : dialog === "create-folder"
                    ? "创建文件夹"
                    : "保存路径"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={deleting.kind === "folder" ? "删除文件夹" : "删除笔记"}
          onClose={() => {
            if (!deleteBusy) setDeleting(null);
          }}
        >
          <div className="confirm-body">
            <p>{deleting.path}</p>
            {deleting.kind === "folder" && (
              <p className="delete-warning">
                将永久删除此文件夹及其中所有子文件夹和笔记，此操作无法撤销。
              </p>
            )}
            <div className="confirm-actions">
              <button
                className="secondary-button"
                disabled={deleteBusy}
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
              <button
                className="danger-button"
                disabled={deleteBusy}
                onClick={async () => {
                  setDeleteBusy(true);
                  try {
                    if (deleting.kind === "folder")
                      await api(
                        `/folder?path=${encodeURIComponent(deleting.path)}`,
                        { method: "DELETE" },
                      );
                    else
                      await api("/note", {
                        method: "DELETE",
                        body: JSON.stringify({ path: deleting.path }),
                      });
                    if (
                      selectedPath === deleting.path ||
                      selectedPath?.startsWith(`${deleting.path}/`)
                    ) {
                      setContent("");
                      setOriginal("");
                      setSelectedPath(null);
                    }
                    setDeleting(null);
                    await refresh();
                    notify("已删除");
                  } catch (e) {
                    notify((e as Error).message);
                  } finally {
                    setDeleteBusy(false);
                  }
                }}
              >
                {deleteBusy && <LoaderCircle size={14} className="spin" />}
                确认删除
              </button>
            </div>
          </div>
        </Modal>
      )}
      {pending && (
        <Modal title="未保存的修改" onClose={closePending}>
          <div className="confirm-body">
            <div className="confirm-actions">
              <button className="secondary-button" onClick={closePending}>
                返回编辑
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  setContent(original);
                  pending();
                  setPending(null);
                }}
              >
                放弃修改
              </button>
              <button
                className="primary-button"
                disabled={saving}
                onClick={async () => {
                  if (await save()) {
                    pending();
                    setPending(null);
                  }
                }}
              >
                保存并继续
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
