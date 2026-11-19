export const MATERIAL_TYPES = ["菌株", "种子", "cDNA", "NRT", "RNA", "DNA", "Primer"] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];
export const CONCENTRATION_MATERIAL_TYPES: ReadonlySet<MaterialType> = new Set(["cDNA", "RNA", "DNA", "Primer"]);
export type SlotStatus = "正常" | "待核对" | "已取出" | "已废弃";

export type FreezerBox = {
  id: string;
  identifier: string;
  freezer: string;
  position: string;
  name: string;
  rows: number;
  columns: number;
};

export type FrozenSlot = {
  id: string;
  boxId: string;
  row: string;
  column: number;
  materialType: MaterialType;
  materialName: string;
  taxonomy: string;
  status: SlotStatus;
  storedAt: string;
  extractedAt: string;
  concentration: string;
  note: string;
  updatedAt: string;
};

export type Primer = {
  id: string;
  name: string;
  sequence: string;
  identifier: string;
  length: string;
  productSizeChromosome: string;
  productSizeInsertion: string;
  forward: string;
  reverse: string;
  forwardName: string;
  reverseName: string;
  forwardLength: string;
  reverseLength: string;
  forwardTm: string;
  reverseTm: string;
  target: string;
  organism: string;
  purpose: string;
  tm: string;
  productLength: string;
  source: string;
  note: string;
  reviewedIssueSignature: string;
  updatedAt: string;
};

export type PrimerQualityIssue = {
  category: "sequence" | "metadata";
  field: "sequence" | "forward" | "reverse" | "names" | "target" | "purpose" | "source";
  severity: "warning" | "info";
  message: string;
};

export type WorkbenchState = {
  version: 11;
  boxes: FreezerBox[];
  slots: FrozenSlot[];
  primers: Primer[];
};

export type WorkbenchRestoreResult =
  | { ok: true; state: WorkbenchState; issues: [] }
  | { ok: false; issues: string[] };

export type BoxExportRecord = {
  boxId?: string;
  slotId?: string;
  recordKey: string;
  boxIdentifier: string;
  freezer: string;
  position: string;
  boxName: string;
  coordinate: string;
  numericPosition: number;
  occupied: "是" | "否";
  materialType: MaterialType | "";
  materialName: string;
  taxonomy: string;
  status: SlotStatus | "";
  concentration: string;
  storedAt: string;
  extractedAt: string;
  note: string;
  updatedAt: string;
};

export type BoxLedgerImportAction = {
  kind: "add" | "update" | "clear";
  recordKey: string;
  boxId: string;
  row: string;
  column: number;
  slot?: Omit<FrozenSlot, "id" | "updatedAt">;
};

export type BoxLedgerImportPlan = {
  actions: BoxLedgerImportAction[];
  errors: string[];
  unchanged: number;
};

export const BOX_LEDGER_BASELINE_SHEET = "回导原始值";
const LEDGER_FIELDS = ["materialType", "materialName", "taxonomy", "status", "concentration", "storedAt", "extractedAt", "note"] as const;

export const BOX_EXPORT_COLUMNS: Array<{ key: keyof BoxExportRecord; label: string; width: number }> = [
  { key: "recordKey", label: "记录键", width: 18 },
  { key: "boxIdentifier", label: "盒标识符", width: 12 },
  { key: "freezer", label: "冰箱", width: 18 },
  { key: "position", label: "架位", width: 12 },
  { key: "boxName", label: "冻存盒名称", width: 16 },
  { key: "coordinate", label: "孔位坐标", width: 10 },
  { key: "numericPosition", label: "数字孔位", width: 10 },
  { key: "occupied", label: "是否占用", width: 10 },
  { key: "materialType", label: "材料类型", width: 10 },
  { key: "materialName", label: "材料名称 / 编号", width: 22 },
  { key: "taxonomy", label: "分类地位（菌株）", width: 28 },
  { key: "status", label: "状态", width: 10 },
  { key: "concentration", label: "浓度（原始记录）", width: 15 },
  { key: "storedAt", label: "保存日期", width: 12 },
  { key: "extractedAt", label: "提取日期", width: 12 },
  { key: "note", label: "备注", width: 28 },
  { key: "updatedAt", label: "更新时间", width: 22 },
];

