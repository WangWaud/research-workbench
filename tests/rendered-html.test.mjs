import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

function sampleWorkspace() {
  const updatedAt = "2000-01-01T00:00:00.000Z";
  const boxes = [1, 2].map((number) => ({
    id: "fixture-box-" + number,
    identifier: "FBX-00" + number,
    freezer: "示例冰箱",
    position: "示例架位",
    name: "测试盒 " + number,
    rows: 9,
    columns: 9,
  }));
  const slots = [
    [0, 1, "菌株", "DEMO101"],
    [0, 2, "菌株", "DEMO101"],
    [0, 3, "菌株", "DEMO202"],
    [0, 4, "菌株", "DEMO202"],
    [1, 1, "菌株", "DEMO202"],
    [1, 2, "cDNA", "DEMO303"],
  ].map(([box, column, materialType, materialName]) => ({
    id: boxes[box].id + "-A" + column,
    boxId: boxes[box].id,
    row: "A",
    column,
    materialType,
    materialName,
    status: "正常",
    storedAt: "",
    extractedAt: "",
    concentration: "",
    taxonomy: "",
    note: "",
    updatedAt,
  }));
  return { version: 11, boxes, slots, primers: [] };
}

test("round-trips every invoice, including duplicate names, and reads legacy backups", async () => {
  const { default: JSZip } = await import("jszip");
  const { attachmentFiles, backupAttachments, invoiceFiles, restoreAttachments } = await import("../app/lib/claimAttachments.ts");
  // JSZip uses the browser FileReader API for Blob inputs.
  const previousReader = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => { this.result = result; this.onload({ target: this }); }, (error) => { this.error = error; this.onerror(); });
    }
  };
  try {
    const file = (content) => ({ name: "车票.pdf", type: "application/pdf", blob: new Blob([content], { type: "application/pdf" }) });
    const invoices = [file("passenger A"), file("passenger B"), file("passenger C")];
    const attachments = { payment: file("one payment"), purchase: null, invoice: invoices };
    assert.equal(invoiceFiles(null).length, 0);
    assert.equal(invoiceFiles([]).length, 0);
    assert.equal(attachmentFiles({ ...attachments, invoice: invoices[0] }, "invoice").length, 1);
    const zip = new JSZip();
    const manifest = await backupAttachments(zip, "trip", attachments);
    assert.equal(new Set(manifest.files.invoice).size, 3);
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: "uint8array" }));
    const restored = await restoreAttachments(loaded, manifest);
    assert.deepEqual(await Promise.all(invoiceFiles(restored.invoice).map((entry) => entry.blob.text())), ["passenger A", "passenger B", "passenger C"]);
    assert.equal(await restored.payment.blob.text(), "one payment");
    assert.equal(restored.purchase, null);
    assert.deepEqual(invoiceFiles(restored.invoice).map(({ name, type }) => [name, type]), invoices.map(({ name, type }) => [name, type]));

    const legacy = await restoreAttachments(loaded, {
      files: { invoice: manifest.files.invoice[0] },
      fileMeta: { invoice: manifest.fileMeta.invoice[0] },
    });
    assert.equal(await legacy.invoice[0].blob.text(), "passenger A");
    const empty = await restoreAttachments(loaded, { files: {}, fileMeta: {} });
    assert.equal(invoiceFiles(empty.invoice).length, 0);
    await assert.rejects(restoreAttachments(loaded, { ...manifest, files: { ...manifest.files, invoice: ["missing.pdf", ...manifest.files.invoice.slice(1)] } }), /Missing backup attachment/);
    await assert.rejects(restoreAttachments(loaded, { ...manifest, fileMeta: { ...manifest.fileMeta, invoice: [] } }), /Invalid attachment metadata/);
  } finally {
    if (previousReader === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = previousReader;
  }
});

