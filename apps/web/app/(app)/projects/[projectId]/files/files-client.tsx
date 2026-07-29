"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronRight, ChevronDown, File, Folder, Loader2, Save } from "lucide-react";
import { apiFetch } from "../../../../../lib/api-client";
import { useTranslation } from "../../../../../lib/i18n/locale-provider";
import { translateApiError } from "../../../../../lib/api-error";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

interface FileEntry {
  name: string;
  isDirectory: boolean;
}

interface TreeNode extends FileEntry {
  path: string;
  expanded: boolean;
  children: TreeNode[] | null;
  loading: boolean;
}

function buildRootNodes(entries: FileEntry[]): TreeNode[] {
  return entries.map((entry) => ({
    ...entry,
    path: entry.name,
    expanded: false,
    children: null,
    loading: false,
  }));
}

function updateNodeAtPath(nodes: TreeNode[], targetPath: string, updater: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) return updater(node);
    if (node.children && targetPath.startsWith(`${node.path}/`)) {
      return { ...node, children: updateNodeAtPath(node.children, targetPath, updater) };
    }
    return node;
  });
}

function TreeView({
  nodes,
  projectId,
  selectedPath,
  onToggle,
  onSelectFile,
}: {
  nodes: TreeNode[];
  projectId: string;
  selectedPath: string | null;
  onToggle: (node: TreeNode) => void;
  onSelectFile: (node: TreeNode) => void;
}) {
  return (
    <div className="flex flex-col">
      {nodes.map((node) => (
        <div key={node.path}>
          <button
            onClick={() => (node.isDirectory ? onToggle(node) : onSelectFile(node))}
            className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px] hover:bg-muted ${
              selectedPath === node.path ? "bg-muted text-foreground" : "text-muted-foreground"
            }`}
          >
            {node.isDirectory ? (
              node.loading ? (
                <Loader2 size={12} className="flex-none animate-spin" />
              ) : node.expanded ? (
                <ChevronDown size={12} className="flex-none" />
              ) : (
                <ChevronRight size={12} className="flex-none" />
              )
            ) : (
              <span className="w-3 flex-none" />
            )}
            {node.isDirectory ? (
              <Folder size={13} strokeWidth={1.75} className="flex-none" />
            ) : (
              <File size={13} strokeWidth={1.75} className="flex-none" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {node.isDirectory && node.expanded && node.children && (
            <div className="ml-3.5 border-l border-border-subtle pl-1.5">
              <TreeView
                nodes={node.children}
                projectId={projectId}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelectFile={onSelectFile}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  php: "php",
  cs: "csharp",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  html: "html",
  css: "css",
  sql: "sql",
};

function guessLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}

export default function FilesClient({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [rootNodes, setRootNodes] = useState<TreeNode[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`/projects/${projectId}/files?path=.`)
      .then((res) => (res.ok ? res.json() : []))
      .then((entries: FileEntry[]) => setRootNodes(buildRootNodes(entries)))
      .catch(() => setRootNodes([]));
  }, [projectId]);

  async function handleToggle(node: TreeNode) {
    if (!node.expanded && !node.children) {
      setRootNodes((prev) => prev && updateNodeAtPath(prev, node.path, (n) => ({ ...n, loading: true })));
      try {
        const res = await apiFetch(`/projects/${projectId}/files?path=${encodeURIComponent(node.path)}`);
        const entries: FileEntry[] = res.ok ? await res.json() : [];
        const children = entries.map((entry) => ({
          ...entry,
          path: `${node.path}/${entry.name}`,
          expanded: false,
          children: null,
          loading: false,
        }));
        setRootNodes(
          (prev) => prev && updateNodeAtPath(prev, node.path, (n) => ({ ...n, children, expanded: true, loading: false })),
        );
      } catch {
        setRootNodes((prev) => prev && updateNodeAtPath(prev, node.path, (n) => ({ ...n, loading: false })));
      }
      return;
    }
    setRootNodes((prev) => prev && updateNodeAtPath(prev, node.path, (n) => ({ ...n, expanded: !n.expanded })));
  }

  async function handleSelectFile(node: TreeNode) {
    setSelectedPath(node.path);
    setLoadingFile(true);
    setError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/files/content?path=${encodeURIComponent(node.path)}`);
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projectFiles.openFileError));
      }
      const data = (await res.json()) as { content: string };
      setContent(data.content);
      setOriginalContent(data.content);
    } catch (err) {
      setContent("");
      setOriginalContent("");
      setError(err instanceof Error ? err.message : t.projectFiles.unknownError);
    } finally {
      setLoadingFile(false);
    }
  }

  async function handleSave() {
    if (!selectedPath) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedPath, content }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(translateApiError(t, body, t.projectFiles.saveError));
      }
      setOriginalContent(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.projectFiles.unknownError);
    } finally {
      setSaving(false);
    }
  }

  const hasChanges = content !== originalContent;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-64 flex-none overflow-y-auto border-r border-border-subtle px-3 py-4">
        {rootNodes === null ? (
          <p className="text-[12.5px] text-muted-foreground">{t.projectFiles.loading}</p>
        ) : rootNodes.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">{t.projectFiles.noFiles}</p>
        ) : (
          <TreeView
            nodes={rootNodes}
            projectId={projectId}
            selectedPath={selectedPath}
            onToggle={handleToggle}
            onSelectFile={handleSelectFile}
          />
        )}
      </aside>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2">
          <p className="truncate font-mono text-[12.5px] text-muted-foreground">{selectedPath ?? t.projectFiles.selectFilePlaceholder}</p>
          <div className="flex items-center gap-3">
            {error && <p className="text-[12px] text-destructive">{error}</p>}
            {selectedPath && (
              <button
                onClick={handleSave}
                disabled={!hasChanges || saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                {t.projectFiles.save}
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {loadingFile ? (
            <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
              {t.projectFiles.loading}
            </div>
          ) : selectedPath ? (
            <MonacoEditor
              key={selectedPath}
              height="100%"
              theme="vs-dark"
              language={guessLanguage(selectedPath)}
              value={content}
              onChange={(value) => setContent(value ?? "")}
              options={{ minimap: { enabled: false }, fontSize: 13 }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
              {t.projectFiles.chooseFilePrompt}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