export const ROWS = "ABCDEFGHI".split("");

export function numericPosition(row: string, column: number) {
  return ROWS.indexOf(row) * 9 + column;
}

export function coordinate(row: string, column: number) {
  return `${row}${column}`;
}

export function buildBoxExportRecords(boxes: FreezerBox[], slots: FrozenSlot[]): BoxExportRecord[] {
  const lookup = new Map(slots.map((slot) => [slotKey(slot.boxId, slot.row, slot.column), slot]));
  return boxes.flatMap((box) => ROWS.flatMap((row) => Array.from({ length: box.columns }, (_, index) => {
    const column = index + 1;
    const slot = lookup.get(slotKey(box.id, row, column));
    const location = coordinate(row, column);
    return {
      boxId: box.id,
      slotId: slot?.id ?? "",
      recordKey: `${box.identifier}:${location}`,
      boxIdentifier: box.identifier,
      freezer: box.freezer,
      position: box.position,
      boxName: box.name,
      coordinate: location,
      numericPosition: numericPosition(row, column),
      occupied: slot ? "是" : "否",
      materialType: slot?.materialType ?? "",
      materialName: slot?.materialName ?? "",
      taxonomy: slot?.taxonomy ?? "",
      status: slot?.status ?? "",
      concentration: slot?.concentration ?? "",
      storedAt: slot?.storedAt ?? "",
      extractedAt: slot?.extractedAt ?? "",
      note: slot?.note ?? "",
      updatedAt: slot?.updatedAt ?? "",
    } satisfies BoxExportRecord;
  })));
}

