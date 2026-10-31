export type View = "chat" | "agent" | "library";
export type User = { id: string; username: string };
export type ReasoningEffort = "default" | "low" | "medium" | "high";
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: { name: string; dataUrl: string }[];
  reasoning?: string;
  tools?: { name: string; path?: string; result: string }[];
};
export type Chat = {
  id: string;
  title: string;
  mode: "chat" | "agent";
  messages: Message[];
  updatedAt: string;
};
export type Note = {
  path: string;
  title: string;
  excerpt: string;
  updatedAt: string;
  size: number;
};
export type LibraryIndex = { notes: Note[]; folders: string[] };
export type Settings = {
  baseUrl: string;
  model: string;
  apiKey: string;
  hasKey?: boolean;
  reasoningEffort?: ReasoningEffort;
};
