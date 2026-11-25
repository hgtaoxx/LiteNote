import { useEffect, useRef } from "react";
import { useTodoStore, initTodosSync } from "@/stores/todoStore";
import { useSettingsStore, initSettingsSync } from "@/stores/settingsStore";
import { useCategoryStore, initCategoriesSync } from "@/stores/categoryStore";

/**
 * 统一的应用初始化 hook。
 *
 * 职责：
 * 1. 从 DB 加载 todos 和 settings
 * 2. 注册跨窗口设置和待办同步监听
 *
 * 通过 initialized 标志确保只初始化一次（即使 StrictMode 双挂载）。
 *
 * @param loadTodos 是否需要加载待办数据（帮助窗口不需要）
 */
export function useAppInit(loadTodos = true): void {
  const settingsInitialized = useSettingsStore((s) => s.initialized);
  const todoInit = useTodoStore((s) => s.init);
  const categoryInit = useCategoryStore((s) => s.init);
  const settingsInit = useSettingsStore((s) => s.init);

  const hasTodoInited = useRef(false);
  const hasCategoryInited = useRef(false);
  const hasSettingsInited = useRef(false);
  const settingsSyncCleanup = useRef<(() => void) | null>(null);
  const todosSyncCleanup = useRef<(() => void) | null>(null);
  const categoriesSyncCleanup = useRef<(() => void) | null>(null);

  // 初始化设置
  useEffect(() => {
    if (!settingsInitialized && !hasSettingsInited.current) {
      hasSettingsInited.current = true;
      settingsInit()
        .then(() => console.log("[LiteNote] Settings 初始化完成"))
        .catch((e) => console.error("[LiteNote] Settings 初始化失败:", e));
    }
  }, [settingsInitialized, settingsInit]);

  // 初始化待办；分类表由 todo 初始化时建好，随后再加载分类。
  useEffect(() => {
    if (loadTodos && !hasTodoInited.current) {
      hasTodoInited.current = true;
      todoInit()
        .then(async () => {
          if (hasCategoryInited.current) return;
          hasCategoryInited.current = true;
          await categoryInit();
          console.log("[LiteNote] Categories 初始化完成");
        })
        .catch((e) => console.error("[LiteNote] Todos/Categories 初始化失败:", e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 注册跨窗口同步监听
  useEffect(() => {
    settingsSyncCleanup.current = initSettingsSync();
    todosSyncCleanup.current = initTodosSync();
    categoriesSyncCleanup.current = initCategoriesSync();
    return () => {
      if (settingsSyncCleanup.current) {
        settingsSyncCleanup.current();
        settingsSyncCleanup.current = null;
      }
      if (todosSyncCleanup.current) {
        todosSyncCleanup.current();
        todosSyncCleanup.current = null;
      }
      if (categoriesSyncCleanup.current) {
        categoriesSyncCleanup.current();
        categoriesSyncCleanup.current = null;
      }
    };
  }, []);
}