export function planBoxLedgerImport(
  records: BoxExportRecord[],
  state: WorkbenchState,
  baseline?: ReadonlyMap<string, BoxExportRecord>,
): BoxLedgerImportPlan {
  const actions: BoxLedgerImportAction[] = [];
  const errors: string[] = [];
  let unchanged = 0;
  const boxes = new Map(state.boxes.map((box) => [box.identifier.trim().toLowerCase(), box]));
  const slots = new Map(state.slots.map((slot) => [slotKey(slot.boxId, slot.row, slot.column), slot]));
  const seen = new Set<string>();
  const addError = (message: string) => {
    if (errors.length < 20) errors.push(message);
  };

  for (const record of records) {
    const recordKey = String(record.recordKey ?? "").trim();
    const boxIdentifier = String(record.boxIdentifier ?? "").trim();
    const location = String(record.coordinate ?? "").trim().toUpperCase();
    const match = location.match(/^([A-I])([1-9])$/);
    const box = boxes.get(boxIdentifier.toLowerCase());
    if (!recordKey || !boxIdentifier || !match || !box) {
      addError(`${recordKey || boxIdentifier || location || "未命名行"}：记录键、盒标识符或孔位无效。`);
      continue;
    }
    const expectedKey = `${box.identifier}:${location}`;
    if (recordKey.toLowerCase() !== expectedKey.toLowerCase()) {
      addError(`${recordKey}：应为 ${expectedKey}。`);
      continue;
    }
    if (seen.has(recordKey.toLowerCase())) {
      addError(`${recordKey}：在导入表中重复出现。`);
      continue;
    }
    seen.add(recordKey.toLowerCase());
    const row = match[1];
    const column = Number(match[2]);
    const key = slotKey(box.id, row, column);
    const existing = slots.get(key);
    const original = baseline?.get(expectedKey.toLowerCase());
    if (baseline && (!original || original.boxId !== box.id)) {
      addError(`${recordKey}：无法与导出时的冻存盒及孔位对应，请重新导出台账。`);
      continue;
    }
    const occupied = String(record.occupied ?? "").trim();
    if (occupied !== "是" && occupied !== "否") {
      addError(`${recordKey}：“是否占用”必须明确填写“是”或“否”。`);
      continue;
    }
    if (occupied === "否") {
      if (!existing || original?.occupied === "否") {
        unchanged += 1;
        continue;
      }
      const unchangedSinceExport = original
        ? existing.id === original.slotId && LEDGER_FIELDS.every((field) => existing[field] === original[field])
        : Boolean(record.updatedAt && existing.updatedAt === record.updatedAt);
      if (!unchangedSinceExport) {
        addError(`${recordKey}：当前冻存管与导出时不同，无法清空。请重新导出核对。`);
        continue;
      }
      actions.push({ kind: "clear", recordKey, boxId: box.id, row, column });
      continue;
    }

    const fieldChanges = LEDGER_FIELDS.filter((field) => !original || record[field] !== original[field]);
    if (original?.occupied === "是" && !fieldChanges.length) {
      unchanged += 1;
      continue;
    }
    if (original) {
      const conflictingFields = existing && original.occupied === "是"
        ? fieldChanges.filter((field) => existing[field] !== original[field] && existing[field] !== record[field])
        : [];
      const replaced = original.occupied === "是" && existing?.id !== original.slotId;
      const occupiedSinceExport = original.occupied === "否" && existing && LEDGER_FIELDS.some((field) => existing[field] !== record[field]);
      // A change of sample identity must never be combined with another edit to that tube.
      const identityFields = ["materialName", "materialType"] as const;
      const identityConflict = existing && original.occupied === "是"
        && (identityFields.some((field) => existing[field] !== original[field] && existing[field] !== record[field])
          || (fieldChanges.some((field) => field === "materialName" || field === "materialType")
            && LEDGER_FIELDS.some((field) => existing[field] !== original[field] && existing[field] !== record[field])));
      if (replaced || occupiedSinceExport || identityConflict || conflictingFields.length) {
        const fields = BOX_EXPORT_COLUMNS.filter((column) => conflictingFields.some((field) => field === column.key)).map(({ label }) => label);
        addError(`${recordKey}：与工作台有冲突${fields.length ? `（${fields.join("、")}）` : "（材料或孔位已变更）"}。请重新导出核对。`);
        continue;
      }
    } else if (existing && LEDGER_FIELDS.every((field) => record[field] === existing[field])) {
      unchanged += 1;
      continue;
    } else if (existing ? !record.updatedAt || existing.updatedAt !== record.updatedAt : Boolean(record.updatedAt)) {
      addError(`${recordKey}：旧版台账缺少原始值或孔位已变更，请重新导出后回导。`);
      continue;
    }
    const value = (field: (typeof LEDGER_FIELDS)[number]) =>
      String((existing && original?.occupied === "是" && !fieldChanges.includes(field) ? existing[field] : record[field]) ?? "").trim();
    const materialType = value("materialType") as MaterialType;
    const status = value("status") as SlotStatus;
    const materialName = normalizeMaterialName(value("materialName"), materialType);
    const storedAt = value("storedAt");
    const extractedAt = value("extractedAt");
    if (!MATERIAL_TYPES.includes(materialType) || !materialName || !["正常", "待核对", "已取出", "已废弃"].includes(status)) {
      addError(`${recordKey}：材料类型、名称或状态无效。`);
      continue;
    }
    if (!validOptionalDate(storedAt) || !validOptionalDate(extractedAt)) {
      addError(`${recordKey}：日期需为有效的 YYYY-MM-DD 或留空。`);
      continue;
    }
    const nextSlot: Omit<FrozenSlot, "id" | "updatedAt"> = {
      boxId: box.id,
      row,
      column,
      materialType,
      materialName,
      taxonomy: materialType === "菌株" ? value("taxonomy") : "",
      status,
      storedAt,
      extractedAt,
      concentration: CONCENTRATION_MATERIAL_TYPES.has(materialType) ? value("concentration") : "",
      note: value("note"),
    };
    const changed = !existing || LEDGER_FIELDS.some((field) => existing[field] !== nextSlot[field]);
    if (!changed) unchanged += 1;
    else actions.push({ kind: existing ? "update" : "add", recordKey, boxId: box.id, row, column, slot: nextSlot });
  }

  return { actions, errors, unchanged };
}

export function applyBoxLedgerImport(state: WorkbenchState, plan: BoxLedgerImportPlan): WorkbenchState {
  if (plan.errors.length || !plan.actions.length) return state;
  const byPosition = new Map(state.slots.map((slot) => [slotKey(slot.boxId, slot.row, slot.column), slot]));
  const updatedAt = new Date().toISOString();
  for (const action of plan.actions) {
    const key = slotKey(action.boxId, action.row, action.column);
    if (action.kind === "clear") {
      byPosition.delete(key);
      continue;
    }
    if (!action.slot) continue;
    const existing = byPosition.get(key);
    byPosition.set(key, { ...action.slot, id: existing?.id ?? crypto.randomUUID(), updatedAt });
  }
  return { ...state, slots: [...byPosition.values()] };
}

