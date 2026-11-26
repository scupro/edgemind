import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Download, Eye, FileArchive, FilePlus, FileText, Folder, History, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { zipSync } from "fflate";
import { toast } from "sonner";
import type { FileDTO, FileVersionDTO } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ConfirmDialog, PromptDialog } from "@/components/PromptDialog";
import { FileViewer } from "@/components/FileViewer";
import { api } from "@/lib/api";
import { uploadFile } from "@/lib/upload";

/** Zipping happens in the browser, so keep the whole archive within what a tab can hold comfortably. */
const MAX_ZIP_BYTES = 500 * 1024 ** 2;

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

interface Job {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

/** Project files: browser-direct S3 uploads (multipart for big files), preview / edit text files, versions, download, delete. */
export function FileManager({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<FileDTO[] | null>(null);
  const [folder, setFolder] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [versionsOf, setVersionsOf] = useState<FileDTO | null>(null);
  const [deleting, setDeleting] = useState<FileDTO | null>(null);
  const [viewing, setViewing] = useState<FileDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [drag, setDrag] = useState(false);
  const [zipping, setZipping] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api<FileDTO[]>(`/projects/${projectId}/files`));
    } catch (e) {
      toast.error((e as Error).message);
      setRows([]);
    }
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load]);

  async function upload(list: FileList | File[]) {
    const prefix = folder.trim().replace(/^\/+|\/+$/g, "");
    await Promise.all(
      Array.from(list).map(async (file) => {
        const key = `${file.name}-${Math.random()}`;
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        setJobs((j) => [...j, { key, name: rel, progress: 0 }]);
        try {
          await uploadFile(file, { scope: "project", projectId, path: prefix ? `${prefix}/${rel}` : rel }, (p) =>
            setJobs((j) => j.map((x) => (x.key === key ? { ...x, progress: p } : x))),
          );
          setJobs((j) => j.filter((x) => x.key !== key));
        } catch (e) {
          setJobs((j) => j.map((x) => (x.key === key ? { ...x, error: (e as Error).message } : x)));
        }
      }),
    );
    load();
  }

  async function download(f: FileDTO) {
    try {
      const { url } = await api<{ url: string }>(`/files/${f.id}/download`);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** Download every current project file as one zip. Files come straight from object storage (presigned GET, same CORS as uploads)
   *  and are zipped in the browser, so no platform response-size or memory limit applies on the server side. */
  async function downloadAll() {
    const list = rows ?? [];
    if (!list.length || zipping) return;
    const total = list.reduce((n, f) => n + f.size, 0);
    if (total > MAX_ZIP_BYTES) {
      toast.error(`專案檔案共 ${fmtSize(total)}，超過打包上限 ${fmtSize(MAX_ZIP_BYTES)}，請改為逐一下載`);
      return;
    }
    const tree: Record<string, Uint8Array> = {};
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        setZipping(`${i + 1}/${list.length}`);
        const { url } = await api<{ url: string }>(`/files/${f.id}/download`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${f.path}：下載失敗（HTTP ${res.status}）`);
        tree[f.path] = new Uint8Array(await res.arrayBuffer());
      }
      const zip = zipSync(tree, { level: 6 });
      const href = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = href;
      a.download = "project-files.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setZipping(null);
    }
  }

  const grouped = useMemo(() => {
    const g = new Map<string, FileDTO[]>();
    for (const r of rows ?? []) {
      const dir = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
      (g.get(dir) ?? g.set(dir, []).get(dir)!).push(r);
    }
    return [...g].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>專案檔案</CardTitle>
        <CardDescription>檔案直接從瀏覽器上傳到物件儲存（大檔自動分段）。點檔名可預覽，文字檔（≤ 2 MB）可直接編輯；模型可用 file_* 工具讀寫；每次覆寫都會保留舊版本。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-6 text-sm text-muted-foreground ${drag ? "border-primary bg-primary/5" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <Upload className="h-6 w-6" />
          <span>拖曳檔案到這裡，或</span>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="上傳到資料夾（選填，例如 docs）" className="h-8 w-64" />
            <Button size="sm" onClick={() => input.current?.click()}><Upload /> 選擇檔案</Button>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}><FilePlus /> 新增文字檔</Button>
            {!!rows?.length && <Button size="sm" variant="outline" onClick={downloadAll} disabled={!!zipping} title="把目前所有檔案打包成 zip 下載">{zipping ? <><Loader2 className="animate-spin" /> 打包中 {zipping}</> : <><FileArchive /> 全部打包下載</>}</Button>}
            <Button size="sm" variant="ghost" onClick={load} title="重新整理" aria-label="重新整理"><RefreshCw /></Button>
          </div>
          <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
        </div>

        {jobs.length > 0 && (
          <div className="space-y-2">
            {jobs.map((j) => (
              <div key={j.key} className="text-xs">
                <div className="flex justify-between"><span className="truncate">{j.name}</span><span className={j.error ? "text-destructive" : ""}>{j.error ?? `${Math.round(j.progress * 100)}%`}</span></div>
                {!j.error && <div className="mt-1 h-1.5 rounded bg-muted"><div className="h-1.5 rounded bg-primary transition-all" style={{ width: `${j.progress * 100}%` }} /></div>}
              </div>
            ))}
          </div>
        )}

        {rows === null ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">還沒有檔案。</p>
        ) : (
          <div className="divide-y rounded-md border text-sm">
            {grouped.map(([dir, list]) => (
              <div key={dir || "/"}>
                {dir && <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground"><Folder className="h-3.5 w-3.5" />{dir}/</div>}
                {list.map((f) => (
                  <div key={f.id} className="group flex items-center gap-2 px-3 py-2">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <button className="truncate text-left hover:underline" title={`預覽／編輯 ${f.path}`} onClick={() => setViewing(f)}>{dir ? f.path.slice(dir.length + 1) : f.path}</button>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmtSize(f.size)} · v{f.version}</span>
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="預覽／編輯" aria-label="預覽／編輯" onClick={() => setViewing(f)}><Eye /></Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="下載" aria-label="下載" onClick={() => download(f)}><Download /></Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="版本紀錄" aria-label="版本紀錄" onClick={() => setVersionsOf(f)}><History /></Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title="刪除" aria-label="刪除" onClick={() => setDeleting(f)}><Trash2 /></Button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <FileViewer file={viewing} onClose={() => setViewing(null)} onSaved={load} onDownload={download} />
      <PromptDialog
        open={creating}
        onOpenChange={setCreating}
        title="新增文字檔"
        description="輸入路徑與副檔名，例如 notes/todo.md；上方填了資料夾時會放進該資料夾。"
        placeholder="notes/todo.md"
        confirmLabel="建立"
        onSubmit={async (path) => {
          const prefix = folder.trim().replace(/^\/+|\/+$/g, "");
          const full = prefix && !path.includes("/") ? `${prefix}/${path.trim()}` : path.trim();
          try {
            const f = await api<FileDTO>(`/projects/${projectId}/files/text`, { method: "POST", body: { path: full, text: "" } });
            setCreating(false);
            await load();
            setViewing(f);
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
      <VersionsDialog file={versionsOf} onClose={() => setVersionsOf(null)} onRestored={load} />
      <ConfirmDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} title="刪除檔案？" destructive confirmLabel="刪除"
        description={`「${deleting?.path}」會從專案移除；內容仍保留在版本紀錄中。`}
        onConfirm={async () => {
          await api(`/files/${deleting!.id}`, { method: "DELETE" });
          setDeleting(null);
          load();
        }} />
    </Card>
  );
}

function VersionsDialog({ file, onClose, onRestored }: { file: FileDTO | null; onClose(): void; onRestored(): void }) {
  const [vs, setVs] = useState<FileVersionDTO[] | null>(null);
  useEffect(() => {
    setVs(null);
    if (file) api<FileVersionDTO[]>(`/files/${file.id}/versions`).then(setVs).catch(() => setVs([]));
  }, [file]);
  return (
    <Dialog open={!!file} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>版本紀錄：{file?.path}</DialogTitle></DialogHeader>
        <div className="text-sm">目前版本：v{file?.version}</div>
        {vs === null ? <Loader2 className="h-5 w-5 animate-spin" /> : vs.length === 0 ? <p className="text-sm text-muted-foreground">沒有較舊的版本。</p> : (
          <div className="max-h-80 divide-y overflow-y-auto rounded-md border text-sm">
            {vs.map((v) => (
              <div key={v.version} className="flex items-center gap-2 px-3 py-2">
                <span>v{v.version}</span>
                <span className="text-xs text-muted-foreground">{fmtSize(v.size)} · {new Date(v.createdAt).toLocaleString("zh-TW")}</span>
                <Button size="sm" variant="outline" className="ml-auto" onClick={async () => {
                  try {
                    await api(`/files/${file!.id}/restore`, { method: "POST", body: { version: v.version } });
                    toast.success(`已還原為 v${v.version} 的內容`);
                    onRestored();
                    onClose();
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }}>還原</Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