test("copies attachment bytes before source files become unavailable and explains read failures", async () => {
  const { snapshotClaimFile, readAttachmentBuffer, backupAttachments } = await import("../app/lib/claimAttachments.ts");
  const { default: JSZip } = await import("jszip");
  const source = new File(["invoice data"], "车票.pdf", { type: "application/pdf" });
  const stored = await snapshotClaimFile(source, "第 2 张发票");
  assert.equal(stored.blob instanceof File, false);
  source.arrayBuffer = async () => { throw new DOMException("Source file disappeared", "NotFoundError"); };
  assert.equal(await stored.blob.text(), "invoice data");
  assert.equal(new TextDecoder().decode(await readAttachmentBuffer(stored, "发票")), "invoice data");
  assert.equal(await snapshotClaimFile(null, "购买记录"), null);
  await assert.rejects(snapshotClaimFile(source, "第 2 张发票"), /无法读取第 2 张发票「车票.pdf」.*重新上传/);
  await assert.rejects(backupAttachments(new JSZip(), "trip", { payment: null, purchase: null, invoice: [{ name: source.name, type: source.type, blob: source }] }), /无法读取备份附件「车票.pdf」/);
});

test("renders the local research workbench shell", { timeout: 20_000 }, async (t) => {
  const cli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
  const server = spawn(process.execPath, [cli, "start", "--hostname", "127.0.0.1", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  const closed = once(server, "close");
  t.after(async () => {
    server.kill();
    await closed;
  });
  const address = await new Promise((resolve, reject) => {
    let output = "";
    function capture(chunk) {
      output += chunk.toString();
      const url = output.match(/Local:\s+(http:\/\/127\.0\.0\.1:[1-9]\d*)/)?.[1];
      if (url && output.includes("Ready")) resolve(url);
    }
    server.stdout.on("data", capture);
    server.stderr.on("data", capture);
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error("Production server exited (" + code + "): " + output)));
  });
  const response = await fetch(address);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>科研工作台<\/title>/i);
  assert.match(html, /今天要找什么/);
  assert.match(html, /本地优先/);
  assert.match(html, /冰箱与冻存盒/);
  assert.match(html, /科研报销夹/);
  assert.match(html, /当前没有冻存盒/);
  assert.match(html, /配方与实验流程/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("starts empty and normalizes previous backups without seeding inventory", async () => {
  const { createInitialState, createNextBoxIdentifier, numericPosition, upgradeWorkbenchState } = await import("../app/lib/workbench.ts");
  const initial = { version: 11, boxes: [], slots: [], primers: [] };
  assert.deepEqual(createInitialState(), initial);
  assert.deepEqual(upgradeWorkbenchState(undefined), initial);
  assert.equal(numericPosition("I", 9), 81);

  const fixture = sampleWorkspace();
  const older = {
    ...fixture,
    version: 2,
    boxes: fixture.boxes.map((box) => ({ ...box, identifier: undefined })),
    slots: fixture.slots.map((slot) => ({ ...slot, taxonomy: undefined })),
  };
  assert.deepEqual(upgradeWorkbenchState(older), fixture);
  assert.equal(createNextBoxIdentifier(fixture.boxes), "FBX-003");
  assert.deepEqual(upgradeWorkbenchState({ ...fixture, boxes: [], slots: [] }), initial);
});

test("exports and safely plans round-trip freezer-box ledger changes", async () => {
  const { BOX_EXPORT_COLUMNS, applyBoxLedgerImport, buildBoxExportRecords, buildBoxGridMatrix, planBoxLedgerImport } = await import("../app/lib/workbench.ts");
  const { buildFreezerWorkbook } = await import("../app/lib/freezerWorkbook.ts");
  const XLSX = await import("xlsx");
  const state = sampleWorkspace();
  const box1 = state.boxes.find((box) => box.identifier === "FBX-002");
  assert.ok(box1);
  const concentrationSlot = state.slots.find((slot) => slot.boxId === box1.id && slot.materialType === "cDNA");
  assert.ok(concentrationSlot);
  const slots = state.slots.map((slot) => slot.id === concentrationSlot.id ? { ...slot, concentration: "120.5" } : slot);
  const allRecords = buildBoxExportRecords(state.boxes, slots);
  const boxRecords = buildBoxExportRecords([box1], slots);
  assert.equal(allRecords.length, 162);
  assert.equal(boxRecords.length, 81);
  assert.equal(boxRecords.filter((record) => record.occupied === "是").length, 2);
  assert.equal(boxRecords.find((record) => record.recordKey === `FBX-002:${concentrationSlot.row}${concentrationSlot.column}`)?.concentration, "120.5");
  assert.equal(buildBoxGridMatrix(box1, slots).length, 10);
  assert.deepEqual(BOX_EXPORT_COLUMNS.map((column) => column.label), ["记录键", "盒标识符", "冰箱", "架位", "冻存盒名称", "孔位坐标", "数字孔位", "是否占用", "材料类型", "材料名称 / 编号", "分类地位（菌株）", "状态", "浓度（原始记录）", "保存日期", "提取日期", "备注", "更新时间"]);

  const singleWorkbook = buildFreezerWorkbook([box1], slots, "2000-02-01T00:00:00.000Z");
  assert.deepEqual(singleWorkbook.SheetNames, ["使用说明", "盒索引", "孔位明细", "盒图", "回导原始值"]);
  assert.equal(singleWorkbook.Workbook.Sheets.at(-1).Hidden, 1);
  assert.equal(XLSX.utils.sheet_to_json(singleWorkbook.Sheets["孔位明细"]).length, 81);
  const allWorkbook = buildFreezerWorkbook(state.boxes, slots, "2000-02-01T00:00:00.000Z");
  assert.deepEqual(allWorkbook.SheetNames, ["使用说明", "盒索引", "全部孔位", "FBX-001", "FBX-002", "回导原始值"]);
  const allLedger = XLSX.utils.sheet_to_json(allWorkbook.Sheets["全部孔位"]);
  assert.equal(allLedger.length, 162);
  assert.equal(allLedger.find((record) => record["记录键"] === `FBX-002:${concentrationSlot.row}${concentrationSlot.column}`)?.["浓度（原始记录）"], 120.5);

  const unchangedPlan = planBoxLedgerImport(boxRecords, { ...state, slots });
  assert.equal(unchangedPlan.actions.length, 0);
  assert.equal(unchangedPlan.errors.length, 0);
  assert.equal(unchangedPlan.unchanged, 81);

  const editedRecord = { ...boxRecords.find((record) => record.recordKey === `FBX-002:${concentrationSlot.row}${concentrationSlot.column}`), concentration: "88 ng/µL", note: "批量回导测试" };
  const editedPlan = planBoxLedgerImport([editedRecord], { ...state, slots });
  assert.deepEqual(editedPlan.actions.map((action) => action.kind), ["update"]);
  const applied = applyBoxLedgerImport({ ...state, slots }, editedPlan);
  const appliedSlot = applied.slots.find((slot) => slot.id === concentrationSlot.id);
  assert.equal(appliedSlot?.concentration, "88 ng/µL");
  assert.equal(appliedSlot?.note, "批量回导测试");

  const strainSlot = state.slots.find((slot) => slot.materialType === "菌株");
  assert.ok(strainSlot);
  const strainRecord = buildBoxExportRecords(state.boxes, state.slots).find((record) => record.recordKey === `FBX-001:${strainSlot.row}${strainSlot.column}`);
  const taxonomyPlan = planBoxLedgerImport([{ ...strainRecord, taxonomy: "Bacillus subtilis" }], state);
  const taxonomyState = applyBoxLedgerImport(state, taxonomyPlan);
  assert.equal(taxonomyState.slots.find((slot) => slot.id === strainSlot.id)?.taxonomy, "Bacillus subtilis");

  const clearPlan = planBoxLedgerImport([{ ...editedRecord, occupied: "否" }], { ...state, slots });
  assert.equal(clearPlan.actions[0]?.kind, "clear");
  assert.equal(applyBoxLedgerImport({ ...state, slots }, clearPlan).slots.some((slot) => slot.id === concentrationSlot.id), false);
  assert.equal(planBoxLedgerImport([{ ...editedRecord, recordKey: "FBX-999:A1" }], state).errors.length, 1);

  const baseline = new Map(boxRecords.map((record) => [record.recordKey.toLowerCase(), record]));
  const original = baseline.get(editedRecord.recordKey.toLowerCase());
  const updated = { ...state, slots: slots.map((slot) => slot.id === concentrationSlot.id ? { ...slot, note: "工作台更新", updatedAt: "2000-02-01T08:00:00Z" } : slot) };
  assert.equal(planBoxLedgerImport(boxRecords, updated, baseline).actions.length, 0);
  assert.ok(planBoxLedgerImport([editedRecord], updated, baseline).errors[0].includes("备注"));
  assert.ok(planBoxLedgerImport([{ ...original, occupied: "否" }], updated, baseline).errors.length);
  assert.ok(planBoxLedgerImport([{ ...original, occupied: "" }], updated, baseline).errors.length);
  assert.ok(planBoxLedgerImport([{ ...original, storedAt: "2000-02-31" }], updated, baseline).errors.length);
  const mergePlan = planBoxLedgerImport([{ ...original, concentration: "88 ng/µL" }], updated, baseline);
  assert.equal(mergePlan.actions[0].slot.note, "工作台更新");
  assert.equal(mergePlan.actions[0].slot.concentration, "88 ng/µL");
  const empty = boxRecords.find((record) => record.occupied === "否");
  const addedSlot = { ...concentrationSlot, id: "new-tube", row: empty.coordinate[0], column: Number(empty.coordinate[1]) };
  const withNewTube = { ...state, slots: [...state.slots, addedSlot] };
  assert.equal(planBoxLedgerImport([empty], withNewTube, baseline).actions.length, 0);
  assert.equal(planBoxLedgerImport([empty], withNewTube).errors.length, 1);
});

test("keeps concurrent edits to different wells and reports same-well and box conflicts", async () => {
  const { mergeWorkbenchStates, upgradeWorkbenchState } = await import("../app/lib/workbench.ts");
  const base = sampleWorkspace();
  const change = (index, note) => ({ ...base, slots: base.slots.map((slot, i) => i === index ? { ...slot, note } : slot) });
  const draft = change(0, "A");
  const latest = change(1, "B");
  const merged = mergeWorkbenchStates(base, draft, latest);
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.state.slots.slice(0, 2).map((slot) => slot.note), ["A", "B"]);
  assert.deepEqual(mergeWorkbenchStates(base, draft, change(0, "B")), { ok: false, conflicts: ["FBX-001:A1"] });
  const afterUndo = mergeWorkbenchStates(draft, base, merged.state);
  assert.deepEqual(afterUndo.state.slots.slice(0, 2).map((slot) => slot.note), [base.slots[0].note, "B"]);
  const moved = { ...base, boxes: base.boxes.map((box) => box.identifier === "FBX-002" ? { ...box, position: "第2层" } : box) };
  assert.equal(upgradeWorkbenchState(moved).boxes.find((box) => box.identifier === "FBX-002").position, "第2层");
  const customDNA = { ...base, slots: base.slots.map((slot) => slot.boxId === "fixture-box-2" ? { ...slot, materialType: "DNA" } : slot) };
  assert.equal(upgradeWorkbenchState(customDNA).slots.find((slot) => slot.boxId === "fixture-box-2").materialType, "DNA");
});

test("rejects malformed workbench backups before replacing local data", async () => {
  const { prepareWorkbenchRestore } = await import("../app/lib/workbench.ts");
  const state = sampleWorkspace();
  assert.equal(prepareWorkbenchRestore(state).ok, true);
  const duplicatePosition = { ...state, slots: [...state.slots, { ...state.slots[0], id: "duplicate-slot" }] };
  const invalid = prepareWorkbenchRestore(duplicatePosition);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.includes("同一孔位")));
  assert.equal(prepareWorkbenchRestore({ boxes: [], slots: [] }).ok, false);
});