export function buildBoxGridMatrix(box: FreezerBox, slots: FrozenSlot[]) {
  const lookup = new Map(slots.filter((slot) => slot.boxId === box.id).map((slot) => [slotKey(slot.boxId, slot.row, slot.column), slot]));
  return [
    ["行 / 列", ...Array.from({ length: box.columns }, (_, index) => index + 1)],
    ...ROWS.slice(0, box.rows).map((row) => [row, ...Array.from({ length: box.columns }, (_, index) => lookup.get(slotKey(box.id, row, index + 1))?.materialName ?? "")]),
  ];
}

export function normalizeMaterialName(materialName: string, materialType: MaterialType) {
  const clean = materialName.trim();
  return materialType === "NRT" ? clean.replace(/\s*\(NRT\)\s*$/i, "") : clean;
}

function inspectPrimerSequence(
  field: PrimerQualityIssue["field"],
  label: string,
  sequence: string | undefined,
  reportedLength: string | undefined,
) {
  if (!sequence) return [];
  const issues: PrimerQualityIssue[] = [];
  const compact = sequence.replace(/[\s-]+/g, "");
  if (/^_x[0-9a-f]{4}_$/i.test(sequence.trim())) {
    issues.push({ category: "sequence", field, severity: "warning", message: `${label} 疑似包含 Excel 控制字符占位符` });
    return issues;
  }
  if (/\s/.test(sequence)) {
    issues.push({ category: "sequence", field, severity: "warning", message: `${label} 序列含空格，复制或订购前需核对` });
  }
  if (compact && !/^[ACGTURYSWKMBDHVNI]+$/i.test(compact)) {
    issues.push({ category: "sequence", field, severity: "warning", message: `${label} 含非常规碱基字符` });
  }
  const length = Number(reportedLength);
  if (reportedLength && Number.isFinite(length) && length !== compact.length) {
    issues.push({ category: "sequence", field, severity: "warning", message: `${label} 标注 ${reportedLength} nt，实际读取 ${compact.length} nt` });
  }
  return issues;
}

export function primerQualityIssues(primer: Partial<Primer>): PrimerQualityIssue[] {
  const issues = [
    ...inspectPrimerSequence("sequence", "单条", primer.sequence, primer.length),
    ...inspectPrimerSequence("forward", "Forward", primer.forward, primer.forwardLength),
    ...inspectPrimerSequence("reverse", "Reverse", primer.reverse, primer.reverseLength),
  ];
  if (primer.forward && primer.reverse && primer.forwardName && primer.forwardName === primer.reverseName) {
    issues.push({ category: "sequence", field: "names", severity: "warning", message: "Forward / Reverse 原名相同，方向命名需核对" });
  }
  if (!primer.target?.trim()) issues.push({ category: "metadata", field: "target", severity: "info", message: "靶标未记录" });
  if (!primer.purpose?.trim()) issues.push({ category: "metadata", field: "purpose", severity: "info", message: "用途未记录" });
  if (!primer.source?.trim()) issues.push({ category: "metadata", field: "source", severity: "info", message: "科学来源未记录" });
  return issues;
}

export function primerSequenceReviewSignature(primer: Partial<Primer>) {
  return JSON.stringify({
    name: primer.name ?? "",
    sequence: primer.sequence ?? "",
    length: primer.length ?? "",
    forward: primer.forward ?? "",
    reverse: primer.reverse ?? "",
    forwardName: primer.forwardName ?? "",
    reverseName: primer.reverseName ?? "",
    forwardLength: primer.forwardLength ?? "",
    reverseLength: primer.reverseLength ?? "",
    issues: primerQualityIssues(primer).filter((issue) => issue.category === "sequence").map((issue) => issue.message),
  });
}

