/** 开发期演示数据（只在 dev 服务器 + ?seed=demo 时生效，不会进入打包产物逻辑）。 */
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
  const projects = await repo.listProjects();
  if (projects.length === 0) {
    const project = await repo.createProject("高二(3)班 · 单元测验");
    await repo.saveProject({
      ...project,
      students: repo.normalizeStudents(DEMO_NAMES),
      sourceFile: "高二3班名单.xlsx",
      importMeta: { sheetName: "Sheet1", headerRow: 0, nameColumn: 1, startRow: 1 },
    });
  }
}

export function devScreenParam(): string | null {
  if (!import.meta.env.DEV) return null;
  return new URLSearchParams(window.location.search).get("screen");
}
