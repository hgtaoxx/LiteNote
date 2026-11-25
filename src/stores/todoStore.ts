import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { TodoItem, RecurrenceType } from "@/types/todo";
import { UNCATEGORIZED_CATEGORY_ID } from "@/types/todo";
import {
  loadTodos,
  insertTodo,
  updateTodo,
  removeTodo,
  clearCompletedTodos as dbClearCompleted,
} from "@/lib/db";

// ──────────────── 类型定义 ────────────────

export interface TodoStoreState {
  todos: TodoItem[];
  /**
   * 列表是否已经从数据库加载过至少一次。
   * 「内容变化才自动同步」要靠它区分「加载完成」和「用户真的改了」：
   * 只看 todos 的签名会把开机那一次加载误判成改动，导致每次启动都多发一次同步。
   */
  loaded: boolean;
  /** 最近一次 DB 写入错误信息 */
  lastError: string | null;
  /** 最近一次操作成功提示 */
  lastSuccess: string | null;
}

export interface TodoStoreActions {
  init: () => Promise<void>;
  reloadFromDb: () => Promise<void>;
  addTodo: (categoryId?: string) => string;
  /** 实时更新文本（仅内存，不写 DB） */
  updateTodoText: (id: string, text: string) => void;
  /** 提交编辑（blur / Enter 时调用）：写 DB */
  commitTodoEdit: (id: string) => void;
  deleteTodo: (id: string) => void;
  clearCompletedTodos: () => void;
  togglePinned: (id: string) => void;
  toggleCompleted: (id: string) => void;
  setTodoColor: (id: string, colorId: TodoItem["colorId"]) => void;
  setTodoCategory: (id: string, categoryId: string) => void;
  setTodoDueDate: (id: string, dueDate: number) => void;
  setTodoRecurrence: (
    id: string,
    isRecurring: boolean,
    type: RecurrenceType,
    config: string,
  ) => void;
  /** 直接更新一条 todo（用于自动推进循环时间等场景） */
  updateTodoDirect: (id: string, dueDate: number) => void;
  /** 拖拽排序：将 fromId 移到 toId 的位置；传 categoryId 时只在本分类内排序 */
  reorderTodos: (fromId: string, toId: string, categoryId?: string) => void;
  /** 复制待办到指定截止日期（生成新条目，原始不变） */
  duplicateTodo: (id: string, dueDate: number) => void;
  clearError: () => void;
  /** 设置操作成功提示 */
  setSuccess: (msg: string) => void;
  clearSuccess: () => void;
}

function nextOrder(todos: TodoItem[]): number {
  if (todos.length === 0) return 1;
  return Math.max(...todos.map((x) => x.sortOrder)) + 1;
}

// ──────────────── 异步 DB 写（带错误反馈） ────────────────

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

// ──────────────── Store ────────────────

