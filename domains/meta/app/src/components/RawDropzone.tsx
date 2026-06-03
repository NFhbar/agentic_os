import type React from 'react';
import { useRef, useState } from 'react';

interface UploadResult {
  ok: boolean;
  saved?: string[];
  skipped?: string[];
}

interface Props {
  // Called after a successful upload so the parent can refresh its file list.
  onUploaded?: (savedPaths: string[]) => void;
}

// Drag-and-drop / browse-files zone that uploads to vault/raw/ via the
// /api/curation/upload endpoint. Saved files are added to the curation queue
// server-side; the parent should refresh whatever list it owns after upload.
export function RawDropzone({ onUploaded }: Props) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setMsg(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('file', f, f.name);
      const r = await fetch('/api/curation/upload', { method: 'POST', body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const result = (await r.json()) as UploadResult;
      const saved = result.saved ?? [];
      const skipped = result.skipped ?? [];
      const parts = [`Uploaded ${saved.length} file${saved.length === 1 ? '' : 's'}`];
      if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
      setMsg(parts.join(' · '));
      onUploaded?.(saved);
      setTimeout(() => setMsg(null), 5000);
    } catch (e) {
      setMsg(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    uploadFiles(Array.from(e.dataTransfer.files));
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    uploadFiles(Array.from(e.target.files ?? []));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div
      className={`dropzone${dragging ? ' dragging' : ''}${uploading ? ' uploading' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={onPick}
      />
      <div className="dropzone-body">
        <div className="dropzone-icon" aria-hidden>
          📥
        </div>
        <div>
          <strong>Drop files here</strong> to add to <code>vault/raw/</code>
          <div className="muted" style={{ fontSize: '0.85em', marginTop: 4 }}>
            or{' '}
            <button
              type="button"
              className="dropzone-browse"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              browse files
            </button>
            . Each upload is added to the curation queue for promotion to <code>vault/wiki/</code>.
          </div>
        </div>
      </div>
      {uploading && <div className="dropzone-status">Uploading…</div>}
      {msg && !uploading && (
        <div
          className={msg.startsWith('Upload failed') ? 'dropzone-status err' : 'dropzone-status ok'}
        >
          {msg}
        </div>
      )}
    </div>
  );
}