test("parses batch material lists and keeps uncertain matches explicit", async () => {
  const { buildBatchLookup, isBatchPickable, parseBatchLookupInput } = await import("../app/lib/batchLookup.ts");
  const state = sampleWorkspace();
  assert.deepEqual(parseBatchLookupInput("DEMO101\nDEMO303，DEMO202\tDEMO404; missing"), ["DEMO101", "DEMO303", "DEMO202", "DEMO404", "missing"]);

  const results = buildBatchLookup("DEMO101\ndemo101\nDEMO-101\nmissing", state.slots, "菌株");
  assert.equal(results[0].status, "exact");
  assert.equal(results[1].status, "normalized");
  assert.equal(results[2].status, "candidate");
  assert.equal(results[3].status, "not-found");
  assert.equal(results[0].slots.length, 2);
  assert.equal(buildBatchLookup("DEMO202", state.slots, "菌株")[0].slots.length, 3);
  assert.equal(buildBatchLookup("DEMO101", state.slots, "DNA")[0].status, "not-found");
  const first = results[0].slots[0];
  const box = state.boxes.find((box) => box.id === first.boxId);
  assert.equal(isBatchPickable(first, box), true);
  assert.equal(isBatchPickable({ ...first, status: "已废弃" }, box), false);
  assert.equal(isBatchPickable({ ...first, status: "待核对" }, box), false);
  assert.equal(isBatchPickable(first, { ...box, position: "待确认" }), false);
  assert.equal(buildBatchLookup("ＤＥＭＯ１０１", results[0].slots)[0].status, "normalized");
  assert.equal(buildBatchLookup("ＤＥＭＯ１０１", [first, { ...first, materialName: "demo101" }])[0].status, "ambiguous");
  assert.equal(buildBatchLookup("DEMO101", [first, { ...first, materialType: "DNA" }], "全部")[0].status, "ambiguous");
});