export function isPrimerSequenceReviewed(primer: Partial<Primer>) {
  const hasSequenceIssue = primerQualityIssues(primer).some((issue) => issue.category === "sequence");
  return hasSequenceIssue && primer.reviewedIssueSignature === primerSequenceReviewSignature(primer);
}

function normalizePrimer(primer: Partial<Primer> & Pick<Primer, "id" | "name">): Primer {
  return {
    id: primer.id,
    name: primer.name,
    sequence: primer.sequence ?? "",
    identifier: primer.identifier ?? "",
    length: primer.length ?? "",
    productSizeChromosome: primer.productSizeChromosome ?? primer.productLength ?? "",
    productSizeInsertion: primer.productSizeInsertion ?? "",
    forward: primer.forward ?? "",
    reverse: primer.reverse ?? "",
    forwardName: primer.forwardName ?? "",
    reverseName: primer.reverseName ?? "",
    forwardLength: primer.forwardLength ?? "",
    reverseLength: primer.reverseLength ?? "",
    forwardTm: primer.forwardTm ?? "",
    reverseTm: primer.reverseTm ?? "",
    target: primer.target ?? "",
    organism: primer.organism ?? "",
    purpose: primer.purpose ?? "",
    tm: primer.tm ?? "",
    productLength: primer.productLength ?? primer.productSizeChromosome ?? "",
    source: primer.source ?? "",
    note: primer.note ?? "",
    reviewedIssueSignature: primer.reviewedIssueSignature ?? "",
    updatedAt: primer.updatedAt ?? new Date().toISOString(),
  };
}

type PrimerDirection = { direction: "F" | "R"; base: string };

function primerDirection(name: string): PrimerDirection | null {
  const clean = name.trim();
  const separated = clean.match(/^(.*?)(?:[_\-\s]+)(FW|RV|FP|RP|F|R)(?:[_-]\d+)?$/i);
  const attached = clean.match(/^(.*?)(FW|RV|FP|RP|F|R)(?:\d+)?(?:-A)?$/i);
  const match = separated ?? attached;
  if (!match || !match[1].trim()) return null;
  return {
    direction: match[2].toUpperCase().startsWith("F") ? "F" : "R",
    base: match[1].trim().replace(/[_\-\s]+$/, ""),
  };
}

function mergePrimerText(...values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].join(" · ");
}

function pairPrimer(forward: Primer, reverse: Primer, sharedBase?: string): Primer {
  return {
    id: `primer-pair:${forward.id}:${reverse.id}`,
    name: sharedBase || `${forward.name} / ${reverse.name}`,
    sequence: "",
    identifier: mergePrimerText(forward.identifier, reverse.identifier),
    length: "",
    productSizeChromosome: forward.productSizeChromosome || reverse.productSizeChromosome,
    productSizeInsertion: forward.productSizeInsertion || reverse.productSizeInsertion,
    forward: forward.sequence || forward.forward,
    reverse: reverse.sequence || reverse.reverse,
    forwardName: forward.name,
    reverseName: reverse.name,
    forwardLength: forward.length || forward.forwardLength,
    reverseLength: reverse.length || reverse.reverseLength,
    forwardTm: forward.tm || forward.forwardTm,
    reverseTm: reverse.tm || reverse.reverseTm,
    target: forward.target || reverse.target,
    organism: mergePrimerText(forward.organism, reverse.organism),
    purpose: forward.purpose || reverse.purpose,
    tm: "",
    productLength: forward.productLength || reverse.productLength,
    source: mergePrimerText(forward.source, reverse.source),
    note: mergePrimerText(forward.note, reverse.note),
    reviewedIssueSignature: "",
    updatedAt: forward.updatedAt > reverse.updatedAt ? forward.updatedAt : reverse.updatedAt,
  };
}

