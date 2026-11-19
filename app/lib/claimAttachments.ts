import type JSZip from "jszip";

export type AttachmentKey = "payment" | "purchase" | "invoice";
export type StoredFile = { name: string; type: string; blob: Blob };
// Legacy records contain a single invoice. Read both shapes without rewriting the database.
export type ClaimAttachments = {
  payment: StoredFile | null;
  purchase: StoredFile | null;
  invoice: StoredFile | StoredFile[] | null;
};
type FileMeta = { name: string; type: string };
type BackupAttachments = {
  files: Partial<Record<AttachmentKey, string | string[]>>;
  fileMeta: Partial<Record<AttachmentKey, FileMeta | FileMeta[]>>;
};
const keys: AttachmentKey[] = ["payment", "purchase", "invoice"];

export function invoiceFiles<T>(value: T | T[] | null | undefined): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

export function attachmentFiles(attachments: ClaimAttachments, key: AttachmentKey): StoredFile[] {
  return invoiceFiles(attachments[key]);
}

export async function readAttachmentBuffer(file: StoredFile, context: string): Promise<ArrayBuffer> {
  try {
    const buffer = await file.blob.arrayBuffer();
    if (buffer.byteLength !== file.blob.size) throw new Error("Attachment size mismatch");
    return buffer;
  } catch {
    throw new Error(`无法读取${context}「${file.name}」。请重新上传该附件后再试。`);
  }
}

export async function snapshotClaimFile(value: File | StoredFile | null, context: string): Promise<StoredFile | null> {
  if (!value) return null;
  const file = "blob" in value ? value : { name: value.name, type: value.type, blob: value };
  // Copy bytes, rather than retaining a File backed by a movable local source file.
  const buffer = await readAttachmentBuffer(file, context);
  return { name: file.name, type: file.type, blob: new Blob([buffer], { type: file.type }) };
}

export async function backupAttachments(zip: JSZip, id: string, attachments: ClaimAttachments): Promise<BackupAttachments> {
  const files: BackupAttachments["files"] = {};
  const fileMeta: BackupAttachments["fileMeta"] = {};
  for (const key of keys) {
    const values = attachmentFiles(attachments, key);
    if (!values.length) continue;
    const paths: string[] = [];
    for (const [index, file] of values.entries()) {
      // The index prevents same-name invoices from overwriting each other in the ZIP.
      const filename = file.name.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
      const path = `files/${id}/${key}_${index + 1}_${filename}`;
      zip.file(path, await readAttachmentBuffer(file, "备份附件"));
      paths.push(path);
    }
    const metadata = values.map(({ name, type }) => ({ name, type }));
    files[key] = key === "invoice" ? paths : paths[0];
    fileMeta[key] = key === "invoice" ? metadata : metadata[0];
  }
  return { files, fileMeta };
}

export async function restoreAttachments(zip: JSZip, entry: BackupAttachments): Promise<ClaimAttachments> {
  const attachments: ClaimAttachments = { payment: null, purchase: null, invoice: [] };
  for (const key of keys) {
    const paths = invoiceFiles(entry.files?.[key]);
    const metadata = invoiceFiles(entry.fileMeta?.[key]);
    if (paths.length !== metadata.length || (key !== "invoice" && paths.length > 1)) throw new Error("Invalid attachment metadata");
    const restored: StoredFile[] = [];
    for (const [index, path] of paths.entries()) {
      const meta = metadata[index];
      const zipped = typeof path === "string" ? zip.file(path) : null;
      if (!zipped || !meta || typeof meta.name !== "string" || typeof meta.type !== "string") throw new Error("Missing backup attachment");
      restored.push({ ...meta, blob: await zipped.async("blob") });
    }
    if (key === "invoice") attachments.invoice = restored;
    else attachments[key] = restored[0] ?? null;
  }
  return attachments;
}