test("pairs only uniquely identified F/R imports and retains metadata", async () => {
  const { pairPrimerRecords, upgradeWorkbenchState } = await import("../app/lib/workbench.ts");
  const fixture = sampleWorkspace();
  const { primers: [forward, reverse] } = upgradeWorkbenchState({
    ...fixture,
    primers: [
      { id: "demo-f", name: "Demo-F", sequence: "ACGT", source: "示例来源" },
      { id: "demo-r", name: "Demo-R", sequence: "TGCA" },
    ],
  });

  const pairs = pairPrimerRecords([reverse, forward]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].forwardName, "Demo-F");
  assert.equal(pairs[0].reverseName, "Demo-R");
  assert.equal(pairs[0].source, "示例来源");
  assert.equal(pairPrimerRecords([forward, { ...reverse, name: "Other-R" }]).length, 2);
  assert.equal(pairPrimerRecords([{ ...forward, name: "One" }, { ...reverse, name: "Two" }]).length, 2);
  assert.equal(pairPrimerRecords([forward, { ...forward, id: "duplicate-f" }, reverse]).length, 3);
});

test("flags Primer issues and invalidates a review when a sequence changes", async () => {
  const { isPrimerSequenceReviewed, primerQualityIssues, primerSequenceReviewSignature } = await import("../app/lib/workbench.ts");
  const example = { name: "示例引物", forward: "_x001f_", reverse: "AC GT", reverseLength: "6", forwardName: "Demo", reverseName: "Demo" };
  const issues = primerQualityIssues(example);
  assert.ok(issues.some((issue) => issue.message.includes("Excel 控制字符")));
  assert.ok(issues.some((issue) => issue.message.includes("实际读取 4 nt")));
  assert.ok(issues.some((issue) => issue.field === "names"));
  assert.equal(example.forward, "_x001f_");
  const reviewed = { ...example, reviewedIssueSignature: primerSequenceReviewSignature(example) };
  assert.equal(isPrimerSequenceReviewed(reviewed), true);
  assert.equal(isPrimerSequenceReviewed({ ...reviewed, reverse: "AC GTT" }), false);
  assert.equal(primerQualityIssues({ sequence: "ACIT" }).some((issue) => issue.message.includes("非常规碱基")), false);
});

