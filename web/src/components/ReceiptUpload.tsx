import { useRef, useState } from 'react';
import { api, ApiError } from '../api';

/**
 * Photographing a slip.
 *
 * A phone camera produces 4-8 MB images, and the server accepts 2 MB. Rather
 * than rejecting the photo and asking someone in a yard to change their camera
 * settings, the image is downscaled and re-encoded here first: longest edge to
 * 1600px, JPEG quality stepped down until it fits.
 *
 * That is enough to read a printed slip number, which is the only thing the
 * image has to prove. A typical result is 150-400 KB, from a 6 MB original.
 */
const MAX_EDGE = 1600;
const TARGET_BYTES = 1_500_000; // aim under the 2 MB ceiling with room to spare
const QUALITY_STEPS = [0.82, 0.72, 0.62, 0.5, 0.4];

export interface UploadedFile {
  id: string;
  size: number;
  mimeType: string;
}

async function optimise(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  // A PDF is passed through untouched; there is nothing to downscale.
  if (file.type === 'application/pdf') {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('Could not read that file'));
      r.readAsDataURL(file);
    });
    return { dataUrl, width: 0, height: 0 };
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not a photograph this browser can read');
  });

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot process images');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  // Step the quality down until it fits. Slips are high contrast, so even the
  // lowest step here stays legible.
  for (const q of QUALITY_STEPS) {
    const dataUrl = canvas.toDataURL('image/jpeg', q);
    const bytes = Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    if (bytes <= TARGET_BYTES) return { dataUrl, width, height };
  }

  throw new Error('That photograph is too large even after compressing. Take it again further from the paper.');
}

export function ReceiptUpload({
  value,
  onChange,
  kind = 'SLIP',
  label = 'Photograph of the slip',
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  kind?: 'RECEIPT' | 'SLIP' | 'INVOICE' | 'OTHER';
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      const original = file.size;
      const { dataUrl, width, height } = await optimise(file);

      const res = await api.uploadAttachment({
        dataUrl,
        filename: file.name || 'slip',
        kind,
        ...(width ? { width, height } : {}),
      });

      onChange(String(res.id));
      setInfo(
        res.reused
          ? 'That exact photograph is already attached elsewhere, so it has been linked rather than stored twice.'
          : `Attached, ${kb(res.size)}${original > res.size * 1.2 ? ` (from ${kb(original)})` : ''}`
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not attach that');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="field">
      <label htmlFor="receipt-file">{label}</label>

      {value ? (
        <div className="receipt-attached">
          <a href={`/api/attachments/${value}`} target="_blank" rel="noreferrer noopener" className="receipt-thumb">
            <img src={`/api/attachments/${value}`} alt="Attached slip" loading="lazy" />
          </a>
          <div className="receipt-meta">
            <span>Attached</span>
            <button type="button" className="btn-link" onClick={() => { onChange(null); setInfo(null); }}>
              Remove
            </button>
          </div>
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            id="receipt-file"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            capture="environment"
            disabled={busy}
            onChange={(e) => void choose(e.target.files?.[0])}
            className="receipt-input"
          />
          <p className="field-hint">
            {busy ? 'Compressing and uploading…' : 'Take a photo or choose a file. Large photos are shrunk automatically.'}
          </p>
        </>
      )}

      {info && <p className="field-hint">{info}</p>}
      {error && <p className="field-hint warn">{error}</p>}
    </div>
  );
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
