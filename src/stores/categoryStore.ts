import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  insertCategory,
  loadCategories,
  removeCategory,
  updateCategory,
} from "@/lib/db";
import { UNCATEGORIZED_CATEGORY_ID, type CategoryItem } from "@/types/todo";
import { freeColorFor } from "@/lib/categoryColors";
import { useTodoStore } from "@/stores/todoStore";

export interface CategoryStoreState {
  categories: CategoryItem[];
  loaded: boolean;
  lastError: string | null;
  lastSuccess: string | null;
}

export interface CategoryStoreActions {
  init: () => Promise<void>;
  reloadFromDb: () => Promise<void>;
  addCategory: (name: string) => CategoryItem | null;
  renameCategory: (id: string, name: string) => boolean;
  /** color："#rrggbb" / NO_CATEGORY_COLOR，选完即入库 */
  setCategoryColor: (id: string, color: string) => boolean;
  deleteCategory: (id: string) => void;
  moveCategory: (id: string, delta: number) => boolean;
  clearError: () => void;
  setSuccess: (msg: string) => void;
  clearSuccess: () => void;
}

function normalizeName(raw: string): string {
  return raw.trim().slice(0, 40);
}

function customCategories(categories: CategoryItem[]): CategoryItem[] {
  return categories
    .filter((c) => c.id !== UNCATEGORIZED_CATEGORY_ID && !c.system)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createTime - b.createTime || a.id.localeCompare(b.id));
}

function sortedCategories(categories: CategoryItem[]): CategoryItem[] {
  const custom = customCategories(categories);
  const uncategorized = categories.find(
    (c) => c.id === UNCATEGORIZED_CATEGORY_ID || c.system,
  );
  return uncategorized ? [...custom, uncategorized] : custom;
}

function dbWrite(
  promise: Promise<unknown>,
  label: string,
  onError: (msg: string) => void,
): void {
  promise
    .then(() => console.log(`[LiteNote] ${label} ✅`))
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[LiteNote] ${label} ❌`, e);
      onError(`${label} 失败: ${msg}`);
    });
}

export const useCategoryStore = create<CategoryStoreState & CategoryStoreActions>()(
  (set, get) => ({
    categories: [],
    loaded: false,
    lastError: null,
    lastSuccess: null,

    init: async () => {
      const categories = sortedCategories(await loadCategories());
      set({ categories, loaded: true });
    },

    reloadFromDb: async () => {
      const categories = sortedCategories(await loadCategories());
      set({ categories, loaded: true });
      console.log("[LiteNote] Categories 已从数据库重新加载");
    },

    clearError: () => set({ lastError: null }),
    setSuccess: (msg) => set({ lastSuccess: msg }),
    clearSuccess: () => set({ lastSuccess: null }),

    addCategory: (rawName) => {
      const name = normalizeName(rawName);
      if (!name) {
        set({ lastError: "标签名称不能为空" });
        return null;
      }
      const current = get().categories;
      if (current.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        set({ lastError: "已有同名标签" });
        return null;
      }

      const now = Date.now();
      const category: CategoryItem = {
        id: crypto.randomUUID(),
        name,
        color: freeColorFor(customCategories(current)),
        sortOrder: customCategories(current).reduce((max, c) => Math.max(max, c.sortOrder), 0) + 1,
        createTime: now,
        updateTime: now,
        system: false,
      };
      set({ categories: [...current, category] });
      dbWrite(insertCategory(category), "addCategory", (msg) => set({ lastError: msg }));
      return category;
    },

    renameCategory: (id, rawName) => {
      const name = normalizeName(rawName);
      const current = get().categories;
      const target = current.find((c) => c.id === id);
      if (!target || target.system) return false;
      if (!name) {
        set({ lastError: "标签名称不能为空" });
        return false;
      }
      if (current.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) {
        set({ lastError: "已有同名标签" });
        return false;
      }

      const now = Date.now();
      const updated = { ...target, name, updateTime: now };
      set({ categories: current.map((c) => (c.id === id ? updated : c)) });
      dbWrite(updateCategory(updated), "renameCategory", (msg) => set({ lastError: msg }));
      return true;
    },

    setCategoryColor: (id, color) => {
      const current = get().categories;
      const target = current.find((c) => c.id === id);
      if (!target || target.system) return false;

      const now = Date.now();
      const updated = { ...target, color, updateTime: now };
      set({ categories: current.map((c) => (c.id === id ? updated : c)) });
      dbWrite(updateCategory(updated), "setCategoryColor", (msg) => set({ lastError: msg }));
      return true;
    },

    deleteCategory: (id) => {
      const current = get().categories;
      const target = current.find((c) => c.id === id);
      if (!target || target.system) return;

      const now = Date.now();
      set({ categories: current.filter((c) => c.id !== id) });
      useTodoStore.setState((s) => ({
        todos: s.todos.map((todo) =>
          todo.categoryId === id
            ? { ...todo, categoryId: UNCATEGORIZED_CATEGORY_ID, updateTime: now }
            : todo,
        ),
      }));
      dbWrite(removeCategory(id), "deleteCategory", (msg) => set({ lastError: msg }));
    },

    moveCategory: (id, delta) => {
      const current = get().categories;
      const custom = customCategories(current);
      const from = custom.findIndex((c) => c.id === id);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= custom.length) return false;

      const reordered = [...custom];
      const [moved] = reordered.splice(from, 1);
      reordered.splice(to, 0, moved);
      const withOrders = reordered.map((c, i) => ({ ...c, sortOrder: i + 1 }));
      const uncategorized = current.find(
        (c) => c.id === UNCATEGORIZED_CATEGORY_ID || c.system,
      );
      const nextCategories = sortedCategories([
        ...withOrders,
        ...(uncategorized ? [uncategorized] : []),
      ]);
      set({ categories: nextCategories });

      const now = Date.now();
      for (const c of withOrders) {
        const updated = { ...c, updateTime: now };
        dbWrite(updateCategory(updated), "moveCategory", (msg) => set({ lastError: msg }));
      }
      return true;
    },
  }),
);

const CATEGORIES_EVENT = "litenote-categories-updated";

let _categoriesSyncInitDone = false;

/** 同步或提醒窗改过分类后，让其它 WebView 从数据库重新载入。 */
export function initCategoriesSync(): () => void {
  if (_categoriesSyncInitDone) return () => {};
  _categoriesSyncInitDone = true;

  let unlisten: (() => void) | null = null;
  listen<{ ts: number; source?: string }>(CATEGORIES_EVENT, async (event) => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (event.payload.source === getCurrentWindow().label) return;
    await useCategoryStore.getState().reloadFromDb();
  }).then((fn) => {
    unlisten = fn;
  });

  return () => {
    if (unlisten) unlisten();
    _categoriesSyncInitDone = false;
  };
}