export function pairPrimerRecords(records: Primer[]) {
  const groups = new Map<string, { forward: Primer[]; reverse: Primer[]; base: string }>();
  for (const primer of records) {
    if (!primer.sequence || primer.forward || primer.reverse) continue;
    const direction = primerDirection(primer.name);
    if (!direction) continue;
    const key = direction.base.toLowerCase();
    const group = groups.get(key) ?? { forward: [], reverse: [], base: direction.base };
    group[direction.direction === "F" ? "forward" : "reverse"].push(primer);
    groups.set(key, group);
  }
  const pairs = new Map<string, Primer>();
  const usedReverse = new Set<string>();
  for (const { forward, reverse, base } of groups.values()) {
    if (forward.length !== 1 || reverse.length !== 1) continue;
    const [f] = forward;
    const [r] = reverse;
    if ((["target", "organism", "purpose", "source"] as const)
      .some((field) => f[field] && r[field] && f[field].toLowerCase() !== r[field].toLowerCase())) continue;
    pairs.set(f.id, pairPrimer(f, r, primerDirection(f.name)?.base ?? base));
    usedReverse.add(r.id);
  }
  return records.flatMap((primer) => usedReverse.has(primer.id) ? [] : [pairs.get(primer.id) ?? primer]);
}

function normalizeSlot(slot: FrozenSlot): FrozenSlot {
  return {
    ...slot,
    materialName: normalizeMaterialName(slot.materialName, slot.materialType),
    taxonomy: slot.materialType === "菌株" ? slot.taxonomy ?? "" : "",
    storedAt: slot.storedAt ?? "",
    extractedAt: slot.extractedAt ?? "",
    concentration: CONCENTRATION_MATERIAL_TYPES.has(slot.materialType) ? slot.concentration ?? "" : "",
  };
}

function nextBoxIdentifier(used: Set<string>) {
  let number = 1;
  while (used.has(`FBX-${String(number).padStart(3, "0")}`.toLowerCase())) number += 1;
  return `FBX-${String(number).padStart(3, "0")}`;
}

export function createNextBoxIdentifier(boxes: Array<Pick<FreezerBox, "identifier">>) {
  const used = new Set(boxes.map((box) => box.identifier.trim().toLowerCase()).filter(Boolean));
  return nextBoxIdentifier(used);
}

function applyUniqueBoxIdentifiers(boxes: FreezerBox[]) {
  const used = new Set<string>();
  return boxes.map((box) => {
    let identifier = box.identifier?.trim() || "";
    if (!identifier || used.has(identifier.toLowerCase())) identifier = nextBoxIdentifier(used);
    used.add(identifier.toLowerCase());
    return { ...box, identifier };
  });
}

export function createInitialState(): WorkbenchState {
  return { version: 11, boxes: [], slots: [], primers: [] };
}