test("preserves reimbursement and import contracts", async () => {
  const [claims, app, css, freezerWorkbook] = await Promise.all([
    readFile(new URL("../app/components/ReimbursementPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/WorkbenchApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/freezerWorkbook.ts", import.meta.url), "utf8"),
  ]);
  assert.match(claims, /const DB_NAME = "research-workbench-community-claims"/);
  assert.match(claims, /const PACKAGE_BASENAME = "科研报销材料"/);
  assert.match(claims, /\["payment", "支付记录"\], \["purchase", "购买记录"\]/);
  assert.match(claims, /\["payment", "支付记录"\], \["invoice", "发票"\]/);
  assert.match(claims, /内容.*"价格（元）".*姓名.*类别/s);
  assert.match(claims, /全部待报销/);
  assert.match(claims, /selectedTotal/);
  assert.match(app, /粘贴 9×9 冻存盒/);
  assert.match(app, /\.xlsx,\.xls,\.csv,\.tsv/);
  assert.match(app, /名称与序列均相同的 Primer 只更新表格实际提供的列/);
  assert.match(app, /配方与实验流程网址/);
  assert.match(app, /管理冰箱与冻存盒/);
  assert.match(app, /删除整盒/);
  assert.match(app, /MATERIAL_TYPES\.map/);
  assert.match(app, /slot-note-marker/);
  assert.match(app, /保存日期/);
  assert.match(app, /提取日期/);
  assert.match(app, /浓度（原始记录）/);
  assert.match(app, /CONCENTRATION_MATERIAL_TYPES\.has/);
  assert.match(app, /盒标识符/);
  assert.match(app, /已被使用，请更换/);
  assert.match(app, /导出当前盒/);
  assert.match(app, /导出全部冻存盒/);
  assert.match(app, /对照导出原值与工作台现值/);
  assert.match(app, /未提供的靶标、用途、来源和备注不会被清空/);
  assert.match(app, /原有状态、浓度、日期与备注均保留/);
  assert.match(app, /撤销：/);
  assert.match(freezerWorkbook, /buildBoxExportRecords/);
  assert.match(freezerWorkbook, /使用说明/);
  assert.match(app, /单条序列（5′→3′）/);
  assert.match(app, /来源（DOI、文章链接或提供者）/);
  assert.match(app, /box\?\.freezer.*box\?\.position.*box\?\.name.*coordinate/s);
  assert.match(app, /openSearchMatch\(match\)/);
  assert.match(app, /setActiveBoxId\(slot\.boxId\)/);
  assert.match(app, /function openSearchMatch[\s\S]*?setSelectedCell\(null\)/);
  assert.match(app, /function openPendingSlot[\s\S]*?setSelectedCell\(\{ row: slot\.row, column: slot\.column \}\)/);
  assert.match(app, /primer-overview/);
  assert.match(app, /primer-meta-strip/);
  assert.match(app, /primer-note/);
  assert.match(app, /重点卡片/);
  assert.match(app, /Excel 表格/);
  assert.match(app, /紧凑列表/);
  assert.match(app, /冻存盒视图/);
  assert.match(app, /freezer-sheet/);
  assert.match(app, /research-workbench-community-freezer-view/);
  assert.match(app, /updateSlotFromTable/);
  assert.match(app, /离开单元格或按 Enter 自动保存/);
  assert.match(app, /sheet-material-input/);
  assert.match(app, /如需清空整支管/);
  assert.match(app, /primer-sheet/);
  assert.match(app, /primer-compact-list/);
  assert.match(app, /compact-oligo-row/);
  assert.match(app, /标注 \$\{length\} nt · 实际 \$\{actualLength\} nt/);
  assert.match(app, /primerDraft\.forwardLength/);
  assert.match(app, /primerDraft\.reverseLength/);
  assert.match(app, /primerDraft\.forwardTm/);
  assert.match(app, /primerDraft\.reverseTm/);
  assert.match(app, /research-workbench-community-primer-view/);
  assert.match(app, /MATERIAL INDEX/);
  assert.match(app, /搜索全部材料、孔位或 Primer/);
  assert.match(app, /Primer 序列或命名需核对/);
  assert.match(app, /标记已核对/);
  assert.match(app, /已人工核对/);
  assert.match(app, /markSlotReviewed/);
  assert.match(app, /togglePrimerReviewed/);
  assert.match(app, /research-workbench-community-last-backup/);
  assert.match(app, /为避免覆盖，当前已停止自动保存/);
  assert.match(app, /移动端主导航/);
  assert.match(app, /批量查找与取样清单/);
  assert.match(app, /按输入顺序/);
  assert.match(app, /按取样路线/);
  assert.match(app, /候选差异只提示，不自动认定/);
  assert.match(app, /科研工作台_批量查找_/);
  assert.match(claims, /选择当前/);
  assert.doesNotMatch(app, /index < 62/);
  assert.match(css, /\.mobile-nav.*grid-template-columns:\s*repeat\(5/s);
  assert.match(css, /\.box-cell\.discarded/);
  assert.match(css, /\.box-cell\.type-primer/);
  assert.match(css, /\.freezer-sheet-wrap/);
  assert.match(css, /\.freezer-sheet \{[^}]*font-size:\s*12px/);
  assert.match(css, /\.freezer-sheet input, \.freezer-sheet select \{[^}]*font-size:\s*11px/);
  assert.match(css, /\.freezer-sheet-help/);
  assert.match(css, /\.freezer-sheet input/);
  assert.match(css, /\.batch-workbench/);
  assert.match(css, /\.batch-route-list/);
});
