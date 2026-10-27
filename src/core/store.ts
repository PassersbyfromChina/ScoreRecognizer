import { create } from "zustand";
import type { AppSettings, Capture, CardTemplate, Project, Student } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import * as repo from "./storage/repo";
import { idbGet, idbPut, STORES } from "./storage/db";

const CURRENT_PROJECT_KEY = "current-project";

interface AppState {
  ready: boolean;
  settings: AppSettings;
  project: Project | null;
  template: CardTemplate | null;
  captures: Capture[];

  init: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  completeOnboarding: (patch: Partial<AppSettings>) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  refreshProject: () => Promise<void>;
  deleteCurrentProject: () => Promise<void>;
  importStudents: (names: string[], meta?: Project["importMeta"], sourceFile?: string) => Promise<void>;
  addStudent: (name: string) => Promise<void>;
  removeStudent: (id: string) => Promise<void>;
  renameStudent: (id: string, name: string) => Promise<void>;
  refreshCaptures: () => Promise<void>;
  setTemplate: (template: CardTemplate | null) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => {
  async function persistProject(project: Project) {
    await repo.saveProject(project);
    const updated = (await repo.getProject(project.id)) ?? project;
    set({ project: updated });
  }

  return {
    ready: false,
    settings: DEFAULT_SETTINGS,
    project: null,
    template: null,
    captures: [],

    init: async () => {
      const settings = await repo.loadSettings();
      const currentId = await idbGet<string>(STORES.kv, CURRENT_PROJECT_KEY);
      let project: Project | null = null;
      if (currentId) project = (await repo.getProject(currentId)) ?? null;
      if (!project) {
        const projects = await repo.listProjects();
        project = projects[0] ?? null;
      }
      const captures = project ? await repo.listCaptures(project.id) : [];
      const template = project?.templateId ? (await repo.getTemplate(project.templateId)) ?? null : null;
      set({ ready: true, settings, project, captures, template });
    },

    updateSettings: async (patch) => {
      const settings = { ...get().settings, ...patch };
      await repo.saveSettings(settings);
      set({ settings });
    },

    completeOnboarding: async (patch) => {
      const settings = { ...get().settings, ...patch, onboarded: true };
      await repo.saveSettings(settings);
      set({ settings });
    },

    createProject: async (name) => {
      const project = await repo.createProject(name);
      await idbPut(STORES.kv, project.id, CURRENT_PROJECT_KEY);
      set({ project, captures: [], template: null });
    },

    selectProject: async (id) => {
      const project = await repo.getProject(id);
      if (!project) return;
      await idbPut(STORES.kv, id, CURRENT_PROJECT_KEY);
      const captures = await repo.listCaptures(id);
      const template = project.templateId ? (await repo.getTemplate(project.templateId)) ?? null : null;
      set({ project, captures, template });
    },

    refreshProject: async () => {
      const current = get().project;
      if (!current) return;
      const project = (await repo.getProject(current.id)) ?? current;
      const template = project.templateId ? (await repo.getTemplate(project.templateId)) ?? null : null;
      set({ project, template });
    },

    deleteCurrentProject: async () => {
      const current = get().project;
      if (!current) return;
      await repo.deleteProject(current.id);
      const projects = await repo.listProjects();
      const next = projects[0] ?? null;
      if (next) await idbPut(STORES.kv, next.id, CURRENT_PROJECT_KEY);
      const captures = next ? await repo.listCaptures(next.id) : [];
      set({ project: next, captures, template: null });
    },

    importStudents: async (names, meta, sourceFile) => {
      const current = get().project;
      if (!current) return;
      const students = repo.normalizeStudents(names);
      const project: Project = {
        ...current,
        students,
        importMeta: meta ?? current.importMeta,
        sourceFile: sourceFile ?? current.sourceFile,
      };
      await persistProject(project);
    },

    addStudent: async (name) => {
      const current = get().project;
      if (!current || !name.trim()) return;
      const students: Student[] = [
        ...current.students,
        { id: repo.newId("stu"), order: current.students.length, name: name.trim() },
      ];
      await persistProject({ ...current, students });
    },

    removeStudent: async (id) => {
      const current = get().project;
      if (!current) return;
      const students = current.students
        .filter((s) => s.id !== id)
        .map((s, i) => ({ ...s, order: i }));
      await persistProject({ ...current, students });
    },

    renameStudent: async (id, name) => {
      const current = get().project;
      if (!current || !name.trim()) return;
      const students = current.students.map((s) => (s.id === id ? { ...s, name: name.trim() } : s));
      await persistProject({ ...current, students });
    },

    refreshCaptures: async () => {
      const current = get().project;
      if (!current) return;
      const captures = await repo.listCaptures(current.id);
      set({ captures });
    },

    setTemplate: async (template) => {
      const current = get().project;
      if (!current) return;
      if (template) await repo.saveTemplate(template);
      const project = { ...current, templateId: template?.id };
      await persistProject(project);
      set({ template });
    },
  };
});

export function captureCounts(captures: Capture[]) {
  const counts = {
    pending_capture: 0,
    pending_process: 0,
    pending_review: 0,
    done: 0,
  } as Record<Capture["status"], number>;
  for (const c of captures) counts[c.status] += 1;
  return counts;
}

/** 顶部状态栏用的统计：待拍摄 = 名单里还没有答题卡的学生数。 */
export function batchCounts(project: Project | null, captures: Capture[]) {
  const counts = captureCounts(captures);
  const students = project?.students.length ?? 0;
  counts.pending_capture = Math.max(0, students - captures.length);
  return counts;
}
