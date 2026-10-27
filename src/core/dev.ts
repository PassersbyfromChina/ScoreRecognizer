/** 开发期演示数据（只在 dev 服务器 + ?seed=demo 时生效）。 */
import type { CardTemplate, Project, Region } from "./types";
import { DEFAULT_ASPECT, DEFAULT_LONG_SIDE, correctCard, loadCard, targetSize } from "./imaging/pipeline";
import { applyHomography, solveHomography } from "./imaging/geometry";
import { canvasToBlob } from "./imaging/canvas";

const DEMO_NAMES = [
  "陈晓", "李然", "王雨", "赵一", "周童", "吴迪", "郑好", "孙悦",
  "林可", "何平", "高远", "罗晨", "梁爽", "宋佳", "唐宁", "许诺",
  "邓超", "冯雪", "曾琳", "程诺", "蔡明", "潘悦", "袁梦", "于洋",
  "董浩", "余乐", "苏晴", "叶青", "吕行", "魏然",
];

export async function maybeSeedForDev(): Promise<void> {
  if (!import.meta.env.DEV) return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("seed") !== "demo") return;

  const repo = await import("./storage/repo");
  const settings = await repo.loadSettings();
  if (!settings.onboarded) {
    await repo.saveSettings({ ...settings, onboarded: true, aiEnabled: false, apiKey: "" });
  }
  let projects = await repo.listProjects();
  let project: Project;
  if (projects.length === 0) {
    project = await repo.createProject("高二(3)班 · 单元测验");
    project = {
      ...project,
      students: repo.normalizeStudents(DEMO_NAMES),
      sourceFile: "高二3班名单.xlsx",
      importMeta: { sheetName: "Sheet1", headerRow: 0, nameColumn: 1, startRow: 1 },
    };
    await repo.saveProject(project);
  } else {
    project = projects[0];
  }

  if (!project.templateId && params.get("template") !== "0") {
    try {
      const template = await seedTemplate(project);
      if (template) {
        project = { ...project, templateId: template.id };
        await repo.saveProject(project);
      }
    } catch (e) {
      console.warn("seed template failed", e);
    }
  }

  const wantedCaptures = Number(params.get("captures") || 0);
  if (wantedCaptures > 0 && project.templateId) {
    try {
      const template = await repo.getTemplate(project.templateId);
      if (template) await seedCaptures(project, template, Math.min(6, wantedCaptures));
    } catch (e) {
      console.warn("seed captures failed", e);
    }
  }
}

/** 生成几张「已处理完、待确认」的答题卡，方便开发核对/导出界面。 */
async function seedCaptures(project: Project, template: CardTemplate, count: number): Promise<void> {
  const repo = await import("./storage/repo");
  const existing = await repo.listCaptures(project.id);
  if (existing.length > 0) return;
  const settings = await repo.loadSettings();
  const { processCapture } = await import("./recognition/engine");
  const demoValues = [8, 7, 6, -2, 5, 9, -1, 4, 10, 0, 7, 5, 8, -3, 6, 4, 9, 5, -2, 7];

  for (let i = 0; i < count; i++) {
    const resp = await fetch(`./samples/card-photo-${(i % 3) + 1}.jpg`);
    if (!resp.ok) return;
    const blob = await resp.blob();
    const result = await processCapture(blob, {
      settings: { ...settings, aiEnabled: false },
      template,
      students: project.students,
    });
    const answers = result.answers.map((a, idx) => {
      if (idx % 9 === 4) {
        return { ...a, rawScore: null, confidence: 0.2, state: "multiple" as const, finalScore: null, note: "同一题出现两个分数" };
      }
      if (idx % 7 === 3) {
        return { ...a, rawScore: null, confidence: 0, state: "missing" as const, finalScore: null, note: "没有找到红色分数" };
      }
      if (idx % 5 === 2) {
        return { ...a, rawScore: demoValues[idx % demoValues.length], confidence: 0.45, state: "low_confidence" as const, finalScore: null };
      }
      return {
        ...a,
        rawScore: demoValues[idx % demoValues.length],
        confidence: 0.93,
        state: "ok" as const,
        finalScore: null,
        note: undefined,
      };
    });

    const imageKey = await repo.putImage(blob);
    const correctedKey = await repo.putImage(result.correctedBlob);
    const student = project.students[i % Math.max(1, project.students.length)];
    const now = Date.now() + i;
    const assigned = i < 2 && student;
    await repo.saveCapture({
      id: `cap_dev_${i + 1}`,
      projectId: project.id,
      createdAt: now,
      updatedAt: now,
      status: "pending_review",
      imageKey,
      correctedKey,
      answers,
      nameText: assigned ? student.name : i === 2 ? "王雨？" : undefined,
      nameConfidence: assigned ? 0.94 : 0.42,
      nameState: assigned ? "ok" : "low_confidence",
      studentId: assigned ? student.id : undefined,
    });
  }
}

