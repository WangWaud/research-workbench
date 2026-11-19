"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ReimbursementPanel } from "./ReimbursementPanel";
import { buildBatchLookup, hasConfirmedBoxLocation, isBatchPickable, type BatchLookupItem, type BatchLookupStatus } from "../lib/batchLookup";
import {
  applyBoxLedgerImport,
  BOX_EXPORT_COLUMNS,
  BOX_LEDGER_BASELINE_SHEET,
  BoxExportRecord,
  CONCENTRATION_MATERIAL_TYPES,
  coordinate,
  createNextBoxIdentifier,
  createInitialState,
  downloadFile,
  FreezerBox,
  FrozenSlot,
  isPrimerSequenceReviewed,
  loadWorkbenchState,
  MATERIAL_TYPES,
  mergeWorkbenchStates,
  MaterialType,
  numericPosition,
  normalizeMaterialName,
  pairPrimerRecords,
  planBoxLedgerImport,
  prepareWorkbenchRestore,
  Primer,
  primerQualityIssues,
  primerSequenceReviewSignature,
  ROWS,
  saveWorkbenchState,
  SlotStatus,
  slotKey,
  today,
  WorkbenchState,
} from "../lib/workbench";

type View = "home" | "freezer" | "materials" | "batch" | "primers" | "claims" | "protocols" | "vendors" | "import";
type FreezerView = "grid" | "table";
type PrimerView = "cards" | "table" | "compact";
type PrimerQualityFilter = "全部" | "需核对" | "信息不完整";
type BatchResultFilter = "全部" | "已匹配" | "需核对" | "未找到";
type BatchSelection = { view: "input"; filter: BatchResultFilter } | { view: "route"; filter: "已匹配" };
type WorkspaceDraft = {
  state: WorkbenchState;
  base: WorkbenchState | null;
  failure: string;
  savedAt: string | null;
};
type SlotDraft = { materialType: MaterialType; materialName: string; taxonomy: string; status: FrozenSlot["status"]; storedAt: string; extractedAt: string; concentration: string; note: string };
type InlineSlotPatch = Partial<Pick<FrozenSlot, "materialType" | "materialName" | "taxonomy" | "status" | "storedAt" | "extractedAt" | "concentration" | "note">>;
type PrimerImportField = Exclude<keyof Omit<Primer, "id" | "updatedAt">, "reviewedIssueSignature">;
type PrimerImportRow = { draft: Omit<Primer, "id" | "updatedAt">; providedFields: PrimerImportField[] };
const PAIRED_IMPORT_FIELDS = ["forward", "reverse", "forwardName", "reverseName", "forwardLength", "reverseLength", "forwardTm", "reverseTm"] as const;
type ImportPreview =
  | { kind: "grid"; slots: Array<Pick<FrozenSlot, "row" | "column" | "materialName">>; source: string }
  | { kind: "primers"; primers: PrimerImportRow[]; source: string }
  | { kind: "ledger"; records: BoxExportRecord[]; baseline?: Map<string, BoxExportRecord>; source: string };

const VIEW_LABELS: Record<View, string> = {
  home: "总览",
  freezer: "冰箱与冻存盒",
  materials: "材料库",
  batch: "批量查找",
  primers: "Primer",
  claims: "科研报销夹",
  protocols: "配方与流程",
  vendors: "测序与试剂",
  import: "导入与备份",
};

const NAV_GROUPS: Array<{ label: string; items: Array<{ view: View; mark: string }> }> = [
  { label: "工作台", items: [{ view: "home", mark: "⌂" }] },
  { label: "样本与序列", items: [{ view: "freezer", mark: "▦" }, { view: "materials", mark: "M" }, { view: "primers", mark: "P" }] },
  { label: "实验工具", items: [{ view: "batch", mark: "⌕" }, { view: "protocols", mark: "∑" }, { view: "vendors", mark: "↗" }] },
  { label: "记录与数据", items: [{ view: "claims", mark: "¥" }, { view: "import", mark: "⇅" }] },
];

const MOBILE_NAV: Array<{ view: View; mark: string; label: string }> = [
  { view: "home", mark: "⌂", label: "总览" },
  { view: "materials", mark: "M", label: "材料" },
  { view: "freezer", mark: "▦", label: "冻存盒" },
  { view: "primers", mark: "P", label: "Primer" },
];

function materialTypeClass(type?: MaterialType) {
  const classes: Record<MaterialType, string> = {
    菌株: "type-strain",
    种子: "type-seed",
    cDNA: "type-cdna",
    NRT: "type-nrt",
    RNA: "type-rna",
    DNA: "type-dna",
    Primer: "type-primer",
  };
  return type ? classes[type] : "";
}

function uniqueMaterialCount(slots: FrozenSlot[], type?: MaterialType) {
  return new Set(slots.filter((slot) => !type || slot.materialType === type).map((slot) => `${slot.materialType}\u0000${slot.materialName}`)).size;
}

function materialIndexRows(
  slots: FrozenSlot[],
  boxes: FreezerBox[],
  query: string,
  type: "全部" | MaterialType,
  status: "全部" | SlotStatus,
) {
  const needle = query.trim().toLowerCase();
  const grouped = new Map<string, { name: string; type: MaterialType; tubes: FrozenSlot[] }>();
  slots
    .filter((slot) => type === "全部" || slot.materialType === type)
    .filter((slot) => status === "全部" || slot.status === status)
    .filter((slot) => !needle || slot.materialName.toLowerCase().includes(needle) || slot.taxonomy.toLowerCase().includes(needle) || slot.concentration.toLowerCase().includes(needle))
    .forEach((slot) => {
      const key = `${slot.materialType}\u0000${slot.materialName}`;
      const current = grouped.get(key) ?? { name: slot.materialName, type: slot.materialType, tubes: [] };
      current.tubes.push(slot);
      grouped.set(key, current);
    });
  return [...grouped.values()]
    .map(({ name, type: materialType, tubes }) => ({
      name,
      materialType,
      tubes,
      paths: tubes.map((slot) => {
        const box = boxes.find((item) => item.id === slot.boxId);
        return `${box?.identifier ? `${box.identifier} · ` : ""}${box?.freezer ?? "未定位"} · ${box?.position ?? "—"} · ${box?.name ?? "—"} · ${coordinate(slot.row, slot.column)}（${numericPosition(slot.row, slot.column)}）${slot.concentration ? ` · ${slot.concentration}` : ""}`;
      }),
    }))
    .sort((a, b) => a.materialType.localeCompare(b.materialType, "zh-CN") || a.name.localeCompare(b.name, "zh-CN"));
}

function parseGridMatrix(matrix: unknown[][]) {
  const clean = matrix.map((row) => row.map((cell) => String(cell ?? "").trim()));
  const headerIndex = clean.findIndex((row) => row.slice(1, 10).every((cell, index) => cell === String(index + 1)));
  const dataStart = headerIndex >= 0 ? headerIndex + 1 : 0;
  const slots: Array<Pick<FrozenSlot, "row" | "column" | "materialName">> = [];
  clean.slice(dataStart, dataStart + 9).forEach((row, rowIndex) => {
    const detectedRow = ROWS.includes(row[0]) ? row[0] : ROWS[rowIndex];
    const offset = ROWS.includes(row[0]) ? 1 : 0;
    row.slice(offset, offset + 9).forEach((materialName, columnIndex) => {
      if (materialName) slots.push({ row: detectedRow, column: columnIndex + 1, materialName });
    });
  });
  return slots;
}

function headerIndex(headers: string[], candidates: string[]) {
  return headers.findIndex((header) => candidates.some((candidate) => header.toLowerCase() === candidate.toLowerCase()));
}

function parsePrimerMatrix(matrix: unknown[][]): PrimerImportRow[] {
  if (!matrix.length) return [];
  const headers = matrix[0].map((cell) => String(cell ?? "").trim());
  const name = headerIndex(headers, ["名称", "Primer名称", "引物名称", "name", "primer", "primers"]);
  const sequence = headerIndex(headers, ["Sequence (5'to3')", "Sequence", "序列", "序列（5′→3′）"]);
  const forward = headerIndex(headers, ["Forward", "F", "正向序列", "上游引物", "forward sequence"]);
  const reverse = headerIndex(headers, ["Reverse", "R", "反向序列", "下游引物", "reverse sequence"]);
  if (name < 0 || (sequence < 0 && forward < 0 && reverse < 0)) return [];
  const target = headerIndex(headers, ["靶基因", "target", "target gene"]);
  const organism = headerIndex(headers, ["物种", "材料", "organism"]);
  const purpose = headerIndex(headers, ["用途", "purpose"]);
  const tm = headerIndex(headers, ["Tm", "退火温度"]);
  const productLength = headerIndex(headers, ["产物长度", "扩增子长度", "product length"]);
  const source = headerIndex(headers, ["来源", "source"]);
  const note = headerIndex(headers, ["备注", "note"]);
  const identifier = headerIndex(headers, ["ID", "编号", "identifier"]);
  const length = headerIndex(headers, ["Len", "长度", "length"]);
  const productSizeChromosome = headerIndex(headers, ["product_size_chr", "染色体产物长度"]);
  const productSizeInsertion = headerIndex(headers, ["product_size_ins", "插入产物长度"]);
  const value = (row: unknown[], index: number) => index >= 0 ? String(row[index] ?? "").trim() : "";
  const providedFields = ([
    ["sequence", sequence], ["identifier", identifier], ["length", length], ["productSizeChromosome", productSizeChromosome],
    ["productSizeInsertion", productSizeInsertion], ["forward", forward], ["reverse", reverse], ["target", target],
    ["organism", organism], ["purpose", purpose], ["tm", tm], ["productLength", productLength], ["source", source], ["note", note],
  ] as Array<[PrimerImportField, number]>).filter(([, index]) => index >= 0).map(([field]) => field);
  const rows = matrix.slice(1).map((row) => ({ draft: {
    name: value(row, name),
    sequence: value(row, sequence),
    identifier: value(row, identifier),
    length: value(row, length),
    productSizeChromosome: value(row, productSizeChromosome),
    productSizeInsertion: value(row, productSizeInsertion),
    forward: value(row, forward),
    reverse: value(row, reverse),
    forwardName: "",
    reverseName: "",
    forwardLength: "",
    reverseLength: "",
    forwardTm: "",
    reverseTm: "",
    target: value(row, target),
    organism: value(row, organism),
    purpose: value(row, purpose),
    tm: value(row, tm),
    productLength: value(row, productLength),
    source: value(row, source),
    note: value(row, note),
    reviewedIssueSignature: "",
  }, providedFields })).filter(({ draft }) => draft.name && (draft.sequence || draft.forward || draft.reverse));
  const paired = pairPrimerRecords(rows.map(({ draft }, index) => ({ ...draft, id: String(index), updatedAt: "" })));
  return paired.map(({ id, ...draft }) => {
    if (!id.startsWith("primer-pair:")) return rows[Number(id)];
    return { draft, providedFields: [...new Set([...providedFields, ...PAIRED_IMPORT_FIELDS])] };
  });
}

function parseLedgerMatrix(matrix: unknown[][]): BoxExportRecord[] {
  if (!matrix.length) return [];
  const headers = matrix[0].map((cell) => String(cell ?? "").trim());
  const indexes = {
    ...Object.fromEntries(BOX_EXPORT_COLUMNS.map((column) => [column.key, headers.indexOf(column.label)])),
    boxId: headers.indexOf("内部盒 ID"),
    slotId: headers.indexOf("内部冻存管 ID"),
  } as Record<keyof BoxExportRecord, number>;
  const required = ["recordKey", "boxIdentifier", "coordinate", "occupied", "materialType", "materialName", "taxonomy", "status", "concentration", "storedAt", "extractedAt", "note", "updatedAt"] as const;
  if (required.some((key) => indexes[key] < 0)) throw new Error("台账缺少回导所需的列，请使用近期导出的冻存盒台账。");
  const value = (row: unknown[], key: keyof BoxExportRecord) => indexes[key] >= 0 ? String(row[indexes[key]] ?? "").trim() : "";
  return matrix.slice(1).map((row) => ({
    boxId: value(row, "boxId"),
    slotId: value(row, "slotId"),
    recordKey: value(row, "recordKey"),
    boxIdentifier: value(row, "boxIdentifier"),
    freezer: value(row, "freezer"),
    position: value(row, "position"),
    boxName: value(row, "boxName"),
    coordinate: value(row, "coordinate"),
    numericPosition: Number(value(row, "numericPosition")) || 0,
    occupied: value(row, "occupied") as "是" | "否",
    materialType: value(row, "materialType") as MaterialType | "",
    materialName: value(row, "materialName"),
    taxonomy: value(row, "taxonomy"),
    status: value(row, "status") as SlotStatus | "",
    concentration: value(row, "concentration"),
    storedAt: value(row, "storedAt"),
    extractedAt: value(row, "extractedAt"),
    note: value(row, "note"),
    updatedAt: value(row, "updatedAt"),
  })).filter((record) => record.recordKey || record.boxIdentifier || record.coordinate);
}

function sourceHref(source: string) {
  const url = source.match(/https?:\/\/[^\s·]+/i)?.[0]?.replace(/[),.;]+$/, "");
  if (url) return url;
  const doi = source.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]?.replace(/[),.;]+$/, "");
  return doi ? `https://doi.org/${doi}` : "";
}

function oligoMeta(sequence: string, length: string, tm: string) {
  const actualLength = sequence.replace(/[\s-]+/g, "").length;
  const reportedLength = Number.parseInt(length, 10);
  const lengthLabel = length
    ? Number.isFinite(reportedLength) && actualLength && reportedLength !== actualLength
      ? `标注 ${length} nt · 实际 ${actualLength} nt`
      : `${length} nt`
    : actualLength
      ? `${actualLength} nt（按序列）`
      : "";
  return [lengthLabel, tm && `Tm ${tm}℃`].filter(Boolean).join(" · ");
}

function primerPurposeClass(purpose: string) {
  const normalized = purpose.toLowerCase();
  if (normalized.includes("qpcr")) return "purpose-qpcr";
  if (normalized.includes("genotyp")) return "purpose-genotyping";
  if (normalized.includes("seq")) return "purpose-seq";
  return "purpose-other";
}