export function upgradeWorkbenchState(value: unknown): WorkbenchState {
  if (!value || typeof value !== "object") return createInitialState();
  const candidate = value as Partial<WorkbenchState>;
  if (!Array.isArray(candidate.boxes) || !Array.isArray(candidate.slots) || !Array.isArray(candidate.primers)) return createInitialState();
  // Normalize older exported records without adding any inventory or changing locations.
  return {
    version: 11,
    boxes: applyUniqueBoxIdentifiers(candidate.boxes),
    slots: candidate.slots.map(normalizeSlot),
    primers: candidate.primers.map(normalizePrimer),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown) {
  return typeof value === "string";
}

export function validOptionalDate(value: string) {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(`${value}T`);
}

export function prepareWorkbenchRestore(value: unknown): WorkbenchRestoreResult {
  if (!isRecord(value) || !Array.isArray(value.boxes) || !Array.isArray(value.slots) || !Array.isArray(value.primers)) {
    return { ok: false, issues: ["备份缺少冻存盒、孔位或 Primer 数据。"] };
  }
  if (!value.boxes.every((box) => isRecord(box) && isText(box.id) && isText(box.name))) {
    return { ok: false, issues: ["备份中存在无法识别的冻存盒记录。"] };
  }
  if (!value.slots.every((slot) => isRecord(slot) && isText(slot.id) && isText(slot.boxId) && isText(slot.materialName) && isText(slot.materialType))) {
    return { ok: false, issues: ["备份中存在无法识别的孔位记录。"] };
  }
  if (!value.primers.every((primer) => isRecord(primer) && isText(primer.id) && isText(primer.name))) {
    return { ok: false, issues: ["备份中存在无法识别的 Primer 记录。"] };
  }
  const rawBoxIds = value.boxes.map((box) => String((box as Record<string, unknown>).id).trim().toLowerCase());
  const rawIdentifiers = value.boxes.map((box) => String((box as Record<string, unknown>).identifier ?? "").trim().toLowerCase()).filter(Boolean);
  if (new Set(rawBoxIds).size !== rawBoxIds.length || new Set(rawIdentifiers).size !== rawIdentifiers.length) {
    return { ok: false, issues: ["备份中的冻存盒内部 ID 或盒标识符重复。"] };
  }

  let state: WorkbenchState;
  try {
    state = upgradeWorkbenchState(value);
  } catch {
    return { ok: false, issues: ["备份内容无法迁移到当前版本。"] };
  }

  const issues: string[] = [];
  const addIssue = (message: string) => {
    if (issues.length < 12 && !issues.includes(message)) issues.push(message);
  };
  const boxIds = new Set<string>();
  const identifiers = new Set<string>();
  for (const box of state.boxes) {
    if (![box.id, box.identifier, box.freezer, box.position, box.name].every((item) => typeof item === "string" && item.trim())) addIssue("冻存盒存在空白的标识、位置或名称。");
    if (box.rows !== 9 || box.columns !== 9) addIssue(`${box.identifier || box.name || "未命名冻存盒"} 不是 9×9 / 81 格。`);
    if (boxIds.has(box.id)) addIssue(`冻存盒内部 ID 重复：${box.id}`);
    boxIds.add(box.id);
    const identifier = box.identifier.trim().toLowerCase();
    if (identifiers.has(identifier)) addIssue(`盒标识符重复：${box.identifier}`);
    identifiers.add(identifier);
  }

  const slotIds = new Set<string>();
  const occupiedPositions = new Set<string>();
  for (const slot of state.slots) {
    if (slotIds.has(slot.id)) addIssue(`孔位记录 ID 重复：${slot.id}`);
    slotIds.add(slot.id);
    if (!boxIds.has(slot.boxId)) addIssue(`孔位 ${slot.row}${slot.column} 指向不存在的冻存盒。`);
    if (!ROWS.includes(slot.row) || !Number.isInteger(slot.column) || slot.column < 1 || slot.column > 9) addIssue(`存在无效孔位：${slot.row}${slot.column}`);
    if (!MATERIAL_TYPES.includes(slot.materialType)) addIssue(`存在无效材料类型：${String(slot.materialType)}`);
    if (!["正常", "待核对", "已取出", "已废弃"].includes(slot.status)) addIssue(`存在无效孔位状态：${String(slot.status)}`);
    if (!slot.materialName.trim()) addIssue(`孔位 ${slot.row}${slot.column} 的材料名称为空。`);
    if (![slot.taxonomy, slot.storedAt, slot.extractedAt, slot.concentration, slot.note, slot.updatedAt].every(isText)) addIssue(`孔位 ${slot.row}${slot.column} 含有非文本字段。`);
    if (!validOptionalDate(slot.storedAt) || !validOptionalDate(slot.extractedAt)) addIssue(`孔位 ${slot.row}${slot.column} 的日期格式无效。`);
    const position = slotKey(slot.boxId, slot.row, slot.column);
    if (occupiedPositions.has(position)) addIssue(`同一孔位出现多条记录：${slot.row}${slot.column}`);
    occupiedPositions.add(position);
  }

  const primerIds = new Set<string>();
  for (const primer of state.primers) {
    if (primerIds.has(primer.id)) addIssue(`Primer 内部 ID 重复：${primer.id}`);
    primerIds.add(primer.id);
    if (!primer.name.trim()) addIssue("存在名称为空的 Primer。");
    if (!Object.entries(primer).every(([key, field]) => key === "updatedAt" || typeof field === "string")) addIssue(`Primer“${primer.name}”含有非文本字段。`);
  }

  return issues.length ? { ok: false, issues } : { ok: true, state, issues: [] };
}

const DB_NAME = "research-workbench-community";
const STORE_NAME = "workspace";
const STATE_KEY = "primary-v2";

export type WorkbenchMergeResult =
  | { ok: true; state: WorkbenchState }
  | { ok: false; conflicts: string[] };

type WorkspaceRecord = FreezerBox | FrozenSlot | Primer;

function sameWorkspaceRecord<T extends WorkspaceRecord>(a: T | undefined, b: T | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof T)[]);
  return [...keys].every((key) => key === "updatedAt" || a[key] === b[key]);
}

