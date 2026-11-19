"use client";

import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { attachmentFiles, backupAttachments, invoiceFiles, readAttachmentBuffer, restoreAttachments, snapshotClaimFile, type AttachmentKey, type ClaimAttachments, type StoredFile } from "../lib/claimAttachments";

type ClaimKind = "小额" | "发票";
type ClaimStatus = "待报销" | "已报销";
type Claim = {
  id: string;
  item: string;
  price: number;
  name: string;
  date: string;
  kind: ClaimKind;
  status: ClaimStatus;
  note: string;
  createdAt: string;
  attachments: ClaimAttachments;
};
type ClaimDraft = {
  item: string;
  name: string;
  price: string;
  date: string;
  kind: ClaimKind;
  note: string;
  payment: File | StoredFile | null;
  purchase: File | StoredFile | null;
  invoice: Array<File | StoredFile>;
};

const DB_NAME = "research-workbench-community-claims";
const STORE_NAME = "claims";
const PACKAGE_BASENAME = "科研报销材料";
const BACKUP_VERSION = 2;
const today = () => new Date().toLocaleDateString("sv-SE");
const monthNow = () => today().slice(0, 7);
const emptyDraft = (): ClaimDraft => ({
  item: "",
  name: "",
  price: "",
  date: today(),
  kind: "小额",
  note: "",
  payment: null,
  purchase: null,
  invoice: [],
});

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readClaims(): Promise<Claim[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as Claim[]);
    request.onerror = () => reject(request.error);
  });
}

async function writeClaim(claim: Claim) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(claim);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function writeClaims(claims: Claim[]) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    claims.forEach((claim) => store.put(claim));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function removeClaim(id: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function safeName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
}

function fileExtension(file: StoredFile) {
  const match = file.name.match(/(\.[a-zA-Z0-9]{1,8})$/);
  if (match) return match[1].toLowerCase();
  const extensions: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
  };
  return extensions[file.type] ?? "";
}

function requiredAttachments(kind: ClaimKind): Array<[AttachmentKey, string]> {
  return kind === "小额"
    ? [["payment", "支付记录"], ["purchase", "购买记录"]]
    : [["payment", "支付记录"], ["invoice", "发票"]];
}

function missingLabels(kind: ClaimKind, files: Record<AttachmentKey, unknown> | ClaimDraft) {
  return requiredAttachments(kind).filter(([key]) => invoiceFiles(files[key]).length === 0).map(([, label]) => label);
}

