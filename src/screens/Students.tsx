import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Download,
  FileSpreadsheet,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useAppStore } from "../core/store";
import type { NameImportResult } from "../core/types";
import type { ParsedWorkbook } from "../core/excel/import";
import { buildImportResult, parseWorkbookFile, suggestNameImport } from "../core/excel/import";
import { toast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";
import { isNativeMobile } from "../core/platform";

interface Selection {
  sheetName: string;
  headerRow: number;
  nameColumn: number;
  startRow: number;
}

export function StudentsScreen() {
  const project = useAppStore((s) => s.project);
  const importStudents = useAppStore((s) => s.importStudents);
  const addStudent = useAppStore((s) => s.addStudent);
  const removeStudent = useAppStore((s) => s.removeStudent);
  const renameStudent = useAppStore((s) => s.renameStudent);

  const [importOpen, setImportOpen] = useState(false);
  const [wb, setWb] = useState<ParsedWorkbook | null>(null);
  const [fileName, setFileName] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const result: NameImportResult | null = useMemo(() => {
    if (!wb || !selection) return null;
    return buildImportResult(wb, selection.sheetName, selection.headerRow, selection.nameColumn, selection.startRow);
  }, [wb, selection]);

  useEffect(() => {
    if (!importOpen) {
      setWb(null);
      setFileName("");
      setSelection(null);
    }
  }, [importOpen]);

  const openFile = useCallback(async (file: File) => {
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseWorkbookFile(file.name, buf);
      setWb(parsed);
      setFileName(file.name);
      const suggested = suggestNameImport(parsed);
      if (suggested) {
        setSelection({
          sheetName: suggested.sheetName,
          headerRow: suggested.headerRow,
          nameColumn: suggested.nameColumn,
          startRow: suggested.startRow,
        });
      } else {
        const first = parsed.sheets[0];
        if (first) {
          setSelection({ sheetName: first.name, headerRow: 0, nameColumn: 0, startRow: 0 });
          toast("没自动认出姓名列，请手动选择", "err");
        }
      }
    } catch (e) {
      console.error(e);
      toast("这个文件读不出来，请确认是 .xlsx / .xls / .csv 文件", "err");
    } finally {
      setBusy(false);
    }
  }, []);

  async function doImport() {
    if (!result || result.names.length === 0) return;
    setBusy(true);
    try {
      await importStudents(
        result.names.map((n) => n.name),
        {
          sheetName: result.sheetName,
          headerRow: result.headerRow,
          nameColumn: result.nameColumn,
          startRow: result.startRow,
        },
        fileName,
      );
      toast(`已导入 ${result.names.length} 名学生`, "ok");
      setImportOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    await addStudent(newName.trim());
    setNewName("");
  }

  function startEdit(id: string, name: string) {
    setEditingId(id);
    setEditingValue(name);
  }

  async function commitEdit() {
    if (!editingId) return;
    const name = editingValue.trim();
    if (name) await renameStudent(editingId, name);
    setEditingId(null);
  }

  if (!project) {
    return (
      <div className="page-inner">
        <div className="empty">
          <div className="icon">
            <Users size={22} />
          </div>
          <div className="title">还没有班级</div>
          <div className="desc">先在「首页」创建一个班级，再导入学生名单。</div>
        </div>
      </div>
    );
  }

  const currentSheet = wb?.sheets.find((s) => s.name === selection?.sheetName);

  return (
    <div className="page-inner">
      <div className="page-head">
        <div className="titles">
          <h1>学生名单</h1>
          <div className="desc">
            {project.importMeta
              ? `来自 ${project.sourceFile ?? "Excel"} · 工作表「${project.importMeta.sheetName}」· 姓名在第 ${project.importMeta.nameColumn + 1} 列 · 从第 ${project.importMeta.startRow + 1} 行开始`
              : "从 Excel 导入姓名，也可以手动添加"}
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => setImportOpen(true)}>
            <Upload size={16} />
            {project.students.length > 0 ? "重新导入 Excel" : "导入 Excel"}
          </button>
        </div>
      </div>

      {!importOpen && (
        <div className="card">
          <div className="card-head">
            <h2>名单</h2>
            <span className="sub">{project.students.length} 人</span>
            <span className="spacer" />
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input"
                style={{ height: 34, width: 180 }}
                placeholder="手动添加姓名"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
              <button className="btn btn-secondary btn-sm" onClick={handleAdd} disabled={!newName.trim()}>
                <Plus size={14} />
                添加
              </button>
            </div>
          </div>
          {project.students.length === 0 ? (
            <div className="empty">
              <div className="icon">
                <FileSpreadsheet size={22} />
              </div>
              <div className="title">名单还是空的</div>
              <div className="desc">
                点右上角「导入 Excel」，应用会自动找「姓名 / 名字」表头。也可以直接手动添加。
              </div>
            </div>
          ) : (
            <div className="table-wrap" style={{ maxHeight: "calc(100vh - 280px)" }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="num">序号</th>
                    <th>姓名</th>
                    <th style={{ width: 120, textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {project.students.map((s, i) => (
                    <tr key={s.id}>
                      <td className="num">{i + 1}</td>
                      <td>
                        {editingId === s.id ? (
                          <input
                            className="input"
                            style={{ height: 30, maxWidth: 220 }}
                            value={editingValue}
                            autoFocus
                            onChange={(e) => setEditingValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdit();
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            onBlur={commitEdit}
                          />
                        ) : (
                          <span style={{ fontWeight: 550 }}>{s.name}</span>
                        )}
                      </td>
                      <td className="actions">
                        <button className="btn btn-icon btn-ghost" title="修改" onClick={() => startEdit(s.id, s.name)}>
                          <Pencil size={14} />
                        </button>
                        <button
                          className="btn btn-icon btn-ghost"
                          title="删除"
                          style={{ color: "var(--red)" }}
                          onClick={() => setDeleteTarget(s.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {importOpen && (
        <div className="card">
          <div className="card-head">
            <h2>导入姓名 Excel</h2>
            <span className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => setImportOpen(false)}>
              <X size={14} />
              取消
            </button>
          </div>
          <div className="card-body">
            {!wb && (
              <>
                <div
                  className={`dropzone ${dragging ? "over" : ""}`}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) openFile(f);
                  }}
                >
                  <div className="dz-icon">{busy ? <span className="spinner" /> : <Upload size={22} />}</div>
                  <div className="dz-title">{isNativeMobile() ? "点这里选择 Excel / CSV 文件" : "把 Excel 拖到这里，或点击选择文件"}</div>
                  <div className="dz-desc">支持 .xlsx / .xls / .csv；表头写「姓名」「名字」等都能识别</div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv,.txt"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) openFile(f);
                      e.target.value = "";
                    }}
                  />
                </div>
                <div className="notice notice-info" style={{ marginTop: 16 }}>
                  <Info size={15} />
                  <div>
                    表头那行不会被当成学生姓名。没有表头也没关系，导入前可以手动选择姓名列和开始行。
                  </div>
                </div>
              </>
            )}

            {wb && selection && (
              <>
                <div className="row wrap" style={{ marginBottom: 14, alignItems: "flex-end" }}>
                  <div className="field" style={{ marginBottom: 0, minWidth: 200 }}>
                    <label className="label">文件</label>
                    <div className="row" style={{ gap: 8 }}>
                      <FileSpreadsheet size={16} color="var(--red)" />
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{fileName}</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
                        <RefreshCw size={13} />
                        换一个
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".xlsx,.xls,.csv,.txt"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) openFile(f);
                          e.target.value = "";
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="import-grid" style={{ display: "grid", gridTemplateColumns: "1.2fr .8fr 1.6fr .8fr", gap: 12 }}>
                  <div className="field">
                    <label className="label">工作表</label>
                    <select
                      className="select"
                      value={selection.sheetName}
                      onChange={(e) => setSelection({ ...selection, sheetName: e.target.value })}
                    >
                      {wb.sheets.map((s) => (
                        <option key={s.name} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="label">表头所在行</label>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      value={selection.headerRow + 1}
                      onChange={(e) =>
                        setSelection({ ...selection, headerRow: Math.max(0, Number(e.target.value) - 1) })
                      }
                    />
                  </div>
                  <div className="field">
                    <label className="label">姓名列</label>
                    <select
                      className="select"
                      value={selection.nameColumn}
                      onChange={(e) => setSelection({ ...selection, nameColumn: Number(e.target.value) })}
                    >
                      {(result?.columns ?? []).map((c) => (
                        <option key={c.index} value={c.index}>
                          第 {c.index + 1} 列{c.header ? `：${c.header}` : ""}
                          {c.sample.length ? `（${c.sample.slice(0, 2).join("、")}…）` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="label">姓名从第几行开始</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={selection.startRow + 1}
                      onChange={(e) =>
                        setSelection({ ...selection, startRow: Math.max(0, Number(e.target.value) - 1) })
                      }
                    />
                  </div>
                </div>

                {result && result.warnings.length > 0 && (
                  <div className="notice notice-warn" style={{ margin: "6px 0 14px" }}>
                    <Info size={15} />
                    <div>
                      {result.warnings.map((w, i) => (
                        <div key={i}>{w}</div>
                      ))}
                    </div>
                  </div>
                )}

                {result && result.names.length > 0 ? (
                  <div className="card" style={{ boxShadow: "none" }}>
                    <div className="card-head">
                      <h3>预览</h3>
                      <span className="sub">共 {result.names.length} 人</span>
                      <span className="spacer" />
                      <span className="faint small">显示前 8 个</span>
                    </div>
                    <div className="card-body" style={{ padding: 0 }}>
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th className="num">行</th>
                            <th>姓名</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentSheet &&
                            result.names.slice(0, 8).map((n) => (
                              <tr key={n.row}>
                                <td className="num">{n.row + 1}</td>
                                <td style={{ fontWeight: 550 }}>{n.name}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="empty" style={{ padding: 28 }}>
                    <div className="icon">
                      <FileSpreadsheet size={22} />
                    </div>
                    <div className="title">这一列没有读到姓名</div>
                    <div className="desc">换一个姓名列，或者调整「姓名从第几行开始」。</div>
                  </div>
                )}

                <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
                  <button className="btn btn-ghost" onClick={() => setImportOpen(false)}>
                    取消
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={!result || result.names.length === 0 || busy}
                    onClick={doImport}
                  >
                    <Check size={16} />
                    导入 {result?.names.length ?? 0} 人
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {!importOpen && project.students.length > 0 && (
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}></div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除学生"
          message="确定要从名单里删除这名学生吗？已识别到该学生的答题卡不会被删除，但会变成未认领状态。"
          confirmText="删除"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            if (deleteTarget) removeStudent(deleteTarget);
            setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}