export function mergeWorkbenchStates(base: WorkbenchState, draft: WorkbenchState, latest: WorkbenchState): WorkbenchMergeResult {
  const conflicts: string[] = [];
  function merge<T extends WorkspaceRecord>(
    original: T[], local: T[], remote: T[], key: (item: T) => string, label: (item: T) => string,
  ) {
    const before = new Map(original.map((item) => [key(item), item]));
    const proposed = new Map(local.map((item) => [key(item), item]));
    const current = new Map(remote.map((item) => [key(item), item]));
    for (const id of new Set([...before.keys(), ...proposed.keys()])) {
      const old = before.get(id);
      const next = proposed.get(id);
      const saved = current.get(id);
      if (sameWorkspaceRecord(old, next) || sameWorkspaceRecord(next, saved)) continue;
      if (!sameWorkspaceRecord(old, saved)) {
        conflicts.push(label((next ?? old)!));
      } else if (next) {
        current.set(id, next);
      } else {
        current.delete(id);
      }
    }
    return [...current.values()];
  }

  const boxes = merge(base.boxes, draft.boxes, latest.boxes, (box) => box.id, (box) => `冻存盒 ${box.identifier}`);
  const lookup = new Map([...base.boxes, ...draft.boxes, ...latest.boxes].map((box) => [box.id, box.identifier]));
  const slots = merge(
    base.slots, draft.slots, latest.slots,
    (slot) => slotKey(slot.boxId, slot.row, slot.column),
    (slot) => `${lookup.get(slot.boxId) ?? slot.boxId}:${coordinate(slot.row, slot.column)}`,
  );
  const primers = merge(base.primers, draft.primers, latest.primers, (primer) => primer.id, (primer) => `Primer ${primer.name}`);
  const boxIds = new Set(boxes.map((box) => box.id));
  const identifiers = new Set<string>();
  for (const box of boxes) {
    const identifier = box.identifier.trim().toLowerCase();
    if (identifiers.has(identifier)) conflicts.push(`冻存盒编号 ${box.identifier} 重复`);
    identifiers.add(identifier);
  }
  if (!boxes.length) conflicts.push("至少保留一个冻存盒");
  for (const slot of slots) {
    if (!boxIds.has(slot.boxId)) conflicts.push(`冻存盒 ${lookup.get(slot.boxId) ?? slot.boxId} 下还有新增孔位`);
  }
  return conflicts.length
    ? { ok: false, conflicts: [...new Set(conflicts)] }
    : { ok: true, state: { ...latest, boxes, slots, primers } };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadWorkbenchState(): Promise<WorkbenchState> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let state: WorkbenchState;
    let failure: unknown;
    const request = store.get(STATE_KEY);
    request.onsuccess = () => {
      try {
        const raw: unknown = request.result;
        if (raw !== undefined && (!isRecord(raw) || !Array.isArray(raw.boxes) || !Array.isArray(raw.slots) || !Array.isArray(raw.primers))) {
          throw new Error("工作台主数据结构无效");
        }
        state = upgradeWorkbenchState(raw);
        if (raw === undefined) store.put(state, STATE_KEY);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => { db.close(); resolve(state); };
    transaction.onabort = () => { db.close(); reject(failure ?? transaction.error); };
  });
}

export async function saveWorkbenchState(base: WorkbenchState, draft: WorkbenchState) {
  const db = await openDb();
  return new Promise<WorkbenchMergeResult>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let result: WorkbenchMergeResult;
    let failure: unknown;
    const request = store.get(STATE_KEY);
    request.onsuccess = () => {
      try {
        if (!request.result) {
          result = { ok: false, conflicts: ["本机主数据已被清除或移动"] };
          return;
        }
        result = mergeWorkbenchStates(base, draft, upgradeWorkbenchState(request.result));
        if (result.ok) store.put(result.state, STATE_KEY);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onabort = () => { db.close(); reject(failure ?? transaction.error); };
  });
}

export function slotKey(boxId: string, row: string, column: number) {
  return `${boxId}:${row}:${column}`;
}

export function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function today() {
  return new Date().toLocaleDateString("sv-SE");
}