function formatLocalTime(value: string | null) {
  if (!value) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

const BATCH_STATUS_META: Record<BatchLookupStatus, { label: string; hint: string; filter: Exclude<BatchResultFilter, "全部"> }> = {
  exact: { label: "精确匹配", hint: "名称完全一致", filter: "已匹配" },
  normalized: { label: "规范化匹配", hint: "仅大小写或字符宽度不同", filter: "已匹配" },
  candidate: { label: "可能匹配", hint: "空格、连字符或下划线不同，需人工确认", filter: "需核对" },
  ambiguous: { label: "多个候选", hint: "命中多个材料名称或类型，需人工确认", filter: "需核对" },
  "not-found": { label: "未找到", hint: "当前材料范围内没有匹配记录", filter: "未找到" },
};
const BATCH_FILTERS: BatchResultFilter[] = ["全部", "已匹配", "需核对", "未找到"];
const PROTOCOL_URL_KEY = "research-workbench-community-protocol-url";
const BATCH_DEFAULT_SELECTION = { view: "input", filter: "全部" } as const;
const BATCH_TABLE_HEADER = ["输入名称", "匹配等级", "匹配名称", "类型", "位置", "材料状态"];
const BATCH_ROUTE_COLLATOR = new Intl.Collator("zh-CN", { numeric: true });

function batchSlotTableRow(input: string, status: string, slot: FrozenSlot, box?: FreezerBox) {
  const hole = `${coordinate(slot.row, slot.column)}（${numericPosition(slot.row, slot.column)}）`;
  const boxLabel = box && box.identifier !== box.name ? `${box.identifier} · ${box.name}` : box?.name;
  const path = [box?.freezer ?? "冰箱未填写", box?.position ?? "架位未填写", boxLabel ?? "冻存盒未填写", hole].join(" → ");
  return [input, status, slot.materialName, slot.materialType, path, slot.status];
}

function parseProtocolUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

export function WorkbenchApp() {
  const [view, setView] = useState<View>("home");
  const [workspace, setWorkspace] = useState<WorkspaceDraft>(() => ({
    state: createInitialState(), base: null, failure: "", savedAt: null,
  }));
  const { state, base, failure: saveFailure, savedAt: lastSavedAt } = workspace;
  const saveStatus = saveFailure ? "error" : !base ? "loading" : state === base ? "saved" : "saving";
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [sessionStartedAt] = useState(() => new Date().getTime());
  const [activeBoxId, setActiveBoxId] = useState("");
  const [focusedSlotId, setFocusedSlotId] = useState("");
  const [protocolUrl, setProtocolUrl] = useState("");
  const [protocolDraft, setProtocolDraft] = useState("");
  const [query, setQuery] = useState("");
  const [boxQuery, setBoxQuery] = useState("");
  const [materialQuery, setMaterialQuery] = useState("");
  const [materialTypeFilter, setMaterialTypeFilter] = useState<"全部" | MaterialType>("全部");
  const [materialStatusFilter, setMaterialStatusFilter] = useState<"全部" | SlotStatus>("全部");
  const [batchText, setBatchText] = useState("");
  const [batchMaterialType, setBatchMaterialType] = useState<"全部" | MaterialType>("菌株");
  const [{ view: batchView, filter: batchResultFilter }, setBatchSelection] = useState<BatchSelection>(BATCH_DEFAULT_SELECTION);
  const [primerQuery, setPrimerQuery] = useState("");
  const [primerPurposeFilter, setPrimerPurposeFilter] = useState("全部");
  const [primerQualityFilter, setPrimerQualityFilter] = useState<PrimerQualityFilter>("全部");
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [selectedCell, setSelectedCell] = useState<{ row: string; column: number } | null>(null);
  const [slotDraft, setSlotDraft] = useState<SlotDraft>({ materialType: "菌株", materialName: "", taxonomy: "", status: "正常", storedAt: "", extractedAt: "", concentration: "", note: "" });
  const [boxManagerOpen, setBoxManagerOpen] = useState(false);
  const [editingBoxId, setEditingBoxId] = useState<string | null>(null);
  const [boxDraft, setBoxDraft] = useState({ identifier: "", freezer: "", position: "", name: "" });
  const [primerEditor, setPrimerEditor] = useState<Primer | null | "new">(null);
  const [freezerView, setFreezerView] = useState<FreezerView>("grid");
  const [primerView, setPrimerView] = useState<PrimerView>("compact");
  const [primerDraft, setPrimerDraft] = useState<Omit<Primer, "id" | "updatedAt">>({
    name: "", sequence: "", identifier: "", length: "", productSizeChromosome: "", productSizeInsertion: "", forward: "", reverse: "", forwardName: "", reverseName: "", forwardLength: "", reverseLength: "", forwardTm: "", reverseTm: "", target: "", organism: "", purpose: "", tm: "", productLength: "", source: "", note: "", reviewedIssueSignature: "",
  });
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importMaterialType, setImportMaterialType] = useState<MaterialType>("菌株");
  const [overwriteImport, setOverwriteImport] = useState(false);
  const [undoEntry, setUndoEntry] = useState<{ label: string; before: WorkbenchState; after: WorkbenchState } | null>(null);
  const [materialLimit, setMaterialLimit] = useState(50);
  const [primerLimit, setPrimerLimit] = useState(20);
  const [dialogOpener, setDialogOpener] = useState<HTMLElement | null>(null);
  const [notice, setNotice] = useState("");
  const restoreRef = useRef<HTMLInputElement>(null);
  const workbookRef = useRef<HTMLInputElement>(null);
  const saveInFlight = useRef(false);

  useEffect(() => {
    loadWorkbenchState()
      .then((stored) => {
        setWorkspace({ state: stored, base: stored, failure: "", savedAt: null });
        setActiveBoxId(stored.boxes[0]?.id ?? "");
        setLastBackupAt(window.localStorage.getItem("research-workbench-community-last-backup"));
      })
      .catch(() => {
        setWorkspace((current) => ({ ...current, failure: "无法读取本机主数据。请重新读取后再编辑。" }));
      });
  }, []);

  function setState(update: WorkbenchState | ((state: WorkbenchState) => WorkbenchState)) {
    setWorkspace((current) => current.base && !current.failure
      ? { ...current, state: typeof update === "function" ? update(current.state) : update }
      : current);
  }

  async function reloadSavedWorkspace() {
    if (base && !window.confirm("重新读取会舍弃本页未保存的修改。继续吗？")) return;
    try {
      const stored = await loadWorkbenchState();
      setWorkspace({ state: stored, base: stored, failure: "", savedAt: null });
      setUndoEntry(null);
      setActiveBoxId(stored.boxes[0]?.id ?? "");
      setSelectedCell(null);
      setBoxManagerOpen(false);
      setPrimerEditor(null);
      setImportPreview(null);
      flash("已读取本机保存的数据。");
    } catch {
      flash("读取失败。本页修改仍可导出。");
    }
  }

  useEffect(() => {
    const url = parseProtocolUrl(window.localStorage.getItem(PROTOCOL_URL_KEY) ?? "");
    if (url) {
      window.setTimeout(() => {
        setProtocolUrl(url);
        setProtocolDraft(url);
      }, 0);
    }
    const savedFreezerView = window.localStorage.getItem("research-workbench-community-freezer-view");
    if (savedFreezerView === "grid" || savedFreezerView === "table") {
      window.setTimeout(() => setFreezerView(savedFreezerView), 0);
    }
    const savedView = window.localStorage.getItem("research-workbench-community-primer-view");
    if (savedView === "cards" || savedView === "table" || savedView === "compact") {
      window.setTimeout(() => setPrimerView(savedView), 0);
    }
  }, []);

  useEffect(() => {
    if (!base || state === base || saveFailure || saveInFlight.current) return;
    const timer = window.setTimeout(async () => {
      saveInFlight.current = true;
      try {
        const result = await saveWorkbenchState(base, state);
        saveInFlight.current = false;
        const savedAt = new Date().toISOString();
        setWorkspace((current) => {
          if (!result.ok) {
            return { ...current, failure: `保存冲突：${result.conflicts.slice(0, 6).join("、")}。` };
          }
          if (current.state === state) {
            return { state: result.state, base: result.state, savedAt, failure: "" };
          }
          const rebased = mergeWorkbenchStates(state, current.state, result.state);
          return rebased.ok
            ? { state: rebased.state, base: result.state, savedAt, failure: "" }
            : { ...current, base: state, savedAt, failure: `保存冲突：${rebased.conflicts.slice(0, 6).join("、")}。` };
        });
      } catch {
        saveInFlight.current = false;
        setWorkspace((current) => ({ ...current, failure: "本机保存失败。" }));
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [state, base, saveFailure]);

  useEffect(() => {
    if (!selectedCell && !boxManagerOpen && !primerEditor) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = dialogOpener;
    document.body.style.overflow = "hidden";
    const activeDialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const initialFocusable = activeDialog?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])');
    if (activeDialog && !activeDialog.contains(document.activeElement)) initialFocusable?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (primerEditor) setPrimerEditor(null);
        else if (boxManagerOpen) setBoxManagerOpen(false);
        else setSelectedCell(null);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])')] : [];
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
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus();
    };
  }, [selectedCell, boxManagerOpen, primerEditor, dialogOpener]);

  const activeBox = state.boxes.find((box) => box.id === activeBoxId) ?? state.boxes[0];
  const slotLookup = useMemo(() => new Map(state.slots.map((slot) => [slotKey(slot.boxId, slot.row, slot.column), slot])), [state.slots]);
  const activeSlots = state.slots.filter((slot) => slot.boxId === activeBox?.id);
  const activePositionSet = useMemo(() => new Set(activeSlots.map((slot) => numericPosition(slot.row, slot.column))), [activeSlots]);
  const materialRows = useMemo(
    () => materialIndexRows(state.slots, state.boxes, materialQuery, materialTypeFilter, materialStatusFilter),
    [state.slots, state.boxes, materialQuery, materialTypeFilter, materialStatusFilter],
  );
  const batchResults = useMemo(() => {
    const all = buildBatchLookup(batchText, state.slots, batchMaterialType);
    const results: Record<BatchResultFilter, BatchLookupItem[]> = { 全部: all, 已匹配: [], 需核对: [], 未找到: [] };
    for (const result of all) results[BATCH_STATUS_META[result.status].filter].push(result);
    return results;
  }, [batchText, state.slots, batchMaterialType]);
  const visibleBatchResults = batchResults[batchResultFilter];
  const batchBoxesById = useMemo(() => new Map(state.boxes.map((box) => [box.id, box])), [state.boxes]);
  const batchRouteGroups = useMemo(() => {
    type RouteEntry = { inputs: Set<string>; statuses: Set<BatchLookupStatus>; slot: FrozenSlot };
    const groups = new Map<string, { box: FreezerBox; entries: Map<string, RouteEntry> }>();
    for (const result of batchResults.已匹配) {
      for (const slot of result.slots) {
        const box = batchBoxesById.get(slot.boxId);
        if (!box || !isBatchPickable(slot, box)) continue;
        const group = groups.get(box.id) ?? { box, entries: new Map<string, RouteEntry>() };
        const key = slotKey(box.id, slot.row, slot.column);
        const entry = group.entries.get(key) ?? { inputs: new Set<string>(), statuses: new Set<BatchLookupStatus>(), slot };
        entry.inputs.add(result.input);
        entry.statuses.add(result.status);
        group.entries.set(key, entry);
        groups.set(box.id, group);
      }
    }
    const compare = BATCH_ROUTE_COLLATOR.compare;
    return [...groups.values()]
      .sort(({ box: a }, { box: b }) => compare(a.freezer, b.freezer)
        || compare(a.position, b.position) || compare(a.name, b.name) || compare(a.identifier, b.identifier))
      .map(({ box, entries }) => ({
        box,
        entries: [...entries.values()]
          .sort((a, b) => numericPosition(a.slot.row, a.slot.column) - numericPosition(b.slot.row, b.slot.column))
          .map(({ inputs, statuses, slot }) => ({ inputs: [...inputs], statuses: [...statuses], slot })),
      }));
  }, [batchResults, batchBoxesById]);
  const batchTubeCount = batchRouteGroups.reduce((count, group) => count + group.entries.length, 0);
  const canExportBatch = batchView === "route" ? batchTubeCount > 0 : visibleBatchResults.length > 0;
  const primerPurposeOptions = useMemo(() => [...new Set(state.primers.map((primer) => primer.purpose).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [state.primers]);
  const primerRows = state.primers.filter((primer) => {
    const issues = primerQualityIssues(primer);
    const needle = primerQuery.trim().toLowerCase();
    const matchesQuery = !needle || Object.values(primer).some((value) => String(value).toLowerCase().includes(needle));
    const matchesPurpose = primerPurposeFilter === "全部" || primer.purpose === primerPurposeFilter;
    const matchesQuality = primerQualityFilter === "全部"
      || (primerQualityFilter === "需核对" && issues.some((issue) => issue.category === "sequence") && !isPrimerSequenceReviewed(primer))
      || (primerQualityFilter === "信息不完整" && issues.some((issue) => issue.category === "metadata"));
    return matchesQuery && matchesPurpose && matchesQuality;
  });
  const primerPairCount = state.primers.filter((primer) => primer.forward && primer.reverse).length;
  const primerPurposeCount = new Set(state.primers.map((primer) => primer.purpose).filter(Boolean)).size;
  const primerSequenceIssueRecords = state.primers.filter((primer) => primerQualityIssues(primer).some((issue) => issue.category === "sequence") && !isPrimerSequenceReviewed(primer));
  const primerMissingSourceCount = state.primers.filter((primer) => !primer.source.trim()).length;
  const pendingBoxes = state.boxes.filter((box) => !hasConfirmedBoxLocation(box));
  const pendingSlots = state.slots.filter((slot) => slot.status === "待核对");
  const primerDraftSequenceIssues = primerQualityIssues(primerDraft).filter((issue) => issue.category === "sequence");
  const primerDraftReviewed = isPrimerSequenceReviewed(primerDraft);
  const lastBackupDays = lastBackupAt ? Math.floor((sessionStartedAt - new Date(lastBackupAt).getTime()) / 86_400_000) : null;
  const backupNeedsAttention = lastBackupDays === null || lastBackupDays >= 7;
  const attentionTotal = pendingBoxes.length + pendingSlots.length + primerSequenceIssueRecords.length + (backupNeedsAttention ? 1 : 0);
  const ledgerImportPlan = useMemo(
    () => importPreview?.kind === "ledger" ? planBoxLedgerImport(importPreview.records, state, importPreview.baseline) : null,
    [importPreview, state],
  );
  const gridImportSummary = useMemo(() => {
    if (importPreview?.kind !== "grid" || !activeBox) return null;
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    for (const imported of importPreview.slots) {
      const existing = slotLookup.get(slotKey(activeBox.id, imported.row, imported.column));
      if (!existing) {
        added += 1;
        continue;
      }
      if (!overwriteImport) {
        skipped += 1;
        continue;
      }
      const materialType = imported.materialName.includes("(NRT)") ? "NRT" as MaterialType : existing.materialType;
      const materialName = normalizeMaterialName(imported.materialName, materialType);
      if (materialName === existing.materialName && materialType === existing.materialType) unchanged += 1;
      else updated += 1;
    }
    return { added, updated, unchanged, skipped };
  }, [importPreview, activeBox, slotLookup, overwriteImport]);
  const primerImportSummary = useMemo(() => {
    if (importPreview?.kind !== "primers") return null;
    const primerKey = (primer: Pick<Primer, "name" | "sequence" | "forward" | "reverse">) => [primer.name, primer.sequence, primer.forward, primer.reverse].join("\u0000");
    const existing = new Map(state.primers.map((primer) => [primerKey(primer), primer]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const row of importPreview.primers) {
      const current = existing.get(primerKey(row.draft));
      if (!current) added += 1;
      else if (row.providedFields.some((field) => current[field] !== row.draft[field])) updated += 1;
      else unchanged += 1;
    }
    return { added, updated, unchanged };
  }, [importPreview, state.primers]);
  const concentrationCoverage = useMemo(() => {
    const relevant = state.slots.filter((slot) => CONCENTRATION_MATERIAL_TYPES.has(slot.materialType));
    return { total: relevant.length, filled: relevant.filter((slot) => slot.concentration.trim()).length };
  }, [state.slots]);
  const exactPrimerDuplicateCount = useMemo(() => {
    const signatures = new Map<string, number>();
    for (const primer of state.primers) {
      const signature = [primer.name, primer.sequence, primer.forward, primer.reverse, primer.target, primer.purpose, primer.source, primer.note].map((value) => value.trim().toLowerCase()).join("\u0000");
      signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
    }
    return [...signatures.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
  }, [state.primers]);
  const globalMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const boxes = state.boxes
      .filter((box) => [box.identifier, box.freezer, box.position, box.name].some((value) => value.toLowerCase().includes(needle)))
      .slice(0, 4)
      .map((box) => ({ kind: "box" as const, box, type: "冻存盒", title: `${box.identifier} · ${box.name}`, detail: `${box.freezer} → ${box.position} → ${state.slots.filter((slot) => slot.boxId === box.id).length} / 81 孔已用` }));
    const materials = state.slots
      .filter((slot) => {
        const box = state.boxes.find((item) => item.id === slot.boxId);
        const haystack = [slot.materialName, slot.materialType, slot.taxonomy, slot.status, slot.concentration, coordinate(slot.row, slot.column), String(numericPosition(slot.row, slot.column)), box?.identifier, box?.freezer, box?.position, box?.name]
          .filter(Boolean).join(" ").toLowerCase();
        return haystack.includes(needle);
      })
      .slice(0, 6)
      .map((slot) => {
        const box = state.boxes.find((item) => item.id === slot.boxId);
      return { kind: "material" as const, slot, type: slot.materialType, title: slot.materialName, detail: `${box?.identifier ? `${box.identifier} · ` : ""}${box?.freezer ?? "冰箱未填写"} → ${box?.position ?? "架位未填写"} → ${box?.name ?? "冻存盒未填写"} → ${coordinate(slot.row, slot.column)}（${numericPosition(slot.row, slot.column)}）${slot.concentration ? ` · ${slot.concentration}` : ""}` };
      });
    const primers = state.primers
      .filter((primer) => Object.values(primer).some((value) => String(value).toLowerCase().includes(needle)))
      .slice(0, 4)
      .map((primer) => ({ kind: "primer" as const, primer, type: "Primer", title: primer.name, detail: primer.target || primer.purpose || "Primer记录" }));
    return [...boxes, ...materials, ...primers];
  }, [query, state.slots, state.primers, state.boxes]);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3_000);
  }

  function commitWithUndo(label: string, update: (current: WorkbenchState) => WorkbenchState) {
    const next = update(state);
    setUndoEntry({ label, before: state, after: next });
    setState(next);
  }

  function undoLastChange() {
    if (!undoEntry) return;
    const result = mergeWorkbenchStates(undoEntry.after, undoEntry.before, state);
    if (!result.ok) {
      flash(`无法撤销，以下记录已发生其他修改：${result.conflicts.slice(0, 4).join("、")}。`);
      return;
    }
    setState(result.state);
    setUndoEntry(null);
    flash(`已撤销：${undoEntry.label}。`);
  }

  function goToView(nextView: View) {
    setView(nextView);
    setMobileToolsOpen(false);
  }

  function locateBatchSlot(slot: FrozenSlot) {
    setActiveBoxId(slot.boxId);
    setFocusedSlotId(slot.id);
    setBoxQuery("");
    setSelectedCell(null);
    goToView("freezer");
    flash(`已定位到 ${slot.materialName}：${coordinate(slot.row, slot.column)}。`);
  }

  function selectBatchFilter(filter: BatchResultFilter) {
    if (batchView === "route" && filter === "已匹配") return;
    setBatchSelection({ view: "input", filter });
  }

  function changeBatchText(value: string) {
    setBatchText(value);
    if (!value.trim()) setBatchSelection(BATCH_DEFAULT_SELECTION);
  }

  function batchTableRows() {
    if (batchView === "route") {
      return batchRouteGroups.flatMap(({ box, entries }) => entries.map(({ inputs, statuses, slot }) => (
        batchSlotTableRow(inputs.join("、"), statuses.map((status) => BATCH_STATUS_META[status].label).join("、"), slot, box)
      )));
    }
    return visibleBatchResults.flatMap(({ input, status, slots }) => {
      const label = BATCH_STATUS_META[status].label;
      if (!slots.length) return [[input, label, "", "", "", ""]];
      return slots.map((slot) => batchSlotTableRow(input, label, slot, batchBoxesById.get(slot.boxId)));
    });
  }

  async function copyBatchResults() {
    if (!canExportBatch) return;
    const rows = batchTableRows();
    const lines = [BATCH_TABLE_HEADER, ...rows].map((row) => row.join("\t"));
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      flash(`已复制 ${rows.length} 行结果。`);
    } catch {
      flash("复制失败，请使用 CSV 导出。");
    }
  }

  function exportBatchResults() {
    if (!canExportBatch) return;
    const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [BATCH_TABLE_HEADER, ...batchTableRows()];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    downloadFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), `科研工作台_批量查找_${today()}.csv`);
    flash("批量查找结果已导出。");
  }

  async function copySequence(sequence: string, label: string) {
    try {
      await navigator.clipboard.writeText(sequence);
      flash(`已复制${label}原始序列。`);
    } catch {
      flash("复制失败，请手动选择序列。");
    }
  }

  function changePrimerView(nextView: PrimerView) {
    setPrimerView(nextView);
    setPrimerLimit(20);
    window.localStorage.setItem("research-workbench-community-primer-view", nextView);
  }

  function changeFreezerView(nextView: FreezerView) {
    setFreezerView(nextView);
    window.localStorage.setItem("research-workbench-community-freezer-view", nextView);
  }

  function updateSlotFromTable(row: string, column: number, patch: InlineSlotPatch, suggestedType: MaterialType) {
    if (!activeBox) return;
    const key = slotKey(activeBox.id, row, column);
    const visibleSlot = slotLookup.get(key);
    if (patch.materialName !== undefined && !patch.materialName.trim()) {
      if (visibleSlot) flash("如需清空整支管，请点击孔位进入详情后使用“清空孔位”。");
      return;
    }
    setFocusedSlotId(visibleSlot?.id ?? "");
    setState((current) => {
      const existing = current.slots.find((slot) => slotKey(slot.boxId, slot.row, slot.column) === key);
      if (!existing && !patch.materialName?.trim()) return current;
      const materialType = patch.materialType ?? existing?.materialType ?? suggestedType;
      const materialName = normalizeMaterialName(patch.materialName ?? existing?.materialName ?? "", materialType);
      const slot: FrozenSlot = {
        id: existing?.id ?? crypto.randomUUID(),
        boxId: activeBox.id,
        row,
        column,
        materialType,
        materialName,
        taxonomy: materialType === "菌株" ? patch.taxonomy?.trim() ?? existing?.taxonomy ?? "" : "",
        status: patch.status ?? existing?.status ?? "正常",
        storedAt: patch.storedAt?.trim() ?? existing?.storedAt ?? "",
        extractedAt: patch.extractedAt?.trim() ?? existing?.extractedAt ?? "",
        concentration: CONCENTRATION_MATERIAL_TYPES.has(materialType) ? patch.concentration?.trim() ?? existing?.concentration ?? "" : "",
        note: patch.note?.trim() ?? existing?.note ?? "",
        updatedAt: new Date().toISOString(),
      };
      return { ...current, slots: [...current.slots.filter((item) => item.id !== slot.id), slot] };
    });
  }

  function blurOnEnter(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") event.currentTarget.blur();
  }

  function openCell(row: string, column: number, preferredType?: MaterialType) {
    if (!activeBox) return;
    const existing = slotLookup.get(slotKey(activeBox.id, row, column));
    setFocusedSlotId(existing?.id ?? "");
    setSelectedCell({ row, column });
    setSlotDraft(existing ? {
      materialType: existing.materialType,
      materialName: existing.materialName,
      taxonomy: existing.taxonomy,
      status: existing.status,
      storedAt: existing.storedAt,
      extractedAt: existing.extractedAt,
      concentration: existing.concentration,
      note: existing.note,
    } : { materialType: preferredType ?? "菌株", materialName: "", taxonomy: "", status: "正常", storedAt: "", extractedAt: "", concentration: "", note: "" });
  }

  function openSearchMatch(match: (typeof globalMatches)[number]) {
    if (match.kind === "box") {
      setActiveBoxId(match.box.id);
      setBoxQuery("");
      setFocusedSlotId("");
      setQuery("");
      goToView("freezer");
      return;
    }
    if (match.kind === "primer") {
      setPrimerQuery(match.primer.name);
      setQuery("");
      goToView("primers");
      return;
    }
    const slot = match.slot;
    setActiveBoxId(slot.boxId);
    setFocusedSlotId(slot.id);
    setBoxQuery("");
    setQuery("");
    goToView("freezer");
    setSelectedCell(null);
    flash(`已定位到 ${slot.materialName}：${coordinate(slot.row, slot.column)}。`);
  }

  function openPendingSlot(slot: FrozenSlot) {
    setActiveBoxId(slot.boxId);
    setFocusedSlotId(slot.id);
    setSelectedCell({ row: slot.row, column: slot.column });
    setSlotDraft({ materialType: slot.materialType, materialName: slot.materialName, taxonomy: slot.taxonomy, status: slot.status, storedAt: slot.storedAt, extractedAt: slot.extractedAt, concentration: slot.concentration, note: slot.note });
    goToView("freezer");
  }

  function saveSlot(event: FormEvent) {
    event.preventDefault();
    if (!activeBox || !selectedCell || !slotDraft.materialName.trim()) return;
    const key = slotKey(activeBox.id, selectedCell.row, selectedCell.column);
    const existing = slotLookup.get(key);
    const slot: FrozenSlot = {
      id: existing?.id ?? crypto.randomUUID(),
      boxId: activeBox.id,
      row: selectedCell.row,
      column: selectedCell.column,
      materialType: slotDraft.materialType,
      materialName: normalizeMaterialName(slotDraft.materialName, slotDraft.materialType),
      taxonomy: slotDraft.materialType === "菌株" ? slotDraft.taxonomy.trim() : "",
      status: slotDraft.status,
      storedAt: slotDraft.storedAt,
      extractedAt: slotDraft.extractedAt,
      concentration: CONCENTRATION_MATERIAL_TYPES.has(slotDraft.materialType) ? slotDraft.concentration.trim() : "",
      note: slotDraft.note.trim(),
      updatedAt: new Date().toISOString(),
    };
    setState((current) => ({ ...current, slots: [...current.slots.filter((item) => item.id !== slot.id), slot] }));
    setSelectedCell(null);
    flash(`正在保存 ${coordinate(slot.row, slot.column)} 的 ${slot.materialName}。`);
  }

  function markSlotReviewed() {
    if (!activeBox || !selectedCell) return;
    const key = slotKey(activeBox.id, selectedCell.row, selectedCell.column);
    const existing = slotLookup.get(key);
    if (!existing) return;
    setState((current) => ({ ...current, slots: current.slots.map((slot) => slot.id === existing.id ? { ...slot, status: "正常", updatedAt: new Date().toISOString() } : slot) }));
    setSelectedCell(null);
    flash(`${existing.materialName} 已标记为核对完成。`);
  }

  function clearSlot() {
    if (!activeBox || !selectedCell) return;
    const existing = slotLookup.get(slotKey(activeBox.id, selectedCell.row, selectedCell.column));
    if (!existing || !window.confirm(`清空 ${coordinate(selectedCell.row, selectedCell.column)} 中的“${existing.materialName}”？`)) return;
    commitWithUndo(`清空 ${activeBox.identifier}:${coordinate(selectedCell.row, selectedCell.column)}`, (current) => ({ ...current, slots: current.slots.filter((slot) => slot.id !== existing.id) }));
    setSelectedCell(null);
  }

  function saveProtocolUrl(event: FormEvent) {
    event.preventDefault();
    const input = protocolDraft.trim();
    const url = parseProtocolUrl(input);
    if (input && !url) {
      flash("请输入有效的 HTTP 或 HTTPS 地址，网址中请勿包含用户名和密码。");
      return;
    }
    try {
      if (url) window.localStorage.setItem(PROTOCOL_URL_KEY, url);
      else window.localStorage.removeItem(PROTOCOL_URL_KEY);
    } catch {
      flash("未能保存链接，请检查浏览器存储权限。");
      return;
    }
    setProtocolDraft(url);
    setProtocolUrl(url);
    flash(url ? "配方链接已保存在当前浏览器。" : "已清除配方链接。");
  }

  function startNewBox() {
    setEditingBoxId(null);
    setBoxDraft({ identifier: createNextBoxIdentifier(state.boxes), freezer: activeBox?.freezer ?? "", position: "", name: "" });
  }

  function startEditBox(box: FreezerBox) {
    setEditingBoxId(box.id);
    setBoxDraft({ identifier: box.identifier, freezer: box.freezer, position: box.position, name: box.name });
  }

  function saveBox(event: FormEvent) {
    event.preventDefault();
    if (!boxDraft.identifier.trim() || !boxDraft.freezer.trim() || !boxDraft.position.trim() || !boxDraft.name.trim()) return;
    const duplicate = state.boxes.some((box) => box.id !== editingBoxId && box.identifier.toLowerCase() === boxDraft.identifier.trim().toLowerCase());
    if (duplicate) {
      flash(`盒标识符“${boxDraft.identifier.trim()}”已被使用，请更换。`);
      return;
    }
    const box: FreezerBox = { id: editingBoxId ?? crypto.randomUUID(), identifier: boxDraft.identifier.trim(), freezer: boxDraft.freezer.trim(), position: boxDraft.position.trim(), name: boxDraft.name.trim(), rows: 9, columns: 9 };
    setState((current) => ({ ...current, boxes: editingBoxId ? current.boxes.map((item) => item.id === box.id ? box : item) : [...current.boxes, box] }));
    setActiveBoxId(box.id);
    setEditingBoxId(box.id);
    flash(editingBoxId ? "冻存盒信息已更新。" : "新冻存盒已建立。 ");
  }

  function deleteBox(box: FreezerBox) {
    const tubeCount = state.slots.filter((slot) => slot.boxId === box.id).length;
    if (!window.confirm(`删除“${box.name}”及其中 ${tubeCount} 个孔位记录？删除后可在本次页面中撤销。`)) return;
    const remaining = state.boxes.filter((item) => item.id !== box.id);
    commitWithUndo(`删除冻存盒 ${box.identifier}`, (current) => ({ ...current, boxes: current.boxes.filter((item) => item.id !== box.id), slots: current.slots.filter((slot) => slot.boxId !== box.id) }));
    if (activeBoxId === box.id) setActiveBoxId(remaining[0]?.id ?? "");
    if (editingBoxId === box.id) startNewBox();
    flash(`已删除“${box.name}”及其整盒位置记录。`);
  }

  function openPrimer(primer?: Primer) {
    setPrimerEditor(primer ?? "new");
    setPrimerDraft(primer ? {
      name: primer.name, sequence: primer.sequence, identifier: primer.identifier, length: primer.length, productSizeChromosome: primer.productSizeChromosome, productSizeInsertion: primer.productSizeInsertion,
      forward: primer.forward, reverse: primer.reverse, forwardName: primer.forwardName, reverseName: primer.reverseName, forwardLength: primer.forwardLength, reverseLength: primer.reverseLength, forwardTm: primer.forwardTm, reverseTm: primer.reverseTm, target: primer.target, organism: primer.organism,
      purpose: primer.purpose, tm: primer.tm, productLength: primer.productLength, source: primer.source, note: primer.note, reviewedIssueSignature: primer.reviewedIssueSignature,
    } : { name: "", sequence: "", identifier: "", length: "", productSizeChromosome: "", productSizeInsertion: "", forward: "", reverse: "", forwardName: "", reverseName: "", forwardLength: "", reverseLength: "", forwardTm: "", reverseTm: "", target: "", organism: "", purpose: "", tm: "", productLength: "", source: "", note: "", reviewedIssueSignature: "" });
  }

  function savePrimer(event: FormEvent) {
    event.preventDefault();
    if (!primerDraft.name.trim()) return;
    const existing = primerEditor !== "new" ? primerEditor : null;
    const primer: Primer = { ...primerDraft, name: primerDraft.name.trim(), id: existing?.id ?? crypto.randomUUID(), updatedAt: new Date().toISOString() };
    setState((current) => ({ ...current, primers: [...current.primers.filter((item) => item.id !== primer.id), primer] }));
    setPrimerEditor(null);
    const qualityWarnings = primerQualityIssues(primer).filter((issue) => issue.category === "sequence");
    flash(qualityWarnings.length && !isPrimerSequenceReviewed(primer) ? `Primer 已保存，并标记 ${qualityWarnings.length} 项需核对。` : "Primer 已保存。");
  }

  function togglePrimerReviewed(primer: Primer) {
    const reviewed = isPrimerSequenceReviewed(primer);
    setState((current) => ({ ...current, primers: current.primers.map((item) => item.id === primer.id ? {
      ...item,
      reviewedIssueSignature: reviewed ? "" : primerSequenceReviewSignature(item),
      updatedAt: new Date().toISOString(),
    } : item) }));
    flash(reviewed ? `${primer.name} 已重新标记为需核对。` : `${primer.name} 已标记为人工核对完成。`);
  }

  function deletePrimer(primer: Primer) {
    if (!window.confirm(`删除 Primer“${primer.name}”？`)) return;
    commitWithUndo(`删除 Primer ${primer.name}`, (current) => ({ ...current, primers: current.primers.filter((item) => item.id !== primer.id) }));
  }

  function previewPastedGrid() {
    if (!activeBox) {
      flash("请先建立用于接收盒表的冻存盒。");
      return;
    }
    const matrix = importText.trim().split(/\r?\n/).map((line) => line.split(/\t|,/));
    const slots = parseGridMatrix(matrix);
    if (!slots.length) {
      flash("没有识别到 9×9 盒表，请保留行列标题后再粘贴。");
      return;
    }
    setImportPreview({ kind: "grid", slots, source: "粘贴的 9×9 表格" });
  }

  async function previewWorkbook(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer());
      const ledgerSheetName = workbook.SheetNames.find((name) => name === "全部孔位" || name === "孔位明细");
      if (ledgerSheetName) {
        const ledgerMatrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[ledgerSheetName], { header: 1, raw: false });
        const records = parseLedgerMatrix(ledgerMatrix);
        if (!records.length) throw new Error("no ledger rows");
        const baselineSheet = workbook.Sheets[BOX_LEDGER_BASELINE_SHEET];
        const originals = baselineSheet ? parseLedgerMatrix(XLSX.utils.sheet_to_json<unknown[]>(baselineSheet, { header: 1, raw: false })) : undefined;
        if (originals?.some((row) => !row.boxId || !["是", "否"].includes(row.occupied) || (row.occupied === "是" && !row.slotId))) {
          throw new Error("台账的原始值工作表不完整，请重新导出台账。");
        }
        const baseline = originals && new Map(originals.map((row) => [row.recordKey.toLowerCase(), row]));
        if (baseline?.size !== originals?.length) throw new Error("台账的原始值工作表存在重复孔位。");
        setImportPreview({ kind: "ledger", records, baseline, source: `${file.name} · ${ledgerSheetName}` });
        return;
      }
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
      const primers = parsePrimerMatrix(matrix);
      if (primers.length) setImportPreview({ kind: "primers", primers, source: file.name });
      else {
        const slots = parseGridMatrix(matrix);
        if (!slots.length) throw new Error("no rows");
        if (!activeBox) {
          flash("请先建立用于接收盒表的冻存盒。");
          return;
        }
        setImportPreview({ kind: "grid", slots, source: file.name });
      }
    } catch (error) {
      flash(error instanceof Error && error.message.startsWith("台账") ? error.message : "无法识别该表格。可使用工作台导出的孔位明细、9×9 盒表，或包含名称与序列的 Primer 表。");
    }
  }

  function applyImport() {
    if (!importPreview) return;
    if (importPreview.kind === "ledger") {
      if (!ledgerImportPlan || ledgerImportPlan.errors.length) return;
      if (!ledgerImportPlan.actions.length) {
        flash("孔位明细与当前工作台一致，没有需要写入的变化。");
        setImportPreview(null);
        return;
      }
      commitWithUndo(`回导 ${ledgerImportPlan.actions.length} 项冻存盒变更`, (current) => applyBoxLedgerImport(current, ledgerImportPlan));
      flash(`正在保存 ${ledgerImportPlan.actions.length} 项回导变更。`);
    } else if (importPreview.kind === "primers") {
      commitWithUndo(`导入 ${importPreview.primers.length} 条 Primer`, (current) => {
        const primerKey = (primer: Pick<Primer, "name" | "sequence" | "forward" | "reverse">) => [primer.name, primer.sequence, primer.forward, primer.reverse].join("\u0000");
        const byIdentity = new Map(current.primers.map((primer) => [primerKey(primer), primer.id]));
        const byId = new Map(current.primers.map((primer) => [primer.id, primer]));
        importPreview.primers.forEach(({ draft, providedFields }) => {
          const key = primerKey(draft);
          const id = byIdentity.get(key) ?? crypto.randomUUID();
          const existing = byId.get(id);
          const patch = Object.fromEntries(providedFields.map((field) => [field, draft[field]])) as Partial<Primer>;
          byIdentity.set(key, id);
          byId.set(id, existing
            ? { ...existing, ...patch, updatedAt: new Date().toISOString() }
            : { ...draft, id, updatedAt: new Date().toISOString() });
        });
        return { ...current, primers: [...byId.values()] };
      });
      flash(`Primer 导入完成：新增 ${primerImportSummary?.added ?? 0}，更新 ${primerImportSummary?.updated ?? 0}，未变化 ${primerImportSummary?.unchanged ?? 0}。`);
    } else if (activeBox) {
      commitWithUndo(`导入 ${activeBox.identifier} 的 9×9 盒表`, (current) => {
        const byPosition = new Map(current.slots.map((slot) => [slotKey(slot.boxId, slot.row, slot.column), slot]));
        for (const imported of importPreview.slots) {
          const key = slotKey(activeBox.id, imported.row, imported.column);
          const existing = byPosition.get(key);
          if (existing && !overwriteImport) continue;
          const materialType = imported.materialName.includes("(NRT)") ? "NRT" as MaterialType : existing?.materialType ?? importMaterialType;
          const materialName = normalizeMaterialName(imported.materialName, materialType);
          byPosition.set(key, existing ? {
            ...existing,
            materialType,
            materialName,
            taxonomy: materialType === "菌株" ? existing.taxonomy : "",
            concentration: CONCENTRATION_MATERIAL_TYPES.has(materialType) ? existing.concentration : "",
            updatedAt: new Date().toISOString(),
          } : {
            id: crypto.randomUUID(), boxId: activeBox.id, row: imported.row, column: imported.column,
            materialType, materialName, taxonomy: "", status: "正常", storedAt: "", extractedAt: "", concentration: "", note: "", updatedAt: new Date().toISOString(),
          });
        }
        return { ...current, slots: [...byPosition.values()] };
      });
      flash(`盒表导入完成：新增 ${gridImportSummary?.added ?? 0}，更新 ${gridImportSummary?.updated ?? 0}，跳过 ${gridImportSummary?.skipped ?? 0}。原有日期、浓度、状态和备注已保留。`);
    }
    setImportPreview(null);
  }

  function exportBackup() {
    downloadFile(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }), `科研工作台_备份_${today()}.json`);
    const backupAt = new Date().toISOString();
    window.localStorage.setItem("research-workbench-community-last-backup", backupAt);
    setLastBackupAt(backupAt);
    flash("完整备份已下载。");
  }

  async function exportFreezerBoxes(boxes: FreezerBox[]) {
    if (!boxes.length) return;
    try {
      const { createFreezerWorkbookBytes } = await import("../lib/freezerWorkbook.ts");
      const bytes = createFreezerWorkbookBytes(boxes, state.slots);
      const scope = boxes.length === 1 ? `${boxes[0].identifier}_${boxes[0].name}` : "全部冻存盒";
      const safeScope = scope.replace(/[\\/:*?"<>|]/g, "_");
      downloadFile(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `科研工作台_${safeScope}_${today()}.xlsx`);
      flash(boxes.length === 1 ? `已导出 ${boxes[0].identifier} 的完整盒信息。` : `已导出全部 ${boxes.length} 个冻存盒。`);
    } catch {
      flash("冻存盒导出失败，请刷新页面后重试。");
    }
  }

  async function restoreBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const prepared = prepareWorkbenchRestore(JSON.parse(await file.text()));
      if (!prepared.ok) {
        flash(`备份校验未通过：${prepared.issues.slice(0, 3).join("；")}`);
        return;
      }
      const restored = prepared.state;
      if (!window.confirm(`恢复后将以备份中的 ${restored.boxes.length} 个冻存盒、${restored.slots.length} 个孔位和 ${restored.primers.length} 条 Primer 替换当前工作台。继续吗？`)) return;
      commitWithUndo(`恢复备份 ${file.name}`, () => restored);
      setActiveBoxId(restored.boxes[0]?.id ?? "");
      flash("已读取工作台备份，正在保存。");
    } catch {
      flash("无法识别该备份文件。");
    }
  }

  function renderImportPreview() {
    if (!importPreview) return null;
    const title = importPreview.kind === "grid"
      ? `${importPreview.slots.length} 个非空孔位`
      : importPreview.kind === "primers"
        ? `${importPreview.primers.length} 条 Primer`
        : `${importPreview.records.length} 行孔位明细`;
    const ledgerCounts = ledgerImportPlan ? {
      add: ledgerImportPlan.actions.filter((action) => action.kind === "add").length,
      update: ledgerImportPlan.actions.filter((action) => action.kind === "update").length,
      clear: ledgerImportPlan.actions.filter((action) => action.kind === "clear").length,
    } : null;
    const primerFlagged = importPreview.kind === "primers"
      ? importPreview.primers.filter(({ draft }) => primerQualityIssues(draft).some((issue) => issue.category === "sequence"))
      : [];
    const blocked = importPreview.kind === "ledger" && Boolean(ledgerImportPlan?.errors.length);

    return <div className={`import-preview ${blocked ? "has-errors" : ""}`}>
      <div>
        <p className="section-kicker">导入预览 · {importPreview.source}</p>
        <h2>{title}</h2>
        {importPreview.kind === "grid" && <>
          <p>将写入 {activeBox?.identifier} · {activeBox?.name}。覆盖已有孔位时只更新名称和明确的 NRT 类型，原有状态、浓度、日期与备注均保留。</p>
          <div className="import-diff"><span>新增 <b>{gridImportSummary?.added ?? 0}</b></span><span>更新 <b>{gridImportSummary?.updated ?? 0}</b></span><span>跳过 <b>{gridImportSummary?.skipped ?? 0}</b></span><span>未变化 <b>{gridImportSummary?.unchanged ?? 0}</b></span></div>
        </>}
        {importPreview.kind === "primers" && <>
          <p>名称与序列均相同的 Primer 只更新表格实际提供的列；未提供的靶标、用途、来源和备注不会被清空。</p>
          <p>分行的单条序列需要有同一名称前缀和唯一的一组明确 F/R 标记才会组成一对。</p>
          <div className="import-diff"><span>新增 <b>{primerImportSummary?.added ?? 0}</b></span><span>更新 <b>{primerImportSummary?.updated ?? 0}</b></span><span>未变化 <b>{primerImportSummary?.unchanged ?? 0}</b></span></div>
          {primerFlagged.length ? <div className="import-quality-warning"><strong>{primerFlagged.length} 条需核对</strong><span>{primerFlagged.slice(0, 5).map(({ draft }) => draft.name).join("、")}{primerFlagged.length > 5 ? "…" : ""}</span></div> : <div className="import-quality-ok">序列格式检查未发现问题</div>}
        </>}
        {importPreview.kind === "ledger" && ledgerCounts && <>
          <p>{importPreview.baseline ? "对照导出原值与工作台现值，只回导本次编辑的字段。" : "这份旧台账缺少导出原值。已变更的孔位需要重新导出核对。"}</p>
          <div className="import-diff"><span>新增 <b>{ledgerCounts.add}</b></span><span>更新 <b>{ledgerCounts.update}</b></span><span>清空 <b>{ledgerCounts.clear}</b></span><span>未变化 <b>{ledgerImportPlan?.unchanged ?? 0}</b></span></div>
          {ledgerImportPlan?.errors.length ? <div className="import-error-list"><strong>{ledgerImportPlan.errors.length} 项错误，修正后再导入</strong>{ledgerImportPlan.errors.slice(0, 6).map((issue) => <span key={issue}>{issue}</span>)}</div> : <div className="import-quality-ok">记录键、孔位和字段校验通过</div>}
        </>}
      </div>
      {importPreview.kind === "grid" && <div className="import-options"><label><span>空位默认类型</span><select value={importMaterialType} onChange={(event) => setImportMaterialType(event.target.value as MaterialType)}>{MATERIAL_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label><label><input type="checkbox" checked={overwriteImport} onChange={(event) => setOverwriteImport(event.target.checked)} /> 更新已占孔位名称</label></div>}
      <div className="import-preview-actions"><button className="quiet-button" type="button" onClick={() => setImportPreview(null)}>取消</button><button className="action-button" type="button" onClick={applyImport} disabled={blocked}>确认导入</button></div>
    </div>;
  }

  function renderFreezerGrid() {
    if (!activeBox) return null;
    return <div className="box-grid-wrap">
      <div className="box-grid">
        <span className="grid-corner">行 / 列</span>
        {Array.from({ length: 9 }, (_, index) => <span className="column-head" key={index}>{index + 1}</span>)}
        {ROWS.map((row) => [
          <span className="row-head" key={`${row}-head`}>{row}</span>,
          ...Array.from({ length: 9 }, (_, index) => {
            const column = index + 1;
            const slot = slotLookup.get(slotKey(activeBox.id, row, column));
            const match = boxQuery && slot?.materialName.toLowerCase().includes(boxQuery.toLowerCase());
            return <button
              type="button"
              className={`box-cell ${slot ? "occupied" : "empty"} ${materialTypeClass(slot?.materialType)} ${slot?.status === "待核对" ? "review" : ""} ${slot?.status === "已取出" ? "removed" : ""} ${slot?.status === "已废弃" ? "discarded" : ""} ${match || slot?.id === focusedSlotId ? "match" : ""} ${boxQuery && slot && !match ? "dim" : ""}`}
              key={`${row}-${column}`}
              onClick={(event) => { setDialogOpener(event.currentTarget); openCell(row, column); }}
              aria-label={`${coordinate(row, column)}，${slot?.materialName ?? "空位"}`}
            >
              <span>{coordinate(row, column)} · {String(numericPosition(row, column)).padStart(2, "0")}</span>
              {slot?.note && <i className="slot-note-marker" title={slot.note} aria-label={`备注：${slot.note}`}>◆</i>}
              <strong>{slot?.materialName || "空"}</strong>
              {slot && <small>{slot.materialType}{slot.concentration ? ` · ${slot.concentration}` : ""}{slot.status !== "正常" ? ` · ${slot.status}` : ""}</small>}
            </button>;
          }),
        ])}
      </div>
    </div>;
  }

  function renderFreezerTable() {
    if (!activeBox) return null;
    const suggestedType = MATERIAL_TYPES.reduce((best, type) => {
      const bestCount = activeSlots.filter((slot) => slot.materialType === best).length;
      const typeCount = activeSlots.filter((slot) => slot.materialType === type).length;
      return typeCount > bestCount ? type : best;
    }, "菌株" as MaterialType);
    return <div className="freezer-sheet-editor">
      <div className="freezer-sheet-help"><span><b>快速编辑</b> 离开单元格或按 Enter 自动保存，Tab 可连续移动。</span><span>空位新增默认类型：<strong>{suggestedType}</strong> · 点击孔位打开完整编辑</span></div>
      <div className="freezer-sheet-wrap">
      <table className="freezer-sheet" key={activeBox.id}>
        <thead><tr><th>#</th><th>孔位</th><th>材料名称 / 编号</th><th>类型</th><th>分类地位</th><th>浓度</th><th>状态</th><th>保存日期</th><th>提取日期</th><th>备注</th></tr></thead>
        <tbody>{ROWS.flatMap((row) => Array.from({ length: 9 }, (_, index) => {
          const column = index + 1;
          const slot = slotLookup.get(slotKey(activeBox.id, row, column));
          const match = boxQuery && slot?.materialName.toLowerCase().includes(boxQuery.toLowerCase());
          return <tr className={`${slot ? materialTypeClass(slot.materialType) : "is-empty"} ${match || slot?.id === focusedSlotId ? "match" : ""} ${boxQuery && slot && !match ? "dim" : ""}`} key={`${row}-${column}`}>
            <td>{String(numericPosition(row, column)).padStart(2, "0")}</td>
            <th><button type="button" title="打开完整编辑" onClick={(event) => { setDialogOpener(event.currentTarget); openCell(row, column); }}>{coordinate(row, column)}</button></th>
            <td><input className="sheet-material-input" key={`${slot?.updatedAt ?? "empty"}-name`} defaultValue={slot?.materialName ?? ""} placeholder={`新增${suggestedType}`} aria-label={`${coordinate(row, column)} 材料名称`} onKeyDown={blurOnEnter} onBlur={(event) => { const value = event.currentTarget.value; if (!value.trim() && slot) event.currentTarget.value = slot.materialName; updateSlotFromTable(row, column, { materialName: value }, suggestedType); }} /></td>
            <td><select aria-label={`${coordinate(row, column)} 类型`} value={slot?.materialType ?? suggestedType} disabled={!slot} onChange={(event) => updateSlotFromTable(row, column, { materialType: event.currentTarget.value as MaterialType }, suggestedType)}>{MATERIAL_TYPES.map((type) => <option key={type}>{type}</option>)}</select></td>
            <td><input className="sheet-taxonomy-input" key={`${slot?.updatedAt ?? "empty"}-taxonomy`} defaultValue={slot?.taxonomy ?? ""} placeholder={slot?.materialType === "菌株" ? "如：Bacillus subtilis" : "—"} aria-label={`${coordinate(row, column)} 分类地位`} disabled={!slot || slot.materialType !== "菌株"} onKeyDown={blurOnEnter} onBlur={(event) => updateSlotFromTable(row, column, { taxonomy: event.currentTarget.value }, suggestedType)} /></td>
            <td><input key={`${slot?.updatedAt ?? "empty"}-concentration`} defaultValue={slot?.concentration ?? ""} placeholder="—" aria-label={`${coordinate(row, column)} 浓度`} disabled={!slot || !CONCENTRATION_MATERIAL_TYPES.has(slot.materialType)} onKeyDown={blurOnEnter} onBlur={(event) => updateSlotFromTable(row, column, { concentration: event.currentTarget.value }, suggestedType)} /></td>
            <td><select aria-label={`${coordinate(row, column)} 状态`} value={slot?.status ?? "正常"} disabled={!slot} onChange={(event) => updateSlotFromTable(row, column, { status: event.currentTarget.value as SlotStatus }, suggestedType)}><option>正常</option><option>待核对</option><option>已取出</option><option>已废弃</option></select></td>
            <td><input type="date" key={`${slot?.updatedAt ?? "empty"}-stored`} defaultValue={slot?.storedAt ?? ""} aria-label={`${coordinate(row, column)} 保存日期`} disabled={!slot} onKeyDown={blurOnEnter} onBlur={(event) => updateSlotFromTable(row, column, { storedAt: event.currentTarget.value }, suggestedType)} /></td>
            <td><input type="date" key={`${slot?.updatedAt ?? "empty"}-extracted`} defaultValue={slot?.extractedAt ?? ""} aria-label={`${coordinate(row, column)} 提取日期`} disabled={!slot} onKeyDown={blurOnEnter} onBlur={(event) => updateSlotFromTable(row, column, { extractedAt: event.currentTarget.value }, suggestedType)} /></td>
            <td><input className="sheet-note-input" key={`${slot?.updatedAt ?? "empty"}-note`} defaultValue={slot?.note ?? ""} placeholder="—" aria-label={`${coordinate(row, column)} 备注`} disabled={!slot} onKeyDown={blurOnEnter} onBlur={(event) => updateSlotFromTable(row, column, { note: event.currentTarget.value }, suggestedType)} /></td>
          </tr>;
        }))}</tbody>
      </table>
      </div>
    </div>;
  }

  function renderMaterialLibrary() {
    return (
      <section>
        <div className="module-heading">
          <div><p className="section-kicker">MATERIAL INDEX</p><h1>材料库</h1><p>七类材料共用一套位置索引；相同名称的不同冻存管不会合并。</p></div>
          <button className="action-button" type="button" onClick={() => goToView("freezer")}>在冻存盒中添加</button>
        </div>
        <div className="material-overview" aria-label="材料类型摘要">
          {MATERIAL_TYPES.map((type) => {
            const tubes = state.slots.filter((slot) => slot.materialType === type);
            return <button className={`${materialTypeClass(type)} ${materialTypeFilter === type ? "active" : ""}`} type="button" key={type} onClick={() => { setMaterialTypeFilter(materialTypeFilter === type ? "全部" : type); setMaterialLimit(50); }}><small>{type}</small><strong>{uniqueMaterialCount(tubes, type)}</strong><span>{tubes.length} 支管</span></button>;
          })}
        </div>
        <div className="list-toolbar material-toolbar">
          <input value={materialQuery} onChange={(event) => { setMaterialQuery(event.target.value); setMaterialLimit(50); }} placeholder="搜索材料名称、分类地位或浓度" />
          <select aria-label="材料类型" value={materialTypeFilter} onChange={(event) => { setMaterialTypeFilter(event.target.value as "全部" | MaterialType); setMaterialLimit(50); }}><option>全部</option>{MATERIAL_TYPES.map((type) => <option key={type}>{type}</option>)}</select>
          <select aria-label="材料状态" value={materialStatusFilter} onChange={(event) => { setMaterialStatusFilter(event.target.value as "全部" | SlotStatus); setMaterialLimit(50); }}><option>全部</option><option>正常</option><option>待核对</option><option>已取出</option><option>已废弃</option></select>
          <span>{materialRows.length} 个材料</span>
        </div>
        <div className="material-list">
          {materialRows.length ? materialRows.slice(0, materialLimit).map((row) => (
            <article key={`${row.materialType}-${row.name}`}>
              <div className={`material-token ${materialTypeClass(row.materialType)}`}>{row.materialType === "菌株" ? "S" : row.materialType === "种子" ? "◉" : row.materialType.slice(0, 2)}</div>
              <div className="material-copy"><h3>{row.name}</h3><p>{row.materialType} · {row.tubes.length} 支管</p>{row.materialType === "菌株" && [...new Set(row.tubes.map((tube) => tube.taxonomy).filter(Boolean))].map((taxonomy) => <span className="taxonomy-pill" key={taxonomy}>{taxonomy}</span>)}{row.tubes.some((tube) => tube.status !== "正常") && <span className="quality-pill warning">含需处理状态</span>}</div>
              <div className="position-list">
                {row.paths.map((path, index) => <button key={`${path}-${index}`} type="button" onClick={() => { const slot = row.tubes[index]; setActiveBoxId(slot.boxId); setFocusedSlotId(slot.id); goToView("freezer"); setBoxQuery(row.name); }}>{path}{row.tubes[index].status !== "正常" ? ` · ${row.tubes[index].status}` : ""}</button>)}
              </div>
            </article>
          )) : <div className="empty-panel"><strong>没有符合条件的材料</strong><span>调整筛选条件，或从冻存盒空孔位添加。</span></div>}
        </div>
        {materialRows.length > materialLimit && <button className="load-more-button" type="button" onClick={() => setMaterialLimit((limit) => limit + 50)}>继续显示 · 已显示 {materialLimit} / {materialRows.length}</button>}
      </section>
    );
  }

  function renderBatchLookup() {
    return (
      <section className="batch-lookup">
        <div className="module-heading batch-heading">
          <div><p className="section-kicker">BATCH MATERIAL FINDER</p><h1>批量查找与取样清单</h1><p>粘贴一列材料名称，一次核对位置；候选差异只提示，不自动认定。</p></div>
          <div className="module-actions">
            <button className="quiet-button" type="button" disabled={!canExportBatch} onClick={copyBatchResults}>复制结果</button>
            <button className="action-button" type="button" disabled={!canExportBatch} onClick={exportBatchResults}>导出 CSV</button>
          </div>
        </div>

        <div className="batch-workbench">
          <aside className="batch-input-panel">
            <div className="batch-panel-title"><span>输入名单</span><b>{batchResults.全部.length || "—"}</b></div>
            <label><span>材料范围</span><select value={batchMaterialType} onChange={(event) => setBatchMaterialType(event.target.value as "全部" | MaterialType)}><option>全部</option>{MATERIAL_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
            <label className="batch-text-label">
              <span>每行一个名称，也可粘贴 Excel 单列</span>
              <textarea
                value={batchText}
                onChange={(event) => changeBatchText(event.target.value)}
                onPaste={() => setBatchSelection(BATCH_DEFAULT_SELECTION)}
                placeholder={"DEMO-01\nDEMO-02\nDEMO-03"}
                spellCheck={false}
              />
            </label>
            <div className="batch-input-foot"><span>支持换行、制表符、逗号或分号分隔</span><button type="button" disabled={!batchText} onClick={() => changeBatchText("")}>清空</button></div>
          </aside>

          <div className="batch-results-panel">
            <div className="batch-summary" role="group" aria-label="结果筛选">
              {BATCH_FILTERS.map((filter) => (
                <button
                  key={filter}
                  className={filter === "需核对" ? "review" : filter === "未找到" ? "missing" : undefined}
                  type="button"
                  aria-pressed={batchResultFilter === filter}
                  onClick={() => selectBatchFilter(filter)}
                >
                  <small>{filter}</small>
                  <strong>{batchResults[filter].length}</strong>
                  {filter === "已匹配" && <span>{batchTubeCount} 支可取</span>}
                </button>
              ))}
            </div>
            <div className="batch-toolbar">
              <div className="batch-view-switch" role="group" aria-label="批量查找视图">
                <button aria-pressed={batchView === "input"} type="button" onClick={() => setBatchSelection({ view: "input", filter: batchResultFilter })}>按输入顺序</button>
                <button aria-pressed={batchView === "route"} type="button" onClick={() => setBatchSelection({ view: "route", filter: "已匹配" })}>按取样路线</button>
              </div>
              <span>{batchView === "route" ? `已匹配 · ${batchTubeCount} 支可取` : batchResultFilter === "全部" ? "全部结果" : batchResultFilter}</span>
            </div>

            {!batchResults.全部.length ? <div className="batch-empty"><div className="batch-empty-grid" aria-hidden="true">{Array.from({ length: 20 }, (_, index) => <i key={index} />)}</div><strong>把材料名单粘贴到输入框</strong><span>按输入顺序查看结果，可展开同名材料的每一支冻存管。</span></div> : batchView === "input" ? (
              <div className="batch-result-list">
                {visibleBatchResults.map((result) => <article className={`batch-result ${result.status}`} key={`${result.index}-${result.input}`}>
                  <div className="batch-query-index">{String(result.index + 1).padStart(2, "0")}</div>
                  <div className="batch-query-copy"><h3>{result.input}</h3><span className={`batch-status ${result.status}`}>{BATCH_STATUS_META[result.status].label}</span><small>{BATCH_STATUS_META[result.status].hint}</small></div>
                  <div className="batch-locations">
                    {result.slots.length ? result.slots.map((slot) => {
                      const box = batchBoxesById.get(slot.boxId);
                      return <button type="button" key={slot.id} onClick={() => locateBatchSlot(slot)}><span className={`legend-dot ${materialTypeClass(slot.materialType)}`} /><strong>{slot.materialName}</strong><small>{box?.freezer ?? "冰箱未填写"} → {box?.position ?? "架位未填写"} → {box?.name ?? "冻存盒未填写"} → <b>{coordinate(slot.row, slot.column)}（{numericPosition(slot.row, slot.column)}）</b></small><em className={slot.status === "正常" ? "normal" : ""}>{slot.status}</em></button>;
                    }) : <div className="batch-no-location">未找到位置记录</div>}
                  </div>
                </article>)}
                {!visibleBatchResults.length && <div className="batch-no-filter-result">当前筛选下没有结果。</div>}
              </div>
            ) : (
              <div className="batch-route-list">
                {batchRouteGroups.length > 0 && <small>取样路线仅收录状态正常且位置已确认的管。</small>}
                {batchRouteGroups.map((group, groupIndex) => <article key={group.box.id}>
                  <header><div className="route-stop">{String(groupIndex + 1).padStart(2, "0")}</div><div><strong>{group.box.freezer} → {group.box.position}</strong><span>{group.box.identifier} · {group.box.name}</span></div><b>{group.entries.length} 支管</b></header>
                  <div>{group.entries.map(({ inputs, slot }) => <button type="button" key={slot.id} onClick={() => locateBatchSlot(slot)}><span>{coordinate(slot.row, slot.column)}<small>{numericPosition(slot.row, slot.column)}</small></span><div><strong>{slot.materialName}</strong><small>{inputs.length > 1 || inputs[0] !== slot.materialName ? `输入：${inputs.join("、")}` : slot.materialType}</small></div><em className={slot.status === "正常" ? "normal" : ""}>{slot.status}</em></button>)}</div>
                </article>)}
                {!batchRouteGroups.length && <div className="batch-no-filter-result">暂无可取冻存管。取样路线仅收录状态正常且位置已确认的管。</div>}
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  function renderPrimerCards() {
    return <div className="primer-list">{primerRows.slice(0, primerLimit).map((primer) => {
      const href = sourceHref(primer.source);
      const isPair = Boolean(primer.forward && primer.reverse);
      const issues = primerQualityIssues(primer);
      const sequenceIssues = issues.filter((issue) => issue.category === "sequence");
      const reviewed = isPrimerSequenceReviewed(primer);
      const needsReview = sequenceIssues.length > 0 && !reviewed;
      return <article className={`primer-card ${primerPurposeClass(primer.purpose)} ${needsReview ? "has-quality-warning" : ""}`} key={primer.id}>
        <div className="primer-card-head">
          <div className="primer-badges"><span>{primer.purpose || "用途未填写"}</span><b>{isPair ? "F / R 引物对" : "单条 Primer"}</b></div>
          <h3>{primer.name}</h3>
          <div className="primer-target"><small>靶标</small><strong>{primer.target || "未填写"}</strong>{primer.identifier && <em>{primer.identifier}</em>}</div>
          {needsReview ? <div className="quality-notice" title={sequenceIssues.map((issue) => issue.message).join("；")}><strong>需核对</strong><span>{sequenceIssues.map((issue) => issue.message).join("；")}</span></div> : reviewed ? <span className="quality-pill complete" title={sequenceIssues.map((issue) => issue.message).join("；")}>已人工核对</span> : issues.some((issue) => issue.category === "metadata") ? <span className="quality-pill info">信息不完整</span> : <span className="quality-pill complete">已检查</span>}
        </div>
        <div className="sequence-block">
          {primer.sequence ? <div className="oligo-row"><span>5′→3′</span><code>{primer.sequence}</code><small>{oligoMeta(primer.sequence, primer.length, primer.tm) || "参数未填写"}</small><button type="button" onClick={() => copySequence(primer.sequence, "单条")}>复制</button></div> : <>
            <div className="oligo-row"><span>FORWARD{primer.forwardName ? ` · ${primer.forwardName}` : ""}</span><code>{primer.forward || "—"}</code><small>{oligoMeta(primer.forward, primer.forwardLength, primer.forwardTm) || "参数未填写"}</small><button type="button" onClick={() => copySequence(primer.forward, " Forward ")}>复制 F</button></div>
            <div className="oligo-row"><span>REVERSE{primer.reverseName ? ` · ${primer.reverseName}` : ""}</span><code>{primer.reverse || "—"}</code><small>{oligoMeta(primer.reverse, primer.reverseLength, primer.reverseTm) || "参数未填写"}</small><button type="button" onClick={() => copySequence(primer.reverse, " Reverse ")}>复制 R</button></div>
          </>}
          <div className="primer-meta-strip">
            {primer.productSizeChromosome && <span>染色体产物 <b>{primer.productSizeChromosome}</b></span>}
            {primer.productSizeInsertion && <span>插入产物 <b>{primer.productSizeInsertion}</b></span>}
            {primer.organism && <span>材料 <b>{primer.organism}</b></span>}
          </div>
        </div>
        <div className="primer-card-foot">
          {primer.note && <p className="primer-note"><span>备注</span>{primer.note}</p>}
          <p className="primer-source"><span>来源</span>{primer.source ? href ? <a href={href} target="_blank" rel="noreferrer">{primer.source} ↗</a> : <em>{primer.source}</em> : <em>未记录来源</em>}</p>
          <div className="primer-actions">{sequenceIssues.length > 0 && <button type="button" onClick={() => togglePrimerReviewed(primer)}>{reviewed ? "重新标记" : "标记已核对"}</button>}<button type="button" onClick={(event) => { setDialogOpener(event.currentTarget); openPrimer(primer); }}>编辑</button><button className="danger" type="button" onClick={() => deletePrimer(primer)}>删除</button></div>
        </div>
      </article>;
    })}</div>;
  }

  function renderPrimerTable() {
    return <div className="primer-sheet-wrap">
      <table className="primer-sheet">
        <thead><tr><th>#</th><th>名称</th><th>质量</th><th>类型</th><th>靶标</th><th>用途</th><th>Forward 名称</th><th>Forward 序列</th><th>F nt</th><th>F Tm</th><th>Reverse 名称</th><th>Reverse 序列</th><th>R nt</th><th>R Tm</th><th>单条序列</th><th>nt</th><th>Tm</th><th>产物 chr</th><th>产物 ins</th><th>备注</th><th>来源</th><th>操作</th></tr></thead>
        <tbody>{primerRows.map((primer, index) => {
          const href = sourceHref(primer.source);
          const isPair = Boolean(primer.forward && primer.reverse);
          const issues = primerQualityIssues(primer);
          const hasSequenceIssue = issues.some((issue) => issue.category === "sequence");
          const reviewed = isPrimerSequenceReviewed(primer);
          const needsReview = hasSequenceIssue && !reviewed;
          return <tr key={primer.id}>
            <td>{index + 1}</td><th scope="row">{primer.name}</th><td><span className={`quality-pill ${needsReview ? "warning" : reviewed ? "complete" : issues.length ? "info" : "complete"}`}>{needsReview ? "需核对" : reviewed ? "已人工核对" : issues.length ? "不完整" : "已检查"}</span></td><td><span className="sheet-kind">{isPair ? "F/R" : "单条"}</span></td><td>{primer.target || "—"}</td><td>{primer.purpose || "—"}</td>
            <td>{primer.forwardName || "—"}</td><td><code>{primer.forward || "—"}</code></td><td>{primer.forwardLength || "—"}</td><td>{primer.forwardTm || "—"}</td><td>{primer.reverseName || "—"}</td><td><code>{primer.reverse || "—"}</code></td><td>{primer.reverseLength || "—"}</td><td>{primer.reverseTm || "—"}</td>
            <td><code>{primer.sequence || "—"}</code></td><td>{primer.length || "—"}</td><td>{primer.tm || "—"}</td><td>{primer.productSizeChromosome || "—"}</td><td>{primer.productSizeInsertion || "—"}</td><td className="sheet-long-cell">{primer.note || "—"}</td>
            <td className="sheet-long-cell">{primer.source ? href ? <a href={href} target="_blank" rel="noreferrer">{primer.source} ↗</a> : primer.source : "—"}</td><td>{hasSequenceIssue && <button type="button" onClick={() => togglePrimerReviewed(primer)}>{reviewed ? "重新标记" : "标记已核对"}</button>}<button type="button" onClick={(event) => { setDialogOpener(event.currentTarget); openPrimer(primer); }}>编辑</button></td>
          </tr>;
        })}</tbody>
      </table>
    </div>;
  }

  function renderPrimerCompact() {
    return <div className="primer-compact-list">{primerRows.slice(0, primerLimit).map((primer, index) => {
      const issues = primerQualityIssues(primer);
      const hasSequenceIssue = issues.some((issue) => issue.category === "sequence");
      const reviewed = isPrimerSequenceReviewed(primer);
      const needsReview = hasSequenceIssue && !reviewed;
      return <article className={needsReview ? "has-quality-warning" : ""} key={primer.id}>
        <span className="compact-index">{String(index + 1).padStart(2, "0")}</span>
        <div className="compact-primer-name"><strong>{primer.name}</strong><small>{primer.target || "靶标未填写"} · {primer.purpose || "用途未填写"}</small>{needsReview ? <span className="quality-pill warning" title={issues.filter((issue) => issue.category === "sequence").map((issue) => issue.message).join("；")}>需核对</span> : reviewed ? <span className="quality-pill complete">已人工核对</span> : issues.length ? <span className="quality-pill info">信息不完整</span> : null}</div>
        <div className="compact-sequences">{primer.sequence ? <div className="compact-oligo-row"><b>5′</b><code>{primer.sequence}</code><small>{oligoMeta(primer.sequence, primer.length, primer.tm) || "参数未填写"}</small></div> : <><div className="compact-oligo-row"><b>F</b><code>{primer.forward || "—"}</code><small>{oligoMeta(primer.forward, primer.forwardLength, primer.forwardTm) || "参数未填写"}</small></div><div className="compact-oligo-row"><b>R</b><code>{primer.reverse || "—"}</code><small>{oligoMeta(primer.reverse, primer.reverseLength, primer.reverseTm) || "参数未填写"}</small></div></>}</div>
        <div className="compact-actions">{primer.sequence ? <button type="button" onClick={() => copySequence(primer.sequence, "单条")}>复制</button> : <><button type="button" onClick={() => copySequence(primer.forward, " Forward ")}>F</button><button type="button" onClick={() => copySequence(primer.reverse, " Reverse ")}>R</button></>}{hasSequenceIssue && <button type="button" onClick={() => togglePrimerReviewed(primer)}>{reviewed ? "重新标记" : "已核对"}</button>}<button type="button" onClick={(event) => { setDialogOpener(event.currentTarget); openPrimer(primer); }}>编辑</button></div>
      </article>;
    })}</div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="identity"><div className="identity-mark"><span /><span /><span /></div><div><strong>科研工作台</strong><small>本地优先</small></div></div>
        <nav className="desktop-nav">
          {NAV_GROUPS.map((group) => <div className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map((item) => (
            <button className={view === item.view ? "active" : ""} type="button" key={item.view} onClick={() => goToView(item.view)}>
              <span>{item.mark}</span>{VIEW_LABELS[item.view]}
            </button>
          ))}</div>)}
        </nav>
        <nav className="mobile-nav" aria-label="移动端主导航">
          {MOBILE_NAV.map((item) => <button className={view === item.view ? "active" : ""} type="button" key={item.view} onClick={() => goToView(item.view)}><span>{item.mark}</span>{item.label}</button>)}
          <button className={mobileToolsOpen || ["batch", "claims", "protocols", "vendors", "import"].includes(view) ? "active" : ""} type="button" aria-expanded={mobileToolsOpen} onClick={() => setMobileToolsOpen((open) => !open)}><span>•••</span>更多</button>
        </nav>
        {mobileToolsOpen && <div className="mobile-more-menu" role="menu"><button type="button" role="menuitem" onClick={() => goToView("batch")}>⌕ 批量查找</button><button type="button" role="menuitem" onClick={() => goToView("protocols")}>∑ 配方与流程</button><button type="button" role="menuitem" onClick={() => goToView("vendors")}>↗ 测序与试剂</button><button type="button" role="menuitem" onClick={() => goToView("claims")}>¥ 科研报销夹</button><button type="button" role="menuitem" onClick={() => goToView("import")}>⇅ 导入与备份</button></div>}
        <div className={`local-status ${saveStatus}`}><span /><div><strong>本机主数据</strong><small>{saveStatus === "loading" ? "正在读取" : saveStatus === "saving" ? "正在保存" : saveStatus === "error" ? "保存失败" : `已保存 ${lastSavedAt ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(lastSavedAt)) : ""}`}</small></div></div>
      </aside>

      <main className="workbench">
        <header className="workbench-topbar">
          <div className="mobile-brand">科研工作台</div>
          <label className="global-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全部材料、孔位或 Primer" /></label>
          {undoEntry && <button className="undo-button" type="button" onClick={undoLastChange} disabled={!!saveFailure}>↶ 撤销：{undoEntry.label}</button>}
          <div className="topbar-date"><small>今天</small><strong>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</strong></div>
          {globalMatches.length > 0 && <div className="search-results">{globalMatches.map((match, index) => <button key={`${match.type}-${match.title}-${index}`} type="button" onClick={() => openSearchMatch(match)}><span>{match.type}</span><strong>{match.title}</strong><small>{match.detail}</small><b>打开 →</b></button>)}</div>}
          {query.trim() && globalMatches.length === 0 && <div className="search-results search-empty"><strong>没有找到匹配项</strong><small>可搜索材料名、浓度、盒标识符、冰箱、架位、A1–I9、1–81 或 Primer。</small></div>}
        </header>

        {saveFailure && <div className="workbench-save-error" role="alert">
          <strong>{saveFailure}</strong>
          <span>为避免覆盖，当前已停止自动保存。可下载本页草稿后重新读取已保存数据。</span>
          <div className="module-actions">
            {base && <button className="quiet-button" type="button" onClick={() => downloadFile(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }), `科研工作台_未保存草稿_${today()}.json`)}>下载本页草稿</button>}
            <button className="action-button" type="button" onClick={reloadSavedWorkspace}>重新读取本机数据</button>
          </div>
        </div>}
        <div className="content-frame" inert={(!base || !!saveFailure) && ["home", "freezer", "primers", "import"].includes(view)}>
          {view === "home" && (
            <section>
              <div className="home-hero">
                <div><p className="section-kicker">PERSONAL RESEARCH DESK</p><h1>今天要找什么？</h1><p>从一个名字出发，定位到每一支管、每一个孔位和对应工具。</p></div>
                <div className="hero-box-mini" aria-hidden="true">{Array.from({ length: 81 }, (_, index) => <span className={activePositionSet.has(index + 1) ? "filled" : ""} key={index} />)}</div>
              </div>
              <div className="metric-strip">
                <button type="button" onClick={() => goToView("materials")}><small>材料</small><strong>{uniqueMaterialCount(state.slots)}</strong><span>七类 · {state.slots.length} 支管</span></button>
                <button type="button" onClick={() => goToView("freezer")}><small>冻存盒</small><strong>{state.boxes.length}</strong><span>{state.slots.length} / {state.boxes.length * 81} 孔已用</span></button>
                <button type="button" onClick={() => goToView("primers")}><small>Primer</small><strong>{state.primers.length}</strong><span>{primerPairCount} 对 · {state.primers.length - primerPairCount} 条单序列</span></button>
                <button type="button" onClick={() => goToView("home")}><small>待处理</small><strong>{attentionTotal}</strong><span>{attentionTotal ? "位置、数据与备份提醒" : "当前没有提醒"}</span></button>
              </div>
              <div className="home-grid">
                <div className="home-main-stack">
                  <section className="attention-board">
                    <div className="card-head"><div><p className="section-kicker">待处理</p><h2>需要你确认的记录</h2></div><span>{attentionTotal}</span></div>
                    <div className="attention-list">
                      <button type="button" onClick={() => { if (pendingBoxes[0]) setActiveBoxId(pendingBoxes[0].id); goToView("freezer"); }} disabled={!pendingBoxes.length}><b>{pendingBoxes.length}</b><span><strong>冻存盒位置待确认</strong><small>{pendingBoxes.length ? pendingBoxes.map((box) => box.name).join("、") : "全部位置已填写"}</small></span><em>→</em></button>
                      <button type="button" onClick={(event) => { if (!pendingSlots[0]) return; setDialogOpener(event.currentTarget); openPendingSlot(pendingSlots[0]); }} disabled={!pendingSlots.length}><b>{pendingSlots.length}</b><span><strong>孔位记录待核对</strong><small>{pendingSlots.length ? [...new Set(pendingSlots.map((slot) => slot.materialName))].join("、") : "没有待核对孔位"}</small></span><em>→</em></button>
                      <button type="button" onClick={() => { setPrimerQualityFilter("需核对"); goToView("primers"); }} disabled={!primerSequenceIssueRecords.length}><b>{primerSequenceIssueRecords.length}</b><span><strong>Primer 序列或命名需核对</strong><small>{primerSequenceIssueRecords.length ? primerSequenceIssueRecords.map((primer) => primer.name).join("、") : "序列检查未发现问题"}</small></span><em>→</em></button>
                      <button type="button" onClick={() => goToView("import")} className={backupNeedsAttention ? "warning" : ""}><b>{backupNeedsAttention ? "!" : "✓"}</b><span><strong>完整备份</strong><small>{lastBackupAt ? `上次 ${formatLocalTime(lastBackupAt)}` : "还没有备份记录"}</small></span><em>→</em></button>
                    </div>
                  </section>
                  {activeBox ? <section className="home-box-card">
                    <div className="card-head"><div><p className="section-kicker">当前冻存盒 · {activeBox?.identifier}</p><h2>{activeBox?.name}</h2></div><button type="button" onClick={() => goToView("freezer")}>打开盒图 →</button></div>
                    <p>{activeBox?.freezer} · {activeBox?.position}</p>
                    <div className="occupancy-bar"><span style={{ width: `${(activeSlots.length / 81) * 100}%` }} /></div>
                    <div className="occupancy-meta"><span>{activeSlots.length} 个孔位已用</span><span>{81 - activeSlots.length} 个空位</span></div>
                  </section> : <section className="home-box-card">
                    <div className="card-head"><h2>冻存盒</h2><button type="button" onClick={() => goToView("freezer")}>建立冻存盒 →</button></div>
                    <p>当前没有冻存盒。新建空盒后即可录入或导入材料。</p>
                  </section>}
                </div>
                <section className="tool-stack">
                  <button type="button" onClick={() => goToView("claims")}><span>¥</span><div><strong>科研报销夹</strong><small>记录凭证并生成报销包</small></div><b>→</b></button>
                  <button type="button" onClick={() => goToView("protocols")}><span>∑</span><div><strong>配方与实验流程</strong><small>打开自定义配方链接</small></div><b>↗</b></button>
                  <button type="button" onClick={() => goToView("import")}><span>⇅</span><div><strong>导入与备份</strong><small>{lastBackupAt ? `上次备份 ${formatLocalTime(lastBackupAt)}` : "尚无完整备份"}</small></div><b>→</b></button>
                </section>
              </div>
            </section>
          )}

          {view === "freezer" && !activeBox && (
            <section>
              <div className="module-heading">
                <div><h1>冰箱与冻存盒</h1><p>建立首个 81 格冻存盒，开始记录材料位置。</p></div>
                <button className="action-button" type="button" disabled={saveStatus === "loading" || Boolean(saveFailure)} onClick={(event) => { setDialogOpener(event.currentTarget); startNewBox(); setBoxManagerOpen(true); }}>新建冻存盒</button>
              </div>
            </section>
          )}

          {view === "freezer" && activeBox && (
            <section>
              <div className="module-heading">
                <div><p className="section-kicker">81-WELL BOX MAP · {activeBox.identifier}</p><h1>冰箱与冻存盒</h1><p>{activeBox.freezer} → {activeBox.position} → {activeBox.name}</p></div>
                <div className="module-actions"><button className="quiet-button" type="button" onClick={(event) => { setDialogOpener(event.currentTarget); startEditBox(activeBox); setBoxManagerOpen(true); }}>管理冻存盒</button><button className="quiet-button" type="button" onClick={() => exportFreezerBoxes([activeBox])}>导出当前盒</button><button className="action-button" type="button" onClick={() => goToView("import")}>导入 / 批量处理</button></div>
              </div>
              <div className="freezer-toolbar">
                <label className="freezer-box-select"><span>当前盒</span><select value={activeBoxId} onChange={(event) => { setActiveBoxId(event.target.value); setBoxQuery(""); setFocusedSlotId(""); }}><option value={activeBox.id}>{activeBox.identifier} / {activeBox.freezer} / {activeBox.position} / {activeBox.name}</option>{state.boxes.filter((box) => box.id !== activeBox.id).map((box) => <option key={box.id} value={box.id}>{box.identifier} / {box.freezer} / {box.position} / {box.name}</option>)}</select></label>
                <div className="freezer-view-switch" role="group" aria-label="冻存盒视图"><button className={freezerView === "grid" ? "active" : ""} type="button" onClick={() => changeFreezerView("grid")}>▦ 盒图</button><button className={freezerView === "table" ? "active" : ""} type="button" onClick={() => changeFreezerView("table")}>▤ Excel 表格</button></div>
                <label className="box-search"><span>⌕</span><input value={boxQuery} onChange={(event) => setBoxQuery(event.target.value)} placeholder="在本盒中查找" /></label>
                <div className="material-legend">{MATERIAL_TYPES.map((type) => <span key={type}><i className={`legend-dot ${materialTypeClass(type)}`} />{type}</span>)}<span><i className="legend-dot review" />待核对</span></div>
              </div>
              <div className="freezer-work-area">
                {freezerView === "grid" ? renderFreezerGrid() : renderFreezerTable()}
                <aside className="box-index-card">
                  <p className="section-kicker">BOX INDEX</p><h2>{activeBox.name}</h2>
                  <div className="box-identifier">{activeBox.identifier}</div>
                  <dl><div><dt>冰箱</dt><dd>{activeBox.freezer}</dd></div><div><dt>架位</dt><dd>{activeBox.position}</dd></div><div><dt>占用</dt><dd>{activeSlots.length} / 81</dd></div><div><dt>空位</dt><dd>{81 - activeSlots.length}</dd></div></dl>
                  <div className="type-counts">{MATERIAL_TYPES.map((type) => { const count = activeSlots.filter((slot) => slot.materialType === type).length; return count ? <span className={materialTypeClass(type)} key={type}>{type} · {count}</span> : null; })}</div>
                  <div className="box-tip">点击任意孔位即可新增、修改或清空冻存管。相同名称会保留为独立管。</div>
                </aside>
              </div>
            </section>
          )}

          {view === "materials" && renderMaterialLibrary()}

          {view === "batch" && renderBatchLookup()}

          {view === "primers" && (
            <section>
              <div className="module-heading"><div><p className="section-kicker">SEQUENCE INDEX</p><h1>Primer 库</h1><p>优先展示序列、靶基因、用途与关键反应参数，不记录实体管位置。</p></div><button className="action-button" type="button" onClick={(event) => { setDialogOpener(event.currentTarget); openPrimer(); }}>＋ 新增 Primer</button></div>
              <div className="primer-overview" aria-label="Primer 库摘要">
                <div><small>全部记录</small><strong>{state.primers.length}</strong><span>组 Primer</span></div>
                <div><small>F / R 引物对</small><strong>{primerPairCount}</strong><span>组已配对</span></div>
                <div className={primerSequenceIssueRecords.length ? "has-warning" : ""}><small>序列或命名需核对</small><strong>{primerSequenceIssueRecords.length}</strong><span>保留原值，未自动修正</span></div>
                <div><small>科学来源未记录</small><strong>{primerMissingSourceCount}</strong><span>{primerPurposeCount} 类实验用途</span></div>
              </div>
              <div className="list-toolbar primer-toolbar"><input value={primerQuery} onChange={(event) => { setPrimerQuery(event.target.value); setPrimerLimit(20); }} placeholder="搜索名称、靶基因、物种或用途" /><select aria-label="Primer 用途" value={primerPurposeFilter} onChange={(event) => { setPrimerPurposeFilter(event.target.value); setPrimerLimit(20); }}><option>全部</option>{primerPurposeOptions.map((purpose) => <option key={purpose}>{purpose}</option>)}</select><select aria-label="Primer 质量" value={primerQualityFilter} onChange={(event) => { setPrimerQualityFilter(event.target.value as PrimerQualityFilter); setPrimerLimit(20); }}><option>全部</option><option>需核对</option><option>信息不完整</option></select><div className="primer-view-switch" role="group" aria-label="Primer 视图"><button className={primerView === "cards" ? "active" : ""} type="button" onClick={() => changePrimerView("cards")}>▤ 重点卡片</button><button className={primerView === "table" ? "active" : ""} type="button" onClick={() => changePrimerView("table")}>▦ Excel 表格</button><button className={primerView === "compact" ? "active" : ""} type="button" onClick={() => changePrimerView("compact")}>☷ 紧凑列表</button></div><span>{primerRows.length} 条</span><button className="quiet-button" type="button" onClick={() => goToView("import")}>从 Excel 导入</button></div>
              {primerRows.length ? primerView === "cards" ? renderPrimerCards() : primerView === "table" ? renderPrimerTable() : renderPrimerCompact() : <div className="empty-panel"><strong>Primer 库还是空的</strong><span>可以单条添加，也可以从 Excel 批量导入。</span></div>}
              {primerView !== "table" && primerRows.length > primerLimit && <button className="load-more-button" type="button" onClick={() => setPrimerLimit((limit) => limit + 20)}>继续显示 · 已显示 {primerLimit} / {primerRows.length}</button>}
            </section>
          )}

          {view === "claims" && <ReimbursementPanel />}

          {view === "protocols" && (
            <section className="protocol-module">
              <div className="module-heading protocol-heading">
                <div><p className="section-kicker">FORMULATION DESK</p><h1>配方与实验流程</h1><p>实验配方、试剂速查与操作流程的统一入口。</p></div>
              </div>
              <div className="protocol-gateway">
                <div className="protocol-card-art" aria-hidden="true">
                  <div className="protocol-art-head"><span>LAB / FORMULATION</span><b>配液记录</b></div>
                  <div className="protocol-vessel">
                    <div className="protocol-scale"><span>500</span><span>400</span><span>300</span><span>200</span><span>100</span></div>
                    <div className="protocol-liquid"><i /><i /><i /></div>
                    <div className="protocol-vessel-label"><b>250</b><small>mL</small></div>
                  </div>
                  <div className="protocol-specimen"><span>pH</span><strong>5.8</strong><i>20 °C</i></div>
                  <div className="protocol-art-foot"><span>量取</span><span>溶解</span><span>校准</span><span>定容</span></div>
                </div>
                <div className="protocol-copy">
                  <h2>配方链接</h2>
                  <form className="protocol-link-form" onSubmit={saveProtocolUrl}>
                    <label><span>配方与实验流程网址</span><input type="url" value={protocolDraft} onChange={(event) => setProtocolDraft(event.target.value)} placeholder="https://example.com/protocols" /></label>
                    <button className="action-button" type="submit">保存链接</button>
                  </form>
                  {protocolUrl && <a href={protocolUrl} target="_blank" rel="noopener noreferrer"><strong>打开配方与实验流程</strong><b aria-hidden="true">↗</b></a>}
                  <p className="protocol-note">链接仅保存在当前浏览器。清空网址并保存即可移除。</p>
                </div>
              </div>
            </section>
          )}

          {view === "vendors" && (
            <section className="vendor-module">
              <div className="module-heading"><div><p className="section-kicker">LAB SUPPLIERS</p><h1>测序与试剂</h1><p>常用测序、合成与试剂订购平台，点击名称即可打开公司网站。</p></div></div>
              <div className="vendor-grid">
                {[
                  { name: "生工", url: "https://passport.sangon.com/?returnUrl=https://store.sangon.com/newPrimerCx", category: "引物合成 · 试剂订购" },
                  { name: "华大", url: "https://mybgi.bgi.com/tech/home", category: "测序 · 技术服务" },
                  { name: "艾康健", url: "https://core-system.icongene.com:8077/#/index", category: "测序 · 合成服务" },
                  { name: "上海源叶", url: "https://www.shyuanye.com/index.html", category: "试剂 · 实验耗材" },
                  { name: "康为", url: "https://www.cwbio.com/", category: "试剂 · 生物耗材" },
                ].map((vendor) => <a className="vendor-link" href={vendor.url} target="_blank" rel="noreferrer" key={vendor.name}><span className="vendor-mark">↗</span><span className="vendor-copy"><strong>{vendor.name}</strong><small>{vendor.category}</small></span><b aria-hidden="true">打开</b></a>)}
              </div>
            </section>
          )}

          {view === "import" && (
            <section>
              <div className="module-heading"><div><p className="section-kicker">DATA IN / DATA OUT</p><h1>导入与备份</h1><p>导入后以本工作台为主数据源；每次大批量修改前先导出备份。</p></div><div className="module-actions"><button className="quiet-button" type="button" onClick={() => exportFreezerBoxes(state.boxes)}>导出全部冻存盒</button><button className="quiet-button" type="button" onClick={exportBackup}>导出完整备份</button><input ref={restoreRef} hidden type="file" accept=".json" onChange={restoreBackup} /><button className="action-button" type="button" onClick={() => restoreRef.current?.click()}>恢复备份</button></div></div>
              <div className="import-grid">
                <section className="import-card"><div className="import-number">01</div><h2>粘贴 9×9 冻存盒</h2><p>从腾讯文档或 Excel 复制整张表格，保留首行 1–9 和首列 A–I。</p><textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={"\\t1\\t2\\t3\\t...\\t9\\nA\\tDEMO-01\\tDEMO-02\\t..."} /><button type="button" onClick={previewPastedGrid}>预览盒表</button></section>
                <section className="import-card"><div className="import-number">02</div><h2>上传 Excel / CSV</h2><p>可直接回导工作台导出的孔位明细，也支持 9×9 盒表和 Primer 表。</p><input ref={workbookRef} hidden type="file" accept=".xlsx,.xls,.csv,.tsv" onChange={previewWorkbook} /><button type="button" onClick={() => workbookRef.current?.click()}>选择表格文件</button><small>9×9 写入目标：{activeBox?.identifier} / {activeBox?.freezer} / {activeBox?.position} / {activeBox?.name}</small></section>
                <section className="import-card backup-card"><div className="import-number">03</div><h2>本地数据安全</h2><p>全部材料、Primer 与盒位保存在浏览器本机。请定期备份当前浏览器中的站点数据。</p><div className="backup-health"><span>当前保存</span><strong>{saveStatus === "error" ? "失败" : saveStatus === "saving" ? "进行中" : "正常"}</strong><small>{lastSavedAt ? formatLocalTime(lastSavedAt) : "本次打开后尚未写入"}</small></div><div className="backup-health"><span>完整备份</span><strong>{lastBackupAt ? (backupNeedsAttention ? "建议更新" : "正常") : "尚未创建"}</strong><small>{formatLocalTime(lastBackupAt)}</small></div><div className="data-health"><span>浓度完整度</span><strong>{concentrationCoverage.filled} / {concentrationCoverage.total}</strong><small>仅提示，不自动补写</small></div><div className="data-health"><span>疑似完全重复 Primer</span><strong>{exactPrimerDuplicateCount}</strong><small>保留原记录，等待人工判断</small></div><button type="button" onClick={exportBackup}>立即下载 JSON 备份</button><small>报销附件请在“科研报销夹”内单独备份。</small></section>
              </div>
              {renderImportPreview()}
            </section>
          )}
        </div>
      </main>

      {selectedCell && activeBox && !saveFailure && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedCell(null); }}>
          <section className="modal-card slot-editor" role="dialog" aria-modal="true" aria-labelledby="slot-title">
            <div className="modal-head"><div><p className="section-kicker">{activeBox.identifier} · {activeBox.freezer} · {activeBox.position} · {activeBox.name}</p><h2 id="slot-title">{coordinate(selectedCell.row, selectedCell.column)} · {numericPosition(selectedCell.row, selectedCell.column)}</h2></div><button type="button" onClick={() => setSelectedCell(null)} aria-label="关闭">×</button></div>
            <form onSubmit={saveSlot}>
              <div className="kind-choice material-type-choice">{MATERIAL_TYPES.map((type) => <label className={materialTypeClass(type)} key={type}><input type="radio" name="material-type" checked={slotDraft.materialType === type} onChange={() => setSlotDraft((draft) => ({ ...draft, materialType: type }))} /> {type}</label>)}</div>
              <label><span>材料名称 / 编号</span><input autoFocus value={slotDraft.materialName} onChange={(event) => setSlotDraft((draft) => ({ ...draft, materialName: event.target.value }))} placeholder="如：DEMO-01" /></label>
              {slotDraft.materialType === "菌株" && <label><span>分类地位</span><input value={slotDraft.taxonomy} onChange={(event) => setSlotDraft((draft) => ({ ...draft, taxonomy: event.target.value }))} placeholder="如：Bacillus subtilis，也可记录属、种或更完整的分类" /></label>}
              <label><span>状态</span><select value={slotDraft.status} onChange={(event) => setSlotDraft((draft) => ({ ...draft, status: event.target.value as FrozenSlot["status"] }))}><option>正常</option><option>待核对</option><option>已取出</option><option>已废弃</option></select></label>
              {CONCENTRATION_MATERIAL_TYPES.has(slotDraft.materialType) && <label><span>浓度（原始记录）</span><input value={slotDraft.concentration} onChange={(event) => setSlotDraft((draft) => ({ ...draft, concentration: event.target.value }))} placeholder="如：120.5 ng/µL 或 10 μM" /></label>}
              <div className="form-grid"><label><span>保存日期</span><input type="date" value={slotDraft.storedAt} onChange={(event) => setSlotDraft((draft) => ({ ...draft, storedAt: event.target.value }))} /></label><label><span>提取日期</span><input type="date" value={slotDraft.extractedAt} onChange={(event) => setSlotDraft((draft) => ({ ...draft, extractedAt: event.target.value }))} /></label></div>
              <label><span>备注</span><textarea value={slotDraft.note} onChange={(event) => setSlotDraft((draft) => ({ ...draft, note: event.target.value }))} /></label>
              <div className="modal-foot">{slotLookup.has(slotKey(activeBox.id, selectedCell.row, selectedCell.column)) ? <><button className="danger-link" type="button" onClick={clearSlot}>清空孔位</button>{slotDraft.status === "待核对" && <button className="review-complete-button" type="button" onClick={markSlotReviewed}>✓ 标记已核对</button>}</> : <span>空孔位</span>}<button className="action-button" type="submit" disabled={!slotDraft.materialName.trim()}>保存冻存管</button></div>
            </form>
          </section>
        </div>
      )}

      {boxManagerOpen && !saveFailure && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBoxManagerOpen(false); }}>
          <section className="modal-card box-manager" role="dialog" aria-modal="true" aria-labelledby="box-manager-title">
            <div className="modal-head"><div><p className="section-kicker">FREEZER & BOX MANAGER</p><h2 id="box-manager-title">管理冰箱与冻存盒</h2></div><button type="button" onClick={() => setBoxManagerOpen(false)} aria-label="关闭">×</button></div>
            <div className="box-manager-grid">
              <div className="box-manager-list">
                <div className="box-manager-list-head"><strong>{state.boxes.length} 个冻存盒</strong><button type="button" onClick={startNewBox}>＋ 新建</button></div>
                {state.boxes.map((box) => { const count = state.slots.filter((slot) => slot.boxId === box.id).length; return <article className={editingBoxId === box.id ? "active" : ""} key={box.id}><button className="box-manager-select" type="button" onClick={() => startEditBox(box)}><strong>{box.name}</strong><b>{box.identifier}</b><span>{box.freezer} · {box.position}</span><small>{count} / 81 孔已用</small></button><div><button type="button" onClick={() => { setActiveBoxId(box.id); setBoxManagerOpen(false); }}>打开</button><button className="danger" type="button" onClick={() => deleteBox(box)}>删除整盒</button></div></article>; })}
              </div>
              <form className="box-manager-form" onSubmit={saveBox}>
                <p className="section-kicker">{editingBoxId ? "EDIT BOX" : "NEW BOX"}</p><h3>{editingBoxId ? "修改冻存盒信息" : "建立空冻存盒"}</h3>
                <label><span>盒标识符</span><input className="mono-input" value={boxDraft.identifier} onChange={(event) => setBoxDraft((draft) => ({ ...draft, identifier: event.target.value }))} placeholder="如：FBX-004" /></label>
                <label><span>冰箱名称</span><input value={boxDraft.freezer} onChange={(event) => setBoxDraft((draft) => ({ ...draft, freezer: event.target.value }))} /></label>
                <label><span>架位</span><input value={boxDraft.position} onChange={(event) => setBoxDraft((draft) => ({ ...draft, position: event.target.value }))} placeholder="如：第 1 层" /></label>
                <label><span>冻存盒名称</span><input value={boxDraft.name} onChange={(event) => setBoxDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="如：盒2" /></label>
                <div className="modal-foot"><span>固定使用 9×9 / 81 格</span><button className="action-button" type="submit">{editingBoxId ? "保存修改" : "建立空盒"}</button></div>
              </form>
            </div>
          </section>
        </div>
      )}

      {primerEditor && !saveFailure && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPrimerEditor(null); }}>
          <section className="modal-card primer-editor" role="dialog" aria-modal="true" aria-labelledby="primer-editor-title"><div className="modal-head"><div><p className="section-kicker">PRIMER RECORD</p><h2 id="primer-editor-title">{primerEditor === "new" ? "新增 Primer" : "编辑 Primer"}</h2></div><button type="button" onClick={() => setPrimerEditor(null)} aria-label="关闭">×</button></div><form onSubmit={savePrimer}><div className="form-grid"><label className="wide"><span>Primer 名称</span><input autoFocus value={primerDraft.name} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, name: event.target.value }))} /></label><label><span>靶基因</span><input value={primerDraft.target} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, target: event.target.value }))} /></label><label><span>ID / 编号</span><input value={primerDraft.identifier} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, identifier: event.target.value }))} /></label><label className="wide"><span>单条序列（5′→3′）</span><input className="mono-input" value={primerDraft.sequence} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, sequence: event.target.value }))} /></label><label><span>单条长度（nt）</span><input value={primerDraft.length} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, length: event.target.value }))} /></label><label><span>单条 Tm（℃）</span><input value={primerDraft.tm} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, tm: event.target.value }))} /></label><label><span>用途</span><input value={primerDraft.purpose} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, purpose: event.target.value }))} /></label><label><span>染色体产物长度</span><input value={primerDraft.productSizeChromosome} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, productSizeChromosome: event.target.value, productLength: event.target.value }))} /></label><label><span>插入产物长度</span><input value={primerDraft.productSizeInsertion} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, productSizeInsertion: event.target.value }))} /></label><label><span>物种 / 材料</span><input value={primerDraft.organism} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, organism: event.target.value }))} /></label><label><span>来源（DOI、文章链接或提供者）</span><input value={primerDraft.source} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, source: event.target.value }))} placeholder="如：10.1038/... 或文章网址" /></label><details className="legacy-primer-fields" open={Boolean(primerDraft.forward || primerDraft.reverse)}><summary>Forward / Reverse 引物对</summary><div className="primer-pair-column"><strong>Forward</strong><label><span>名称</span><input value={primerDraft.forwardName} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, forwardName: event.target.value }))} /></label><label><span>序列（5′→3′）</span><input className="mono-input" value={primerDraft.forward} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, forward: event.target.value }))} /></label><div className="primer-pair-parameters"><label><span>长度（nt）</span><input value={primerDraft.forwardLength} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, forwardLength: event.target.value }))} /></label><label><span>Tm（℃）</span><input value={primerDraft.forwardTm} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, forwardTm: event.target.value }))} /></label></div></div><div className="primer-pair-column"><strong>Reverse</strong><label><span>名称</span><input value={primerDraft.reverseName} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, reverseName: event.target.value }))} /></label><label><span>序列（5′→3′）</span><input className="mono-input" value={primerDraft.reverse} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, reverse: event.target.value }))} /></label><div className="primer-pair-parameters"><label><span>长度（nt）</span><input value={primerDraft.reverseLength} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, reverseLength: event.target.value }))} /></label><label><span>Tm（℃）</span><input value={primerDraft.reverseTm} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, reverseTm: event.target.value }))} /></label></div></div></details></div><label><span>备注</span><textarea value={primerDraft.note} onChange={(event) => setPrimerDraft((draft) => ({ ...draft, note: event.target.value }))} /></label>{primerDraftSequenceIssues.length > 0 && (primerDraftReviewed ? <div className="reviewed-notice"><strong>已人工核对</strong><span>若修改名称、序列或长度，系统会重新标记为需核对。</span></div> : <div className="quality-notice"><strong>保存后将标记为需核对</strong><span>{primerDraftSequenceIssues.map((issue) => issue.message).join("；")}</span></div>)}<div className="modal-foot"><span>保留原始值 · Esc 关闭</span><button className="action-button" type="submit">保存 Primer</button></div></form></section>
        </div>
      )}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