/** 用模拟样张创建一个可直接使用的模板，方便开发时测试拍摄/识别流程。 */
async function seedTemplate(project: Project): Promise<CardTemplate | null> {
  const repo = await import("./storage/repo");
  const resp = await fetch("./samples/card-flat-1.jpg");
  if (!resp.ok) return null;
  const blob = await resp.blob();
  // 和真实模板流程一致：先检测边缘，再把版面坐标投影到矫正后的画布上
  const loaded = await loadCard(blob);
  const canvas = correctCard(loaded.canvas, loaded.corners, DEFAULT_ASPECT, DEFAULT_LONG_SIDE);
  const target = targetSize(DEFAULT_ASPECT, DEFAULT_LONG_SIDE);
  const long = Math.max(target.width, target.height);
  const homography = solveHomography(loaded.corners, [
    { x: 0, y: 0 },
    { x: target.width, y: 0 },
    { x: target.width, y: target.height },
    { x: 0, y: target.height },
  ]);

  // 与 _build/gen_samples.py 里的排版保持一致（源图 1240x1754）
  const LAYOUT_W = 1240;
  const LAYOUT_H = 1754;
  const scaleX = loaded.width / LAYOUT_W;
  const scaleY = loaded.height / LAYOUT_H;
  const norm = (x: number, y: number) => {
    const p = applyHomography(homography, { x: x * scaleX, y: y * scaleY });
    return { x: p.x / long, y: p.y / long };
  };
  const makeRegion = (
    id: string,
    kind: Region["kind"],
    x: number,
    y: number,
    w: number,
    h: number,
    questionNo?: number,
  ): Region => {
    const tl = norm(x, y);
    const br = norm(x + w, y + h);
    return { id, kind, questionNo, x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  };

  const boxW = 480;
  const boxH = 118;
  const top = 300;
  const gap = 18;
  const x0s = [70, 660];
  const regions: Region[] = [];
  for (let i = 0; i < 20; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = x0s[col];
    const y = top + row * (boxH + gap);
    regions.push(makeRegion(`rg_dev_${i + 1}`, "question", x, y, boxW, boxH, i + 1));
  }
  regions.push(makeRegion("rg_dev_name", "name", 145, 180, 285, 55));

  const now = Date.now();
  const correctedKey = await repo.putImage(await canvasToBlob(canvas, "image/jpeg", 0.92));
  const imageKey = await repo.putImage(blob);
  const template: CardTemplate = {
    id: repo.newId("tpl"),
    name: `${project.name} 答题卡模板`,
    createdAt: now,
    updatedAt: now,
    imageWidth: loaded.width,
    imageHeight: loaded.height,
    imageKey,
    correctedKey,
    corners: loaded.corners,
    regions,
    aspect: DEFAULT_ASPECT,
  };
  await repo.saveTemplate(template);
  return template;
}

export function devScreenParam(): string | null {
  if (!import.meta.env.DEV) return null;
  return new URLSearchParams(window.location.search).get("screen");
}