function money(value: number) {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

async function workbookBlob(claims: Claim[]) {
  const XLSX = await import("xlsx");
  const rows = claims.map((claim) => ({
    内容: claim.item,
    "价格（元）": claim.price,
    姓名: claim.name,
    类别: claim.kind,
  }));
  const sheet = XLSX.utils.json_to_sheet(rows, { header: ["内容", "价格（元）", "姓名", "类别"] });
  sheet["!cols"] = [{ wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "报销清单");
  return new Blob([XLSX.write(workbook, { bookType: "xlsx", type: "array" })], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function FileDrop({
  label,
  file,
  onChange,
}: {
  label: string;
  file: File | StoredFile | null;
  onChange: (file: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const received = event.dataTransfer.files?.[0];
    if (received) onChange(received);
  }
  return (
    <div
      className={`claims-file ${file ? "complete" : "missing"} ${dragging ? "dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <input ref={input} type="file" hidden onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
      <button type="button" onClick={() => input.current?.click()}>
        <span>{file ? "✓" : "+"}</span>
        <strong>{label}{!file && <em> 待补</em>}</strong>
        <small>{file ? file.name : "点击或从 Finder 拖入"}</small>
      </button>
      {file && <button className="claims-file-remove" type="button" onClick={() => onChange(null)} aria-label={`移除${label}`}>×</button>}
    </div>
  );
}

function InvoiceDrop({ files, onAdd, onRemove }: {
  files: Array<File | StoredFile>;
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div className="claims-invoices">
      <div
        className={`claims-file ${files.length ? "complete" : "missing"} ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); onAdd(Array.from(event.dataTransfer.files)); }}
      >
        <input ref={input} type="file" multiple hidden aria-label="上传发票（可多选）" onChange={(event) => {
          onAdd(Array.from(event.target.files ?? []));
          event.target.value = "";
        }} />
        <button type="button" onClick={() => input.current?.click()}>
          <span>＋</span>
          <strong>{files.length ? "继续添加发票" : "上传发票"}{!files.length && <em> 待补</em>}</strong>
          <small>支持多选或拖入多张，共用一份支付记录</small>
        </button>
      </div>
      {files.length > 0 && <div className="claims-invoice-list">
        <p aria-live="polite">已添加 {files.length} 张发票</p>
        <ul>{files.map((file, index) => <li key={index}>
          <span title={file.name}>{index + 1}. {file.name}</span>
          <button type="button" onClick={() => onRemove(index)} aria-label={`移除第${index + 1}张发票：${file.name}`}>移除</button>
        </li>)}</ul>
      </div>}
    </div>
  );
}

export function ReimbursementPanel() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [draft, setDraft] = useState<ClaimDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeHidden, setIncludeHidden] = useState(false);
  const [month, setMonth] = useState(monthNow());
  const [kind, setKind] = useState<"全部" | ClaimKind>("全部");
  const [status, setStatus] = useState<"全部" | ClaimStatus>("待报销");
  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [dialogOpener, setDialogOpener] = useState<HTMLElement | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [attachmentAction, setAttachmentAction] = useState<"export" | "backup" | null>(null);
  const [actionError, setActionError] = useState("");
  const restoreRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    readClaims()
      .then((rows) => setClaims(rows.sort((a, b) => b.date.localeCompare(a.date))))
      .catch(() => setNotice("无法读取本地报销数据，请刷新页面。"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!formOpen) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = dialogOpener;
    document.body.style.overflow = "hidden";
    const activeDialog = document.querySelector<HTMLElement>('.claims-editor[role="dialog"]');
    const initialFocusable = activeDialog?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (activeDialog && !activeDialog.contains(document.activeElement)) initialFocusable?.focus();
    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setFormOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>('.claims-editor[role="dialog"]');
      const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')] : [];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleDialogKeys);
      previousFocus?.focus();
    };
  }, [formOpen, dialogOpener]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return claims
      .filter((claim) => !month || claim.date.startsWith(month))
      .filter((claim) => kind === "全部" || claim.kind === kind)
      .filter((claim) => status === "全部" || claim.status === status)
      .filter((claim) => !needle || [claim.item, claim.note].some((value) => value.toLowerCase().includes(needle)));
  }, [claims, month, kind, status, query]);
  const completeVisible = useMemo(() => visible.filter((claim) => missingLabels(claim.kind, claim.attachments).length === 0), [visible]);
  const visibleClaimIds = useMemo(() => new Set(visible.map((claim) => claim.id)), [visible]);
  const hiddenSelected = claims.filter((claim) => selected.has(claim.id) && !visibleClaimIds.has(claim.id));
  const selectedClaims = (includeHidden ? claims : visible).filter((claim) => selected.has(claim.id));
  const allVisibleSelected = visible.length > 0 && visible.every((claim) => selected.has(claim.id));
  const selectedTotal = selectedClaims.reduce((sum, claim) => sum + claim.price, 0);
  const pendingClaims = claims.filter((claim) => claim.status === "待报销" && (!month || claim.date.startsWith(month)));
  const pendingTotal = pendingClaims.reduce((sum, claim) => sum + claim.price, 0);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3_000);
  }

  function updateDraft<K extends keyof ClaimDraft>(key: K, value: ClaimDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!draft.item.trim() || !draft.date || Number(draft.price) <= 0) {
      flash("请填写用品、金额和购买日期。");
      return;
    }
    const existing = editingId ? claims.find((claim) => claim.id === editingId) : undefined;
    setSaving(true);
    setActionError("");
    let attachments: ClaimAttachments;
    try {
      attachments = {
        payment: await snapshotClaimFile(draft.payment, "支付记录"),
        purchase: draft.kind === "小额" ? await snapshotClaimFile(draft.purchase, "购买记录") : null,
        invoice: draft.kind === "发票" ? await Promise.all(draft.invoice.map(async (file, index) => (await snapshotClaimFile(file, `第 ${index + 1} 张发票`))!)) : null,
      };
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "附件读取失败，请重新上传后再保存。");
      setSaving(false);
      return;
    }
    const claim: Claim = {
      id: editingId ?? crypto.randomUUID(),
      item: draft.item.trim(),
      price: Number(draft.price),
      name: draft.name.trim(),
      date: draft.date,
      kind: draft.kind,
      status: existing?.status ?? "待报销",
      note: draft.note.trim(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      attachments,
    };
    try {
      await writeClaim(claim);
    } catch {
      setActionError("报销记录保存失败，请检查浏览器存储空间后重试。");
      return;
    } finally {
      setSaving(false);
    }
    setClaims((current) => [...current.filter((row) => row.id !== claim.id), claim].sort((a, b) => b.date.localeCompare(a.date)));
    setDraft(emptyDraft());
    setEditingId(null);
    setFormOpen(false);
    const missing = missingLabels(claim.kind, claim.attachments);
    flash(missing.length ? `已保存，待补：${missing.join("、")}。` : "已保存到本机报销夹。");
  }

  function edit(claim: Claim) {
    setActionError("");
    setEditingId(claim.id);
    setDraft({
      item: claim.item,
      name: claim.name,
      price: String(claim.price),
      date: claim.date,
      kind: claim.kind,
      note: claim.note,
      payment: claim.attachments.payment,
      purchase: claim.attachments.purchase,
      invoice: invoiceFiles(claim.attachments.invoice),
    });
    setFormOpen(true);
  }

  async function deleteOne(claim: Claim) {
    if (!window.confirm(`确定删除“${claim.item}”及其附件吗？`)) return;
    try {
      await removeClaim(claim.id);
    } catch {
      flash("删除失败，原记录仍保留在本机。");
      return;
    }
    setClaims((current) => current.filter((row) => row.id !== claim.id));
    setSelected((current) => {
      const next = new Set(current);
      next.delete(claim.id);
      return next;
    });
  }

  async function toggleStatus(claim: Claim) {
    const updated: Claim = { ...claim, status: claim.status === "待报销" ? "已报销" : "待报销" };
    try {
      await writeClaim(updated);
    } catch {
      flash("状态更新失败，请刷新后重试。");
      return;
    }
    setClaims((current) => current.map((row) => row.id === claim.id ? updated : row));
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisibleSelection() {
    const visibleIds = visible.map((claim) => claim.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    setSelected((current) => {
      const next = new Set(current);
      visibleIds.forEach((id) => allVisibleSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }

  function selectCompleteVisible() {
    setSelected(new Set(completeVisible.map((claim) => claim.id)));
    setIncludeHidden(false);
    flash(`已选中当前筛选结果中材料完整的 ${completeVisible.length} 项。`);
  }

  function resetHiddenExport() {
    setIncludeHidden(false);
  }

  async function exportSelected() {
    if (!selectedClaims.length || attachmentAction) return;
    setAttachmentAction("export");
    setActionError("");
    try {
      // Read persisted copies instead of stale File references retained by an open editor.
      const persisted = new Map((await readClaims()).map((claim) => [claim.id, claim]));
      const exportClaims = selectedClaims.map((claim) => {
        const current = persisted.get(claim.id);
        if (!current) throw new Error(`「${claim.item}」已不存在，请刷新报销列表后重新选择。`);
        return current;
      });
      const incomplete = exportClaims.filter((claim) => missingLabels(claim.kind, claim.attachments).length);
      const outside = exportClaims.filter((claim) => !visibleClaimIds.has(claim.id));
      const amount = exportClaims.reduce((sum, claim) => sum + claim.price, 0);
      const preview = [
        `将打包 ${exportClaims.length} 项，共 ¥ ${money(amount)}。`,
        outside.length ? `包含筛选外的 ${outside.length} 项：\n${outside.map((claim) => `${claim.date} · ${claim.item} · ¥ ${money(claim.price)}`).join("\n")}` : "",
        incomplete.length ? `其中 ${incomplete.length} 项材料尚未补齐。` : "",
        "确认生成报销包？",
      ].filter(Boolean).join("\n\n");
      if (!window.confirm(preview)) return;
      const [{ default: JSZip }, workbook] = await Promise.all([import("jszip"), workbookBlob(exportClaims)]);
      const zip = new JSZip();
      zip.file("报销清单.xlsx", await workbook.arrayBuffer());
      for (const [index, claim] of exportClaims.entries()) {
        const folder = zip.folder(`${claim.kind}/${String(index + 1).padStart(2, "0")}_${claim.date}_${safeName(claim.item)}`);
        for (const [key, label] of requiredAttachments(claim.kind)) {
          const files = attachmentFiles(claim.attachments, key);
          for (const [fileIndex, file] of files.entries()) {
            const suffix = files.length > 1 ? `-${String(fileIndex + 1).padStart(2, "0")}` : "";
            const data = await readAttachmentBuffer(file, `「${claim.item}」的${label}${suffix}`);
            folder?.file(`${safeName(claim.item)}-${label}${suffix}${fileExtension(file)}`, data);
          }
        }
      }
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${PACKAGE_BASENAME}.zip`);
      window.setTimeout(() => downloadBlob(workbook, `${PACKAGE_BASENAME}.xlsx`), 350);
      flash(`已生成 ${exportClaims.length} 项报销材料。`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "报销包生成失败，请重试。");
    } finally {
      setAttachmentAction(null);
    }
  }

  async function backupAll() {
    if (attachmentAction) return;
    setAttachmentAction("backup");
    setActionError("");
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const manifest = [];
      for (const claim of await readClaims()) {
        const { files, fileMeta } = await backupAttachments(zip, claim.id, claim.attachments);
        const record = {
          id: claim.id,
          item: claim.item,
          price: claim.price,
          name: claim.name,
          date: claim.date,
          kind: claim.kind,
          status: claim.status,
          note: claim.note,
          createdAt: claim.createdAt,
        };
        manifest.push({ ...record, files, fileMeta });
      }
      zip.file("manifest.json", JSON.stringify({ version: BACKUP_VERSION, claims: manifest }, null, 2));
      downloadBlob(await zip.generateAsync({ type: "blob" }), `报销面板_完整备份_${today()}.zip`);
      flash("完整备份已生成。");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "备份生成失败，请重试。");
    } finally {
      setAttachmentAction(null);
    }
  }

  async function restoreBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(file);
      const manifestFile = zip.file("manifest.json");
      if (!manifestFile) throw new Error("missing manifest");
      const manifest = JSON.parse(await manifestFile.async("string"));
      if (![1, BACKUP_VERSION].includes(manifest.version) || !Array.isArray(manifest.claims)) throw new Error("bad version");
      const restored: Claim[] = [];
      for (const entry of manifest.claims) {
        const attachments = await restoreAttachments(zip, entry);
        restored.push({ ...entry, price: Number(entry.price), attachments });
      }
      const invalid = restored.find((claim) => !claim.id || !claim.item || !Number.isFinite(claim.price) || claim.price <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(claim.date) || !["小额", "发票"].includes(claim.kind) || !["待报销", "已报销"].includes(claim.status));
      if (invalid) throw new Error("invalid claim");
      const replaced = restored.filter((claim) => claims.some((current) => current.id === claim.id)).length;
      if (!window.confirm(`将恢复 ${restored.length} 条报销记录，其中 ${replaced} 条同 ID 记录会更新，其余记录会合并加入。继续吗？`)) return;
      await writeClaims(restored);
      setClaims((current) => {
        const merged = new Map(current.map((claim) => [claim.id, claim]));
        restored.forEach((claim) => merged.set(claim.id, claim));
        return [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
      });
      flash(`已恢复 ${restored.length} 条记录。`);
    } catch {
      flash("无法识别该备份，请选择报销夹导出的 ZIP。");
    }
  }

  return (
    <section className="claims-module">
      <div className="module-heading">
        <div>
          <p className="section-kicker">本机凭证抽屉</p>
          <h1>科研报销夹</h1>
          <p>一笔支付可关联多张发票，统一保存并导出报销材料。</p>
        </div>
        <div className="module-actions">
          <button className="quiet-button" type="button" onClick={backupAll} disabled={!claims.length || !!attachmentAction}>{attachmentAction === "backup" ? "正在备份…" : "备份全部"}</button>
          <input ref={restoreRef} type="file" hidden accept=".zip" onChange={restoreBackup} />
          <button className="quiet-button" type="button" onClick={() => restoreRef.current?.click()}>恢复备份</button>
          <button className="action-button" type="button" onClick={(event) => { setActionError(""); setDialogOpener(event.currentTarget); setDraft(emptyDraft()); setEditingId(null); setFormOpen(true); }}>＋ 记一笔</button>
        </div>
      </div>

      {actionError && !formOpen && <p className="claims-operation-error" role="alert">{actionError}</p>}
      {attachmentAction && <p className="claims-operation-status" role="status">{attachmentAction === "export" ? "正在读取附件并生成报销包，请稍候…" : "正在读取附件并生成完整备份，请稍候…"}</p>}
      <div className="claims-summary">
        <label>
          <span>当前抽屉</span>
          <input type="month" value={month} onChange={(event) => { setMonth(event.target.value); resetHiddenExport(); }} />
          <button type="button" className={!month ? "active" : ""} onClick={() => { setMonth(""); setStatus("待报销"); resetHiddenExport(); }}>全部待报销</button>
        </label>
        <div><small>待报销总额</small><strong>¥ {money(pendingTotal)}</strong><span>{pendingClaims.length} 项</span></div>
        <div className="selected"><small>待打包</small><strong>¥ {money(selectedTotal)}</strong><span>{selectedClaims.length} 项</span></div>
        <button type="button" onClick={exportSelected} disabled={!selectedClaims.length || !!attachmentAction}>{attachmentAction === "export" ? "正在生成…" : "生成报销包"}</button>
      </div>

      <div className="list-toolbar">
        <input value={query} onChange={(event) => { setQuery(event.target.value); resetHiddenExport(); }} placeholder="搜索用品或备注" />
        <select aria-label="报销类别" value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); resetHiddenExport(); }}>
          <option>全部</option><option>小额</option><option>发票</option>
        </select>
        <select aria-label="报销状态" value={status} onChange={(event) => { setStatus(event.target.value as typeof status); resetHiddenExport(); }}>
          <option>待报销</option><option>已报销</option><option>全部</option>
        </select>
        <button className="selection-button" type="button" onClick={toggleVisibleSelection} disabled={!visible.length}>{allVisibleSelected ? "取消选择当前结果" : `选择当前 ${visible.length} 项`}</button>
        <button className="selection-button" type="button" onClick={selectCompleteVisible} disabled={!completeVisible.length} title="仅选中当前筛选结果中材料完整的项目，替换原有选择">仅选材料完整（{completeVisible.length} 项）</button>
      </div>

      {hiddenSelected.length > 0 && <details className="claims-operation-status">
        <summary>筛选外已勾选 {hiddenSelected.length} 项 · ¥ {money(hiddenSelected.reduce((total, claim) => total + claim.price, 0))}</summary>
        <label><input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} /> 本次打包包含这些项目</label>
        <ul>{hiddenSelected.map((claim) => <li key={claim.id}>{claim.date} · {claim.item} · ¥ {money(claim.price)}</li>)}</ul>
      </details>}

      <div className="claims-list">
        {loading ? <div className="empty-panel">正在打开本地报销夹…</div> : visible.length === 0 ? (
          <div className="empty-panel"><strong>{claims.length ? "当前条件下没有记录" : "报销夹还是空的"}</strong><span>点击“记一笔”保存第一张凭证。</span></div>
        ) : visible.map((claim) => {
          const missing = missingLabels(claim.kind, claim.attachments);
          return (
            <article className={`claim-card ${selected.has(claim.id) ? "selected" : ""}`} key={claim.id}>
              <input type="checkbox" checked={selected.has(claim.id)} onChange={() => toggleSelected(claim.id)} aria-label={`选择${claim.item}`} />
              <div className="claim-main">
                <div><strong>{claim.item}</strong><span className={`kind-pill ${claim.kind === "发票" ? "invoice" : ""}`}>{claim.kind}</span></div>
                <p>{claim.date} · {claim.name}{claim.note ? ` · ${claim.note}` : ""}</p>
                {missing.length ? <small className="needs-material">待补：{missing.join("、")}</small> : <small className="complete-material">材料完整</small>}
                {claim.kind === "发票" && invoiceFiles(claim.attachments.invoice).length > 0 && <small className="claim-invoice-count"> · {invoiceFiles(claim.attachments.invoice).length} 张发票</small>}
              </div>
              <strong className="claim-price">¥ {money(claim.price)}</strong>
              <div className="claim-actions">
                <button type="button" onClick={() => toggleStatus(claim)}>{claim.status}</button>
                <button type="button" onClick={(event) => { setDialogOpener(event.currentTarget); edit(claim); }}>编辑</button>
                <button type="button" className="danger" onClick={() => deleteOne(claim)}>删除</button>
              </div>
            </article>
          );
        })}
      </div>

      {formOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFormOpen(false); }}>
          <section className="modal-card claims-editor" role="dialog" aria-modal="true" aria-labelledby="claim-title">
            <div className="modal-head">
              <div><p className="section-kicker">本地凭证</p><h2 id="claim-title">{editingId ? "编辑这笔记录" : "今天买了什么？"}</h2></div>
              <button type="button" onClick={() => setFormOpen(false)} aria-label="关闭">×</button>
            </div>
            <form onSubmit={submit}>
              <div className="form-grid">
                <label className="wide"><span>用品名称</span><input autoFocus value={draft.item} onChange={(event) => updateDraft("item", event.target.value)} placeholder="如：15 mL 离心管" /></label>
                <label><span>报销人姓名</span><input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
                <label><span>金额（元）</span><input type="number" min="0.01" step="0.01" value={draft.price} onChange={(event) => updateDraft("price", event.target.value)} /></label>
                <label><span>购买日期</span><input type="date" value={draft.date} onChange={(event) => updateDraft("date", event.target.value)} /></label>
              </div>
              <div className="kind-choice">
                <label><input type="radio" checked={draft.kind === "小额"} onChange={() => updateDraft("kind", "小额")} /> 小额</label>
                <label><input type="radio" checked={draft.kind === "发票"} onChange={() => updateDraft("kind", "发票")} /> 发票</label>
              </div>
              <div className="claims-files">
                <FileDrop label="支付记录" file={draft.payment} onChange={(file) => updateDraft("payment", file)} />
                {draft.kind === "小额" && <FileDrop label="购买记录" file={draft.purchase} onChange={(file) => updateDraft("purchase", file)} />}
                {draft.kind === "发票" && <InvoiceDrop files={draft.invoice}
                  onAdd={(files) => setDraft((current) => ({ ...current, invoice: [...current.invoice, ...files] }))}
                  onRemove={(index) => setDraft((current) => ({ ...current, invoice: current.invoice.filter((_, fileIndex) => fileIndex !== index) }))}
                />}
              </div>
              {missingLabels(draft.kind, draft).length > 0 && <p className="form-warning">可以先保存，之后请补传：{missingLabels(draft.kind, draft).join("、")}</p>}
              <label className="note-field"><span>备注</span><textarea value={draft.note} onChange={(event) => updateDraft("note", event.target.value)} /></label>
              {actionError && <p className="claims-operation-error" role="alert">{actionError}</p>}
              <div className="modal-foot"><span>凭证仅保存在当前浏览器</span><button className="action-button" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存到报销夹"}</button></div>
            </form>
          </section>
        </div>
      )}
      {notice && <div className="toast" role="status">{notice}</div>}
    </section>
  );
}