export const useTodoStore = create<TodoStoreState & TodoStoreActions>()(
  (set, get) => ({
    todos: [],
    loaded: false,
    lastError: null,
    lastSuccess: null,

    clearError: () => set({ lastError: null }),
    clearSuccess: () => set({ lastSuccess: null }),
    setSuccess: (msg) => set({ lastSuccess: msg }),

    init: async () => {
      const todos = await loadTodos();
      set({ todos, loaded: true });
    },

    reloadFromDb: async () => {
      const todos = await loadTodos();
      set({ todos, loaded: true });
      console.log("[LiteNote] Todos 已从数据库重新加载");
    },

    // ── Todo 操作（乐观更新：同步改 state，异步写 DB） ──

    addTodo: (categoryId) => {
      const now = Date.now();
      const id = crypto.randomUUID();
      const item: TodoItem = {
        id,
        text: "",
        categoryId: categoryId || UNCATEGORIZED_CATEGORY_ID,
        colorId: "none",
        pinned: false,
        completed: false,
        completedTime: 0,
        sortOrder: nextOrder(get().todos),
        createTime: now,
        updateTime: now,
        dueDate: 0,
        reminded: false,
        isRecurring: false,
        recurrenceType: "none",
        recurrenceConfig: "",
      };
      set((s) => ({ todos: [...s.todos, item] }));
      dbWrite(
        insertTodo(item),
        "addTodo",
        (msg) => set({ lastError: msg }),
      );
      return id;
    },

    updateTodoText: (id, text) => {
      set((s) => ({
        todos: s.todos.map((x) =>
          x.id === id ? { ...x, text } : x,
        ),
      }));
    },

    commitTodoEdit: (id) => {
      const item = get().todos.find((x) => x.id === id);
      if (!item) return;
      const updated = { ...item, updateTime: Date.now() };
      /*
        以前这里只写库、不更新 state：数组身份没变，React 侧一切照旧，
        于是「内容变化才同步」的 effect 根本不会被提交编辑触发 ——
        实测新增一条要等 37 秒才上传（还是被 30 秒的提醒轮询顺带叫起来的）。
        提交必须同时落到 state：界面时间戳要跟着变，同步触发也要看得见。
      */
      set((s) => ({ todos: s.todos.map((x) => (x.id === id ? updated : x)) }));
      dbWrite(
        updateTodo(updated),
        "updateTodo",
        (msg) => set({ lastError: msg }),
      );
    },

    deleteTodo: (id) => {
      set((s) => ({ todos: s.todos.filter((x) => x.id !== id) }));
      dbWrite(
        removeTodo(id),
        "deleteTodo",
        (msg) => set({ lastError: msg }),
      );
    },

    clearCompletedTodos: () => {
      set((s) => ({ todos: s.todos.filter((x) => !x.completed) }));
      dbWrite(
        dbClearCompleted(),
        "clearCompletedTodos",
        (msg) => set({ lastError: msg }),
      );
    },

    togglePinned: (id) => {
      const now = Date.now();
      let updated!: TodoItem;
      set((s) => ({
        todos: s.todos.map((x) =>
          x.id === id
            ? ((updated = { ...x, pinned: !x.pinned, updateTime: now }), updated)
            : x,
        ),
      }));
      if (updated) {
        dbWrite(
          updateTodo(updated),
          "togglePinned",
          (msg) => set({ lastError: msg }),
        );
      }
    },

    toggleCompleted: (id) => {
      const target = get().todos.find((x) => x.id === id);
      if (!target) return;

      /*
        完成即终结：按用户要求，一条待办一旦完成，截止时间与循环规则全部归零，
        它变成一条普通已完成项，不再推进到下一轮、也不再提醒。
        （循环本体在「到期未处理」时仍由 Rust 端自动滚动到下一轮，那是另一回事。）
      */
      const now = Date.now();
      let updated!: TodoItem;
      set((s) => ({
        todos: s.todos.map((x) => {
          if (x.id !== id) return x;
          const nextCompleted = !x.completed;
          return ((updated = {
            ...x,
            completed: nextCompleted,
            // 完成时记录完成时间；取消完成时清零
            completedTime: nextCompleted ? now : 0,
            pinned: nextCompleted ? false : x.pinned,
            dueDate: nextCompleted ? 0 : x.dueDate,
            isRecurring: nextCompleted ? false : x.isRecurring,
            recurrenceType: nextCompleted ? ("none" as const) : x.recurrenceType,
            recurrenceConfig: nextCompleted ? "" : x.recurrenceConfig,
            reminded: nextCompleted ? false : x.reminded,
            updateTime: now,
          }),
          updated);
        }),
      }));
      if (updated) {
        dbWrite(
          updateTodo(updated),
          "toggleCompleted",
          (msg) => set({ lastError: msg }),
        );
      }
    },

    setTodoColor: (id, colorId) => {
      const now = Date.now();
      let updated!: TodoItem;
      set((s) => ({
        todos: s.todos.map((x) =>
          x.id === id
            ? ((updated = { ...x, colorId, updateTime: now }), updated)
            : x,
        ),
      }));
      if (updated) {
        dbWrite(
          updateTodo(updated),
          "setTodoColor",
          (msg) => set({ lastError: msg }),
        );
      }
    },

    setTodoCategory: (id, categoryId) => {
      const now = Date.now();
      let updated!: TodoItem;
      set((s) => ({
        todos: s.todos.map((x) =>
          x.id === id
            ? ((updated = {
                ...x,
                categoryId: categoryId || UNCATEGORIZED_CATEGORY_ID,
                updateTime: now,
              }), updated)
            : x,
        ),
      }));
      if (updated) {
        dbWrite(
          updateTodo(updated),
          "setTodoCategory",
          (msg) => set({ lastError: msg }),
        );
      }
    },

    setTodoDueDate: (id, dueDate) => {
      const now = Date.now();
      let updated!: TodoItem;
      set((s) => ({
        todos: s.todos.map((x) =>
          x.id === id
            ? ((updated = {
                ...x,
                dueDate,
                updateTime: now,
                // 重新设置截止时间后，进入新一轮提醒窗口，清空 reminded
                reminded: false,
              }), updated)
            : x,
        ),
      }));
      if (updated) {
        dbWrite(
          updateTodo(updated),
          "setTodoDueDate",
          (msg) => set({ lastError: msg }),
        );
      }
    },

    setTodoRecurrence: (id, isRecurring, type, config) => {
      const now = Date.now();
      let updated!: TodoItem;
      set((s) => ({
        todos: s.todos.map((x) =>
          x.id === id
            ? ((updated = {
                ...x,
                isRecurring,
                recurrenceType: type,
                recurrenceConfig: config,
                // 设为循环时重置 reminded，确保新轮次能提醒
                reminded: isRecurring ? false : x.reminded,
                updateTime: now,
              }),
              updated)
            : x,
        ),
      }));
      if (updated) {
        dbWrite(
          updateTodo(updated),
          "setTodoRecurrence",
          (msg) => set({ lastError: msg }),
        );
      }
    },

    updateTodoDirect: (id, dueDate) => {
      const now = Date.now();
      let updated!: TodoItem;
      set((s) => ({
        todos: s.todos.map((x) =>
          x.id === id
            ? ((updated = {
                ...x,
                dueDate,
                reminded: false,
                updateTime: now,
              }),
              updated)
            : x,
        ),
      }));
      if (updated) {
        dbWrite(
          updateTodo(updated),
          "updateTodoDirect",
          (msg) => set({ lastError: msg }),
        );
      }
    },

    reorderTodos: (fromId, toId, categoryId) => {
      const { todos } = get();
      const active = todos.filter((x) => !x.completed);
      const completed = todos.filter((x) => x.completed);
      const scoped = categoryId
        ? active.filter((x) => x.categoryId === categoryId)
        : active;

      const fromIdx = scoped.findIndex((x) => x.id === fromId);
      const toIdx = scoped.findIndex((x) => x.id === toId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

      const reordered = [...scoped];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      const orders = scoped.map((x) => x.sortOrder).sort((a, b) => a - b);
      const orderById = new Map(
        reordered.map((todo, i) => [todo.id, orders[i] ?? i + 1]),
      );

      const now = Date.now();
      const updated = active.map((todo) => {
        const sortOrder = orderById.get(todo.id);
        if (sortOrder === undefined) return todo;
        return {
          ...todo,
          sortOrder,
          updateTime: todo.sortOrder === sortOrder ? todo.updateTime : now,
        };
      });
      const nextTodos = [...updated, ...completed];

      set({ todos: nextTodos });

      // 异步写入 DB：只更新位置真正改变的条目，分类筛选下不碰其它分类。
      const original = new Map(todos.map((t) => [t.id, t.sortOrder]));
      for (const t of updated) {
        if (original.get(t.id) === t.sortOrder) continue;
        dbWrite(
          updateTodo(t),
          "reorderTodos",
          (msg) => set({ lastError: msg }),
        );
      }
    },

    duplicateTodo: (id, dueDate) => {
      const original = get().todos.find((x) => x.id === id);
      if (!original) return;

      const now = Date.now();
      const newId = crypto.randomUUID();
      const copy: TodoItem = {
        id: newId,
        text: original.text,
        categoryId: original.categoryId || UNCATEGORIZED_CATEGORY_ID,
        colorId: original.colorId,
        pinned: false,
        completed: false,
        completedTime: 0,
        sortOrder: original.sortOrder + 0.5,
        createTime: now,
        updateTime: now,
        dueDate,
        reminded: false,
        isRecurring: false,
        recurrenceType: "none",
        recurrenceConfig: "",
      };

      // 插入到原条目后方，并只在同一分类内重排。
      const todos = [...get().todos];
      const idx = todos.findIndex((x) => x.id === id);
      if (idx === -1) return;
      todos.splice(idx + 1, 0, copy);

      const active = todos.filter((x) => !x.completed);
      const completed = todos.filter((x) => x.completed);
      const categoryScope = copy.categoryId;
      const scoped = active.filter((t) => t.categoryId === categoryScope);
      const scopedIdx = scoped.findIndex((t) => t.id === newId);
      const originalOrders = new Map(todos.map((t) => [t.id, t.sortOrder]));
      let scopedOrders: number[];
      if (scoped.length <= 1) {
        scopedOrders = [originalOrders.get(newId) ?? 1];
      } else {
        const withoutNew = scoped.filter((t) => t.id !== newId);
        const base = withoutNew.map((t) => t.sortOrder).sort((a, b) => a - b);
        const previous = scopedIdx > 0 ? base[scopedIdx - 1] : base[0] - 1;
        const next = base[scopedIdx] ?? base[base.length - 1] + 1;
        scopedOrders = base.slice();
        scopedOrders.splice(scopedIdx, 0, previous + (next - previous) / 2);
      }
      const orderById = new Map(scoped.map((t, i) => [t.id, scopedOrders[i]]));
      const reordered = [
        ...active.map((t) => {
          const sortOrder = orderById.get(t.id);
          if (sortOrder === undefined) return t;
          return {
            ...t,
            sortOrder,
            updateTime: originalOrders.get(t.id) === sortOrder ? t.updateTime : now,
          };
        }),
        ...completed,
      ];
      set({ todos: reordered });

      const dbCopy = reordered.find((x) => x.id === newId);
      if (dbCopy) {
        dbWrite(
          insertTodo(dbCopy),
          "duplicateTodo",
          (msg) => set({ lastError: msg }),
        );
      }
      for (const t of reordered) {
        if (t.id !== newId && originalOrders.get(t.id) !== t.sortOrder) {
          dbWrite(
            updateTodo(t),
            "duplicateTodo(reorder)",
            (msg) => set({ lastError: msg }),
          );
        }
      }
    },
  }),
);

// ──────────────── 跨窗口待办同步 ────────────────

const TODOS_EVENT = "litenote-todos-updated";

let _todosSyncInitDone = false;

/**
 * 注册跨窗口待办同步监听。
 * 当其他窗口（如提醒弹窗）修改了 DB 中的 todo 数据后，
 * 会通过 Tauri 事件通知本窗口重新从数据库加载。
 */
export function initTodosSync(): () => void {
  if (_todosSyncInitDone) return () => {};
  _todosSyncInitDone = true;

  let unlisten: (() => void) | null = null;

  listen<{ ts: number; source?: string }>(TODOS_EVENT, async (event) => {
    // 跳过自身发出的消息
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (event.payload.source === getCurrentWindow().label) return;

    console.log("[LiteNote] 收到待办更新事件，重新加载数据");
    await useTodoStore.getState().reloadFromDb();
  }).then((fn) => {
    unlisten = fn;
  });

  return () => {
    if (unlisten) unlisten();
  };
}
