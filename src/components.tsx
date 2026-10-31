import {
  isValidElement,
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Copy, X } from "lucide-react";
const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`logo-mark ${small ? "small" : ""}`}>
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="m11 9-7 7 7 7m10-14 7 7-7 7M18.5 6l-5 20"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    const el = ref.current!;
    const focusable = () => [
      ...el.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input, textarea, select, a[href], [tabindex="0"]',
      ),
    ];
    focusable()[0]?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      before?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
      >
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭弹窗"
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  let lang = "CODE";
  if (
    isValidElement<{ className?: string }>(children) &&
    typeof children.props.className === "string"
  ) {
    const match = children.props.className.match(/language-([a-z0-9_+-]+)/i);
    if (match) lang = match[1].toUpperCase();
  }
  return (
    <div className="code-block" ref={ref}>
      <div className="code-toolbar">
        <span>{lang}</span>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                ref.current?.querySelector("code")?.textContent || "",
              );
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            } catch {
              setCopied(false);
            }
          }}
          aria-label="复制代码"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({
  content,
}: {
  content: string;
}) {
  return (
    <Suspense
      fallback={
        <div className="markdown" role="status">
          正在加载文档…
        </div>
      }
    >
      <MarkdownRenderer content={content} />
    </Suspense>
  );
});
